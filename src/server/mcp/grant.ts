// Resolve /mcp/<key> into an McpGrant: what this request may do.
// Unknown / disabled / expired / deleted keys, banned owners → null (the endpoint answers 404, never 401).
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { LRUCache } from "lru-cache"
import { hashMcpKey, isWellFormedMcpKey } from "../crypto/mcp-key"
import { db } from "../db/client"
import {
  adAccounts,
  connections,
  mcpAccountScopes,
  mcpPageScopes,
  mcpPlatformPermissions,
  mcpServers,
  metaPages,
  user,
} from "../db/schema"
import { PLATFORMS, type Platform } from "../providers/types"
import { denied } from "./errors"
import { parseMcpSettings } from "./settings"
import { PERMISSIONS, grantAllows, type GrantAccount, type GrantPage, type McpGrant, type Permission } from "./types"

/** Grants are rebuilt per request; this tiny cache only absorbs bursts (≤ 5 s staleness, per spec). */
const GRANT_CACHE_TTL_MS = 3_000

const g = globalThis as unknown as { __adsMcpGrantCache?: LRUCache<string, { grant: McpGrant | null }> }
function cache() {
  g.__adsMcpGrantCache ??= new LRUCache<string, { grant: McpGrant | null }>({ max: 1_000, ttl: GRANT_CACHE_TTL_MS })
  return g.__adsMcpGrantCache
}

/** Drop cached grants (call after disabling / rotating / editing an MCP). No argument = everything. */
export function invalidateGrantCache(mcpId?: string) {
  const c = cache()
  if (!mcpId) return c.clear()
  for (const [k, v] of c.entries()) if (v.grant?.mcpId === mcpId) c.delete(k)
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
  const grant = await loadGrantByHash(keyHash)
  // do not cache misses for long: a just-created key should work immediately
  if (grant) cache().set(keyHash, { grant })
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
    .where(
      and(
        eq(mcpServers.keyHash, keyHash),
        eq(mcpServers.status, "active"),
        isNull(mcpServers.deletedAt),
        or(isNull(mcpServers.expiresAt), gt(mcpServers.expiresAt, sql`now()`))
      )
    )
    .limit(1)
  const m = rows[0]
  if (!m) return null
  if (m.ownerBanned && (!m.ownerBanExpires || m.ownerBanExpires.getTime() > Date.now())) return null

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

  return {
    mcpId: m.id,
    mcpName: m.name,
    ownerId: m.ownerId,
    ownerEmail: m.ownerEmail,
    ownerRole: ownerIsAdmin ? "admin" : "staff",
    settings: parseMcpSettings(m.settings),
    permissions,
    accounts,
    pages,
  }
}

// ---------------------------------------------------------------------------
// Per-tool re-check (never trust schema enums or input)
// ---------------------------------------------------------------------------

const PLATFORM_LABEL: Partial<Record<Platform, string>> = {
  meta: "Meta",
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

/** Candidate spellings of an account id (Meta "act_" prefix optional). */
export function accountIdCandidates(platform: Platform, raw: string): string[] {
  const id = raw.trim()
  const out = new Set([id])
  if (platform === "meta") {
    if (/^\d+$/.test(id)) out.add(`act_${id}`)
  }
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

/** Platforms on which the grant has this permission AND at least one account. */
export function platformsWithAccounts(grant: McpGrant, permission: Permission): Platform[] {
  return PLATFORMS.filter((p) => grantAllows(grant, p, permission) && grant.accounts.some((a) => a.platform === p))
}
