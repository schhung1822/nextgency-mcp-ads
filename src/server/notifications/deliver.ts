// Sending one message to one channel + bookkeeping (channel status / last_sent_at / migrated chat id, delivery row).
// Shared by the `notify.telegram` worker job, the "Gửi tin thử" action and the MCP tool telegram_send_message.
// The bot token is decrypted here only, used for one request and dropped. No "next/*" imports.
import { and, eq, isNull, sql } from "drizzle-orm"

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

import { creditFooter } from "./credit"
import {
  fitMessage,
  PREVIEW_MAX,
  previewOf,
  TELEGRAM_MAX_CAPTION,
  TELEGRAM_MAX_MESSAGE,
  truncateText,
} from "./format"
import {
  mediaPreviewLabel,
  type OutgoingMedia,
  type OutgoingMediaKind,
} from "./media"
import {
  isTelegramError,
  sendTelegramMedia,
  sendTelegramText,
  type SendMediaResult,
  type SendTextResult,
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
  | {
      ok: true
      messageId: number
      sentAsPlainText: boolean
      /** media sends only: what Telegram received */
      sentAs?: OutgoingMediaKind
    }
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
> & {
  disableNotification?: boolean
  now?: Date
  /** upload this file with `html` as its caption (sendChannelMessageNow only - the queue sends text) */
  media?: OutgoingMedia | null
}

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
 * Every message gets the credit footer here (§10.1), once: queued rows, test messages and MCP messages alike.
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
  const { media = null, ...callOpts } = opts
  // the content is fitted so that content + footer stay within Telegram's limit (4096 text / 1024 caption); the
  // plain form of the footer (parse-entities fallback) is the longer one, so it sets the reserve
  const footer = creditFooter()
  const fitted = fitMessage(
    html,
    footer.plain.length,
    media ? TELEGRAM_MAX_CAPTION : TELEGRAM_MAX_MESSAGE
  )
  try {
    const target = { chatId: cfg.chatId, messageThreadId: cfg.messageThreadId }
    const sendOpts = {
      ...callOpts,
      footer,
      botUsername: cfg.botUsername || null,
    }
    const r: SendTextResult & Partial<Pick<SendMediaResult, "sentAs">> = media
      ? await sendTelegramMedia(token, target, media, fitted, sendOpts)
      : await sendTelegramText(token, target, fitted, sendOpts)
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
        ...(r.sentAs ? { sentAs: r.sentAs } : {}),
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
      /** set when `dedupeKey` matched a delivery Telegram already received: nothing was sent again */
      duplicate?: true
      /** media sends only: what Telegram received (a refused photo goes out as a document) */
      sentAs?: OutgoingMediaKind
    }
  | {
      ok: false
      deliveryId: string | null
      error: string
      kind:
        | TelegramErrorKind
        | "credentials"
        | "channel_unavailable"
        | "duplicate"
      /** channel status after this attempt (null: channel not found) */
      channelStatus: NotificationChannelStatus | null
      /** kind "duplicate": the delivery with this dedupe key is still pending - not sent again */
      duplicate?: true
    }

export type DeliveryRef = {
  id: string
  status: string
  telegramMessageId: number | null
}

/** The delivery holding this dedupe key on this channel (a failed one gives its key up on the next attempt). */
export async function findDeliveryByDedupeKey(
  channelId: string,
  dedupeKey: string,
  exec: Tx | typeof db = db
): Promise<DeliveryRef | null> {
  const rows = await exec
    .select({
      id: notificationDeliveries.id,
      status: notificationDeliveries.status,
      telegramMessageId: notificationDeliveries.telegramMessageId,
    })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.channelId, channelId),
        eq(notificationDeliveries.dedupeKey, dedupeKey)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

/** the earlier delivery with the same dedupe key: its outcome when sent, otherwise "still being sent" (never "sent") */
function duplicateResult(
  row: ChannelRow,
  d: DeliveryRef | null
): SendNowResult {
  const channelStatus = row.status as NotificationChannelStatus
  if (d && d.status === "sent")
    return {
      ok: true,
      duplicate: true,
      deliveryId: d.id,
      messageId: d.telegramMessageId ?? 0,
      channelStatus,
    }
  return {
    ok: false,
    duplicate: true,
    deliveryId: d?.id ?? null,
    error: m.errors.duplicateDelivery,
    kind: "duplicate",
    channelStatus,
  }
}

/**
 * Synchronous send (no queue, no retry) that is still recorded in notification_deliveries: "Gửi tin thử" (source
 * test) and the MCP tool telegram_send_message (source mcp_tool, waits at most 10 s for Telegram - 30 s for an
 * upload). The caller has already checked that the actor / MCP may use the channel. `html` must be built with
 * format.ts (escaped); with `media` it is the caption (fitted to 1024 characters incl. the credit footer).
 *
 * - `media`: upload this file (sendPhoto / sendVideo / sendDocument) with `html` as its caption; the delivery
 *   preview is "[Ảnh|Video|Tệp: <name> · <size>] <caption…>".
 * - `dedupeKey`: unique per channel; a second call with the same key sends NOTHING and returns the earlier
 *   delivery (`duplicate: true`; ok with its telegram message id when it was sent, kind "duplicate" while it is
 *   pending). A FAILED earlier delivery never blocks: its key is retired (`<key>:failed:<id>`) and this call sends.
 * - `reserve(tx)`: runs in the transaction that inserts the pending delivery, BEFORE the insert (and before the
 *   channel-availability verdict) - e.g. take an advisory lock + check an hourly quota, throw to refuse. The
 *   pending row is visible to the next caller once that transaction commits. Not called for a duplicate found
 *   before the transaction.
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
  media?: OutgoingMedia | null
  dedupeKey?: string | null
  /** per Telegram request (default 10 s text / 30 s upload) - the MCP tool passes what is left of its budget */
  timeoutMs?: number
  /** aborts the Telegram request (client cancelled / overall deadline) */
  signal?: AbortSignal
  fetchImpl?: TelegramCallOptions["fetchImpl"]
  now?: Date
  reserve?: (tx: Tx) => Promise<void>
  onSettled?: (tx: Tx, result: SendNowResult) => Promise<void>
}): Promise<SendNowResult> {
  const settleOnly = async (result: SendNowResult) => {
    const settle = args.onSettled
    if (settle) await db.transaction((tx) => settle(tx, result))
    return result
  }
  const row = await loadChannel(args.channelId)
  const dedupeKey = args.dedupeKey ? args.dedupeKey.slice(0, 200) : null
  if (row && dedupeKey) {
    const earlier = await findDeliveryByDedupeKey(row.id, dedupeKey)
    if (earlier && earlier.status !== "failed")
      return settleOnly(duplicateResult(row, earlier))
  }
  const blocked = !row
    ? m.errors.notFound
    : row.status === "disabled"
      ? m.errors.channelDisabled
      : row.status === "error" && !args.allowErrorStatus
        ? m.telegram.skippedError(row.statusMessage ?? "")
        : null
  const now = args.now ?? new Date()
  const media = args.media ?? null
  const preview = media
    ? truncateText(
        `${mediaPreviewLabel(media)} ${previewOf(args.html)}`.trim(),
        PREVIEW_MAX
      )
    : previewOf(args.html)
  let deliveryId: string | null = null
  if (args.reserve || (row && blocked === null)) {
    const inserted = await db.transaction(async (tx) => {
      if (args.reserve) await args.reserve(tx)
      if (!row || blocked !== null) return null
      if (dedupeKey) {
        // a failed attempt with this key is retried: its row keeps a retired key (still readable in the log)
        await tx
          .update(notificationDeliveries)
          .set({
            dedupeKey: sql`${notificationDeliveries.dedupeKey} || ':failed:' || ${notificationDeliveries.id}::text`,
          })
          .where(
            and(
              eq(notificationDeliveries.channelId, row.id),
              eq(notificationDeliveries.dedupeKey, dedupeKey),
              eq(notificationDeliveries.status, "failed")
            )
          )
      }
      const [delivery] = await tx
        .insert(notificationDeliveries)
        .values({
          channelId: row.id,
          source: args.source,
          eventType: args.eventType,
          mcpId: args.mcpId ?? null,
          dedupeKey,
          status: "pending",
          attempts: 1,
          preview,
          message: null,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [
            notificationDeliveries.channelId,
            notificationDeliveries.dedupeKey,
          ],
        })
        .returning({ id: notificationDeliveries.id })
      if (delivery) return { id: delivery.id }
      // a concurrent call with the same dedupe key inserted first: nothing is sent
      return {
        duplicateOf: await findDeliveryByDedupeKey(row.id, dedupeKey!, tx),
      }
    })
    if (inserted && "duplicateOf" in inserted)
      return settleOnly(duplicateResult(row!, inserted.duplicateOf ?? null))
    deliveryId = inserted?.id ?? null
  }
  if (!row || blocked !== null || deliveryId === null) {
    return settleOnly({
      ok: false,
      deliveryId: null,
      error: blocked ?? m.errors.notFound,
      kind: "channel_unavailable",
      channelStatus: row ? (row.status as NotificationChannelStatus) : null,
    })
  }
  const { outcome: out, patch } = await attemptSend(row, args.html, {
    fetchImpl: args.fetchImpl,
    disableNotification: args.disableNotification,
    media,
    now,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
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
      ...(out.sentAs ? { sentAs: out.sentAs } : {}),
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
