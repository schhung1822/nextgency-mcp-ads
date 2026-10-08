// Reporting via the synchronous /report/integrated/get/ (BASIC, AUCTION_*).
// - daily granularity: ranges split into ≤30-day windows (TikTok limit) and merged; ≤365 days for totals
// - page_size ≤1000; opaque cursor spans windows + pages (+ offset inside a page)
// - filtering is an ARRAY with JSON-string filter_value; deleted objects only with includeDeleted (STATUS_ALL)
// - every metric comes back as a string → numbers here; money already in MAJOR units
// Spec: .claude/docs/providers/tiktok.md §3, 04-mcp-design.md (normalized metric table).
import { createHash } from "node:crypto"
import { assertRange, daysBetweenInclusive, splitRange } from "../dates"
import { ProviderError } from "../errors"
import { num } from "../money"
import {
  emptyMetrics,
  type DateRange,
  type MetricPreset,
  type NormalizedMetrics,
  type NormalizedStatus,
  type ProviderContext,
  type ReportLevel,
  type ReportPage,
  type ReportQuery,
  type ReportRow,
} from "../types"
import { invalid, str, ttFromCtx, ttGet, type Raw, type TT } from "./api"
import type { TikTokCredentials } from "./credentials"

export const DAILY_WINDOW_DAYS = 30
export const TOTAL_MAX_DAYS = 365
const MAX_PAGE_SIZE = 1000
const MAX_FILTER_IDS = 100

const LEVELS: Record<
  Exclude<ReportLevel, "keyword">,
  { dataLevel: string; idDim: string; attrs: string[]; statusField: string | null }
> = {
  account: { dataLevel: "AUCTION_ADVERTISER", idDim: "advertiser_id", attrs: [], statusField: null },
  campaign: { dataLevel: "AUCTION_CAMPAIGN", idDim: "campaign_id", attrs: ["campaign_name"], statusField: "campaign_status" },
  ad_group: {
    dataLevel: "AUCTION_ADGROUP",
    idDim: "adgroup_id",
    attrs: ["campaign_id", "campaign_name", "adgroup_name"],
    statusField: "adgroup_status",
  },
  ad: {
    dataLevel: "AUCTION_AD",
    idDim: "ad_id",
    attrs: ["campaign_id", "campaign_name", "adgroup_id", "adgroup_name", "ad_name"],
    statusField: "ad_status",
  },
}

export const BASIC_METRICS = ["spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpc", "cpm"]
export const CONVERSION_METRICS = [
  "conversion",
  "cost_per_conversion",
  "complete_payment",
  "total_complete_payment_rate", // = purchase VALUE (website), not a rate
  "complete_payment_roas",
  "form",
  "onsite_form",
  "messaging_total_conversation_tiktok_direct_message",
]
export const VIDEO_METRICS = [
  "video_play_actions",
  "video_watched_2s",
  "video_watched_6s",
  "video_views_p25",
  "video_views_p50",
  "video_views_p75",
  "video_views_p100",
  "average_video_play",
]
export const EXTRA_METRICS = [
  "result",
  "cost_per_result",
  "conversion_rate",
  "cost_per_1000_reached",
  "engagements",
  "likes",
  "comments",
  "shares",
  "follows",
  "profile_visits",
  "cost_per_complete_payment",
  "value_per_complete_payment",
  "initiate_checkout",
  "web_event_add_to_cart",
  "on_web_order",
  "user_registration",
  "total_landing_page_view",
  "onsite_total_purchase",
  "total_onsite_shopping_value",
]

/**
 * Metrics whose names are not confirmed on the official metric pages. Empty since 2026-10-08: onsite_form,
 * messaging_total_conversation_tiktok_direct_message, total_onsite_shopping_value and onsite_shopping_roas are
 * all documented (providers/tiktok.md §3).
 */
export const UNCONFIRMED_METRICS = new Set<string>()

const BASIC_SET = new Set(BASIC_METRICS)

/**
 * Safety net: non-basic metrics named (whole word) by a TikTok 40002 error - e.g. a metric not available for
 * this account. The report drops them, retries once and warns instead of failing. Empty for any other error.
 */
export function rejectedUnconfirmedMetrics(e: unknown, metricNames: string[]): string[] {
  if (!(e instanceof ProviderError) || e.code !== "invalid_request") return []
  if (Number(e.upstream?.code) !== 40002) return []
  const msg = String(e.upstream?.message ?? e.message ?? "")
  return metricNames.filter((m) => !BASIC_SET.has(m) && new RegExp(`(^|[^A-Za-z0-9_])${m}($|[^A-Za-z0-9_])`).test(msg))
}

export function metricsForPreset(preset: MetricPreset): string[] {
  switch (preset) {
    case "basic":
      return [...BASIC_METRICS]
    case "conversion":
      return [...BASIC_METRICS, ...CONVERSION_METRICS]
    case "video":
      return [...BASIC_METRICS, ...VIDEO_METRICS]
    case "all":
      return [...BASIC_METRICS, ...CONVERSION_METRICS, ...VIDEO_METRICS, ...EXTRA_METRICS]
  }
}

function sumOrNull(...vals: (number | null)[]): number | null {
  const present = vals.filter((v): v is number => v !== null)
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

/** TikTok metric strings → normalized metrics (04-mcp-design.md table). Keys not requested stay null. */
export function normalizeTikTokMetrics(m: Raw, requested: Set<string>): NormalizedMetrics {
  const out = emptyMetrics()
  const get = (k: string) => (requested.has(k) ? num(m[k]) : null)
  out.spend = get("spend")
  out.impressions = get("impressions")
  out.reach = get("reach")
  out.frequency = get("frequency")
  out.clicks = get("clicks")
  out.link_clicks = get("clicks") // TikTok `clicks` are destination clicks
  out.ctr = get("ctr") // already a percentage
  out.cpc = get("cpc")
  out.cpm = get("cpm")
  out.conversions = get("conversion")
  out.conversion_value = get("total_complete_payment_rate")
  out.cpa = get("cost_per_conversion")
  out.roas = get("complete_payment_roas")
  out.purchases = get("complete_payment")
  out.leads = requested.has("form") || requested.has("onsite_form") ? sumOrNull(get("form"), get("onsite_form")) : null
  out.messages = get("messaging_total_conversation_tiktok_direct_message")
  out.video_views = get("video_play_actions")
  return out
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

interface Cursor {
  /** window index */
  w: number
  /** 1-based page within the window */
  p: number
  /** rows of that page already returned */
  o: number
  /** fingerprint of the query (cursor only valid for the same query) */
  f: string
}

function fingerprint(q: ReportQuery): string {
  const basis = JSON.stringify([q.level, q.dateRange, q.granularity, q.metrics, q.filters ?? null, q.limit])
  return createHash("sha256").update(basis).digest("hex").slice(0, 16)
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url")
}

function decodeCursor(s: string, f: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor
    if (
      c.f === f &&
      Number.isInteger(c.w) &&
      Number.isInteger(c.p) &&
      Number.isInteger(c.o) &&
      c.w >= 0 &&
      c.p >= 1 &&
      c.o >= 0
    ) {
      return c
    }
  } catch {
    // fall through
  }
  throw invalid("Cursor không hợp lệ hoặc không khớp với truy vấn hiện tại.", "Gọi lại ads_get_report không kèm cursor.")
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

interface Filter {
  field_name: string
  filter_type: "IN"
  filter_value: string
}

const STATUS_TO_PRIMARY: Partial<Record<NormalizedStatus, string>> = {
  active: "STATUS_DELIVERY_OK",
  paused: "STATUS_DISABLE",
  deleted: "STATUS_DELETE",
}

export function buildReportFilters(q: ReportQuery, warnings: string[]): Filter[] {
  const lv = levelConf(q.level)
  const f = q.filters ?? {}
  const filters: Filter[] = []
  const idFilter = (field: string, ids: string[] | undefined, allowed: boolean, label: string) => {
    if (!ids?.length) return
    if (!allowed) {
      warnings.push(`Bộ lọc ${label} không áp dụng được ở cấp báo cáo này nên đã bỏ qua.`)
      return
    }
    if (ids.length > MAX_FILTER_IDS) throw invalid(`Tối đa ${MAX_FILTER_IDS} id cho mỗi bộ lọc ${label}.`)
    filters.push({ field_name: field, filter_type: "IN", filter_value: JSON.stringify(ids.map(String)) })
  }
  idFilter("campaign_ids", f.campaignIds, q.level !== "account", "campaign")
  idFilter("adgroup_ids", f.adGroupIds, q.level === "ad_group" || q.level === "ad", "ad group")
  idFilter("ad_ids", f.adIds, q.level === "ad", "ad")
  if (q.level === "ad" && (f.campaignIds?.length ?? 0) > 30) {
    throw invalid("Ở cấp quảng cáo, TikTok chỉ cho lọc tối đa 30 chiến dịch mỗi lần.")
  }
  if (lv.statusField) {
    let primary: string[] | null = null
    if (f.includeDeleted) {
      primary = ["STATUS_ALL"]
    } else if (f.statuses?.length) {
      const mapped = f.statuses.map((s) => STATUS_TO_PRIMARY[s]).filter((s): s is string => !!s)
      if (mapped.length < f.statuses.length) {
        warnings.push("Một số trạng thái lọc không hỗ trợ trong báo cáo TikTok (chỉ active/paused/deleted) nên đã bỏ qua.")
      }
      if (mapped.length) primary = [...new Set(mapped)]
    }
    if (primary) filters.push({ field_name: lv.statusField, filter_type: "IN", filter_value: JSON.stringify(primary) })
  } else if (f.statuses?.length) {
    warnings.push("Báo cáo cấp tài khoản không lọc theo trạng thái.")
  }
  return filters
}

function levelConf(level: ReportLevel) {
  if (level === "keyword") {
    throw new ProviderError({
      platform: "tiktok",
      code: "unsupported",
      message: "TikTok has no keyword level report",
      userMessageVi: "TikTok không có báo cáo cấp từ khoá.",
    })
  }
  return LEVELS[level]
}

export function reportWindows(q: ReportQuery): DateRange[] {
  let range: DateRange
  try {
    range = assertRange(q.dateRange)
  } catch (e) {
    if (e instanceof RangeError) throw invalid(e.message, "Dùng ngày dạng YYYY-MM-DD, from ≤ to.")
    throw e
  }
  if (q.granularity === "day") return splitRange(range, DAILY_WINDOW_DAYS)
  if (daysBetweenInclusive(range) > TOTAL_MAX_DAYS) {
    throw invalid(
      `Báo cáo tổng (granularity=total) của TikTok tối đa ${TOTAL_MAX_DAYS} ngày.`,
      "Thu hẹp khoảng ngày hoặc dùng granularity=day."
    )
  }
  return [range]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function toRow(item: Raw, q: ReportQuery, requested: Set<string>, includeExtra: boolean, tt: TT): ReportRow {
  const lv = levelConf(q.level)
  const dims = (item.dimensions as Raw | undefined) ?? {}
  const m = (item.metrics as Raw | undefined) ?? {}
  const row: ReportRow = { level: q.level, metrics: normalizeTikTokMetrics(m, requested) }
  if (q.granularity === "day") {
    const d = str(dims.stat_time_day)
    row.date = d ? d.slice(0, 10) : undefined
  }
  const id = str(dims[lv.idDim])
  if (q.level === "campaign") {
    row.campaignId = id
    row.campaignName = str(m.campaign_name)
  } else if (q.level === "ad_group") {
    row.campaignId = str(m.campaign_id)
    row.campaignName = str(m.campaign_name)
    row.adGroupId = id
    row.adGroupName = str(m.adgroup_name)
  } else if (q.level === "ad") {
    row.campaignId = str(m.campaign_id)
    row.campaignName = str(m.campaign_name)
    row.adGroupId = str(m.adgroup_id)
    row.adGroupName = str(m.adgroup_name)
    row.adId = id
    row.adName = str(m.ad_name)
  }
  if (includeExtra) {
    const extra: Raw = {}
    for (const k of requested) {
      if (k in m) extra[k] = num(m[k]) ?? m[k]
    }
    if (q.level === "account") extra.advertiser_id = id ?? tt.advertiserId
    row.extra = extra
  }
  return row
}

function rowName(r: ReportRow): string {
  return (r.adName ?? r.adGroupName ?? r.campaignName ?? "").toLowerCase()
}

export async function getTikTokReport(ctx: ProviderContext<TikTokCredentials>, q: ReportQuery): Promise<ReportPage> {
  const tt = ttFromCtx(ctx)
  const lv = levelConf(q.level)
  const warnings: string[] = []
  const windows = reportWindows(q)
  const filters = buildReportFilters(q, warnings)
  let metricNames = metricsForPreset(q.metrics)
  const requested = new Set(metricNames)
  let droppedRetry = false
  const limit = Math.max(1, Math.min(q.limit || 50, MAX_PAGE_SIZE))
  const pageSize = limit
  const fp = fingerprint(q)
  let cur: Cursor = q.cursor ? decodeCursor(q.cursor, fp) : { w: 0, p: 1, o: 0, f: fp }
  const nameNeedle = q.filters?.nameContains?.trim().toLowerCase() || null
  if (nameNeedle && q.level === "account") warnings.push("Bộ lọc tên không áp dụng cho báo cáo cấp tài khoản.")

  const rows: ReportRow[] = []
  let nextCursor: string | null = null
  let throttled = false
  let calls = 0
  const MAX_CALLS = 20

  while (cur.w < windows.length) {
    const win = windows[cur.w]!
    const query: Record<string, unknown> = {
      advertiser_id: tt.advertiserId,
      report_type: "BASIC",
      service_type: "AUCTION",
      data_level: lv.dataLevel,
      dimensions: q.granularity === "day" ? [lv.idDim, "stat_time_day"] : [lv.idDim],
      metrics: [...lv.attrs, ...metricNames],
      start_date: win.from,
      end_date: win.to,
      page: cur.p,
      page_size: pageSize,
    }
    if (filters.length) query.filtering = filters
    type ReportData = { list?: Raw[]; page_info?: { total_page?: number; page?: number } }
    let res: Awaited<ReturnType<typeof ttGet<ReportData>>>
    try {
      res = await ttGet<ReportData>(tt, "report/integrated/get", query)
    } catch (e) {
      const bad = droppedRetry ? [] : rejectedUnconfirmedMetrics(e, metricNames)
      if (!bad.length) throw e
      // drop the rejected (unconfirmed) metrics and retry exactly once
      droppedRetry = true
      metricNames = metricNames.filter((m) => !bad.includes(m))
      for (const m of bad) requested.delete(m)
      warnings.push(
        `TikTok không nhận chỉ số ${bad.join(", ")} cho tài khoản này - đã bỏ chỉ số đó (các cột liên quan như tin nhắn/khách hàng tiềm năng có thể trống).`
      )
      res = await ttGet<ReportData>(tt, "report/integrated/get", { ...query, metrics: [...lv.attrs, ...metricNames] })
    }
    calls++
    if (res.headers.get("x-tt-ads-throttle")) throttled = true
    const list = res.data.list ?? []
    const totalPage = Number(res.data.page_info?.total_page ?? 0)
    let i = cur.o
    for (; i < list.length; i++) {
      const row = toRow(list[i]!, q, requested, q.metrics === "all", tt)
      if (nameNeedle && q.level !== "account" && !rowName(row).includes(nameNeedle)) continue
      rows.push(row)
      if (rows.length >= limit) {
        i++
        break
      }
    }
    // advance the cursor past what was consumed
    if (i < list.length) {
      cur = { ...cur, o: i }
    } else if (cur.p < totalPage) {
      cur = { ...cur, p: cur.p + 1, o: 0 }
    } else {
      cur = { ...cur, w: cur.w + 1, p: 1, o: 0 }
    }
    if (rows.length >= limit || calls >= MAX_CALLS) {
      nextCursor = cur.w < windows.length ? encodeCursor(cur) : null
      break
    }
  }

  if (windows.length > 1) {
    warnings.push(`Khoảng ngày được chia thành ${windows.length} đoạn ≤${DAILY_WINDOW_DAYS} ngày (giới hạn của TikTok) rồi ghép lại.`)
  }
  if (throttled) {
    warnings.push(
      "TikTok chỉ tính 20.000 quảng cáo tạo gần nhất của tài khoản (header X-Tt-Ads-Throttle) - số liệu có thể thiếu; hãy lọc theo campaign/ad group."
    )
  }
  if (nameNeedle && q.level !== "account") {
    warnings.push("Lọc theo tên được thực hiện sau khi lấy dữ liệu nên mỗi trang có thể ít dòng hơn giới hạn.")
  }
  if (!q.filters?.includeDeleted && q.level !== "account") {
    warnings.push("Mặc định không gồm đối tượng đã xoá - tổng chi tiêu có thể thấp hơn cấp tài khoản (bật includeDeleted để lấy đủ).")
  }
  latencyWarning(q.dateRange, tt.timezone, warnings)
  return { rows, nextCursor, currency: tt.currency, timezone: tt.timezone, warnings }
}

/** TikTok data latency: near-real-time metrics may lag 2 h or more, reach/frequency ~16 h; previous day final after 12:00 UTC. */
export function latencyWarning(range: DateRange, timezone: string, warnings: string[], now: Date = new Date()): void {
  const todayLocal = localDate(timezone, now)
  const yesterdayLocal = localDate(timezone, new Date(now.getTime() - 86_400_000))
  if (range.to >= todayLocal) {
    warnings.push("Dữ liệu hôm nay chưa chốt (số liệu gần thời gian thực có thể trễ từ 2 giờ trở lên; reach/frequency trễ tới ~16 giờ).")
  } else if (range.to >= yesterdayLocal && now.getUTCHours() < 12) {
    warnings.push("Dữ liệu hôm qua chỉ được TikTok chốt sau 12:00 UTC - số liệu có thể còn thay đổi.")
  }
}

function localDate(timezone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}
