import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth"

export const platformEnum = pgEnum("platform", ["meta", "tiktok", "google_ads", "openai_ads"])

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

// ---------------------------------------------------------------------------
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    platform: platformEnum("platform").notNull(),
    name: text("name").notNull(),
    /** v<ver>.<iv>.<tag>.<ct>, AAD connection:<id>:credentials */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    credentialHint: text("credential_hint").notNull().default(""),
    status: text("status").notNull().default("active"),
    statusMessage: text("status_message"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes").array(),
    /** non-secret metadata (app_id, login_customer_id, probed features…) */
    meta: jsonb("meta").notNull().default({}),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("connections_owner_idx").on(t.ownerId),
    index("connections_platform_idx").on(t.platform),
    check("connections_status_chk", sql`${t.status} in ('active','expiring','invalid','disabled')`),
  ]
)

// ---------------------------------------------------------------------------
export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull().default("unknown"),
    statusRaw: text("status_raw"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isManager: boolean("is_manager").notNull().default(false),
    parentExternalId: text("parent_external_id"),
    extra: jsonb("extra").notNull().default({}),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("ad_accounts_connection_external_uq").on(t.connectionId, t.externalId),
    index("ad_accounts_platform_external_idx").on(t.platform, t.externalId),
    check("ad_accounts_status_chk", sql`${t.status} in ('active','disabled','pending','closed','unknown')`),
  ]
)

// ---------------------------------------------------------------------------
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyEncrypted: text("key_encrypted").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** McpSettings (validated with zod in services) */
    settings: jsonb("settings").notNull().default({}),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastClient: text("last_client"),
    keyRotatedAt: timestamp("key_rotated_at", { withTimezone: true }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("mcp_servers_key_hash_uq").on(t.keyHash),
    index("mcp_servers_owner_idx").on(t.ownerId),
    check("mcp_servers_status_chk", sql`${t.status} in ('active','disabled')`),
  ]
)

export const mcpPlatformPermissions = pgTable(
  "mcp_platform_permissions",
  {
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    permissions: text("permissions").array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mcpId, t.platform] }),
    check(
      "mcp_platform_permissions_chk",
      sql`${t.permissions} <@ array['read','status','update','copy','create','delete']::text[] and 'read' = any(${t.permissions})`
    ),
  ]
)

export const mcpAccountScopes = pgTable(
  "mcp_account_scopes",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** null = every enabled account of the connection (including future ones) */
    adAccountId: uuid("ad_account_id").references(() => adAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("mcp_account_scopes_uq").on(t.mcpId, t.connectionId, t.adAccountId).nullsNotDistinct(),
    index("mcp_account_scopes_connection_idx").on(t.connectionId),
    index("mcp_account_scopes_account_idx").on(t.adAccountId),
  ]
)

// ---------------------------------------------------------------------------
// Facebook Pages of a Meta connection (read-only feature, .claude/docs/11-meta-pages.md)
export const metaPages = pgTable(
  "meta_pages",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    link: text("link"),
    pictureUrl: text("picture_url"),
    followersCount: integer("followers_count"),
    verificationStatus: text("verification_status"),
    isPublished: boolean("is_published"),
    /** normalised Page tasks of the token user (ANALYZE, ADVERTISE…); empty = only seen through a Business Manager */
    tasks: text("tasks").array().notNull().default(sql`'{}'::text[]`),
    /** subset of me_accounts / owned_pages / client_pages */
    sources: text("sources").array().notNull().default(sql`'{}'::text[]`),
    businessId: text("business_id"),
    businessName: text("business_name"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    /** not returned by the last successful sync - kept (MCP scopes reference it) but never handed to an MCP */
    isMissing: boolean("is_missing").notNull().default(false),
    extra: jsonb("extra").notNull().default({}),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("meta_pages_connection_external_uq").on(t.connectionId, t.externalId),
    index("meta_pages_external_idx").on(t.externalId),
  ]
)

export const mcpPageScopes = pgTable(
  "mcp_page_scopes",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** null = every enabled Page of the connection (including Pages synced later) */
    pageId: uuid("page_id").references(() => metaPages.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("mcp_page_scopes_uq").on(t.mcpId, t.connectionId, t.pageId).nullsNotDistinct(),
    index("mcp_page_scopes_connection_idx").on(t.connectionId),
    index("mcp_page_scopes_page_idx").on(t.pageId),
  ]
)

export const mcpPendingActions = pgTable(
  "mcp_pending_actions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tokenHash: text("token_hash").notNull(),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    argsHash: text("args_hash").notNull(),
    args: jsonb("args").notNull(),
    preview: jsonb("preview").notNull(),
    status: text("status").notNull().default("pending"),
    result: jsonb("result"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mcp_pending_actions_token_uq").on(t.tokenHash),
    index("mcp_pending_actions_mcp_idx").on(t.mcpId),
    index("mcp_pending_actions_expires_idx").on(t.expiresAt),
    check("mcp_pending_actions_status_chk", sql`${t.status} in ('pending','consumed','expired')`),
  ]
)

export const mcpCallStatsHourly = pgTable(
  "mcp_call_stats_hourly",
  {
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    mcpId: uuid("mcp_id").notNull(),
    ownerId: text("owner_id"),
    platform: text("platform").notNull().default(""),
    toolName: text("tool_name").notNull().default(""),
    calls: integer("calls").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    writes: integer("writes").notNull().default(0),
    durationMsSum: bigint("duration_ms_sum", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.mcpId, t.platform, t.toolName] }),
    index("mcp_call_stats_owner_idx").on(t.ownerId, t.bucket),
  ]
)

// ---------------------------------------------------------------------------
// System update requests (.claude/docs/10-update-system.md §3). The web app INSERTs a `pending` row (admin +
// re-auth, one transaction with the activity log); the separate `updater` service claims it
// (`FOR UPDATE SKIP LOCKED`), runs backup → pull → migrate → restart → healthcheck and writes the outcome here.
// The web container never touches docker.
export const systemUpdateRequests = pgTable(
  "system_update_requests",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    /** version running when the request was made */
    fromVersion: text("from_version").notNull(),
    /** semver without "v" - the updater re-validates it (^\d+\.\d+\.\d+$) */
    targetVersion: text("target_version").notNull(),
    status: text("status").notNull().default("pending"),
    step: text("step"),
    /** short Vietnamese message shown in the UI (redacted) */
    message: text("message"),
    /** technical log tail, <= 64 KB, redacted (no tokens / passwords) */
    log: text("log"),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("system_update_requests_status_chk", sql`${t.status} in ('pending','running','succeeded','failed','rolled_back')`),
    check(
      "system_update_requests_step_chk",
      sql`${t.step} is null or ${t.step} in ('backup','pull','migrate','restart','healthcheck','rollback')`
    ),
    // strict MAJOR.MINOR.PATCH (no leading zeros): second line of defence behind zod and the updater's own regex,
    // because the value ends up in an image tag
    check(
      "system_update_requests_target_chk",
      sql`${t.targetVersion} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`
    ),
    // at most ONE open request (pending or running) at any time
    uniqueIndex("system_update_requests_open_uq")
      .on(sql`(true)`)
      .where(sql`${t.status} in ('pending','running')`),
    index("system_update_requests_created_idx").on(t.createdAt.desc()),
  ]
)
