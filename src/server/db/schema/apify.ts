// Apify (data collection through Actors) - .claude/docs/16-apify.md §3. Plain tables (no partitioning).
// Apify is NOT an ad platform: no `platform` enum. API tokens are encrypted with AES-256-GCM + AAD
// apify_token:<id>:credentials (src/server/apify/store.ts is the only module that encrypts / decrypts them) and
// never leave the server. Nothing from GET /v2/users/me that is personal or secret (email, proxy password) is stored.
import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { mcpServers } from "./app"
import { user } from "./auth"

/**
 * Apify API tokens. company = shared by every MCP that enables Apify (admins create / manage them);
 * personal = only the owner's MCPs rotate through it. Tokens of one Apify account (same apify_user_id) share the
 * credit: the pool groups them.
 */
export const apifyTokens = pgTable(
  "apify_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    scope: text("scope").notNull(),
    /** creator (company: the admin who added it) / owner (personal) */
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** v<ver>.<iv>.<tag>.<ct> of the API token, AAD apify_token:<id>:credentials; soft delete → re-encrypted "" */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    /** last 4 chars of the token (UI) */
    credentialHint: text("credential_hint").notNull().default(""),
    /** GET /v2/users/me id: tokens of one account share the credit */
    apifyUserId: text("apify_user_id"),
    apifyUsername: text("apify_username"),
    /** plan.id (FREE / STARTER / SCALE / BUSINESS…) */
    planId: text("plan_id"),
    /** plan.tier (FREE…DIAMOND): pay-per-event prices depend on it */
    planTier: text("plan_tier"),
    /** cached /v2/users/me/limits current.monthlyUsageUsd */
    usageUsd: numeric("usage_usd", { precision: 12, scale: 4, mode: "number" }),
    /** cached /v2/users/me/limits limits.maxMonthlyUsageUsd */
    limitUsd: numeric("limit_usd", { precision: 12, scale: 4, mode: "number" }),
    /** monthlyUsageCycle.endAt: the credit resets then */
    cycleEndAt: timestamp("cycle_end_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    /** Vietnamese, redacted */
    statusMessage: text("status_message"),
    /** exhausted: usable again from then (= cycle_end_at, else +24 h) */
    exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
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
    index("apify_tokens_owner_idx").on(t.ownerId),
    index("apify_tokens_scope_idx").on(t.scope),
    index("apify_tokens_apify_user_idx").on(t.apifyUserId),
    check("apify_tokens_scope_chk", sql`${t.scope} in ('company','personal')`),
    check(
      "apify_tokens_status_chk",
      sql`${t.status} in ('active','exhausted','invalid','error','disabled')`
    ),
  ]
)

/**
 * Runs started by an MCP. The token is PINNED: every later call for the run (get run, dataset, abort) uses the token
 * that started it (Apify resources are "Restricted" by default). The AI only reaches runs of its own MCP.
 * Rows older than 90 days are deleted by the apify.health job.
 */
export const apifyRuns = pgTable(
  "apify_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apifyTokens.id, { onDelete: "restrict" }),
    /** "username~name" */
    actorId: text("actor_id").notNull(),
    /** catalog task; null = an Actor outside the catalog */
    taskKey: text("task_key"),
    /** Apify run id; "pending:<uuid>" = a daily-cap reservation (status STARTING, or UNKNOWN when the start was uncertain) */
    runId: text("run_id").notNull(),
    /** defaultDatasetId */
    datasetId: text("dataset_id"),
    /** READY / RUNNING / TIMING-OUT / ABORTING / SUCCEEDED / FAILED / TIMED-OUT / ABORTED */
    status: text("status").notNull(),
    /** maxTotalChargeUsd sent with the run */
    maxChargeUsd: numeric("max_charge_usd", {
      precision: 10,
      scale: 4,
      mode: "number",
    }).notNull(),
    /** usageTotalUsd (real cost, refreshed when the run is read) */
    usageUsd: numeric("usage_usd", { precision: 12, scale: 4, mode: "number" }),
    itemCount: integer("item_count"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("apify_runs_mcp_run_uq").on(t.mcpId, t.runId),
    // one owner per Apify run across ALL MCPs (a recovered run can never be claimed by two MCPs); daily-cap
    // reservations use a unique placeholder "pending:<uuid>" and are left out
    uniqueIndex("apify_runs_run_uq")
      .on(t.runId)
      .where(sql`${t.runId} not like 'pending:%'`),
    index("apify_runs_mcp_created_idx").on(t.mcpId, t.createdAt),
    index("apify_runs_token_idx").on(t.tokenId),
  ]
)
