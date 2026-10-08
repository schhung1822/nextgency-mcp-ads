// Emulated copy for Google Ads (there is no copy endpoint): read the tree with GAQL, strip output-only fields and
// re-create everything in ONE atomic googleAds:mutate using negative temp ids (parents before children).
// Copies are always created PAUSED at the root; children keep their source status (they cannot serve while the root
// is paused). New ads are created (v23+: ads cannot be shared between ad groups).
// Fail closed: targeting/exclusions that cannot be re-created (audiences, proximity, IP blocks, placements…), a missing
// EU political-ads declaration or a truncated read stop the copy with a Vietnamese error instead of silently producing
// a campaign that targets more broadly than the source. `CopyRequest.allowIncomplete` opts in to a partial copy.
import { ProviderError, isProviderError } from "../errors"
import { addDays, todayInTz } from "../dates"
import type { CopyMapping, CopyRequest, CopyResult, MutationOptions, ObjectLevel } from "../types"
import { field, resourceId, str, type GoogleAdsClient, type GoogleAdsRow } from "./client"
import { clientFor, customerIdOf, invalidRequest, notFound, type GCtx } from "./context"
import { assertId, escapeLike, gaqlString, idList } from "./gaql"
import { isOpenEnded } from "./time"
import { assertNotVideo, videoReadOnlyError } from "./youtube"

export const MAX_COPY_ADS = 50
export const DEFAULT_COPY_SUFFIX = " (bản sao)"

const CAMPAIGN_COPY_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.advertising_channel_type",
  "campaign.advertising_channel_sub_type",
  "campaign.bidding_strategy_type",
  "campaign.bidding_strategy",
  "campaign.manual_cpc.enhanced_cpc_enabled",
  "campaign.maximize_conversions.target_cpa_micros",
  "campaign.maximize_conversion_value.target_roas",
  "campaign.target_spend.cpc_bid_ceiling_micros",
  "campaign.target_cpa.target_cpa_micros",
  "campaign.target_roas.target_roas",
  "campaign.target_impression_share.location",
  "campaign.target_impression_share.location_fraction_micros",
  "campaign.target_impression_share.cpc_bid_ceiling_micros",
  "campaign.network_settings.target_google_search",
  "campaign.network_settings.target_search_network",
  "campaign.network_settings.target_content_network",
  "campaign.network_settings.target_partner_search_network",
  "campaign.geo_target_type_setting.positive_geo_target_type",
  "campaign.geo_target_type_setting.negative_geo_target_type",
  "campaign.start_date_time",
  "campaign.end_date_time",
  "campaign.contains_eu_political_advertising",
  "campaign.tracking_url_template",
  "campaign.final_url_suffix",
  "campaign_budget.id",
  "campaign_budget.amount_micros",
  "campaign_budget.total_amount_micros",
  "campaign_budget.period",
  "campaign_budget.delivery_method",
  "campaign_budget.explicitly_shared",
]

const CRITERION_COPY_FIELDS = [
  "campaign_criterion.criterion_id",
  "campaign_criterion.type",
  "campaign_criterion.negative",
  "campaign_criterion.bid_modifier",
  "campaign_criterion.location.geo_target_constant",
  "campaign_criterion.language.language_constant",
  "campaign_criterion.keyword.text",
  "campaign_criterion.keyword.match_type",
  "campaign_criterion.ad_schedule.day_of_week",
  "campaign_criterion.ad_schedule.start_hour",
  "campaign_criterion.ad_schedule.start_minute",
  "campaign_criterion.ad_schedule.end_hour",
  "campaign_criterion.ad_schedule.end_minute",
  "campaign_criterion.device.type",
]

const SHARED_SET_COPY_FIELDS = [
  "campaign_shared_set.shared_set",
  "campaign_shared_set.status",
  "shared_set.id",
  "shared_set.name",
  "shared_set.type",
  "shared_set.status",
]

const AD_GROUP_COPY_FIELDS = [
  "campaign.id",
  "campaign.advertising_channel_type",
  "ad_group.id",
  "ad_group.name",
  "ad_group.status",
  "ad_group.type",
  "ad_group.cpc_bid_micros",
  "ad_group.target_cpa_micros",
  "ad_group.ad_rotation_mode",
  "ad_group.tracking_url_template",
  "ad_group.final_url_suffix",
]

const KEYWORD_COPY_FIELDS = [
  "ad_group.id",
  "ad_group_criterion.criterion_id",
  "ad_group_criterion.type",
  "ad_group_criterion.status",
  "ad_group_criterion.negative",
  "ad_group_criterion.keyword.text",
  "ad_group_criterion.keyword.match_type",
  "ad_group_criterion.cpc_bid_micros",
  "ad_group_criterion.final_urls",
]

const AD_COPY_FIELDS = [
  "campaign.id",
  "campaign.advertising_channel_type",
  "ad_group.id",
  "ad_group_ad.status",
  "ad_group_ad.ad.id",
  "ad_group_ad.ad.type",
  "ad_group_ad.ad.final_urls",
  "ad_group_ad.ad.final_mobile_urls",
  "ad_group_ad.ad.tracking_url_template",
  "ad_group_ad.ad.final_url_suffix",
  "ad_group_ad.ad.responsive_search_ad.headlines",
  "ad_group_ad.ad.responsive_search_ad.descriptions",
  "ad_group_ad.ad.responsive_search_ad.path1",
  "ad_group_ad.ad.responsive_search_ad.path2",
]

// ---------------------------------------------------------------------------
// Pure builders (unit-tested)
// ---------------------------------------------------------------------------

export class TempIds {
  private n = 0
  next(): string {
    this.n -= 1
    return String(this.n)
  }
}

export interface PlanEntry {
  index: number
  level: ObjectLevel | "budget" | "campaign_criterion"
  sourceId: string
}

export interface CopyPlan {
  ops: Record<string, unknown>[]
  entries: PlanEntry[]
  warnings: string[]
  /** targeting/exclusions that could not be re-created (fail closed unless allowIncomplete) */
  uncopyable: string[]
  rootLevel: ObjectLevel
  rootName: string
  rootIndex: number
}

export function copyName(name: string, prefix?: string, suffix?: string): string {
  const p = prefix ?? ""
  const s = suffix ?? ""
  const out = !p && !s ? `${name}${DEFAULT_COPY_SUFFIX}` : `${p}${name}${s}`
  return out.slice(0, 255)
}

export function uniqueName(desired: string, existing: Set<string>): string {
  if (!existing.has(desired)) return desired
  for (let i = 2; i < 1000; i++) {
    const cand = `${desired} ${i}`.slice(0, 255)
    if (!existing.has(cand)) return cand
  }
  return `${desired} ${Date.now().toString(36)}`.slice(0, 255)
}

const nonEmpty = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => nonEmpty(v))) as T
}

/** Whole days from date `a` to date `b` ("yyyy-MM-dd"). */
function dayDiff(a: string, b: string): number {
  const d = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  return Number.isFinite(d) ? Math.round(d) : 0
}

export function unsupportedChannel(channel: string | null): ProviderError {
  if (channel === "VIDEO") return videoReadOnlyError("copy")
  if (channel === "PERFORMANCE_MAX") {
    return new ProviderError({
      platform: "google_ads",
      code: "unsupported",
      message: "Copying Performance Max campaigns is not supported",
      userMessageVi:
        "Chưa hỗ trợ sao chép chiến dịch Performance Max (cần asset group, asset tối thiểu và brand guidelines). Hãy sao chép trong giao diện Google Ads.",
    })
  }
  return new ProviderError({
    platform: "google_ads",
    code: "unsupported",
    message: `Copying ${channel} campaigns is not supported`,
    userMessageVi: `Hiện chỉ hỗ trợ sao chép chiến dịch Tìm kiếm (Search); chiến dịch loại ${channel ?? "không rõ"} chưa được hỗ trợ.`,
  })
}

export function biddingFor(row: GoogleAdsRow, warnings: string[]): Record<string, unknown> {
  const portfolio = str(row, "campaign.bidding_strategy")
  if (portfolio) return { biddingStrategy: portfolio }
  const type = str(row, "campaign.bidding_strategy_type")
  switch (type) {
    case "MANUAL_CPC":
      if (field(row, "campaign.manual_cpc.enhanced_cpc_enabled") === true) warnings.push("Enhanced CPC đã bị Google ngừng hỗ trợ - bản sao dùng Manual CPC thường.")
      return { manualCpc: {} }
    case "MAXIMIZE_CONVERSIONS":
    case "TARGET_CPA": {
      const t = str(row, "campaign.maximize_conversions.target_cpa_micros") ?? str(row, "campaign.target_cpa.target_cpa_micros")
      return { maximizeConversions: compact({ targetCpaMicros: t }) }
    }
    case "MAXIMIZE_CONVERSION_VALUE":
    case "TARGET_ROAS": {
      const r = field(row, "campaign.maximize_conversion_value.target_roas") ?? field(row, "campaign.target_roas.target_roas")
      return { maximizeConversionValue: compact({ targetRoas: r }) }
    }
    case "TARGET_SPEND":
      return { targetSpend: compact({ cpcBidCeilingMicros: str(row, "campaign.target_spend.cpc_bid_ceiling_micros") }) }
    case "TARGET_IMPRESSION_SHARE":
      return {
        targetImpressionShare: compact({
          location: str(row, "campaign.target_impression_share.location"),
          locationFractionMicros: str(row, "campaign.target_impression_share.location_fraction_micros"),
          cpcBidCeilingMicros: str(row, "campaign.target_impression_share.cpc_bid_ceiling_micros"),
        }),
      }
    default:
      throw new ProviderError({
        platform: "google_ads",
        code: "unsupported",
        message: `Bidding strategy ${type} cannot be copied`,
        userMessageVi: `Chưa hỗ trợ sao chép chiến lược giá thầu ${type ?? "không rõ"}.`,
      })
  }
}

function textAssets(v: unknown): { text: string; pinnedField?: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => {
      const o = x as { text?: string; pinnedField?: string }
      const out: { text: string; pinnedField?: string } = { text: o.text ?? "" }
      if (o.pinnedField && o.pinnedField !== "UNSPECIFIED" && o.pinnedField !== "UNKNOWN") out.pinnedField = o.pinnedField
      return out
    })
    .filter((x) => x.text)
}

function childStatus(s: string | null): "ENABLED" | "PAUSED" {
  return s === "ENABLED" ? "ENABLED" : "PAUSED"
}

/** Ad group create op + its keywords + ads (in that order). */
function addAdGroupOps(
  plan: CopyPlan,
  cid: string,
  tmp: TempIds,
  campaignRn: string,
  ag: GoogleAdsRow,
  keywords: GoogleAdsRow[],
  ads: GoogleAdsRow[],
  o: { name: string; status: "ENABLED" | "PAUSED" }
): void {
  const agId = str(ag, "ad_group.id")!
  const agRn = `customers/${cid}/adGroups/${tmp.next()}`
  plan.entries.push({ index: plan.ops.length, level: "ad_group", sourceId: agId })
  plan.ops.push({
    adGroupOperation: {
      create: compact({
        resourceName: agRn,
        campaign: campaignRn,
        name: o.name,
        status: o.status,
        type: str(ag, "ad_group.type") ?? "SEARCH_STANDARD",
        cpcBidMicros: str(ag, "ad_group.cpc_bid_micros"),
        targetCpaMicros: str(ag, "ad_group.target_cpa_micros"),
        adRotationMode: str(ag, "ad_group.ad_rotation_mode"),
        trackingUrlTemplate: str(ag, "ad_group.tracking_url_template"),
        finalUrlSuffix: str(ag, "ad_group.final_url_suffix"),
      }),
    },
  })
  const skippedTypes = new Map<string, number>()
  for (const k of keywords) {
    const type = str(k, "ad_group_criterion.type")
    if (type !== "KEYWORD") {
      skippedTypes.set(type ?? "?", (skippedTypes.get(type ?? "?") ?? 0) + 1)
      continue
    }
    const negative = field(k, "ad_group_criterion.negative") === true
    plan.entries.push({ index: plan.ops.length, level: "keyword", sourceId: `${agId}~${str(k, "ad_group_criterion.criterion_id")}` })
    plan.ops.push({
      adGroupCriterionOperation: {
        create: compact({
          adGroup: agRn,
          status: negative ? undefined : childStatus(str(k, "ad_group_criterion.status")),
          negative: negative ? true : undefined,
          keyword: { text: str(k, "ad_group_criterion.keyword.text"), matchType: str(k, "ad_group_criterion.keyword.match_type") },
          cpcBidMicros: negative ? undefined : str(k, "ad_group_criterion.cpc_bid_micros"),
          finalUrls: negative ? undefined : (field(k, "ad_group_criterion.final_urls") as string[] | undefined),
        }),
      },
    })
  }
  for (const [t, n] of skippedTypes) plan.uncopyable.push(`${n} tiêu chí loại ${t} của nhóm “${o.name}”`)
  for (const a of ads) addAdOp(plan, tmp, agRn, a, childStatus(str(a, "ad_group_ad.status")))
}

function addAdOp(plan: CopyPlan, _tmp: TempIds, adGroupRn: string, a: GoogleAdsRow, status: "ENABLED" | "PAUSED"): boolean {
  const adId = str(a, "ad_group_ad.ad.id")
  const type = str(a, "ad_group_ad.ad.type")
  const key = `${str(a, "ad_group.id")}~${adId}`
  if (type !== "RESPONSIVE_SEARCH_AD") {
    plan.warnings.push(`Bỏ qua quảng cáo ${key} loại ${type ?? "?"} (chỉ sao chép quảng cáo RSA).`)
    return false
  }
  plan.entries.push({ index: plan.ops.length, level: "ad", sourceId: key })
  plan.ops.push({
    adGroupAdOperation: {
      create: {
        adGroup: adGroupRn,
        status,
        ad: compact({
          finalUrls: field(a, "ad_group_ad.ad.final_urls") as string[] | undefined,
          finalMobileUrls: field(a, "ad_group_ad.ad.final_mobile_urls") as string[] | undefined,
          trackingUrlTemplate: str(a, "ad_group_ad.ad.tracking_url_template"),
          finalUrlSuffix: str(a, "ad_group_ad.ad.final_url_suffix"),
          responsiveSearchAd: compact({
            headlines: textAssets(field(a, "ad_group_ad.ad.responsive_search_ad.headlines")),
            descriptions: textAssets(field(a, "ad_group_ad.ad.responsive_search_ad.descriptions")),
            path1: str(a, "ad_group_ad.ad.responsive_search_ad.path1"),
            path2: str(a, "ad_group_ad.ad.responsive_search_ad.path2"),
          }),
        }),
      },
    },
  })
  return true
}

export interface CampaignSource {
  campaign: GoogleAdsRow
  criteria: GoogleAdsRow[]
  adGroups: GoogleAdsRow[]
  keywords: GoogleAdsRow[]
  ads: GoogleAdsRow[]
  /** campaign_shared_set rows (negative keyword lists…) attached to the source */
  sharedSets?: GoogleAdsRow[]
}

/** Fail closed when targeting/exclusions would be silently dropped, unless the caller explicitly accepted it. */
export function finalizeIncomplete(plan: CopyPlan, allowIncomplete: boolean): void {
  if (!plan.uncopyable.length) return
  const list = plan.uncopyable.join("; ")
  if (!allowIncomplete) {
    throw new ProviderError({
      platform: "google_ads",
      code: "invalid_request",
      message: `Copy would drop targeting/exclusions: ${list}`,
      userMessageVi: `Không sao chép được đầy đủ nhắm mục tiêu/loại trừ: ${list}. Bản sao sẽ nhắm rộng hơn bản gốc nên đã dừng (chưa tạo gì).`,
      hint: "Thêm lại các tiêu chí này thủ công sau khi sao chép, rồi gọi lại với allow_incomplete_targeting=true để chấp nhận bản sao thiếu.",
    })
  }
  plan.warnings.push(`Đã bỏ qua (allow_incomplete_targeting=true): ${list} - bản sao nhắm rộng hơn bản gốc, hãy thêm lại thủ công trước khi bật.`)
}

export function euNotDeclared(campaignId: string): ProviderError {
  return new ProviderError({
    platform: "google_ads",
    code: "invalid_request",
    message: `Source campaign ${campaignId} has no EU political advertising declaration`,
    userMessageVi:
      "Chiến dịch gốc chưa khai báo có/không chứa quảng cáo chính trị nhắm tới EU - app không tự khai báo thay bạn.",
    hint: `Gọi google_ads_declare_eu_political với campaign_ids=["${campaignId}"] và chọn rõ contains_eu_political_advertising (hỏi người dùng), rồi sao chép lại.`,
  })
}

export function buildCampaignCopy(
  cid: string,
  src: CampaignSource,
  o: { name: string; today: string; deep: boolean; budgetSuffix?: string; allowIncomplete?: boolean }
): CopyPlan {
  const c = src.campaign
  const channel = str(c, "campaign.advertising_channel_type")
  if (channel !== "SEARCH") throw unsupportedChannel(channel)
  const plan: CopyPlan = { ops: [], entries: [], warnings: [], uncopyable: [], rootLevel: "campaign", rootName: o.name, rootIndex: -1 }
  const tmp = new TempIds()

  // 1) budget: always a new, non-shared budget with the same amount
  const budgetRn = `customers/${cid}/campaignBudgets/${tmp.next()}`
  const period = str(c, "campaign_budget.period") ?? "DAILY"
  const lifetime = period === "CUSTOM_PERIOD"
  if (field(c, "campaign_budget.explicitly_shared") === true) {
    plan.warnings.push("Chiến dịch gốc dùng ngân sách chung (shared); bản sao được tạo ngân sách riêng với cùng số tiền.")
  }
  const amount = str(c, lifetime ? "campaign_budget.total_amount_micros" : "campaign_budget.amount_micros")
  if (!amount) throw invalidRequest("Source budget missing", "Không đọc được ngân sách của chiến dịch gốc.")
  plan.entries.push({ index: plan.ops.length, level: "budget", sourceId: str(c, "campaign_budget.id") ?? "" })
  plan.ops.push({
    campaignBudgetOperation: {
      create: compact({
        resourceName: budgetRn,
        name: `${o.name} - ngân sách ${o.budgetSuffix ?? Date.now().toString(36)}`.slice(0, 255),
        explicitlyShared: false,
        deliveryMethod: str(c, "campaign_budget.delivery_method") === "ACCELERATED" ? undefined : "STANDARD",
        period: lifetime ? "CUSTOM_PERIOD" : undefined,
        amountMicros: lifetime ? undefined : amount,
        totalAmountMicros: lifetime ? amount : undefined,
      }),
    },
  })

  // 2) campaign - PAUSED, EU declaration always present, start not in the past
  const warnings = plan.warnings
  const eu = str(c, "campaign.contains_eu_political_advertising")
  // Never declare on the user's behalf: the declaration is a legal statement.
  if (eu !== "CONTAINS_EU_POLITICAL_ADVERTISING" && eu !== "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING") {
    throw euNotDeclared(str(c, "campaign.id") ?? "?")
  }
  const srcStart = str(c, "campaign.start_date_time")
  const startDateTime = srcStart && srcStart.slice(0, 10) > o.today ? srcStart : `${o.today} 00:00:00`
  const srcEnd = str(c, "campaign.end_date_time")
  let endDateTime: string | undefined
  if (!isOpenEnded(srcEnd) && srcEnd) {
    const shift = srcStart ? dayDiff(srcStart.slice(0, 10), startDateTime.slice(0, 10)) : 0
    if (shift > 0) {
      // the start moved to today → move the end by the same number of days (same flight length, so a lifetime
      // budget is not squeezed into fewer days)
      endDateTime = `${addDays(srcEnd.slice(0, 10), shift)}${srcEnd.slice(10)}`
      warnings.push(
        `Ngày kết thúc của bản sao được dời thành ${endDateTime.slice(0, 10)} để giữ nguyên số ngày chạy như chiến dịch gốc (ngày gốc: ${srcEnd.slice(0, 10)}).`
      )
    } else if (srcEnd.slice(0, 10) >= startDateTime.slice(0, 10)) endDateTime = srcEnd
    else warnings.push(`Ngày kết thúc của chiến dịch gốc (${srcEnd.slice(0, 10)}) đã qua - bản sao không có ngày kết thúc.`)
  }
  if (lifetime && !endDateTime) {
    throw invalidRequest(
      "Lifetime budget copy needs an end date",
      "Chiến dịch gốc dùng ngân sách tổng nhưng ngày kết thúc đã qua; hãy sửa ngày kết thúc của chiến dịch gốc hoặc tạo chiến dịch mới."
    )
  }
  if (srcStart && startDateTime !== srcStart) warnings.push(`Ngày bắt đầu của bản sao được đặt là ${o.today} (ngày gốc đã qua).`)
  const campaignRn = `customers/${cid}/campaigns/${tmp.next()}`
  const subType = str(c, "campaign.advertising_channel_sub_type")
  plan.rootIndex = plan.ops.length
  plan.entries.push({ index: plan.ops.length, level: "campaign", sourceId: str(c, "campaign.id")! })
  plan.ops.push({
    campaignOperation: {
      create: compact({
        resourceName: campaignRn,
        name: o.name,
        status: "PAUSED",
        advertisingChannelType: channel,
        advertisingChannelSubType: subType && subType !== "UNSPECIFIED" && subType !== "UNKNOWN" ? subType : undefined,
        campaignBudget: budgetRn,
        ...biddingFor(c, warnings),
        networkSettings: {
          targetGoogleSearch: field(c, "campaign.network_settings.target_google_search") === true,
          targetSearchNetwork: field(c, "campaign.network_settings.target_search_network") === true,
          targetContentNetwork: field(c, "campaign.network_settings.target_content_network") === true,
          targetPartnerSearchNetwork: field(c, "campaign.network_settings.target_partner_search_network") === true,
        },
        geoTargetTypeSetting: compact({
          positiveGeoTargetType: str(c, "campaign.geo_target_type_setting.positive_geo_target_type"),
          negativeGeoTargetType: str(c, "campaign.geo_target_type_setting.negative_geo_target_type"),
        }),
        containsEuPoliticalAdvertising: eu,
        startDateTime,
        endDateTime,
        trackingUrlTemplate: str(c, "campaign.tracking_url_template"),
        finalUrlSuffix: str(c, "campaign.final_url_suffix"),
      }),
    },
  })
  const camp = plan.ops[plan.ops.length - 1]!.campaignOperation as { create: Record<string, unknown> }
  if (camp.create.geoTargetTypeSetting && !Object.keys(camp.create.geoTargetTypeSetting as object).length) delete camp.create.geoTargetTypeSetting

  // 3) campaign criteria: location, negative keywords, ad schedule, device bid modifiers (language: skipped)
  const skipped = new Map<string, number>()
  let languagesSkipped = 0
  for (const cr of src.criteria) {
    const type = str(cr, "campaign_criterion.type")
    const negative = field(cr, "campaign_criterion.negative") === true
    const bidModifier = field(cr, "campaign_criterion.bid_modifier")
    let body: Record<string, unknown> | null = null
    if (type === "LOCATION") {
      body = { location: { geoTargetConstant: str(cr, "campaign_criterion.location.geo_target_constant") } }
    } else if (type === "LANGUAGE") {
      // Search campaigns no longer accept manual language targeting (ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT
      // since 2026-09-30): skip with a warning - Google infers the language, so this is not "incomplete targeting".
      languagesSkipped++
      continue
    } else if (type === "KEYWORD" && negative) {
      body = { keyword: { text: str(cr, "campaign_criterion.keyword.text"), matchType: str(cr, "campaign_criterion.keyword.match_type") } }
    } else if (type === "AD_SCHEDULE") {
      body = {
        adSchedule: compact({
          dayOfWeek: str(cr, "campaign_criterion.ad_schedule.day_of_week"),
          startHour: field(cr, "campaign_criterion.ad_schedule.start_hour") ?? 0,
          startMinute: str(cr, "campaign_criterion.ad_schedule.start_minute") ?? "ZERO",
          endHour: field(cr, "campaign_criterion.ad_schedule.end_hour") ?? 24,
          endMinute: str(cr, "campaign_criterion.ad_schedule.end_minute") ?? "ZERO",
        }),
      }
    } else if (type === "DEVICE") {
      // bid_modifier 0 = device excluded (-100%) - must be copied; absent / 1.0 = no adjustment → nothing to create
      if (typeof bidModifier !== "number" || bidModifier === 1) continue
      const deviceType = str(cr, "campaign_criterion.device.type")
      if (!deviceType) {
        skipped.set("DEVICE", (skipped.get("DEVICE") ?? 0) + 1)
        continue
      }
      body = { device: { type: deviceType } }
    }
    if (!body) {
      skipped.set(type ?? "?", (skipped.get(type ?? "?") ?? 0) + 1)
      continue
    }
    plan.entries.push({ index: plan.ops.length, level: "campaign_criterion", sourceId: str(cr, "campaign_criterion.criterion_id") ?? "" })
    plan.ops.push({
      campaignCriterionOperation: {
        create: compact({
          campaign: campaignRn,
          ...body,
          negative: negative ? true : undefined,
          bidModifier: !negative && typeof bidModifier === "number" && bidModifier !== 1 && type !== "LANGUAGE" ? bidModifier : undefined,
        }),
      },
    })
  }
  // PROXIMITY, LOCATION_GROUP, USER_LIST, IP_BLOCK, negative PLACEMENT/CONTENT_LABEL, BRAND_LIST… cannot be re-created
  for (const [t, n] of skipped) plan.uncopyable.push(`${n} tiêu chí chiến dịch loại ${t}`)
  if (languagesSkipped) {
    plan.warnings.push(
      `Đã bỏ qua ${languagesSkipped} tiêu chí ngôn ngữ: từ 30/09/2026 chiến dịch Tìm kiếm không còn nhắm mục tiêu ngôn ngữ thủ công (Google tự xác định ngôn ngữ).`
    )
  }

  // 3b) shared sets (negative keyword lists…) are linked, not copied - same account
  for (const ss of src.sharedSets ?? []) {
    const rn = str(ss, "campaign_shared_set.shared_set")
    if (!rn || str(ss, "campaign_shared_set.status") !== "ENABLED" || (str(ss, "shared_set.status") ?? "ENABLED") !== "ENABLED") continue
    plan.ops.push({ campaignSharedSetOperation: { create: { campaign: campaignRn, sharedSet: rn } } })
  }
  if (!src.criteria.some((cr) => str(cr, "campaign_criterion.type") === "LOCATION")) {
    warnings.push("Chiến dịch gốc không giới hạn vị trí - bản sao cũng nhắm mọi quốc gia.")
  }

  // 4) ad groups + keywords + ads
  if (o.deep) {
    for (const ag of src.adGroups) {
      const agId = str(ag, "ad_group.id")!
      const type = str(ag, "ad_group.type")
      if (type && type !== "SEARCH_STANDARD") {
        warnings.push(`Bỏ qua nhóm “${str(ag, "ad_group.name")}” loại ${type} (chỉ sao chép nhóm Search tiêu chuẩn).`)
        continue
      }
      addAdGroupOps(
        plan,
        cid,
        tmp,
        campaignRn,
        ag,
        src.keywords.filter((k) => str(k, "ad_group.id") === agId),
        src.ads.filter((a) => str(a, "ad_group.id") === agId),
        { name: str(ag, "ad_group.name") ?? `Ad group ${agId}`, status: childStatus(str(ag, "ad_group.status")) }
      )
    }
  }
  finalizeIncomplete(plan, !!o.allowIncomplete)
  return plan
}

export function buildAdGroupCopy(
  cid: string,
  targetCampaignId: string,
  ag: GoogleAdsRow,
  keywords: GoogleAdsRow[],
  ads: GoogleAdsRow[],
  o: { name: string; deep: boolean; allowIncomplete?: boolean }
): CopyPlan {
  const plan: CopyPlan = { ops: [], entries: [], warnings: [], uncopyable: [], rootLevel: "ad_group", rootName: o.name, rootIndex: 0 }
  const type = str(ag, "ad_group.type")
  if (type && type !== "SEARCH_STANDARD") throw unsupportedChannel(str(ag, "campaign.advertising_channel_type"))
  // deep=false still checks non-keyword targeting criteria (audiences…): they belong to the ad group itself
  const criteria = o.deep ? keywords : keywords.filter((k) => str(k, "ad_group_criterion.type") !== "KEYWORD")
  addAdGroupOps(plan, cid, new TempIds(), `customers/${cid}/campaigns/${targetCampaignId}`, ag, criteria, o.deep ? ads : [], {
    name: o.name,
    status: "PAUSED",
  })
  finalizeIncomplete(plan, !!o.allowIncomplete)
  return plan
}

export function buildAdCopy(cid: string, targetAdGroupId: string, ad: GoogleAdsRow): CopyPlan {
  const plan: CopyPlan = { ops: [], entries: [], warnings: [], uncopyable: [], rootLevel: "ad", rootName: "", rootIndex: 0 }
  if (!addAdOp(plan, new TempIds(), `customers/${cid}/adGroups/${targetAdGroupId}`, ad, "PAUSED")) {
    throw new ProviderError({
      platform: "google_ads",
      code: "unsupported",
      message: "Only responsive search ads can be copied",
      userMessageVi: "Chỉ hỗ trợ sao chép quảng cáo tìm kiếm thích ứng (RSA).",
    })
  }
  return plan
}

/** Extract resource names from mutateOperationResponses (one key like campaignResult per entry). */
export function responseResourceName(resp: Record<string, unknown> | undefined): string | null {
  if (!resp) return null
  for (const v of Object.values(resp)) {
    if (v && typeof v === "object" && typeof (v as { resourceName?: unknown }).resourceName === "string") {
      return (v as { resourceName: string }).resourceName
    }
  }
  return null
}

export function mappingsFrom(plan: CopyPlan, results: Record<string, unknown>[] | null): CopyMapping[] {
  return plan.entries
    .filter((e): e is PlanEntry & { level: ObjectLevel } => e.level === "campaign" || e.level === "ad_group" || e.level === "ad" || e.level === "keyword")
    .map((e) => ({ level: e.level, sourceId: e.sourceId, newId: results ? resourceId(responseResourceName(results[e.index])) : null }))
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** searchAll that refuses a truncated read (a silent partial copy would drop objects). */
async function readAll(client: GoogleAdsClient, cid: string, query: string, maxRows: number, whatVi: string): Promise<GoogleAdsRow[]> {
  const { rows, truncated } = await client.searchAll(cid, query, { maxRows })
  if (truncated) {
    throw invalidRequest(
      `Copy source too large: ${whatVi} > ${maxRows}`,
      `Đối tượng nguồn có quá nhiều ${whatVi} (>${maxRows}) - không sao chép một phần. Hãy sao chép từng nhóm quảng cáo.`
    )
  }
  return rows
}

/** Campaign-specific conversion goals are not copied (the copy uses account-level goals) → warn. */
async function conversionGoalWarning(client: GoogleAdsClient, cid: string, campaignId: string): Promise<string | null> {
  try {
    const { rows } = await client.searchAll(
      cid,
      `SELECT conversion_goal_campaign_config.goal_config_level FROM conversion_goal_campaign_config WHERE campaign.id = ${campaignId}`,
      { maxRows: 1 }
    )
    return rows.some((r) => str(r, "conversion_goal_campaign_config.goal_config_level") === "CAMPAIGN")
      ? "Chiến dịch gốc dùng mục tiêu chuyển đổi riêng cấp chiến dịch - bản sao dùng mục tiêu cấp tài khoản; hãy đặt lại mục tiêu chuyển đổi trước khi bật."
      : null
  } catch {
    return "Không kiểm tra được mục tiêu chuyển đổi của chiến dịch gốc - nếu chiến dịch gốc dùng mục tiêu riêng, hãy đặt lại cho bản sao."
  }
}

async function existingNames(client: GoogleAdsClient, cid: string, from: "campaign" | "ad_group", base: string, campaignId?: string): Promise<Set<string>> {
  const nameField = `${from}.name`
  const conds = [`${nameField} LIKE ${gaqlString(`${escapeLike(base)}%`)}`, `${from}.status != 'REMOVED'`]
  if (campaignId) conds.push(`campaign.id = ${assertId(campaignId)}`)
  const { rows } = await client.searchAll(cid, `SELECT ${nameField} FROM ${from} WHERE ${conds.join(" AND ")}`, { maxRows: 2_000 })
  return new Set(rows.map((r) => str(r, nameField) ?? ""))
}

async function runPlan(
  client: GoogleAdsClient,
  cid: string,
  plan: CopyPlan,
  opts: MutationOptions,
  recover: () => Promise<string | null>
): Promise<CopyResult> {
  if (opts.dryRun) {
    await client.googleAdsMutate(cid, plan.ops, { validateOnly: true })
    return { preview: true, mode: "emulated", rootNewId: null, mappings: mappingsFrom(plan, null), warnings: plan.warnings }
  }
  try {
    const res = await client.googleAdsMutate(cid, plan.ops, { idempotent: false })
    const mappings = mappingsFrom(plan, res.results)
    const root = resourceId(responseResourceName(res.results[plan.rootIndex]))
    return { preview: false, mode: "emulated", rootNewId: root, mappings, warnings: plan.warnings }
  } catch (e) {
    // No blind retry: after a timeout/5xx check whether the copy exists before reporting failure.
    if (isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")) {
      const found = await recover().catch(() => null)
      if (found) {
        return {
          preview: false,
          mode: "emulated",
          rootNewId: found,
          mappings: mappingsFrom(plan, null),
          warnings: [...plan.warnings, "Mất kết nối khi tạo nhưng bản sao đã được tạo trên Google Ads (không lấy được bảng map id chi tiết)."],
        }
      }
    }
    throw e
  }
}

export async function copyObject(ctx: GCtx, r: CopyRequest, opts: MutationOptions = {}): Promise<CopyResult> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const today = todayInTz(ctx.account.timezone)

  if (r.level === "campaign") {
    const id = assertId(r.id, "campaign_id")
    const c = (await client.searchAll(cid, `SELECT ${CAMPAIGN_COPY_FIELDS.join(", ")} FROM campaign WHERE campaign.id = ${id}`, { maxRows: 1 })).rows[0]
    if (!c) throw notFound("chiến dịch", id)
    const channel = str(c, "campaign.advertising_channel_type")
    if (channel !== "SEARCH") throw unsupportedChannel(channel)
    if (r.targetParentId) throw invalidRequest("targetParentId not applicable", "Sao chép chiến dịch chỉ trong cùng tài khoản; không dùng target_parent_id.")
    const criteria = await readAll(
      client,
      cid,
      `SELECT ${CRITERION_COPY_FIELDS.join(", ")} FROM campaign_criterion WHERE campaign.id = ${id} AND campaign_criterion.status != 'REMOVED'`,
      5_000,
      "tiêu chí chiến dịch"
    )
    const sharedSets = await readAll(
      client,
      cid,
      `SELECT ${SHARED_SET_COPY_FIELDS.join(", ")} FROM campaign_shared_set WHERE campaign.id = ${id} AND campaign_shared_set.status = 'ENABLED'`,
      1_000,
      "danh sách dùng chung"
    )
    let adGroups: GoogleAdsRow[] = []
    let keywords: GoogleAdsRow[] = []
    let ads: GoogleAdsRow[] = []
    if (r.deep) {
      adGroups = await readAll(
        client,
        cid,
        `SELECT ${AD_GROUP_COPY_FIELDS.join(", ")} FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED' ORDER BY ad_group.id`,
        1_000,
        "nhóm quảng cáo"
      )
      ads = await readAll(
        client,
        cid,
        `SELECT ${AD_COPY_FIELDS.join(", ")} FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`,
        5_000,
        "quảng cáo"
      )
      assertAdCap(ads.length)
      keywords = await readAll(
        client,
        cid,
        `SELECT ${KEYWORD_COPY_FIELDS.join(", ")} FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED'`,
        9_000,
        "từ khóa/tiêu chí nhóm"
      )
    }
    const base = copyName(str(c, "campaign.name") ?? id, r.namePrefix, r.nameSuffix)
    const name = uniqueName(base, await existingNames(client, cid, "campaign", base))
    const plan = buildCampaignCopy(
      cid,
      { campaign: c, criteria, adGroups, keywords, ads, sharedSets },
      { name, today, deep: r.deep, allowIncomplete: r.allowIncomplete === true }
    )
    const goalWarning = await conversionGoalWarning(client, cid, id)
    if (goalWarning) plan.warnings.push(goalWarning)
    return runPlan(client, cid, plan, opts, async () => findByName(client, cid, "campaign", name))
  }

  if (r.level === "ad_group") {
    const id = assertId(r.id, "ad_group_id")
    const ag = (await client.searchAll(cid, `SELECT ${AD_GROUP_COPY_FIELDS.join(", ")} FROM ad_group WHERE ad_group.id = ${id}`, { maxRows: 1 })).rows[0]
    if (!ag) throw notFound("nhóm quảng cáo", id)
    const srcChannel = str(ag, "campaign.advertising_channel_type")
    if (srcChannel !== "SEARCH") throw unsupportedChannel(srcChannel)
    const targetCampaign = r.targetParentId ? assertId(r.targetParentId, "target_parent_id") : str(ag, "campaign.id")!
    if (targetCampaign !== str(ag, "campaign.id")) {
      const t = (
        await client.searchAll(cid, `SELECT campaign.id, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${targetCampaign}`, {
          maxRows: 1,
        })
      ).rows[0]
      if (!t || str(t, "campaign.status") === "REMOVED") throw notFound("chiến dịch đích", targetCampaign)
      if (str(t, "campaign.advertising_channel_type") !== "SEARCH") throw unsupportedChannel(str(t, "campaign.advertising_channel_type"))
    }
    let ads: GoogleAdsRow[] = []
    if (r.deep) {
      ads = await readAll(
        client,
        cid,
        `SELECT ${AD_COPY_FIELDS.join(", ")} FROM ad_group_ad WHERE ad_group.id = ${id} AND ad_group_ad.status != 'REMOVED'`,
        5_000,
        "quảng cáo"
      )
      assertAdCap(ads.length)
    }
    // always read criteria: non-keyword targeting (audiences…) must be detected even for a shallow copy
    const keywords = await readAll(
      client,
      cid,
      `SELECT ${KEYWORD_COPY_FIELDS.join(", ")} FROM ad_group_criterion WHERE ad_group.id = ${id} AND ad_group_criterion.status != 'REMOVED'`,
      9_000,
      "từ khóa/tiêu chí nhóm"
    )
    const base = copyName(str(ag, "ad_group.name") ?? id, r.namePrefix, r.nameSuffix)
    const name = uniqueName(base, await existingNames(client, cid, "ad_group", base, targetCampaign))
    const plan = buildAdGroupCopy(cid, targetCampaign, ag, keywords, ads, { name, deep: r.deep, allowIncomplete: r.allowIncomplete === true })
    return runPlan(client, cid, plan, opts, async () => findByName(client, cid, "ad_group", name, targetCampaign))
  }

  if (r.level === "ad") {
    const [agPart, adPart] = r.id.includes("~") ? r.id.split("~") : [null, r.id]
    const adId = assertId(adPart!, "ad_id")
    const conds = [`ad_group_ad.ad.id = ${adId}`]
    if (agPart) conds.push(`ad_group.id = ${assertId(agPart, "ad_group_id")}`)
    const rows = (await client.searchAll(cid, `SELECT ${AD_COPY_FIELDS.join(", ")} FROM ad_group_ad WHERE ${conds.join(" AND ")}`, { maxRows: 10 })).rows
    if (!rows.length) throw notFound("quảng cáo", r.id)
    if (rows.length > 1) throw invalidRequest("Ambiguous ad", "Quảng cáo xuất hiện ở nhiều nhóm - hãy dùng id dạng AD_GROUP_ID~AD_ID.")
    const ad = rows[0]!
    assertNotVideo([ad], "copy")
    const targetAg = r.targetParentId ? assertId(r.targetParentId, "target_parent_id") : str(ad, "ad_group.id")!
    if (targetAg !== str(ad, "ad_group.id")) {
      const t = (
        await client.searchAll(
          cid,
          `SELECT ad_group.id, ad_group.status, ad_group.type, campaign.advertising_channel_type FROM ad_group WHERE ad_group.id IN ${idList([targetAg])}`,
          { maxRows: 1 }
        )
      ).rows[0]
      if (!t || str(t, "ad_group.status") === "REMOVED") throw notFound("nhóm quảng cáo đích", targetAg)
      // Video (YouTube) campaigns are read-only; only RSA is copied and it needs a standard Search ad group
      assertNotVideo([t], "copy")
      if (str(t, "ad_group.type") !== "SEARCH_STANDARD") {
        throw invalidRequest(
          `Target ad group type ${str(t, "ad_group.type") ?? "?"} cannot hold a responsive search ad`,
          "Quảng cáo RSA chỉ sao chép được vào nhóm quảng cáo Search tiêu chuẩn (SEARCH_STANDARD) - hãy chọn nhóm quảng cáo đích thuộc chiến dịch Tìm kiếm."
        )
      }
    }
    const plan = buildAdCopy(cid, targetAg, ad)
    if (r.namePrefix || r.nameSuffix) plan.warnings.push("Quảng cáo RSA không có tên - bỏ qua tiền tố/hậu tố tên.")
    // ads have no name to look up after a timeout → no recovery
    return runPlan(client, cid, plan, opts, async () => null)
  }

  throw invalidRequest(`Unsupported copy level ${String((r as { level: string }).level)}`, "Cấp sao chép không hợp lệ.")
}

function assertAdCap(n: number) {
  if (n > MAX_COPY_ADS) {
    throw invalidRequest(
      `Too many ads to copy: ${n}`,
      `Sao chép sâu tối đa ${MAX_COPY_ADS} quảng cáo mỗi lần (đối tượng này có ${n}). Hãy sao chép từng nhóm quảng cáo hoặc dùng deep = false.`
    )
  }
}

async function findByName(client: GoogleAdsClient, cid: string, from: "campaign" | "ad_group", name: string, campaignId?: string): Promise<string | null> {
  const conds = [`${from}.name = ${gaqlString(name)}`, `${from}.status != 'REMOVED'`]
  if (campaignId) conds.push(`campaign.id = ${assertId(campaignId)}`)
  const { rows } = await client.searchAll(cid, `SELECT ${from}.id FROM ${from} WHERE ${conds.join(" AND ")}`, { maxRows: 1 })
  return rows[0] ? str(rows[0], `${from}.id`) : null
}
