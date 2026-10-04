// Insights → normalized report rows.
// Always sends an explicit fields[] list (omitting it returns only impressions).
// Request field names: FLAT everywhere (`readable_time`, `campaign_id`, `ad_group_status`, `spend`…), as in the
// official reporting example (`fields[]=campaign_id`) and the OpenAPI InsightItemBody (every response key is
// flat). The OpenAPI spec does not document dotted request names. Set OPENAI_ADS_INSIGHTS_FIELD_STYLE=canonical
// to switch back to the dotted form (`campaign.id`, `{level}.{metric}`); the parser accepts both shapes.
import { ProviderError, unsupported } from "../errors"
import { assertRange, addDays, daysBetweenInclusive, todayInTz } from "../dates"
import { num } from "../money"
import {
  emptyMetrics,
  type NormalizedMetrics,
  type NormalizedStatus,
  type ReportLevel,
  type ReportPage,
  type ReportQuery,
  type ReportRow,
} from "../types"
import { decodeCursor, encodeCursor, oaRequest, PLATFORM, type OaList } from "./client"
import { normalizeStatus, type Ctx } from "./objects"

type AggLevel = "ad_account" | "campaign" | "ad_group" | "ad"

const AGG: Record<Exclude<ReportLevel, "keyword">, AggLevel> = {
  account: "ad_account",
  campaign: "campaign",
  ad_group: "ad_group",
  ad: "ad",
}

const DELIVERY_METRICS = ["impressions", "clicks", "spend", "ctr", "cpc", "cpm"] as const
const CONVERSION_METRICS = ["conversions", "cpa", "post_click_cvr", "order_created_attributed_sales", "order_created_roas"] as const
const LEVEL_DEPTH: Record<AggLevel, number> = { ad_account: 0, campaign: 1, ad_group: 2, ad: 3 }

/** Daily/monthly delivery reporting keeps the most recent 365 days. */
export const HISTORY_DAYS = 365
export const MAX_ROWS_PER_PAGE = 2_000

export type InsightsRow = Record<string, unknown>

function fieldStyle(): "canonical" | "flat" {
  return process.env.OPENAI_ADS_INSIGHTS_FIELD_STYLE === "canonical" ? "canonical" : "flat"
}

/** Canonical "campaign.id" → flat "campaign_id" (and metadata.readable_time → readable_time). */
export function flatKey(field: string): string {
  if (field.startsWith("metadata.")) return field.slice("metadata.".length)
  return field.replace(/\./g, "_")
}

export function buildFields(agg: AggLevel, opts: { daily: boolean; conversions: boolean }): string[] {
  const style = fieldStyle()
  const f: string[] = []
  if (opts.daily) f.push("metadata.readable_time")
  // parent ids then own id/name/status
  if (LEVEL_DEPTH[agg] >= 2) f.push("campaign.id")
  if (LEVEL_DEPTH[agg] >= 3) f.push("ad_group.id")
  f.push(`${agg}.id`, `${agg}.name`)
  if (agg !== "ad_account") f.push(`${agg}.status`)
  if (agg === "ad") f.push("ad.review_status")
  for (const m of DELIVERY_METRICS) f.push(style === "flat" ? m : `${agg}.${m}`)
  if (opts.conversions) f.push(...CONVERSION_METRICS, "order_created_attributed_sales_currency")
  return style === "flat" ? f.map(flatKey) : f
}

export function dateRangeJson(since: string, until: string, timezone: string): string {
  return JSON.stringify({ type: "date_range", since, until, timezone })
}

/** Read a field from a row whatever its serialization: flat, dotted, or level-prefixed metric. */
export function pick(row: InsightsRow, agg: AggLevel, name: string): unknown {
  const candidates = [name, flatKey(name)]
  if (!name.includes(".")) candidates.push(`${agg}_${name}`, `${agg}.${name}`)
  for (const k of candidates) {
    if (k in row) return row[k]
  }
  return undefined
}

function numOrNull(v: unknown): number | null {
  return num(v)
}

export function normalizeInsightRow(row: InsightsRow, agg: AggLevel): NormalizedMetrics {
  const m = emptyMetrics()
  const g = (n: string) => numOrNull(pick(row, agg, n))
  m.impressions = g("impressions")
  m.clicks = g("clicks")
  m.link_clicks = m.clicks // every OpenAI Ads click goes to the landing page (04-mcp-design normalized table)
  m.spend = g("spend") // major units already
  const ctr = g("ctr") // ratio (0.04 = 4%)
  m.ctr = ctr === null ? null : Math.round(ctr * 100 * 1e6) / 1e6
  m.cpc = g("cpc")
  m.cpm = g("cpm")
  m.conversions = g("conversions")
  m.cpa = g("cpa")
  m.conversion_value = g("order_created_attributed_sales")
  m.roas = g("order_created_roas")
  return m
}

const STATUS_TO_RAW: Partial<Record<NormalizedStatus, { field: "status" | "review_status"; value: string }>> = {
  active: { field: "status", value: "active" },
  paused: { field: "status", value: "paused" },
  archived: { field: "status", value: "archived" },
  pending_review: { field: "review_status", value: "in_review" },
  rejected: { field: "review_status", value: "rejected" },
}

interface Filter {
  field: string
  operator: "IN" | "GREATER_THAN" | "LESS_THAN"
  value: string[] | number
}

export function buildFilters(q: ReportQuery, agg: AggLevel, warnings: string[]): Filter[] {
  const out: Filter[] = []
  const f = q.filters ?? {}
  const idFilter = (ids: string[] | undefined, level: AggLevel, label: string) => {
    if (!ids?.length) return
    if (LEVEL_DEPTH[level] > LEVEL_DEPTH[agg]) {
      warnings.push(`Bỏ qua bộ lọc ${label}: không áp dụng được khi báo cáo ở cấp ${agg}.`)
      return
    }
    out.push({ field: `${level}.id`, operator: "IN", value: ids })
  }
  idFilter(f.campaignIds, "campaign", "campaignIds")
  idFilter(f.adGroupIds, "ad_group", "adGroupIds")
  idFilter(f.adIds, "ad", "adIds")
  if (f.statuses?.length && agg !== "ad_account") {
    const byField = new Map<string, string[]>()
    for (const s of f.statuses) {
      const m = STATUS_TO_RAW[s]
      if (!m || (m.field === "review_status" && agg !== "ad")) {
        warnings.push(`Bỏ qua trạng thái "${s}" trong bộ lọc (không áp dụng cho OpenAI Ads ở cấp ${agg}).`)
        continue
      }
      const key = `${agg}.${m.field}`
      byField.set(key, [...(byField.get(key) ?? []), m.value])
    }
    for (const [field, value] of byField) out.push({ field, operator: "IN", value })
  }
  return out
}

/** Clamp the requested range to what OpenAI keeps; returns warnings instead of failing where safe. */
export function clampRange(from: string, to: string, timezone: string, now: Date = new Date()) {
  const warnings: string[] = []
  assertRange({ from, to })
  const today = todayInTz(timezone, now)
  if (from > today) {
    throw new ProviderError({
      platform: PLATFORM,
      code: "invalid_request",
      message: "Date range is in the future",
      userMessageVi: "Khoảng ngày nằm hoàn toàn trong tương lai.",
    })
  }
  let until = to
  if (until > today) {
    until = today
    warnings.push(`Ngày kết thúc ${to} ở tương lai - đã lấy đến hôm nay (${today}).`)
  }
  const earliest = addDays(today, -(HISTORY_DAYS - 1))
  let since = from
  if (since < earliest) {
    if (until < earliest) {
      throw new ProviderError({
        platform: PLATFORM,
        code: "invalid_request",
        message: "Date range older than retention",
        userMessageVi: `OpenAI Ads chỉ lưu dữ liệu báo cáo theo ngày trong ${HISTORY_DAYS} ngày gần nhất (từ ${earliest}).`,
      })
    }
    since = earliest
    warnings.push(`OpenAI Ads chỉ giữ ${HISTORY_DAYS} ngày dữ liệu - đã lấy từ ${earliest} thay vì ${from}.`)
  }
  if (until >= today) warnings.push("Số liệu của hôm nay chưa chốt (mới một phần ngày); spend/chuyển đổi có thể cập nhật muộn hơn lượt hiển thị/nhấp.")
  return { since, until, warnings }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

export async function getReport(ctx: Ctx, q: ReportQuery): Promise<ReportPage> {
  if (q.level === "keyword") throw unsupported(PLATFORM, "báo cáo theo từ khoá")
  const agg = AGG[q.level]
  const tz = ctx.account.timezone
  const { since, until, warnings } = clampRange(q.dateRange.from, q.dateRange.to, tz)

  let preset = q.metrics
  if (preset === "video") {
    warnings.push("OpenAI Ads không có chỉ số video - trả về nhóm chỉ số cơ bản.")
    preset = "basic"
  }
  const wantConversions = preset === "conversion" || preset === "all"
  if (wantConversions) {
    warnings.push(
      "Chuyển đổi tính theo cửa sổ mặc định 30 ngày sau nhấp / 1 ngày sau xem, theo ngày tương tác quảng cáo; dữ liệu chuyển đổi cập nhật theo ngày."
    )
    if (daysBetweenInclusive({ from: since, to: until }) > HISTORY_DAYS) {
      throw new ProviderError({
        platform: PLATFORM,
        code: "invalid_request",
        message: "Conversion metrics range > 365 days",
        userMessageVi: "Chỉ số chuyển đổi chỉ lấy được tối đa 365 ngày mỗi lần.",
      })
    }
  }
  const daily = q.granularity === "day"
  const fields = buildFields(agg, { daily, conversions: wantConversions })
  const filters = buildFilters(q, agg, warnings)
  const limit = Math.min(Math.max(Math.trunc(q.limit) || 50, 1), MAX_ROWS_PER_PAGE)
  const cur = decodeCursor(q.cursor)
  const after = typeof cur?.after === "string" ? cur.after : undefined

  const res = await oaRequest<OaList<InsightsRow> & { timezone?: string }>(ctx, {
    method: "GET",
    path: "/ad_account/insights",
    query: {
      aggregation_level: agg,
      time_granularity: daily ? "daily" : "none",
      time_ranges: [dateRangeJson(since, until, tz)],
      fields,
      filters: filters.length ? filters.map((x) => JSON.stringify(x)) : undefined,
      limit,
      after,
    },
  })

  const needle = q.filters?.nameContains?.trim().toLowerCase() || null
  const rows: ReportRow[] = []
  for (const raw of res.data ?? []) {
    const row = toReportRow(raw, q.level as Exclude<ReportLevel, "keyword">, agg, tz, daily, preset === "all")
    if (needle) {
      const name = (row.adName ?? row.adGroupName ?? row.campaignName ?? "").toLowerCase()
      if (!name.includes(needle)) continue
    }
    rows.push(row)
  }
  if (needle) warnings.push("Lọc theo tên được thực hiện sau khi tải trang - trang có thể ít dòng hơn limit.")
  if (res.timezone && res.timezone !== tz) warnings.push(`Báo cáo dùng múi giờ ${res.timezone}.`)

  return {
    rows,
    nextCursor: res.has_more && res.last_id ? encodeCursor({ after: res.last_id }) : null,
    currency: ctx.account.currency,
    timezone: res.timezone ?? tz,
    warnings,
  }
}

const MAPPED_KEYS = new Set([
  "impressions",
  "clicks",
  "spend",
  "ctr",
  "cpc",
  "cpm",
  "conversions",
  "cpa",
  "order_created_attributed_sales",
  "order_created_roas",
])

export function toReportRow(
  raw: InsightsRow,
  level: Exclude<ReportLevel, "keyword">,
  agg: AggLevel,
  timezone: string,
  daily: boolean,
  includeExtra: boolean
): ReportRow {
  const row: ReportRow = { level, metrics: normalizeInsightRow(raw, agg) }
  if (daily) {
    const readable = str(pick(raw, agg, "metadata.readable_time"))
    const start = num(raw.start_time)
    row.date = readable?.slice(0, 10) ?? (start !== null ? todayInTz(timezone, new Date(start * 1000)) : undefined)
  }
  const get = (f: string) => str(pick(raw, agg, f))
  if (agg !== "ad_account") {
    row.campaignId = get("campaign.id")
    if (agg === "campaign") row.campaignName = get("campaign.name")
  }
  if (agg === "ad_group" || agg === "ad") row.adGroupId = get("ad_group.id")
  if (agg === "ad_group") row.adGroupName = get("ad_group.name")
  if (agg === "ad") {
    row.adId = get("ad.id")
    row.adName = get("ad.name")
  }
  if (agg !== "ad_account") {
    const status = get(`${agg}.status`)
    row.status = status ? normalizeStatus(status, agg === "ad" ? get("ad.review_status") : null) : null
  }
  if (includeExtra) {
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (!MAPPED_KEYS.has(k)) extra[k] = v
    }
    row.extra = extra
  }
  return row
}
