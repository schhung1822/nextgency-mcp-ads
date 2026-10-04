// ads_get_report for Meta: account-level insights with `level`, normalized metrics, opaque cursor,
// automatic switch to async report runs (meta.md §4). Never requests 7d_view/28d_view attribution windows
// (we never send action_attribution_windows → results follow each ad set's attribution like Ads Manager).
import { createHash } from "node:crypto"

import { assertRange, daysBetweenInclusive, todayInTz, addDays } from "../dates"
import { ProviderError, isProviderError } from "../errors"
import { num } from "../money"
import { sleep } from "../rate-limit"
import {
  emptyMetrics,
  type MetricPreset,
  type NormalizedMetrics,
  type ProviderContext,
  type ReportLevel,
  type ReportPage,
  type ReportQuery,
  type ReportRow,
} from "../types"
import { META_TIMINGS, actId, graph, graphPage, type MetaCallContext, type MetaCredentials } from "./client"
import {
  allEffectiveStatuses,
  base64UrlJson,
  callCtx,
  effectiveStatusesFor,
  noMatchingStatus,
  invalid,
  invalidCursor,
  parseBase64UrlJson,
} from "./shared"

type MetaReportLevel = "account" | "campaign" | "adset" | "ad"

function toMetaReportLevel(level: ReportLevel): MetaReportLevel {
  if (level === "keyword") {
    throw new ProviderError({
      platform: "meta",
      code: "unsupported",
      message: "meta: keyword report level not supported",
      userMessageVi: "Meta không có báo cáo cấp từ khoá.",
    })
  }
  return level === "ad_group" ? "adset" : level
}

const ID_FIELDS: Record<MetaReportLevel, string[]> = {
  account: ["account_id", "account_name", "account_currency"],
  campaign: ["account_currency", "campaign_id", "campaign_name"],
  adset: ["account_currency", "campaign_id", "campaign_name", "adset_id", "adset_name"],
  ad: ["account_currency", "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"],
}

const BASIC_FIELDS = ["spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "ctr", "cpc", "cpm"]
const CONVERSION_FIELDS = [
  "actions",
  "action_values",
  "cost_per_action_type",
  "purchase_roas",
  "results",
  "cost_per_result",
]
const VIDEO_FIELDS = [
  "video_play_actions",
  "video_thruplay_watched_actions",
  "cost_per_thruplay",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p95_watched_actions",
  "video_p100_watched_actions",
  "video_avg_time_watched_actions",
]
const ALL_EXTRA_FIELDS = [
  "objective",
  "optimization_goal",
  "attribution_setting",
  "inline_link_click_ctr",
  "outbound_clicks",
  "website_purchase_roas",
  "conversions",
  "conversion_values",
]
const RANKING_FIELDS = ["quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking"]

export function insightFields(level: MetaReportLevel, preset: MetricPreset): string[] {
  const f = [...ID_FIELDS[level], ...BASIC_FIELDS]
  if (preset === "conversion" || preset === "all") f.push(...CONVERSION_FIELDS)
  if (preset === "video" || preset === "all") f.push(...VIDEO_FIELDS)
  if (preset === "all") {
    f.push(...ALL_EXTRA_FIELDS)
    if (level === "ad") f.push(...RANKING_FIELDS)
  }
  return [...new Set(f)]
}

// action_type priority lists (first present wins - omni_* already de-duplicates channels)
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"]
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"]
const MESSAGE_TYPES = ["onsite_conversion.messaging_conversation_started_7d"]

interface ActionStat {
  action_type?: string
  value?: string | number
}

type RawInsight = Record<string, unknown>

function asActions(v: unknown): ActionStat[] | null {
  return Array.isArray(v) ? (v as ActionStat[]) : null
}

function pickAction(list: ActionStat[] | null, types: string[]): number | null {
  if (!list) return null
  for (const t of types) {
    const hit = list.find((a) => a.action_type === t)
    if (hit) return num(hit.value)
  }
  return null
}

function sumActions(list: ActionStat[] | null): number | null {
  if (!list || list.length === 0) return null
  let total = 0
  for (const a of list) total += num(a.value) ?? 0
  return total
}

/** `results` / `cost_per_result`: [{indicator, values:[{value}]}] ([M] shape) → first indicator's first value. */
function resultValue(v: unknown): number | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const first = v[0] as { values?: { value?: unknown }[]; value?: unknown }
  if (Array.isArray(first.values)) {
    if (first.values.length === 0) return null
    return num(first.values[0]?.value)
  }
  return num(first.value)
}

/** Normalize one insights row (money in MAJOR units; ctr already a percentage). */
export function normalizeInsight(raw: RawInsight, fields: string[]): NormalizedMetrics {
  const m = emptyMetrics()
  const has = (f: string) => fields.includes(f)
  const zeroIfRequested = (f: string, v: number | null) => (v !== null ? v : has(f) ? 0 : null)

  m.spend = zeroIfRequested("spend", num(raw.spend))
  m.impressions = zeroIfRequested("impressions", num(raw.impressions))
  m.reach = has("reach") ? num(raw.reach) : null
  m.frequency = has("frequency") ? num(raw.frequency) : null
  m.clicks = zeroIfRequested("clicks", num(raw.clicks))
  m.link_clicks = zeroIfRequested("inline_link_clicks", num(raw.inline_link_clicks))
  m.ctr = has("ctr") ? num(raw.ctr) : null
  m.cpc = has("cpc") ? num(raw.cpc) : null
  m.cpm = has("cpm") ? num(raw.cpm) : null

  if (has("actions")) {
    const actions = asActions(raw.actions)
    const values = asActions(raw.action_values)
    const purchases = pickAction(actions, PURCHASE_TYPES)
    const leads = pickAction(actions, LEAD_TYPES)
    const messages = pickAction(actions, MESSAGE_TYPES)
    m.purchases = purchases ?? 0
    m.leads = leads ?? 0
    m.messages = messages ?? 0

    const results = resultValue(raw.results)
    m.conversions = results ?? purchases ?? leads ?? 0
    m.conversion_value = pickAction(values, PURCHASE_TYPES) ?? 0

    const costPerResult = resultValue(raw.cost_per_result)
    m.cpa = costPerResult ?? (m.conversions > 0 && m.spend !== null ? m.spend / m.conversions : null)

    const roasList = asActions(raw.purchase_roas)
    const roas = pickAction(roasList, PURCHASE_TYPES) ?? (roasList && roasList.length ? num(roasList[0].value) : null)
    m.roas = roas ?? (m.spend && m.spend > 0 ? m.conversion_value / m.spend : null)

    if (!has("video_play_actions")) m.video_views = pickAction(actions, ["video_view"]) ?? 0
  }
  if (has("video_play_actions")) {
    m.video_views = sumActions(asActions(raw.video_play_actions)) ?? 0
  }
  return m
}

const ID_KEYS = new Set([
  "account_id",
  "account_name",
  "account_currency",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "date_start",
  "date_stop",
])

export function toReportRow(raw: RawInsight, q: ReportQuery, fields: string[]): ReportRow {
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : null)
  const row: ReportRow = { level: q.level, metrics: normalizeInsight(raw, fields) }
  if (q.granularity === "day") row.date = str("date_start") ?? undefined
  if (q.level !== "account") {
    row.campaignId = str("campaign_id")
    row.campaignName = str("campaign_name")
  }
  if (q.level === "ad_group" || q.level === "ad") {
    row.adGroupId = str("adset_id")
    row.adGroupName = str("adset_name")
  }
  if (q.level === "ad") {
    row.adId = str("ad_id")
    row.adName = str("ad_name")
  }
  if (q.metrics === "all") row.extra = compactExtra(raw)
  return row
}

const BASIC_KEYS = new Set(BASIC_FIELDS)

/**
 * Every platform-specific value of an "all" report (not ids, not the basic fields already normalised), with
 * `[{action_type, value}]` lists (actions, action_values, cost_per_action_type, video_*_actions…) turned into
 * `{action_type: value}` maps - same data, a fraction of the size, and addressable as `actions.add_to_cart`.
 */
export function compactExtra(raw: RawInsight): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (ID_KEYS.has(k) || BASIC_KEYS.has(k)) continue
    const list = asActions(v)
    if (list && list.length > 0 && list.every((a) => a && typeof a === "object" && typeof a.action_type === "string")) {
      out[k] = Object.fromEntries(list.map((a) => [a.action_type as string, num(a.value) ?? a.value ?? null]))
    } else {
      out[k] = v
    }
  }
  return out
}

interface ReportCursor {
  v: 1
  /** query fingerprint */
  fp: string
  mode: "sync" | "async"
  after?: string | null
  run?: string
}

function fingerprint(ctx: ProviderContext<MetaCredentials>, q: ReportQuery): string {
  const material = JSON.stringify([
    ctx.account.externalId,
    q.level,
    q.dateRange,
    q.granularity,
    q.metrics,
    q.filters ?? null,
  ])
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

export function encodeReportCursor(c: ReportCursor): string {
  return base64UrlJson(c)
}

function decodeReportCursor(s: string, fp: string): ReportCursor {
  const c = parseBase64UrlJson<ReportCursor>(s)
  if (!c || c.v !== 1 || c.fp !== fp || (c.mode !== "sync" && c.mode !== "async")) throw invalidCursor()
  if (c.mode === "async" && (typeof c.run !== "string" || !/^\d+$/.test(c.run))) throw invalidCursor()
  return c
}

export function buildInsightParams(
  q: ReportQuery,
  warnings: string[]
): { params: Record<string, unknown>; fields: string[] } {
  const level = toMetaReportLevel(q.level)
  const fields = insightFields(level, q.metrics)
  const filtering: { field: string; operator: string; value: unknown }[] = []
  const f = q.filters ?? {}
  if (f.campaignIds?.length) filtering.push({ field: "campaign.id", operator: "IN", value: f.campaignIds })
  if (f.adGroupIds?.length) filtering.push({ field: "adset.id", operator: "IN", value: f.adGroupIds })
  if (f.adIds?.length) filtering.push({ field: "ad.id", operator: "IN", value: f.adIds })
  if (level === "account") {
    if (f.statuses?.length || f.nameContains) {
      warnings.push("Bộ lọc trạng thái/tên không áp dụng cho báo cáo cấp tài khoản.")
    }
  } else {
    if (f.statuses?.length) {
      const raw = effectiveStatusesFor(f.statuses, level)
      if (!raw.length) throw noMatchingStatus(level)
      filtering.push({ field: `${level}.effective_status`, operator: "IN", value: raw })
    } else if (f.includeDeleted) {
      filtering.push({ field: `${level}.effective_status`, operator: "IN", value: allEffectiveStatuses(level) })
    } else {
      warnings.push(
        "Mặc định Meta không trả đối tượng đã xoá/lưu trữ (DELETED/ARCHIVED) - tổng chi tiêu có thể thấp hơn báo cáo cấp tài khoản (bật includeDeleted để lấy đủ)."
      )
    }
    if (f.nameContains) filtering.push({ field: `${level}.name`, operator: "CONTAIN", value: f.nameContains })
  }
  const params: Record<string, unknown> = {
    level,
    fields: fields.join(","),
    time_range: { since: q.dateRange.from, until: q.dateRange.to },
    time_increment: q.granularity === "day" ? 1 : "all_days",
  }
  if (filtering.length) params.filtering = filtering
  return { params, fields }
}

/** Heuristic: requests likely to time out synchronously go straight to an async report run. [L] */
export function isHeavyReport(q: ReportQuery): boolean {
  const days = daysBetweenInclusive(q.dateRange)
  if (q.granularity !== "day") return q.level === "ad" && days > 366
  if (q.level === "ad") return days > 31
  if (q.level === "ad_group") return days > 92
  return days > 366
}

function isTooMuchData(e: unknown): boolean {
  if (!isProviderError(e)) return false
  const code = Number(e.upstream?.code)
  const sub = Number(e.upstream?.subcode)
  return code === 1 || (code === 100 && sub === 1487534)
}

interface ReportRunStatus {
  id?: string
  async_status?: string
  async_percent_completion?: number
  error_code?: number
  error_message?: string
  error_user_msg?: string
}

async function startReportRun(call: MetaCallContext, account: string, params: Record<string, unknown>): Promise<string> {
  const res = await graph<{ report_run_id?: string }>(call, {
    method: "POST",
    path: `${account}/insights`,
    params,
    idempotent: false,
  })
  if (!res.report_run_id) {
    throw new ProviderError({
      platform: "meta",
      code: "upstream_error",
      message: "meta: async insights did not return report_run_id",
      userMessageVi: "Meta không tạo được báo cáo bất đồng bộ.",
      retryable: true,
    })
  }
  return res.report_run_id
}

/** Refuse a report run (from a cursor) that does not belong to the context ad account. */
async function assertRunOwned(call: MetaCallContext, runId: string, account: string): Promise<void> {
  const res = await graph<{ account_id?: string | number }>(call, { method: "GET", path: runId, params: { fields: "account_id" }, idempotent: true })
  const owner = String(res.account_id ?? "").replace(/^act_/, "")
  if (!owner || owner !== account.replace(/^act_/, "")) throw invalidCursor()
}

/** Poll a report run until completed (true), or until the wait budget is spent (false). */
async function waitForReportRun(call: MetaCallContext, runId: string): Promise<boolean> {
  const deadline = Date.now() + META_TIMINGS.asyncReportMaxWaitMs
  let interval = META_TIMINGS.pollIntervalMs
  for (;;) {
    const st = await graph<ReportRunStatus>(call, {
      method: "GET",
      path: runId,
      params: { fields: "async_status,async_percent_completion,error_code,error_message,error_user_msg" },
      idempotent: true,
    })
    if (st.async_status === "Job Completed" && (st.async_percent_completion ?? 100) >= 100) return true
    if (st.async_status === "Job Failed" || st.async_status === "Job Skipped") {
      throw new ProviderError({
        platform: "meta",
        code: "upstream_error",
        message: `meta: async report ${runId} ${st.async_status}: ${st.error_message ?? ""}`,
        userMessageVi: `Meta không tạo được báo cáo${st.error_user_msg ? `: ${st.error_user_msg}` : ""}. Hãy thu hẹp khoảng ngày hoặc cấp báo cáo rồi thử lại.`,
        retryable: true,
        upstream: { code: st.error_code ?? null, message: st.error_message ?? null },
      })
    }
    if (Date.now() + interval > deadline) return false
    await sleep(interval, call.signal)
    interval = Math.min(Math.round(interval * 1.5), 10_000)
  }
}

export async function getMetaReport(ctx: ProviderContext<MetaCredentials>, q: ReportQuery): Promise<ReportPage> {
  try {
    assertRange(q.dateRange, 1100)
  } catch (e) {
    throw invalid((e as Error).message)
  }
  const warnings: string[] = []
  const call = callCtx(ctx)
  const account = actId(ctx.account.externalId)
  const { params, fields } = buildInsightParams(q, warnings)
  const limit = Math.min(Math.max(Math.trunc(q.limit) || 50, 1), 500)
  const fp = fingerprint(ctx, q)
  const cursor = q.cursor ? decodeReportCursor(q.cursor, fp) : null

  const today = todayInTz(ctx.account.timezone)
  if (q.dateRange.to >= addDays(today, -1)) {
    warnings.push("Số liệu hôm nay/hôm qua chưa chốt; chuyển đổi có thể còn thay đổi tới 28 ngày.")
  }

  const page = (data: RawInsight[], next: ReportCursor | null): ReportPage => {
    const rows = data.map((r) => toReportRow(r, q, fields))
    const currencies = new Set(data.map((r) => r.account_currency).filter((c): c is string => typeof c === "string"))
    if ([...currencies].some((c) => c.toUpperCase() !== ctx.account.currency.toUpperCase())) {
      warnings.push(`Meta trả tiền tệ ${[...currencies].join(", ")} khác với tiền tệ đã lưu ${ctx.account.currency}.`)
    }
    return {
      rows,
      nextCursor: next ? encodeReportCursor(next) : null,
      currency: ctx.account.currency,
      timezone: ctx.account.timezone,
      warnings,
    }
  }

  const readRun = async (run: string, after: string | null): Promise<ReportPage> => {
    const res = await graphPage<RawInsight>(call, `${run}/insights`, { limit, ...(after ? { after } : {}) }, { insights: true })
    return page(res.data, res.after ? { v: 1, fp, mode: "async", run, after: res.after } : null)
  }

  const pending = (run: string): ReportPage => {
    warnings.push("Meta đang tạo báo cáo lớn (bất đồng bộ). Gọi lại với next_cursor sau ít phút để lấy dữ liệu.")
    return page([], { v: 1, fp, mode: "async", run, after: null })
  }

  const runAsync = async (): Promise<ReportPage> => {
    const run = await startReportRun(call, account, params)
    warnings.push("Báo cáo lớn nên được tạo bất đồng bộ trên Meta.")
    return (await waitForReportRun(call, run)) ? readRun(run, null) : pending(run)
  }

  if (cursor?.mode === "async") {
    // a report run id from a cursor must belong to THIS ad account (defense in depth on top of the
    // signed MCP cursor: never read another account's report through a crafted cursor)
    await assertRunOwned(call, cursor.run!, account)
    if (cursor.after) return readRun(cursor.run!, cursor.after)
    return (await waitForReportRun(call, cursor.run!)) ? readRun(cursor.run!, null) : pending(cursor.run!)
  }

  if (!cursor && isHeavyReport(q)) return runAsync()

  try {
    const res = await graphPage<RawInsight>(
      call,
      `${account}/insights`,
      { ...params, limit, ...(cursor?.after ? { after: cursor.after } : {}) },
      { insights: true }
    )
    return page(res.data, res.after ? { v: 1, fp, mode: "sync", after: res.after } : null)
  } catch (e) {
    if (!cursor && isTooMuchData(e)) return runAsync()
    throw e
  }
}
