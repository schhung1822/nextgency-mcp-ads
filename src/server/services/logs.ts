// Log reading service: MCP call logs + staff activity logs (monthly-partitioned tables).
// Rules (03-database-schema.md §5): every query is bounded by a time range (partition pruning),
// keyset pagination on (created_at, id), list queries never select the big jsonb columns,
// no exact count(*). Ownership: staff only see logs of their own MCPs; activity logs are admin-only
// (except "my activity").
import "server-only"
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm"
import { db } from "@/server/db/client"
import {
  activityLogs,
  adAccounts,
  connections,
  mcpCallLogs,
  mcpCallStatsHourly,
  mcpServers,
  user as userTable,
} from "@/server/db/schema"
import { AuthorizationError } from "@/server/auth/session"
import {
  LOG_EXPORT_MAX_ROWS,
  LOG_PAGE_SIZE,
  resolveLogTimeRange,
  type LogQuery,
  type LogTimeRange,
} from "@/lib/schemas/logs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whoever is reading logs (from requireUser()/requireUserForAction()). Never from the client. */
export interface LogViewer {
  id: string
  role: "admin" | "staff"
}

export interface LogPage<T> {
  rows: T[]
  /** opaque keyset cursor for the next page; null = no more rows */
  nextCursor: string | null
}

export interface McpLogFilters extends LogTimeRange {
  mcpIds?: string[]
  /** admin only - ignored for staff (always their own id) */
  ownerIds?: string[]
  platforms?: string[]
  adAccountIds?: string[]
  tools?: string[]
  statuses?: string[]
  writesOnly?: boolean
  /** substring of error_message (pg_trgm index) */
  q?: string
}

export interface ActivityLogFilters extends LogTimeRange {
  actorIds?: string[]
  /** action prefixes, e.g. "auth" → auth.* */
  groups?: string[]
  actions?: string[]
  targetType?: string
  targetId?: string
  statuses?: string[]
  /** substring of actor email / target label / target id */
  q?: string
}

export interface McpLogListRow {
  id: string
  /** ISO-8601 UTC with microseconds (needed for detail lookups) */
  createdAt: string
  mcpId: string | null
  mcpName: string | null
  ownerId: string | null
  ownerEmail: string | null
  clientName: string | null
  clientVersion: string | null
  method: string
  toolName: string | null
  platform: string | null
  adAccountId: string | null
  actionKind: string
  status: string
  errorCode: string | null
  /** first 300 characters */
  errorMessage: string | null
  durationMs: number
}

export interface McpLogDetail extends McpLogListRow {
  jsonrpcId: string | null
  protocolVersion: string | null
  ip: string | null
  userAgent: string | null
  objectIds: string[] | null
  upstreamRequestIds: string[] | null
  request: unknown
  response: unknown
  changes: unknown
  pendingActionId: string | null
  requestBytes: number | null
  responseBytes: number | null
  truncated: boolean
}

export interface ActivityLogListRow {
  id: string
  createdAt: string
  actorId: string | null
  actorEmail: string | null
  actorRole: string | null
  action: string
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  status: string
  ip: string | null
  userAgent: string | null
}

export interface ActivityLogDetail extends ActivityLogListRow {
  metadata: unknown
}

// ---------------------------------------------------------------------------
// Cursor + small helpers
// ---------------------------------------------------------------------------

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RANGE_MS = 400 * 86_400_000

export function encodeLogCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url")
}

export function decodeLogCursor(cursor: string | null | undefined): { ts: string; id: string } | null {
  if (!cursor) return null
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    if (!Array.isArray(v) || v.length !== 2) return null
    const [ts, id] = v
    if (typeof ts !== "string" || typeof id !== "string") return null
    if (!TS_RE.test(ts) || !UUID_RE.test(id)) return null
    return { ts, id }
  } catch {
    return null
  }
}

export function isLogTimestamp(s: string): boolean {
  return TS_RE.test(s)
}

/** LIKE pattern escaping (%, _ and \). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function assertTimeRange(r: LogTimeRange): void {
  const since = r.since?.getTime?.()
  const until = r.until?.getTime?.()
  if (!Number.isFinite(since) || !Number.isFinite(until)) {
    throw new RangeError("Log queries require a time range (since/until).")
  }
  if (since >= until) throw new RangeError("Log time range is empty.")
  if (until - since > MAX_RANGE_MS) throw new RangeError("Log time range is too long (max 400 days).")
}

function isoMicro(col: SQL | typeof mcpCallLogs.createdAt | typeof activityLogs.createdAt) {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

function nonEmpty<T>(a: T[] | undefined): a is T[] {
  return Array.isArray(a) && a.length > 0
}

// ---------------------------------------------------------------------------
// MCP call logs
// ---------------------------------------------------------------------------

const mcpListColumns = {
  id: mcpCallLogs.id,
  createdAt: isoMicro(mcpCallLogs.createdAt),
  mcpId: mcpCallLogs.mcpId,
  mcpName: mcpCallLogs.mcpName,
  ownerId: mcpCallLogs.ownerId,
  ownerEmail: mcpCallLogs.ownerEmail,
  clientName: mcpCallLogs.clientName,
  clientVersion: mcpCallLogs.clientVersion,
  method: mcpCallLogs.method,
  toolName: mcpCallLogs.toolName,
  platform: mcpCallLogs.platform,
  adAccountId: mcpCallLogs.adAccountId,
  actionKind: mcpCallLogs.actionKind,
  status: mcpCallLogs.status,
  errorCode: mcpCallLogs.errorCode,
  errorMessage: sql<string | null>`left(${mcpCallLogs.errorMessage}, 300)`,
  durationMs: mcpCallLogs.durationMs,
}

function mcpWhere(viewer: LogViewer, f: McpLogFilters, cursor: { ts: string; id: string } | null): SQL {
  assertTimeRange(f)
  const t = mcpCallLogs
  const conds: (SQL | undefined)[] = [gte(t.createdAt, f.since), lt(t.createdAt, f.until)]
  if (viewer.role !== "admin") conds.push(eq(t.ownerId, viewer.id))
  else if (nonEmpty(f.ownerIds)) conds.push(inArray(t.ownerId, f.ownerIds))
  if (nonEmpty(f.mcpIds)) conds.push(inArray(t.mcpId, f.mcpIds.filter((id) => UUID_RE.test(id))))
  if (nonEmpty(f.platforms)) conds.push(inArray(t.platform, f.platforms))
  if (nonEmpty(f.adAccountIds)) conds.push(inArray(t.adAccountId, f.adAccountIds))
  if (nonEmpty(f.tools)) conds.push(inArray(t.toolName, f.tools))
  if (nonEmpty(f.statuses)) conds.push(inArray(t.status, f.statuses))
  if (f.writesOnly) conds.push(eq(t.actionKind, "write"))
  if (f.q) conds.push(sql`${t.errorMessage} ilike ${`%${escapeLike(f.q)}%`}`)
  if (cursor) conds.push(sql`(${t.createdAt}, ${t.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`)
  return and(...conds) as SQL
}

/** Converts the /logs URL query into service filters (time range resolved, default last 24h). */
export function mcpFiltersFromQuery(q: LogQuery, now: Date = new Date()): McpLogFilters {
  return {
    ...resolveLogTimeRange(q.range, now),
    mcpIds: q.mcp,
    ownerIds: q.owner,
    platforms: q.platform,
    adAccountIds: q.account,
    tools: q.tool,
    statuses: q.status,
    writesOnly: q.writes,
    q: q.q || undefined,
  }
}

export function activityFiltersFromQuery(q: LogQuery, now: Date = new Date()): ActivityLogFilters {
  return {
    ...resolveLogTimeRange(q.range, now),
    actorIds: q.actor,
    groups: q.group,
    statuses: q.result,
    q: q.q || undefined,
  }
}

/** MCP call logs, newest first. Staff: only rows whose owner_id is theirs. */
export async function listMcpLogs(
  viewer: LogViewer,
  filters: McpLogFilters,
  cursor?: string | null,
  limit: number = LOG_PAGE_SIZE
): Promise<LogPage<McpLogListRow>> {
  const c = decodeLogCursor(cursor)
  if (cursor && !c) return { rows: [], nextCursor: null }
  const take = Math.max(1, Math.min(limit, 1000))
  const rows = await db
    .select(mcpListColumns)
    .from(mcpCallLogs)
    .where(mcpWhere(viewer, filters, c))
    .orderBy(desc(mcpCallLogs.createdAt), desc(mcpCallLogs.id))
    .limit(take + 1)
  const more = rows.length > take
  const page = more ? rows.slice(0, take) : rows
  const last = page[page.length - 1]
  return { rows: page, nextCursor: more && last ? encodeLogCursor(last.createdAt, last.id) : null }
}

/** One MCP call log with request/response/changes. null when missing or not visible to the viewer. */
export async function getMcpLog(viewer: LogViewer, id: string, createdAt: string): Promise<McpLogDetail | null> {
  if (!UUID_RE.test(id) || !TS_RE.test(createdAt)) return null
  const t = mcpCallLogs
  const rows = await db
    .select({
      ...mcpListColumns,
      errorMessage: t.errorMessage,
      jsonrpcId: t.jsonrpcId,
      protocolVersion: t.protocolVersion,
      ip: sql<string | null>`host(${t.ip})`,
      userAgent: t.userAgent,
      objectIds: t.objectIds,
      upstreamRequestIds: t.upstreamRequestIds,
      request: t.request,
      response: t.response,
      changes: t.changes,
      pendingActionId: t.pendingActionId,
      requestBytes: t.requestBytes,
      responseBytes: t.responseBytes,
      truncated: t.truncated,
    })
    .from(t)
    .where(
      and(
        eq(t.id, id),
        sql`${t.createdAt} = ${createdAt}::timestamptz`,
        viewer.role === "admin" ? undefined : eq(t.ownerId, viewer.id)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Activity (staff) logs
// ---------------------------------------------------------------------------

const activityListColumns = {
  id: activityLogs.id,
  createdAt: isoMicro(activityLogs.createdAt),
  actorId: activityLogs.actorId,
  actorEmail: activityLogs.actorEmail,
  actorRole: activityLogs.actorRole,
  action: activityLogs.action,
  targetType: activityLogs.targetType,
  targetId: activityLogs.targetId,
  targetLabel: activityLogs.targetLabel,
  status: activityLogs.status,
  ip: sql<string | null>`host(${activityLogs.ip})`,
  userAgent: activityLogs.userAgent,
}

function activityWhere(f: ActivityLogFilters, cursor: { ts: string; id: string } | null, actorId?: string): SQL {
  assertTimeRange(f)
  const t = activityLogs
  const conds: (SQL | undefined)[] = [gte(t.createdAt, f.since), lt(t.createdAt, f.until)]
  if (actorId) conds.push(eq(t.actorId, actorId))
  else if (nonEmpty(f.actorIds)) conds.push(inArray(t.actorId, f.actorIds))
  if (nonEmpty(f.groups)) {
    conds.push(or(...f.groups.map((g) => sql`${t.action} like ${`${escapeLike(g)}.%`}`)))
  }
  if (nonEmpty(f.actions)) conds.push(inArray(t.action, f.actions))
  if (f.targetType) conds.push(eq(t.targetType, f.targetType))
  if (f.targetId) conds.push(eq(t.targetId, f.targetId))
  if (nonEmpty(f.statuses)) conds.push(inArray(t.status, f.statuses))
  if (f.q) {
    const p = `%${escapeLike(f.q)}%`
    conds.push(or(sql`${t.actorEmail} ilike ${p}`, sql`${t.targetLabel} ilike ${p}`, sql`${t.targetId} ilike ${p}`))
  }
  if (cursor) conds.push(sql`(${t.createdAt}, ${t.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`)
  return and(...conds) as SQL
}

async function selectActivityPage(
  where: SQL,
  limit: number
): Promise<LogPage<ActivityLogListRow>> {
  const take = Math.max(1, Math.min(limit, 1000))
  const rows = await db
    .select(activityListColumns)
    .from(activityLogs)
    .where(where)
    .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
    .limit(take + 1)
  const more = rows.length > take
  const page = more ? rows.slice(0, take) : rows
  const last = page[page.length - 1]
  return { rows: page, nextCursor: more && last ? encodeLogCursor(last.createdAt, last.id) : null }
}

function assertAdmin(viewer: LogViewer): void {
  if (viewer.role !== "admin") throw new AuthorizationError()
}

/** Staff activity log - admins only. */
export async function listActivityLogs(
  viewer: LogViewer,
  filters: ActivityLogFilters,
  cursor?: string | null,
  limit: number = LOG_PAGE_SIZE
): Promise<LogPage<ActivityLogListRow>> {
  assertAdmin(viewer)
  const c = decodeLogCursor(cursor)
  if (cursor && !c) return { rows: [], nextCursor: null }
  return selectActivityPage(activityWhere(filters, c), limit)
}

/**
 * "Hoạt động của tôi" (account page): the viewer's own activity, newest first.
 * Default window: last 90 days (keeps partition pruning); pass `cursor` from the previous page.
 */
export async function listMyActivity(
  viewer: LogViewer,
  opts: { cursor?: string | null; limit?: number; days?: number; now?: Date } = {}
): Promise<LogPage<ActivityLogListRow>> {
  const now = opts.now ?? new Date()
  const days = Math.max(1, Math.min(opts.days ?? 90, 400))
  const c = decodeLogCursor(opts.cursor)
  if (opts.cursor && !c) return { rows: [], nextCursor: null }
  const range = { since: new Date(now.getTime() - days * 86_400_000), until: new Date(now.getTime() + 60_000) }
  return selectActivityPage(activityWhere(range, c, viewer.id), opts.limit ?? 20)
}

/** One activity row with metadata. Admin: any row; staff: only their own. */
export async function getActivityLog(
  viewer: LogViewer,
  id: string,
  createdAt: string
): Promise<ActivityLogDetail | null> {
  if (!UUID_RE.test(id) || !TS_RE.test(createdAt)) return null
  const t = activityLogs
  const rows = await db
    .select({ ...activityListColumns, metadata: t.metadata })
    .from(t)
    .where(
      and(
        eq(t.id, id),
        sql`${t.createdAt} = ${createdAt}::timestamptz`,
        viewer.role === "admin" ? undefined : eq(t.actorId, viewer.id)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Filter options for the /logs page
// ---------------------------------------------------------------------------

export interface LogFilterOptions {
  mcps: { id: string; name: string; ownerEmail: string | null }[]
  /** admin only (empty for staff) */
  users: { id: string; name: string; email: string }[]
  accounts: { externalId: string; name: string; platform: string }[]
  tools: string[]
}

export async function getLogFilterOptions(viewer: LogViewer, now: Date = new Date()): Promise<LogFilterOptions> {
  const admin = viewer.role === "admin"
  const [mcps, users, accounts, tools] = await Promise.all([
    db
      .select({ id: mcpServers.id, name: mcpServers.name, ownerEmail: userTable.email })
      .from(mcpServers)
      .leftJoin(userTable, eq(userTable.id, mcpServers.ownerId))
      .where(and(isNull(mcpServers.deletedAt), admin ? undefined : eq(mcpServers.ownerId, viewer.id)))
      .orderBy(asc(mcpServers.name))
      .limit(500),
    admin
      ? db
          .select({ id: userTable.id, name: userTable.name, email: userTable.email })
          .from(userTable)
          .orderBy(asc(userTable.email))
          .limit(500)
      : Promise.resolve([]),
    db
      .selectDistinctOn([adAccounts.platform, adAccounts.externalId], {
        externalId: adAccounts.externalId,
        name: adAccounts.name,
        platform: adAccounts.platform,
      })
      .from(adAccounts)
      .innerJoin(connections, eq(connections.id, adAccounts.connectionId))
      .where(and(isNull(connections.deletedAt), admin ? undefined : eq(connections.ownerId, viewer.id)))
      .orderBy(asc(adAccounts.platform), asc(adAccounts.externalId))
      .limit(1000),
    db
      .selectDistinct({ tool: mcpCallStatsHourly.toolName })
      .from(mcpCallStatsHourly)
      .where(
        and(
          gte(mcpCallStatsHourly.bucket, new Date(now.getTime() - 30 * 86_400_000)),
          sql`${mcpCallStatsHourly.toolName} <> ''`,
          admin ? undefined : eq(mcpCallStatsHourly.ownerId, viewer.id)
        )
      )
      .orderBy(asc(mcpCallStatsHourly.toolName))
      .limit(300),
  ])
  return {
    mcps,
    users,
    accounts: accounts.map((a) => ({ ...a, platform: String(a.platform) })),
    tools: tools.map((t) => t.tool),
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export const CSV_BOM = "﻿"

/**
 * Cells a spreadsheet may read as a formula: =, +, -, @, tab, CR, LF - also their full-width forms (＝ ＋ － ＠, which
 * some spreadsheet apps normalise) and after leading spaces (" =1+1").
 */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/

/** RFC 4180 field + spreadsheet formula-injection guard (a risky first character is prefixed with '). */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ""
  let s = Array.isArray(value) ? value.join(" ") : String(value)
  if (FORMULA_START.test(s) || FORMULA_START.test(s.trimStart())) s = `'${s}`
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvLine(values: readonly unknown[]): string {
  return values.map(csvEscape).join(",") + "\r\n"
}

export interface McpLogExportRow extends McpLogListRow {
  ip: string | null
  objectIds: string[] | null
  upstreamRequestIds: string[] | null
}

/** Batched keyset iteration for CSV export (no jsonb columns), capped at `maxRows`. */
export async function* iterateMcpLogsForExport(
  viewer: LogViewer,
  filters: McpLogFilters,
  maxRows: number = LOG_EXPORT_MAX_ROWS,
  batchSize = 1000
): AsyncGenerator<McpLogExportRow[]> {
  let cursor: { ts: string; id: string } | null = null
  let total = 0
  while (total < maxRows) {
    const take = Math.min(batchSize, maxRows - total)
    const rows: McpLogExportRow[] = await db
      .select({
        ...mcpListColumns,
        errorMessage: sql<string | null>`left(${mcpCallLogs.errorMessage}, 2000)`,
        ip: sql<string | null>`host(${mcpCallLogs.ip})`,
        objectIds: mcpCallLogs.objectIds,
        upstreamRequestIds: mcpCallLogs.upstreamRequestIds,
      })
      .from(mcpCallLogs)
      .where(mcpWhere(viewer, filters, cursor))
      .orderBy(desc(mcpCallLogs.createdAt), desc(mcpCallLogs.id))
      .limit(take)
    if (rows.length === 0) return
    total += rows.length
    yield rows
    if (rows.length < take) return
    const last = rows[rows.length - 1]
    cursor = { ts: last.createdAt, id: last.id }
  }
}

export async function* iterateActivityLogsForExport(
  viewer: LogViewer,
  filters: ActivityLogFilters,
  maxRows: number = LOG_EXPORT_MAX_ROWS,
  batchSize = 1000
): AsyncGenerator<ActivityLogListRow[]> {
  assertAdmin(viewer)
  let cursor: { ts: string; id: string } | null = null
  let total = 0
  while (total < maxRows) {
    const take = Math.min(batchSize, maxRows - total)
    const rows: ActivityLogListRow[] = await db
      .select(activityListColumns)
      .from(activityLogs)
      .where(activityWhere(filters, cursor))
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(take)
    if (rows.length === 0) return
    total += rows.length
    yield rows
    if (rows.length < take) return
    const last = rows[rows.length - 1]
    cursor = { ts: last.createdAt, id: last.id }
  }
}

// ---------------------------------------------------------------------------
// Storage info (settings page, admin)
// ---------------------------------------------------------------------------

export interface PartitionInfo {
  name: string
  bytes: number
  rowsEstimate: number
  /** e.g. FOR VALUES FROM ('2026-10-01 00:00:00+00') TO (...) | DEFAULT */
  bound: string
}

export interface LogTableInfo {
  table: "mcp_call_logs" | "activity_logs"
  totalBytes: number
  rowsEstimate: number
  partitions: PartitionInfo[]
  /** rows in the DEFAULT partition (capped at 10 001) - should be 0 */
  defaultRows: number
}

export interface LogStorageInfo {
  tables: LogTableInfo[]
  stats: { bytes: number; rowsEstimate: number }
}

const LOG_PARENTS = ["mcp_call_logs", "activity_logs"] as const

/** Sizes of the log tables / partitions (settings page) - admins only. */
export async function getLogStorageInfo(viewer: LogViewer): Promise<LogStorageInfo> {
  assertAdmin(viewer)
  const tables: LogTableInfo[] = []
  for (const parent of LOG_PARENTS) {
    const res = await db.execute<{ name: string; bytes: string; rows: string; bound: string | null }>(sql`
      select c.relname as name,
             pg_total_relation_size(c.oid)::bigint as bytes,
             greatest(c.reltuples, 0)::bigint as rows,
             pg_get_expr(c.relpartbound, c.oid) as bound
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
       where p.relname = ${parent}
         and p.relnamespace = 'public'::regnamespace
         and c.relkind in ('r', 'p')
       order by c.relname`)
    const partitions: PartitionInfo[] = res.rows.map((r) => ({
      name: r.name,
      bytes: Number(r.bytes),
      rowsEstimate: Number(r.rows),
      bound: r.bound ?? "",
    }))
    // static identifiers (no user input)
    const defaultCount =
      parent === "mcp_call_logs"
        ? await db.execute<{ n: string }>(
            sql`select count(*)::int as n from (select 1 from mcp_call_logs_default limit 10001) s`
          )
        : await db.execute<{ n: string }>(
            sql`select count(*)::int as n from (select 1 from activity_logs_default limit 10001) s`
          )
    tables.push({
      table: parent,
      totalBytes: partitions.reduce((s, p) => s + p.bytes, 0),
      rowsEstimate: partitions.reduce((s, p) => s + p.rowsEstimate, 0),
      partitions,
      defaultRows: Number(defaultCount.rows[0]?.n ?? 0),
    })
  }
  const stats = await db.execute<{ bytes: string; rows: string }>(sql`
    select pg_total_relation_size('mcp_call_stats_hourly'::regclass)::bigint as bytes,
           greatest(reltuples, 0)::bigint as rows
      from pg_class where oid = 'mcp_call_stats_hourly'::regclass`)
  return {
    tables,
    stats: { bytes: Number(stats.rows[0]?.bytes ?? 0), rowsEstimate: Number(stats.rows[0]?.rows ?? 0) },
  }
}
