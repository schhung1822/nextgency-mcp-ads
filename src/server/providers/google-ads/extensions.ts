// Google-Ads-specific MCP tools. Money inputs are MAJOR units of the account currency.
import { z } from "zod"
import { redactString } from "../../audit/redact"
import { addDays, isIsoDate, todayInTz } from "../dates"
import { ProviderError, isProviderError } from "../errors"
import type { ExtensionMoneyItem, FieldChange, MutationOptions, MutationResult, ProviderExtension } from "../types"
import { field, resourceId, str, type GoogleAdsRow } from "./client"
import { clientFor, customerIdOf, invalidRequest, notFound, type GCtx } from "./context"
import { responseResourceName } from "./copy"
import type { GoogleAdsCredentials } from "./credentials"
import { decodeCursor, slicePage } from "./cursor"
import { assertId, gaqlString, idList } from "./gaql"
import { googleAdsAssetExtensions } from "./assets"
import { createYoutubeVideoAsset } from "./media"
import {
  adScheduleBody,
  adSchedulesSchema,
  campaignTargetingExtensions,
  geoTargetTypeSchema,
  proximitiesSchema,
  proximityBody,
  proximityPoint,
} from "./targeting"
import { buildUpdate, failuresToError } from "./mutate"
import { moneyToMicros, primeBillableUnit } from "./units"
import { assertNotVideo, youtubeWatchUrl } from "./youtube"

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const idStr = z.string().trim().regex(/^\d{1,19}$/, "Id chỉ gồm chữ số.")
const matchType = z.enum(["EXACT", "PHRASE", "BROAD"])
const keywordText = z
  .string()
  .trim()
  .min(1)
  .max(80, "Từ khóa tối đa 80 ký tự.")
  .refine((s) => s.split(/\s+/).length <= 10, "Từ khóa tối đa 10 từ.")
const money = z.number().positive().finite()
const isoDate = z.string().refine(isIsoDate, "Ngày phải có dạng YYYY-MM-DD.")

const keywordSchema = z.object({ text: keywordText, match_type: matchType.default("PHRASE") })

export const rsaFields = {
  final_url: z.string().trim().url("final_url phải là URL đầy đủ (https://…).").max(2048),
  headlines: z
    .array(z.string().trim().min(1).max(30, "Mỗi tiêu đề tối đa 30 ký tự."))
    .min(3, "Cần ít nhất 3 tiêu đề.")
    .max(15, "Tối đa 15 tiêu đề.")
    .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, "Các tiêu đề không được trùng nhau."),
  descriptions: z
    .array(z.string().trim().min(1).max(90, "Mỗi mô tả tối đa 90 ký tự."))
    .min(2, "Cần ít nhất 2 mô tả.")
    .max(4, "Tối đa 4 mô tả.")
    .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, "Các mô tả không được trùng nhau."),
  path1: z.string().trim().max(15, "path1 tối đa 15 ký tự.").optional(),
  path2: z.string().trim().max(15, "path2 tối đa 15 ký tự.").optional(),
}
const rsaSchema = z.object(rsaFields).refine((r) => !r.path2 || !!r.path1, { message: "path2 chỉ dùng khi đã có path1.", path: ["path2"] })
type RsaInput = z.infer<typeof rsaSchema>

function rsaAd(r: RsaInput): Record<string, unknown> {
  const rsa: Record<string, unknown> = {
    headlines: r.headlines.map((text) => ({ text })),
    descriptions: r.descriptions.map((text) => ({ text })),
  }
  if (r.path1) rsa.path1 = r.path1
  if (r.path2) rsa.path2 = r.path2
  return { finalUrls: [r.final_url], responsiveSearchAd: rsa }
}

function created(objectId: string, objectName: string, level: FieldChange["level"], after: unknown): FieldChange {
  return { objectId, objectName, level, field: "create", before: null, after }
}

async function campaignNameExists(ctx: GCtx, cid: string, name: string): Promise<string | null> {
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT campaign.id FROM campaign WHERE campaign.name = ${gaqlString(name)} AND campaign.status != 'REMOVED'`,
    { maxRows: 1 }
  )
  return rows[0] ? str(rows[0], "campaign.id") : null
}

// ---------------------------------------------------------------------------
// google_ads_create_search_campaign
// ---------------------------------------------------------------------------

export const createSearchCampaignInput = z
  .object({
    name: z.string().trim().min(1).max(255),
    daily_budget: money.describe("Ngân sách ngày, đơn vị chính của tiền tệ tài khoản (vd 500000 cho 500.000 VND)"),
    bidding_strategy: z.enum(["manual_cpc", "maximize_clicks", "maximize_conversions"]).default("maximize_clicks"),
    max_cpc_bid_limit: money.optional().describe("Trần CPC cho maximize_clicks"),
    target_cpa: money.optional().describe("CPA mục tiêu cho maximize_conversions"),
    start_date: isoDate.optional().describe("YYYY-MM-DD theo múi giờ tài khoản, mặc định hôm nay"),
    end_date: isoDate.optional(),
    location_ids: z.array(idStr).min(1).max(1000).optional().describe("ID geo target (lấy từ ads_lookup kind=locations), vd 2704 = Việt Nam"),
    excluded_location_ids: z.array(idStr).max(1000).optional(),
    proximities: proximitiesSchema.optional().describe("Bán kính quanh tọa độ (km 1–800 / dặm 0,7–500); cần location_ids hoặc proximities"),
    positive_geo_target_type: geoTargetTypeSchema
      .optional()
      .describe("PRESENCE = chỉ người đang ở / thường ở khu vực; bỏ trống = mặc định Google PRESENCE_OR_INTEREST (thêm người quan tâm)"),
    ad_schedules: adSchedulesSchema.optional().describe("Lịch quảng cáo theo múi giờ tài khoản; bỏ trống = cả ngày, mọi ngày"),
    // No language_ids: since 2026-09-30 manual language targeting on Search fails with
    // ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT (Google infers the language).
    include_search_partners: z.boolean().default(false),
    include_display_network: z.boolean().default(false),
    contains_eu_political_advertising: z.boolean().default(false),
    negative_keywords: z.array(keywordSchema).max(1000).optional().describe("Từ khóa phủ định cấp chiến dịch"),
    ad_groups: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(255),
          cpc_bid: money.optional().describe("Giá thầu CPC tối đa (bắt buộc với manual_cpc)"),
          keywords: z.array(keywordSchema).min(1).max(500),
          negative_keywords: z.array(keywordSchema).max(500).optional(),
          ads: z.array(rsaSchema).min(1).max(3),
        })
      )
      .min(1)
      .max(20),
  })
  .superRefine((v, ctx) => {
    if (!v.location_ids?.length && !v.proximities?.length) {
      ctx.addIssue({ code: "custom", path: ["location_ids"], message: "Cần ít nhất 1 vị trí (location_ids) hoặc 1 bán kính (proximities)." })
    }
    if (v.bidding_strategy === "manual_cpc") {
      v.ad_groups.forEach((g, i) => {
        if (g.cpc_bid === undefined) ctx.addIssue({ code: "custom", path: ["ad_groups", i, "cpc_bid"], message: "manual_cpc cần cpc_bid cho mỗi nhóm." })
      })
    }
    if (v.target_cpa !== undefined && v.bidding_strategy !== "maximize_conversions") {
      ctx.addIssue({ code: "custom", path: ["target_cpa"], message: "target_cpa chỉ dùng với maximize_conversions." })
    }
    if (v.max_cpc_bid_limit !== undefined && v.bidding_strategy !== "maximize_clicks") {
      ctx.addIssue({ code: "custom", path: ["max_cpc_bid_limit"], message: "max_cpc_bid_limit chỉ dùng với maximize_clicks." })
    }
    if (v.start_date && v.end_date && v.end_date < v.start_date) ctx.addIssue({ code: "custom", path: ["end_date"], message: "end_date phải sau start_date." })
    const names = v.ad_groups.map((g) => g.name.toLowerCase())
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", path: ["ad_groups"], message: "Tên nhóm quảng cáo không được trùng." })
  })
export type CreateSearchCampaignInput = z.infer<typeof createSearchCampaignInput>

export interface SearchCampaignPlan {
  ops: Record<string, unknown>[]
  campaignIndex: number
  adGroupIndexes: number[]
  warnings: string[]
}

/** Pure builder: one atomic googleAds:mutate with temp ids, parents first. */
export function buildSearchCampaignOps(cid: string, input: CreateSearchCampaignInput, o: { currency: string; today: string; budgetSuffix?: string }): SearchCampaignPlan {
  const warnings: string[] = []
  let tmp = 0
  const nextId = () => String(--tmp)
  const ops: Record<string, unknown>[] = []
  const start = input.start_date ?? o.today
  if (start < o.today) throw invalidRequest("start in past", `start_date (${start}) không được ở quá khứ (hôm nay: ${o.today}).`)

  const budgetRn = `customers/${cid}/campaignBudgets/${nextId()}`
  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: budgetRn,
        name: `${input.name} - ngân sách ${o.budgetSuffix ?? Date.now().toString(36)}`.slice(0, 255),
        amountMicros: moneyToMicros(input.daily_budget, o.currency, warnings, "Ngân sách ngày"),
        deliveryMethod: "STANDARD",
        explicitlyShared: false,
      },
    },
  })

  const campaignRn = `customers/${cid}/campaigns/${nextId()}`
  let bidding: Record<string, unknown>
  if (input.bidding_strategy === "manual_cpc") bidding = { manualCpc: {} }
  else if (input.bidding_strategy === "maximize_clicks") {
    bidding = { targetSpend: input.max_cpc_bid_limit ? { cpcBidCeilingMicros: moneyToMicros(input.max_cpc_bid_limit, o.currency, warnings, "Trần CPC") } : {} }
  } else {
    bidding = { maximizeConversions: input.target_cpa ? { targetCpaMicros: moneyToMicros(input.target_cpa, o.currency, warnings, "CPA mục tiêu") } : {} }
  }
  const campaign: Record<string, unknown> = {
    resourceName: campaignRn,
    name: input.name,
    status: "PAUSED",
    advertisingChannelType: "SEARCH",
    campaignBudget: budgetRn,
    ...bidding,
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork: input.include_search_partners,
      targetContentNetwork: input.include_display_network,
      targetPartnerSearchNetwork: false,
    },
    containsEuPoliticalAdvertising: input.contains_eu_political_advertising ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    startDateTime: `${start} 00:00:00`,
  }
  if (input.end_date) campaign.endDateTime = `${input.end_date} 23:59:59`
  // omitted = Google default (PRESENCE_OR_INTEREST); sent only when the user chose
  if (input.positive_geo_target_type) campaign.geoTargetTypeSetting = { positiveGeoTargetType: input.positive_geo_target_type }
  const campaignIndex = ops.length
  ops.push({ campaignOperation: { create: campaign } })

  for (const id of input.location_ids ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, location: { geoTargetConstant: `geoTargetConstants/${assertId(id)}` } } } })
  }
  for (const id of input.excluded_location_ids ?? []) {
    ops.push({
      campaignCriterionOperation: { create: { campaign: campaignRn, negative: true, location: { geoTargetConstant: `geoTargetConstants/${assertId(id)}` } } },
    })
  }
  for (const p of input.proximities ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, proximity: proximityBody(proximityPoint(p)) } } })
  }
  for (const s of input.ad_schedules ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, adSchedule: adScheduleBody(s) } } })
  }
  for (const k of input.negative_keywords ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, negative: true, keyword: { text: k.text, matchType: k.match_type } } } })
  }

  const adGroupIndexes: number[] = []
  for (const g of input.ad_groups) {
    const agRn = `customers/${cid}/adGroups/${nextId()}`
    const ag: Record<string, unknown> = { resourceName: agRn, campaign: campaignRn, name: g.name, status: "ENABLED", type: "SEARCH_STANDARD" }
    if (g.cpc_bid !== undefined) ag.cpcBidMicros = moneyToMicros(g.cpc_bid, o.currency, warnings, "Giá thầu CPC")
    adGroupIndexes.push(ops.length)
    ops.push({ adGroupOperation: { create: ag } })
    for (const ad of g.ads) ops.push({ adGroupAdOperation: { create: { adGroup: agRn, status: "ENABLED", ad: rsaAd(ad) } } })
    for (const k of g.keywords) {
      ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: "ENABLED", keyword: { text: k.text, matchType: k.match_type } } } })
    }
    for (const k of g.negative_keywords ?? []) {
      ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, negative: true, keyword: { text: k.text, matchType: k.match_type } } } })
    }
  }
  if (input.start_date && input.start_date > addDays(o.today, 365)) warnings.push("Ngày bắt đầu cách hơn 1 năm.")
  return { ops, campaignIndex, adGroupIndexes, warnings }
}

async function runCreateSearchCampaign(ctx: GCtx, input: CreateSearchCampaignInput, opts: MutationOptions) {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const today = todayInTz(ctx.account.timezone)
  const existing = await campaignNameExists(ctx, cid, input.name)
  if (existing) {
    throw new ProviderError({
      platform: "google_ads",
      code: "conflict",
      message: `Campaign name exists: ${existing}`,
      userMessageVi: `Đã có chiến dịch tên “${input.name}” (id ${existing}). Tên chiến dịch phải duy nhất - hãy đặt tên khác.`,
    })
  }
  await primeBillableUnit(client, cid, ctx.account.currency)
  const plan = buildSearchCampaignOps(cid, input, { currency: ctx.account.currency, today })
  const warnings = [
    ...plan.warnings,
    "Chiến dịch được tạo ở trạng thái TẠM DỪNG - dùng ads_set_status để bật khi đã kiểm tra.",
    ...(input.contains_eu_political_advertising ? ["Đã khai báo chiến dịch CÓ chứa quảng cáo chính trị EU - có thể bị hạn chế phân phát tại EU."] : []),
    ...(input.ad_schedules?.length
      ? [`Lịch quảng cáo tính theo múi giờ tài khoản (${ctx.account.timezone}); khung qua nửa đêm phải tách thành 2 ngày.`]
      : []),
  ]
  const summary = {
    name: input.name,
    daily_budget: input.daily_budget,
    currency: ctx.account.currency,
    bidding_strategy: input.bidding_strategy,
    start_date: input.start_date ?? today,
    end_date: input.end_date ?? null,
    locations: input.location_ids?.length ?? 0,
    proximities: input.proximities?.length ?? 0,
    ad_schedules: input.ad_schedules?.length ?? 0,
    positive_geo_target_type: input.positive_geo_target_type ?? "PRESENCE_OR_INTEREST (mặc định)",
    ad_groups: input.ad_groups.map((g) => ({ name: g.name, keywords: g.keywords.length, ads: g.ads.length })),
    operations: plan.ops.length,
  }
  if (opts.dryRun) {
    await client.googleAdsMutate(cid, plan.ops, { validateOnly: true })
    return { preview: true, changes: [created("(mới)", input.name, "campaign", summary)], warnings, createdIds: [] } satisfies MutationResult
  }
  let res
  try {
    res = await client.googleAdsMutate(cid, plan.ops, { idempotent: false })
  } catch (e) {
    if (isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")) {
      const found = await campaignNameExists(ctx, cid, input.name).catch(() => null)
      if (found) {
        return {
          preview: false,
          changes: [created(found, input.name, "campaign", summary)],
          warnings: [...warnings, "Mất kết nối khi tạo nhưng chiến dịch đã có trên Google Ads - kiểm tra lại bằng ads_get_object."],
          createdIds: [found],
          campaign_id: found,
        }
      }
    }
    throw e
  }
  const campaignId = resourceId(responseResourceName(res.results[plan.campaignIndex]))
  const adGroupIds = plan.adGroupIndexes.map((i) => resourceId(responseResourceName(res.results[i])))
  return {
    preview: false,
    changes: [created(campaignId ?? "?", input.name, "campaign", summary)],
    warnings,
    createdIds: [campaignId, ...adGroupIds].filter((x): x is string => !!x),
    campaign_id: campaignId,
    ad_group_ids: adGroupIds,
  }
}

// ---------------------------------------------------------------------------
// google_ads_create_rsa
// ---------------------------------------------------------------------------

export const createRsaInput = z
  .object({ ad_group_id: idStr, ...rsaFields })
  .refine((r) => !r.path2 || !!r.path1, { message: "path2 chỉ dùng khi đã có path1.", path: ["path2"] })

async function loadAdGroup(ctx: GCtx, cid: string, id: string): Promise<GoogleAdsRow> {
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id, campaign.advertising_channel_type FROM ad_group WHERE ad_group.id = ${assertId(id, "ad_group_id")}`,
    { maxRows: 1 }
  )
  const row = rows[0]
  if (!row || str(row, "ad_group.status") === "REMOVED") throw notFound("nhóm quảng cáo", id)
  return row
}

async function runCreateRsa(ctx: GCtx, input: z.infer<typeof createRsaInput>, opts: MutationOptions): Promise<MutationResult> {
  const cid = customerIdOf(ctx)
  const ag = await loadAdGroup(ctx, cid, input.ad_group_id)
  assertNotVideo([ag], "create_rsa")
  if (str(ag, "ad_group.type") !== "SEARCH_STANDARD") {
    throw invalidRequest("Not a search ad group", "Quảng cáo RSA chỉ thêm được vào nhóm quảng cáo Search tiêu chuẩn.")
  }
  const op = { create: { adGroup: `customers/${cid}/adGroups/${input.ad_group_id}`, status: "PAUSED", ad: rsaAd(input) } }
  const warnings = ["Quảng cáo mới ở trạng thái TẠM DỪNG và sẽ được Google xét duyệt - dùng ads_set_status (level=ad) để bật."]
  let newId: string | null = null
  try {
    const res = await clientFor(ctx).mutate<{ resourceName?: string }>(cid, "adGroupAds", [op], { validateOnly: !!opts.dryRun })
    newId = opts.dryRun ? null : resourceId(res.results[0]?.resourceName)
  } catch (e) {
    // Outcome unknown (5xx/timeout): look for an RSA with exactly these headlines before reporting failure.
    if (opts.dryRun || !isUncertain(e)) throw e
    newId = await findRsa(ctx, cid, input).catch(() => null)
    if (!newId) throw e
    warnings.push("Mất kết nối khi tạo nhưng quảng cáo đã có trên Google Ads - dùng id tìm thấy, không tạo lại.")
  }
  return {
    preview: !!opts.dryRun,
    changes: [created(newId ?? "(mới)", input.headlines[0]!, "ad", { ad_group: str(ag, "ad_group.name"), headlines: input.headlines.length, descriptions: input.descriptions.length, final_url: input.final_url })],
    warnings,
    createdIds: newId ? [newId] : [],
  }
}

/** Create failed with an unknown outcome (the request may have been applied). */
function isUncertain(e: unknown): boolean {
  return isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size

/** RSA in the ad group with the same headline set + final URL (post-failure existence check). */
async function findRsa(ctx: GCtx, cid: string, input: z.infer<typeof createRsaInput>): Promise<string | null> {
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines FROM ad_group_ad WHERE ad_group.id = ${assertId(input.ad_group_id, "ad_group_id")} AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`,
    { maxRows: 1_000 }
  )
  const want = input.headlines.map((h) => h.trim())
  for (const r of rows) {
    const heads = ((field(r, "ad_group_ad.ad.responsive_search_ad.headlines") as { text?: string }[] | undefined) ?? []).map((h) => (h.text ?? "").trim())
    const urls = (field(r, "ad_group_ad.ad.final_urls") as string[] | undefined) ?? []
    if (sameSet(heads, want) && urls.includes(input.final_url)) return str(r, "ad_group_ad.ad.id")
  }
  return null
}

/** Keywords (text + match type + negative) that now exist under the parent - post-failure existence check. */
async function findKeywords(
  ctx: GCtx,
  cid: string,
  parent: { adGroupId?: string; campaignId?: string },
  keywords: { text: string; match_type: string; negative: boolean }[]
): Promise<(string | null)[]> {
  const res = parent.adGroupId ? "ad_group_criterion" : "campaign_criterion"
  const scope = parent.adGroupId ? `ad_group.id = ${assertId(parent.adGroupId)}` : `campaign.id = ${assertId(parent.campaignId!)}`
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT ${res}.criterion_id, ${res}.negative, ${res}.keyword.text, ${res}.keyword.match_type FROM ${res} WHERE ${scope} AND ${res}.type = 'KEYWORD' AND ${res}.status != 'REMOVED'`,
    { maxRows: 10_000 }
  )
  const key = (t: string, m: string, n: boolean) => `${t.trim().toLowerCase()}|${m}|${n ? 1 : 0}`
  const have = new Map<string, string>()
  for (const r of rows) {
    const id = str(r, `${res}.criterion_id`)
    if (id) have.set(key(str(r, `${res}.keyword.text`) ?? "", str(r, `${res}.keyword.match_type`) ?? "", field(r, `${res}.negative`) === true), id)
  }
  const prefix = parent.adGroupId ? `${parent.adGroupId}~` : `${parent.campaignId}~`
  return keywords.map((k) => {
    const id = have.get(key(k.text, k.match_type, k.negative))
    return id ? `${prefix}${id}` : null
  })
}

// ---------------------------------------------------------------------------
// google_ads_add_keywords
// ---------------------------------------------------------------------------

export const addKeywordsInput = z
  .object({
    ad_group_id: idStr.optional().describe("Thêm từ khóa (và phủ định) vào nhóm quảng cáo này"),
    campaign_id: idStr.optional().describe("Chỉ dùng cho từ khóa phủ định cấp chiến dịch (khi không có ad_group_id)"),
    keywords: z
      .array(z.object({ text: keywordText, match_type: matchType.default("PHRASE"), negative: z.boolean().default(false), cpc_bid: money.optional() }))
      .min(1)
      .max(200),
  })
  .superRefine((v, ctx) => {
    if (!v.ad_group_id && !v.campaign_id) ctx.addIssue({ code: "custom", path: ["ad_group_id"], message: "Cần ad_group_id hoặc campaign_id." })
    if (!v.ad_group_id && v.keywords.some((k) => !k.negative)) {
      ctx.addIssue({ code: "custom", path: ["keywords"], message: "Cấp chiến dịch chỉ nhận từ khóa phủ định (negative=true); từ khóa thường cần ad_group_id." })
    }
    if (v.keywords.some((k) => k.negative && k.cpc_bid !== undefined)) ctx.addIssue({ code: "custom", path: ["keywords"], message: "Từ khóa phủ định không có giá thầu." })
  })

async function runAddKeywords(ctx: GCtx, input: z.infer<typeof addKeywordsInput>, opts: MutationOptions): Promise<MutationResult> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const warnings: string[] = []
  if (input.keywords.some((k) => k.cpc_bid !== undefined)) await primeBillableUnit(client, cid, ctx.account.currency)
  let service: string
  let ops: Record<string, unknown>[]
  let parentName: string | null
  if (input.ad_group_id) {
    const ag = await loadAdGroup(ctx, cid, input.ad_group_id)
    assertNotVideo([ag], "add_keywords")
    parentName = str(ag, "ad_group.name")
    const agRn = `customers/${cid}/adGroups/${input.ad_group_id}`
    service = "adGroupCriteria"
    ops = input.keywords.map((k) => {
      const c: Record<string, unknown> = { adGroup: agRn, keyword: { text: k.text, matchType: k.match_type } }
      if (k.negative) c.negative = true
      else c.status = "PAUSED"
      if (k.cpc_bid !== undefined) c.cpcBidMicros = moneyToMicros(k.cpc_bid, ctx.account.currency, warnings, "Giá thầu")
      return { create: c }
    })
  } else {
    const campaignId = assertId(input.campaign_id!, "campaign_id")
    const { rows } = await client.searchAll(
      cid,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${campaignId}`,
      { maxRows: 1 }
    )
    if (!rows[0] || str(rows[0], "campaign.status") === "REMOVED") throw notFound("chiến dịch", campaignId)
    assertNotVideo(rows, "add_keywords")
    parentName = str(rows[0], "campaign.name")
    service = "campaignCriteria"
    ops = input.keywords.map((k) => ({ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, negative: true, keyword: { text: k.text, matchType: k.match_type } } }))
  }
  let res: Awaited<ReturnType<typeof client.mutate<{ resourceName?: string }>>>
  try {
    res = await client.mutate<{ resourceName?: string }>(cid, service, ops, { partialFailure: true, validateOnly: !!opts.dryRun })
  } catch (e) {
    // Outcome unknown (5xx/timeout): report what now exists instead of inviting a duplicate retry.
    if (opts.dryRun || !isUncertain(e)) throw e
    const found = await findKeywords(ctx, cid, { adGroupId: input.ad_group_id, campaignId: input.campaign_id }, input.keywords).catch(() => null)
    if (!found || !found.some(Boolean)) throw e
    const missing = input.keywords.filter((_, i) => !found[i]).map((k) => k.text)
    return {
      preview: false,
      changes: input.keywords.flatMap((k, i) =>
        found[i] ? [created(found[i]!, k.text, "keyword", { match_type: k.match_type, negative: k.negative, parent: parentName })] : []
      ),
      warnings: [
        "Mất kết nối khi thêm từ khóa nhưng các từ khóa dưới đây đã có trên Google Ads - không thêm lại.",
        ...(missing.length ? [`Chưa thấy: ${missing.join(", ")} - có thể đã tạo hoặc chưa; hãy kiểm tra trước khi thử lại.`] : []),
      ],
      createdIds: found.filter((x): x is string => !!x),
    }
  }
  const failed = new Set(res.failures.map((f) => f.index).filter((i): i is number => i !== null))
  if (res.failures.length && (failed.size >= ops.length || res.failures.some((f) => f.index === null))) throw failuresToError(res.failures)
  for (const f of res.failures) {
    const k = f.index !== null ? input.keywords[f.index] : null
    warnings.push(redactString(`Không thêm được “${k?.text ?? "?"}”: ${f.code ?? ""} ${f.message}`.trim()))
  }
  const changes: FieldChange[] = []
  const createdIds: string[] = []
  input.keywords.forEach((k, i) => {
    if (failed.has(i)) return
    const id = opts.dryRun ? null : resourceId(res.results[i]?.resourceName)
    if (id) createdIds.push(id)
    changes.push(created(id ?? "(mới)", k.text, "keyword", { match_type: k.match_type, negative: k.negative, parent: parentName }))
  })
  if (input.keywords.some((k) => !k.negative)) warnings.push("Từ khóa mới ở trạng thái TẠM DỪNG - dùng ads_set_status (level=keyword) để bật.")
  return { preview: !!opts.dryRun, changes, warnings, createdIds }
}

// ---------------------------------------------------------------------------
// google_ads_declare_eu_political
// ---------------------------------------------------------------------------

export const declareEuInput = z.object({
  // No default: declaring "does not contain" is a legal statement the user must choose explicitly.
  contains_eu_political_advertising: z
    .boolean()
    .describe("BẮT BUỘC chọn: true nếu chiến dịch CÓ quảng cáo chính trị nhắm tới EU, false nếu KHÔNG"),
  campaign_ids: z.array(idStr).max(500).optional().describe("Mặc định: mọi chiến dịch còn thiếu khai báo"),
})

async function runDeclareEu(ctx: GCtx, input: z.infer<typeof declareEuInput>, opts: MutationOptions): Promise<MutationResult> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const conds = ["campaign.missing_eu_political_advertising_declaration = TRUE", "campaign.status != 'REMOVED'"]
  if (input.campaign_ids?.length) conds.push(`campaign.id IN ${idList(input.campaign_ids, "campaign_id")}`)
  const { rows: all } = await client.searchAll(
    cid,
    `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.contains_eu_political_advertising FROM campaign WHERE ${conds.join(" AND ")}`,
    { maxRows: 5_000 }
  )
  if (!all.length) return { preview: !!opts.dryRun, changes: [], warnings: ["Không có chiến dịch nào thiếu khai báo quảng cáo chính trị EU."] }
  // Video (YouTube) campaigns are read-only through the API in this app → declared in the Google Ads UI
  const video = all.filter((r) => str(r, "campaign.advertising_channel_type") === "VIDEO")
  const rows = all.filter((r) => str(r, "campaign.advertising_channel_type") !== "VIDEO")
  const videoWarnings = video.length
    ? [
        `Bỏ qua ${video.length} chiến dịch Video (YouTube) (${video
          .slice(0, 10)
          .map((r) => str(r, "campaign.id"))
          .join(", ")}${video.length > 10 ? "…" : ""}) - chiến dịch Video chỉ xem được qua API; hãy khai báo quảng cáo chính trị EU trong giao diện Google Ads.`,
      ]
    : []
  if (!rows.length) return { preview: !!opts.dryRun, changes: [], warnings: videoWarnings }
  const value = input.contains_eu_political_advertising ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
  const ops = rows.map((r) => buildUpdate(`customers/${cid}/campaigns/${str(r, "campaign.id")}`, { containsEuPoliticalAdvertising: value }))
  const res = await client.mutate(cid, "campaigns", ops, { partialFailure: true, validateOnly: !!opts.dryRun })
  const failed = new Set(res.failures.map((f) => f.index).filter((i): i is number => i !== null))
  if (res.failures.length && (failed.size >= ops.length || res.failures.some((f) => f.index === null))) throw failuresToError(res.failures)
  const warnings = [
    ...videoWarnings,
    ...res.failures.map((f) => redactString(`Lỗi chiến dịch ${f.index !== null ? str(rows[f.index], "campaign.id") : "?"}: ${f.message}`)),
  ]
  if (input.contains_eu_political_advertising) warnings.push("Chiến dịch khai báo CÓ quảng cáo chính trị EU có thể bị hạn chế phân phát tại EU.")
  return {
    preview: !!opts.dryRun,
    changes: rows
      .filter((_, i) => !failed.has(i))
      .map((r) => ({
        objectId: str(r, "campaign.id")!,
        objectName: str(r, "campaign.name"),
        level: "campaign" as const,
        field: "contains_eu_political_advertising",
        before: str(r, "campaign.contains_eu_political_advertising"),
        after: value,
      })),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// google_ads_run_gaql (read-only)
// ---------------------------------------------------------------------------

/** Remove string literals and comments so keyword checks cannot be fooled. */
function stripLiterals(q: string): string {
  return q.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''")
}

// Remove block comments, "--" and "//" line comments that are outside string literals.
export function stripComments(q: string): string {
  let out = ""
  let i = 0
  while (i < q.length) {
    const ch = q[i]!
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < q.length && q[j] !== ch) j += q[j] === "\\" ? 2 : 1
      out += q.slice(i, j + 1)
      i = j + 1
    } else if (q.startsWith("/*", i)) {
      const end = q.indexOf("*/", i + 2)
      out += " "
      i = end === -1 ? q.length : end + 2
    } else if (q.startsWith("--", i) || q.startsWith("//", i)) {
      const end = q.indexOf("\n", i)
      out += " "
      i = end === -1 ? q.length : end
    } else {
      out += ch
      i++
    }
  }
  return out.trim()
}

/** Only a single SELECT statement is allowed. Returns the query to send (comments stripped). */
export function assertSelectOnly(raw: string): string {
  const q = stripComments(raw)
  if (!/^select\s/i.test(q)) {
    throw invalidRequest("Only SELECT queries are allowed", "google_ads_run_gaql chỉ chấp nhận câu truy vấn bắt đầu bằng SELECT (chỉ đọc).")
  }
  const bare = stripLiterals(q)
  if (bare.includes(";")) throw invalidRequest("Multiple statements", "Chỉ được gửi 1 câu truy vấn (không dùng dấu ;).")
  if (!/\sfrom\s+[a-z_]+/i.test(bare)) throw invalidRequest("Missing FROM", "Câu truy vấn GAQL cần mệnh đề FROM <resource>.")
  // account-hierarchy / user resources would let a grant on one account enumerate accounts and users
  // outside the MCP's scope (via the manager's links)
  const lower = bare.toLowerCase()
  for (const r of GAQL_FORBIDDEN_RESOURCES) {
    if (new RegExp(`(^|[^a-z_.])${r}(\\.|\\s|$)`).test(lower)) {
      throw invalidRequest(
        `Resource ${r} is not allowed`,
        `google_ads_run_gaql không cho truy vấn ${r} (danh sách tài khoản/người dùng ngoài phạm vi MCP).`
      )
    }
  }
  return q
}

/** Resources that describe other accounts or users (hierarchy, links, access) - never queryable via MCP. */
export const GAQL_FORBIDDEN_RESOURCES = [
  "customer_client",
  "customer_client_link",
  "customer_manager_link",
  "customer_user_access",
  "customer_user_access_invitation",
  "account_link",
] as const

/** Refuse manager (MCC) accounts: their GAQL scope spans every linked client account. */
async function assertNotManager(ctx: GCtx, cid: string): Promise<void> {
  const meta = ctx.connectionMeta ?? {}
  const managerIds = Array.isArray(meta.manager_ids) ? meta.manager_ids.map(String) : []
  const creds = ctx.credentials as { login_customer_id?: string | null }
  const known = managerIds.includes(cid) || (creds.login_customer_id ? String(creds.login_customer_id).replace(/-/g, "") === cid : false)
  let manager = known
  if (!manager) {
    const page = await clientFor(ctx).search(cid, "SELECT customer.id, customer.manager FROM customer LIMIT 1", null)
    manager = page.results.some((r) => (r as { customer?: { manager?: unknown } }).customer?.manager === true)
  }
  if (manager) {
    throw invalidRequest(
      "GAQL on manager account",
      "Không chạy GAQL trên tài khoản người quản lý (MCC): phạm vi của nó gồm cả các tài khoản ngoài MCP. Chọn một tài khoản quảng cáo con."
    )
  }
}

export const runGaqlInput = z.object({
  query: z.string().min(10).max(20_000).describe("Câu GAQL dạng SELECT … FROM … WHERE … (chỉ đọc)"),
  max_rows: z.number().int().min(1).max(1000).default(200),
  cursor: z.string().max(4_000).optional().describe("next_cursor từ lần gọi trước"),
})

async function runGaql(ctx: GCtx, input: z.infer<typeof runGaqlInput>) {
  const cid = customerIdOf(ctx)
  const query = assertSelectOnly(input.query)
  const cur = decodeCursor(input.cursor, query)
  await assertNotManager(ctx, cid)
  const page = await clientFor(ctx).search(cid, query, cur.pt)
  const { items, nextCursor } = slicePage(page.results, cur, page.nextPageToken, input.max_rows, query)
  return {
    rows: items,
    row_count: items.length,
    next_cursor: nextCursor,
    field_mask: page.fieldMask,
    currency: ctx.account.currency,
    timezone: ctx.account.timezone,
    note: "Giá trị *_micros là micros (chia 1.000.000 để ra đơn vị chính); số int64 trả về dạng chuỗi; giá trị 0 thường bị bỏ khỏi JSON.",
  }
}

// ---------------------------------------------------------------------------
// google_ads_add_youtube_video (YoutubeVideoAsset from a YouTube URL / id - no file upload)
// ---------------------------------------------------------------------------

export const addYoutubeVideoInput = z.object({
  video: z
    .string()
    .trim()
    .min(11)
    .max(300)
    .describe("Link YouTube (youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…) hoặc ID video 11 ký tự"),
  name: z.string().trim().max(128).optional().describe("Tên asset (mặc định: YouTube <id>)"),
})

async function runAddYoutubeVideo(ctx: GCtx, input: z.infer<typeof addYoutubeVideoInput>, opts: MutationOptions): Promise<MutationResult> {
  const res = await createYoutubeVideoAsset(ctx, input, { dryRun: opts.dryRun })
  const url = youtubeWatchUrl(res.youtubeVideoId)
  const warnings = [
    "Video phải ở chế độ Công khai hoặc Không công khai trên YouTube (video Riêng tư không chạy được quảng cáo).",
    ...(res.existing ? ["Tài khoản đã có asset cho video này - dùng lại asset có sẵn, không tạo mới."] : []),
  ]
  const id = res.resourceName ?? "(mới)"
  return {
    preview: !!opts.dryRun,
    changes: [{ objectId: id, objectName: input.name ?? `YouTube ${res.youtubeVideoId}`, field: "youtube_video_asset", before: null, after: url }],
    warnings,
    createdIds: res.resourceName && !res.existing && !opts.dryRun ? [res.resourceName] : [],
  }
}

/** Money of google_ads_create_search_campaign for the MCP caps (MAJOR units). */
export function searchCampaignMoney(input: CreateSearchCampaignInput): ExtensionMoneyItem[] {
  const items: ExtensionMoneyItem[] = [{ kind: "daily_budget", amount: input.daily_budget, field: "daily_budget" }]
  if (input.max_cpc_bid_limit !== undefined) items.push({ kind: "bid", amount: input.max_cpc_bid_limit, field: "max_cpc_bid_limit" })
  if (input.target_cpa !== undefined) items.push({ kind: "bid", amount: input.target_cpa, field: "target_cpa" })
  input.ad_groups.forEach((g, i) => {
    if (g.cpc_bid !== undefined) items.push({ kind: "bid", amount: g.cpc_bid, field: `ad_groups[${i}].cpc_bid` })
  })
  return items
}

// ---------------------------------------------------------------------------

type Ext = ProviderExtension<GoogleAdsCredentials>

export const googleAdsExtensions: Ext[] = [
  {
    name: "google_ads_create_search_campaign",
    permission: "create",
    title: "Tạo chiến dịch Tìm kiếm Google",
    description:
      "Dùng khi cần tạo trọn bộ một chiến dịch Google Search: ngân sách ngày → chiến dịch → vị trí → nhóm quảng cáo → quảng cáo RSA → từ khóa (và phủ định), tất cả trong 1 lần ghi nguyên khối (lỗi thì không tạo gì). " +
      "Chiến dịch luôn được tạo ở trạng thái TẠM DỪNG và tự khai báo quảng cáo chính trị EU. Tiền theo đơn vị chính của tiền tệ tài khoản. " +
      "Không nhắm mục tiêu ngôn ngữ (từ 30/09/2026 Google tự xác định ngôn ngữ cho chiến dịch Tìm kiếm). " +
      "Gọi trước: ads_list_accounts (account_id, tiền tệ), ads_lookup kind=locations để lấy ID vị trí. " +
      "Cần location_ids hoặc proximities (bán kính quanh tọa độ); tùy chọn positive_geo_target_type (PRESENCE = chỉ người ở khu vực, bỏ trống = mặc định Google PRESENCE_OR_INTEREST) và ad_schedules (≤6 khung/ngày, giờ theo múi giờ tài khoản). " +
      "RSA: 3–15 tiêu đề ≤30 ký tự, 2–4 mô tả ≤90 ký tự. Chiến lược giá thầu: manual_cpc (cần cpc_bid từng nhóm), maximize_clicks (tùy chọn trần CPC), maximize_conversions (tùy chọn target_cpa).",
    input: createSearchCampaignInput,
    write: true,
    moneyOf: (input: CreateSearchCampaignInput) => searchCampaignMoney(input),
    run: (ctx, input: CreateSearchCampaignInput, opts) => runCreateSearchCampaign(ctx, input, opts),
  },
  {
    name: "google_ads_create_rsa",
    permission: "create",
    title: "Thêm quảng cáo RSA",
    description:
      "Dùng khi cần thêm một quảng cáo tìm kiếm thích ứng (RSA) vào nhóm quảng cáo Search có sẵn. Quảng cáo mới ở trạng thái TẠM DỪNG. " +
      "Gọi trước: ads_list_objects level=ad_group để lấy ad_group_id. 3–15 tiêu đề ≤30 ký tự, 2–4 mô tả ≤90 ký tự, path1/path2 ≤15 ký tự.",
    input: createRsaInput,
    write: true,
    run: (ctx, input: z.infer<typeof createRsaInput>, opts) => runCreateRsa(ctx, input, opts),
  },
  {
    name: "google_ads_add_keywords",
    permission: "create",
    title: "Thêm từ khóa Google Ads",
    description:
      "Dùng khi cần thêm từ khóa (EXACT/PHRASE/BROAD) hoặc từ khóa phủ định vào nhóm quảng cáo, hoặc từ khóa phủ định cấp chiến dịch (chỉ truyền campaign_id). " +
      "Từ khóa thường mới ở trạng thái TẠM DỪNG; giá thầu theo đơn vị chính. Từ khóa ≤80 ký tự, ≤10 từ. Gọi trước: ads_list_objects để lấy ad_group_id/campaign_id.",
    input: addKeywordsInput,
    write: true,
    moneyOf: (input: z.infer<typeof addKeywordsInput>) =>
      input.keywords.flatMap((k, i): ExtensionMoneyItem[] => (k.cpc_bid !== undefined ? [{ kind: "bid", amount: k.cpc_bid, field: `keywords[${i}].cpc_bid` }] : [])),
    run: (ctx, input: z.infer<typeof addKeywordsInput>, opts) => runAddKeywords(ctx, input, opts),
  },
  ...campaignTargetingExtensions,
  ...googleAdsAssetExtensions,
  {
    name: "google_ads_declare_eu_political",
    permission: "update",
    title: "Khai báo quảng cáo chính trị EU",
    description:
      "Dùng khi Google Ads báo lỗi EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED (chặn mọi thay đổi chiến dịch) hoặc để khai báo hàng loạt các chiến dịch còn thiếu khai báo có/không chứa quảng cáo chính trị nhắm tới EU. " +
      "Bắt buộc truyền rõ contains_eu_political_advertising (true/false) - hỏi người dùng, không tự chọn. Chỉ đổi các chiến dịch đang thiếu khai báo; có thể giới hạn bằng campaign_ids.",
    input: declareEuInput,
    write: true,
    run: (ctx, input: z.infer<typeof declareEuInput>, opts) => runDeclareEu(ctx, input, opts),
  },
  {
    name: "google_ads_add_youtube_video",
    permission: "create",
    title: "Thêm video YouTube vào Google Ads",
    description:
      "Dùng khi cần đưa một video YouTube vào thư viện asset của tài khoản Google Ads (để dùng cho quảng cáo YouTube / Demand Gen). " +
      "Nhận link YouTube (watch, youtu.be, shorts) hoặc ID video 11 ký tự - không tải file lên; video phải đăng trên YouTube trước (Công khai hoặc Không công khai). " +
      "Nếu tài khoản đã có asset của video đó thì dùng lại. Trả về resource name asset (customers/…/assets/…). Gọi trước: ads_list_accounts.",
    input: addYoutubeVideoInput,
    write: true,
    run: (ctx, input: z.infer<typeof addYoutubeVideoInput>, opts) => runAddYoutubeVideo(ctx, input, opts),
  },
  {
    name: "google_ads_run_gaql",
    permission: "read",
    title: "Chạy truy vấn GAQL",
    description:
      "Dùng khi các tool báo cáo chung không đủ (vd search_term_view, segments.device, change_event) và cần chạy một câu Google Ads Query Language chỉ đọc. " +
      "Chỉ chấp nhận SELECT … FROM …; tối đa 1000 dòng mỗi lần, có next_cursor. Kết quả là JSON gốc của Google: tiền dạng *_micros (chia 1.000.000), ngày theo múi giờ tài khoản, giá trị 0 có thể bị bỏ. " +
      "Không truy vấn metrics trên tài khoản người quản lý (MCC). Gọi trước: ads_list_accounts.",
    input: runGaqlInput,
    write: false,
    run: (ctx, input: z.infer<typeof runGaqlInput>) => runGaql(ctx, input),
  },
]

