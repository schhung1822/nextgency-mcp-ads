// Emulated copy of Google Ads Demand Gen campaigns / ad groups / ads (same account, no copy endpoint). Same contract as
// the Search copy in copy.ts (which dispatches here): read with GAQL, strip output-only fields, re-create everything in
// ONE atomic googleAds:mutate with negative temp ids; the root is PAUSED, children keep their source status; dryRun =
// validateOnly; timeout/5xx → recovery by name; targeting that cannot be re-created fails closed unless allowIncomplete;
// the EU political-ads declaration is never made on the user's behalf.
// Official facts (v25): campaign without sub type / network settings / geo target type setting, budget never shared;
// ad groups without `type`, channel controls as `channelStrategy` XOR `selectedChannels` (`channelConfig` is output
// only); ads rebuilt from the read AdInfo - images / videos / CTA / carousel cards reuse the asset resource names
// (assets are shareable inside the account), text assets are sent inline (`text` + pin only).
// Upgraded targeting (campaign.demand_gen_campaign_settings.upgraded_targeting, optional bool, default true): location
// and language live on the ad group; an ad group is only copied into a campaign with the same mode.
import { ProviderError } from "../errors"
import type { CopyRequest, CopyResult, MutationOptions } from "../types"
import { field, str, type GoogleAdsClient, type GoogleAdsRow } from "./client"
import { invalidRequest, notFound } from "./context"
import {
  ASSET_LINK_COPY_FIELDS,
  CRITERION_COPY_FIELDS,
  SHARED_SET_COPY_FIELDS,
  TempIds,
  addBudgetOp,
  addCampaignAssetLinks,
  addSharedSetLinks,
  assertAdCap,
  biddingFor,
  childStatus,
  compact,
  conversionGoalWarning,
  copyFlight,
  copyName,
  euDeclaration,
  existingNames,
  finalizeIncomplete,
  findByName,
  proximityBody,
  readAll,
  runPlan,
  textAssets,
  uniqueName,
  unsupportedChannel,
  type CampaignSource,
  type CopyPlan,
} from "./copy"
import { assertId, idList } from "./gaql"
import { assertNotVideo, videoReadOnlyError } from "./youtube"

// ---------------------------------------------------------------------------
// GAQL (only fields verified selectable in the v25 field reference - research §5.1)
// ---------------------------------------------------------------------------

const UPGRADED = "campaign.demand_gen_campaign_settings.upgraded_targeting"

export const DG_CAMPAIGN_COPY_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.advertising_channel_type",
  "campaign.bidding_strategy_type",
  "campaign.bidding_strategy",
  "campaign.maximize_conversions.target_cpa_micros",
  "campaign.maximize_conversion_value.target_roas",
  "campaign.target_cpa.target_cpa_micros",
  "campaign.target_roas.target_roas",
  "campaign.target_spend.cpc_bid_ceiling_micros",
  "campaign.target_cpc.target_cpc_micros",
  UPGRADED,
  "campaign.audience_setting.use_audience_grouped",
  "campaign.shopping_setting.merchant_id",
  "campaign.shopping_setting.feed_label",
  "campaign.view_through_conversion_optimization_enabled",
  "campaign.start_date_time",
  "campaign.end_date_time",
  "campaign.contains_eu_political_advertising",
  "campaign.tracking_url_template",
  "campaign.final_url_suffix",
  "campaign.url_custom_parameters",
  "campaign_budget.id",
  "campaign_budget.amount_micros",
  "campaign_budget.total_amount_micros",
  "campaign_budget.period",
  "campaign_budget.delivery_method",
  "campaign_budget.explicitly_shared",
]

const CC = "ad_group.demand_gen_ad_group_settings.channel_controls"

/** DemandGenSelectedChannels (v25, `maps` since v24.2): REST name → GAQL name. */
export const DG_SELECTED_CHANNELS = [
  ["youtubeInFeed", "youtube_in_feed"],
  ["youtubeInStream", "youtube_in_stream"],
  ["youtubeShorts", "youtube_shorts"],
  ["discover", "discover"],
  ["gmail", "gmail"],
  ["display", "display"],
  ["maps", "maps"],
] as const

export const DG_AD_GROUP_COPY_FIELDS = [
  "campaign.id",
  "campaign.advertising_channel_type",
  "campaign.bidding_strategy",
  UPGRADED,
  "ad_group.id",
  "ad_group.name",
  "ad_group.status",
  "ad_group.audience_setting.use_audience_grouped",
  "ad_group.optimized_targeting_enabled",
  "ad_group.exclude_demographic_expansion",
  "ad_group.target_cpa_micros",
  "ad_group.target_cpc_micros",
  "ad_group.target_roas",
  `${CC}.channel_config`,
  `${CC}.channel_strategy`,
  ...DG_SELECTED_CHANNELS.map(([, g]) => `${CC}.selected_channels.${g}`),
  "ad_group.tracking_url_template",
  "ad_group.final_url_suffix",
  "ad_group.url_custom_parameters",
]

export const DG_AD_GROUP_CRITERION_COPY_FIELDS = [
  "ad_group.id",
  "ad_group_criterion.criterion_id",
  "ad_group_criterion.type",
  "ad_group_criterion.status",
  "ad_group_criterion.negative",
  "ad_group_criterion.bid_modifier",
  "ad_group_criterion.location.geo_target_constant",
  "ad_group_criterion.language.language_constant",
  "ad_group_criterion.audience.audience",
  "ad_group_criterion.user_list.user_list",
  "ad_group_criterion.age_range.type",
  "ad_group_criterion.gender.type",
  "ad_group_criterion.parental_status.type",
  "ad_group_criterion.income_range.type",
  "ad_group_criterion.listing_group.type",
]

const A = "ad_group_ad.ad"
const VR = `${A}.demand_gen_video_responsive_ad`
const MA = `${A}.demand_gen_multi_asset_ad`
const CA = `${A}.demand_gen_carousel_ad`
const PR = `${A}.demand_gen_product_ad`

export const DG_AD_COPY_FIELDS = [
  "campaign.id",
  "campaign.advertising_channel_type",
  "ad_group.id",
  "ad_group_ad.status",
  "ad_group_ad.ad_group_ad_asset_automation_settings",
  `${A}.id`,
  `${A}.type`,
  `${A}.name`,
  `${A}.final_urls`,
  `${A}.final_mobile_urls`,
  `${A}.tracking_url_template`,
  `${A}.final_url_suffix`,
  `${A}.url_custom_parameters`,
  ...[
    "videos",
    "logo_images",
    "headlines",
    "long_headlines",
    "descriptions",
    "business_name",
    "call_to_actions",
    "companion_banners",
    "breadcrumb1",
    "breadcrumb2",
  ].map((f) => `${VR}.${f}`),
  ...[
    "marketing_images",
    "square_marketing_images",
    "portrait_marketing_images",
    "tall_portrait_marketing_images",
    "classic_display_images",
    "logo_images",
    "headlines",
    "descriptions",
    "business_name",
    "call_to_action_text",
  ].map((f) => `${MA}.${f}`),
  ...[
    "business_name",
    "logo_image",
    "headline",
    "description",
    "call_to_action_text",
    "carousel_cards",
  ].map((f) => `${CA}.${f}`),
  ...[
    "headline",
    "description",
    "logo_image",
    "business_name",
    "call_to_action",
    "breadcrumb1",
    "breadcrumb2",
  ].map((f) => `${PR}.${f}`),
]

/** Ad types copied by this module (legacy "Demand Gen video ad" is not returned by GAQL at all). */
export const DG_AD_TYPES = [
  "DEMAND_GEN_VIDEO_RESPONSIVE_AD",
  "DEMAND_GEN_MULTI_ASSET_AD",
  "DEMAND_GEN_CAROUSEL_AD",
  "DEMAND_GEN_PRODUCT_AD",
] as const

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const bool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined
/** int64 micros value set on the source ("0"/absent = not set). */
const microsSet = (v: string | null): string | undefined =>
  v && v !== "0" ? v : undefined
const positive = (v: unknown): number | undefined => {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const known = (v: string | null): v is string =>
  !!v && v !== "UNSPECIFIED" && v !== "UNKNOWN"

/** Upgraded targeting of the campaign in a row (optional bool: absent = unset = Google default true). */
export const isUpgraded = (row: GoogleAdsRow): boolean =>
  field(row, UPGRADED) !== false

// ---------------------------------------------------------------------------
// Pure builders (unit-tested)
// ---------------------------------------------------------------------------

const CHANNEL_LABEL: Record<string, string> = {
  SEARCH: "Tìm kiếm (Search)",
  DEMAND_GEN: "Demand Gen",
}
const label = (c: string | null) => (c ? (CHANNEL_LABEL[c] ?? c) : "không rõ")

/** Source and target must be the same campaign type (a Search ad group cannot live in a Demand Gen campaign…). */
export function channelMismatch(
  source: string,
  target: string | null
): ProviderError {
  return invalidRequest(
    `Cannot copy a ${source} object into a ${target ?? "?"} campaign`,
    `Đối tượng thuộc chiến dịch ${label(source)} chỉ sao chép được vào chiến dịch cùng loại ${label(source)} - đích đang là chiến dịch ${label(target)}.`,
    "Chọn target_parent_id thuộc chiến dịch cùng loại với bản gốc (xem ads_list_objects, trường advertising_channel_type)."
  )
}

/** An ad group keeps its location/language only in a campaign with the same upgraded-targeting mode. */
export function targetingModeMismatch(sourceUpgraded: boolean): ProviderError {
  const mode = (u: boolean) =>
    u
      ? "vị trí/ngôn ngữ đặt ở cấp nhóm quảng cáo"
      : "vị trí/ngôn ngữ đặt ở cấp chiến dịch"
  return invalidRequest(
    "Source and target Demand Gen campaigns use different upgraded_targeting modes",
    `Không sao chép được: chiến dịch gốc dùng ${mode(sourceUpgraded)}, còn chiến dịch đích dùng ${mode(!sourceUpgraded)} - nhóm sao chép sang sẽ mất hoặc sai vị trí/ngôn ngữ (có thể nhắm mọi quốc gia).`,
    "Chọn chiến dịch đích cùng chế độ nhắm mục tiêu (upgraded_targeting) với chiến dịch gốc, hoặc sao chép cả chiến dịch (level=campaign)."
  )
}

/** Bidding of a Demand Gen copy: portfolio / Max conv / Max conv value / tCPA / tROAS / Max clicks via biddingFor + Target CPC. */
export function demandGenBidding(
  c: GoogleAdsRow,
  warnings: string[]
): Record<string, unknown> {
  if (str(c, "campaign.bidding_strategy")) return biddingFor(c, warnings)
  const type = str(c, "campaign.bidding_strategy_type")
  if (type === "TARGET_CPC") {
    const t = microsSet(str(c, "campaign.target_cpc.target_cpc_micros"))
    if (!t) {
      throw invalidRequest(
        "Target CPC campaign without a readable target_cpc_micros",
        "Không đọc được giá thầu CPC mục tiêu (target_cpc_micros) của chiến dịch gốc - chưa sao chép được.",
        "Kiểm tra chiến lược giá thầu CPC mục tiêu của chiến dịch gốc trong Google Ads rồi sao chép lại."
      )
    }
    return { targetCpc: { targetCpcMicros: t } }
  }
  if (type === "MANUAL_CPC" || type === "TARGET_IMPRESSION_SHARE") {
    throw new ProviderError({
      platform: "google_ads",
      code: "unsupported",
      message: `Bidding strategy ${type} cannot be copied to a Demand Gen campaign`,
      userMessageVi: `Chiến dịch Demand Gen không hỗ trợ chiến lược giá thầu ${type} qua API - chưa sao chép được. Hãy đổi chiến lược giá thầu của chiến dịch gốc (ví dụ Tối đa hoá lượt chuyển đổi) hoặc sao chép trong giao diện Google Ads.`,
    })
  }
  return biddingFor(c, warnings)
}

/** CustomParameter[] → [{key, value}] (the only input fields). */
function customParams(
  v: unknown
): { key: string; value: string }[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .map((x) => x as { key?: unknown; value?: unknown })
    .filter((x) => typeof x.key === "string" && x.key)
    .map((x) => ({
      key: x.key as string,
      value: typeof x.value === "string" ? x.value : "",
    }))
  return out.length ? out : undefined
}

/**
 * campaign.demand_gen_campaign_settings.upgraded_targeting (immutable, default true). If the read omits it, campaign-
 * level LOCATION / LANGUAGE criteria only exist without upgraded targeting → keep the campaign-level mode.
 */
function upgradedTargetingOf(
  c: GoogleAdsRow,
  criteria: GoogleAdsRow[]
): boolean | undefined {
  const v = bool(field(c, UPGRADED))
  if (v !== undefined) return v
  return criteria.some((cr) =>
    ["LOCATION", "LANGUAGE"].includes(str(cr, "campaign_criterion.type") ?? "")
  )
    ? false
    : undefined
}

/**
 * DemandGenChannelControls input: `channelStrategy` XOR `selectedChannels` (all 7 booleans). null = cannot copy
 * (unknown value, no channel selected, or nothing readable - leaving it out would silently mean ALL_CHANNELS).
 */
export function channelControlsBody(
  ag: GoogleAdsRow
): Record<string, unknown> | null {
  const config = str(ag, `${CC}.channel_config`)
  const strategy = str(ag, `${CC}.channel_strategy`)
  const selected = field(ag, `${CC}.selected_channels`)
  const useStrategy =
    config === "CHANNEL_STRATEGY" || (!known(config) && known(strategy))
  const useSelected =
    config === "SELECTED_CHANNELS" ||
    (!known(config) &&
      !known(strategy) &&
      !!selected &&
      typeof selected === "object")
  if (useStrategy)
    return strategy === "ALL_CHANNELS" ||
      strategy === "ALL_OWNED_AND_OPERATED_CHANNELS"
      ? { channelStrategy: strategy }
      : null
  if (useSelected) {
    const sel = Object.fromEntries(
      DG_SELECTED_CHANNELS.map(([rest, gaql]) => [
        rest,
        field(ag, `${CC}.selected_channels.${gaql}`) === true,
      ])
    )
    // "should be set with at least one true value"
    return Object.values(sel).some(Boolean) ? { selectedChannels: sel } : null
  }
  return null
}

type CriterionBody = (r: GoogleAdsRow) => Record<string, unknown> | null
const ref = (key: string, inner: string, v: string | null) =>
  v ? { [key]: { [inner]: v } } : null
const AG_CRITERION_BODY: Record<string, CriterionBody> = {
  LOCATION: (r) =>
    ref(
      "location",
      "geoTargetConstant",
      str(r, "ad_group_criterion.location.geo_target_constant")
    ),
  LANGUAGE: (r) =>
    ref(
      "language",
      "languageConstant",
      str(r, "ad_group_criterion.language.language_constant")
    ),
  AUDIENCE: (r) =>
    ref("audience", "audience", str(r, "ad_group_criterion.audience.audience")),
  USER_LIST: (r) =>
    ref(
      "userList",
      "userList",
      str(r, "ad_group_criterion.user_list.user_list")
    ),
  AGE_RANGE: (r) =>
    ref("ageRange", "type", str(r, "ad_group_criterion.age_range.type")),
  GENDER: (r) =>
    ref("gender", "type", str(r, "ad_group_criterion.gender.type")),
  PARENTAL_STATUS: (r) =>
    ref(
      "parentalStatus",
      "type",
      str(r, "ad_group_criterion.parental_status.type")
    ),
  INCOME_RANGE: (r) =>
    ref("incomeRange", "type", str(r, "ad_group_criterion.income_range.type")),
}

function assetRefs(v: unknown): { asset: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (x as { asset?: unknown })?.asset)
    .filter((a): a is string => typeof a === "string" && !!a)
    .map((asset) => ({ asset }))
}
function assetRef(v: unknown): { asset: string } | undefined {
  return assetRefs([v])[0]
}

/** Only the boolean keys of `o` that are listed (empty → undefined). */
function boolsOf(
  o: unknown,
  keys: readonly string[]
): Record<string, boolean> | undefined {
  if (!o || typeof o !== "object") return undefined
  const out: Record<string, boolean> = {}
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k]
    if (typeof v === "boolean") out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * AdVideoAsset[] → {asset, adVideoAssetInfo?}: only the input booleans of AdVideoAssetInfo (v25 common/ad_asset.proto):
 * inventory preferences (in feed / in stream / Shorts) and the YouTube-comments feature control.
 */
function videoRefs(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return []
  const out: Record<string, unknown>[] = []
  for (const x of v) {
    const o = x as {
      asset?: unknown
      adVideoAssetInfo?: {
        adVideoAssetInventoryPreferences?: unknown
        adVideoAssetFeatureControl?: unknown
      }
    } | null
    if (typeof o?.asset !== "string" || !o.asset) continue
    const prefs = boolsOf(
      o.adVideoAssetInfo?.adVideoAssetInventoryPreferences,
      ["inFeedPreference", "inStreamPreference", "shortsPreference"]
    )
    const control = boolsOf(o.adVideoAssetInfo?.adVideoAssetFeatureControl, [
      "allowYoutubeComments",
    ])
    const info = {
      ...(prefs ? { adVideoAssetInventoryPreferences: prefs } : {}),
      ...(control ? { adVideoAssetFeatureControl: control } : {}),
    }
    out.push(
      Object.keys(info).length
        ? { asset: o.asset, adVideoAssetInfo: info }
        : { asset: o.asset }
    )
  }
  return out
}

/** AdTextAsset field → {text (+ pinnedField)} (strips assetPerformanceLabel / policySummaryInfo). */
function textAsset(
  v: unknown
): { text: string; pinnedField?: string } | undefined {
  return textAssets([typeof v === "string" ? { text: v } : v])[0]
}
/** Plain string field (multi-asset / carousel business name, CTA text, breadcrumbs). */
function plain(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined
  const t = (v as { text?: unknown } | null)?.text
  return typeof t === "string" && t ? t : undefined
}

/** AdInfo builders per Demand Gen ad type (research §3: which fields are AdTextAsset vs string). */
const DG_AD_INFO: Record<
  (typeof DG_AD_TYPES)[number],
  (a: GoogleAdsRow) => [string, Record<string, unknown>]
> = {
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: (a) => [
    "demandGenVideoResponsiveAd",
    compact({
      videos: videoRefs(field(a, `${VR}.videos`)),
      logoImages: assetRefs(field(a, `${VR}.logo_images`)),
      headlines: textAssets(field(a, `${VR}.headlines`)),
      longHeadlines: textAssets(field(a, `${VR}.long_headlines`)),
      descriptions: textAssets(field(a, `${VR}.descriptions`)),
      businessName: textAsset(field(a, `${VR}.business_name`)),
      callToActions: assetRefs(field(a, `${VR}.call_to_actions`)),
      companionBanners: assetRefs(field(a, `${VR}.companion_banners`)),
      breadcrumb1: plain(field(a, `${VR}.breadcrumb1`)),
      breadcrumb2: plain(field(a, `${VR}.breadcrumb2`)),
    }),
  ],
  DEMAND_GEN_MULTI_ASSET_AD: (a) => [
    "demandGenMultiAssetAd",
    compact({
      marketingImages: assetRefs(field(a, `${MA}.marketing_images`)),
      squareMarketingImages: assetRefs(
        field(a, `${MA}.square_marketing_images`)
      ),
      portraitMarketingImages: assetRefs(
        field(a, `${MA}.portrait_marketing_images`)
      ),
      tallPortraitMarketingImages: assetRefs(
        field(a, `${MA}.tall_portrait_marketing_images`)
      ),
      classicDisplayImages: assetRefs(field(a, `${MA}.classic_display_images`)),
      logoImages: assetRefs(field(a, `${MA}.logo_images`)),
      headlines: textAssets(field(a, `${MA}.headlines`)),
      descriptions: textAssets(field(a, `${MA}.descriptions`)),
      businessName: plain(field(a, `${MA}.business_name`)),
      callToActionText: plain(field(a, `${MA}.call_to_action_text`)),
    }),
  ],
  DEMAND_GEN_CAROUSEL_AD: (a) => [
    "demandGenCarouselAd",
    compact({
      businessName: plain(field(a, `${CA}.business_name`)),
      logoImage: assetRef(field(a, `${CA}.logo_image`)),
      headline: textAsset(field(a, `${CA}.headline`)),
      description: textAsset(field(a, `${CA}.description`)),
      callToActionText: plain(field(a, `${CA}.call_to_action_text`)),
      carouselCards: assetRefs(field(a, `${CA}.carousel_cards`)),
    }),
  ],
  DEMAND_GEN_PRODUCT_AD: (a) => [
    "demandGenProductAd",
    compact({
      headline: textAsset(field(a, `${PR}.headline`)),
      description: textAsset(field(a, `${PR}.description`)),
      logoImage: assetRef(field(a, `${PR}.logo_image`)),
      businessName: textAsset(field(a, `${PR}.business_name`)),
      callToAction: assetRef(field(a, `${PR}.call_to_action`)),
      breadcrumb1: plain(field(a, `${PR}.breadcrumb1`)),
      breadcrumb2: plain(field(a, `${PR}.breadcrumb2`)),
    }),
  ],
}

const isDgAdType = (t: string | null): t is (typeof DG_AD_TYPES)[number] =>
  !!t && (DG_AD_TYPES as readonly string[]).includes(t)

/** AdGroupAd.ad_group_ad_asset_automation_settings (opt-ins/outs such as GENERATE_ANIMATED_IMAGES…) kept as source. */
function automationSettings(
  v: unknown
): { assetAutomationType: string; assetAutomationStatus: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .map(
      (x) =>
        x as { assetAutomationType?: string; assetAutomationStatus?: string }
    )
    .filter(
      (x) =>
        known(x.assetAutomationType ?? null) &&
        known(x.assetAutomationStatus ?? null)
    )
    .map((x) => ({
      assetAutomationType: x.assetAutomationType!,
      assetAutomationStatus: x.assetAutomationStatus!,
    }))
}

function addDemandGenAdOp(
  plan: CopyPlan,
  adGroupRn: string,
  a: GoogleAdsRow,
  status: "ENABLED" | "PAUSED"
): boolean {
  const type = str(a, `${A}.type`)
  const key = `${str(a, "ad_group.id")}~${str(a, `${A}.id`)}`
  if (!isDgAdType(type)) {
    plan.warnings.push(
      `Bỏ qua quảng cáo ${key} loại ${type ?? "?"} (chỉ sao chép quảng cáo Demand Gen: video, nhiều asset/hình ảnh, băng chuyền, sản phẩm).`
    )
    return false
  }
  const [infoKey, info] = DG_AD_INFO[type](a)
  plan.entries.push({ index: plan.ops.length, level: "ad", sourceId: key })
  plan.ops.push({
    adGroupAdOperation: {
      create: compact({
        adGroup: adGroupRn,
        status,
        ad: compact({
          name: str(a, `${A}.name`),
          finalUrls: field(a, `${A}.final_urls`) as string[] | undefined,
          finalMobileUrls: field(a, `${A}.final_mobile_urls`) as
            string[] | undefined,
          trackingUrlTemplate: str(a, `${A}.tracking_url_template`),
          finalUrlSuffix: str(a, `${A}.final_url_suffix`),
          urlCustomParameters: customParams(
            field(a, `${A}.url_custom_parameters`)
          ),
          [infoKey]: info,
        }),
        adGroupAdAssetAutomationSettings: automationSettings(
          field(a, "ad_group_ad.ad_group_ad_asset_automation_settings")
        ),
      }),
    },
  })
  return true
}

/**
 * Demand Gen ad group create op + its targeting criteria + ads (in that order). Returns the number of positive
 * LOCATION criteria re-created (upgraded targeting: 0 = the ad group targets every country).
 */
function addDemandGenAdGroupOps(
  plan: CopyPlan,
  cid: string,
  tmp: TempIds,
  campaignRn: string,
  ag: GoogleAdsRow,
  criteria: GoogleAdsRow[],
  ads: GoogleAdsRow[],
  o: { name: string; status: "ENABLED" | "PAUSED"; portfolio?: boolean }
): number {
  const agId = str(ag, "ad_group.id")!
  const agRn = `customers/${cid}/adGroups/${tmp.next()}`
  const controls = channelControlsBody(ag)
  if (!controls)
    plan.uncopyable.push(
      `kênh hiển thị (channel controls) của nhóm “${o.name}”`
    )
  const grouped = bool(
    field(ag, "ad_group.audience_setting.use_audience_grouped")
  )
  let targetRoas = positive(field(ag, "ad_group.target_roas"))
  if (targetRoas !== undefined && o.portfolio) {
    // ad_group.proto: with a portfolio bidding strategy target_roas "cannot be set" (error) → drop it
    targetRoas = undefined
    plan.warnings.push(
      `Nhóm “${o.name}”: bỏ ROAS mục tiêu riêng của nhóm vì chiến dịch đích dùng chiến lược giá thầu danh mục (portfolio) - Google không cho đặt.`
    )
  }
  plan.entries.push({
    index: plan.ops.length,
    level: "ad_group",
    sourceId: agId,
  })
  plan.ops.push({
    adGroupOperation: {
      // no `type` (Demand Gen ad groups are created without AdGroupType)
      create: compact({
        resourceName: agRn,
        campaign: campaignRn,
        name: o.name,
        status: o.status,
        audienceSetting:
          grouped === undefined ? undefined : { useAudienceGrouped: grouped },
        optimizedTargetingEnabled: bool(
          field(ag, "ad_group.optimized_targeting_enabled")
        ),
        excludeDemographicExpansion: bool(
          field(ag, "ad_group.exclude_demographic_expansion")
        ),
        targetCpaMicros: microsSet(str(ag, "ad_group.target_cpa_micros")),
        targetCpcMicros: microsSet(str(ag, "ad_group.target_cpc_micros")),
        targetRoas,
        demandGenAdGroupSettings: controls
          ? { channelControls: controls }
          : undefined,
        trackingUrlTemplate: str(ag, "ad_group.tracking_url_template"),
        finalUrlSuffix: str(ag, "ad_group.final_url_suffix"),
        urlCustomParameters: customParams(
          field(ag, "ad_group.url_custom_parameters")
        ),
      }),
    },
  })
  const skipped = new Map<string, number>()
  const skip = (t: string | null) =>
    skipped.set(t ?? "?", (skipped.get(t ?? "?") ?? 0) + 1)
  let locations = 0
  // listing groups (product feed): only a single root UNIT ("all products") can be re-created safely
  const listing = criteria.filter(
    (k) => str(k, "ad_group_criterion.type") === "LISTING_GROUP"
  )
  const singleRootUnit =
    listing.length === 1 &&
    str(listing[0]!, "ad_group_criterion.listing_group.type") === "UNIT"
  for (const k of criteria) {
    const type = str(k, "ad_group_criterion.type")
    const negative = field(k, "ad_group_criterion.negative") === true
    let body: Record<string, unknown> | null = null
    if (type === "LISTING_GROUP")
      body = singleRootUnit ? { listingGroup: { type: "UNIT" } } : null
    else if (type && AG_CRITERION_BODY[type]) body = AG_CRITERION_BODY[type]!(k)
    if (!body) {
      skip(type)
      continue
    }
    if (type === "LOCATION" && !negative) locations++
    const bidModifier = field(k, "ad_group_criterion.bid_modifier")
    plan.ops.push({
      adGroupCriterionOperation: {
        create: compact({
          adGroup: agRn,
          // default is ENABLED; only a paused positive criterion carries its status
          status:
            !negative && str(k, "ad_group_criterion.status") === "PAUSED"
              ? "PAUSED"
              : undefined,
          negative: negative ? true : undefined,
          ...body,
          bidModifier:
            !negative &&
            typeof bidModifier === "number" &&
            bidModifier !== 1 &&
            type !== "LANGUAGE" &&
            type !== "LISTING_GROUP"
              ? bidModifier
              : undefined,
        }),
      },
    })
  }
  for (const [t, n] of skipped)
    plan.uncopyable.push(`${n} tiêu chí loại ${t} của nhóm “${o.name}”`)
  for (const a of ads)
    addDemandGenAdOp(plan, agRn, a, childStatus(str(a, "ad_group_ad.status")))
  return locations
}

const NO_GROUP_LOCATION_VI = "vị trí (nhóm gốc không có vị trí riêng)"

export function buildDemandGenCampaignCopy(
  cid: string,
  src: CampaignSource,
  o: {
    name: string
    today: string
    deep: boolean
    budgetSuffix?: string
    allowIncomplete?: boolean
  }
): CopyPlan {
  const c = src.campaign
  const channel = str(c, "campaign.advertising_channel_type")
  if (channel !== "DEMAND_GEN") throw unsupportedChannel(channel)
  const plan: CopyPlan = {
    ops: [],
    entries: [],
    warnings: [],
    uncopyable: [],
    rootLevel: "campaign",
    rootName: o.name,
    rootIndex: -1,
  }
  const tmp = new TempIds()

  // 1) budget: new, non-shared (Demand Gen rejects shared budgets), same amount, daily or CUSTOM_PERIOD total
  const { budgetRn, lifetime } = addBudgetOp(plan, cid, tmp, c, o)

  // 2) campaign - PAUSED, no sub type / network settings / geo target type setting
  const warnings = plan.warnings
  const eu = euDeclaration(c)
  const { startDateTime, endDateTime } = copyFlight(
    c,
    o.today,
    lifetime,
    warnings
  )
  const campaignRn = `customers/${cid}/campaigns/${tmp.next()}`
  const upgraded = upgradedTargetingOf(c, src.criteria)
  const grouped = bool(
    field(c, "campaign.audience_setting.use_audience_grouped")
  )
  const merchantId = microsSet(str(c, "campaign.shopping_setting.merchant_id"))
  plan.rootIndex = plan.ops.length
  plan.entries.push({
    index: plan.ops.length,
    level: "campaign",
    sourceId: str(c, "campaign.id")!,
  })
  plan.ops.push({
    campaignOperation: {
      create: compact({
        resourceName: campaignRn,
        name: o.name,
        status: "PAUSED",
        advertisingChannelType: "DEMAND_GEN",
        campaignBudget: budgetRn,
        ...demandGenBidding(c, warnings),
        demandGenCampaignSettings:
          upgraded === undefined ? undefined : { upgradedTargeting: upgraded },
        audienceSetting:
          grouped === undefined ? undefined : { useAudienceGrouped: grouped },
        shoppingSetting: merchantId
          ? compact({
              merchantId,
              feedLabel: str(c, "campaign.shopping_setting.feed_label"),
            })
          : undefined,
        // "only allowed for certain Demand Gen campaigns" → only carried when the source turned it on
        viewThroughConversionOptimizationEnabled:
          field(c, "campaign.view_through_conversion_optimization_enabled") ===
          true
            ? true
            : undefined,
        containsEuPoliticalAdvertising: eu,
        startDateTime,
        endDateTime,
        trackingUrlTemplate: str(c, "campaign.tracking_url_template"),
        finalUrlSuffix: str(c, "campaign.final_url_suffix"),
        urlCustomParameters: customParams(
          field(c, "campaign.url_custom_parameters")
        ),
      }),
    },
  })

  // 3) campaign criteria: location, proximity, language (allowed on Demand Gen), device, ad schedule, negative keywords
  const skipped = new Map<string, number>()
  for (const cr of src.criteria) {
    const type = str(cr, "campaign_criterion.type")
    const negative = field(cr, "campaign_criterion.negative") === true
    const bidModifier = field(cr, "campaign_criterion.bid_modifier")
    let body: Record<string, unknown> | null = null
    if (type === "LOCATION") {
      body = ref(
        "location",
        "geoTargetConstant",
        str(cr, "campaign_criterion.location.geo_target_constant")
      )
    } else if (type === "PROXIMITY" && !negative) {
      body = proximityBody(cr)
    } else if (type === "LANGUAGE") {
      body = ref(
        "language",
        "languageConstant",
        str(cr, "campaign_criterion.language.language_constant")
      )
    } else if (type === "KEYWORD" && negative) {
      body = {
        keyword: {
          text: str(cr, "campaign_criterion.keyword.text"),
          matchType: str(cr, "campaign_criterion.keyword.match_type"),
        },
      }
    } else if (type === "AD_SCHEDULE") {
      body = {
        adSchedule: compact({
          dayOfWeek: str(cr, "campaign_criterion.ad_schedule.day_of_week"),
          startHour:
            field(cr, "campaign_criterion.ad_schedule.start_hour") ?? 0,
          startMinute:
            str(cr, "campaign_criterion.ad_schedule.start_minute") ?? "ZERO",
          endHour: field(cr, "campaign_criterion.ad_schedule.end_hour") ?? 24,
          endMinute:
            str(cr, "campaign_criterion.ad_schedule.end_minute") ?? "ZERO",
        }),
      }
    } else if (type === "DEVICE") {
      // bid_modifier 0 = device excluded; absent / 1.0 = no adjustment → nothing to create
      if (typeof bidModifier !== "number" || bidModifier === 1) continue
      body = ref("device", "type", str(cr, "campaign_criterion.device.type"))
    }
    if (!body) {
      skipped.set(type ?? "?", (skipped.get(type ?? "?") ?? 0) + 1)
      continue
    }
    plan.entries.push({
      index: plan.ops.length,
      level: "campaign_criterion",
      sourceId: str(cr, "campaign_criterion.criterion_id") ?? "",
    })
    plan.ops.push({
      campaignCriterionOperation: {
        create: compact({
          campaign: campaignRn,
          ...body,
          // default is ENABLED; a paused positive criterion stays paused (re-enabling it would broaden delivery)
          status:
            !negative && str(cr, "campaign_criterion.status") === "PAUSED"
              ? "PAUSED"
              : undefined,
          negative: negative ? true : undefined,
          bidModifier:
            !negative &&
            typeof bidModifier === "number" &&
            bidModifier !== 1 &&
            type !== "LANGUAGE"
              ? bidModifier
              : undefined,
        }),
      },
    })
  }
  for (const [t, n] of skipped)
    plan.uncopyable.push(`${n} tiêu chí chiến dịch loại ${t}`)

  // 3b/3c) shared sets and campaign-level asset links: linked, same rules as Search
  addSharedSetLinks(plan, src, campaignRn)
  addCampaignAssetLinks(plan, src, campaignRn)

  // 4) ad groups + their targeting + ads
  const geo = (rows: GoogleAdsRow[], typeField: string, negField: string) =>
    rows.some(
      (r) =>
        ["LOCATION", "PROXIMITY"].includes(str(r, typeField) ?? "") &&
        field(r, negField) !== true
    )
  if (o.deep) {
    const campaignGeo = geo(
      src.criteria,
      "campaign_criterion.type",
      "campaign_criterion.negative"
    )
    const noGeoAtAll =
      !campaignGeo &&
      !geo(
        src.keywords,
        "ad_group_criterion.type",
        "ad_group_criterion.negative"
      )
    if (noGeoAtAll)
      warnings.push(
        "Chiến dịch gốc không giới hạn vị trí (cả cấp chiến dịch và nhóm quảng cáo) - bản sao cũng nhắm mọi quốc gia."
      )
    const portfolio = !!str(c, "campaign.bidding_strategy")
    for (const ag of src.adGroups) {
      const agId = str(ag, "ad_group.id")!
      const name = str(ag, "ad_group.name") ?? `Ad group ${agId}`
      const locations = addDemandGenAdGroupOps(
        plan,
        cid,
        tmp,
        campaignRn,
        ag,
        src.keywords.filter((k) => str(k, "ad_group.id") === agId),
        src.ads.filter((a) => str(a, "ad_group.id") === agId),
        { name, status: childStatus(str(ag, "ad_group.status")), portfolio }
      )
      // upgraded targeting: location lives on the ad group. The source group already serves this way → warn only.
      if (upgraded !== false && !locations && !campaignGeo && !noGeoAtAll) {
        warnings.push(
          `Nhóm “${name}” không có vị trí riêng (nhắm mục tiêu nâng cấp: vị trí đặt ở cấp nhóm) - nhóm sao chép cũng nhắm mọi quốc gia như nhóm gốc.`
        )
      }
    }
  } else {
    warnings.push(
      `Sao chép nông (deep=false): bản sao Demand Gen chưa có nhóm quảng cáo - ${upgraded === false ? "" : "vị trí, ngôn ngữ, "}đối tượng và kênh hiển thị nằm ở cấp nhóm; hãy sao chép nhóm vào bản sao (level=ad_group, target_parent_id) trước khi bật.`
    )
  }
  finalizeIncomplete(plan, !!o.allowIncomplete)
  return plan
}

export function buildDemandGenAdGroupCopy(
  cid: string,
  targetCampaignId: string,
  ag: GoogleAdsRow,
  criteria: GoogleAdsRow[],
  ads: GoogleAdsRow[],
  o: {
    name: string
    deep: boolean
    allowIncomplete?: boolean
    /** upgraded targeting of the target campaign (default: same as the source campaign in `ag`) */
    targetUpgraded?: boolean
    /** true when copying into another campaign: a group without location then fails closed instead of a warning */
    otherCampaign?: boolean
    /** the target campaign uses a portfolio bidding strategy */
    portfolio?: boolean
  }
): CopyPlan {
  const channel = str(ag, "campaign.advertising_channel_type")
  if (channel !== "DEMAND_GEN") throw unsupportedChannel(channel)
  const plan: CopyPlan = {
    ops: [],
    entries: [],
    warnings: [],
    uncopyable: [],
    rootLevel: "ad_group",
    rootName: o.name,
    rootIndex: 0,
  }
  // targeting criteria belong to the ad group itself → copied even when deep=false; ads only when deep
  const locations = addDemandGenAdGroupOps(
    plan,
    cid,
    new TempIds(),
    `customers/${cid}/campaigns/${targetCampaignId}`,
    ag,
    criteria,
    o.deep ? ads : [],
    {
      name: o.name,
      status: "PAUSED",
      portfolio: o.portfolio ?? !!str(ag, "campaign.bidding_strategy"),
    }
  )
  if ((o.targetUpgraded ?? isUpgraded(ag)) && !locations) {
    // upgraded targeting: no ad-group location = every country
    if (o.otherCampaign) plan.uncopyable.push(NO_GROUP_LOCATION_VI)
    else
      plan.warnings.push(
        `Nhóm gốc không có vị trí riêng (nhắm mục tiêu nâng cấp) - nhóm sao chép cũng nhắm mọi quốc gia như nhóm gốc.`
      )
  }
  finalizeIncomplete(plan, !!o.allowIncomplete)
  return plan
}

export function buildDemandGenAdCopy(
  cid: string,
  targetAdGroupId: string,
  ad: GoogleAdsRow
): CopyPlan {
  const plan: CopyPlan = {
    ops: [],
    entries: [],
    warnings: [],
    uncopyable: [],
    rootLevel: "ad",
    rootName: str(ad, `${A}.name`) ?? "",
    rootIndex: 0,
  }
  if (
    !addDemandGenAdOp(
      plan,
      `customers/${cid}/adGroups/${targetAdGroupId}`,
      ad,
      "PAUSED"
    )
  ) {
    throw new ProviderError({
      platform: "google_ads",
      code: "unsupported",
      message: `Ad type ${str(ad, `${A}.type`) ?? "?"} cannot be copied`,
      userMessageVi: `Chưa hỗ trợ sao chép quảng cáo loại ${str(ad, `${A}.type`) ?? "không rõ"} - chỉ sao chép quảng cáo Demand Gen dạng video, nhiều asset/hình ảnh, băng chuyền và sản phẩm.`,
    })
  }
  return plan
}

// ---------------------------------------------------------------------------
// Orchestration (called from copyObject in copy.ts after the source channel was read)
// ---------------------------------------------------------------------------

const hasMerchant = (row: GoogleAdsRow | undefined) =>
  !!row && !!microsSet(str(row, "campaign.shopping_setting.merchant_id"))

function needsFeedError(): ProviderError {
  return invalidRequest(
    "Target campaign has no product feed",
    "Quảng cáo sản phẩm / nhóm sản phẩm (listing group) chỉ sao chép được vào chiến dịch Demand Gen có nguồn cấp sản phẩm (Merchant Center) - chiến dịch đích không có.",
    "Chọn chiến dịch / nhóm đích dùng nguồn cấp sản phẩm, hoặc sao chép cả chiến dịch gốc."
  )
}

export async function copyDemandGenCampaign(
  client: GoogleAdsClient,
  cid: string,
  id: string,
  r: CopyRequest,
  today: string,
  opts: MutationOptions
): Promise<CopyResult> {
  if (r.targetParentId)
    throw invalidRequest(
      "targetParentId not applicable",
      "Sao chép chiến dịch chỉ trong cùng tài khoản; không dùng target_parent_id."
    )
  const c = (
    await client.searchAll(
      cid,
      `SELECT ${DG_CAMPAIGN_COPY_FIELDS.join(", ")} FROM campaign WHERE campaign.id = ${id}`,
      { maxRows: 1 }
    )
  ).rows[0]
  if (!c) throw notFound("chiến dịch", id)
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
  const assets = await readAll(
    client,
    cid,
    `SELECT ${ASSET_LINK_COPY_FIELDS.join(", ")} FROM campaign_asset WHERE campaign.id = ${id} AND campaign_asset.status = 'ENABLED'`,
    1_000,
    "asset cấp chiến dịch"
  )
  let adGroups: GoogleAdsRow[] = []
  let keywords: GoogleAdsRow[] = []
  let ads: GoogleAdsRow[] = []
  if (r.deep) {
    adGroups = await readAll(
      client,
      cid,
      `SELECT ${DG_AD_GROUP_COPY_FIELDS.join(", ")} FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED' ORDER BY ad_group.id`,
      1_000,
      "nhóm quảng cáo"
    )
    ads = await readAll(
      client,
      cid,
      `SELECT ${DG_AD_COPY_FIELDS.join(", ")} FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`,
      5_000,
      "quảng cáo"
    )
    assertAdCap(ads.length)
    keywords = await readAll(
      client,
      cid,
      `SELECT ${DG_AD_GROUP_CRITERION_COPY_FIELDS.join(", ")} FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED'`,
      9_000,
      "tiêu chí nhóm"
    )
  }
  const base = copyName(
    str(c, "campaign.name") ?? id,
    r.namePrefix,
    r.nameSuffix
  )
  const name = uniqueName(
    base,
    await existingNames(client, cid, "campaign", base)
  )
  const plan = buildDemandGenCampaignCopy(
    cid,
    { campaign: c, criteria, adGroups, keywords, ads, sharedSets, assets },
    { name, today, deep: r.deep, allowIncomplete: r.allowIncomplete === true }
  )
  const goalWarning = await conversionGoalWarning(client, cid, id)
  if (goalWarning) plan.warnings.push(goalWarning)
  return runPlan(client, cid, plan, opts, async () =>
    findByName(client, cid, "campaign", name)
  )
}

export async function copyDemandGenAdGroup(
  client: GoogleAdsClient,
  cid: string,
  source: GoogleAdsRow,
  r: CopyRequest,
  opts: MutationOptions
): Promise<CopyResult> {
  const id = assertId(str(source, "ad_group.id") ?? r.id, "ad_group_id")
  const ag = (
    await client.searchAll(
      cid,
      `SELECT ${DG_AD_GROUP_COPY_FIELDS.join(", ")} FROM ad_group WHERE ad_group.id = ${id}`,
      { maxRows: 1 }
    )
  ).rows[0]
  if (!ag) throw notFound("nhóm quảng cáo", id)
  const sourceCampaign = str(ag, "campaign.id")!
  const targetCampaign = r.targetParentId
    ? assertId(r.targetParentId, "target_parent_id")
    : sourceCampaign
  let target: GoogleAdsRow | undefined
  if (targetCampaign !== sourceCampaign) {
    target = (
      await client.searchAll(
        cid,
        `SELECT campaign.id, campaign.status, campaign.advertising_channel_type, campaign.shopping_setting.merchant_id, campaign.bidding_strategy, ${UPGRADED} FROM campaign WHERE campaign.id = ${targetCampaign}`,
        { maxRows: 1 }
      )
    ).rows[0]
    if (!target || str(target, "campaign.status") === "REMOVED")
      throw notFound("chiến dịch đích", targetCampaign)
    const tc = str(target, "campaign.advertising_channel_type")
    if (tc === "VIDEO") throw videoReadOnlyError("copy")
    if (tc !== "DEMAND_GEN") throw channelMismatch("DEMAND_GEN", tc)
    // location / language would be lost (or rejected) between campaign-level and ad-group-level targeting
    if (isUpgraded(ag) !== isUpgraded(target))
      throw targetingModeMismatch(isUpgraded(ag))
  }
  let ads: GoogleAdsRow[] = []
  if (r.deep) {
    ads = await readAll(
      client,
      cid,
      `SELECT ${DG_AD_COPY_FIELDS.join(", ")} FROM ad_group_ad WHERE ad_group.id = ${id} AND ad_group_ad.status != 'REMOVED'`,
      5_000,
      "quảng cáo"
    )
    assertAdCap(ads.length)
  }
  // always read criteria: Demand Gen targeting (location, language, audiences…) lives on the ad group
  const criteria = await readAll(
    client,
    cid,
    `SELECT ${DG_AD_GROUP_CRITERION_COPY_FIELDS.join(", ")} FROM ad_group_criterion WHERE ad_group.id = ${id} AND ad_group_criterion.status != 'REMOVED'`,
    9_000,
    "tiêu chí nhóm"
  )
  const needsFeed =
    ads.some((a) => str(a, `${A}.type`) === "DEMAND_GEN_PRODUCT_AD") ||
    criteria.some((k) => str(k, "ad_group_criterion.type") === "LISTING_GROUP")
  if (target && needsFeed && !hasMerchant(target)) throw needsFeedError()
  const base = copyName(
    str(ag, "ad_group.name") ?? id,
    r.namePrefix,
    r.nameSuffix
  )
  const name = uniqueName(
    base,
    await existingNames(client, cid, "ad_group", base, targetCampaign)
  )
  const campaignRow = target ?? ag
  const plan = buildDemandGenAdGroupCopy(
    cid,
    targetCampaign,
    ag,
    criteria,
    ads,
    {
      name,
      deep: r.deep,
      allowIncomplete: r.allowIncomplete === true,
      targetUpgraded: isUpgraded(campaignRow),
      otherCampaign: !!target,
      portfolio: !!str(campaignRow, "campaign.bidding_strategy"),
    }
  )
  return runPlan(client, cid, plan, opts, async () =>
    findByName(client, cid, "ad_group", name, targetCampaign)
  )
}

export async function copyDemandGenAd(
  client: GoogleAdsClient,
  cid: string,
  source: GoogleAdsRow,
  r: CopyRequest,
  opts: MutationOptions
): Promise<CopyResult> {
  const agId = assertId(str(source, "ad_group.id") ?? "", "ad_group_id")
  const adId = assertId(str(source, `${A}.id`) ?? "", "ad_id")
  const ad = (
    await client.searchAll(
      cid,
      `SELECT ${DG_AD_COPY_FIELDS.join(", ")} FROM ad_group_ad WHERE ${A}.id = ${adId} AND ad_group.id = ${agId}`,
      { maxRows: 1 }
    )
  ).rows[0]
  if (!ad) throw notFound("quảng cáo", r.id)
  const targetAg = r.targetParentId
    ? assertId(r.targetParentId, "target_parent_id")
    : agId
  if (targetAg !== agId) {
    const t = (
      await client.searchAll(
        cid,
        `SELECT ad_group.id, ad_group.status, campaign.advertising_channel_type, campaign.shopping_setting.merchant_id FROM ad_group WHERE ad_group.id IN ${idList([targetAg])}`,
        { maxRows: 1 }
      )
    ).rows[0]
    if (!t || str(t, "ad_group.status") === "REMOVED")
      throw notFound("nhóm quảng cáo đích", targetAg)
    assertNotVideo([t], "copy")
    const tc = str(t, "campaign.advertising_channel_type")
    if (tc !== "DEMAND_GEN") throw channelMismatch("DEMAND_GEN", tc)
    if (str(ad, `${A}.type`) === "DEMAND_GEN_PRODUCT_AD" && !hasMerchant(t))
      throw needsFeedError()
  }
  const plan = buildDemandGenAdCopy(cid, targetAg, ad)
  if (r.namePrefix || r.nameSuffix)
    plan.warnings.push(
      "Quảng cáo Demand Gen giữ nguyên tên như bản gốc - bỏ qua tiền tố/hậu tố tên."
    )
  // ads have no unique name to look up after a timeout → no recovery
  return runPlan(client, cid, plan, opts, async () => null)
}
