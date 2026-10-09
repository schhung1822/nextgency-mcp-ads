// Google Drive / Google Sheets as a creative source - .claude/docs/15-google-drive-media.md §10.
// Plain tables (no partitioning). Secrets (service account JSON, API key, resource keys) are encrypted with
// AES-256-GCM + AAD (src/server/crypto/secret-box.ts `aad.drive*`) and never leave the server.
import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import type {
  FolderSourceConfig,
  SheetSourceConfig,
} from "../../drive/types"

import { adAccounts, mcpServers, platformEnum } from "./app"
import { user } from "./auth"

/**
 * Google credentials used to read Drive / Sheets.
 * - system: ONE live row (partial unique index), owner_id NULL, service account JSON + optional API key
 *   (public "Anyone with the link" files are read with the API key only).
 * - personal: a staff member's own service account (owner_id set, never an API key).
 */
export const driveCredentials = pgTable(
  "drive_credentials",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    kind: text("kind").notNull(),
    ownerId: text("owner_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull().default(""),
    /** v<ver>.<iv>.<tag>.<ct> of the GoogleServiceAccount JSON, AAD drive_credential:<id>:credentials */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    /** system only: Google API key (anonymous access to public files), AAD drive_credential:<id>:api_key */
    apiKeyEncrypted: text("api_key_encrypted"),
    /** last 4 chars of the API key (UI) */
    apiKeyHint: text("api_key_hint"),
    /** service account email - NOT a secret (users share folders with it) */
    clientEmail: text("client_email").notNull(),
    /** last 4 chars of the private_key_id (UI) */
    credentialHint: text("credential_hint").notNull().default(""),
    status: text("status").notNull().default("active"),
    statusMessage: text("status_message"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
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
    index("drive_credentials_owner_idx").on(t.ownerId),
    uniqueIndex("drive_credentials_one_system_uq")
      .on(t.kind)
      .where(sql`${t.kind} = 'system' and ${t.deletedAt} is null`),
    check(
      "drive_credentials_kind_chk",
      sql`${t.kind} in ('system','personal')`
    ),
    check(
      "drive_credentials_owner_chk",
      sql`(${t.kind} = 'system') = (${t.ownerId} is null)`
    ),
    check(
      "drive_credentials_api_key_chk",
      sql`${t.apiKeyEncrypted} is null or ${t.kind} = 'system'`
    ),
    check(
      "drive_credentials_status_chk",
      sql`${t.status} in ('active','error','disabled')`
    ),
  ]
)

/**
 * A registered Drive folder or Google Sheet tab. First registration of (credential, google id, gid) wins
 * (anti "claiming", doc 15 §5.2) - enforced by the partial unique index over live rows.
 * config (camelCase JSON): folder → FolderSourceConfig, sheet → SheetSourceConfig.
 */
export const driveSources = pgTable(
  "drive_sources",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    /** creator (company scope: the admin who created it) */
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => driveCredentials.id, { onDelete: "restrict" }),
    /** folder id or spreadsheet id */
    googleId: text("google_id").notNull(),
    /** sheet tab id (#gid=), NULL for folders */
    sheetGid: integer("sheet_gid"),
    /** resource key of the folder / spreadsheet link, AAD drive_source:<id>:resource_key */
    resourceKeyEncrypted: text("resource_key_encrypted"),
    /** display name (editable) */
    name: text("name").notNull(),
    /** name on Google Drive at the last check */
    googleName: text("google_name"),
    sharedDriveId: text("shared_drive_id"),
    /**
     * Drive ids of the visible ancestors of the folder / spreadsheet (nearest first), refreshed on recheck and by
     * drive.health. Lets a new registration find live personal sources BELOW it (security review H1).
     */
    ancestorIds: text("ancestor_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    config: jsonb("config")
      .$type<FolderSourceConfig | SheetSourceConfig>()
      .notNull()
      .default({} as FolderSourceConfig),
    status: text("status").notNull().default("active"),
    statusMessage: text("status_message"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
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
    index("drive_sources_owner_idx").on(t.ownerId),
    index("drive_sources_credential_idx").on(t.credentialId),
    // "is the new folder an ancestor of a live source?" → ancestor_ids @> array[<id>]
    index("drive_sources_ancestor_ids_gin").using("gin", t.ancestorIds),
    uniqueIndex("drive_sources_live_uq")
      .on(t.credentialId, t.googleId, sql`coalesce(${t.sheetGid}, -1)`)
      .where(sql`${t.deletedAt} is null`),
    check("drive_sources_kind_chk", sql`${t.kind} in ('folder','sheet')`),
    check("drive_sources_scope_chk", sql`${t.scope} in ('company','personal')`),
    check(
      "drive_sources_status_chk",
      sql`${t.status} in ('active','error','disabled')`
    ),
    check(
      "drive_sources_gid_chk",
      sql`(${t.kind} = 'sheet') = (${t.sheetGid} is not null)`
    ),
  ]
)

/** Drive sources an MCP may use (drive_* tools, ads_upload_media drive_file). */
export const mcpDriveScopes = pgTable(
  "mcp_drive_scopes",
  {
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => driveSources.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.mcpId, t.sourceId] }),
    index("mcp_drive_scopes_source_idx").on(t.sourceId),
  ]
)

/** Media ids already uploaded to an ad account for one version of a Drive file (reuse, doc 15 §7.4). */
export const driveMediaUploads = pgTable(
  "drive_media_uploads",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    driveFileId: text("drive_file_id").notNull(),
    /** md5:<md5>:<size> | rev:<headRevisionId>:<size> | ver:<version> (driveContentKey) */
    contentKey: text("content_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    mediaType: text("media_type").notNull(),
    /** image_hash / video_id / image_id / asset resource / file_id */
    mediaId: text("media_id").notNull(),
    mediaUrl: text("media_url"),
    sourceId: uuid("source_id").references(() => driveSources.id, {
      onDelete: "set null",
    }),
    firstMcpId: uuid("first_mcp_id").references(() => mcpServers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("drive_media_uploads_key_uq").on(
      t.adAccountId,
      t.driveFileId,
      t.contentKey
    ),
    // "uploaded_to" lookups by file id (drive_list_files, folder grid)
    index("drive_media_uploads_file_idx").on(t.driveFileId),
    index("drive_media_uploads_source_idx").on(t.sourceId),
    index("drive_media_uploads_first_mcp_idx").on(t.firstMcpId),
    check(
      "drive_media_uploads_type_chk",
      sql`${t.mediaType} in ('image','video')`
    ),
  ]
)

/**
 * Temporary public links /dl/<token>/<name> the ad platforms fetch videos from (doc 15 §8). Only the SHA-256 of
 * the token is stored. Expired rows are deleted by the drive.cleanup job (> 24 h after expiry).
 */
export const driveRelayLinks = pgTable(
  "drive_relay_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** sha256 hex of the adr_… token */
    tokenHash: text("token_hash").notNull(),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    driveFileId: text("drive_file_id").notNull(),
    contentKey: text("content_key").notNull(),
    access: text("access").notNull(),
    credentialId: uuid("credential_id").references(() => driveCredentials.id, {
      onDelete: "cascade",
    }),
    /** drive_sources.id the file was resolved through (NULL = public link / source deleted); re-checked on GET */
    sourceId: uuid("source_id").references(() => driveSources.id, {
      onDelete: "set null",
    }),
    /** AAD drive_relay_link:<id>:resource_key */
    resourceKeyEncrypted: text("resource_key_encrypted"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    fetchCount: integer("fetch_count").notNull().default(0),
    maxFetches: integer("max_fetches").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("drive_relay_links_token_uq").on(t.tokenHash),
    index("drive_relay_links_expires_idx").on(t.expiresAt),
    index("drive_relay_links_mcp_idx").on(t.mcpId),
    index("drive_relay_links_ad_account_idx").on(t.adAccountId),
    index("drive_relay_links_credential_idx").on(t.credentialId),
    index("drive_relay_links_source_idx").on(t.sourceId),
    check(
      "drive_relay_links_access_chk",
      sql`${t.access} in ('service_account','api_key')`
    ),
    check(
      "drive_relay_links_credential_chk",
      sql`(${t.access} = 'service_account') = (${t.credentialId} is not null)`
    ),
  ]
)

/**
 * Background (chunked) video uploads Drive → Meta / TikTok for videos above the relay threshold (owner decision
 * 2026-10-09). One ACTIVE job per (ad account, Drive file version) - partial unique index. Rows are short-lived
 * (drive.cleanup deletes finished jobs after 30 days). The resource key is encrypted with
 * AAD media_upload_job:<id>:resource_key and never leaves the server.
 */
export const mediaUploadJobs = pgTable(
  "media_upload_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    driveFileId: text("drive_file_id").notNull(),
    /** driveContentKey(file) when the job was created - the worker re-checks it before uploading */
    contentKey: text("content_key").notNull(),
    sourceId: uuid("source_id").references(() => driveSources.id, {
      onDelete: "set null",
    }),
    access: text("access").notNull(),
    credentialId: uuid("credential_id").references(() => driveCredentials.id, {
      onDelete: "cascade",
    }),
    /** AAD media_upload_job:<id>:resource_key */
    resourceKeyEncrypted: text("resource_key_encrypted"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    md5: text("md5"),
    /** media library name on the platform */
    name: text("name"),
    status: text("status").notNull().default("queued"),
    uploadedBytes: bigint("uploaded_bytes", { mode: "number" })
      .notNull()
      .default(0),
    /** video_id (Meta) / video_id (TikTok) once uploaded */
    mediaId: text("media_id"),
    errorCode: text("error_code"),
    /** Vietnamese, safe to show (never secrets) */
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("media_upload_jobs_active_uq")
      .on(t.adAccountId, t.driveFileId, t.contentKey)
      .where(sql`${t.status} in ('queued','uploading','processing')`),
    index("media_upload_jobs_mcp_created_idx").on(t.mcpId, t.createdAt.desc()),
    index("media_upload_jobs_status_updated_idx").on(t.status, t.updatedAt),
    index("media_upload_jobs_ad_account_idx").on(t.adAccountId),
    index("media_upload_jobs_source_idx").on(t.sourceId),
    index("media_upload_jobs_credential_idx").on(t.credentialId),
    check(
      "media_upload_jobs_status_chk",
      sql`${t.status} in ('queued','uploading','processing','done','failed')`
    ),
    check(
      "media_upload_jobs_access_chk",
      sql`${t.access} in ('service_account','api_key')`
    ),
    check(
      "media_upload_jobs_credential_chk",
      sql`(${t.access} = 'service_account') = (${t.credentialId} is not null)`
    ),
    check(
      "media_upload_jobs_size_chk",
      sql`${t.sizeBytes} >= 0 and ${t.uploadedBytes} >= 0`
    ),
  ]
)
