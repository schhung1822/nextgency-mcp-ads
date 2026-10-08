// "Kết nối quảng cáo" service: owner checks, encryption at rest, activity log in the same transaction.
// Credentials are decrypted only inside this module / connection-ops and are NEVER returned.
import { isReleasedPlatform, RELEASED_PLATFORMS } from "@/lib/platforms"
import "server-only"
import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"

import { connectionStatus as cs } from "@/lib/i18n/vi/connection-status"
import { connections as m } from "@/lib/i18n/vi/connections"
import {
  isDefaultEnabled,
  statusHintFor,
  type AdAccountDto,
  type ConnectionCheckResult,
  type ConnectionDetail,
  type ConnectionListItem,
  type ConnectionPreview,
  type ConnectionStatusValue,
  type McpUsage,
  type MetaPageDto,
  type PagesSyncDto,
  type PlatformFormSpec,
} from "@/lib/schemas/connections"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { canAccessOwned, type AppUser } from "@/server/auth/session"
import { db } from "@/server/db/client"
import { adAccounts, connections, mcpAccountScopes, mcpServers, metaPages, user as userTable } from "@/server/db/schema"
import {
  applyRefresh,
  countAccounts,
  effectiveStatusAfter,
  encryptCredentials,
  loadConnection,
  META_WARNINGS_KEY,
  PAGES_SYNC_KEY,
  planRefresh,
  providerErrorMessage,
  safeErrorForLog,
  upsertAdAccounts,
  upsertMetaPages,
  verifyCredentials,
  type ConnectionRow,
  type VerifyOutcome,
} from "@/server/jobs/lib/connection-ops"
import { appBaseUrl } from "@/server/env"
import { invalidateGrantCache } from "@/server/mcp/grant"
import { notifyConnectionHealth } from "@/server/notifications/events"
import { allProviders, ensureProvidersRegistered, getProvider } from "@/server/providers"
import { isProviderError } from "@/server/providers/errors"
import { forgetPageTokens, pageCapabilities } from "@/server/providers/meta/pages"
import { exchangeAuthCode } from "@/server/providers/tiktok"
import { PLATFORMS, type AdAccountInfo, type ConnectionGuide, type Platform } from "@/server/providers/types"

export type Actor = Pick<AppUser, "id" | "email" | "role">

/** Error whose message is safe to show to the user (Vietnamese). */
export class ConnectionServiceError extends Error {
  readonly fieldErrors?: Record<string, string>
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = "ConnectionServiceError"
    this.fieldErrors = fieldErrors
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function warningsOf(meta: unknown): string[] {
  const w = (meta as Record<string, unknown> | null)?.[META_WARNINGS_KEY]
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : []
}

function parseCredentialsOrThrow(platform: Platform, raw: unknown): unknown {
  ensureProvidersRegistered()
  try {
    return getProvider(platform).parseCredentials(raw)
  } catch (e) {
    if (isProviderError(e)) throw new ConnectionServiceError(e.userMessageVi || m.errors.invalidInput)
    throw new ConnectionServiceError(m.errors.invalidInput)
  }
}

/** Adapter-specific normalisation (e.g. Meta short-lived → 60-day token). Network only, outside any tx. */
async function prepareOrThrow(platform: Platform, creds: unknown): Promise<{ credentials: unknown; notes: string[] }> {
  const provider = getProvider(platform)
  if (!provider.prepareCredentials) return { credentials: creds, notes: [] }
  try {
    return await provider.prepareCredentials({ credentials: creds })
  } catch (e) {
    if (!isProviderError(e)) console.error("[connections] prepare failed:", safeErrorForLog(e))
    throw new ConnectionServiceError(providerErrorMessage(e))
  }
}

async function verifyOrThrow(
  platform: Platform,
  credentials: unknown,
  opts: { connectionId?: string; connectionMeta?: Record<string, unknown>; listPages?: boolean }
): Promise<VerifyOutcome & { accounts: AdAccountInfo[] }> {
  let out: VerifyOutcome
  try {
    out = await verifyCredentials(platform, credentials, { ...opts, listAccounts: true })
  } catch (e) {
    if (!isProviderError(e)) console.error("[connections] verify failed:", safeErrorForLog(e))
    throw new ConnectionServiceError(providerErrorMessage(e))
  }
  if (!out.check.valid || !out.accounts || out.health.status === "invalid") {
    // wizard (no connection yet): paste a new token; replacing/testing an existing connection: the platform specific next step
    const next = opts.connectionId ? statusHintFor({ platform, status: "invalid" }) : cs.hint.pasteAgain
    const message = out.health.statusMessage ?? cs.message.invalid
    throw new ConnectionServiceError(next ? `${message} ${next}` : message)
  }
  return out as VerifyOutcome & { accounts: AdAccountInfo[] }
}

/** Loads a non-deleted connection the actor may access; otherwise a generic "not found". */
async function getOwnedRow(actor: Actor, connectionId: string): Promise<ConnectionRow> {
  const row = await loadConnection(connectionId)
  if (!row || !canAccessOwned(actor, row.ownerId) || !isReleasedPlatform(row.platform)) {
    throw new ConnectionServiceError(m.errors.notFound)
  }
  return row
}

// ---------------------------------------------------------------------------
// Form metadata (credential fields + guide) for the wizard
// ---------------------------------------------------------------------------

function withAppUrl(guide: ConnectionGuide): ConnectionGuide {
  const url = appBaseUrl()
  const r = (text: string) => text.replaceAll("{APP_URL}", url)
  return {
    ...guide,
    summary: r(guide.summary),
    steps: guide.steps.map((step) => ({ ...step, title: r(step.title), detail: r(step.detail) })),
    warnings: guide.warnings?.map(r),
  }
}

export function getPlatformFormSpecs(): PlatformFormSpec[] {
  return PLATFORMS.map((p) => {
    const provider = allProviders[p]!
    return {
      platform: p,
      fields: provider.credentialFields.map((f) => ({ ...f })),
      // {APP_URL} in a guide = the address this Ads MCP runs at (e.g. the exact redirect URL to declare)
      guide: withAppUrl(provider.guide),
      supportsAuthCode: p === "tiktok",
    }
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Staff: own connections only. Admin: every connection (with owner). Never includes credentials. */
export async function listConnections(actor: Actor, opts: { platform?: Platform } = {}): Promise<ConnectionListItem[]> {
  const rows = await db
    .select({
      id: connections.id,
      name: connections.name,
      platform: connections.platform,
      status: connections.status,
      statusMessage: connections.statusMessage,
      credentialHint: connections.credentialHint,
      tokenExpiresAt: connections.tokenExpiresAt,
      lastCheckedAt: connections.lastCheckedAt,
      createdAt: connections.createdAt,
      ownerId: connections.ownerId,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
    })
    .from(connections)
    .innerJoin(userTable, eq(userTable.id, connections.ownerId))
    .where(
      and(
        isNull(connections.deletedAt),
        // connections of a platform not shipped in this build stay in the DB but are hidden
        inArray(connections.platform, [...RELEASED_PLATFORMS]),
        actor.role === "admin" ? undefined : eq(connections.ownerId, actor.id),
        opts.platform ? eq(connections.platform, opts.platform) : undefined
      )
    )
    .orderBy(desc(connections.createdAt))
  const counts = await countAccounts(rows.map((r) => r.id))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    status: r.status as ConnectionStatusValue,
    statusMessage: r.statusMessage,
    statusHint: statusHintFor({ platform: r.platform, status: r.status as ConnectionStatusValue, statusMessage: r.statusMessage }),
    credentialHint: r.credentialHint,
    tokenExpiresAt: iso(r.tokenExpiresAt),
    lastCheckedAt: iso(r.lastCheckedAt),
    createdAt: r.createdAt.toISOString(),
    accountCount: counts.get(r.id)?.total ?? 0,
    enabledAccountCount: counts.get(r.id)?.enabled ?? 0,
    owner: { id: r.ownerId, email: r.ownerEmail, name: r.ownerName },
  }))
}

export function toAdAccountDto(r: typeof adAccounts.$inferSelect): AdAccountDto {
  return {
    id: r.id,
    externalId: r.externalId,
    name: r.name,
    currency: r.currency,
    timezone: r.timezone,
    status: r.status as AdAccountDto["status"],
    statusRaw: r.statusRaw,
    isEnabled: r.isEnabled,
    isManager: r.isManager,
    parentExternalId: r.parentExternalId,
    lastSyncedAt: iso(r.lastSyncedAt),
  }
}

export function toMetaPageDto(r: typeof metaPages.$inferSelect): MetaPageDto {
  const tasks = [...(r.tasks ?? [])]
  return {
    id: r.id,
    externalId: r.externalId,
    name: r.name,
    category: r.category,
    link: r.link,
    pictureUrl: r.pictureUrl,
    followersCount: r.followersCount,
    verificationStatus: r.verificationStatus,
    isPublished: r.isPublished,
    tasks,
    sources: [...(r.sources ?? [])],
    businessName: r.businessName,
    isEnabled: r.isEnabled,
    isMissing: r.isMissing,
    lastSyncedAt: iso(r.lastSyncedAt),
    capabilities: pageCapabilities(tasks),
  }
}

function pagesSyncOf(meta: unknown): PagesSyncDto | null {
  const v = (meta as Record<string, unknown> | null)?.[PAGES_SYNC_KEY] as Record<string, unknown> | undefined
  if (!v || typeof v !== "object" || typeof v.at !== "string") return null
  return {
    ok: v.ok === true,
    at: v.at,
    count: typeof v.count === "number" ? v.count : 0,
    warnings: Array.isArray(v.warnings) ? v.warnings.filter((x): x is string => typeof x === "string") : [],
  }
}

/** MCP servers (not deleted) whose scopes reference this connection. */
export async function getConnectionUsage(actor: Actor, connectionId: string): Promise<McpUsage[]> {
  await getOwnedRow(actor, connectionId)
  const rows = await db
    .selectDistinct({ id: mcpServers.id, name: mcpServers.name, ownerId: mcpServers.ownerId })
    .from(mcpAccountScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpAccountScopes.mcpId))
    .where(and(eq(mcpAccountScopes.connectionId, connectionId), isNull(mcpServers.deletedAt)))
  return rows.map((r) => {
    const visible = canAccessOwned(actor, r.ownerId)
    return { id: visible ? r.id : null, name: visible ? r.name : null, ownedByViewer: r.ownerId === actor.id }
  })
}

/** Detail for /connections/[id]; throws ConnectionServiceError(notFound) when not accessible. */
export async function getConnection(actor: Actor, connectionId: string): Promise<ConnectionDetail> {
  const row = await getOwnedRow(actor, connectionId)
  const [owner] = await db
    .select({ id: userTable.id, email: userTable.email, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, row.ownerId))
    .limit(1)
  const accounts = await db
    .select()
    .from(adAccounts)
    .where(eq(adAccounts.connectionId, row.id))
    .orderBy(adAccounts.name)
  const usedBy = await getConnectionUsage(actor, row.id)
  const pages =
    row.platform === "meta"
      ? await db.select().from(metaPages).where(eq(metaPages.connectionId, row.id)).orderBy(metaPages.name)
      : []
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    status: row.status as ConnectionStatusValue,
    statusMessage: row.statusMessage,
    statusHint: statusHintFor({ platform: row.platform, status: row.status as ConnectionStatusValue, statusMessage: row.statusMessage }),
    credentialHint: row.credentialHint,
    tokenExpiresAt: iso(row.tokenExpiresAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    accountCount: accounts.length,
    enabledAccountCount: accounts.filter((a) => a.isEnabled).length,
    owner: owner ?? { id: row.ownerId, email: "", name: "" },
    scopes: row.scopes ?? null,
    warnings: warningsOf(row.meta),
    accounts: accounts.map(toAdAccountDto),
    pages: pages.map(toMetaPageDto),
    pagesSync: row.platform === "meta" ? pagesSyncOf(row.meta) : null,
    usedBy,
  }
}

// ---------------------------------------------------------------------------
// Preview (wizard step 3) - validates + lists accounts, saves nothing
// ---------------------------------------------------------------------------

export async function previewConnection(
  _actor: Actor,
  input: { platform: Platform; credentials: Record<string, string> }
): Promise<ConnectionPreview> {
  const prepared = await prepareOrThrow(input.platform, parseCredentialsOrThrow(input.platform, input.credentials))
  // the wizard preview only shows ad accounts: Pages are listed when the connection is saved
  const out = await verifyOrThrow(input.platform, prepared.credentials, { listPages: false })
  return {
    status: out.health.status,
    statusMessage: out.health.statusMessage,
    statusHint: statusHintFor({ platform: input.platform, ...out.health }),
    tokenExpiresAt: iso(out.check.tokenExpiresAt),
    scopes: out.check.scopes,
    warnings: [...prepared.notes, ...out.check.warnings],
    accounts: out.accounts.map((a) => ({
      externalId: a.externalId,
      name: a.name,
      currency: a.currency,
      timezone: a.timezone,
      status: a.status,
      statusRaw: a.statusRaw,
      isManager: a.isManager ?? false,
      parentExternalId: a.parentExternalId ?? null,
      defaultEnabled: isDefaultEnabled(a),
    })),
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function insertVerifiedConnection(
  actor: Actor,
  args: {
    platform: Platform
    name: string
    credentials: unknown
    out: VerifyOutcome & { accounts: AdAccountInfo[] }
    disabledExternalIds: string[]
    enabledExternalIds?: string[]
    via?: "token" | "auth_code"
  }
): Promise<{ id: string }> {
  const provider = getProvider(args.platform)
  const id = randomUUID()
  const now = new Date()
  const hint = provider.credentialHint(args.credentials)
  await db.transaction(async (tx) => {
    await tx.insert(connections).values({
      id,
      ownerId: actor.id,
      platform: args.platform,
      name: args.name,
      credentialsEncrypted: encryptCredentials(id, args.credentials),
      credentialHint: hint,
      status: args.out.health.status,
      statusMessage: args.out.health.statusMessage,
      tokenExpiresAt: args.out.check.tokenExpiresAt,
      scopes: args.out.check.scopes,
      meta: args.out.meta,
      lastCheckedAt: now,
    })
    const summary = await upsertAdAccounts(tx, id, args.platform, args.out.accounts, {
      // initial creation: the user reviewed the list in the wizard
      newAccountsEnabled: true,
      disabledExternalIds: args.disabledExternalIds,
      enabledExternalIds: args.enabledExternalIds,
      now,
    })
    // first Pages sync of a new connection: every Page starts enabled
    const pages = args.out.pages?.ok ? await upsertMetaPages(tx, id, args.out.pages.pages, { now }) : null
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.create",
        target: { type: "connection", id, label: args.name },
        metadata: {
          platform: args.platform,
          name: args.name,
          via: args.via ?? "token",
          status: args.out.health.status,
          accounts: summary.total,
          disabledAccounts: args.disabledExternalIds.length,
          ...(pages ? { pages: pages.total } : {}),
        },
      },
      tx
    )
  })
  return { id }
}

export async function createConnection(
  actor: Actor,
  input: {
    platform: Platform
    name: string
    credentials: Record<string, string>
    disabledExternalIds?: string[]
    enabledExternalIds?: string[]
  }
): Promise<{ id: string }> {
  const { credentials: creds } = await prepareOrThrow(input.platform, parseCredentialsOrThrow(input.platform, input.credentials))
  const out = await verifyOrThrow(input.platform, creds, {})
  return insertVerifiedConnection(actor, {
    platform: input.platform,
    name: input.name,
    credentials: creds,
    out,
    disabledExternalIds: input.disabledExternalIds ?? [],
    enabledExternalIds: input.enabledExternalIds ?? [],
  })
}

/** TikTok "Đổi auth_code": exchange server-side and save directly - the token never reaches the browser. */
async function exchangeTikTok(input: { appId: string; secret: string; authCode: string }) {
  ensureProvidersRegistered()
  try {
    // only what the exchange needs (the caller's input also carries the connection name / re-auth fields)
    const res = await exchangeAuthCode({ appId: input.appId, secret: input.secret, authCode: input.authCode })
    const creds = parseCredentialsOrThrow("tiktok", { accessToken: res.accessToken, appId: input.appId, secret: input.secret })
    // granted scope ids (digit strings, non-secret) are kept for the scope warnings
    return { creds, meta: { scope: res.scope } as Record<string, unknown> }
  } catch (e) {
    if (e instanceof ConnectionServiceError) throw e
    if (!isProviderError(e)) console.error("[connections] tiktok exchange failed:", safeErrorForLog(e))
    throw new ConnectionServiceError(providerErrorMessage(e))
  }
}

export async function createTikTokConnectionFromAuthCode(
  actor: Actor,
  input: { name: string; appId: string; secret: string; authCode: string }
): Promise<{ id: string }> {
  const { creds, meta } = await exchangeTikTok(input)
  const out = await verifyOrThrow("tiktok", creds, { connectionMeta: meta })
  return insertVerifiedConnection(actor, {
    platform: "tiktok",
    name: input.name,
    credentials: creds,
    out,
    disabledExternalIds: [],
    via: "auth_code",
  })
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function renameConnection(actor: Actor, input: { connectionId: string; name: string }): Promise<void> {
  const row = await getOwnedRow(actor, input.connectionId)
  if (row.name === input.name) return
  await db.transaction(async (tx) => {
    await tx.update(connections).set({ name: input.name }).where(eq(connections.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.update",
        target: { type: "connection", id: row.id, label: input.name },
        metadata: { before: { name: row.name }, after: { name: input.name } },
      },
      tx
    )
  })
}

async function applyNewCredentials(
  actor: Actor,
  row: ConnectionRow,
  creds: unknown,
  out: VerifyOutcome & { accounts: AdAccountInfo[] },
  via: "token" | "auth_code"
): Promise<ConnectionCheckResult> {
  const provider = getProvider(row.platform)
  const now = new Date()
  const summary = await db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        credentialsEncrypted: encryptCredentials(row.id, creds),
        credentialHint: provider.credentialHint(creds),
        status: out.health.status,
        statusMessage: out.health.statusMessage,
        tokenExpiresAt: out.check.tokenExpiresAt,
        scopes: out.check.scopes,
        meta: out.meta,
        lastCheckedAt: now,
      })
      .where(eq(connections.id, row.id))
    const s = await upsertAdAccounts(tx, row.id, row.platform, out.accounts, { markMissing: true, now })
    const pages = out.pages?.ok ? await upsertMetaPages(tx, row.id, out.pages.pages, { now }) : null
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.update",
        target: { type: "connection", id: row.id, label: row.name },
        metadata: {
          changed: ["credentials"],
          via,
          before: { status: row.status, credentialHint: row.credentialHint },
          after: { status: out.health.status, credentialHint: provider.credentialHint(creds) },
          accounts: s,
          ...(pages ? { pages } : {}),
        },
      },
      tx
    )
    return s
  })
  // cached Page tokens were derived from the old token
  forgetPageTokens(row.id)
  invalidateGrantCache()
  return {
    status: out.health.status,
    statusMessage: out.health.statusMessage,
    statusHint: statusHintFor({ platform: row.platform, ...out.health }),
    tokenExpiresAt: iso(out.check.tokenExpiresAt),
    accountCount: summary.total,
  }
}

/** Replace credentials (re-validate + re-sync). The caller must have re-verified the user's password. */
export async function replaceCredentials(
  actor: Actor,
  input: { connectionId: string; credentials: Record<string, string> }
): Promise<ConnectionCheckResult> {
  const row = await getOwnedRow(actor, input.connectionId)
  const { credentials: creds } = await prepareOrThrow(row.platform, parseCredentialsOrThrow(row.platform, input.credentials))
  const out = await verifyOrThrow(row.platform, creds, { connectionId: row.id })
  return applyNewCredentials(actor, row, creds, out, "token")
}

/** "Thay token" by a new TikTok auth_code. The caller must have re-verified the user's password. */
export async function replaceTikTokCredentialsFromAuthCode(
  actor: Actor,
  input: { connectionId: string; appId: string; secret: string; authCode: string }
): Promise<ConnectionCheckResult> {
  const row = await getOwnedRow(actor, input.connectionId)
  if (row.platform !== "tiktok") throw new ConnectionServiceError(m.errors.tiktokOnly)
  const { creds, meta } = await exchangeTikTok(input)
  const out = await verifyOrThrow("tiktok", creds, { connectionId: row.id, connectionMeta: meta })
  return applyNewCredentials(actor, row, creds, out, "auth_code")
}

// ---------------------------------------------------------------------------
// Test / sync / health
// ---------------------------------------------------------------------------

async function refreshForUser(actor: Actor, connectionId: string, syncAccounts: boolean): Promise<ConnectionCheckResult> {
  const row = await getOwnedRow(actor, connectionId)
  const plan = await planRefresh(row, { syncAccounts })
  if (plan.error) console.warn(`[connections] check ${row.id} failed: ${plan.error}`)
  const now = new Date()
  const summary = await db.transaction(async (tx) => {
    const s = await applyRefresh(tx, row, plan, now)
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.test",
        target: { type: "connection", id: row.id, label: row.name },
        status: plan.ok ? "success" : "failure",
        metadata: {
          kind: syncAccounts ? "sync" : "test",
          before: { status: row.status },
          after: { status: plan.status ?? row.status },
          message: plan.statusMessage,
          accounts: s ? { total: s.total, inserted: s.inserted, missing: s.missing } : undefined,
          ...(s?.pages ? { pages: s.pages } : {}),
        },
      },
      tx
    )
    return s
  })
  // account list / names may have changed (grants embed them)
  invalidateGrantCache()
  // Telegram (after commit, never throws): only a real status transition, once per connection/status/day
  await notifyConnectionHealth({ connectionId: row.id, before: row.status, after: effectiveStatusAfter(row, plan), statusMessage: plan.statusMessage, now })
  return {
    status: (plan.status ?? row.status) as ConnectionStatusValue,
    statusMessage: plan.statusMessage,
    statusHint: statusHintFor({ platform: row.platform, status: (plan.status ?? row.status) as ConnectionStatusValue, statusMessage: plan.statusMessage }),
    tokenExpiresAt: plan.tokenExpiresAt !== undefined ? iso(plan.tokenExpiresAt) : iso(row.tokenExpiresAt),
    accountCount: summary?.total,
  }
}

/** "Kiểm tra lại": validate the stored token and update status (activity `connection.test`). */
export async function testConnection(actor: Actor, connectionId: string): Promise<ConnectionCheckResult> {
  return refreshForUser(actor, connectionId, false)
}

/** "Đồng bộ tài khoản": validate + re-list ad accounts (missing ones → closed). */
export async function syncConnectionAccounts(actor: Actor, connectionId: string): Promise<ConnectionCheckResult> {
  return refreshForUser(actor, connectionId, true)
}

// ---------------------------------------------------------------------------
// Delete (soft) - wipes the stored credentials
// ---------------------------------------------------------------------------

export async function deleteConnection(
  actor: Actor,
  connectionId: string
): Promise<{ affectedMcpIds: string[]; affectedMcpCount: number }> {
  const row = await getOwnedRow(actor, connectionId)
  const usage = await getConnectionUsage(actor, row.id)
  // staff never learn the ids of other people's MCPs (not even through their own activity log); the count is complete
  const visibleIds = usage.flatMap((u) => (u.id ? [u.id] : []))
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        deletedAt: now,
        // the token is useless after deletion: replace the ciphertext with an empty object
        credentialsEncrypted: encryptCredentials(row.id, {}),
        statusMessage: null,
      })
      .where(and(eq(connections.id, row.id), isNull(connections.deletedAt)))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.delete",
        target: { type: "connection", id: row.id, label: row.name },
        metadata: { platform: row.platform, name: row.name, affectedMcpIds: visibleIds, affectedMcpCount: usage.length },
      },
      tx
    )
  })
  // MCPs that reference this connection lose it at once (the grant cache would serve it for a few more seconds)
  invalidateGrantCache()
  forgetPageTokens(row.id)
  return { affectedMcpIds: visibleIds, affectedMcpCount: usage.length }
}

// ---------------------------------------------------------------------------
// Internal helpers exported for the ad-accounts service
// ---------------------------------------------------------------------------

export { getOwnedRow as getAccessibleConnectionRow }

/** Ids of connections (not deleted) the actor may use, optionally restricted to `ids`. */
export async function accessibleConnectionIds(actor: Actor, ids?: string[]): Promise<string[]> {
  if (ids && ids.length === 0) return []
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        isNull(connections.deletedAt),
        actor.role === "admin" ? undefined : eq(connections.ownerId, actor.id),
        ids ? inArray(connections.id, ids) : undefined
      )
    )
  return rows.map((r) => r.id)
}
