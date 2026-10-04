// Overview (/) data: KPIs, call chart (from the hourly rollup), alerts and recent activity.
// Scope: admins see everything; staff only their own connections / MCPs / MCP logs.
import { RELEASED_PLATFORMS } from "@/lib/platforms"
import "server-only"
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections, mcpCallLogs, mcpCallStatsHourly, mcpServers } from "@/server/db/schema"
import { statusHintFor, type ConnectionStatusValue } from "@/lib/schemas/connections"
import { LOG_TIMEZONE, zonedDayStart } from "@/lib/schemas/logs"
import type { LogViewer } from "./logs"

export const CHART_PLATFORMS = RELEASED_PLATFORMS
export type ChartPlatform = (typeof CHART_PLATFORMS)[number]
/** days before a token expiry that we warn */
export const TOKEN_WARN_DAYS = 7

export interface OverviewKpis {
  connections: number
  connectionsNeedingAttention: number
  adAccounts: number
  activeMcp: number
  totalMcp: number
  calls24h: number
  errors24h: number
  callsPrev24h: number
  errorsPrev24h: number
}

export interface ChartPoint {
  /** YYYY-MM-DD in LOG_TIMEZONE */
  date: string
  meta: number
  openai_ads: number
  other: number
}

export interface DashboardAlert {
  connectionId: string
  name: string
  platform: string
  kind: "invalid" | "expiring"
  tokenExpiresAt: string | null
  /** whole days left (null when no expiry) */
  daysLeft: number | null
  message: string | null
  /** the concrete next step (Vietnamese) - null when nothing to do */
  hint: string | null
}

export interface RecentItem {
  kind: "mcp" | "staff"
  id: string
  createdAt: string
  /** MCP: mcp name · staff: actor email */
  who: string | null
  /** MCP: tool or method · staff: action code */
  what: string
  platform: string | null
  status: string
  mcpId: string | null
  targetLabel: string | null
}

function startOfZonedDay(now: Date, daysBack: number, timeZone = LOG_TIMEZONE): { since: Date; days: string[] } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const today = fmt.format(now)
  const days: string[] = []
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }
  return { since: zonedDayStart(days[0], timeZone), days }
}

export async function getOverviewKpis(viewer: LogViewer, now: Date = new Date()): Promise<OverviewKpis> {
  const admin = viewer.role === "admin"
  const warnBefore = new Date(now.getTime() + TOKEN_WARN_DAYS * 86_400_000)
  const h24 = new Date(now.getTime() - 24 * 3_600_000)
  const h48 = new Date(now.getTime() - 48 * 3_600_000)
  const ownConn = admin ? undefined : eq(connections.ownerId, viewer.id)
  const ownMcp = admin ? undefined : eq(mcpServers.ownerId, viewer.id)

  const [conn, accounts, mcp, calls] = await Promise.all([
    db
      .select({
        total: count(),
        attention: sql<number>`count(*) filter (where ${connections.status} in ('expiring','invalid')
          or (${connections.status} <> 'disabled' and ${connections.tokenExpiresAt} is not null
              and ${connections.tokenExpiresAt} < ${warnBefore}))`.mapWith(Number),
      })
      .from(connections)
      .where(and(isNull(connections.deletedAt), inArray(connections.platform, [...RELEASED_PLATFORMS]), ownConn)),
    db
      .select({ total: count() })
      .from(adAccounts)
      .innerJoin(connections, eq(connections.id, adAccounts.connectionId))
      .where(and(isNull(connections.deletedAt), eq(adAccounts.isEnabled, true), ownConn)),
    db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${mcpServers.status} = 'active'
          and (${mcpServers.expiresAt} is null or ${mcpServers.expiresAt} > ${now}))`.mapWith(Number),
      })
      .from(mcpServers)
      .where(and(isNull(mcpServers.deletedAt), ownMcp)),
    db
      .select({
        calls: sql<number>`coalesce(sum(${mcpCallStatsHourly.calls}) filter (where ${mcpCallStatsHourly.bucket} >= date_trunc('hour', ${h24}::timestamptz)), 0)`.mapWith(Number),
        errors: sql<number>`coalesce(sum(${mcpCallStatsHourly.errors}) filter (where ${mcpCallStatsHourly.bucket} >= date_trunc('hour', ${h24}::timestamptz)), 0)`.mapWith(Number),
        callsPrev: sql<number>`coalesce(sum(${mcpCallStatsHourly.calls}) filter (where ${mcpCallStatsHourly.bucket} < date_trunc('hour', ${h24}::timestamptz)), 0)`.mapWith(Number),
        errorsPrev: sql<number>`coalesce(sum(${mcpCallStatsHourly.errors}) filter (where ${mcpCallStatsHourly.bucket} < date_trunc('hour', ${h24}::timestamptz)), 0)`.mapWith(Number),
      })
      .from(mcpCallStatsHourly)
      .where(
        and(
          gte(mcpCallStatsHourly.bucket, sql`date_trunc('hour', ${h48}::timestamptz)`),
          ne(mcpCallStatsHourly.toolName, ""),
          admin ? undefined : eq(mcpCallStatsHourly.ownerId, viewer.id)
        )
      ),
  ])
  return {
    connections: Number(conn[0]?.total ?? 0),
    connectionsNeedingAttention: Number(conn[0]?.attention ?? 0),
    adAccounts: Number(accounts[0]?.total ?? 0),
    activeMcp: Number(mcp[0]?.active ?? 0),
    totalMcp: Number(mcp[0]?.total ?? 0),
    calls24h: calls[0]?.calls ?? 0,
    errors24h: calls[0]?.errors ?? 0,
    callsPrev24h: calls[0]?.callsPrev ?? 0,
    errorsPrev24h: calls[0]?.errorsPrev ?? 0,
  }
}

/** Tool calls per day (LOG_TIMEZONE) and platform for the last `days` days, zero-filled. */
export async function getCallsChart(viewer: LogViewer, days = 30, now: Date = new Date()): Promise<ChartPoint[]> {
  const { since, days: labels } = startOfZonedDay(now, days)
  const rows = await db
    .select({
      day: sql<string>`to_char(${mcpCallStatsHourly.bucket} at time zone ${LOG_TIMEZONE}, 'YYYY-MM-DD')`,
      platform: mcpCallStatsHourly.platform,
      calls: sql<number>`sum(${mcpCallStatsHourly.calls})`.mapWith(Number),
    })
    .from(mcpCallStatsHourly)
    .where(
      and(
        gte(mcpCallStatsHourly.bucket, since),
        ne(mcpCallStatsHourly.toolName, ""),
        viewer.role === "admin" ? undefined : eq(mcpCallStatsHourly.ownerId, viewer.id)
      )
    )
    .groupBy(sql`1`, mcpCallStatsHourly.platform)
  const byDay = new Map<string, ChartPoint>(
    labels.map((d) => [d, { date: d, meta: 0, openai_ads: 0, other: 0 }])
  )
  for (const r of rows) {
    const p = byDay.get(r.day)
    if (!p) continue
    const key = (CHART_PLATFORMS as readonly string[]).includes(r.platform) ? (r.platform as ChartPlatform) : "other"
    p[key] += r.calls
  }
  return [...byDay.values()]
}

export async function getDashboardAlerts(viewer: LogViewer, now: Date = new Date()): Promise<DashboardAlert[]> {
  const warnBefore = new Date(now.getTime() + TOKEN_WARN_DAYS * 86_400_000)
  const rows = await db
    .select({
      id: connections.id,
      name: connections.name,
      platform: connections.platform,
      status: connections.status,
      statusMessage: connections.statusMessage,
      tokenExpiresAt: connections.tokenExpiresAt,
    })
    .from(connections)
    .where(
      and(
        isNull(connections.deletedAt),
        inArray(connections.platform, [...RELEASED_PLATFORMS]),
        viewer.role === "admin" ? undefined : eq(connections.ownerId, viewer.id),
        or(
          inArray(connections.status, ["expiring", "invalid"]),
          and(ne(connections.status, "disabled"), lt(connections.tokenExpiresAt, warnBefore))
        )
      )
    )
    .orderBy(sql`case when ${connections.status} = 'invalid' then 0 else 1 end`, connections.tokenExpiresAt)
    .limit(8)
  return rows.map((r) => ({
    connectionId: r.id,
    name: r.name,
    platform: String(r.platform),
    kind: r.status === "invalid" ? "invalid" : "expiring",
    tokenExpiresAt: r.tokenExpiresAt ? r.tokenExpiresAt.toISOString() : null,
    daysLeft: r.tokenExpiresAt ? Math.floor((r.tokenExpiresAt.getTime() - now.getTime()) / 86_400_000) : null,
    message: r.statusMessage,
    hint: statusHintFor({ platform: r.platform, status: r.status as ConnectionStatusValue, statusMessage: r.statusMessage }),
  }))
}

/** Last `limit` MCP calls (scoped) + staff actions (admins only), newest first, within 7 days. */
export async function getRecentActivity(
  viewer: LogViewer,
  limit = 10,
  now: Date = new Date()
): Promise<RecentItem[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000)
  const iso = (col: typeof mcpCallLogs.createdAt | typeof activityLogs.createdAt) =>
    sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  const [calls, staff] = await Promise.all([
    db
      .select({
        id: mcpCallLogs.id,
        createdAt: iso(mcpCallLogs.createdAt),
        mcpId: mcpCallLogs.mcpId,
        mcpName: mcpCallLogs.mcpName,
        method: mcpCallLogs.method,
        toolName: mcpCallLogs.toolName,
        platform: mcpCallLogs.platform,
        status: mcpCallLogs.status,
      })
      .from(mcpCallLogs)
      .where(
        and(
          gt(mcpCallLogs.createdAt, since),
          viewer.role === "admin" ? undefined : eq(mcpCallLogs.ownerId, viewer.id)
        )
      )
      .orderBy(desc(mcpCallLogs.createdAt), desc(mcpCallLogs.id))
      .limit(limit),
    viewer.role === "admin"
      ? db
          .select({
            id: activityLogs.id,
            createdAt: iso(activityLogs.createdAt),
            actorEmail: activityLogs.actorEmail,
            action: activityLogs.action,
            targetLabel: activityLogs.targetLabel,
            status: activityLogs.status,
          })
          .from(activityLogs)
          .where(gt(activityLogs.createdAt, since))
          .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
          .limit(limit)
      : Promise.resolve([]),
  ])
  const items: RecentItem[] = [
    ...calls.map((c) => ({
      kind: "mcp" as const,
      id: c.id,
      createdAt: c.createdAt,
      who: c.mcpName,
      what: c.toolName ?? c.method,
      platform: c.platform,
      status: c.status,
      mcpId: c.mcpId,
      targetLabel: null,
    })),
    ...staff.map((s) => ({
      kind: "staff" as const,
      id: s.id,
      createdAt: s.createdAt,
      who: s.actorEmail,
      what: s.action,
      platform: null,
      status: s.status,
      mcpId: null,
      targetLabel: s.targetLabel,
    })),
  ]
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return items.slice(0, limit)
}
