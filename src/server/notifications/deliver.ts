// Sending one message to one channel + bookkeeping (channel status / last_sent_at / migrated chat id, delivery row).
// Shared by the `notify.telegram` worker job, the "Gửi tin thử" action and the MCP tool telegram_send_message.
// The bot token is decrypted here only, used for one request and dropped. No "next/*" imports.
import { and, eq, isNull } from "drizzle-orm"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import type {
  DeliveryEventType,
  DeliverySource,
  NotificationChannelStatus,
} from "@/lib/schemas/notifications"
import { redactString } from "@/server/audit/redact"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db, type Tx } from "@/server/db/client"
import {
  notificationChannels,
  notificationDeliveries,
  type TelegramChannelConfig,
} from "@/server/db/schema"

import { fitMessage, previewOf } from "./format"
import {
  isTelegramError,
  sendTelegramText,
  type TelegramCallOptions,
  type TelegramErrorKind,
} from "./telegram"

export type ChannelRow = typeof notificationChannels.$inferSelect

export function encryptChannelToken(
  channelId: string,
  botToken: string
): string {
  return encryptSecret(botToken, aad.notificationChannelCredentials(channelId))
}

export function decryptChannelToken(
  row: Pick<ChannelRow, "id" | "credentialsEncrypted">
): string {
  return decryptSecret(
    row.credentialsEncrypted,
    aad.notificationChannelCredentials(row.id)
  )
}

export function channelConfig(
  row: Pick<ChannelRow, "config">
): TelegramChannelConfig {
  const c = (row.config ?? {}) as Partial<TelegramChannelConfig>
  return {
    chatId: String(c.chatId ?? ""),
    chatTitle: c.chatTitle ?? null,
    chatType: c.chatType ?? "group",
    messageThreadId:
      typeof c.messageThreadId === "number" && c.messageThreadId > 1
        ? c.messageThreadId
        : null,
    botId: String(c.botId ?? ""),
    botUsername: String(c.botUsername ?? ""),
  }
}

export async function loadChannel(
  channelId: string
): Promise<ChannelRow | null> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, channelId),
        isNull(notificationChannels.deletedAt)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

export type SendOutcome =
  | { ok: true; messageId: number; sentAsPlainText: boolean }
  | {
      ok: false
      kind: TelegramErrorKind | "credentials"
      /** Vietnamese, safe for the UI / AI */
      message: string
      /** for notification_deliveries.error_message: Vietnamese + redacted Telegram description */
      detail: string
      code: number | null
      retryable: boolean
      retryAfterSec: number | null
      /** channel status after this attempt */
      channelStatus: NotificationChannelStatus
    }

/** Channel bookkeeping after one send attempt (status / status_message / last_sent_at / last_error_at / config). */
export type ChannelPatch = Partial<typeof notificationChannels.$inferInsert>

type SendOptions = Pick<
  TelegramCallOptions,
  "fetchImpl" | "signal" | "baseUrl" | "timeoutMs"
> & { disableNotification?: boolean; now?: Date }

/** Applies the bookkeeping of attemptSend (no-op for null), on `exec` = db or the caller's transaction. */
export async function applyChannelPatch(
  exec: Tx | typeof db,
  channelId: string,
  patch: ChannelPatch | null
): Promise<void> {
  if (!patch || Object.keys(patch).length === 0) return
  await exec
    .update(notificationChannels)
    .set(patch)
    .where(eq(notificationChannels.id, channelId))
}

/**
 * One send attempt (no retry), WITHOUT touching the DB: returns the outcome and the channel patch to apply.
 * success → last_sent_at (+ new chat id after a group migration; an `error` channel becomes `active` again);
 * token/chat/thread/rights error → status `error` + Vietnamese status_message; any other error → last_error_at.
 */
export async function attemptSend(
  row: ChannelRow,
  html: string,
  opts: SendOptions = {}
): Promise<{ outcome: SendOutcome; patch: ChannelPatch | null }> {
  const cfg = channelConfig(row)
  let token: string
  try {
    token = decryptChannelToken(row)
  } catch (e) {
    console.error(
      `[notifications] channel ${row.id}: token unreadable: ${safeErrorForLog(e)}`
    )
    return {
      outcome: {
        ok: false,
        kind: "credentials",
        message: m.errors.credentialsUnreadable,
        detail: m.errors.credentialsUnreadable,
        code: null,
        retryable: false,
        retryAfterSec: null,
        channelStatus: row.status as NotificationChannelStatus,
      },
      patch: null,
    }
  }
  const fitted = fitMessage(html)
  try {
    const r = await sendTelegramText(
      token,
      { chatId: cfg.chatId, messageThreadId: cfg.messageThreadId },
      fitted,
      {
        ...opts,
        botUsername: cfg.botUsername || null,
      }
    )
    const now = opts.now ?? new Date()
    const patch: ChannelPatch = {
      lastSentAt: now,
    }
    if (r.migratedChatId)
      patch.config = {
        ...cfg,
        chatId: r.migratedChatId,
        chatType: "supergroup",
      }
    if (row.status === "error") {
      patch.status = "active"
      patch.statusMessage = null
    }
    return {
      outcome: {
        ok: true,
        messageId: r.messageId,
        sentAsPlainText: r.sentAsPlainText,
      },
      patch,
    }
  } catch (e) {
    const now = opts.now ?? new Date()
    if (!isTelegramError(e)) {
      console.error(
        `[notifications] channel ${row.id}: send failed: ${safeErrorForLog(e)}`
      )
      return {
        outcome: {
          ok: false,
          kind: "network",
          message: m.telegram.unavailable,
          detail: m.telegram.unavailable,
          code: null,
          retryable: true,
          retryAfterSec: null,
          channelStatus: row.status as NotificationChannelStatus,
        },
        patch: { lastErrorAt: now },
      }
    }
    const broken = e.channelBroken && row.status !== "disabled"
    return {
      outcome: {
        ok: false,
        kind: e.kind,
        message: e.userMessageVi,
        detail: errorDetail(e.userMessageVi, e.description),
        code: e.code,
        retryable: e.retryable,
        retryAfterSec: e.retryAfterSec,
        channelStatus: broken
          ? "error"
          : (row.status as NotificationChannelStatus),
      },
      patch: broken
        ? { status: "error", statusMessage: e.userMessageVi, lastErrorAt: now }
        : { lastErrorAt: now },
    }
  }
}

/** One send attempt (no retry) + its channel bookkeeping applied at once (worker job `notify.telegram`). */
export async function sendToChannel(
  row: ChannelRow,
  html: string,
  opts: SendOptions = {}
): Promise<SendOutcome> {
  const { outcome, patch } = await attemptSend(row, html, opts)
  await applyChannelPatch(db, row.id, patch)
  return outcome
}

export function errorDetail(
  messageVi: string,
  description?: string | null
): string {
  const d = description ? redactString(description).slice(0, 300) : ""
  return (d ? `${messageVi} (${d})` : messageVi).slice(0, 1000)
}

export type SendNowResult =
  | {
      ok: true
      deliveryId: string
      messageId: number
      /** channel status after this send */
      channelStatus: NotificationChannelStatus
    }
  | {
      ok: false
      deliveryId: string | null
      error: string
      kind: TelegramErrorKind | "credentials" | "channel_unavailable"
      /** channel status after this attempt (null: channel not found) */
      channelStatus: NotificationChannelStatus | null
    }

/**
 * Synchronous send (no queue, no retry) that is still recorded in notification_deliveries: "Gửi tin thử" (source
 * test) and the MCP tool telegram_send_message (source mcp_tool, waits at most 10 s for Telegram). The caller has
 * already checked that the actor / MCP may use the channel. `html` must be built with format.ts (escaped).
 *
 * - `reserve(tx)`: runs in the transaction that inserts the pending delivery, BEFORE the insert (and before the
 *   channel-availability verdict) - e.g. take an advisory lock + check an hourly quota, throw to refuse. The
 *   pending row is visible to the next caller once that transaction commits.
 * - `onSettled(tx, result)`: runs in ONE transaction with the channel bookkeeping (status / last_sent_at /
 *   migrated chat id) - e.g. the activity log of "Gửi tin thử"; if it throws, the channel change rolls back too
 *   (the delivery row, already updated, still tells what Telegram did). Called exactly once.
 */
export async function sendChannelMessageNow(args: {
  channelId: string
  html: string
  source: DeliverySource
  eventType: DeliveryEventType
  mcpId?: string | null
  disableNotification?: boolean
  /** "Gửi tin thử" also works on an `error` channel (it is the final check); the MCP tool requires `active` */
  allowErrorStatus?: boolean
  fetchImpl?: TelegramCallOptions["fetchImpl"]
  now?: Date
  reserve?: (tx: Tx) => Promise<void>
  onSettled?: (tx: Tx, result: SendNowResult) => Promise<void>
}): Promise<SendNowResult> {
  const row = await loadChannel(args.channelId)
  const blocked = !row
    ? m.errors.notFound
    : row.status === "disabled"
      ? m.errors.channelDisabled
      : row.status === "error" && !args.allowErrorStatus
        ? m.telegram.skippedError(row.statusMessage ?? "")
        : null
  const now = args.now ?? new Date()
  let deliveryId: string | null = null
  if (args.reserve || (row && blocked === null)) {
    deliveryId = await db.transaction(async (tx) => {
      if (args.reserve) await args.reserve(tx)
      if (!row || blocked !== null) return null
      const [delivery] = await tx
        .insert(notificationDeliveries)
        .values({
          channelId: row.id,
          source: args.source,
          eventType: args.eventType,
          mcpId: args.mcpId ?? null,
          status: "pending",
          attempts: 1,
          preview: previewOf(args.html),
          message: null,
          createdAt: now,
        })
        .returning({ id: notificationDeliveries.id })
      return delivery!.id
    })
  }
  if (!row || blocked !== null || deliveryId === null) {
    const result: SendNowResult = {
      ok: false,
      deliveryId: null,
      error: blocked ?? m.errors.notFound,
      kind: "channel_unavailable",
      channelStatus: row ? (row.status as NotificationChannelStatus) : null,
    }
    const settle = args.onSettled
    if (settle) await db.transaction((tx) => settle(tx, result))
    return result
  }
  const { outcome: out, patch } = await attemptSend(row, args.html, {
    fetchImpl: args.fetchImpl,
    disableNotification: args.disableNotification,
    now,
  })
  let result: SendNowResult
  if (out.ok) {
    await db
      .update(notificationDeliveries)
      .set({
        status: "sent",
        sentAt: new Date(),
        telegramMessageId: out.messageId,
      })
      .where(eq(notificationDeliveries.id, deliveryId))
    result = {
      ok: true,
      deliveryId,
      messageId: out.messageId,
      channelStatus: (patch?.status ?? row.status) as NotificationChannelStatus,
    }
  } else {
    await db
      .update(notificationDeliveries)
      .set({ status: "failed", errorCode: out.code, errorMessage: out.detail })
      .where(eq(notificationDeliveries.id, deliveryId))
    result = {
      ok: false,
      deliveryId,
      error: out.message,
      kind: out.kind,
      channelStatus: out.channelStatus,
    }
  }
  const settle = args.onSettled
  if (settle) {
    await db.transaction(async (tx) => {
      await applyChannelPatch(tx, row.id, patch)
      await settle(tx, result)
    })
  } else {
    await applyChannelPatch(db, row.id, patch)
  }
  return result
}
