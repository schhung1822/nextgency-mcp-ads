"use server"
// Server actions for "Kết nối Telegram" (notification channels). Thin: requireUserForAction → zod → service (owner
// checks, encryption, activity log in the same transaction) → revalidatePath. Never returns the bot token.
import { revalidatePath } from "next/cache"
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import {
  channelIdSchema,
  createTelegramChannelSchema,
  previewTelegramChannelSchema,
  replaceTelegramTokenSchema,
  setChannelEnabledSchema,
  updateTelegramChannelSchema,
  type ChannelMcpUsage,
  type McpChannelOption,
  type NotificationChannelDto,
  type NotificationChannelStatus,
  type NotificationDeliveryDto,
  type TelegramCheckResult,
  type TelegramTestResult,
} from "@/lib/schemas/notifications"
import { safeErrorForLog } from "@/server/audit/safe-error"
import {
  ReauthError,
  requestReauthVerifier,
  requireReauth,
} from "@/server/auth/reauth"
import {
  AuthorizationError,
  requireUserForAction,
  type AppSession,
} from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import {
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationChannelUsage,
  listChannelsForMcpScope,
  listNotificationDeliveries,
  NotificationServiceError,
  previewTelegramChannel,
  recheckNotificationChannel,
  replaceNotificationChannelToken,
  sendNotificationChannelTest,
  setNotificationChannelEnabled,
  updateNotificationChannel,
  type ChannelRecheckResult,
} from "@/server/services/notification-channels"
import { checkDisclaimerAccepted } from "@/server/services/disclaimers"

const LIST = "/connections"
const detailPath = (id: string) => `/connections/telegram/${id}`

function zodFail(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {}
  for (const i of error.issues) {
    const k = i.path.join(".") || "_"
    fieldErrors[k] ??= i.message
  }
  return fail(error.issues[0]?.message ?? m.errors.invalidInput, fieldErrors)
}

function toFail(e: unknown): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof NotificationServiceError || e instanceof ReauthError)
    return fail(e.message, e.fieldErrors)
  // unexpected: log a redacted one-liner, show a generic Vietnamese message
  console.error("[actions/notification-channels]", safeErrorForLog(e))
  return fail(m.errors.generic)
}

/**
 * Calls that reach Telegram with a token (check, create, chat change, replace token, recheck, test message) are
 * throttled per user (10 / minute): Telegram rate-limits per bot and a script could probe tokens at full speed.
 */
const TELEGRAM_QUOTA_MAX = 10
const TELEGRAM_QUOTA_WINDOW_MS = 60_000

async function throttleTelegram(
  session: AppSession
): Promise<ActionResult<never> | null> {
  const q = await consumeQuota(
    "telegram-verify",
    session.user.id,
    TELEGRAM_QUOTA_MAX,
    TELEGRAM_QUOTA_WINDOW_MS
  )
  return q.allowed ? null : fail(m.errors.tooManyChecks(q.retryAfterSec))
}

function revalidateChannel(id?: string) {
  revalidatePath(LIST)
  if (id) revalidatePath(detailPath(id))
}

// ---------------------------------------------------------------------------

/** Wizard "Kiểm tra": getMe / getChat / getChatMember. Saves nothing. */
export async function previewTelegramChannelAction(
  input: unknown
): Promise<ActionResult<TelegramCheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = previewTelegramChannelSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleTelegram(session)
    if (throttled) return throttled
    return ok(await previewTelegramChannel(session.user, parsed.data))
  } catch (e) {
    return toFail(e)
  }
}

/** "Kiểm tra & lưu". */
export async function createTelegramChannelAction(
  input: unknown
): Promise<ActionResult<{ id: string; check: TelegramCheckResult }>> {
  try {
    const session = await requireUserForAction()
    const parsed = createTelegramChannelSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    // "Miễn trừ trách nhiệm" (kết nối) accepted: current version, last 12 h
    const disclaimer = await checkDisclaimerAccepted(session.user.id, "connection")
    if (!disclaimer.ok) return fail(disclaimer.error)
    const throttled = await throttleTelegram(session)
    if (throttled) return throttled
    const res = await createNotificationChannel(session.user, parsed.data, {
      disclaimerVersion: disclaimer.version,
    })
    revalidateChannel(res.id)
    return ok(res, m.server.created)
  } catch (e) {
    return toFail(e)
  }
}

/** Name / chat / thread / events / all-connections (chat or thread changes are re-checked with Telegram). */
export async function updateTelegramChannelAction(
  input: unknown
): Promise<ActionResult<NotificationChannelDto>> {
  try {
    const session = await requireUserForAction()
    const parsed = updateTelegramChannelSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    if (
      parsed.data.chatId !== undefined ||
      parsed.data.messageThreadId !== undefined
    ) {
      const throttled = await throttleTelegram(session)
      if (throttled) return throttled
    }
    const res = await updateNotificationChannel(session.user, parsed.data)
    revalidateChannel(parsed.data.channelId)
    return ok(res, m.server.updated)
  } catch (e) {
    return toFail(e)
  }
}

/**
 * Replacing the bot token is sensitive: re-authenticate (password + TOTP when 2FA is on) through the shared gate -
 * failures are counted (5 / 15 min / user, all sensitive actions) and logged as notification_channel.token.replace.
 */
export async function replaceTelegramTokenAction(
  input: unknown
): Promise<ActionResult<TelegramCheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = replaceTelegramTokenSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleTelegram(session)
    if (throttled) return throttled
    await requireReauth(
      {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      },
      {
        action: "notification_channel.token.replace",
        target: { type: "notification_channel", id: parsed.data.channelId },
      },
      await requestReauthVerifier(session.user, parsed.data),
      { sessionId: session.sessionId }
    )
    const res = await replaceNotificationChannelToken(session.user, parsed.data)
    revalidateChannel(parsed.data.channelId)
    return ok(res, m.server.tokenReplaced)
  } catch (e) {
    return toFail(e)
  }
}

/** "Kiểm tra lại". */
export async function recheckTelegramChannelAction(
  input: unknown
): Promise<ActionResult<ChannelRecheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = channelIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleTelegram(session)
    if (throttled) return throttled
    const res = await recheckNotificationChannel(
      session.user,
      parsed.data.channelId
    )
    revalidateChannel(parsed.data.channelId)
    return ok(res, res.ok ? m.server.rechecked : undefined)
  } catch (e) {
    return toFail(e)
  }
}

/** "Gửi tin thử" (synchronous). `data.ok = false` + `data.error` when Telegram refused it. */
export async function sendTelegramTestAction(
  input: unknown
): Promise<ActionResult<TelegramTestResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = channelIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleTelegram(session)
    if (throttled) return throttled
    const res = await sendNotificationChannelTest(
      session.user,
      parsed.data.channelId
    )
    revalidateChannel(parsed.data.channelId)
    return ok(res, res.ok ? m.server.testSent : undefined)
  } catch (e) {
    return toFail(e)
  }
}

export async function setTelegramChannelEnabledAction(
  input: unknown
): Promise<ActionResult<{ status: NotificationChannelStatus }>> {
  try {
    const session = await requireUserForAction()
    const parsed = setChannelEnabledSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const res = await setNotificationChannelEnabled(session.user, parsed.data)
    revalidateChannel(parsed.data.channelId)
    return ok(res, parsed.data.enabled ? m.server.enabled : m.server.disabled)
  } catch (e) {
    return toFail(e)
  }
}

/** MCPs that lose the channel if it is deleted (delete dialog). */
export async function telegramChannelUsageAction(
  input: unknown
): Promise<ActionResult<ChannelMcpUsage[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = channelIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    return ok(
      await getNotificationChannelUsage(session.user, parsed.data.channelId)
    )
  } catch (e) {
    return toFail(e)
  }
}

export async function deleteTelegramChannelAction(
  input: unknown
): Promise<
  ActionResult<{ affectedMcpIds: string[]; affectedMcpCount: number }>
> {
  try {
    const session = await requireUserForAction()
    const parsed = channelIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const res = await deleteNotificationChannel(
      session.user,
      parsed.data.channelId
    )
    revalidatePath(LIST)
    return ok(res, m.server.deleted)
  } catch (e) {
    return toFail(e)
  }
}

/** Last 50 deliveries (refresh of the detail page table). */
export async function listTelegramDeliveriesAction(
  input: unknown
): Promise<ActionResult<NotificationDeliveryDto[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = channelIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    return ok(
      await listNotificationDeliveries(session.user, parsed.data.channelId)
    )
  } catch (e) {
    return toFail(e)
  }
}

/** Channel options of the MCP wizard: the viewer's own channels (admins too - an MCP only uses its owner's). */
export async function listMcpChannelOptionsAction(): Promise<
  ActionResult<McpChannelOption[]>
> {
  try {
    const session = await requireUserForAction()
    return ok(await listChannelsForMcpScope(session.user))
  } catch (e) {
    return toFail(e)
  }
}
