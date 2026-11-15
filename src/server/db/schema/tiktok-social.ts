// TikTok Social (organic TikTok accounts through TikTok's Social MCP server) - .claude/docs/17-tiktok-social.md §4.
// Not an ad platform: no `platform` enum. Tokens (access 1 day + refresh 1 year) are encrypted with AES-256-GCM + AAD
// tiktok_social_account:<id>:credentials (src/server/tiktok-social/store.ts is the only module that encrypts / decrypts
// them) and never leave the server.
import { sql } from "drizzle-orm"
import { boolean, check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { mcpServers } from "./app"
import { user } from "./auth"

/**
 * OAuth clients this install registered on TikTok's Social MCP server (Dynamic Client Registration, public client - no
 * secret). One per redirect URI: a new APP_URL registers a new client; tokens keep the client that issued them.
 */
export const tiktokSocialClients = pgTable("tiktok_social_clients", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  redirectUri: text("redirect_uri").notNull().unique(),
  clientId: text("client_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One connected TikTok account (one sign-in). A TikTok account (username, case-insensitive) has at most ONE live row:
 * signing in again with the same account replaces the tokens of that row (doc 17 TSD1).
 */
export const tiktokSocialAccounts = pgTable(
  "tiktok_social_accounts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** who connected it (staff: only their own MCPs use it; admins see every row) */
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** TikTok username (handle) at the last check, lower case - the identity used against duplicates */
    username: text("username").notNull(),
    displayName: text("display_name"),
    /** profile_deep_link (vm.tiktok.com short link) */
    profileUrl: text("profile_url"),
    isBusinessAccount: boolean("is_business_account"),
    /** OAuth client that issued the tokens (refresh must use it) */
    clientId: text("client_id").notNull(),
    /** v<ver>.<iv>.<tag>.<ct> of {accessToken, refreshToken}; soft delete → re-encrypted "" */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    /** the 1-year authorization window: sign in again after it */
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("active"),
    /** Vietnamese, redacted */
    statusMessage: text("status_message"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("tiktok_social_accounts_owner_idx").on(t.ownerId),
    uniqueIndex("tiktok_social_accounts_username_uq")
      .on(t.username)
      .where(sql`${t.deletedAt} is null`),
    check(
      "tiktok_social_accounts_status_chk",
      sql`${t.status} in ('active','expiring','invalid','disabled')`
    ),
  ]
)

/** TikTok accounts an MCP may read (tiktok_social_* tools). */
export const mcpTiktokSocialScopes = pgTable(
  "mcp_tiktok_social_scopes",
  {
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => tiktokSocialAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.mcpId, t.accountId] }),
    index("mcp_tiktok_social_scopes_account_idx").on(t.accountId),
  ]
)
