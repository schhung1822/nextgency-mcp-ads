// Framework-agnostic connection operations shared by the web services (src/server/services/connections.ts)
// and the pg-boss worker (scripts/worker.ts). MUST NOT import "next/*" or "server-only".
// Credentials are decrypted only inside these functions and never returned to callers.
import { RELEASED_PLATFORMS } from "@/lib/platforms"
import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm"

import { connectionStatus as cs } from "@/lib/i18n/vi/connection-status"
import { connections as m } from "@/lib/i18n/vi/connections"
import { formatDate } from "@/lib/format"
import { isDefaultEnabled, type ConnectionStatusValue } from "@/lib/schemas/connections"
import { redactString } from "@/server/audit/redact"
import { safeErrorForLog as safeGenericError } from "@/server/audit/safe-error"
import { aad, decryptJson, encryptJson } from "@/server/crypto/secret-box"
import { db, type Tx } from "@/server/db/client"
import { adAccounts, connections, mcpPageScopes, metaPages } from "@/server/db/schema"
import { isProviderError } from "@/server/providers/errors"
import { getProvider } from "@/server/providers/registry"
import type { AdAccountInfo, CredentialCheck, PageInfo, PageListResult, Platform } from "@/server/providers/types"

/** Tokens expiring within this window are flagged "expiring" (Sắp hết hạn). */
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Key inside connections.meta holding the Vietnamese warnings of the last check (non-secret). */
export const META_WARNINGS_KEY = "checkWarnings"

/** Key inside connections.meta: outcome of the last Facebook Pages sync (Meta only, non-secret). */
export const PAGES_SYNC_KEY = "pagesSync"

export interface PagesSyncInfo {
  ok: boolean
  at: string
  count: number
  warnings: string[]
}

export type ConnectionRow = typeof connections.$inferSelect

export interface Health {
  status: ConnectionStatusValue
  statusMessage: string | null
}

export interface VerifyOutcome {
  check: CredentialCheck
  /** null when the token is invalid or accounts were not requested */
  accounts: AdAccountInfo[] | null
  /** Facebook Pages (providers with listPages, when accounts are listed); null when not requested / not supported */
  pages: PageListResult | null
  /** connectionMeta merged with check.meta (+ warnings), ready to persist */
  meta: Record<string, unknown>
  health: Health
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** active / expiring (< 7 days) / invalid from a CredentialCheck. */
export function deriveHealth(check: CredentialCheck, now: Date = new Date()): Health {
  if (!check.valid) {
    return { status: "invalid", statusMessage: check.warnings[0] ?? cs.message.invalid }
  }
  if (check.tokenExpiresAt) {
    const ms = check.tokenExpiresAt.getTime() - now.getTime()
    if (ms <= 0) return { status: "invalid", statusMessage: cs.message.expired(formatDate(check.tokenExpiresAt)) }
    if (ms < EXPIRING_WINDOW_MS) {
      const days = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)))
      return { status: "expiring", statusMessage: cs.message.expiring(days, formatDate(check.tokenExpiresAt)) }
    }
  }
  return { status: "active", statusMessage: null }
}

/** User-facing Vietnamese message for any error thrown by an adapter (never leaks upstream details). */
export function providerErrorMessage(e: unknown): string {
  if (isProviderError(e)) {
    const parts = [e.userMessageVi, e.hint].filter((s): s is string => !!s && s.trim() !== "")
    return redactString(parts.join(" ")) || m.errors.upstream
  }
  return m.errors.upstream
}

/**
 * What happened, for the connection's `status_message`: the adapter's Vietnamese message WITHOUT its hint (the next
 * step is shown separately as `statusHint`).
 */
export function providerStatusMessage(e: unknown): string {
  if (isProviderError(e)) return redactString(e.userMessageVi ?? "").trim() || m.errors.upstream
  return m.errors.upstream
}

/**
 * Health after a failed check. Auth/permission errors mark the connection invalid; transient errors
 * (rate limit, 5xx, timeout…) keep the current status and only record the message.
 */
export function healthFromError(e: unknown): { status: ConnectionStatusValue | null; statusMessage: string } {
  if (isProviderError(e) && (e.code === "auth_invalid" || e.code === "permission_denied")) {
    return { status: "invalid", statusMessage: providerStatusMessage(e) }
  }
  return { status: null, statusMessage: cs.message.checkFailed(providerStatusMessage(e)) }
}

/** One-line, redacted description of an error for stdout (no stack, no secrets). */
export function safeErrorForLog(e: unknown): string {
  if (isProviderError(e)) return redactString(`${e.platform}/${e.code}: ${e.message}`).slice(0, 500)
  return safeGenericError(e)
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function encryptCredentials(connectionId: string, credentials: unknown): string {
  return encryptJson(credentials, aad.connectionCredentials(connectionId))
}

export function decryptCredentials<C = unknown>(row: Pick<ConnectionRow, "id" | "credentialsEncrypted">): C {
  return decryptJson<C>(row.credentialsEncrypted, aad.connectionCredentials(row.id))
}

/**
 * validateCredentials (+ listAccounts when valid and requested). Network only - call it OUTSIDE a DB
 * transaction. Errors thrown by the adapter propagate (ProviderError).
 */
export async function verifyCredentials(
  platform: Platform,
  credentials: unknown,
  opts: {
    connectionId?: string
    connectionMeta?: Record<string, unknown>
    listAccounts?: boolean
    /** default: same as listAccounts */
    listPages?: boolean
    now?: Date
  } = {}
): Promise<VerifyOutcome> {
  const provider = getProvider(platform)
  const baseMeta = { ...(opts.connectionMeta ?? {}) }
  delete baseMeta[META_WARNINGS_KEY]
  const check = await provider.validateCredentials({
    connectionId: opts.connectionId,
    credentials,
    connectionMeta: baseMeta,
  })
  const meta: Record<string, unknown> = { ...baseMeta, ...(check.meta ?? {}) }
  let accounts: AdAccountInfo[] | null = null
  if (check.valid && opts.listAccounts !== false) {
    accounts = await provider.listAccounts({ connectionId: opts.connectionId, credentials, connectionMeta: meta })
  }
  let pages: PageListResult | null = null
  if (check.valid && provider.listPages && (opts.listPages ?? opts.listAccounts !== false)) {
    pages = await listPagesSafe(() => provider.listPages!({ connectionId: opts.connectionId, credentials, connectionMeta: meta }))
    const info: PagesSyncInfo = {
      ok: pages.ok,
      at: (opts.now ?? new Date()).toISOString(),
      count: pages.pages.length,
      warnings: pages.warnings.map((w) => redactString(w)).slice(0, 10),
    }
    meta[PAGES_SYNC_KEY] = info
  }
  meta[META_WARNINGS_KEY] = check.warnings ?? []
  return { check, accounts, pages, meta, health: deriveHealth(check, opts.now) }
}

/** listPages must never fail a connection check: any error becomes "not read" (stored Pages stay untouched). */
async function listPagesSafe(run: () => Promise<PageListResult>): Promise<PageListResult> {
  try {
    return await run()
  } catch (e) {
    console.warn("[connections] listPages failed:", safeErrorForLog(e))
    return { ok: false, pages: [], warnings: [m.errors.pagesUnreadable] }
  }
}

// ---------------------------------------------------------------------------
// Ad accounts upsert / sync
// ---------------------------------------------------------------------------

export interface UpsertSummary {
  total: number
  inserted: number
  missing: number
}

const UPSERT_CHUNK = 500

/**
 * Upsert ad accounts of a connection. Existing rows keep their `is_enabled`.
 * New rows:
 * - initial creation (`newAccountsEnabled: true`): enabled by default (`isDefaultEnabled`: not closed / disabled /
 *   pending, not a manager account) unless listed in `disabledExternalIds`; an account listed in
 *   `enabledExternalIds` is enabled even when it defaults to OFF (both lists come from the wizard step 3);
 * - any later sync / credential replacement (default): DISABLED - an MCP scoped to "all accounts" of the
 *   connection must not silently gain accounts the user never reviewed (L10). They enable them on the
 *   connection page.
 * With `markMissing`, rows no longer returned by the platform are marked `closed` (status_raw
 * "not_returned") - rows are NEVER deleted (MCP scopes reference them).
 */
export async function upsertAdAccounts(
  tx: Tx | typeof db,
  connectionId: string,
  platform: Platform,
  accounts: AdAccountInfo[],
  opts: {
    disabledExternalIds?: Iterable<string>
    enabledExternalIds?: Iterable<string>
    newAccountsEnabled?: boolean
    markMissing?: boolean
    now?: Date
  } = {}
): Promise<UpsertSummary> {
  const now = opts.now ?? new Date()
  const disabled = new Set(opts.disabledExternalIds ?? [])
  const forcedOn = new Set(opts.enabledExternalIds ?? [])
  const newEnabled = opts.newAccountsEnabled === true
  // de-duplicate by external id (MCC trees can list the same customer twice)
  const unique = [...new Map(accounts.map((a) => [a.externalId, a])).values()]

  const existing = await tx
    .select({ externalId: adAccounts.externalId })
    .from(adAccounts)
    .where(eq(adAccounts.connectionId, connectionId))
  const existingIds = new Set(existing.map((r) => r.externalId))

  for (let i = 0; i < unique.length; i += UPSERT_CHUNK) {
    const chunk = unique.slice(i, i + UPSERT_CHUNK)
    await tx
      .insert(adAccounts)
      .values(
        chunk.map((a) => ({
          connectionId,
          platform,
          externalId: a.externalId,
          name: a.name || a.externalId,
          currency: (a.currency || "XXX").toUpperCase().slice(0, 3),
          timezone: a.timezone || "UTC",
          status: a.status,
          statusRaw: a.statusRaw ?? null,
          isEnabled: newEnabled && !disabled.has(a.externalId) && (forcedOn.has(a.externalId) || isDefaultEnabled(a)),
          isManager: a.isManager ?? false,
          parentExternalId: a.parentExternalId ?? null,
          extra: a.extra ?? {},
          lastSyncedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: [adAccounts.connectionId, adAccounts.externalId],
        set: {
          name: sql`excluded.name`,
          currency: sql`excluded.currency`,
          timezone: sql`excluded.timezone`,
          status: sql`excluded.status`,
          statusRaw: sql`excluded.status_raw`,
          isManager: sql`excluded.is_manager`,
          parentExternalId: sql`excluded.parent_external_id`,
          extra: sql`excluded.extra`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: now,
        },
      })
  }

  let missing = 0
  if (opts.markMissing) {
    const ids = unique.map((a) => a.externalId)
    const res = await tx
      .update(adAccounts)
      .set({ status: "closed", statusRaw: "not_returned", updatedAt: now })
      .where(
        and(
          eq(adAccounts.connectionId, connectionId),
          ids.length ? notInArray(adAccounts.externalId, ids) : undefined,
          ne(adAccounts.status, "closed")
        )
      )
      .returning({ id: adAccounts.id })
    missing = res.length
  }

  return {
    total: unique.length,
    inserted: unique.filter((a) => !existingIds.has(a.externalId)).length,
    missing,
  }
}

// ---------------------------------------------------------------------------
// Facebook Pages upsert / sync (Meta)
// ---------------------------------------------------------------------------

/**
 * Upsert the Pages of a connection. Existing rows keep `is_enabled`. New rows are enabled only on the FIRST Pages
 * sync of the connection - no Page row yet AND no MCP Page scope on the connection (an MCP may have saved "all Pages"
 * on a connection that had none); otherwise they start DISABLED so an MCP scoped to "all Pages" never silently gains
 * Pages (same rule as ad accounts, L10). Pages no longer returned are flagged `is_missing` (never deleted - MCP scopes
 * reference them) and are hidden from MCPs.
 */
export async function upsertMetaPages(
  tx: Tx | typeof db,
  connectionId: string,
  pages: PageInfo[],
  opts: { now?: Date } = {}
): Promise<UpsertSummary> {
  const now = opts.now ?? new Date()
  const unique = [...new Map(pages.map((p) => [p.externalId, p])).values()]
  const existing = await tx
    .select({ externalId: metaPages.externalId })
    .from(metaPages)
    .where(eq(metaPages.connectionId, connectionId))
  const existingIds = new Set(existing.map((r) => r.externalId))
  const scoped =
    existing.length === 0
      ? await tx.select({ id: mcpPageScopes.id }).from(mcpPageScopes).where(eq(mcpPageScopes.connectionId, connectionId)).limit(1)
      : []
  const firstSync = existing.length === 0 && scoped.length === 0

  for (let i = 0; i < unique.length; i += UPSERT_CHUNK) {
    const chunk = unique.slice(i, i + UPSERT_CHUNK)
    await tx
      .insert(metaPages)
      .values(
        chunk.map((p) => ({
          connectionId,
          externalId: p.externalId,
          name: p.name || p.externalId,
          category: p.category,
          link: p.link,
          pictureUrl: p.pictureUrl,
          followersCount: p.followersCount === null ? null : Math.min(Math.max(Math.trunc(p.followersCount), 0), 2_147_483_647),
          verificationStatus: p.verificationStatus,
          isPublished: p.isPublished,
          tasks: p.tasks,
          sources: p.sources,
          businessId: p.businessId,
          businessName: p.businessName,
          isEnabled: firstSync,
          isMissing: false,
          lastSyncedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: [metaPages.connectionId, metaPages.externalId],
        set: {
          name: sql`excluded.name`,
          category: sql`excluded.category`,
          link: sql`excluded.link`,
          pictureUrl: sql`excluded.picture_url`,
          followersCount: sql`excluded.followers_count`,
          verificationStatus: sql`excluded.verification_status`,
          isPublished: sql`excluded.is_published`,
          tasks: sql`excluded.tasks`,
          sources: sql`excluded.sources`,
          businessId: sql`excluded.business_id`,
          businessName: sql`excluded.business_name`,
          isMissing: false,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: now,
        },
      })
  }

  const ids = unique.map((p) => p.externalId)
  const gone = await tx
    .update(metaPages)
    .set({ isMissing: true, updatedAt: now })
    .where(
      and(
        eq(metaPages.connectionId, connectionId),
        ids.length ? notInArray(metaPages.externalId, ids) : undefined,
        eq(metaPages.isMissing, false)
      )
    )
    .returning({ id: metaPages.id })

  return {
    total: unique.length,
    inserted: unique.filter((p) => !existingIds.has(p.externalId)).length,
    missing: gone.length,
  }
}

// ---------------------------------------------------------------------------
// Refresh (health check / account sync) - used by services and worker jobs
// ---------------------------------------------------------------------------

export interface RefreshPlan {
  connectionId: string
  ok: boolean
  /** null = keep the current status (transient error) */
  status: ConnectionStatusValue | null
  statusMessage: string | null
  tokenExpiresAt?: Date | null
  scopes?: string[] | null
  meta?: Record<string, unknown>
  accounts: AdAccountInfo[] | null
  /** Facebook Pages listed during the refresh (Meta); null/absent = not listed */
  pages?: PageListResult | null
  /** redacted, for logs */
  error?: string
}

export async function loadConnection(connectionId: string, tx: Tx | typeof db = db): Promise<ConnectionRow | null> {
  const rows = await tx
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

/** Network phase: decrypt, validate (+ list accounts). Never throws for provider errors. */
export async function planRefresh(
  row: ConnectionRow,
  opts: { syncAccounts: boolean; now?: Date }
): Promise<RefreshPlan> {
  let credentials: unknown
  try {
    credentials = decryptCredentials(row)
  } catch (e) {
    // our own key problem (wrong / missing ENCRYPTION_KEYS on this process), not a verdict on the token: say so
    // and keep the status - marking every connection invalid because of a misconfigured worker would be destructive
    return {
      connectionId: row.id,
      ok: false,
      status: null,
      statusMessage: cs.message.credentialsUnreadable,
      accounts: null,
      error: `credentials unreadable: ${safeGenericError(e)}`,
    }
  }
  try {
    const out = await verifyCredentials(row.platform, credentials, {
      connectionId: row.id,
      connectionMeta: (row.meta ?? {}) as Record<string, unknown>,
      listAccounts: opts.syncAccounts,
      now: opts.now,
    })
    return {
      connectionId: row.id,
      ok: out.check.valid,
      status: out.health.status,
      statusMessage: out.health.statusMessage,
      tokenExpiresAt: out.check.tokenExpiresAt,
      scopes: out.check.scopes,
      meta: out.meta,
      accounts: out.accounts,
      pages: out.pages,
    }
  } catch (e) {
    const h = healthFromError(e)
    return {
      connectionId: row.id,
      ok: false,
      status: h.status,
      statusMessage: h.statusMessage,
      accounts: null,
      error: safeErrorForLog(e),
    }
  }
}

/** Accounts upsert summary (+ the Facebook Pages one when Pages were synced). */
export type RefreshSummary = UpsertSummary & { pages?: UpsertSummary }

/** DB phase: persist the plan (connection status + accounts). Run inside a transaction. */
export async function applyRefresh(
  tx: Tx | typeof db,
  row: ConnectionRow,
  plan: RefreshPlan,
  now: Date = new Date()
): Promise<RefreshSummary | null> {
  // A transient failure (status unchanged) must not overwrite the reason a connection is already invalid / expiring
  // ("token revoked on …", "expires in 3 days"): that message stays the truth until a real check replaces it.
  const keepReason = plan.status === null && (row.status === "invalid" || row.status === "expiring") && !!row.statusMessage
  const patch: Partial<typeof connections.$inferInsert> = {
    statusMessage: keepReason ? row.statusMessage : plan.statusMessage,
    lastCheckedAt: now,
    updatedAt: now,
  }
  // never resurrect a connection an admin/user disabled
  if (plan.status && row.status !== "disabled") patch.status = plan.status
  if (plan.tokenExpiresAt !== undefined) patch.tokenExpiresAt = plan.tokenExpiresAt
  if (plan.scopes !== undefined) patch.scopes = plan.scopes
  if (plan.meta !== undefined) patch.meta = plan.meta
  await tx.update(connections).set(patch).where(eq(connections.id, row.id))

  const pages = plan.ok && plan.pages?.ok ? await upsertMetaPages(tx, row.id, plan.pages.pages, { now }) : undefined
  if (plan.ok && plan.accounts) {
    const accounts = await upsertAdAccounts(tx, row.id, row.platform, plan.accounts, { markMissing: true, now })
    return pages ? { ...accounts, pages } : accounts
  }
  return null
}

/** Worker entry point: check one connection (and optionally sync its accounts). No activity log. */
export async function refreshConnection(
  connectionId: string,
  opts: { syncAccounts: boolean; now?: Date }
): Promise<(RefreshPlan & { accountsSummary: RefreshSummary | null }) | null> {
  const row = await loadConnection(connectionId)
  if (!row || row.status === "disabled") return null
  const plan = await planRefresh(row, opts)
  const accountsSummary = await db.transaction((tx) => applyRefresh(tx, row, plan, opts.now))
  return { ...plan, accountsSummary }
}

/** Ids of every connection the background jobs should look at (not deleted, not disabled). */
export async function listActiveConnectionIds(): Promise<string[]> {
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(isNull(connections.deletedAt), ne(connections.status, "disabled"), inArray(connections.platform, [...RELEASED_PLATFORMS])))
    .orderBy(sql`${connections.lastCheckedAt} asc nulls first`)
  return rows.map((r) => r.id)
}

/** Count accounts per connection (helper shared with the list query). */
export async function countAccounts(connectionIds: string[]): Promise<Map<string, { total: number; enabled: number }>> {
  const out = new Map<string, { total: number; enabled: number }>()
  if (!connectionIds.length) return out
  const rows = await db
    .select({
      connectionId: adAccounts.connectionId,
      total: sql<number>`count(*)::int`,
      enabled: sql<number>`count(*) filter (where ${adAccounts.isEnabled})::int`,
    })
    .from(adAccounts)
    .where(inArray(adAccounts.connectionId, connectionIds))
    .groupBy(adAccounts.connectionId)
  for (const r of rows) out.set(r.connectionId, { total: Number(r.total), enabled: Number(r.enabled) })
  return out
}
