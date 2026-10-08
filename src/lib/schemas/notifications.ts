// Zod schemas + client-safe DTO types for notification channels (Telegram). Shared client/server.
// The bot token is accepted on input only: no DTO ever carries it (only `credentialHint`, 4 last chars).
import { z } from "zod"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import { reauthCodeSchema } from "@/lib/schemas/reauth"
import { hasForbiddenNameChars } from "@/lib/text-safety"

export const NOTIFICATION_CHANNEL_TYPES = ["telegram"] as const
export type NotificationChannelType =
  (typeof NOTIFICATION_CHANNEL_TYPES)[number]

/** System events a channel can subscribe to (`system_update`: admin only). */
export const NOTIFICATION_EVENTS = [
  "connection_health",
  "system_update",
] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export const NOTIFICATION_CHANNEL_STATUSES = [
  "active",
  "error",
  "disabled",
] as const
export type NotificationChannelStatus =
  (typeof NOTIFICATION_CHANNEL_STATUSES)[number]

export const DELIVERY_SOURCES = [
  "system",
  "mcp_tool",
  "mcp_write",
  "test",
] as const
export type DeliverySource = (typeof DELIVERY_SOURCES)[number]

export const DELIVERY_EVENT_TYPES = [
  "connection_expiring",
  "connection_invalid",
  "connection_recovered",
  "update_available",
  "update_succeeded",
  "update_failed",
  "mcp_write",
  "mcp_message",
  "test",
] as const
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number]

export const DELIVERY_STATUSES = ["pending", "sent", "failed"] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export type TelegramChatType = "private" | "group" | "supergroup" | "channel"

/** Telegram bot token: "<bot id>:<secret>" (BotFather). Strict: it ends up in a URL path. */
export const TELEGRAM_BOT_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,100}$/
/** numeric chat id (groups / channels: -100…) or @username of a public group / channel */
export const TELEGRAM_CHAT_ID_RE =
  /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/
export const MAX_THREAD_ID = 2_147_483_647

const uuid = z.uuid({ error: m.errors.notFound })

export const channelNameSchema = z
  .string({ error: m.errors.nameRequired })
  .trim()
  .min(1, { error: m.errors.nameRequired })
  .max(100, { error: m.errors.nameTooLong })
  // same rule as MCP names: no control characters / bidi overrides (the name reaches AI clients and Telegram)
  .refine((v) => !hasForbiddenNameChars(v), { error: m.errors.nameBadChars })

export const botTokenSchema = z
  .string({ error: m.errors.botTokenRequired })
  .trim()
  .min(1, { error: m.errors.botTokenRequired })
  .regex(TELEGRAM_BOT_TOKEN_RE, { error: m.errors.botTokenFormat })

export const chatIdSchema = z
  .string({ error: m.errors.chatIdRequired })
  .trim()
  .min(1, { error: m.errors.chatIdRequired })
  .regex(TELEGRAM_CHAT_ID_RE, { error: m.errors.chatIdFormat })

/** Optional forum topic id: number, digit string, "" or null → number | null. 1 (General) is normalised later. */
export const messageThreadIdSchema = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined) return null
    const s = typeof v === "number" ? String(v) : v.trim()
    if (s === "") return null
    if (!/^\d{1,10}$/.test(s) || Number(s) < 1 || Number(s) > MAX_THREAD_ID) {
      ctx.addIssue({ code: "custom", message: m.errors.threadIdFormat })
      return z.NEVER
    }
    return Number(s)
  })

export const notificationEventsSchema = z
  .array(z.enum(NOTIFICATION_EVENTS, { error: m.errors.eventInvalid }))
  .max(NOTIFICATION_EVENTS.length)
  .transform((v) => [...new Set(v)])

/** "Kiểm tra" in the wizard: validates bot/chat/thread, saves nothing. */
export const previewTelegramChannelSchema = z.object({
  botToken: botTokenSchema,
  chatId: chatIdSchema,
  /** omitted = no topic */
  messageThreadId: messageThreadIdSchema.optional(),
})
export type PreviewTelegramChannelInput = z.input<
  typeof previewTelegramChannelSchema
>

export const createTelegramChannelSchema = z.object({
  name: channelNameSchema,
  botToken: botTokenSchema,
  chatId: chatIdSchema,
  /** omitted = no topic */
  messageThreadId: messageThreadIdSchema.optional(),
  events: notificationEventsSchema.default([]),
  /** admin only */
  allConnections: z.boolean().default(false),
})
export type CreateTelegramChannelInput = z.input<
  typeof createTelegramChannelSchema
>

export const channelIdSchema = z.object({ channelId: uuid })

/** Partial update; chat/thread changes are re-validated against Telegram. */
export const updateTelegramChannelSchema = z.object({
  channelId: uuid,
  name: channelNameSchema.optional(),
  chatId: chatIdSchema.optional(),
  /** undefined = unchanged, null / "" = no topic */
  messageThreadId: messageThreadIdSchema.optional(),
  events: notificationEventsSchema.optional(),
  allConnections: z.boolean().optional(),
})
export type UpdateTelegramChannelInput = z.input<
  typeof updateTelegramChannelSchema
>

export const replaceTelegramTokenSchema = z.object({
  channelId: uuid,
  botToken: botTokenSchema,
  password: z
    .string({ error: m.errors.passwordRequired })
    .min(1, { error: m.errors.passwordRequired })
    .max(256),
  /** TOTP code - required by the server when the user has 2FA enabled */
  code: reauthCodeSchema,
})
export type ReplaceTelegramTokenInput = z.input<
  typeof replaceTelegramTokenSchema
>

export const setChannelEnabledSchema = z.object({
  channelId: uuid,
  enabled: z.boolean(),
})
export type SetChannelEnabledInput = z.input<typeof setChannelEnabledSchema>

/**
 * Client form values of /connections/telegram/new and the detail "Cài đặt" card (all plain strings/booleans, so
 * react-hook-form + zodResolver work without transforms). The server re-validates with the schemas above.
 */
const threadIdFormSchema = z
  .string()
  .trim()
  .refine(
    (v) =>
      v === "" ||
      (/^\d{1,10}$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_THREAD_ID),
    { error: m.errors.threadIdFormat }
  )

export const telegramChannelSettingsFormSchema = z.object({
  name: channelNameSchema,
  chatId: chatIdSchema,
  messageThreadId: threadIdFormSchema,
  events: z.array(z.enum(NOTIFICATION_EVENTS, { error: m.errors.eventInvalid })),
  allConnections: z.boolean(),
})
export type TelegramChannelSettingsFormValues = z.input<
  typeof telegramChannelSettingsFormSchema
>

export const telegramChannelFormSchema = telegramChannelSettingsFormSchema.extend({
  botToken: botTokenSchema,
})
export type TelegramChannelFormValues = z.input<typeof telegramChannelFormSchema>

/** Channel ids chosen for an MCP (wizard step 2). */
export const mcpChannelIdsSchema = z
  .array(uuid)
  .max(20, { error: m.errors.tooManyChannels })
  .default([])

// ---------------------------------------------------------------------------
// DTOs (never contain the token / ciphertext)
// ---------------------------------------------------------------------------

export interface ChannelOwnerDto {
  id: string
  email: string
  name: string
  /** admin-only settings (system_update, allConnections) apply only to channels owned by an admin */
  role: "admin" | "staff"
}

export interface NotificationChannelDto {
  id: string
  type: NotificationChannelType
  name: string
  /** 4 last chars of the bot token */
  credentialHint: string
  botId: string
  botUsername: string
  chatId: string
  chatTitle: string | null
  chatType: TelegramChatType
  messageThreadId: number | null
  events: NotificationEvent[]
  allConnections: boolean
  status: NotificationChannelStatus
  statusMessage: string | null
  lastSentAt: string | null
  lastErrorAt: string | null
  createdAt: string
  updatedAt: string
  owner: ChannelOwnerDto
  /** MCPs (not deleted) that have this channel in scope */
  mcpCount: number
}

/** MCP using a channel; id/name hidden (null) when the viewer may not see that MCP. */
export interface ChannelMcpUsage {
  id: string | null
  name: string | null
  ownedByViewer: boolean
}

export interface NotificationChannelDetail extends NotificationChannelDto {
  usedBy: ChannelMcpUsage[]
}

export interface NotificationDeliveryDto {
  id: string
  source: DeliverySource
  eventType: DeliveryEventType
  status: DeliveryStatus
  attempts: number
  errorCode: number | null
  errorMessage: string | null
  preview: string
  /** null when not visible to the viewer (or no MCP) */
  mcp: { id: string; name: string } | null
  createdAt: string
  sentAt: string | null
}

/** Result of a Telegram configuration check (getMe → getChat → getChatMember). */
export interface TelegramCheckResult {
  bot: { id: string; username: string; name: string }
  chat: {
    id: string
    title: string | null
    type: TelegramChatType
    isForum: boolean
  }
  messageThreadId: number | null
  /** Vietnamese, non-blocking */
  warnings: string[]
}

export interface TelegramTestResult {
  deliveryId: string
  ok: boolean
  /** Vietnamese reason when !ok */
  error: string | null
  channelStatus: NotificationChannelStatus
}

/** Option of the "Telegram" block in the MCP wizard: a channel of the MCP owner (admins too). */
export interface McpChannelOption {
  id: string
  name: string
  chatTitle: string | null
  hasThread: boolean
  status: NotificationChannelStatus
  statusMessage: string | null
  owner: ChannelOwnerDto
}
