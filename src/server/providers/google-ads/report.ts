// ads_get_report for Google Ads: GAQL per level, micros → major units, normalized metrics.
import { addDays, assertRange, todayInTz } from "../dates"
import { isProviderError } from "../errors"
import { fromMicros } from "../money"
import { emptyMetrics, type MetricPreset, type NormalizedMetrics, type ReportLevel, type ReportPage, type ReportQuery, type ReportRow } from "../types"
import { field, numField, str, type GoogleAdsRow } from "./client"
import { clientFor, customerIdOf, invalidRequest, type GCtx } from "./context"
import { decodeCursor, slicePage } from "./cursor"
import { idList, likeContains, mapStatus, parseCompositeId, statusCondition, where } from "./gaql"
import { channelCondition, channelInfo, resolveAdNetworkTypes, resolveChannelTypes, type GoogleReportFilters } from "./youtube"

interface LevelSpec {
  from: string
  fields: string[]
  status: string | null
  name: string | null
  /** metrics not available for this resource */
  noVideo?: boolean
  impressionShare?: boolean
  budgetLostShare?: boolean
}

const LEVELS: Record<ReportLevel, LevelSpec> = {
  account: {
    from: "customer",
    fields: ["customer.id", "customer.descriptive_name"],
    status: null,
    name: null,
    impressionShare: true,
  },
  campaign: {
    from: "campaign",
    fields: ["campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.advertising_channel_sub_type"],
    status: "campaign.status",
    name: "campaign.name",
    impressionShare: true,
    budgetLostShare: true,
  },
  ad_group: {
    from: "ad_group",
    fields: ["campaign.id", "campaign.name", "campaign.advertising_channel_type", "ad_group.id", "ad_group.name", "ad_group.status"],
    status: "ad_group.status",
    name: "ad_group.name",
    impressionShare: true,
  },
  ad: {
    from: "ad_group_ad",
    fields: [
      "campaign.id",
      "campaign.name",
      "campaign.advertising_channel_type",
      "ad_group.id",
      "ad_group.name",
      "ad_group_ad.ad.id",
      "ad_group_ad.ad.name",
      "ad_group_ad.ad.type",
      "ad_group_ad.status",
    ],
    status: "ad_group_ad.status",
    name: "ad_group_ad.ad.name",
  },
  keyword: {
    from: "keyword_view",
    fields: [
      "campaign.id",
      "campaign.name",
      "campaign.advertising_channel_type",
      "ad_group.id",
      "ad_group.name",
      "ad_group_criterion.criterion_id",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.keyword.match_type",
      "ad_group_criterion.status",
    ],
    status: "ad_group_criterion.status",
    name: "ad_group_criterion.keyword.text",
    noVideo: true,
    impressionShare: true,
  },
}

const BASIC = ["metrics.impressions", "metrics.clicks", "metrics.ctr", "metrics.average_cpc", "metrics.average_cpm", "metrics.cost_micros"]
const CONVERSION = ["metrics.conversions", "metrics.conversions_value", "metrics.cost_per_conversion"]
const VIDEO = ["metrics.video_trueview_views"]
/**
 * YouTube metrics of the video preset (v25). Their compatibility with every resource is UNVERIFIED: when Google
 * rejects one (queryError naming it), getReport retries once with VIDEO only and warns.
 * trueview_average_cpv is read as micros (UNVERIFIED - cost_per_view = spend / views is returned next to it).
 */
export const VIDEO_EXTENDED = [
  "metrics.video_trueview_view_rate",
  "metrics.trueview_average_cpv",
  "metrics.video_quartile_p25_rate",
  "metrics.video_quartile_p50_rate",
  "metrics.video_quartile_p75_rate",
  "metrics.video_quartile_p100_rate",
  "metrics.video_watch_time_duration_millis",
  "metrics.average_video_watch_time_duration_millis",
  "metrics.engagements",
  "metrics.youtube_likes",
  "metrics.youtube_comments",
  "metrics.youtube_shares",
]

export interface MetricOptions {
  /** drop VIDEO_EXTENDED (fallback after Google rejected one of them) */
  basicVideoOnly?: boolean
}

export function metricFields(level: ReportLevel, preset: MetricPreset, o: MetricOptions = {}): string[] {
  const spec = LEVELS[level]
  const out = [...BASIC]
  if (preset === "conversion" || preset === "all") out.push(...CONVERSION)
  if ((preset === "video" || preset === "all") && !spec.noVideo) {
    out.push(...VIDEO)
    if (!o.basicVideoOnly) out.push(...VIDEO_EXTENDED)
  }
  if (preset === "all") {
    out.push("metrics.all_conversions", "metrics.all_conversions_value", "metrics.interactions")
    if (spec.impressionShare) out.push("metrics.search_impression_share")
    if (spec.budgetLostShare) out.push("metrics.search_budget_lost_impression_share")
  }
  return out
}

export interface BuiltQuery {
  query: string
  warnings: string[]
}

/** Pure GAQL builder (unit-tested). All user values pass through gaql.ts helpers / allow-lists. */
export function buildReportQuery(q: ReportQuery, o: MetricOptions = {}): BuiltQuery {
  const spec = LEVELS[q.level]
  if (!spec) throw invalidRequest(`Unknown level ${q.level}`, `Cấp báo cáo không hợp lệ: ${q.level}.`)
  try {
    assertRange(q.dateRange)
  } catch (e) {
    throw invalidRequest((e as Error).message, (e as Error).message)
  }
  const warnings: string[] = []
  const f: GoogleReportFilters = q.filters ?? {}
  const channels = resolveChannelTypes(f.channelTypes)
  const networks = resolveAdNetworkTypes(f.adNetworkTypes)
  if (channels && q.level === "account") {
    throw invalidRequest(
      "Channel filter at account level",
      "Bộ lọc loại chiến dịch (YouTube/Video/Search…) không dùng được ở cấp account - hãy dùng level=campaign (granularity=total để có tổng)."
    )
  }
  const select = [...spec.fields]
  if (q.granularity === "day") select.push("segments.date")
  if (networks) select.push("segments.ad_network_type")
  select.push(...metricFields(q.level, q.metrics, o))

  const conds: (string | null)[] = [`segments.date BETWEEN '${q.dateRange.from}' AND '${q.dateRange.to}'`]
  conds.push(channelCondition(channels))
  if (networks) conds.push(`segments.ad_network_type IN (${networks.map((n) => `'${n}'`).join(", ")})`)
  if (f.campaignIds?.length) {
    if (q.level === "account") warnings.push("Bộ lọc campaign không áp dụng cho cấp account.")
    else conds.push(`campaign.id IN ${idList(f.campaignIds, "campaign_id")}`)
  }
  if (f.adGroupIds?.length) {
    if (q.level === "ad" || q.level === "keyword" || q.level === "ad_group") conds.push(`ad_group.id IN ${idList(f.adGroupIds, "ad_group_id")}`)
    else warnings.push("Bộ lọc ad_group chỉ áp dụng cho cấp ad_group/ad/keyword.")
  }
  if (f.adIds?.length) {
    if (q.level === "ad") conds.push(`ad_group_ad.ad.id IN ${idList(f.adIds.map((id) => parseCompositeId(id, "ad_id").id), "ad_id")}`)
    else warnings.push("Bộ lọc ad chỉ áp dụng cho cấp ad.")
  }
  if (spec.status) {
    conds.push(statusCondition(spec.status, f.statuses, f.includeDeleted))
    if (!f.statuses?.length && !f.includeDeleted) {
      warnings.push(
        "Mặc định không gồm đối tượng đã xoá (REMOVED) - tổng chi tiêu có thể thấp hơn báo cáo cấp tài khoản (bật includeDeleted để lấy đủ)."
      )
    }
  }
  if (f.nameContains) {
    if (spec.name) conds.push(likeContains(spec.name, f.nameContains))
    else warnings.push("Bộ lọc tên không áp dụng cho cấp account.")
  }
  const order = q.granularity === "day" ? " ORDER BY segments.date" : ""
  return { query: `SELECT ${select.join(", ")} FROM ${spec.from}${where(conds)}${order}`, warnings }
}

const micro = (row: GoogleAdsRow, path: string, dflt: number | null = 0): number | null => {
  const v = field(row, path)
  if (v === undefined || v === null || v === "") return dflt
  return fromMicros(typeof v === "number" ? v : String(v))
}

/** Normalize one GAQL row's metrics. Absent selected metrics → 0; not applicable/not selected → null. */
export function normalizeMetrics(row: GoogleAdsRow, level: ReportLevel, preset: MetricPreset): NormalizedMetrics {
  const m = emptyMetrics()
  const selected = new Set(metricFields(level, preset))
  const spend = micro(row, "metrics.cost_micros") ?? 0
  const clicks = numField(row, "metrics.clicks") ?? 0
  m.spend = spend
  m.impressions = numField(row, "metrics.impressions")
  m.clicks = clicks
  m.link_clicks = clicks
  const ctr = numField(row, "metrics.ctr")
  m.ctr = ctr === null ? null : ctr * 100
  m.cpc = micro(row, "metrics.average_cpc")
  m.cpm = micro(row, "metrics.average_cpm")
  if (selected.has("metrics.conversions")) {
    m.conversions = numField(row, "metrics.conversions")
    m.conversion_value = numField(row, "metrics.conversions_value")
    m.cpa = micro(row, "metrics.cost_per_conversion")
    m.roas = spend > 0 ? (m.conversion_value ?? 0) / spend : null
  }
  if (selected.has("metrics.video_trueview_views")) m.video_views = numField(row, "metrics.video_trueview_views")
  return m
}

const pct = (row: GoogleAdsRow, path: string): number | null => {
  const v = numField(row, path, null)
  return v === null ? null : v * 100
}

/** Channels whose rows can carry video metrics (others report them as null - "missing metric → null", not 0). */
const VIDEO_METRIC_CHANNELS = new Set(["VIDEO", "DEMAND_GEN", "PERFORMANCE_MAX"])

/** false when the row's campaign channel is known and cannot have video metrics (Search, Shopping, Display…). */
export function videoMetricsApply(channel: string | null | undefined): boolean {
  return !channel || VIDEO_METRIC_CHANNELS.has(channel)
}

const VIDEO_ONLY_EXTRAS = [
  "video_view_rate_pct",
  "average_cpv",
  "cost_per_view",
  "video_quartile_p25_pct",
  "video_quartile_p50_pct",
  "video_quartile_p75_pct",
  "video_quartile_p100_pct",
  "video_watch_time_ms",
  "average_video_watch_time_ms",
  "youtube_likes",
  "youtube_comments",
  "youtube_shares",
] as const

/**
 * YouTube/video extras (rates as %, money in MAJOR units). Only the metrics that were selected. `notApplicable`
 * (campaign channel without video): every video-only metric is null instead of Google's default 0.
 */
export function videoExtras(row: GoogleAdsRow, selected: Set<string>, spend: number | null, notApplicable = false): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!selected.has("metrics.video_trueview_view_rate")) return out
  if (notApplicable) {
    for (const k of VIDEO_ONLY_EXTRAS) out[k] = null
    out.engagements = numField(row, "metrics.engagements")
    return out
  }
  const views = numField(row, "metrics.video_trueview_views")
  out.video_view_rate_pct = pct(row, "metrics.video_trueview_view_rate")
  out.average_cpv = micro(row, "metrics.trueview_average_cpv", null)
  out.cost_per_view = views && spend !== null ? spend / views : null
  out.video_quartile_p25_pct = pct(row, "metrics.video_quartile_p25_rate")
  out.video_quartile_p50_pct = pct(row, "metrics.video_quartile_p50_rate")
  out.video_quartile_p75_pct = pct(row, "metrics.video_quartile_p75_rate")
  out.video_quartile_p100_pct = pct(row, "metrics.video_quartile_p100_rate")
  out.video_watch_time_ms = numField(row, "metrics.video_watch_time_duration_millis")
  out.average_video_watch_time_ms = numField(row, "metrics.average_video_watch_time_duration_millis", null)
  out.engagements = numField(row, "metrics.engagements")
  out.youtube_likes = numField(row, "metrics.youtube_likes")
  out.youtube_comments = numField(row, "metrics.youtube_comments")
  out.youtube_shares = numField(row, "metrics.youtube_shares")
  return out
}

export function rowToReport(row: GoogleAdsRow, q: ReportQuery, o: MetricOptions = {}): ReportRow {
  const level = q.level
  const out: ReportRow = {
    level,
    metrics: normalizeMetrics(row, level, q.metrics),
  }
  const selected = new Set(metricFields(level, q.metrics, o))
  if (q.granularity === "day") out.date = str(row, "segments.date") ?? undefined
  if (level !== "account") {
    out.campaignId = str(row, "campaign.id")
    out.campaignName = str(row, "campaign.name")
  }
  if (level === "ad_group" || level === "ad" || level === "keyword") {
    out.adGroupId = str(row, "ad_group.id")
    out.adGroupName = str(row, "ad_group.name")
  }
  const extra: Record<string, unknown> = {}
  if (level !== "account") {
    const ch = channelInfo(row)
    extra.advertising_channel_type = ch.advertising_channel_type
    if (level === "campaign") extra.advertising_channel_sub_type = ch.advertising_channel_sub_type
    extra.youtube = ch.youtube
  }
  const network = str(row, "segments.ad_network_type")
  if (network) extra.ad_network_type = network
  // video metrics of a campaign that cannot run video (Search…) are "not available" → null, not 0
  const noVideo = level !== "account" && !videoMetricsApply(str(row, "campaign.advertising_channel_type"))
  if (noVideo) out.metrics.video_views = null
  Object.assign(extra, videoExtras(row, selected, out.metrics.spend, noVideo))
  switch (level) {
    case "account":
      extra.customerId = str(row, "customer.id")
      extra.customerName = str(row, "customer.descriptive_name")
      break
    case "campaign":
      out.status = mapStatus(str(row, "campaign.status"))
      extra.status_raw = str(row, "campaign.status")
      break
    case "ad_group":
      out.status = mapStatus(str(row, "ad_group.status"))
      extra.status_raw = str(row, "ad_group.status")
      break
    case "ad": {
      const ag = str(row, "ad_group.id")
      const ad = str(row, "ad_group_ad.ad.id")
      out.adId = ag && ad ? `${ag}~${ad}` : ad
      out.adName = str(row, "ad_group_ad.ad.name") || (ad ? `Ad ${ad}` : null)
      out.status = mapStatus(str(row, "ad_group_ad.status"))
      extra.status_raw = str(row, "ad_group_ad.status")
      extra.ad_type = str(row, "ad_group_ad.ad.type")
      break
    }
    case "keyword": {
      const ag = str(row, "ad_group.id")
      const crit = str(row, "ad_group_criterion.criterion_id")
      out.keyword = str(row, "ad_group_criterion.keyword.text")
      out.status = mapStatus(str(row, "ad_group_criterion.status"))
      extra.keyword_id = ag && crit ? `${ag}~${crit}` : crit
      extra.match_type = str(row, "ad_group_criterion.keyword.match_type")
      extra.status_raw = str(row, "ad_group_criterion.status")
      break
    }
  }
  if (q.metrics === "all") {
    extra.all_conversions = numField(row, "metrics.all_conversions")
    extra.all_conversions_value = numField(row, "metrics.all_conversions_value")
    extra.interactions = numField(row, "metrics.interactions")
    if (LEVELS[level].impressionShare) extra.search_impression_share = numField(row, "metrics.search_impression_share", null)
    if (LEVELS[level].budgetLostShare) extra.search_budget_lost_impression_share = numField(row, "metrics.search_budget_lost_impression_share", null)
  }
  if (Object.keys(extra).length) out.extra = extra
  return out
}

/** Vietnamese data-freshness warnings. */
export function freshnessWarnings(q: ReportQuery, timezone: string, now = new Date()): string[] {
  const w: string[] = []
  const today = todayInTz(timezone, now)
  if (q.metrics !== "basic" && q.dateRange.to >= addDays(today, -3)) {
    w.push(
      `Số chuyển đổi của các ngày gần đây (từ ${addDays(today, -3)}) có thể còn thay đổi vài ngày do Google ghi nhận chuyển đổi trễ - nên kéo lại sau.`
    )
  }
  if (q.dateRange.to >= today) w.push("Dữ liệu hôm nay chưa chốt (Google cập nhật chậm vài giờ).")
  const limit = new Date(`${today}T00:00:00Z`)
  limit.setUTCMonth(limit.getUTCMonth() - 37)
  if (q.dateRange.from < limit.toISOString().slice(0, 10)) {
    w.push("Google Ads chỉ giữ dữ liệu theo ngày trong 37 tháng gần nhất; phần cũ hơn sẽ trống.")
  }
  return w
}

/** Google rejected one of the extended video metrics (queryError naming it) → retry with VIDEO only. */
export function rejectsExtendedVideo(e: unknown): boolean {
  if (!isProviderError(e) || e.code !== "invalid_request") return false
  const codes = `${String(e.upstream?.code ?? "")},${String(e.upstream?.subcode ?? "")}`
  if (!/queryError\.|requestError\.UNRECOGNIZED_FIELD|UNRECOGNIZED_FIELD/.test(codes)) return false
  const text = `${e.upstream?.message ?? ""} ${e.message}`
  return VIDEO_EXTENDED.some((m) => text.includes(m.slice("metrics.".length)))
}

const VIDEO_FALLBACK_WARNING =
  "Google không trả một số chỉ số YouTube mở rộng (tỉ lệ xem, quartile, thời gian xem, lượt thích…) cho cấp/tài khoản này - chỉ còn lượt xem video."

function cursorFits(cursor: string | null | undefined, query: string): boolean {
  if (!cursor) return false
  try {
    decodeCursor(cursor, query)
    return true
  } catch {
    return false
  }
}

export async function getReport(ctx: GCtx, q: ReportQuery): Promise<ReportPage> {
  const cid = customerIdOf(ctx)
  const full = buildReportQuery(q)
  const reduced = q.metrics === "video" || q.metrics === "all" ? buildReportQuery(q, { basicVideoOnly: true }) : null
  // a cursor issued after the video fallback is bound to the reduced query
  let opts: MetricOptions = reduced && reduced.query !== full.query && cursorFits(q.cursor, reduced.query) ? { basicVideoOnly: true } : {}
  let built = opts.basicVideoOnly ? reduced! : full
  const warnings: string[] = opts.basicVideoOnly ? [VIDEO_FALLBACK_WARNING] : []
  const limit = Math.max(1, Math.min(q.limit || 50, 1_000))
  const cur = decodeCursor(q.cursor, built.query)
  const client = clientFor(ctx)
  let page
  try {
    page = await client.search(cid, built.query, cur.pt)
  } catch (e) {
    if (!reduced || opts.basicVideoOnly || reduced.query === full.query || cur.pt !== null || !rejectsExtendedVideo(e)) throw e
    opts = { basicVideoOnly: true }
    built = reduced
    warnings.push(VIDEO_FALLBACK_WARNING)
    page = await client.search(cid, built.query, null)
  }
  const { items, nextCursor } = slicePage(page.results, cur, page.nextPageToken, limit, built.query)
  return {
    rows: items.map((r) => rowToReport(r, q, opts)),
    nextCursor,
    currency: ctx.account.currency,
    timezone: ctx.account.timezone,
    warnings: [...built.warnings, ...warnings, ...(cur.pt === null && cur.off === 0 ? freshnessWarnings(q, ctx.account.timezone) : [])],
  }
}
