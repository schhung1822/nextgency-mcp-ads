// Notification channels (Telegram) - .claude/docs/14-telegram-notifications.md §2. Plain tables (no partitioning).
// A channel is NOT an ad platform: no `platform` enum, no ad accounts; MCPs reach it through mcp_notification_scopes.
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { mcpServers } from "./app"
import { user } from "./auth"

/** Non-secret Telegram target, stored in notification_channels.config. */
export interface TelegramChannelConfig {
  /** canonical chat id returned by getChat (numeric, as a string: "-1001234567890") */
  chatId: string
  chatTitle: string | null
  chatType: "private" | "group" | "supergroup" | "channel"
  /** forum topic; null = General topic / no topics (1 is normalised to null) */
  messageThreadId: number | null
  botId: string
  botUsername: string
}

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    type: text("type").notNull().default("telegram"),
    name: text("name").notNull(),
    /** v<ver>.<iv>.<tag>.<ct>, AAD notification_channel:<id>:credentials (the bot token) - never leaves the server */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    credentialHint: text("credential_hint").notNull().default(""),
    config: jsonb("config").$type<TelegramChannelConfig>().notNull(),
    /** subscribed system events: connection_health, system_update (admin only) */
    events: text("events")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** admin only: receive connection_health of EVERY connection (not just the owner's) */
    allConnections: boolean("all_connections").notNull().default(false),
    status: text("status").notNull().default("active"),
    statusMessage: text("status_message"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("notification_channels_owner_idx").on(t.ownerId),
    check("notification_channels_type_chk", sql`${t.type} in ('telegram')`),
    check(
      "notification_channels_status_chk",
      sql`${t.status} in ('active','error','disabled')`
    ),
    check(
      "notification_channels_events_chk",
      sql`${t.events} <@ array['connection_health','system_update']::text[]`
    ),
  ]
)

/** Send log + queue state of every notification (cleaned after log_retention_months_mcp). */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    mcpId: uuid("mcp_id").references(() => mcpServers.id, {
      onDelete: "set null",
    }),
    /** per-channel idempotency key (Telegram has none): conn:<id>:<status>:<day>, update:<version>… */
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    errorCode: integer("error_code"),
    /** Vietnamese reason + redacted Telegram description */
    errorMessage: text("error_message"),
    /** plain text, <= 300 chars, redacted (shown in the UI) */
    preview: text("preview").notNull().default(""),
    /** full HTML message to send; cleared (null) once the delivery is final */
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    unique("notification_deliveries_dedupe_uq").on(t.channelId, t.dedupeKey),
    index("notification_deliveries_channel_created_idx").on(
      t.channelId,
      t.createdAt.desc()
    ),
    // FK index + hourly MCP quota of telegram_send_message (mcp_id, created_at > now() - 1h)
    index("notification_deliveries_mcp_created_idx").on(t.mcpId, t.createdAt),
    index("notification_deliveries_created_idx").on(t.createdAt),
    check(
      "notification_deliveries_source_chk",
      sql`${t.source} in ('system','mcp_tool','mcp_write','test')`
    ),
    check(
      "notification_deliveries_status_chk",
      sql`${t.status} in ('pending','sent','failed')`
    ),
    check(
      "notification_deliveries_event_chk",
      sql`${t.eventType} in ('connection_expiring','connection_invalid','connection_recovered','update_available','update_succeeded','update_failed','mcp_write','mcp_message','test')`
    ),
  ]
)

/** Channels an MCP may send to (telegram_send_message) / notify after writes. */
export const mcpNotificationScopes = pgTable(
  "mcp_notification_scopes",
  {
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.mcpId, t.channelId] }),
    index("mcp_notification_scopes_channel_idx").on(t.channelId),
  ]
)
