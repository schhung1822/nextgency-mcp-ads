// Event sources (14-telegram-notifications.md §5): who receives what, with which dedupe key. Every function here
// NEVER throws - the caller (connection check, update job, MCP write) must not fail because of a notification.
// No "next/*" imports (used by the worker and by the web app / MCP layer).
import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"

import { safeErrorForLog } from "@/server/audit/safe-error"
import { db } from "@/server/db/client"
import {
  connections,
  mcpNotificationScopes,
  notificationChannels,
  systemUpdateRequests,
  user as userTable,
} from "@/server/db/schema"

import { enqueueNotification } from "./enqueue"
import {
  buildConnectionHealthMessage,
  buildMcpWriteMessage,
  buildUpdateAvailableMessage,
  buildUpdateResultMessage,
  type ConnectionHealthEvent,
  type NotifyChange,
  type UpdateResultStatus,
} from "./format"

export const NOTIFY_TZ = "Asia/Ho_Chi_Minh"

/** YYYY-MM-DD in Asia/Ho_Chi_Minh (dedupe day). */
export function vnDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: NOTIFY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/**
 * Health transition worth a message (only real changes): active → expiring; active/expiring → invalid;
 * invalid/expiring → active. disabled / unchanged / unknown → null.
 */
export function healthTransition(
  before: string,
  after: string | null | undefined
): ConnectionHealthEvent | null {
  if (!after || before === after) return null
  if (before === "active" && after === "expiring") return "connection_expiring"
  if ((before === "active" || before === "expiring") && after === "invalid")
    return "connection_invalid"
  if ((before === "invalid" || before === "expiring") && after === "active")
    return "connection_recovered"
  return null
}

/** Channels subscribed to connection_health for a connection owned by `ownerId` (+ admin "all connections"). */
export async function connectionHealthChannelIds(
  ownerId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .innerJoin(userTable, eq(userTable.id, notificationChannels.ownerId))
    .where(
      and(
        isNull(notificationChannels.deletedAt),
        ne(notificationChannels.status, "disabled"),
        sql`'connection_health' = any(${notificationChannels.events})`,
        sql`coalesce(${userTable.banned}, false) = false`,
        sql`(${notificationChannels.ownerId} = ${ownerId} or (${notificationChannels.allConnections} and ${userTable.role} = 'admin'))`
      )
    )
  return rows.map((r) => r.id)
}

/** Admin channels subscribed to system_update. */
export async function systemUpdateChannelIds(): Promise<string[]> {
  const rows = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .innerJoin(userTable, eq(userTable.id, notificationChannels.ownerId))
    .where(
      and(
        isNull(notificationChannels.deletedAt),
        ne(notificationChannels.status, "disabled"),
        sql`'system_update' = any(${notificationChannels.events})`,
        eq(userTable.role, "admin"),
        sql`coalesce(${userTable.banned}, false) = false`
      )
    )
  return rows.map((r) => r.id)
}

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

/**
 * Call after a check changed (or may have changed) `connections.status` - committed. Sends only on a real
 * transition, at most once per connection + status + Vietnamese day (dedupe `conn:<id>:<status>:<YYYY-MM-DD>`).
 */
export async function notifyConnectionHealth(args: {
  connectionId: string
  before: string
  after: string | null | undefined
  statusMessage?: string | null
  now?: Date
}): Promise<void> {
  try {
    const event = healthTransition(args.before, args.after)
    if (!event) return
    const [conn] = await db
      .select({
        id: connections.id,
        name: connections.name,
        platform: connections.platform,
        ownerId: connections.ownerId,
        tokenExpiresAt: connections.tokenExpiresAt,
        ownerEmail: userTable.email,
      })
      .from(connections)
      .innerJoin(userTable, eq(userTable.id, connections.ownerId))
      .where(
        and(
          eq(connections.id, args.connectionId),
          isNull(connections.deletedAt)
        )
      )
      .limit(1)
    if (!conn) return
    const channelIds = await connectionHealthChannelIds(conn.ownerId)
    if (channelIds.length === 0) return
    const text = buildConnectionHealthMessage({
      event,
      connectionName: conn.name,
      platform: conn.platform,
      ownerEmail: conn.ownerEmail,
      statusMessage:
        event === "connection_recovered" ? null : args.statusMessage,
      tokenExpiresAt: conn.tokenExpiresAt,
    })
    await enqueueNotification({
      channelIds,
      source: "system",
      eventType: event,
      dedupeKey: `conn:${conn.id}:${args.after}:${vnDay(args.now ?? new Date())}`,
      text,
    })
  } catch (e) {
    console.error(
      `[notifications] connection health ${args.connectionId}: ${safeErrorForLog(e)}`
    )
  }
}

// ---------------------------------------------------------------------------
// System update
// ---------------------------------------------------------------------------

/** New release found by update.check (dedupe `update:<version>`). */
export async function notifyUpdateAvailable(args: {
  version: string
  currentVersion?: string | null
  notes?: string | null
}): Promise<void> {
  try {
    const channelIds = await systemUpdateChannelIds()
    if (channelIds.length === 0) return
    await enqueueNotification({
      channelIds,
      source: "system",
      eventType: "update_available",
      dedupeKey: `update:${args.version}`,
      text: buildUpdateAvailableMessage(args),
    })
  } catch (e) {
    console.error(`[notifications] update available: ${safeErrorForLog(e)}`)
  }
}

/** Window in which a finished update request is still announced (the updater restarts web + worker). */
export const UPDATE_RESULT_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * The `updater` container (scripts/updater-*.ts) writes the outcome straight into system_update_requests and has no
 * access to this module: the worker's sweep picks up requests that finished recently and announces each once per
 * channel (dedupe `update-result:<requestId>`). Channels created after the update finished are skipped.
 */
export async function notifyRecentUpdateResults(
  opts: { now?: Date } = {}
): Promise<number> {
  try {
    const now = opts.now ?? new Date()
    const finished = await db
      .select({
        id: systemUpdateRequests.id,
        status: systemUpdateRequests.status,
        targetVersion: systemUpdateRequests.targetVersion,
        message: systemUpdateRequests.message,
        finishedAt: systemUpdateRequests.finishedAt,
      })
      .from(systemUpdateRequests)
      .where(
        and(
          inArray(systemUpdateRequests.status, [
            "succeeded",
            "failed",
            "rolled_back",
          ]),
          isNotNull(systemUpdateRequests.finishedAt),
          gte(
            systemUpdateRequests.finishedAt,
            new Date(now.getTime() - UPDATE_RESULT_WINDOW_MS)
          )
        )
      )
    if (finished.length === 0) return 0
    const ids = await systemUpdateChannelIds()
    if (ids.length === 0) return 0
    const channels = await db
      .select({
        id: notificationChannels.id,
        createdAt: notificationChannels.createdAt,
      })
      .from(notificationChannels)
      .where(inArray(notificationChannels.id, ids))
    let queued = 0
    for (const r of finished) {
      const channelIds = channels
        .filter((c) => c.createdAt <= r.finishedAt!)
        .map((c) => c.id)
      if (channelIds.length === 0) continue
      const res = await enqueueNotification({
        channelIds,
        source: "system",
        eventType:
          r.status === "succeeded" ? "update_succeeded" : "update_failed",
        dedupeKey: `update-result:${r.id}`,
        text: buildUpdateResultMessage({
          status: r.status as UpdateResultStatus,
          targetVersion: r.targetVersion,
          message: r.message,
        }),
      })
      queued += res.queued.length
    }
    return queued
  } catch (e) {
    console.error(`[notifications] update results: ${safeErrorForLog(e)}`)
    return 0
  }
}

// ---------------------------------------------------------------------------
// MCP writes
// ---------------------------------------------------------------------------

export interface NotifyMcpWriteInput {
  mcpId: string
  mcpName: string
  /** channels of the MCP grant (re-checked against mcp_notification_scopes here) */
  channelIds: string[]
  platform: string
  /** external ad account id (act_123…) */
  accountId?: string | null
  toolName: string
  /** before → after of every object of ONE successful write (grouped into one message) */
  changes: NotifyChange[]
  /** the AI's reason / note, if any (untrusted text, escaped) */
  reason?: string | null
}

/**
 * After a successful MCP write (commit + call log done), when the MCP has `telegram_notify_writes`. One message per
 * execution, no dedupe. Only channels still in the MCP's scope (and not deleted / disabled) receive it.
 * Never throws: `void notifyMcpWrite(...)` is fine.
 */
export async function notifyMcpWrite(
  input: NotifyMcpWriteInput
): Promise<void> {
  try {
    if (input.channelIds.length === 0) return
    const scoped = await db
      .select({ channelId: mcpNotificationScopes.channelId })
      .from(mcpNotificationScopes)
      .where(
        and(
          eq(mcpNotificationScopes.mcpId, input.mcpId),
          inArray(mcpNotificationScopes.channelId, input.channelIds)
        )
      )
    if (scoped.length === 0) return
    await enqueueNotification({
      channelIds: scoped.map((s) => s.channelId),
      source: "mcp_write",
      eventType: "mcp_write",
      mcpId: input.mcpId,
      text: buildMcpWriteMessage(input),
    })
  } catch (e) {
    console.error(
      `[notifications] mcp write ${input.mcpId}: ${safeErrorForLog(e)}`
    )
  }
}
