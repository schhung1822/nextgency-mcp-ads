// "Kết nối Telegram" (notification channels) service: owner checks (staff: own channels, admin: all - but an MCP
// only ever uses channels of its OWN owner, admins included), bot token encrypted at rest (AAD notification_channel:<id>:credentials) and NEVER returned, activity log in the same
// transaction as every change. Telegram calls (network) always run outside DB transactions.
// Design: .claude/docs/14-telegram-notifications.md.
import "server-only"
import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import type {
  ChannelMcpUsage,
  DeliveryEventType,
  DeliverySource,
  DeliveryStatus,
  McpChannelOption,
  NotificationChannelDetail,
  NotificationChannelDto,
  NotificationChannelStatus,
  NotificationDeliveryDto,
  NotificationEvent,
  TelegramCheckResult,
  TelegramTestResult,
} from "@/lib/schemas/notifications"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { canAccessOwned, type AppUser } from "@/server/auth/session"
import { lastChars } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  mcpNotificationScopes,
  mcpServers,
  notificationChannels,
  notificationDeliveries,
  user as userTable,
  type TelegramChannelConfig,
} from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"
import {
  channelConfig,
  decryptChannelToken,
  encryptChannelToken,
  loadChannel,
  sendChannelMessageNow,
  type ChannelRow,
} from "@/server/notifications/deliver"
import { buildTestMessage } from "@/server/notifications/format"
import {
  validateTelegramConfig,
  TelegramValidationError,
} from "@/server/notifications/validate"

export type Actor = Pick<AppUser, "id" | "email" | "role">

/** Error whose message is safe to show to the user (Vietnamese). */
export class NotificationServiceError extends Error {
  readonly fieldErrors?: Record<string, string>
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = "NotificationServiceError"
    this.fieldErrors = fieldErrors
  }
}

const TARGET = "notification_channel"
const DELIVERIES_LIMIT = 50

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function eventsOf(v: string[] | null | undefined): NotificationEvent[] {
  return (v ?? []).filter(
    (e): e is NotificationEvent =>
      e === "connection_health" || e === "system_update"
  )
}

/** Telegram check → NotificationServiceError (message + field error for the form). */
async function validateOrThrow(input: {
  botToken: string
  chatId: string
  messageThreadId?: number | null
}): Promise<TelegramCheckResult> {
  try {
    return await validateTelegramConfig(input)
  } catch (e) {
    if (e instanceof TelegramValidationError) {
      throw new NotificationServiceError(
        e.message,
        e.field ? { [e.field]: e.message } : undefined
      )
    }
    console.error(
      "[notification-channels] validate failed:",
      safeErrorForLog(e)
    )
    throw new NotificationServiceError(m.telegram.unavailable)
  }
}

function configFrom(check: TelegramCheckResult): TelegramChannelConfig {
  return {
    chatId: check.chat.id,
    chatTitle: check.chat.title,
    chatType: check.chat.type,
    messageThreadId: check.messageThreadId,
    botId: check.bot.id,
    botUsername: check.bot.username,
  }
}

/** system_update / all connections are admin features: the CHANNEL OWNER must be an admin. */
function assertAdminOnly(
  ownerRole: string,
  input: { events?: NotificationEvent[]; allConnections?: boolean }
) {
  if (ownerRole === "admin") return
  if (input.events?.includes("system_update"))
    throw new NotificationServiceError(m.errors.adminOnlyEvent, {
      events: m.errors.adminOnlyEvent,
    })
  if (input.allConnections) {
    throw new NotificationServiceError(m.errors.adminOnlyAllConnections, {
      allConnections: m.errors.adminOnlyAllConnections,
    })
  }
}

async function ownerOf(
  ownerId: string
): Promise<{ id: string; email: string; name: string; role: string }> {
  const [o] = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      name: userTable.name,
      role: userTable.role,
    })
    .from(userTable)
    .where(eq(userTable.id, ownerId))
    .limit(1)
  return o
    ? { ...o, role: o.role ?? "staff" }
    : { id: ownerId, email: "", name: "", role: "staff" }
}

/** Loads a non-deleted channel the actor may access; otherwise a generic "not found". */
async function getOwnedRow(
  actor: Actor,
  channelId: string
): Promise<ChannelRow> {
  const row = await loadChannel(channelId)
  if (!row || !canAccessOwned(actor, row.ownerId))
    throw new NotificationServiceError(m.errors.notFound)
  return row
}

function toDto(
  row: ChannelRow,
  owner: { id: string; email: string; name: string; role: string },
  mcpCount: number
): NotificationChannelDto {
  const cfg = channelConfig(row)
  return {
    id: row.id,
    type: "telegram",
    name: row.name,
    credentialHint: row.credentialHint,
    botId: cfg.botId,
    botUsername: cfg.botUsername,
    chatId: cfg.chatId,
    chatTitle: cfg.chatTitle,
    chatType: cfg.chatType,
    messageThreadId: cfg.messageThreadId,
    events: eventsOf(row.events),
    allConnections: row.allConnections,
    status: row.status as NotificationChannelStatus,
    statusMessage: row.statusMessage,
    lastSentAt: iso(row.lastSentAt),
    lastErrorAt: iso(row.lastErrorAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    owner: { id: owner.id, email: owner.email, name: owner.name, role: owner.role === "admin" ? "admin" : "staff" },
    mcpCount,
  }
}

async function mcpCounts(channelIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (channelIds.length === 0) return out
  const rows = await db
    .select({
      channelId: mcpNotificationScopes.channelId,
      n: sql<number>`count(distinct ${mcpNotificationScopes.mcpId})::int`,
    })
    .from(mcpNotificationScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpNotificationScopes.mcpId))
    .where(
      and(
        inArray(mcpNotificationScopes.channelId, channelIds),
        isNull(mcpServers.deletedAt)
      )
    )
    .groupBy(mcpNotificationScopes.channelId)
  for (const r of rows) out.set(r.channelId, Number(r.n))
  return out
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Staff: own channels. Admin: every channel (with owner). Never includes the token. */
export async function listNotificationChannels(
  actor: Actor
): Promise<NotificationChannelDto[]> {
  const rows = await db
    .select({
      channel: notificationChannels,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
      ownerRole: userTable.role,
    })
    .from(notificationChannels)
    .innerJoin(userTable, eq(userTable.id, notificationChannels.ownerId))
    .where(
      and(
        isNull(notificationChannels.deletedAt),
        actor.role === "admin"
          ? undefined
          : eq(notificationChannels.ownerId, actor.id)
      )
    )
    .orderBy(desc(notificationChannels.createdAt))
  const counts = await mcpCounts(rows.map((r) => r.channel.id))
  return rows.map((r) =>
    toDto(
      r.channel,
      { id: r.channel.ownerId, email: r.ownerEmail, name: r.ownerName, role: r.ownerRole ?? "staff" },
      counts.get(r.channel.id) ?? 0
    )
  )
}

/** MCP servers (not deleted) that have this channel in scope; other people's MCPs are anonymous for staff. */
export async function getNotificationChannelUsage(
  actor: Actor,
  channelId: string
): Promise<ChannelMcpUsage[]> {
  await getOwnedRow(actor, channelId)
  return usageOf(actor, channelId)
}

async function usageOf(
  actor: Actor,
  channelId: string
): Promise<ChannelMcpUsage[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      ownerId: mcpServers.ownerId,
    })
    .from(mcpNotificationScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpNotificationScopes.mcpId))
    .where(
      and(
        eq(mcpNotificationScopes.channelId, channelId),
        isNull(mcpServers.deletedAt)
      )
    )
  return rows.map((r) => {
    const visible = canAccessOwned(actor, r.ownerId)
    return {
      id: visible ? r.id : null,
      name: visible ? r.name : null,
      ownedByViewer: r.ownerId === actor.id,
    }
  })
}

/** Detail for /connections/telegram/[id]; throws NotificationServiceError(notFound) when not accessible. */
export async function getNotificationChannel(
  actor: Actor,
  channelId: string
): Promise<NotificationChannelDetail> {
  const row = await getOwnedRow(actor, channelId)
  const owner = await ownerOf(row.ownerId)
  const usedBy = await usageOf(actor, row.id)
  return { ...toDto(row, owner, usedBy.length), usedBy }
}

/** Last 50 deliveries of a channel (newest first). */
export async function listNotificationDeliveries(
  actor: Actor,
  channelId: string
): Promise<NotificationDeliveryDto[]> {
  const row = await getOwnedRow(actor, channelId)
  const rows = await db
    .select({
      id: notificationDeliveries.id,
      source: notificationDeliveries.source,
      eventType: notificationDeliveries.eventType,
      status: notificationDeliveries.status,
      attempts: notificationDeliveries.attempts,
      errorCode: notificationDeliveries.errorCode,
      errorMessage: notificationDeliveries.errorMessage,
      preview: notificationDeliveries.preview,
      createdAt: notificationDeliveries.createdAt,
      sentAt: notificationDeliveries.sentAt,
      mcpId: mcpServers.id,
      mcpName: mcpServers.name,
      mcpOwnerId: mcpServers.ownerId,
    })
    .from(notificationDeliveries)
    .leftJoin(mcpServers, eq(mcpServers.id, notificationDeliveries.mcpId))
    .where(eq(notificationDeliveries.channelId, row.id))
    .orderBy(
      desc(notificationDeliveries.createdAt),
      desc(notificationDeliveries.id)
    )
    .limit(DELIVERIES_LIMIT)
  return rows.map((r) => ({
    id: r.id,
    source: r.source as DeliverySource,
    eventType: r.eventType as DeliveryEventType,
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    preview: r.preview,
    mcp:
      r.mcpId &&
      r.mcpName !== null &&
      r.mcpOwnerId &&
      canAccessOwned(actor, r.mcpOwnerId)
        ? { id: r.mcpId, name: r.mcpName }
        : null,
    createdAt: r.createdAt.toISOString(),
    sentAt: iso(r.sentAt),
  }))
}

/**
 * Options of the "Telegram" block of the MCP wizard: the channels of `mcpOwner` only (the viewer creating an MCP, or
 * the owner of the MCP being edited) - for admins too. An MCP never uses somebody else's channel: that person could
 * later point the channel (chat id / token) elsewhere and read the MCP's notifications.
 */
export async function listChannelsForMcpScope(
  mcpOwner: Pick<Actor, "id">
): Promise<McpChannelOption[]> {
  const rows = await db
    .select({
      channel: notificationChannels,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
      ownerRole: userTable.role,
    })
    .from(notificationChannels)
    .innerJoin(userTable, eq(userTable.id, notificationChannels.ownerId))
    .where(
      and(
        isNull(notificationChannels.deletedAt),
        eq(notificationChannels.ownerId, mcpOwner.id)
      )
    )
    .orderBy(notificationChannels.name)
  return rows.map((r) => {
    const cfg = channelConfig(r.channel)
    return {
      id: r.channel.id,
      name: r.channel.name,
      chatTitle: cfg.chatTitle,
      hasThread: cfg.messageThreadId !== null,
      status: r.channel.status as NotificationChannelStatus,
      statusMessage: r.channel.statusMessage,
      owner: {
        id: r.channel.ownerId,
        email: r.ownerEmail,
        name: r.ownerName,
        role: r.ownerRole === "admin" ? "admin" : "staff",
      },
    }
  })
}

/**
 * The subset of `channelIds` an MCP owned by `mcpOwner` may use: not deleted AND owned by the MCP owner - for an
 * admin's MCP too (security-first: a staff-owned channel in an admin MCP would let that staff member redirect the
 * admin MCP's notifications). Input order kept, duplicates dropped.
 */
export async function channelsUsableForMcp(
  mcpOwner: Pick<Actor, "id">,
  channelIds: string[]
): Promise<string[]> {
  const ids = [...new Set(channelIds)]
  if (ids.length === 0) return []
  const rows = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        inArray(notificationChannels.id, ids),
        isNull(notificationChannels.deletedAt),
        eq(notificationChannels.ownerId, mcpOwner.id)
      )
    )
  const usable = new Set(rows.map((r) => r.id))
  return ids.filter((id) => usable.has(id))
}

/**
 * MCP save: every id must be usable by an MCP owned by `mcpOwner` (see channelsUsableForMcp). Throws
 * NotificationServiceError(channelNotUsable) when one id is not usable.
 */
export async function assertChannelsUsableForMcp(
  mcpOwner: Pick<Actor, "id">,
  channelIds: string[]
): Promise<string[]> {
  const ids = [...new Set(channelIds)]
  const usable = await channelsUsableForMcp(mcpOwner, ids)
  if (usable.length !== ids.length)
    throw new NotificationServiceError(m.errors.channelNotUsable)
  return usable
}

// ---------------------------------------------------------------------------
// Check / create
// ---------------------------------------------------------------------------

/** Wizard "Kiểm tra": getMe → getChat → getChatMember. Saves nothing. */
export async function previewTelegramChannel(
  _actor: Actor,
  input: { botToken: string; chatId: string; messageThreadId?: number | null }
): Promise<TelegramCheckResult> {
  return validateOrThrow(input)
}

export async function createNotificationChannel(
  actor: Actor,
  input: {
    name: string
    botToken: string
    chatId: string
    messageThreadId?: number | null
    events: NotificationEvent[]
    allConnections: boolean
  }
): Promise<{ id: string; check: TelegramCheckResult }> {
  assertAdminOnly(actor.role, input)
  const check = await validateOrThrow(input)
  const id = randomUUID()
  const config = configFrom(check)
  await db.transaction(async (tx) => {
    await tx.insert(notificationChannels).values({
      id,
      ownerId: actor.id,
      type: "telegram",
      name: input.name,
      credentialsEncrypted: encryptChannelToken(id, input.botToken),
      credentialHint: lastChars(input.botToken),
      config,
      events: input.events,
      allConnections: input.allConnections,
      status: "active",
    })
    await logActivity(
      {
        actor: actorOf(actor),
        action: "notification_channel.create",
        target: { type: TARGET, id, label: input.name },
        metadata: {
          type: "telegram",
          name: input.name,
          bot: config.botUsername,
          chatType: config.chatType,
          chatTitle: config.chatTitle,
          messageThreadId: config.messageThreadId,
          events: input.events,
          allConnections: input.allConnections,
        },
      },
      tx
    )
  })
  return { id, check }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

function tokenOrThrow(row: ChannelRow): string {
  try {
    return decryptChannelToken(row)
  } catch (e) {
    console.error(
      `[notification-channels] channel ${row.id}: token unreadable: ${safeErrorForLog(e)}`
    )
    throw new NotificationServiceError(m.errors.credentialsUnreadable)
  }
}

/**
 * Name / chat / thread / events / all-connections. A chat or thread change is re-validated against Telegram with
 * the stored token (the channel becomes `active` again when it passes, unless it is disabled).
 */
export async function updateNotificationChannel(
  actor: Actor,
  input: {
    channelId: string
    name?: string
    chatId?: string
    messageThreadId?: number | null
    events?: NotificationEvent[]
    allConnections?: boolean
  }
): Promise<NotificationChannelDto> {
  const row = await getOwnedRow(actor, input.channelId)
  const owner = await ownerOf(row.ownerId)
  assertAdminOnly(owner.role, input)
  const cfg = channelConfig(row)

  const patch: Partial<typeof notificationChannels.$inferInsert> = {}
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  if (input.name !== undefined && input.name !== row.name) {
    patch.name = input.name
    before.name = row.name
    after.name = input.name
  }
  const nextThread =
    input.messageThreadId === undefined
      ? cfg.messageThreadId
      : input.messageThreadId && input.messageThreadId > 1
        ? input.messageThreadId
        : null
  const chatChanged =
    input.chatId !== undefined && input.chatId.trim() !== cfg.chatId
  const threadChanged = nextThread !== cfg.messageThreadId
  if (chatChanged || threadChanged) {
    const check = await validateOrThrow({
      botToken: tokenOrThrow(row),
      chatId: chatChanged ? input.chatId!.trim() : cfg.chatId,
      messageThreadId: nextThread,
    })
    const next = configFrom(check)
    patch.config = next
    if (row.status !== "disabled") {
      patch.status = "active"
      patch.statusMessage = null
    }
    before.chat = {
      chatId: cfg.chatId,
      chatTitle: cfg.chatTitle,
      messageThreadId: cfg.messageThreadId,
    }
    after.chat = {
      chatId: next.chatId,
      chatTitle: next.chatTitle,
      messageThreadId: next.messageThreadId,
    }
  }
  if (input.events !== undefined) {
    const prev = eventsOf(row.events)
    if ([...prev].sort().join(",") !== [...input.events].sort().join(",")) {
      patch.events = input.events
      before.events = prev
      after.events = input.events
    }
  }
  if (
    input.allConnections !== undefined &&
    input.allConnections !== row.allConnections
  ) {
    patch.allConnections = input.allConnections
    before.allConnections = row.allConnections
    after.allConnections = input.allConnections
  }

  if (Object.keys(after).length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(notificationChannels)
        .set(patch)
        .where(eq(notificationChannels.id, row.id))
      await logActivity(
        {
          actor: actorOf(actor),
          action: "notification_channel.update",
          target: { type: TARGET, id: row.id, label: patch.name ?? row.name },
          metadata: { before, after },
        },
        tx
      )
    })
    // MCP grants embed channel names / chat titles
    invalidateGrantCache()
  }
  const fresh = (await loadChannel(row.id)) ?? row
  return toDto(fresh, owner, (await mcpCounts([row.id])).get(row.id) ?? 0)
}

/** New bot token (validated against the CURRENT chat). The caller must have re-authenticated the user. */
export async function replaceNotificationChannelToken(
  actor: Actor,
  input: { channelId: string; botToken: string }
): Promise<TelegramCheckResult> {
  const row = await getOwnedRow(actor, input.channelId)
  const cfg = channelConfig(row)
  const check = await validateOrThrow({
    botToken: input.botToken,
    chatId: cfg.chatId,
    messageThreadId: cfg.messageThreadId,
  })
  const next = configFrom(check)
  await db.transaction(async (tx) => {
    await tx
      .update(notificationChannels)
      .set({
        credentialsEncrypted: encryptChannelToken(row.id, input.botToken),
        credentialHint: lastChars(input.botToken),
        config: next,
        ...(row.status === "disabled"
          ? {}
          : { status: "active", statusMessage: null }),
      })
      .where(eq(notificationChannels.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "notification_channel.token.replace",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: {
          before: {
            credentialHint: row.credentialHint,
            bot: cfg.botUsername,
            status: row.status,
          },
          after: {
            credentialHint: lastChars(input.botToken),
            bot: next.botUsername,
            status: row.status === "disabled" ? "disabled" : "active",
          },
        },
      },
      tx
    )
  })
  invalidateGrantCache()
  return check
}

export interface ChannelRecheckResult {
  ok: boolean
  status: NotificationChannelStatus
  statusMessage: string | null
  check: TelegramCheckResult | null
}

/**
 * "Kiểm tra lại": validate the stored token + chat. Pass → `active` (config refreshed); a configuration problem →
 * `error` with the Vietnamese reason; Telegram unreachable → status unchanged. Activity `notification_channel.test`.
 */
export async function recheckNotificationChannel(
  actor: Actor,
  channelId: string
): Promise<ChannelRecheckResult> {
  const row = await getOwnedRow(actor, channelId)
  const cfg = channelConfig(row)
  let check: TelegramCheckResult | null = null
  let problem: string | null = null
  let broken = false
  try {
    check = await validateTelegramConfig({
      botToken: tokenOrThrow(row),
      chatId: cfg.chatId,
      messageThreadId: cfg.messageThreadId,
    })
  } catch (e) {
    if (e instanceof NotificationServiceError) throw e
    if (e instanceof TelegramValidationError) {
      problem = e.message
      broken = !e.telegramError || e.telegramError.channelBroken
    } else {
      console.error(
        "[notification-channels] recheck failed:",
        safeErrorForLog(e)
      )
      problem = m.telegram.unavailable
    }
  }
  const keep = row.status === "disabled"
  const status: NotificationChannelStatus = keep
    ? "disabled"
    : check
      ? "active"
      : broken
        ? "error"
        : (row.status as NotificationChannelStatus)
  const statusMessage = check ? null : broken ? problem : row.statusMessage
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(notificationChannels)
      .set({
        ...(check ? { config: configFrom(check) } : {}),
        ...(keep ? {} : { status, statusMessage }),
        ...(check ? {} : { lastErrorAt: now }),
      })
      .where(eq(notificationChannels.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "notification_channel.test",
        target: { type: TARGET, id: row.id, label: row.name },
        status: check ? "success" : "failure",
        metadata: {
          kind: "check",
          before: { status: row.status },
          after: { status },
          message: problem,
        },
      },
      tx
    )
  })
  invalidateGrantCache()
  return {
    ok: !!check,
    status,
    statusMessage: keep ? row.statusMessage : statusMessage,
    check,
  }
}

/**
 * "Gửi tin thử": synchronous send (also the final topic check); works on an `error` channel. The channel
 * bookkeeping (status / last_sent_at / migrated chat id) and the activity log are written in ONE transaction.
 */
export async function sendNotificationChannelTest(
  actor: Actor,
  channelId: string
): Promise<TelegramTestResult> {
  const row = await getOwnedRow(actor, channelId)
  if (row.status === "disabled")
    throw new NotificationServiceError(m.errors.channelDisabled)
  const before = row.status as NotificationChannelStatus
  const res = await sendChannelMessageNow({
    channelId: row.id,
    html: buildTestMessage({ channelName: row.name, actorEmail: actor.email }),
    source: "test",
    eventType: "test",
    allowErrorStatus: true,
    onSettled: (tx, r) =>
      logActivity(
        {
          actor: actorOf(actor),
          action: "notification_channel.test",
          target: { type: TARGET, id: row.id, label: row.name },
          status: r.ok ? "success" : "failure",
          metadata: {
            kind: "send",
            deliveryId: r.deliveryId,
            before: { status: before },
            after: { status: r.channelStatus ?? before },
            message: r.ok ? null : r.error,
          },
        },
        tx
      ),
  })
  const channelStatus = res.channelStatus ?? before
  if (channelStatus !== row.status) invalidateGrantCache()
  return {
    deliveryId: res.deliveryId ?? "",
    ok: res.ok,
    error: res.ok ? null : res.error,
    channelStatus,
  }
}

// ---------------------------------------------------------------------------
// Enable / disable / delete
// ---------------------------------------------------------------------------

export async function setNotificationChannelEnabled(
  actor: Actor,
  input: { channelId: string; enabled: boolean }
): Promise<{ status: NotificationChannelStatus }> {
  const row = await getOwnedRow(actor, input.channelId)
  const isDisabled = row.status === "disabled"
  if (input.enabled !== isDisabled)
    return { status: row.status as NotificationChannelStatus }
  const status: NotificationChannelStatus = input.enabled
    ? "active"
    : "disabled"
  await db.transaction(async (tx) => {
    await tx
      .update(notificationChannels)
      .set({ status, statusMessage: null })
      .where(eq(notificationChannels.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: input.enabled
          ? "notification_channel.enable"
          : "notification_channel.disable",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: { before: { status: row.status }, after: { status } },
      },
      tx
    )
  })
  invalidateGrantCache()
  return { status }
}

/** Soft delete: wipes the token, removes the channel from every MCP scope, reports the MCPs that used it. */
export async function deleteNotificationChannel(
  actor: Actor,
  channelId: string
): Promise<{ affectedMcpIds: string[]; affectedMcpCount: number }> {
  const row = await getOwnedRow(actor, channelId)
  const usage = await usageOf(actor, row.id)
  // staff never learn the ids of other people's MCPs; the count is complete
  const visibleIds = usage.flatMap((u) => (u.id ? [u.id] : []))
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(notificationChannels)
      .set({
        deletedAt: now,
        credentialsEncrypted: encryptChannelToken(row.id, ""),
        statusMessage: null,
      })
      .where(
        and(
          eq(notificationChannels.id, row.id),
          isNull(notificationChannels.deletedAt)
        )
      )
    await tx
      .delete(mcpNotificationScopes)
      .where(eq(mcpNotificationScopes.channelId, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "notification_channel.delete",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: {
          type: "telegram",
          name: row.name,
          affectedMcpIds: visibleIds,
          affectedMcpCount: usage.length,
        },
      },
      tx
    )
  })
  invalidateGrantCache()
  return { affectedMcpIds: visibleIds, affectedMcpCount: usage.length }
}
