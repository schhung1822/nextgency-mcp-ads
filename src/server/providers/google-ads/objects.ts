// ads_list_objects / ads_get_object for Google Ads (campaign, ad_group, ad = ad_group_ad, keyword = ad_group_criterion).
// Ad and keyword ids are exposed as composite "AG~AD" / "AG~CRIT" (as in their resource names) so they can be
// mutated directly; plain ad ids are accepted and resolved.
import { fromMicros } from "../money"
import type { AdObjectDetail, AdObjectSummary, Budget, ListQuery, ObjectLevel, ObjectPage } from "../types"
import { field, str, type GoogleAdsClient, type GoogleAdsRow } from "./client"
import { clientFor, customerIdOf, invalidRequest, notFound, type GCtx } from "./context"
import { decodeCursor, slicePage } from "./cursor"
import { assertId, gaqlString, idList, likeContains, mapStatus, parseCompositeId, statusCondition, where } from "./gaql"
import { accountLocalToIso, isOpenEnded } from "./time"
import { channelCondition, channelInfo, resolveChannelTypes, type GoogleListQuery } from "./youtube"

export const CAMPAIGN_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.serving_status",
  "campaign.primary_status",
  "campaign.advertising_channel_type",
  "campaign.advertising_channel_sub_type",
  "campaign.bidding_strategy_type",
  "campaign.bidding_strategy",
  "campaign.start_date_time",
  "campaign.end_date_time",
  "campaign.contains_eu_political_advertising",
  "campaign_budget.id",
  "campaign_budget.name",
  "campaign_budget.amount_micros",
  "campaign_budget.total_amount_micros",
  "campaign_budget.period",
  "campaign_budget.explicitly_shared",
  "campaign_budget.reference_count",
  "campaign_budget.delivery_method",
]

const CAMPAIGN_DETAIL_FIELDS = [
  ...CAMPAIGN_FIELDS,
  "campaign.missing_eu_political_advertising_declaration",
  "campaign.network_settings.target_google_search",
  "campaign.network_settings.target_search_network",
  "campaign.network_settings.target_content_network",
  "campaign.network_settings.target_partner_search_network",
  "campaign.manual_cpc.enhanced_cpc_enabled",
  "campaign.maximize_conversions.target_cpa_micros",
  "campaign.maximize_conversion_value.target_roas",
  "campaign.target_spend.cpc_bid_ceiling_micros",
  "campaign.target_cpa.target_cpa_micros",
  "campaign.target_roas.target_roas",
  // VIDEO (YouTube) campaigns: where the ads may show (in-stream / in-feed / Shorts)
  "campaign.video_campaign_settings.video_ad_inventory_control.allow_in_stream",
  "campaign.video_campaign_settings.video_ad_inventory_control.allow_in_feed",
  "campaign.video_campaign_settings.video_ad_inventory_control.allow_shorts",
  "campaign.geo_target_type_setting.positive_geo_target_type",
  "campaign.geo_target_type_setting.negative_geo_target_type",
  "campaign.tracking_url_template",
  "campaign.final_url_suffix",
  "campaign.optimization_score",
]

export const AD_GROUP_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.advertising_channel_type",
  "campaign.advertising_channel_sub_type",
  "ad_group.id",
  "ad_group.name",
  "ad_group.status",
  "ad_group.type",
  "ad_group.cpc_bid_micros",
  "ad_group.target_cpa_micros",
  "ad_group.primary_status",
]

export const AD_FIELDS = [
  "campaign.id",
  "campaign.advertising_channel_type",
  "campaign.advertising_channel_sub_type",
  "ad_group.id",
  "ad_group.name",
  "ad_group_ad.ad.id",
  "ad_group_ad.ad.name",
  "ad_group_ad.ad.type",
  "ad_group_ad.ad.final_urls",
  "ad_group_ad.ad.responsive_search_ad.headlines",
  "ad_group_ad.ad.responsive_search_ad.descriptions",
  "ad_group_ad.ad.responsive_search_ad.path1",
  "ad_group_ad.ad.responsive_search_ad.path2",
  "ad_group_ad.status",
  "ad_group_ad.policy_summary.approval_status",
  "ad_group_ad.policy_summary.review_status",
  "ad_group_ad.ad_strength",
]

/** Video ad content (YouTube): only selected for list/detail reads, not for the pre-reads of writes. */
export const AD_VIDEO_FIELDS = [
  "ad_group_ad.ad.video_ad.video.asset",
  "ad_group_ad.ad.video_responsive_ad.videos",
  "ad_group_ad.ad.video_responsive_ad.headlines",
  "ad_group_ad.ad.video_responsive_ad.long_headlines",
  "ad_group_ad.ad.video_responsive_ad.descriptions",
  "ad_group_ad.ad.demand_gen_video_responsive_ad.videos",
  "ad_group_ad.ad.demand_gen_video_responsive_ad.headlines",
  "ad_group_ad.ad.demand_gen_video_responsive_ad.business_name",
]
export const AD_LIST_FIELDS = [...AD_FIELDS, ...AD_VIDEO_FIELDS]

export const KEYWORD_FIELDS = [
  "campaign.id",
  "campaign.advertising_channel_type",
  "ad_group.id",
  "ad_group_criterion.criterion_id",
  "ad_group_criterion.keyword.text",
  "ad_group_criterion.keyword.match_type",
  "ad_group_criterion.status",
  "ad_group_criterion.negative",
  "ad_group_criterion.cpc_bid_micros",
  "ad_group_criterion.approval_status",
  "ad_group_criterion.quality_info.quality_score",
]

interface LevelSpec {
  from: string
  fields: string[]
  idField: string
  status: string
  name: string
  parent: string
  extra?: string
}

const SPECS: Record<ObjectLevel, LevelSpec> = {
  campaign: { from: "campaign", fields: CAMPAIGN_FIELDS, idField: "campaign.id", status: "campaign.status", name: "campaign.name", parent: "" },
  ad_group: { from: "ad_group", fields: AD_GROUP_FIELDS, idField: "ad_group.id", status: "ad_group.status", name: "ad_group.name", parent: "campaign.id" },
  ad: { from: "ad_group_ad", fields: AD_FIELDS, idField: "ad_group_ad.ad.id", status: "ad_group_ad.status", name: "ad_group_ad.ad.name", parent: "ad_group.id" },
  keyword: {
    from: "ad_group_criterion",
    fields: KEYWORD_FIELDS,
    idField: "ad_group_criterion.criterion_id",
    status: "ad_group_criterion.status",
    name: "ad_group_criterion.keyword.text",
    parent: "ad_group.id",
    extra: "ad_group_criterion.type = 'KEYWORD'",
  },
}

const microsToMajor = (row: GoogleAdsRow, path: string): number | null => {
  const v = str(row, path)
  return v === null ? null : fromMicros(v)
}

export function budgetFromRow(row: GoogleAdsRow, currency: string): Budget | null {
  if (!str(row, "campaign_budget.id")) return null
  const lifetime = str(row, "campaign_budget.period") === "CUSTOM_PERIOD"
  const amount = microsToMajor(row, lifetime ? "campaign_budget.total_amount_micros" : "campaign_budget.amount_micros")
  return {
    type: lifetime ? "lifetime" : "daily",
    amount: amount ?? 0,
    currency,
    level: "campaign",
    shared: field(row, "campaign_budget.explicitly_shared") === true,
  }
}

function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String((x as { text?: unknown })?.text ?? "")).filter(Boolean) : []
}

export function summaryFromRow(level: ObjectLevel, row: GoogleAdsRow, ctx: { currency: string; timezone: string }): AdObjectSummary {
  switch (level) {
    case "campaign": {
      const end = str(row, "campaign.end_date_time")
      return {
        id: str(row, "campaign.id")!,
        level,
        name: str(row, "campaign.name") ?? "",
        status: mapStatus(str(row, "campaign.status")),
        statusRaw: str(row, "campaign.status") ?? "UNSPECIFIED",
        campaignId: str(row, "campaign.id"),
        parentId: null,
        budget: budgetFromRow(row, ctx.currency),
        objective: str(row, "campaign.advertising_channel_type"),
        startTime: accountLocalToIso(str(row, "campaign.start_date_time"), ctx.timezone),
        endTime: isOpenEnded(end) ? null : accountLocalToIso(end, ctx.timezone),
        extra: {
          ...channelInfo(row),
          serving_status: str(row, "campaign.serving_status"),
          primary_status: str(row, "campaign.primary_status"),
          bidding_strategy_type: str(row, "campaign.bidding_strategy_type"),
          contains_eu_political_advertising: str(row, "campaign.contains_eu_political_advertising"),
          budget_id: str(row, "campaign_budget.id"),
          budget_explicitly_shared: field(row, "campaign_budget.explicitly_shared") === true,
          budget_reference_count: Number(str(row, "campaign_budget.reference_count") ?? 0),
        },
      }
    }
    case "ad_group":
      return {
        id: str(row, "ad_group.id")!,
        level,
        name: str(row, "ad_group.name") ?? "",
        status: mapStatus(str(row, "ad_group.status")),
        statusRaw: str(row, "ad_group.status") ?? "UNSPECIFIED",
        campaignId: str(row, "campaign.id"),
        parentId: str(row, "campaign.id"),
        budget: null,
        extra: {
          ...channelInfo(row),
          type: str(row, "ad_group.type"),
          cpc_bid: microsToMajor(row, "ad_group.cpc_bid_micros"),
          target_cpa: microsToMajor(row, "ad_group.target_cpa_micros"),
          primary_status: str(row, "ad_group.primary_status"),
          currency: ctx.currency,
        },
      }
    case "ad": {
      const ag = str(row, "ad_group.id")
      const ad = str(row, "ad_group_ad.ad.id")
      const headlines = [
        ...texts(field(row, "ad_group_ad.ad.responsive_search_ad.headlines")),
        ...texts(field(row, "ad_group_ad.ad.video_responsive_ad.headlines")),
        ...texts(field(row, "ad_group_ad.ad.demand_gen_video_responsive_ad.headlines")),
      ]
      const videoAssets = videoAssetsOf(row)
      return {
        id: `${ag}~${ad}`,
        level,
        name: str(row, "ad_group_ad.ad.name") || headlines[0] || `Ad ${ad}`,
        status: mapStatus(str(row, "ad_group_ad.status")),
        statusRaw: str(row, "ad_group_ad.status") ?? "UNSPECIFIED",
        campaignId: str(row, "campaign.id"),
        parentId: ag,
        budget: null,
        extra: {
          ...channelInfo(row),
          ad_id: ad,
          type: str(row, "ad_group_ad.ad.type"),
          ...(videoAssets.length ? { video_assets: videoAssets } : {}),
          final_urls: field(row, "ad_group_ad.ad.final_urls") ?? [],
          approval_status: str(row, "ad_group_ad.policy_summary.approval_status"),
          review_status: str(row, "ad_group_ad.policy_summary.review_status"),
          ad_strength: str(row, "ad_group_ad.ad_strength"),
        },
      }
    }
    case "keyword": {
      const ag = str(row, "ad_group.id")
      const crit = str(row, "ad_group_criterion.criterion_id")
      return {
        id: `${ag}~${crit}`,
        level,
        name: str(row, "ad_group_criterion.keyword.text") ?? "",
        status: mapStatus(str(row, "ad_group_criterion.status")),
        statusRaw: str(row, "ad_group_criterion.status") ?? "UNSPECIFIED",
        campaignId: str(row, "campaign.id"),
        parentId: ag,
        budget: null,
        extra: {
          criterion_id: crit,
          match_type: str(row, "ad_group_criterion.keyword.match_type"),
          negative: field(row, "ad_group_criterion.negative") === true,
          cpc_bid: microsToMajor(row, "ad_group_criterion.cpc_bid_micros"),
          approval_status: str(row, "ad_group_criterion.approval_status"),
          quality_score: field(row, "ad_group_criterion.quality_info.quality_score") ?? null,
          currency: ctx.currency,
        },
      }
    }
  }
}

export function buildListQuery(q: ListQuery): string {
  const spec = SPECS[q.level]
  if (!spec) throw invalidRequest(`Unknown level ${q.level}`, `Cấp không hợp lệ: ${q.level}.`)
  const conds: (string | null | undefined)[] = [spec.extra, channelCondition(resolveChannelTypes((q as GoogleListQuery).channelTypes))]
  if (q.parentId) {
    if (!spec.parent) throw invalidRequest("campaign has no parent", "Cấp campaign không có parent_id.")
    conds.push(`${spec.parent} = ${assertId(q.parentId, "parent_id")}`)
  }
  conds.push(statusCondition(spec.status, q.statuses))
  if (q.nameContains) conds.push(likeContains(spec.name, q.nameContains))
  const fields = q.level === "ad" ? AD_LIST_FIELDS : spec.fields
  return `SELECT ${fields.join(", ")} FROM ${spec.from}${where(conds)} ORDER BY ${spec.idField}`
}

// ---------------------------------------------------------------------------
// YouTube video assets of ads (video_ad / video_responsive_ad / demand_gen_video_responsive_ad)
// ---------------------------------------------------------------------------

const ASSET_RN = /^customers\/\d{1,19}\/assets\/\d{1,19}$/

/** Asset resource names of the videos of an ad row. */
export function videoAssetsOf(row: GoogleAdsRow): string[] {
  const out: string[] = []
  const single = str(row, "ad_group_ad.ad.video_ad.video.asset")
  if (single) out.push(single)
  for (const p of ["ad_group_ad.ad.video_responsive_ad.videos", "ad_group_ad.ad.demand_gen_video_responsive_ad.videos"]) {
    const v = field(row, p)
    if (Array.isArray(v)) for (const x of v) if (typeof (x as { asset?: unknown })?.asset === "string") out.push((x as { asset: string }).asset)
  }
  return [...new Set(out)]
}

/** asset resource name → { youtube_video_id, title } (one GAQL read; unknown/invalid names are skipped). */
export async function resolveYoutubeAssets(
  client: GoogleAdsClient,
  cid: string,
  assetNames: string[]
): Promise<Map<string, { youtube_video_id: string | null; title: string | null }>> {
  const names = [...new Set(assetNames)].filter((n) => ASSET_RN.test(n)).slice(0, 1_000)
  const out = new Map<string, { youtube_video_id: string | null; title: string | null }>()
  if (!names.length) return out
  const { rows } = await client.searchAll(
    cid,
    `SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title FROM asset WHERE asset.resource_name IN (${names.map(gaqlString).join(", ")})`,
    { maxRows: 1_000 }
  )
  for (const r of rows) {
    const rn = str(r, "asset.resource_name")
    if (rn) out.set(rn, { youtube_video_id: str(r, "asset.youtube_video_asset.youtube_video_id"), title: str(r, "asset.youtube_video_asset.youtube_video_title") })
  }
  return out
}

/** Add `youtube_videos` [{asset, youtube_video_id, title, url}] to ad summaries/details that carry video assets. */
async function attachYoutubeIds(client: GoogleAdsClient, cid: string, items: AdObjectSummary[], warnings?: string[]): Promise<void> {
  const all = items.flatMap((i) => (Array.isArray(i.extra?.video_assets) ? (i.extra!.video_assets as string[]) : []))
  if (!all.length) return
  let map: Map<string, { youtube_video_id: string | null; title: string | null }>
  try {
    map = await resolveYoutubeAssets(client, cid, all)
  } catch {
    warnings?.push("Không đọc được ID video YouTube của quảng cáo (asset) - chỉ có tên tài nguyên asset.")
    return
  }
  for (const i of items) {
    const assets = i.extra?.video_assets
    if (!Array.isArray(assets)) continue
    i.extra!.youtube_videos = (assets as string[]).map((a) => {
      const yt = map.get(a)
      const id = yt?.youtube_video_id ?? null
      return { asset: a, youtube_video_id: id, title: yt?.title ?? null, url: id ? `https://www.youtube.com/watch?v=${id}` : null }
    })
  }
}

export async function listObjects(ctx: GCtx, q: ListQuery): Promise<ObjectPage> {
  const cid = customerIdOf(ctx)
  const query = buildListQuery(q)
  const limit = Math.max(1, Math.min(q.limit || 50, 1_000))
  const cur = decodeCursor(q.cursor, query)
  const page = await clientFor(ctx).search(cid, query, cur.pt)
  const { items, nextCursor } = slicePage(page.results, cur, page.nextPageToken, limit, query)
  const warnings: string[] = []
  if (q.level === "ad" && q.nameContains) warnings.push("Quảng cáo RSA thường không có tên - lọc theo tên có thể không ra kết quả.")
  const out = items.map((r) => summaryFromRow(q.level, r, ctx.account))
  if (q.level === "ad") await attachYoutubeIds(clientFor(ctx), cid, out, warnings)
  if (out.some((i) => i.extra?.advertising_channel_type === "VIDEO")) {
    warnings.push("Chiến dịch Video (YouTube) chỉ xem được qua API - bật/tắt, ngân sách và nội dung phải chỉnh trong Google Ads.")
  }
  return { items: out, nextCursor, warnings }
}

// ---------------------------------------------------------------------------
// Id resolution (plain ad id → AG~AD; keyword requires AG~CRIT unless unambiguous)
// ---------------------------------------------------------------------------

export interface ObjRef {
  level: ObjectLevel
  id: string
  adGroupId: string | null
  /** display id (composite for ad/keyword) */
  key: string
}

export async function resolveRefs(client: GoogleAdsClient, cid: string, level: ObjectLevel, ids: string[]): Promise<ObjRef[]> {
  if (level === "campaign" || level === "ad_group") {
    return ids.map((i) => {
      const id = assertId(i, `${level}_id`)
      return { level, id, adGroupId: null, key: id }
    })
  }
  const parsed = ids.map((i) => parseCompositeId(i, level === "ad" ? "ad_id" : "keyword_id"))
  const missing = parsed.filter((p) => !p.adGroupId)
  if (!missing.length) return parsed.map((p) => ({ level, id: p.id, adGroupId: p.adGroupId, key: `${p.adGroupId}~${p.id}` }))
  const spec = SPECS[level]
  const query = `SELECT ad_group.id, ${spec.idField} FROM ${spec.from}${where([spec.extra, `${spec.idField} IN ${idList(missing.map((m) => m.id))}`])}`
  const { rows } = await client.searchAll(cid, query, { maxRows: 1_000 })
  const found = new Map<string, string[]>()
  for (const r of rows) {
    const id = str(r, spec.idField)!
    found.set(id, [...(found.get(id) ?? []), str(r, "ad_group.id")!])
  }
  return parsed.map((p) => {
    if (p.adGroupId) return { level, id: p.id, adGroupId: p.adGroupId, key: `${p.adGroupId}~${p.id}` }
    const ags = found.get(p.id) ?? []
    if (!ags.length) throw notFound(level === "ad" ? "quảng cáo" : "từ khóa", p.id)
    if (ags.length > 1) {
      throw invalidRequest(
        `Ambiguous ${level} id ${p.id}`,
        `Id ${p.id} xuất hiện ở nhiều nhóm quảng cáo (${ags.join(", ")}). Hãy dùng dạng AD_GROUP_ID~ID, vd ${ags[0]}~${p.id}.`
      )
    }
    return { level, id: p.id, adGroupId: ags[0]!, key: `${ags[0]}~${p.id}` }
  })
}

/** WHERE condition selecting exactly the given refs. */
export function refsCondition(level: ObjectLevel, refs: ObjRef[]): string {
  const spec = SPECS[level]
  if (level === "campaign" || level === "ad_group") return `${spec.idField} IN ${idList(refs.map((r) => r.id))}`
  // composite: filter by both ids (superset), exact pairs are matched in memory
  return `${spec.idField} IN ${idList(refs.map((r) => r.id))} AND ad_group.id IN ${idList(refs.map((r) => r.adGroupId!))}`
}

export function rowKey(level: ObjectLevel, row: GoogleAdsRow): string {
  const spec = SPECS[level]
  const id = str(row, spec.idField)!
  return level === "ad" || level === "keyword" ? `${str(row, "ad_group.id")}~${id}` : id
}

export function resourceNameFor(cid: string, ref: ObjRef): string {
  switch (ref.level) {
    case "campaign":
      return `customers/${cid}/campaigns/${ref.id}`
    case "ad_group":
      return `customers/${cid}/adGroups/${ref.id}`
    case "ad":
      return `customers/${cid}/adGroupAds/${ref.adGroupId}~${ref.id}`
    case "keyword":
      return `customers/${cid}/adGroupCriteria/${ref.adGroupId}~${ref.id}`
  }
}

export const SERVICE_BY_LEVEL: Record<ObjectLevel, string> = {
  campaign: "campaigns",
  ad_group: "adGroups",
  ad: "adGroupAds",
  keyword: "adGroupCriteria",
}

/** Read current rows for refs (keyed by display id). */
export async function readCurrent(client: GoogleAdsClient, cid: string, level: ObjectLevel, refs: ObjRef[], fields?: string[]): Promise<Map<string, GoogleAdsRow>> {
  const spec = SPECS[level]
  const query = `SELECT ${(fields ?? spec.fields).join(", ")} FROM ${spec.from}${where([spec.extra, refsCondition(level, refs)])}`
  const { rows } = await client.searchAll(cid, query, { maxRows: 5_000 })
  const wanted = new Set(refs.map((r) => r.key))
  const out = new Map<string, GoogleAdsRow>()
  for (const r of rows) {
    const k = rowKey(level, r)
    if (wanted.has(k)) out.set(k, r)
  }
  return out
}

// ---------------------------------------------------------------------------
// getObject
// ---------------------------------------------------------------------------

const MAX_CHILDREN = 500

function campaignConfig(row: GoogleAdsRow, currency: string): Record<string, unknown> {
  const channel = str(row, "campaign.advertising_channel_type")
  return {
    advertising_channel_type: channel,
    advertising_channel_sub_type: str(row, "campaign.advertising_channel_sub_type"),
    ...(channel === "VIDEO"
      ? {
          read_only: true,
          video_ad_inventory_control: {
            allow_in_stream: field(row, "campaign.video_campaign_settings.video_ad_inventory_control.allow_in_stream") ?? null,
            allow_in_feed: field(row, "campaign.video_campaign_settings.video_ad_inventory_control.allow_in_feed") ?? null,
            allow_shorts: field(row, "campaign.video_campaign_settings.video_ad_inventory_control.allow_shorts") ?? null,
          },
        }
      : {}),
    bidding: {
      type: str(row, "campaign.bidding_strategy_type"),
      portfolio_bidding_strategy: str(row, "campaign.bidding_strategy"),
      manual_cpc_enhanced: field(row, "campaign.manual_cpc.enhanced_cpc_enabled") ?? null,
      target_cpa: microsToMajor(row, "campaign.maximize_conversions.target_cpa_micros") ?? microsToMajor(row, "campaign.target_cpa.target_cpa_micros"),
      target_roas: field(row, "campaign.maximize_conversion_value.target_roas") ?? field(row, "campaign.target_roas.target_roas") ?? null,
      max_cpc_bid_ceiling: microsToMajor(row, "campaign.target_spend.cpc_bid_ceiling_micros"),
      currency,
    },
    budget: {
      id: str(row, "campaign_budget.id"),
      name: str(row, "campaign_budget.name"),
      period: str(row, "campaign_budget.period"),
      amount: microsToMajor(row, "campaign_budget.amount_micros"),
      total_amount: microsToMajor(row, "campaign_budget.total_amount_micros"),
      explicitly_shared: field(row, "campaign_budget.explicitly_shared") === true,
      reference_count: Number(str(row, "campaign_budget.reference_count") ?? 0),
      delivery_method: str(row, "campaign_budget.delivery_method"),
      currency,
    },
    network_settings: {
      target_google_search: field(row, "campaign.network_settings.target_google_search") === true,
      target_search_network: field(row, "campaign.network_settings.target_search_network") === true,
      target_content_network: field(row, "campaign.network_settings.target_content_network") === true,
      target_partner_search_network: field(row, "campaign.network_settings.target_partner_search_network") === true,
    },
    geo_target_type_setting: {
      positive: str(row, "campaign.geo_target_type_setting.positive_geo_target_type"),
      negative: str(row, "campaign.geo_target_type_setting.negative_geo_target_type"),
    },
    contains_eu_political_advertising: str(row, "campaign.contains_eu_political_advertising"),
    missing_eu_political_advertising_declaration: field(row, "campaign.missing_eu_political_advertising_declaration") === true,
    start_date_time: str(row, "campaign.start_date_time"),
    end_date_time: str(row, "campaign.end_date_time"),
    tracking_url_template: str(row, "campaign.tracking_url_template"),
    final_url_suffix: str(row, "campaign.final_url_suffix"),
    optimization_score: field(row, "campaign.optimization_score") ?? null,
  }
}

function adConfig(row: GoogleAdsRow): Record<string, unknown> {
  const pick = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => ({ text: (x as { text?: string }).text ?? "", pinned_field: (x as { pinnedField?: string }).pinnedField ?? null })) : []
  return {
    type: str(row, "ad_group_ad.ad.type"),
    final_urls: field(row, "ad_group_ad.ad.final_urls") ?? [],
    responsive_search_ad: {
      headlines: pick(field(row, "ad_group_ad.ad.responsive_search_ad.headlines")),
      descriptions: pick(field(row, "ad_group_ad.ad.responsive_search_ad.descriptions")),
      path1: str(row, "ad_group_ad.ad.responsive_search_ad.path1"),
      path2: str(row, "ad_group_ad.ad.responsive_search_ad.path2"),
    },
    policy: {
      approval_status: str(row, "ad_group_ad.policy_summary.approval_status"),
      review_status: str(row, "ad_group_ad.policy_summary.review_status"),
    },
    ad_strength: str(row, "ad_group_ad.ad_strength"),
    ...videoAdConfig(row),
  }
}

function videoAdConfig(row: GoogleAdsRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const single = str(row, "ad_group_ad.ad.video_ad.video.asset")
  if (single) out.video_ad = { video_asset: single }
  const vr = field(row, "ad_group_ad.ad.video_responsive_ad")
  if (vr && typeof vr === "object") {
    out.video_responsive_ad = {
      videos: videoAssetList(field(row, "ad_group_ad.ad.video_responsive_ad.videos")),
      headlines: texts(field(row, "ad_group_ad.ad.video_responsive_ad.headlines")),
      long_headlines: texts(field(row, "ad_group_ad.ad.video_responsive_ad.long_headlines")),
      descriptions: texts(field(row, "ad_group_ad.ad.video_responsive_ad.descriptions")),
    }
  }
  const dg = field(row, "ad_group_ad.ad.demand_gen_video_responsive_ad")
  if (dg && typeof dg === "object") {
    out.demand_gen_video_responsive_ad = {
      videos: videoAssetList(field(row, "ad_group_ad.ad.demand_gen_video_responsive_ad.videos")),
      headlines: texts(field(row, "ad_group_ad.ad.demand_gen_video_responsive_ad.headlines")),
      business_name: str(row, "ad_group_ad.ad.demand_gen_video_responsive_ad.business_name.text"),
    }
  }
  return out
}

function videoAssetList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (x as { asset?: unknown })?.asset).filter((a): a is string => typeof a === "string") : []
}

function detail(level: ObjectLevel, row: GoogleAdsRow, ctx: GCtx, config: Record<string, unknown>): AdObjectDetail {
  return { ...summaryFromRow(level, row, ctx.account), config }
}

export async function getObject(ctx: GCtx, level: ObjectLevel, id: string, opts: { includeChildren?: boolean } = {}): Promise<AdObjectDetail> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const [ref] = await resolveRefs(client, cid, level, [id])
  const fields = level === "campaign" ? CAMPAIGN_DETAIL_FIELDS : level === "ad" ? AD_LIST_FIELDS : undefined
  const rows = await readCurrent(client, cid, level, [ref!], fields)
  const row = rows.get(ref!.key)
  if (!row) throw notFound(level, id)
  const cur = ctx.account.currency

  if (level === "campaign") {
    const crit = await client.searchAll(
      cid,
      `SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.display_name, ` +
        `campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.keyword.text, ` +
        `campaign_criterion.keyword.match_type, campaign_criterion.bid_modifier FROM campaign_criterion ` +
        `WHERE campaign.id = ${ref!.id} AND campaign_criterion.status != 'REMOVED'`,
      { maxRows: 2_000 }
    )
    const config = campaignConfig(row, cur)
    config.criteria = crit.rows.map((r) => ({
      criterion_id: str(r, "campaign_criterion.criterion_id"),
      type: str(r, "campaign_criterion.type"),
      negative: field(r, "campaign_criterion.negative") === true,
      display_name: str(r, "campaign_criterion.display_name"),
      geo_target_constant: str(r, "campaign_criterion.location.geo_target_constant"),
      language_constant: str(r, "campaign_criterion.language.language_constant"),
      keyword: str(r, "campaign_criterion.keyword.text"),
      match_type: str(r, "campaign_criterion.keyword.match_type"),
      bid_modifier: field(r, "campaign_criterion.bid_modifier") ?? null,
    }))
    const out = detail(level, row, ctx, config)
    if (opts.includeChildren) {
      out.children = await campaignChildren(client, cid, ctx, ref!.id)
      await attachYoutubeIds(client, cid, out.children.flatMap((g) => g.children ?? []).filter((c) => c.level === "ad"))
    }
    return out
  }
  if (level === "ad_group") {
    const out = detail(level, row, ctx, {
      type: str(row, "ad_group.type"),
      cpc_bid: microsToMajor(row, "ad_group.cpc_bid_micros"),
      target_cpa: microsToMajor(row, "ad_group.target_cpa_micros"),
      currency: cur,
    })
    if (opts.includeChildren) {
      const children = await adGroupChildren(client, cid, ctx, `ad_group.id = ${ref!.id}`).then((m) => m.get(ref!.id) ?? [])
      await attachYoutubeIds(client, cid, children.filter((c) => c.level === "ad"))
      out.children = children
    }
    return out
  }
  if (level === "ad") {
    const out = detail(level, row, ctx, adConfig(row))
    await attachYoutubeIds(client, cid, [out])
    return out
  }
  return detail(level, row, ctx, {
    keyword: str(row, "ad_group_criterion.keyword.text"),
    match_type: str(row, "ad_group_criterion.keyword.match_type"),
    negative: field(row, "ad_group_criterion.negative") === true,
    cpc_bid: microsToMajor(row, "ad_group_criterion.cpc_bid_micros"),
    quality_score: field(row, "ad_group_criterion.quality_info.quality_score") ?? null,
    currency: cur,
  })
}

/** ads + keywords grouped by ad group id */
async function adGroupChildren(client: GoogleAdsClient, cid: string, ctx: GCtx, cond: string): Promise<Map<string, AdObjectDetail[]>> {
  const [ads, kws] = await Promise.all([
    client.searchAll(cid, `SELECT ${AD_LIST_FIELDS.join(", ")} FROM ad_group_ad WHERE ${cond} AND ad_group_ad.status != 'REMOVED'`, { maxRows: MAX_CHILDREN }),
    client.searchAll(
      cid,
      `SELECT ${KEYWORD_FIELDS.join(", ")} FROM ad_group_criterion WHERE ${cond} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`,
      { maxRows: MAX_CHILDREN }
    ),
  ])
  const by = new Map<string, AdObjectDetail[]>()
  const push = (ag: string, d: AdObjectDetail) => by.set(ag, [...(by.get(ag) ?? []), d])
  for (const r of ads.rows) push(str(r, "ad_group.id")!, detail("ad", r, ctx, adConfig(r)))
  for (const r of kws.rows) push(str(r, "ad_group.id")!, { ...summaryFromRow("keyword", r, ctx.account), config: {} })
  return by
}

async function campaignChildren(client: GoogleAdsClient, cid: string, ctx: GCtx, campaignId: string): Promise<AdObjectDetail[]> {
  const ags = await client.searchAll(
    cid,
    `SELECT ${AD_GROUP_FIELDS.join(", ")} FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED' ORDER BY ad_group.id`,
    { maxRows: MAX_CHILDREN }
  )
  const children = await adGroupChildren(client, cid, ctx, `campaign.id = ${campaignId}`)
  return ags.rows.map((r) => {
    const s = summaryFromRow("ad_group", r, ctx.account)
    return { ...s, config: { cpc_bid: s.extra?.cpc_bid ?? null }, children: children.get(s.id) ?? [] }
  })
}
