// Campaign / ad group / ad reads. Shapes follow the official OpenAPI spec (CampaignItemBody,
// AdGroupItemBody, AdItemBody). Note: ad group and ad responses do NOT include their parent id.
import { unsupported } from "../errors"
import { fromMicros } from "../money"
import { addDays, todayInTz } from "../dates"
import type {
  AdObjectDetail,
  AdObjectSummary,
  Budget,
  ListQuery,
  NormalizedStatus,
  ObjectLevel,
  ObjectPage,
  ProviderContext,
} from "../types"
import { decodeCursor, encodeCursor, listAll, oaRequest, PLATFORM, type OaList } from "./client"
import type { OpenAIAdsCredentials } from "./credentials"

export type Ctx = ProviderContext<OpenAIAdsCredentials>
export type OaLevel = Exclude<ObjectLevel, "keyword">

// ---------------------------------------------------------------------------
// Raw API shapes (subset of the OpenAPI response schemas)
// ---------------------------------------------------------------------------

export interface RawBudget {
  daily_spend_limit_micros?: number
  lifetime_spend_limit_micros?: number
}

export interface RawGeoLocation {
  id: string
  name?: string
  type?: string
  country_code?: string
  region_code?: string | null
}

export interface RawTargeting {
  locations?: { countries?: string[]; include?: RawGeoLocation[] }
  excluded_locations?: { countries?: string[]; include?: RawGeoLocation[] }
  custom_audiences?: { ids: string[] }
  excluded_custom_audiences?: { ids: string[] }
  platforms?: { included?: string[] } | null
}

export interface RawLandingPageConfiguration {
  query_string_template: string | null
}

export interface RawCampaign {
  id: string
  created_at: number
  updated_at: number
  name: string
  description: string | null
  status: string
  mode?: string | null
  product_feed_id: string | null
  business_agent_id?: string | null
  start_time: number | null
  end_time: number | null
  budget: RawBudget
  bidding_type: string
  objective?: string
  billing_event_type?: string
  conversion_event_setting_ids?: string[]
  targeting?: RawTargeting
  landing_page_configuration?: RawLandingPageConfiguration | null
  serving_issues?: { code: string }[]
}

export interface RawBiddingConfig {
  billing_event_type: string
  strategy?: string
  max_bid_micros?: number
  custom_audience_bid_multipliers?: { custom_audience_id: string; bid_multiplier_micros: number }[]
}

export interface RawProductSet {
  product_feed_id: string
  filters: { field: string; operator: string; values: string[] }[]
}

export interface RawAdGroup {
  id: string
  created_at: number
  updated_at: number
  name: string
  description: string | null
  context_hints: string[]
  product_set?: RawProductSet | null
  status: string
  bidding_config: RawBiddingConfig
  landing_page_configuration?: RawLandingPageConfiguration | null
  serving_issues?: { code: string }[]
  /** not in the spec - read defensively in case OpenAI adds it */
  campaign_id?: string
}

export interface RawImageCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface RawCreative {
  type: string
  title: string
  body: string
  price?: string
  file_id?: string
  image_url?: string | null
  image_crop?: RawImageCrop
  target_url: string | null
}

export interface RawAd {
  id: string
  name: string
  created_at: number
  updated_at: number
  creative: RawCreative
  status: string
  review_status: string
  review?: { status: string; reason?: string }
  landing_page_configuration?: RawLandingPageConfiguration | null
  appeal?: { status: string } | null
  serving_issues?: { code: string }[]
  /** not in the spec - read defensively */
  ad_group_id?: string
}

export type RawObject = RawCampaign | RawAdGroup | RawAd

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export const LEVEL_PATH: Record<OaLevel, string> = {
  campaign: "/campaigns",
  ad_group: "/ad_groups",
  ad: "/ads",
}

export function assertOaLevel(level: ObjectLevel): OaLevel {
  if (level === "keyword") throw unsupported(PLATFORM, "keyword (OpenAI Ads không có từ khoá; chủ đề khớp qua context_hints của ad group)")
  return level
}

export function normalizeStatus(status: string | null | undefined, reviewStatus?: string | null): NormalizedStatus {
  const s = (status ?? "").toLowerCase()
  if (s === "archived") return "archived"
  const r = (reviewStatus ?? "").toLowerCase()
  if (r === "rejected") return "rejected"
  if (s === "active" && r === "in_review") return "pending_review"
  if (s === "active") return "active"
  if (s === "paused") return "paused"
  return "unknown"
}

export function unixToIso(v: number | null | undefined): string | null {
  return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null
}

export function budgetFromRaw(b: RawBudget | null | undefined, currency: string): Budget | null {
  if (!b) return null
  if (b.daily_spend_limit_micros !== undefined && b.daily_spend_limit_micros !== null) {
    return { type: "daily", amount: fromMicros(b.daily_spend_limit_micros) ?? 0, currency, level: "campaign" }
  }
  if (b.lifetime_spend_limit_micros !== undefined && b.lifetime_spend_limit_micros !== null) {
    return { type: "lifetime", amount: fromMicros(b.lifetime_spend_limit_micros) ?? 0, currency, level: "campaign" }
  }
  return null
}

export function mapCampaign(raw: RawCampaign, currency: string): AdObjectDetail {
  return {
    id: raw.id,
    level: "campaign",
    name: raw.name,
    status: normalizeStatus(raw.status),
    statusRaw: raw.status,
    campaignId: raw.id,
    parentId: null,
    budget: budgetFromRaw(raw.budget, currency),
    objective: raw.bidding_type ?? raw.objective ?? null,
    startTime: unixToIso(raw.start_time),
    endTime: unixToIso(raw.end_time),
    createdTime: unixToIso(raw.created_at),
    extra: {
      bidding_type: raw.bidding_type,
      mode: raw.mode ?? null,
      serving_issues: (raw.serving_issues ?? []).map((i) => i.code),
    },
    config: {
      description: raw.description,
      bidding_type: raw.bidding_type,
      objective: raw.objective ?? null,
      billing_event_type: raw.billing_event_type ?? null,
      budget: budgetFromRaw(raw.budget, currency),
      conversion_event_setting_ids: raw.conversion_event_setting_ids ?? [],
      targeting: raw.targeting ?? {},
      landing_page_configuration: raw.landing_page_configuration ?? null,
      mode: raw.mode ?? null,
      product_feed_id: raw.product_feed_id ?? null,
      updated_time: unixToIso(raw.updated_at),
    },
  }
}

export function bidFromRaw(bc: RawBiddingConfig | null | undefined): number | null {
  return bc?.max_bid_micros !== undefined && bc?.max_bid_micros !== null ? fromMicros(bc.max_bid_micros) : null
}

export function mapAdGroup(raw: RawAdGroup, currency: string, parentCampaignId: string | null): AdObjectDetail {
  const campaignId = raw.campaign_id ?? parentCampaignId ?? null
  return {
    id: raw.id,
    level: "ad_group",
    name: raw.name,
    status: normalizeStatus(raw.status),
    statusRaw: raw.status,
    campaignId,
    parentId: campaignId,
    budget: null, // budgets live on the campaign
    objective: null,
    startTime: null,
    endTime: null,
    createdTime: unixToIso(raw.created_at),
    extra: {
      strategy: raw.bidding_config?.strategy ?? null,
      billing_event_type: raw.bidding_config?.billing_event_type ?? null,
      max_bid: bidFromRaw(raw.bidding_config),
      currency,
      context_hints_count: raw.context_hints?.length ?? 0,
      serving_issues: (raw.serving_issues ?? []).map((i) => i.code),
    },
    config: {
      description: raw.description,
      context_hints: raw.context_hints ?? [],
      bidding_config: {
        billing_event_type: raw.bidding_config?.billing_event_type ?? null,
        strategy: raw.bidding_config?.strategy ?? null,
        /** MAJOR units, per billing event (per impression for impression billing - not CPM) */
        max_bid: bidFromRaw(raw.bidding_config),
        custom_audience_bid_multipliers: (raw.bidding_config?.custom_audience_bid_multipliers ?? []).map((m) => ({
          custom_audience_id: m.custom_audience_id,
          multiplier: fromMicros(m.bid_multiplier_micros),
        })),
      },
      product_set: raw.product_set ?? null,
      landing_page_configuration: raw.landing_page_configuration ?? null,
      updated_time: unixToIso(raw.updated_at),
    },
  }
}

export function mapAd(raw: RawAd, parentAdGroupId: string | null): AdObjectDetail {
  const adGroupId = raw.ad_group_id ?? parentAdGroupId ?? null
  return {
    id: raw.id,
    level: "ad",
    name: raw.name,
    status: normalizeStatus(raw.status, raw.review_status),
    statusRaw: raw.status,
    campaignId: null,
    parentId: adGroupId,
    budget: null,
    objective: null,
    startTime: null,
    endTime: null,
    createdTime: unixToIso(raw.created_at),
    extra: {
      review_status: raw.review_status,
      review_reason: raw.review?.reason ?? null,
      serving_issues: (raw.serving_issues ?? []).map((i) => i.code),
    },
    config: {
      creative: {
        type: raw.creative?.type,
        title: raw.creative?.title,
        body: raw.creative?.body,
        target_url: raw.creative?.target_url ?? null,
        file_id: raw.creative?.file_id ?? null,
        image_url: raw.creative?.image_url ?? null,
        image_crop: raw.creative?.image_crop ?? null,
        price: raw.creative?.price ?? null,
      },
      review_status: raw.review_status,
      review: raw.review ?? null,
      appeal: raw.appeal ?? null,
      landing_page_configuration: raw.landing_page_configuration ?? null,
      updated_time: unixToIso(raw.updated_at),
    },
  }
}

export function mapRaw(level: OaLevel, raw: RawObject, currency: string, parentId: string | null = null): AdObjectDetail {
  if (level === "campaign") return mapCampaign(raw as RawCampaign, currency)
  if (level === "ad_group") return mapAdGroup(raw as RawAdGroup, currency, parentId)
  return mapAd(raw as RawAd, parentId)
}

export function toSummary(d: AdObjectDetail): AdObjectSummary {
  const { config: _config, children: _children, ...summary } = d
  return summary
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchRaw<T extends RawObject>(ctx: Ctx, level: OaLevel, id: string): Promise<T> {
  return oaRequest<T>(ctx, {
    method: "GET",
    path: `${LEVEL_PATH[level]}/${encodeURIComponent(id)}`,
    query: { include: ["serving_issues"] },
  })
}

const MAX_SCAN_PAGES = 10

export async function listObjects(ctx: Ctx, q: ListQuery): Promise<ObjectPage> {
  const level = assertOaLevel(q.level)
  const limit = Math.min(Math.max(Math.trunc(q.limit) || 50, 1), 500)
  const cur = decodeCursor(q.cursor)
  let after = typeof cur?.after === "string" ? cur.after : null
  const warnings: string[] = []
  const parentId = q.parentId ?? null
  if (level === "campaign" && parentId) warnings.push("Campaign không có đối tượng cha - bỏ qua parentId.")

  const query: Record<string, string | undefined> = {}
  if (level === "ad_group" && parentId) query.campaign_id = parentId
  if (level === "ad" && parentId) query.ad_group_id = parentId

  const statuses = q.statuses?.length ? new Set(q.statuses) : null
  const needle = q.nameContains?.trim().toLowerCase() || null
  const filtering = statuses !== null || needle !== null

  const items: AdObjectSummary[] = []
  let nextAfter: string | null = null
  for (let pageNo = 0; pageNo < MAX_SCAN_PAGES; pageNo++) {
    const page: OaList<RawObject> = await oaRequest<OaList<RawObject>>(ctx, {
      method: "GET",
      path: LEVEL_PATH[level],
      query: { ...query, limit: filtering ? 500 : limit, after: after ?? undefined, include: ["serving_issues"] },
    })
    const data = page.data ?? []
    let stoppedEarly = false
    for (let i = 0; i < data.length; i++) {
      const raw = data[i]!
      const summary = toSummary(mapRaw(level, raw, ctx.account.currency, level === "campaign" ? null : parentId))
      const keep = (!statuses || statuses.has(summary.status)) && (!needle || summary.name.toLowerCase().includes(needle))
      if (keep) items.push(summary)
      if (items.length >= limit) {
        const moreInPage = i < data.length - 1
        if (moreInPage || page.has_more) nextAfter = raw.id
        stoppedEarly = true
        break
      }
    }
    if (stoppedEarly) break
    if (!page.has_more || !page.last_id) {
      nextAfter = null
      break
    }
    after = page.last_id
    nextAfter = page.last_id
    if (pageNo === MAX_SCAN_PAGES - 1) {
      warnings.push("Đã quét 10 trang mà chưa đủ kết quả khớp bộ lọc - dùng nextCursor để quét tiếp.")
    }
  }
  if (filtering) warnings.push("Lọc theo trạng thái/tên được thực hiện phía ứng dụng (OpenAI Ads không hỗ trợ lọc này).")
  return { items, nextCursor: nextAfter ? encodeCursor({ after: nextAfter }) : null, warnings }
}

const MAX_CHILD_AD_GROUPS = 200
const MAX_CHILD_ADS = 1_000

export async function getObject(
  ctx: Ctx,
  levelIn: ObjectLevel,
  id: string,
  opts: { includeChildren?: boolean } = {}
): Promise<AdObjectDetail> {
  const level = assertOaLevel(levelIn)
  const raw = await fetchRaw<RawObject>(ctx, level, id)
  const detail = mapRaw(level, raw, ctx.account.currency)
  if (!opts.includeChildren || level === "ad") return detail

  let truncated = false
  let adBudget = MAX_CHILD_ADS
  const loadAds = async (adGroupId: string): Promise<AdObjectDetail[]> => {
    if (adBudget <= 0) {
      truncated = true
      return []
    }
    const res = await listAll<RawAd>(ctx, "/ads", { ad_group_id: adGroupId }, { maxItems: adBudget })
    adBudget -= res.items.length
    if (res.truncated) truncated = true
    return res.items.map((a) => mapAd(a, adGroupId))
  }

  if (level === "ad_group") {
    detail.children = await loadAds(id)
  } else {
    const groups = await listAll<RawAdGroup>(ctx, "/ad_groups", { campaign_id: id }, { maxItems: MAX_CHILD_AD_GROUPS })
    if (groups.truncated) truncated = true
    const children: AdObjectDetail[] = []
    for (const g of groups.items) {
      const child = mapAdGroup(g, ctx.account.currency, id)
      child.children = await loadAds(g.id)
      children.push(child)
    }
    detail.children = children
  }
  if (truncated) detail.extra = { ...detail.extra, children_truncated: true }
  return detail
}

/**
 * Best-effort lookup of a parent id (ad group → campaign, ad → ad group), which the object endpoints do
 * not return. Uses the insights endpoint with zero-impression rows. Returns null when unknown.
 */
export async function resolveParentId(ctx: Ctx, level: "ad_group" | "ad", id: string): Promise<string | null> {
  const parentField = level === "ad_group" ? "campaign" : "ad_group"
  const today = todayInTz(ctx.account.timezone)
  try {
    const res = await oaRequest<OaList<Record<string, unknown>>>(ctx, {
      method: "GET",
      path: `${LEVEL_PATH[level]}/${encodeURIComponent(id)}/insights`,
      query: {
        aggregation_level: level,
        time_granularity: "none",
        limit: 1,
        includes: ["zero_impression_items"],
        fields: [`${parentField}.id`, `${level}.id`],
        time_ranges: [
          JSON.stringify({ type: "date_range", since: addDays(today, -364), until: today, timezone: ctx.account.timezone }),
        ],
      },
    })
    const row = res.data?.[0]
    const v = row?.[`${parentField}_id`] ?? row?.[`${parentField}.id`]
    return typeof v === "string" && v ? v : null
  } catch {
    return null
  }
}
