// Resolve /mcp/<key> into an McpGrant: what this request may do.
// Unknown / disabled / expired / deleted keys, banned owners → null (the endpoint answers 404, never 401).
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { LRUCache } from "lru-cache"
// the store module (not the server-only service): the worker reaches this file through apify health → pool
import { loadGrantApifyTokens } from "../apify/store"
import { loadGrantTiktokSocialAccounts } from "../tiktok-social/store"
import { hashMcpKey, isWellFormedMcpKey } from "../crypto/mcp-key"
import { db } from "../db/client"
import {
  adAccounts,
  connections,
  driveCredentials,
  driveSources,
  mcpAccountScopes,
  mcpDriveScopes,
  mcpNotificationScopes,
  mcpPageScopes,
  mcpPlatformPermissions,
  mcpServers,
  metaPages,
  mcpTiktokSocialScopes,
  notificationChannels,
  user,
} from "../db/schema"
import { loadBlockedFolderIds, sourceIsBlocked } from "../drive/blocked"
import { normalizeFolderConfig, normalizeSheetConfig } from "../drive/store"
import { PLATFORMS, type Platform } from "../providers/types"
import { denied } from "./errors"
import { effectiveMcpSettings, parseMcpSettings } from "./settings"
import {
  PERMISSIONS,
  grantAllows,
  type GrantAccount,
  type GrantChannel,
  type GrantDriveSource,
  type GrantPage,
  type McpGrant,
  type Permission,
} from "./types"

/** Grants are rebuilt per request; this tiny cache only absorbs bursts (≤ 5 s staleness, per spec). */
const GRANT_CACHE_TTL_MS = 3_000

/**
 * Key hashes that resolved to nothing: a repeated unknown key (a client still configured with a deleted MCP, a
 * guesser replaying a key) does not hit the database again for 30 s. Keys are random, so a brand-new key is never in
 * here; re-enabling an MCP clears it (invalidateGrantCache). Per process.
 */
const MISS_CACHE_TTL_MS = 30_000
/**
 * Key hashes of every usable MCP (active, not deleted, not expired, owner not banned), refreshed at most every 60 s
 * and dropped by invalidateGrantCache. Used only for clients blocked by the unknown-key limiter (serve.ts): their
 * valid keys go on to the normal lookup, anything else is answered without touching the database.
 */
const ACTIVE_KEYS_TTL_MS = 60_000

const g = globalThis as unknown as {
  __adsMcpGrantCache?: LRUCache<string, { grant: McpGrant | null }>
  __adsMcpGrantMiss?: LRUCache<string, true>
  __adsMcpActiveKeys?: { at: number; hashes: Promise<Set<string>> } | null
  __adsMcpGrantDbLookups?: number
}
function cache() {
  g.__adsMcpGrantCache ??= new LRUCache<string, { grant: McpGrant | null }>({ max: 1_000, ttl: GRANT_CACHE_TTL_MS })
  return g.__adsMcpGrantCache
}
function missCache() {
  g.__adsMcpGrantMiss ??= new LRUCache<string, true>({ max: 10_000, ttl: MISS_CACHE_TTL_MS })
  return g.__adsMcpGrantMiss
}

/**
 * Drop cached grants (call after creating / enabling / disabling / rotating / editing an MCP). No argument =
 * everything. The unknown-key cache and the active-key set are always cleared entirely (keyed by key hash).
 */
export function invalidateGrantCache(mcpId?: string) {
  missCache().clear()
  g.__adsMcpActiveKeys = null
  const c = cache()
  if (!mcpId) return c.clear()
  for (const [k, v] of c.entries()) if (v.grant?.mcpId === mcpId) c.delete(k)
}

/** test helper: key queries that reached the database (grant lookups + active-key set loads) since the process started */
export function __grantDbLookups(): number {
  return g.__adsMcpGrantDbLookups ?? 0
}

/** An MCP whose key may resolve: active, not deleted, not expired (the owner ban is checked in code). */
function usableMcp() {
  return and(
    eq(mcpServers.status, "active"),
    isNull(mcpServers.deletedAt),
    or(isNull(mcpServers.expiresAt), gt(mcpServers.expiresAt, sql`now()`))
  )
}

function ownerBanned(banned: boolean | null, banExpires: Date | null): boolean {
  return !!banned && (!banExpires || banExpires.getTime() > Date.now())
}

async function loadActiveKeyHashes(): Promise<Set<string>> {
  g.__adsMcpGrantDbLookups = (g.__adsMcpGrantDbLookups ?? 0) + 1
  const rows = await db
    .select({ keyHash: mcpServers.keyHash, banned: user.banned, banExpires: user.banExpires })
    .from(mcpServers)
    .innerJoin(user, eq(user.id, mcpServers.ownerId))
    .where(usableMcp())
  return new Set(rows.filter((r) => !ownerBanned(r.banned, r.banExpires)).map((r) => r.keyHash))
}

/**
 * Is this the key of a usable MCP? One small query per minute at most (cached set, cleared by invalidateGrantCache).
 * Only asked for clients blocked by the unknown-key limiter, so their valid keys are never refused while unknown
 * keys cost no database access.
 */
export async function isActiveMcpKey(rawKey: string, now = Date.now()): Promise<boolean> {
  if (!isWellFormedMcpKey(rawKey)) return false
  let entry = g.__adsMcpActiveKeys
  if (!entry || now - entry.at >= ACTIVE_KEYS_TTL_MS) {
    const hashes = loadActiveKeyHashes()
    entry = g.__adsMcpActiveKeys = { at: now, hashes }
    // a failed load is not cached: the next blocked request retries
    hashes.catch(() => {
      if (g.__adsMcpActiveKeys === entry) g.__adsMcpActiveKeys = null
    })
  }
  return (await entry.hashes).has(hashMcpKey(rawKey))
}

/** Only the exact role "admin" is admin (no comma lists, no whitespace/case variants). */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin"
}

const CONNECTION_STATUS_RANK: Record<string, number> = { active: 0, expiring: 1, invalid: 2 }

/**
 * The same ad account can be reachable through several connections of one MCP (two tokens, an MCC and a direct
 * login, an admin MCP spanning several people's connections). The AI must see it ONCE - twice would list it
 * twice and double-count its spend in `ads_get_report` - and it needs ONE deterministic set of credentials:
 * the healthiest connection (active > expiring > invalid), then the oldest connection, then the lowest id.
 */
export function dedupeAccounts<
  T extends { id: string; platform: string; externalId: string; connectionStatus: string; connectionCreatedAt: Date },
>(rows: T[]): T[] {
  const rank = (r: T) => CONNECTION_STATUS_RANK[r.connectionStatus] ?? 3
  const better = (a: T, b: T) =>
    rank(a) !== rank(b)
      ? rank(a) < rank(b)
      : a.connectionCreatedAt.getTime() !== b.connectionCreatedAt.getTime()
        ? a.connectionCreatedAt.getTime() < b.connectionCreatedAt.getTime()
        : a.id < b.id
  const best = new Map<string, T>()
  for (const r of rows) {
    const key = `${r.platform}\u0000${r.externalId}`
    const cur = best.get(key)
    if (!cur || better(r, cur)) best.set(key, r)
  }
  return [...best.values()]
}

/**
 * Same Page through several Meta connections of one MCP → keep ONE row (one set of credentials): a connection whose
 * user can read the Page Insights (task ANALYZE) first, then the healthiest connection, then the oldest, then the id.
 */
export function dedupePages<
  T extends { id: string; externalId: string; tasks: string[]; connectionStatus: string; connectionCreatedAt: Date },
>(rows: T[]): T[] {
  const rank = (r: T) => CONNECTION_STATUS_RANK[r.connectionStatus] ?? 3
  const analyze = (r: T) => (r.tasks.includes("ANALYZE") ? 0 : 1)
  const better = (a: T, b: T) =>
    analyze(a) !== analyze(b)
      ? analyze(a) < analyze(b)
      : rank(a) !== rank(b)
        ? rank(a) < rank(b)
        : a.connectionCreatedAt.getTime() !== b.connectionCreatedAt.getTime()
          ? a.connectionCreatedAt.getTime() < b.connectionCreatedAt.getTime()
          : a.id < b.id
  const best = new Map<string, T>()
  for (const r of rows) {
    const cur = best.get(r.externalId)
    if (!cur || better(r, cur)) best.set(r.externalId, r)
  }
  return [...best.values()]
}

/** Load the grant for a raw key. Returns null for anything that must look like "not found". */
export async function loadGrantByKey(rawKey: string): Promise<McpGrant | null> {
  if (!isWellFormedMcpKey(rawKey)) return null
  const keyHash = hashMcpKey(rawKey)
  const hit = cache().get(keyHash)
  if (hit) return hit.grant
  if (missCache().has(keyHash)) return null
  g.__adsMcpGrantDbLookups = (g.__adsMcpGrantDbLookups ?? 0) + 1
  const grant = await loadGrantByHash(keyHash)
  if (grant) {
    cache().set(keyHash, { grant })
    missCache().delete(keyHash)
  } else {
    missCache().set(keyHash, true)
  }
  return grant
}

export async function loadGrantByHash(keyHash: string): Promise<McpGrant | null> {
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      ownerId: mcpServers.ownerId,
      settings: mcpServers.settings,
      ownerEmail: user.email,
      ownerRole: user.role,
      ownerBanned: user.banned,
      ownerBanExpires: user.banExpires,
    })
    .from(mcpServers)
    .innerJoin(user, eq(user.id, mcpServers.ownerId))
    .where(and(eq(mcpServers.keyHash, keyHash), usableMcp()))
    .limit(1)
  const m = rows[0]
  if (!m) return null
  if (ownerBanned(m.ownerBanned, m.ownerBanExpires)) return null

  const ownerIsAdmin = isAdminRole(m.ownerRole)

  const permRows = await db
    .select({ platform: mcpPlatformPermissions.platform, permissions: mcpPlatformPermissions.permissions })
    .from(mcpPlatformPermissions)
    .where(eq(mcpPlatformPermissions.mcpId, m.id))

  const permissions: Partial<Record<Platform, Permission[]>> = {}
  for (const r of permRows) {
    const perms = (r.permissions ?? []).filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p))
    // "read" is mandatory (DB check constraint); be defensive anyway
    if (!perms.includes("read")) continue
    if (!(PLATFORMS as readonly string[]).includes(r.platform)) continue
    // stable order following PERMISSIONS
    permissions[r.platform] = PERMISSIONS.filter((p) => perms.includes(p))
  }

  const grantedPlatforms = Object.keys(permissions) as Platform[]
  let accounts: GrantAccount[] = []
  if (grantedPlatforms.length > 0) {
    const accRows = await db
      .selectDistinct({
        id: adAccounts.id,
        connectionId: adAccounts.connectionId,
        platform: adAccounts.platform,
        externalId: adAccounts.externalId,
        name: adAccounts.name,
        currency: adAccounts.currency,
        timezone: adAccounts.timezone,
        connectionStatus: connections.status,
        connectionCreatedAt: connections.createdAt,
      })
      .from(mcpAccountScopes)
      .innerJoin(connections, eq(connections.id, mcpAccountScopes.connectionId))
      .innerJoin(
        adAccounts,
        and(
          eq(adAccounts.connectionId, connections.id),
          or(isNull(mcpAccountScopes.adAccountId), eq(mcpAccountScopes.adAccountId, adAccounts.id))
        )
      )
      .where(
        and(
          eq(mcpAccountScopes.mcpId, m.id),
          isNull(connections.deletedAt),
          ne(connections.status, "disabled"),
          eq(adAccounts.isEnabled, true),
          // account platform must match its connection and be granted on this MCP
          eq(adAccounts.platform, connections.platform),
          inArray(adAccounts.platform, grantedPlatforms),
          // staff-owned MCP may only reach connections of the same owner (admin: any connection)
          ownerIsAdmin ? undefined : eq(connections.ownerId, m.ownerId)
        )
      )
    accounts = dedupeAccounts(accRows)
      .map(({ connectionStatus: _s, connectionCreatedAt: _c, ...a }) => ({ ...a, currency: a.currency.toUpperCase() }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId))
  }

  let pages: GrantPage[] = []
  if (permissions.meta?.includes("read")) {
    const pageRows = await db
      .selectDistinct({
        id: metaPages.id,
        connectionId: metaPages.connectionId,
        externalId: metaPages.externalId,
        name: metaPages.name,
        category: metaPages.category,
        followersCount: metaPages.followersCount,
        verificationStatus: metaPages.verificationStatus,
        tasks: metaPages.tasks,
        businessName: metaPages.businessName,
        connectionStatus: connections.status,
        connectionCreatedAt: connections.createdAt,
      })
      .from(mcpPageScopes)
      .innerJoin(connections, eq(connections.id, mcpPageScopes.connectionId))
      .innerJoin(
        metaPages,
        and(
          eq(metaPages.connectionId, connections.id),
          or(isNull(mcpPageScopes.pageId), eq(mcpPageScopes.pageId, metaPages.id))
        )
      )
      .where(
        and(
          eq(mcpPageScopes.mcpId, m.id),
          isNull(connections.deletedAt),
          ne(connections.status, "disabled"),
          eq(connections.platform, "meta"),
          eq(metaPages.isEnabled, true),
          eq(metaPages.isMissing, false),
          // staff-owned MCP may only reach connections of the same owner (admin: any connection)
          ownerIsAdmin ? undefined : eq(connections.ownerId, m.ownerId)
        )
      )
    pages = dedupePages(pageRows)
      .map(({ connectionStatus: _s, connectionCreatedAt: _c, ...p }) => ({ ...p, tasks: [...(p.tasks ?? [])] }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId))
  }

  // Telegram channels: usable (active|error), not deleted, and owned by the MCP owner - for an admin's MCP too (a
  // channel of somebody else could be re-pointed by that person to read this MCP's notifications); scope rows that
  // break the rule (legacy) are ignored here and pruned on the next save
  const channelRows = await db
    .select({
      id: notificationChannels.id,
      name: notificationChannels.name,
      config: notificationChannels.config,
    })
    .from(mcpNotificationScopes)
    .innerJoin(notificationChannels, eq(notificationChannels.id, mcpNotificationScopes.channelId))
    .where(
      and(
        eq(mcpNotificationScopes.mcpId, m.id),
        isNull(notificationChannels.deletedAt),
        inArray(notificationChannels.status, ["active", "error"]),
        eq(notificationChannels.ownerId, m.ownerId)
      )
    )
  const notificationChannelsInScope: GrantChannel[] = channelRows
    .map((c) => ({
      id: c.id,
      name: c.name,
      chatTitle: c.config?.chatTitle ?? null,
      hasThread: c.config?.messageThreadId != null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  // what the endpoint enforces: basic mode switches every limit off except the expiry date
  const settings = effectiveMcpSettings(parseMcpSettings(m.settings))
  return {
    mcpId: m.id,
    mcpName: m.name,
    ownerId: m.ownerId,
    ownerEmail: m.ownerEmail,
    ownerRole: ownerIsAdmin ? "admin" : "staff",
    settings,
    permissions,
    accounts,
    pages,
    notificationChannels: notificationChannelsInScope,
    driveSources: await loadGrantDriveSources(m.id, m.ownerId, ownerIsAdmin),
    drivePublicAvailable: await systemDriveApiKeyAvailable(),
    // Apify pool (16-apify.md §5): company tokens + the MCP OWNER's personal tokens (admin-owned MCP too), no secrets;
    // read only when the MCP uses Apify (no query otherwise)
    apifyTokens: settings.apifyEnabled ? await loadGrantApifyTokens(m.ownerId) : [],
    // TikTok Social accounts picked for this MCP (17-tiktok-social.md §4): live, not disabled; staff-owned MCP → the
    // owner's rows only (admin: any row). No secrets.
    tiktokSocialAccounts: await loadGrantTiktokSocialAccounts(
      (
        await db
          .select({ id: mcpTiktokSocialScopes.accountId })
          .from(mcpTiktokSocialScopes)
          .where(eq(mcpTiktokSocialScopes.mcpId, m.id))
      ).map((r) => r.id),
      { id: m.ownerId, isAdmin: ownerIsAdmin }
    ),
  }
}

/**
 * Google Drive sources of an MCP (15-google-drive-media.md §5): scope rows ⋈ live sources (status ≠ disabled) ⋈ live
 * credentials (status ≠ disabled). Defence in depth on top of the service rules: a staff-owned MCP only reaches
 * company sources and the owner's personal sources (an admin's MCP: any source, G4); a company source must use the
 * system credential and a personal credential only serves its own owner's sources. A staff-owned MCP also loses a
 * source that is (or now sits inside) another user's live personal folder (stored ancestor_ids ∩ the owner's blocked
 * folders - security review T-2), e.g. a company folder moved into a staff member's personal folder.
 */
async function loadGrantDriveSources(mcpId: string, ownerId: string, ownerIsAdmin: boolean): Promise<GrantDriveSource[]> {
  const rows = await db
    .select({
      id: driveSources.id,
      kind: driveSources.kind,
      scope: driveSources.scope,
      name: driveSources.name,
      googleId: driveSources.googleId,
      sheetGid: driveSources.sheetGid,
      credentialId: driveSources.credentialId,
      ownerId: driveSources.ownerId,
      status: driveSources.status,
      sharedDriveId: driveSources.sharedDriveId,
      config: driveSources.config,
      ancestorIds: driveSources.ancestorIds,
    })
    .from(mcpDriveScopes)
    .innerJoin(driveSources, eq(driveSources.id, mcpDriveScopes.sourceId))
    .innerJoin(driveCredentials, eq(driveCredentials.id, driveSources.credentialId))
    .where(
      and(
        eq(mcpDriveScopes.mcpId, mcpId),
        isNull(driveSources.deletedAt),
        ne(driveSources.status, "disabled"),
        isNull(driveCredentials.deletedAt),
        ne(driveCredentials.status, "disabled"),
        or(
          and(eq(driveSources.scope, "company"), eq(driveCredentials.kind, "system")),
          and(
            eq(driveSources.scope, "personal"),
            or(eq(driveCredentials.kind, "system"), eq(driveCredentials.ownerId, driveSources.ownerId))
          )
        ),
        ownerIsAdmin ? undefined : or(eq(driveSources.scope, "company"), eq(driveSources.ownerId, ownerId))
      )
    )
  const blocked =
    ownerIsAdmin || rows.length === 0 ? new Set<string>() : await loadBlockedFolderIds({ id: ownerId, role: "staff" })
  return rows
    .filter((r) => (r.kind === "folder" || r.kind === "sheet") && (r.kind === "sheet") === (r.sheetGid !== null))
    .filter((r) => !sourceIsBlocked(r, blocked))
    .map(
      (r): GrantDriveSource => ({
        id: r.id,
        kind: r.kind as GrantDriveSource["kind"],
        scope: r.scope === "company" ? "company" : "personal",
        name: r.name,
        googleId: r.googleId,
        sheetGid: r.sheetGid,
        credentialId: r.credentialId,
        ownerId: r.ownerId,
        status: r.status === "active" ? "active" : "error",
        sharedDriveId: r.sharedDriveId,
        config: r.kind === "sheet" ? normalizeSheetConfig(r.config) : normalizeFolderConfig(r.config),
      })
    )
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "company" ? -1 : 1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Public "Anyone with the link" Drive files are readable: the live, not disabled system credential has an API key. */
async function systemDriveApiKeyAvailable(): Promise<boolean> {
  const [row] = await db
    .select({ id: driveCredentials.id })
    .from(driveCredentials)
    .where(
      and(
        eq(driveCredentials.kind, "system"),
        isNull(driveCredentials.deletedAt),
        ne(driveCredentials.status, "disabled"),
        sql`${driveCredentials.apiKeyEncrypted} is not null`
      )
    )
    .limit(1)
  return !!row
}

// ---------------------------------------------------------------------------
// Per-tool re-check (never trust schema enums or input)
// ---------------------------------------------------------------------------

const PLATFORM_LABEL: Partial<Record<Platform, string>> = {
  meta: "Meta",
  tiktok: "TikTok",
  google_ads: "Google Ads",
  openai_ads: "OpenAI Ads",
}

export function platformLabel(p: Platform): string {
  return PLATFORM_LABEL[p] ?? p
}

const PERMISSION_LABEL: Record<Permission, string> = {
  read: "Xem",
  status: "Bật/Tắt",
  update: "Sửa",
  copy: "Sao chép",
  create: "Tạo mới",
  delete: "Xoá",
}

/** Candidate spellings of an account id (Meta "act_" prefix optional, Google dashes optional). */
export function accountIdCandidates(platform: Platform, raw: string): string[] {
  const id = raw.trim()
  const out = new Set([id])
  if (platform === "meta") {
    if (/^\d+$/.test(id)) out.add(`act_${id}`)
  }
  if (platform === "google_ads") out.add(id.replace(/-/g, ""))
  return [...out]
}

export function findGrantAccount(grant: McpGrant, platform: Platform, accountId: string): GrantAccount | undefined {
  const ids = accountIdCandidates(platform, accountId)
  return grant.accounts.find((a) => a.platform === platform && ids.includes(a.externalId))
}

/**
 * Every tool handler calls this FIRST. Throws McpToolError (logged as "denied") when the MCP lacks the
 * permission on that platform or the account is not in scope. Returns the granted account.
 */
export function assertGrant(
  grant: McpGrant,
  q: { platform: Platform; accountId: string; permission: Permission }
): GrantAccount {
  if (!(PLATFORMS as readonly string[]).includes(q.platform) || !grantAllows(grant, q.platform, q.permission)) {
    throw denied(
      "permission_denied",
      `MCP này không có quyền "${PERMISSION_LABEL[q.permission] ?? q.permission}" trên ${platformLabel(q.platform)}.`,
      "Gọi ads_list_accounts để xem nền tảng và quyền khả dụng; quyền được cấu hình trong trang MCP của Ads MCP."
    )
  }
  const account = findGrantAccount(grant, q.platform, q.accountId)
  if (!account) {
    throw denied(
      "account_not_in_scope",
      `Tài khoản quảng cáo "${String(q.accountId).slice(0, 64)}" không thuộc phạm vi của MCP này trên ${platformLabel(q.platform)}.`,
      "Gọi ads_list_accounts để lấy đúng account_id."
    )
  }
  return account
}

/**
 * Every Page tool calls this FIRST: Meta "read" on the MCP and the Page in its scope. Throws McpToolError (logged as
 * "denied"). Returns the granted Page.
 */
export function assertPageGrant(grant: McpGrant, pageId: string): GrantPage {
  if (!grantAllows(grant, "meta", "read")) {
    throw denied(
      "permission_denied",
      `MCP này không có quyền "${PERMISSION_LABEL.read}" trên Meta.`,
      "Quyền được cấu hình trong trang MCP của Ads MCP."
    )
  }
  const id = String(pageId ?? "").trim()
  const page = grant.pages.find((p) => p.externalId === id)
  if (!page) {
    throw denied(
      "page_not_in_scope",
      `Trang "${id.slice(0, 64)}" không thuộc phạm vi của MCP này.`,
      "Gọi meta_list_pages để lấy đúng page_id."
    )
  }
  return page
}

/**
 * Every Telegram tool calls this: the channel must be in the MCP's scope. No id → the only channel of the scope (an
 * MCP with several channels must name one). Throws McpToolError (logged as "denied").
 */
export function assertChannelGrant(grant: McpGrant, channelId: string | null | undefined): GrantChannel {
  const channels = grant.notificationChannels
  const id = String(channelId ?? "").trim()
  if (!id) {
    if (channels.length === 1) return channels[0]!
    throw denied(
      channels.length === 0 ? "channel_not_in_scope" : "channel_required",
      channels.length === 0 ? "MCP này chưa được cấp kênh Telegram nào." : "MCP này có nhiều kênh Telegram - cần chọn channel_id.",
      "Gọi telegram_list_channels để lấy đúng channel_id."
    )
  }
  const channel = channels.find((c) => c.id === id)
  if (!channel) {
    throw denied(
      "channel_not_in_scope",
      `Kênh Telegram "${id.slice(0, 64)}" không thuộc phạm vi của MCP này.`,
      "Gọi telegram_list_channels để lấy đúng channel_id."
    )
  }
  return channel
}

/** Platforms on which the grant has this permission AND at least one account. */
export function platformsWithAccounts(grant: McpGrant, permission: Permission): Platform[] {
  return PLATFORMS.filter((p) => grantAllows(grant, p, permission) && grant.accounts.some((a) => a.platform === p))
}
