// MCP server management (admin UI side): list/get/create/update/enable/disable/rotate/reveal/delete.
// Security model (05-security.md §2, 01-product-spec.md §2):
// - staff only see/touch their own MCPs; admins see all (with owner email);
// - an MCP owned by STAFF may only reference connections of that same staff member; an MCP owned by an
//   ADMIN may reference any connection (decision D4). Checked here on save (and again by the grant loader);
// - the raw key is returned only once (create/rotate) or via reveal after re-authentication;
//   DB stores HMAC hash + 12-char prefix + AES-GCM ciphertext (AAD mcp:<id>:key);
// - every change writes activity_logs in the SAME transaction.
import "server-only"
import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"

import {
  createMcpSchema,
  hasMoneyWritePermission,
  MCP_PERMISSIONS,
  MCP_PLATFORMS,
  MCP_SCHEMA_MESSAGES,
  missingDailyCapCurrencies,
  MONEY_WRITE_PERMISSIONS,
  normalizePermissions,
  scopeHasPages,
  toStoredMcpSettings,
  updateMcpSchema,
  type CreateMcpData,
  type McpSettingsInput,
} from "@/lib/schemas/mcp-servers"
import { connections as connectionsVi } from "@/lib/i18n/vi/connections"
import { mcp as mcpVi } from "@/lib/i18n/vi/mcp"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import {
  REAUTH_MAX_FAILURES,
  REAUTH_WINDOW_MINUTES,
  verifyReauthWithBetterAuth,
  withReauth,
  type ReauthOutcome,
  type ReauthVerifier,
} from "@/server/auth/reauth"
import {
  buildMcpUrl,
  generateMcpKey,
  hashMcpKey,
  mcpKeyPrefix,
} from "@/server/crypto/mcp-key"
import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db, type Tx } from "@/server/db/client"
import {
  adAccounts,
  connections,
  mcpAccountScopes,
  mcpCallStatsHourly,
  mcpDriveScopes,
  mcpNotificationScopes,
  mcpPageScopes,
  mcpPlatformPermissions,
  mcpServers,
  notificationChannels,
  user,
} from "@/server/db/schema"
import { appBaseUrl } from "@/server/env"
import {
  assertScopesUsableForMcp,
  listUsableConnectionsForMcp,
} from "@/server/services/ad-accounts"
import { ConnectionServiceError } from "@/server/services/connections"
import {
  assertChannelsUsableForMcp,
  channelsUsableForMcp,
  NotificationServiceError,
} from "@/server/services/notification-channels"
import {
  assertDriveSourcesUsableForMcp,
  driveSourcesUsableForMcp,
  DriveServiceError,
  loadMcpDriveSourceRefs,
  type DriveMcpOwner,
} from "@/server/services/drive-sources"
import type { McpDriveSourceRef } from "@/lib/schemas/drive"
import { invalidateGrantCache } from "@/server/mcp/grant"
import { parseMcpSettings } from "@/server/mcp/settings"
import type { McpSettings, Permission } from "@/server/mcp/types"
import type { Platform } from "@/server/providers/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface McpActor {
  id: string
  email: string
  role: "admin" | "staff"
}

export type McpComputedStatus = "active" | "disabled" | "expired"

export type McpServiceErrorCode = "not_found" | "invalid"

/** Expected, user-facing failure (Vietnamese message safe to show). */
export class McpServiceError extends Error {
  constructor(
    public readonly code: McpServiceErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>
  ) {
    super(message)
    this.name = "McpServiceError"
  }
}

const MCP_PAGE_NOT_FOUND = connectionsVi.errors.pageNotFound

export const MCP_ERRORS = {
  notFound: "Không tìm thấy MCP hoặc bạn không có quyền truy cập.",
  connectionUnavailable:
    "Kết nối không tồn tại, đã bị xoá hoặc bạn không có quyền dùng.",
  platformMismatch: "Kết nối không thuộc nền tảng đã chọn.",
  accountUnavailable:
    "Tài khoản quảng cáo không thuộc kết nối đã chọn hoặc đang bị tắt.",
  pageUnavailable:
    "Trang Facebook không thuộc kết nối đã chọn hoặc đang bị tắt.",
  nameMismatch: "Tên xác nhận chưa khớp với tên MCP.",
  dailyCapRequired: (curs: readonly string[]) =>
    `MCP có quyền ghi phải đặt trần ngân sách/ngày cho: ${curs.join(", ")}.`,
} as const

export interface McpListItem {
  id: string
  name: string
  description: string | null
  ownerId: string
  ownerEmail: string
  ownerName: string
  isMine: boolean
  platforms: Platform[]
  /** platform → permissions (always includes read) */
  permissions: Partial<Record<Platform, Permission[]>>
  /** union of all platform permissions, canonical order */
  allPermissions: Permission[]
  status: McpComputedStatus
  keyPrefix: string
  expiresAt: string | null
  lastUsedAt: string | null
  lastClient: string | null
  calls7d: number
  errors7d: number
  createdAt: string
  /**
   * Currencies of the ad accounts reachable with money-write permissions (status/update/copy/create) that
   * have no daily cap - always [] right after a save (enforced); legacy MCPs or accounts synced later may show some.
   */
  capsMissing: string[]
}

export interface McpScopeConnection {
  connectionId: string
  connectionName: string
  connectionStatus: string
  connectionDeleted: boolean
  /** null = all enabled accounts of the connection */
  accountIds: string[] | null
  /** Meta only - Facebook Pages: null = all enabled Pages, [] = none */
  pageIds?: string[] | null
}

export interface McpPlatformConfig {
  platform: Platform
  permissions: Permission[]
  connections: McpScopeConnection[]
}

export interface McpStats {
  calls7d: number
  errors7d: number
  writes7d: number
  avgDurationMs: number | null
  /** last 14 days (Asia/Ho_Chi_Minh), oldest first, gaps filled with 0 */
  daily: { date: string; calls: number; errors: number }[]
  byPlatform: { platform: string; calls: number }[]
}

/** A Telegram channel in the MCP scope (mcp_notification_scopes) as the admin UI shows it - never the token / chat id. */
export interface McpChannelRef {
  id: string
  name: string
  chatTitle: string | null
  status: string
  /** soft-deleted since: dropped from the grant, removed from the scope on the next save */
  deleted: boolean
}

export interface McpDetail extends McpListItem {
  ownerRole: "admin" | "staff"
  /** Telegram channels in scope (incl. disabled / deleted ones, flagged) */
  notificationChannels: McpChannelRef[]
  /** Google Drive sources in scope that the MCP may still use (others are pruned on the next save) */
  driveSources: McpDriveSourceRef[]
  maskedUrl: string
  /** + moneyCapsRequired: false = legacy MCP (created before daily caps became mandatory) */
  settings: McpSettingsInput & Pick<McpSettings, "moneyCapsRequired">
  config: McpPlatformConfig[]
  keyRotatedAt: string | null
  updatedAt: string
  stats: McpStats
}

export interface SelectableAccount {
  id: string
  externalId: string
  name: string
  currency: string
  timezone: string
  status: string
}

export interface SelectablePage {
  id: string
  externalId: string
  name: string
  category: string | null
  followersCount: number | null
  /** the connection's user can read the Page Insights */
  insights: boolean
}

export interface SelectableConnection {
  id: string
  name: string
  platform: Platform
  status: string
  ownerId: string
  ownerEmail: string
  isMine: boolean
  /** enabled ad accounts only */
  accounts: SelectableAccount[]
  /** Meta only: enabled Facebook Pages */
  pages: SelectablePage[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuidSchema = z.uuid()
const isUuid = (v: unknown): v is string => uuidSchema.safeParse(v).success

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

function canAccess(actor: McpActor, ownerId: string) {
  return actor.role === "admin" || actor.id === ownerId
}

export function computeMcpStatus(
  row: { status: string; expiresAt: Date | null },
  now: Date = new Date()
): McpComputedStatus {
  if (row.status !== "active") return "disabled"
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime())
    return "expired"
  return "active"
}

export function maskMcpUrl(
  keyPrefix: string,
  baseUrl: string = appBaseUrl()
): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp/${keyPrefix}••••••••`
}

function unionPermissions(
  perms: Partial<Record<Platform, Permission[]>>
): Permission[] {
  const all = new Set<Permission>()
  for (const list of Object.values(perms))
    for (const p of list ?? []) all.add(p)
  return MCP_PERMISSIONS.filter((p) => all.has(p))
}

function toPermissionList(raw: string[]): Permission[] {
  return normalizePermissions(
    raw.filter((p): p is Permission =>
      (MCP_PERMISSIONS as readonly string[]).includes(p)
    )
  )
}

function invalid(
  message: string,
  fieldErrors?: Record<string, string>
): McpServiceError {
  return new McpServiceError("invalid", message, fieldErrors)
}

function notFound(): McpServiceError {
  return new McpServiceError("not_found", MCP_ERRORS.notFound)
}

function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown
): z.output<S> {
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const fieldErrors: Record<string, string> = {}
  for (const issue of r.error.issues) {
    const key = issue.path.join(".") || "_"
    fieldErrors[key] ??= issue.message
  }
  throw invalid(
    r.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    fieldErrors
  )
}

/**
 * Only the exact role "admin" is admin - the same rule as the session (toAppUser) and the grant loader
 * (isAdminRole). A lenient parse here ("admin,staff") would let the editor accept scopes the endpoint then drops.
 */
function roleOf(role: string | null | undefined): "admin" | "staff" {
  return role === "admin" ? "admin" : "staff"
}

async function ownerRoleOf(
  tx: Tx | typeof db,
  ownerId: string
): Promise<"admin" | "staff"> {
  const [u] = await tx
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, ownerId))
    .limit(1)
  return roleOf(u?.role)
}

type PlatformScopes = CreateMcpData["platforms"]

/**
 * Telegram channel ids an MCP owned by `owner` may use (not deleted, owned by the MCP owner - admins included) -
 * undefined passes through ("keep the stored scope"). An unusable id → McpServiceError invalid on
 * `notificationChannelIds`.
 */
async function usableChannelIds(
  owner: { id: string },
  ids: string[] | undefined
): Promise<string[] | undefined> {
  if (ids === undefined) return undefined
  try {
    return (await assertChannelsUsableForMcp(owner, ids)).sort()
  } catch (e) {
    if (e instanceof NotificationServiceError)
      throw invalid(e.message, { notificationChannelIds: e.message })
    throw e
  }
}

/**
 * Channel scope to store on update. requested undefined = keep the stored scope. Stored ids the MCP may no longer use
 * (another person's channel - legacy rows from when an admin MCP could use any channel - or a deleted one) are
 * pruned silently; a NEWLY added unusable id is refused.
 */
async function channelIdsForUpdate(
  ownerId: string,
  requested: string[] | undefined,
  stored: string[]
): Promise<string[]> {
  const wanted = [...new Set(requested ?? stored)]
  const storedSet = new Set(stored)
  await usableChannelIds(
    { id: ownerId },
    wanted.filter((id) => !storedSet.has(id))
  )
  return (await channelsUsableForMcp({ id: ownerId }, wanted)).sort()
}

async function loadChannelIds(
  tx: Tx | typeof db,
  mcpId: string
): Promise<string[]> {
  const rows = await tx
    .select({ channelId: mcpNotificationScopes.channelId })
    .from(mcpNotificationScopes)
    .where(eq(mcpNotificationScopes.mcpId, mcpId))
  return rows.map((r) => r.channelId).sort()
}

async function writeChannelScopes(tx: Tx, mcpId: string, channelIds: string[]) {
  await tx
    .delete(mcpNotificationScopes)
    .where(eq(mcpNotificationScopes.mcpId, mcpId))
  if (channelIds.length)
    await tx
      .insert(mcpNotificationScopes)
      .values(channelIds.map((channelId) => ({ mcpId, channelId })))
}

/**
 * Google Drive source ids an MCP owned by `owner` may use (company + owner's personal; admin MCP: any live source,
 * G4) - undefined passes through ("keep the stored scope"). An unusable id → McpServiceError invalid on
 * `driveSourceIds`.
 */
async function usableDriveSourceIds(
  owner: DriveMcpOwner,
  ids: string[] | undefined,
  tx: Tx | typeof db = db
): Promise<string[] | undefined> {
  if (ids === undefined) return undefined
  try {
    return (await assertDriveSourcesUsableForMcp(owner, ids, tx)).sort()
  } catch (e) {
    if (e instanceof DriveServiceError)
      throw invalid(e.message, { driveSourceIds: e.message })
    throw e
  }
}

/** Like channelIdsForUpdate: omitted = keep; stored ids no longer usable are pruned; NEW unusable ids are refused. */
async function driveSourceIdsForUpdate(
  tx: Tx,
  owner: DriveMcpOwner,
  requested: string[] | undefined,
  stored: string[]
): Promise<string[]> {
  const wanted = [...new Set(requested ?? stored)]
  const storedSet = new Set(stored)
  await usableDriveSourceIds(
    owner,
    wanted.filter((id) => !storedSet.has(id)),
    tx
  )
  return (await driveSourcesUsableForMcp(owner, wanted, tx)).sort()
}

async function loadDriveSourceIds(
  tx: Tx | typeof db,
  mcpId: string
): Promise<string[]> {
  const rows = await tx
    .select({ sourceId: mcpDriveScopes.sourceId })
    .from(mcpDriveScopes)
    .where(eq(mcpDriveScopes.mcpId, mcpId))
  return rows.map((r) => r.sourceId).sort()
}

async function writeDriveScopes(tx: Tx, mcpId: string, sourceIds: string[]) {
  await tx.delete(mcpDriveScopes).where(eq(mcpDriveScopes.mcpId, mcpId))
  if (sourceIds.length)
    await tx
      .insert(mcpDriveScopes)
      .values(sourceIds.map((sourceId) => ({ mcpId, sourceId })))
}

/** Channels in scope that belong to the MCP owner (another person's channel is ignored by the grant and pruned on save). */
async function loadChannelRefs(
  mcpId: string,
  ownerId: string
): Promise<McpChannelRef[]> {
  const rows = await db
    .select({
      id: notificationChannels.id,
      name: notificationChannels.name,
      config: notificationChannels.config,
      status: notificationChannels.status,
      deletedAt: notificationChannels.deletedAt,
    })
    .from(mcpNotificationScopes)
    .innerJoin(
      notificationChannels,
      eq(notificationChannels.id, mcpNotificationScopes.channelId)
    )
    .where(
      and(
        eq(mcpNotificationScopes.mcpId, mcpId),
        eq(notificationChannels.ownerId, ownerId)
      )
    )
    .orderBy(asc(notificationChannels.name))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    chatTitle: r.config?.chatTitle ?? null,
    status: r.status,
    deleted: !!r.deletedAt,
  }))
}

/**
 * Currencies (upper case, sorted) of the ad accounts an MCP config can spend on: accounts of every platform
 * whose permissions include a money-write permission (picked accounts, or every enabled account of the
 * connection when accountIds is null).
 */
async function requiredCapCurrencies(
  tx: Tx | typeof db,
  platforms: PlatformScopes
): Promise<string[]> {
  const conds = []
  for (const p of platforms) {
    if (!hasMoneyWritePermission(p.permissions)) continue
    for (const c of p.connections) {
      if (c.accountIds === null)
        conds.push(
          and(
            eq(adAccounts.connectionId, c.connectionId),
            eq(adAccounts.isEnabled, true)
          )
        )
      else if (c.accountIds.length)
        conds.push(
          and(
            eq(adAccounts.connectionId, c.connectionId),
            inArray(adAccounts.id, c.accountIds)
          )
        )
    }
  }
  if (conds.length === 0) return []
  const rows = await tx
    .selectDistinct({ currency: adAccounts.currency })
    .from(adAccounts)
    .where(or(...conds))
  return [...new Set(rows.map((r) => r.currency.toUpperCase()))].sort()
}

/** Save-time rule: an MCP with money-write permissions needs a daily cap for every currency in that scope. */
async function assertDailyCaps(
  tx: Tx | typeof db,
  platforms: PlatformScopes,
  settings: McpSettingsInput
): Promise<void> {
  const missing = missingDailyCapCurrencies(
    settings.maxDailyBudget,
    await requiredCapCurrencies(tx, platforms)
  )
  if (missing.length === 0) return
  throw invalid(
    MCP_ERRORS.dailyCapRequired(missing),
    Object.fromEntries(
      missing.map((cur) => [
        `settings.maxDailyBudget.${cur}`,
        MCP_SCHEMA_MESSAGES.dailyCapRequired(cur),
      ])
    )
  )
}

/**
 * Per MCP: currencies of the ENABLED ad accounts in a money-write scope that have no daily cap in `settings`
 * (one query for all ids). Feeds the "no spending cap" warning of legacy MCPs.
 */
async function capsMissingFor(
  rows: { id: string; settings: unknown }[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (rows.length === 0) return out
  const found = await db
    .selectDistinct({
      mcpId: mcpAccountScopes.mcpId,
      currency: adAccounts.currency,
    })
    .from(mcpAccountScopes)
    .innerJoin(
      adAccounts,
      and(
        eq(adAccounts.isEnabled, true),
        or(
          eq(mcpAccountScopes.adAccountId, adAccounts.id),
          and(
            isNull(mcpAccountScopes.adAccountId),
            eq(adAccounts.connectionId, mcpAccountScopes.connectionId)
          )
        )
      )
    )
    .innerJoin(
      mcpPlatformPermissions,
      and(
        eq(mcpPlatformPermissions.mcpId, mcpAccountScopes.mcpId),
        eq(mcpPlatformPermissions.platform, adAccounts.platform)
      )
    )
    .where(
      and(
        inArray(
          mcpAccountScopes.mcpId,
          rows.map((r) => r.id)
        ),
        sql`${mcpPlatformPermissions.permissions} && array[${sql.join(
          MONEY_WRITE_PERMISSIONS.map((p) => sql`${p}`),
          sql`, `
        )}]::text[]`
      )
    )
  const byMcp = new Map<string, string[]>()
  for (const f of found) {
    const list = byMcp.get(f.mcpId) ?? []
    list.push(f.currency)
    byMcp.set(f.mcpId, list)
  }
  for (const r of rows) {
    const required = byMcp.get(r.id)
    out.set(
      r.id,
      required
        ? missingDailyCapCurrencies(
            parseMcpSettings(r.settings).maxDailyBudget,
            required
          )
        : []
    )
  }
  return out
}

/**
 * Scope rules come from the connections feature (`assertScopesUsableForMcp`, evaluated for the MCP
 * OWNER: staff → own connections only; admin → any, D4; never deleted/disabled connections; picked
 * accounts must be enabled and belong to the connection). On top of that each connection must match
 * the platform it is listed under and appear only once.
 */
async function assertScopesAllowed(
  tx: Tx | typeof db,
  owner: { id: string; email: string; role: "admin" | "staff" },
  platforms: PlatformScopes
): Promise<void> {
  const flat: { connectionId: string; adAccountId: string | null }[] =
    platforms.flatMap((p) =>
      p.connections.flatMap(
        (c): { connectionId: string; adAccountId: string | null }[] =>
          c.accountIds === null
            ? [{ connectionId: c.connectionId, adAccountId: null }]
            : c.accountIds.map((a) => ({
                connectionId: c.connectionId,
                adAccountId: a,
              }))
      )
    )
  const pageFlat: { connectionId: string; pageId: string | null }[] =
    platforms
      .filter((p) => p.platform === "meta")
      .flatMap((p) =>
        p.connections.filter(scopeHasPages).flatMap(
          (c): { connectionId: string; pageId: string | null }[] =>
            c.pageIds === null || c.pageIds === undefined
              ? [{ connectionId: c.connectionId, pageId: null }]
              : c.pageIds.map((pageId) => ({
                  connectionId: c.connectionId,
                  pageId,
                }))
        )
      )
  try {
    await assertScopesUsableForMcp(owner, flat, pageFlat)
  } catch (e) {
    if (!(e instanceof ConnectionServiceError)) throw e
    const accountProblem = flat.some((s) => s.adAccountId !== null)
    const pageProblem = pageFlat.some((s) => s.pageId !== null)
    const msg =
      e.message === MCP_PAGE_NOT_FOUND && pageProblem
        ? MCP_ERRORS.pageUnavailable
        : accountProblem
          ? MCP_ERRORS.accountUnavailable
          : MCP_ERRORS.connectionUnavailable
    throw invalid(msg, { platforms: msg })
  }
  const connIds = [...new Set(flat.map((s) => s.connectionId))]
  const rows = connIds.length
    ? await tx
        .select({ id: connections.id, platform: connections.platform })
        .from(connections)
        .where(inArray(connections.id, connIds))
    : []
  const platformOf = new Map(rows.map((r) => [r.id, r.platform]))
  const seen = new Set<string>()
  for (const p of platforms) {
    for (const c of p.connections) {
      if (platformOf.get(c.connectionId) !== p.platform) {
        throw invalid(MCP_ERRORS.platformMismatch, {
          [`platforms.${p.platform}`]: MCP_ERRORS.platformMismatch,
        })
      }
      if (seen.has(c.connectionId))
        throw invalid(MCP_SCHEMA_MESSAGES.connectionDuplicate)
      seen.add(c.connectionId)
    }
  }
}

async function writeScopes(tx: Tx, mcpId: string, platforms: PlatformScopes) {
  await tx
    .delete(mcpPlatformPermissions)
    .where(eq(mcpPlatformPermissions.mcpId, mcpId))
  await tx.delete(mcpAccountScopes).where(eq(mcpAccountScopes.mcpId, mcpId))
  await tx.delete(mcpPageScopes).where(eq(mcpPageScopes.mcpId, mcpId))
  if (platforms.length === 0) return
  await tx.insert(mcpPlatformPermissions).values(
    platforms.map((p) => ({
      mcpId,
      platform: p.platform,
      permissions: normalizePermissions(p.permissions),
    }))
  )
  const scopeRows: {
    mcpId: string
    connectionId: string
    adAccountId: string | null
  }[] = platforms.flatMap((p) =>
    p.connections.flatMap(
      (
        c
      ): {
        mcpId: string
        connectionId: string
        adAccountId: string | null
      }[] =>
        c.accountIds === null
          ? [{ mcpId, connectionId: c.connectionId, adAccountId: null }]
          : [...new Set(c.accountIds)].map((a) => ({
              mcpId,
              connectionId: c.connectionId,
              adAccountId: a,
            }))
    )
  )
  if (scopeRows.length) await tx.insert(mcpAccountScopes).values(scopeRows)
  // Facebook Pages (Meta connections only - the schema refuses Pages elsewhere)
  const pageRows = platforms
    .filter((p) => p.platform === "meta")
    .flatMap((p) =>
      p.connections.filter(scopeHasPages).flatMap((c) =>
        c.pageIds === null || c.pageIds === undefined
          ? [{ mcpId, connectionId: c.connectionId, pageId: null }]
          : [...new Set(c.pageIds)].map((pageId) => ({
              mcpId,
              connectionId: c.connectionId,
              pageId: pageId as string | null,
            }))
      )
    )
  if (pageRows.length) await tx.insert(mcpPageScopes).values(pageRows)
}

/** Stable, secret-free summary of an MCP config for activity-log diffs. */
interface ConfigSummary {
  name: string
  description: string | null
  platforms: Record<
    string,
    {
      permissions: Permission[]
      scopes: Record<string, "all" | string[]>
      /** Facebook Pages per connection (Meta, only connections with Pages) */
      pages?: Record<string, "all" | string[]>
    }
  >
  settings: DiffSettings
  expiresAt: string | null
  /** Telegram channel ids in scope (sorted) */
  channels: string[]
  /** Google Drive source ids in scope (sorted) */
  driveSources: string[]
}

/** Settings as compared/logged in activity diffs (the internal `moneyCapsRequired` marker is left out). */
type DiffSettings = Omit<McpSettings, "moneyCapsRequired">

function sortCaps(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(r).sort(([a], [b]) => a.localeCompare(b))
  )
}

/**
 * Canonical settings for diffs. Both sides go through the runtime parser (parseMcpSettings) so the
 * stored jsonb and a freshly validated input compare equal when nothing changed - including fields
 * added later (defaults) and keys in a different order.
 */
export function normalizeSettingsForDiff(stored: unknown): DiffSettings {
  const { moneyCapsRequired: _flag, ...parsed } = parseMcpSettings(stored)
  return {
    ...parsed,
    maxDailyBudget: sortCaps(parsed.maxDailyBudget),
    maxLifetimeBudget: sortCaps(parsed.maxLifetimeBudget),
    maxBid: sortCaps(parsed.maxBid),
  }
}

function summarize(data: {
  name: string
  description: string | null
  platforms: {
    platform: Platform
    permissions: Permission[]
    connections: {
      connectionId: string
      accountIds: string[] | null
      pageIds?: string[] | null
    }[]
  }[]
  /** already normalized with normalizeSettingsForDiff */
  settings: DiffSettings
  expiresAt: Date | null
  channels: string[]
  driveSources: string[]
}): ConfigSummary {
  const platforms: ConfigSummary["platforms"] = {}
  for (const p of [...data.platforms].sort((a, b) =>
    a.platform.localeCompare(b.platform)
  )) {
    const scopes: Record<string, "all" | string[]> = {}
    const pages: Record<string, "all" | string[]> = {}
    for (const c of [...p.connections].sort((a, b) =>
      a.connectionId.localeCompare(b.connectionId)
    )) {
      scopes[c.connectionId] =
        c.accountIds === null ? "all" : [...new Set(c.accountIds)].sort()
      if (p.platform === "meta" && scopeHasPages(c))
        pages[c.connectionId] =
          c.pageIds === null || c.pageIds === undefined
            ? "all"
            : [...new Set(c.pageIds)].sort()
    }
    platforms[p.platform] = {
      permissions: normalizePermissions(p.permissions),
      scopes,
      ...(Object.keys(pages).length ? { pages } : {}),
    }
  }
  return {
    name: data.name,
    description: data.description,
    platforms,
    settings: data.settings,
    expiresAt: iso(data.expiresAt),
    channels: [...new Set(data.channels)].sort(),
    driveSources: [...new Set(data.driveSources)].sort(),
  }
}

/** {before, after} with only the top-level keys that changed (empty when nothing changed). */
export function diffSummaries<T extends object>(
  before: T,
  after: T
): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {}
  const a: Partial<T> = {}
  for (const k of Object.keys({ ...before, ...after }) as (keyof T)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k]
      a[k] = after[k]
    }
  }
  return { before: b, after: a }
}

/**
 * Stored scope of an MCP. With a `viewer`, the names of connections the viewer may not access (another
 * user's connection, e.g. after the viewer was demoted to staff) are masked.
 */
async function loadConfig(
  tx: Tx | typeof db,
  mcpId: string,
  viewer?: McpActor
): Promise<McpPlatformConfig[]> {
  const perms = await tx
    .select()
    .from(mcpPlatformPermissions)
    .where(eq(mcpPlatformPermissions.mcpId, mcpId))
  const scopes = await tx
    .select({
      connectionId: mcpAccountScopes.connectionId,
      adAccountId: mcpAccountScopes.adAccountId,
      connectionName: connections.name,
      connectionOwnerId: connections.ownerId,
      connectionStatus: connections.status,
      connectionPlatform: connections.platform,
      connectionDeletedAt: connections.deletedAt,
    })
    .from(mcpAccountScopes)
    .innerJoin(connections, eq(connections.id, mcpAccountScopes.connectionId))
    .where(eq(mcpAccountScopes.mcpId, mcpId))
  const pageScopes = await tx
    .select({
      connectionId: mcpPageScopes.connectionId,
      pageId: mcpPageScopes.pageId,
    })
    .from(mcpPageScopes)
    .where(eq(mcpPageScopes.mcpId, mcpId))
  const out: McpPlatformConfig[] = []
  for (const platform of MCP_PLATFORMS) {
    const perm = perms.find((p) => p.platform === platform)
    if (!perm) continue
    const byConn = new Map<string, McpScopeConnection>()
    for (const s of scopes.filter((x) => x.connectionPlatform === platform)) {
      let entry = byConn.get(s.connectionId)
      if (!entry) {
        entry = {
          connectionId: s.connectionId,
          connectionName:
            viewer && !canAccess(viewer, s.connectionOwnerId)
              ? mcpVi.config.otherOwnerConnection
              : s.connectionName,
          connectionStatus: s.connectionStatus,
          connectionDeleted: !!s.connectionDeletedAt,
          accountIds: [],
        }
        byConn.set(s.connectionId, entry)
      }
      if (s.adAccountId === null) entry.accountIds = null
      else if (entry.accountIds !== null) entry.accountIds.push(s.adAccountId)
    }
    if (platform === "meta") {
      for (const entry of byConn.values()) {
        const rows = pageScopes.filter(
          (s) => s.connectionId === entry.connectionId
        )
        entry.pageIds = rows.some((s) => s.pageId === null)
          ? null
          : rows.map((s) => s.pageId as string)
      }
    }
    out.push({
      platform,
      permissions: toPermissionList(perm.permissions),
      connections: [...byConn.values()],
    })
  }
  return out
}

async function lockMcp(tx: Tx, actor: McpActor, id: string) {
  if (!isUuid(id)) throw notFound()
  const [row] = await tx
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), isNull(mcpServers.deletedAt)))
    .for("update")
    .limit(1)
  if (!row || !canAccess(actor, row.ownerId)) throw notFound()
  return row
}

function newKeyColumns(mcpId: string) {
  const key = generateMcpKey()
  return {
    key,
    columns: {
      keyHash: hashMcpKey(key),
      keyPrefix: mcpKeyPrefix(key),
      keyEncrypted: encryptSecret(key, aad.mcpKey(mcpId)),
    },
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function callCounts7d(
  ids: string[]
): Promise<Map<string, { calls: number; errors: number }>> {
  const map = new Map<string, { calls: number; errors: number }>()
  if (ids.length === 0) return map
  const rows = await db
    .select({
      mcpId: mcpCallStatsHourly.mcpId,
      calls: sql<number>`coalesce(sum(${mcpCallStatsHourly.calls}), 0)::int`,
      errors: sql<number>`coalesce(sum(${mcpCallStatsHourly.errors}), 0)::int`,
    })
    .from(mcpCallStatsHourly)
    .where(
      and(
        inArray(mcpCallStatsHourly.mcpId, ids),
        gte(mcpCallStatsHourly.bucket, sql`now() - interval '7 days'`)
      )
    )
    .groupBy(mcpCallStatsHourly.mcpId)
  for (const r of rows)
    map.set(r.mcpId, { calls: Number(r.calls), errors: Number(r.errors) })
  return map
}

/** Staff: own MCPs. Admin: every MCP (with owner email). Soft-deleted MCPs are excluded. */
export async function listMcpServers(actor: McpActor): Promise<McpListItem[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      description: mcpServers.description,
      ownerId: mcpServers.ownerId,
      ownerEmail: user.email,
      ownerName: user.name,
      status: mcpServers.status,
      keyPrefix: mcpServers.keyPrefix,
      expiresAt: mcpServers.expiresAt,
      lastUsedAt: mcpServers.lastUsedAt,
      lastClient: mcpServers.lastClient,
      createdAt: mcpServers.createdAt,
      settings: mcpServers.settings,
    })
    .from(mcpServers)
    .innerJoin(user, eq(user.id, mcpServers.ownerId))
    .where(
      and(
        isNull(mcpServers.deletedAt),
        actor.role === "admin" ? undefined : eq(mcpServers.ownerId, actor.id)
      )
    )
    .orderBy(desc(mcpServers.createdAt))
  const ids = rows.map((r) => r.id)
  const perms = ids.length
    ? await db
        .select()
        .from(mcpPlatformPermissions)
        .where(inArray(mcpPlatformPermissions.mcpId, ids))
    : []
  const counts = await callCounts7d(ids)
  const missing = await capsMissingFor(rows)
  const now = new Date()
  return rows.map((r) => {
    const permissions: Partial<Record<Platform, Permission[]>> = {}
    for (const p of perms)
      if (p.mcpId === r.id)
        permissions[p.platform] = toPermissionList(p.permissions)
    const platforms = MCP_PLATFORMS.filter((p) => permissions[p])
    const c = counts.get(r.id)
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      ownerId: r.ownerId,
      ownerEmail: r.ownerEmail,
      ownerName: r.ownerName,
      isMine: r.ownerId === actor.id,
      platforms,
      permissions,
      allPermissions: unionPermissions(permissions),
      status: computeMcpStatus(r, now),
      keyPrefix: r.keyPrefix,
      expiresAt: iso(r.expiresAt),
      lastUsedAt: iso(r.lastUsedAt),
      lastClient: r.lastClient,
      calls7d: c?.calls ?? 0,
      errors7d: c?.errors ?? 0,
      createdAt: r.createdAt.toISOString(),
      capsMissing: missing.get(r.id) ?? [],
    }
  })
}

async function loadStats(mcpId: string, now = new Date()): Promise<McpStats> {
  const [totals] = await db
    .select({
      calls: sql<number>`coalesce(sum(${mcpCallStatsHourly.calls}), 0)::int`,
      errors: sql<number>`coalesce(sum(${mcpCallStatsHourly.errors}), 0)::int`,
      writes: sql<number>`coalesce(sum(${mcpCallStatsHourly.writes}), 0)::int`,
      durationSum: sql<number>`coalesce(sum(${mcpCallStatsHourly.durationMsSum}), 0)::bigint`,
    })
    .from(mcpCallStatsHourly)
    .where(
      and(
        eq(mcpCallStatsHourly.mcpId, mcpId),
        gte(mcpCallStatsHourly.bucket, sql`now() - interval '7 days'`)
      )
    )
  const dayExpr = sql<string>`to_char(${mcpCallStatsHourly.bucket} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`
  const daily = await db
    .select({
      date: dayExpr,
      calls: sql<number>`coalesce(sum(${mcpCallStatsHourly.calls}), 0)::int`,
      errors: sql<number>`coalesce(sum(${mcpCallStatsHourly.errors}), 0)::int`,
    })
    .from(mcpCallStatsHourly)
    .where(
      and(
        eq(mcpCallStatsHourly.mcpId, mcpId),
        gte(mcpCallStatsHourly.bucket, sql`now() - interval '14 days'`)
      )
    )
    .groupBy(dayExpr)
  const byPlatform = await db
    .select({
      platform: mcpCallStatsHourly.platform,
      calls: sql<number>`coalesce(sum(${mcpCallStatsHourly.calls}), 0)::int`,
    })
    .from(mcpCallStatsHourly)
    .where(
      and(
        eq(mcpCallStatsHourly.mcpId, mcpId),
        gte(mcpCallStatsHourly.bucket, sql`now() - interval '7 days'`)
      )
    )
    .groupBy(mcpCallStatsHourly.platform)
    .orderBy(asc(mcpCallStatsHourly.platform))

  const byDay = new Map(daily.map((d) => [d.date, d]))
  const days: McpStats["daily"] = []
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  for (let i = 13; i >= 0; i--) {
    const date = fmt.format(new Date(now.getTime() - i * 86_400_000))
    const d = byDay.get(date)
    days.push({
      date,
      calls: Number(d?.calls ?? 0),
      errors: Number(d?.errors ?? 0),
    })
  }
  const calls = Number(totals?.calls ?? 0)
  return {
    calls7d: calls,
    errors7d: Number(totals?.errors ?? 0),
    writes7d: Number(totals?.writes ?? 0),
    avgDurationMs:
      calls > 0 ? Math.round(Number(totals?.durationSum ?? 0) / calls) : null,
    daily: days,
    byPlatform: byPlatform
      .filter((p) => Number(p.calls) > 0)
      .map((p) => ({ platform: p.platform, calls: Number(p.calls) })),
  }
}

/** One MCP with config + stats, or null when missing / deleted / not accessible. Never includes the key. */
export async function getMcpServer(
  actor: McpActor,
  id: string
): Promise<McpDetail | null> {
  if (!isUuid(id)) return null
  const [r] = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      description: mcpServers.description,
      ownerId: mcpServers.ownerId,
      ownerEmail: user.email,
      ownerName: user.name,
      ownerRole: user.role,
      status: mcpServers.status,
      keyPrefix: mcpServers.keyPrefix,
      expiresAt: mcpServers.expiresAt,
      settings: mcpServers.settings,
      lastUsedAt: mcpServers.lastUsedAt,
      lastClient: mcpServers.lastClient,
      keyRotatedAt: mcpServers.keyRotatedAt,
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
    })
    .from(mcpServers)
    .innerJoin(user, eq(user.id, mcpServers.ownerId))
    .where(and(eq(mcpServers.id, id), isNull(mcpServers.deletedAt)))
    .limit(1)
  if (!r || !canAccess(actor, r.ownerId)) return null
  const config = await loadConfig(db, r.id, actor)
  const permissions: Partial<Record<Platform, Permission[]>> = {}
  for (const p of config) permissions[p.platform] = p.permissions
  const stats = await loadStats(r.id)
  const missing = await capsMissingFor([r])
  const notificationChannelRefs = await loadChannelRefs(r.id, r.ownerId)
  const driveSourceRefs = await loadMcpDriveSourceRefs(r.id, {
    id: r.ownerId,
    role: roleOf(r.ownerRole),
  })
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ownerId: r.ownerId,
    ownerEmail: r.ownerEmail,
    ownerName: r.ownerName,
    ownerRole: roleOf(r.ownerRole),
    isMine: r.ownerId === actor.id,
    platforms: config.map((p) => p.platform),
    permissions,
    allPermissions: unionPermissions(permissions),
    status: computeMcpStatus(r),
    keyPrefix: r.keyPrefix,
    maskedUrl: maskMcpUrl(r.keyPrefix),
    expiresAt: iso(r.expiresAt),
    lastUsedAt: iso(r.lastUsedAt),
    lastClient: r.lastClient,
    calls7d: stats.calls7d,
    errors7d: stats.errors7d,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    keyRotatedAt: iso(r.keyRotatedAt),
    settings: parseMcpSettings(r.settings),
    config,
    stats,
    capsMissing: missing.get(r.id) ?? [],
    notificationChannels: notificationChannelRefs,
    driveSources: driveSourceRefs,
  }
}

/**
 * Connections usable in an MCP (wizard step 2 / config editor), with their ENABLED ad accounts -
 * delegates to `listUsableConnectionsForMcp` of the connections feature, evaluated for the MCP owner:
 * staff-owned MCP → only that staff's connections; admin-owned → all (D4). Deleted and disabled
 * connections are excluded. `forOwner` = owner of the MCP being edited (defaults to the actor).
 */
export async function listSelectableConnections(
  actor: McpActor,
  forOwner?: { id: string; role: "admin" | "staff" }
): Promise<SelectableConnection[]> {
  const owner = forOwner ?? { id: actor.id, role: actor.role }
  if (actor.role !== "admin" && owner.id !== actor.id) return []
  const usable = await listUsableConnectionsForMcp({
    id: owner.id,
    email: "",
    role: owner.role,
  })
  return usable
    .map((c) => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      status: c.status,
      ownerId: c.owner.id,
      ownerEmail: c.owner.email,
      isMine: c.owner.id === actor.id,
      accounts: c.accounts.map((a) => ({
        id: a.id,
        externalId: a.externalId,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        status: a.status,
      })),
      pages: c.pages.map((p) => ({
        id: p.id,
        externalId: p.externalId,
        name: p.name,
        category: p.category,
        followersCount: p.followersCount,
        insights: p.capabilities.insights,
      })),
    }))
    .sort((a, b) => Number(b.isMine) - Number(a.isMine))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Creates an MCP owned by the actor. Returns the full URL - the ONLY time it is returned without re-auth. */
/**
 * Wizard submit. Hands out a usable link → requires the same re-authentication as reveal/rotate
 * (password, plus TOTP when 2FA is on); the insert runs in the re-auth transaction.
 */
export async function createMcpServer(
  actor: McpActor,
  input: unknown,
  verify: ReauthVerifier
): Promise<{ id: string; name: string; url: string }> {
  const data = parseOrThrow(createMcpSchema, input)
  if (data.expiresAt && data.expiresAt.getTime() <= Date.now()) {
    throw invalid(MCP_SCHEMA_MESSAGES.expiresFuture, {
      expiresAt: MCP_SCHEMA_MESSAGES.expiresFuture,
    })
  }
  // Telegram channels: the creator owns the MCP → only the creator's own channels (admins too)
  const channelIds =
    (await usableChannelIds({ id: actor.id }, data.notificationChannelIds)) ??
    []
  // Google Drive sources: company + the creator's personal ones (admin creator: any live source)
  const driveSourceIds =
    (await usableDriveSourceIds(
      { id: actor.id, role: actor.role },
      data.driveSourceIds
    )) ?? []
  const id = randomUUID()
  const { key, columns } = newKeyColumns(id)
  const reauthLog = { action: "mcp.create" as const, target: { type: "mcp", id: null, label: data.name } }
  await withReauth(actor, reauthLog, verify, async (tx) => {
    await assertScopesAllowed(tx, actor, data.platforms)
    await assertDailyCaps(tx, data.platforms, data.settings)
    await tx.insert(mcpServers).values({
      id,
      ownerId: actor.id,
      name: data.name,
      description: data.description,
      ...columns,
      status: "active",
      expiresAt: data.expiresAt,
      settings: toStoredMcpSettings(data.settings),
    })
    await writeScopes(tx, id, data.platforms)
    await writeChannelScopes(tx, id, channelIds)
    await writeDriveScopes(tx, id, driveSourceIds)
    await logActivity(
      {
        actor: actorOf(actor),
        action: "mcp.create",
        target: { type: "mcp", id, label: data.name },
        metadata: {
          after: summarize({
            ...data,
            settings: normalizeSettingsForDiff(
              toStoredMcpSettings(data.settings)
            ),
            channels: channelIds,
            driveSources: driveSourceIds,
          }),
          keyPrefix: columns.keyPrefix,
        },
      },
      tx
    )
  })
  // the new key must work at once, also for a client blocked by the unknown-key limiter (active-key set)
  invalidateGrantCache(id)
  return { id, name: data.name, url: buildMcpUrl(appBaseUrl(), key) }
}

/** Updates name/description + steps 2–4. Takes effect on the next MCP request. */
export async function updateMcpServer(
  actor: McpActor,
  input: unknown
): Promise<{ changed: boolean }> {
  const data = parseOrThrow(updateMcpSchema, input)
  const result = await db.transaction(async (tx) => {
    const row = await lockMcp(tx, actor, data.id)
    const ownerRole = await ownerRoleOf(tx, row.ownerId)
    const expiryChanged =
      (row.expiresAt?.getTime() ?? null) !== (data.expiresAt?.getTime() ?? null)
    if (
      expiryChanged &&
      data.expiresAt &&
      data.expiresAt.getTime() <= Date.now()
    ) {
      throw invalid(MCP_SCHEMA_MESSAGES.expiresFuture, {
        expiresAt: MCP_SCHEMA_MESSAGES.expiresFuture,
      })
    }
    await assertScopesAllowed(
      tx,
      { id: row.ownerId, email: "", role: ownerRole },
      data.platforms
    )
    // every save makes the MCP a "caps required" one: a legacy MCP with write permissions must get its caps now
    await assertDailyCaps(tx, data.platforms, data.settings)

    const beforeConfig = await loadConfig(tx, row.id)
    const beforeChannels = await loadChannelIds(tx, row.id)
    // Telegram channels of the MCP OWNER only (an admin editing a staff MCP cannot add the admin's channels, an
    // admin MCP cannot use a staff channel); omitted = keep the stored scope; stored foreign rows are pruned
    const channelIds = await channelIdsForUpdate(
      row.ownerId,
      data.notificationChannelIds,
      beforeChannels
    )
    const beforeDrive = await loadDriveSourceIds(tx, row.id)
    // Drive sources usable by the MCP OWNER (staff MCP: company + own; admin MCP: any live source); omitted = keep
    const driveSourceIds = await driveSourceIdsForUpdate(
      tx,
      { id: row.ownerId, role: ownerRole },
      data.driveSourceIds,
      beforeDrive
    )
    const before = summarize({
      name: row.name,
      description: row.description,
      platforms: beforeConfig,
      settings: normalizeSettingsForDiff(row.settings),
      expiresAt: row.expiresAt,
      channels: beforeChannels,
      driveSources: beforeDrive,
    })
    const after = summarize({
      ...data,
      settings: normalizeSettingsForDiff(toStoredMcpSettings(data.settings)),
      channels: channelIds,
      driveSources: driveSourceIds,
    })
    const diff = diffSummaries(before, after)
    if (Object.keys(diff.after).length === 0) {
      if (parseMcpSettings(row.settings).moneyCapsRequired) return { changed: false }
      // no field the user edited changed, but saving upgrades a legacy row to "caps required": from now on money
      // writes without a daily cap are refused - a runtime change, so it is saved and logged like any update
      await tx
        .update(mcpServers)
        .set({ settings: toStoredMcpSettings(data.settings), updatedAt: new Date() })
        .where(eq(mcpServers.id, row.id))
      await logActivity(
        {
          actor: actorOf(actor),
          action: "mcp.update",
          target: { type: "mcp", id: row.id, label: data.name },
          metadata: {
            before: { moneyCapsRequired: false },
            after: { moneyCapsRequired: true },
            reason: "caps_required_upgrade",
            ...(row.ownerId !== actor.id ? { ownerId: row.ownerId } : {}),
          },
        },
        tx
      )
      return { changed: true }
    }

    await tx
      .update(mcpServers)
      .set({
        name: data.name,
        description: data.description,
        settings: toStoredMcpSettings(data.settings),
        expiresAt: data.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, row.id))
    if ("platforms" in diff.after) await writeScopes(tx, row.id, data.platforms)
    if ("channels" in diff.after) await writeChannelScopes(tx, row.id, channelIds)
    if ("driveSources" in diff.after)
      await writeDriveScopes(tx, row.id, driveSourceIds)
    await logActivity(
      {
        actor: actorOf(actor),
        action: "mcp.update",
        target: { type: "mcp", id: row.id, label: data.name },
        metadata: {
          ...diff,
          ...(row.ownerId !== actor.id ? { ownerId: row.ownerId } : {}),
        },
      },
      tx
    )
    return { changed: true }
  })
  if (result.changed) invalidateGrantCache(data.id)
  return result
}

export async function setMcpEnabled(
  actor: McpActor,
  id: string,
  enabled: boolean
): Promise<{ changed: boolean }> {
  const result = await db.transaction(async (tx) => {
    const row = await lockMcp(tx, actor, id)
    const next = enabled ? "active" : "disabled"
    if (row.status === next) return { changed: false }
    await tx
      .update(mcpServers)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(mcpServers.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: enabled ? "mcp.enable" : "mcp.disable",
        target: { type: "mcp", id: row.id, label: row.name },
        metadata: { before: { status: row.status }, after: { status: next } },
      },
      tx
    )
    return { changed: true }
  })
  if (result.changed) invalidateGrantCache(id)
  return result
}

/** @deprecated alias kept for callers/tests - the budget is shared by every re-auth (src/server/auth/reauth.ts). */
export const REVEAL_MAX_FAILURES = REAUTH_MAX_FAILURES
export { REAUTH_MAX_FAILURES, REAUTH_WINDOW_MINUTES, verifyReauthWithBetterAuth }
export type { ReauthOutcome, ReauthVerifier }

const mcpReauthLog = (
  action: "mcp.key.reveal" | "mcp.key.rotate",
  row: { id: string; name: string; keyPrefix: string }
) => ({
  action,
  target: { type: "mcp", id: row.id, label: row.name },
  metadata: { keyPrefix: row.keyPrefix },
})

/** Existing, accessible, non-deleted MCP (cheap pre-check before asking for re-auth). */
async function accessibleMcpRow(actor: McpActor, id: string) {
  if (!isUuid(id)) throw notFound()
  const [row] = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      ownerId: mcpServers.ownerId,
      keyPrefix: mcpServers.keyPrefix,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), isNull(mcpServers.deletedAt)))
    .limit(1)
  if (!row || !canAccess(actor, row.ownerId)) throw notFound()
  return row
}

/**
 * New key → old link stops working immediately. Hands out a usable link, so it requires the same
 * re-authentication as "Xem lại link" (password, plus TOTP when 2FA is on). Returns the new URL once.
 */
export async function rotateMcpKey(
  actor: McpActor,
  id: string,
  verify: ReauthVerifier
): Promise<{ url: string }> {
  const pre = await accessibleMcpRow(actor, id)
  const result = await withReauth(
    actor,
    mcpReauthLog("mcp.key.rotate", pre),
    verify,
    async (tx) => {
      const row = await lockMcp(tx, actor, id)
      const { key, columns } = newKeyColumns(row.id)
      await tx
        .update(mcpServers)
        .set({ ...columns, keyRotatedAt: new Date(), updatedAt: new Date() })
        .where(eq(mcpServers.id, row.id))
      await logActivity(
        {
          actor: actorOf(actor),
          action: "mcp.key.rotate",
          target: { type: "mcp", id: row.id, label: row.name },
          metadata: {
            before: { keyPrefix: row.keyPrefix },
            after: { keyPrefix: columns.keyPrefix },
          },
        },
        tx
      )
      return { url: buildMcpUrl(appBaseUrl(), key) }
    }
  )
  invalidateGrantCache(id)
  return result
}

/**
 * "Xem lại link" (D1): requires re-authentication on EVERY call (password, plus TOTP when the user has
 * 2FA). Failures are logged and throttled; success is logged (same transaction) before the URL is returned.
 */
export async function revealMcpUrl(
  actor: McpActor,
  id: string,
  verify: ReauthVerifier
): Promise<{ url: string }> {
  const row = await accessibleMcpRow(actor, id)
  return withReauth(actor, mcpReauthLog("mcp.key.reveal", row), verify, async (tx) => {
    const [locked] = await tx
      .select({
        keyEncrypted: mcpServers.keyEncrypted,
        keyPrefix: mcpServers.keyPrefix,
      })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, row.id), isNull(mcpServers.deletedAt)))
      .for("share")
      .limit(1)
    if (!locked) throw notFound()
    const key = decryptSecret(locked.keyEncrypted, aad.mcpKey(row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "mcp.key.reveal",
        target: { type: "mcp", id: row.id, label: row.name },
        metadata: {
          keyPrefix: locked.keyPrefix,
          ...(row.ownerId !== actor.id ? { ownerId: row.ownerId } : {}),
        },
      },
      tx
    )
    return { url: buildMcpUrl(appBaseUrl(), key) }
  })
}

/** Soft delete (requires typing the exact name). The key is scrubbed so the old link can never resolve. */
export async function deleteMcpServer(
  actor: McpActor,
  id: string,
  confirmName: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockMcp(tx, actor, id)
    if (confirmName.trim() !== row.name.trim()) {
      throw invalid(MCP_ERRORS.nameMismatch, {
        confirmName: MCP_ERRORS.nameMismatch,
      })
    }
    const scrub = newKeyColumns(row.id)
    await tx
      .update(mcpServers)
      .set({
        keyHash: scrub.columns.keyHash,
        keyEncrypted: scrub.columns.keyEncrypted,
        status: "disabled",
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "mcp.delete",
        target: { type: "mcp", id: row.id, label: row.name },
        metadata: {
          before: {
            name: row.name,
            status: row.status,
            keyPrefix: row.keyPrefix,
          },
        },
      },
      tx
    )
  })
  invalidateGrantCache(id)
}
