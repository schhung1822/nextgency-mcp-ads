// Copy: official async campaign copy task when possible (allowlisted, campaign level, deep) - otherwise
// a DIY deep copy (read tree → strip read-only fields → create DISABLE copies with fresh request_ids).
// Spec: .claude/docs/providers/tiktok.md §5.
import { ProviderError, isProviderError } from "../errors"
import { sleep } from "../rate-limit"
import type { CopyMapping, CopyRequest, CopyResult, MutationOptions, ObjectLevel, ProviderContext } from "../types"
import {
  automationType,
  chunk,
  formatTikTokTime,
  invalid,
  isUpgradedSmartPlus,
  parseTikTokTime,
  str,
  ttFromCtx,
  ttGet,
  ttGetAll,
  ttPost,
  type Raw,
  type TT,
} from "./api"
import { AD_CREATE_VERIFY_HINT, createAdsChecked } from "./ad-create"
import { makeRequestId } from "./client"
import { createChecked, isUncertainCreateError } from "./create-checked"
import type { TikTokCredentials } from "./credentials"
import { routeGmvMaxCopy } from "./gmv-max-write"
import { campaignNotFound, fetchAdsForAdGroups, fetchByIds, fetchOne, objectId } from "./objects"
import { applyStatus } from "./mutate"

/** Poll timing for the async copy task (overridable in tests). */
export const COPY_POLL = { initialDelayMs: 10_000, intervalMs: 10_000, timeoutMs: 120_000 }

export const CAMPAIGN_CREATE_CUTOFF_WARNING =
  "TikTok ngừng cho tạo chiến dịch thủ công (Manual) qua /campaign/create/ sau 31/12/2026 - sau mốc này việc sao chép/tạo chiến dịch thủ công qua API sẽ không còn hoạt động."
const CUSTOM_IDENTITY_WARNING =
  "Quảng cáo dùng Custom Identity (CUSTOMIZED_USER, không phải Spark Ads) trên vị trí TikTok/Tự động: tài khoản tạo từ 15/01/2026 không tạo được, tài khoản cũ cũng không còn được tạo mới - bản sao có thể bị từ chối; hãy chuyển sang Spark Ads (TT_USER/BC_AUTH_TT/AUTH_CODE)."
const MAX_DIY_ADS = 50
const OFFICIAL_COPY_OBJECTIVES = new Set([
  "REACH",
  "TRAFFIC",
  "VIDEO_VIEWS",
  "ENGAGEMENT",
  "APP_PROMOTION",
  "LEAD_GENERATION",
  "WEB_CONVERSIONS",
])

// ---------------------------------------------------------------------------
// Create-field allowlists (API reference "Create a campaign / ad group / ads", v1.3, read 2026-10-02).
// Anything else returned by GET (ids, times, statuses, secondary_status, campaign_automation_type,
// split_test_*, schedule_infos, ad_id_v2, is_aco, …) is read-only and stripped.
// ---------------------------------------------------------------------------

export const CAMPAIGN_CREATE_FIELDS = [
  "objective_type",
  "app_promotion_type",
  "virtual_objective_type",
  "sales_destination",
  "is_search_campaign",
  "campaign_type",
  "app_id",
  "is_advanced_dedicated_campaign",
  "disable_skan_campaign",
  "campaign_app_profile_page_state",
  "campaign_product_source",
  "catalog_enabled",
  "special_industries",
  "budget_optimize_on",
  "budget_mode",
  "budget",
  "rta_id",
  "rta_bid_enabled",
  "rta_product_selection_enabled",
  "po_number",
] as const

export const ADGROUP_CREATE_FIELDS = [
  "shopping_ads_type",
  "identity_id",
  "identity_type",
  "identity_authorized_bc_id",
  "product_source",
  "catalog_id",
  "catalog_authorized_bc_id",
  "store_id",
  "store_authorized_bc_id",
  "promotion_type",
  "promotion_target_type",
  "messaging_app_type",
  "messaging_app_account_id",
  "phone_region_code",
  "phone_region_calling_code",
  "phone_number",
  "promotion_website_type",
  "app_id",
  "pixel_id",
  "optimization_event",
  "custom_conversion_id",
  "app_config",
  "deep_funnel_optimization_status",
  "deep_funnel_event_source",
  "deep_funnel_event_source_id",
  "deep_funnel_optimization_event",
  "placement_type",
  "placements",
  "tiktok_subplacements",
  "search_result_enabled",
  "automated_keywords_enabled",
  "search_keywords",
  "comment_disabled",
  "video_download_disabled",
  "share_disabled",
  "blocked_pangle_app_ids",
  "saved_audience_id",
  "shopping_ads_retargeting_type",
  "shopping_ads_retargeting_actions_days",
  "included_custom_actions",
  "excluded_custom_actions",
  "shopping_ads_retargeting_custom_audience_relation",
  "location_ids",
  "zipcode_ids",
  "languages",
  "gender",
  "age_groups",
  "spending_power",
  "household_income",
  "audience_ids",
  "smart_audience_enabled",
  "excluded_audience_ids",
  "interest_category_ids",
  "interest_keyword_ids",
  "purchase_intention_keyword_ids",
  "actions",
  "smart_interest_behavior_enabled",
  "included_pangle_audience_package_ids",
  "excluded_pangle_audience_package_ids",
  "operating_systems",
  "min_android_version",
  "ios14_targeting",
  "min_ios_version",
  "device_model_ids",
  "network_types",
  "carrier_ids",
  "isp_ids",
  "device_price_ranges",
  "audience_type",
  "audience_rule",
  "contextual_tag_ids",
  "brand_safety_type",
  "brand_safety_partner",
  "category_exclusion_ids",
  "vertical_sensitivity_id",
  "budget_mode",
  "budget",
  "schedule_type",
  "schedule_start_time",
  "schedule_end_time",
  "dayparting",
  "optimization_goal",
  "secondary_optimization_event",
  "message_event_set_id",
  "frequency",
  "frequency_schedule",
  "bid_type",
  "bid_price",
  "conversion_bid_price",
  "deep_bid_type",
  "roas_bid",
  "vbo_window",
  "bid_display_mode",
  "next_day_retention",
  "click_attribution_window",
  "engaged_view_attribution_window",
  "view_attribution_window",
  "attribution_event_count",
  "billing_event",
  "pacing",
  "statistic_type",
  "is_hfss",
  "is_lhf_compliance",
  "creative_material_mode",
  "adgroup_app_profile_page_state",
] as const

export const AD_CREATE_CREATIVE_FIELDS = [
  "ad_name",
  "identity_type",
  "identity_id",
  "identity_authorized_bc_id",
  "catalog_id",
  "product_specific_type",
  "item_group_ids",
  "product_set_id",
  "sku_ids",
  "vehicle_ids",
  "showcase_products",
  "ad_format",
  "vertical_video_strategy",
  "dynamic_format",
  "video_id",
  "image_ids",
  "carousel_image_index",
  "end_card_cta",
  "product_display_field_list",
  "auto_disclaimer_types",
  "music_id",
  "tiktok_item_id",
  "promotional_music_disabled",
  "item_duet_status",
  "item_stitch_status",
  "dark_post_status",
  "shopping_ads_video_package_id",
  "ad_text",
  "ad_texts",
  "call_to_action",
  "call_to_action_id",
  "card_id",
  "landing_page_url",
  "utm_params",
  "page_id",
  "cpp_url",
  "tiktok_page_category",
  "phone_region_code",
  "phone_region_calling_code",
  "phone_number",
  "creative_auto_enhancement_strategy_list",
  "deeplink",
  "deeplink_type",
  "deeplink_format_type",
  "shopping_ads_deeplink_type",
  "deeplink_utm_params",
  "shopping_ads_fallback_type",
  "fallback_type",
  "dynamic_destination",
  "instant_product_page_used",
  "page_image_index",
  "auto_message_id",
  "aigc_disclosure_type",
  "disclaimer_type",
  "disclaimer_text",
  "disclaimer_clickable_texts",
  "tracking_pixel_id",
  "tracking_app_id",
  "tracking_offline_event_set_ids",
  "tracking_message_event_set_id",
  "viewability_postbid_partner",
  "viewability_vast_url",
  "brand_safety_postbid_partner",
  "brand_safety_vast_url",
  "impression_tracking_url",
  "click_tracking_url",
  "playable_url",
  "creative_type",
  "video_view_tracking_url",
  "app_name",
  "display_name",
  "avatar_icon_web_uri",
  "creative_authorized",
] as const

function pick(src: Raw, fields: readonly string[]): Raw {
  const out: Raw = {}
  for (const k of fields) {
    const v = src[k]
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

export function copyName(name: string, prefix?: string, suffix?: string): string {
  const p = prefix ?? ""
  const s = prefix || suffix ? (suffix ?? "") : " - Bản sao"
  return `${p}${name}${s}`.slice(0, 512)
}

export function campaignCreateBody(src: Raw, advertiserId: string, name: string, requestId: string): Raw {
  return {
    advertiser_id: advertiserId,
    ...pick(src, CAMPAIGN_CREATE_FIELDS),
    campaign_name: name,
    operation_status: "DISABLE",
    request_id: requestId,
  }
}

/**
 * New schedule for a copied ad group: start ≥ now (+10 min); lifetime/end-dated groups keep their flight LENGTH (when
 * the start moves, the end moves by the same delta) so a lifetime budget is not squeezed into fewer days.
 */
export function freshSchedule(src: Raw, now: Date): { schedule: Raw; changed: boolean } {
  const minStart = new Date(Math.ceil((now.getTime() + 10 * 60_000) / 60_000) * 60_000)
  const start = parseTikTokTime(src.schedule_start_time) ?? minStart
  const end = parseTikTokTime(src.schedule_end_time)
  const type = src.schedule_type === "SCHEDULE_START_END" || src.budget_mode === "BUDGET_MODE_TOTAL" ? "SCHEDULE_START_END" : "SCHEDULE_FROM_NOW"
  let newStart = start
  let changed = false
  if (start.getTime() < minStart.getTime()) {
    newStart = minStart
    changed = true
  }
  const schedule: Raw = { schedule_type: type, schedule_start_time: formatTikTokTime(newStart) }
  if (type === "SCHEDULE_START_END") {
    const duration = end && start ? Math.max(end.getTime() - start.getTime(), 86_400_000) : 7 * 86_400_000
    let newEnd = end
    // start moved → shift the end by the same delta (same number of days as the source flight)
    if (!newEnd || changed || newEnd.getTime() <= newStart.getTime() + 3_600_000) {
      newEnd = new Date(newStart.getTime() + duration)
      changed = true
    }
    schedule.schedule_end_time = formatTikTokTime(newEnd)
  }
  return { schedule, changed }
}

export function adgroupCreateBody(
  src: Raw,
  advertiserId: string,
  campaignId: string,
  name: string,
  requestId: string,
  now: Date,
  warnings: string[]
): Raw {
  const body: Raw = {
    advertiser_id: advertiserId,
    ...pick(src, ADGROUP_CREATE_FIELDS),
    campaign_id: campaignId,
    adgroup_name: name,
    operation_status: "DISABLE",
    request_id: requestId,
  }
  if (body.placement_type === "PLACEMENT_TYPE_AUTOMATIC") delete body.placements
  if (Array.isArray(body.tiktok_subplacements) && body.tiktok_subplacements.includes("TIKTOK_LITE")) {
    body.tiktok_subplacements = body.tiktok_subplacements.filter((s) => s !== "TIKTOK_LITE")
    warnings.push(`Nhóm "${name}": đã bỏ vị trí TIKTOK_LITE (TikTok không còn hỗ trợ).`)
  }
  const { schedule, changed } = freshSchedule(src, now)
  Object.assign(body, schedule)
  if (body.schedule_type === "SCHEDULE_FROM_NOW") delete body.schedule_end_time
  if (changed) {
    warnings.push(
      `Nhóm "${name}": lịch gốc đã qua nên bản sao bắt đầu từ ${String(body.schedule_start_time)} (UTC)${body.schedule_end_time ? `, kết thúc ${String(body.schedule_end_time)} (UTC) - giữ nguyên độ dài lịch chạy của nhóm gốc để ngân sách trọn đời không bị dồn vào ít ngày hơn` : ""}.`
    )
  }
  return body
}

export function adCreativeFromSource(src: Raw, name?: string): Raw {
  const creative = pick(src, AD_CREATE_CREATIVE_FIELDS)
  if (name !== undefined) creative.ad_name = name
  creative.operation_status = "DISABLE"
  return creative
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

interface Tree {
  campaign?: Raw
  groups: Raw[]
  adsByGroup: Map<string, Raw[]>
}

async function readAdGroups(tt: TT, campaignId: string): Promise<Raw[]> {
  return ttGetAll<Raw>(tt, "adgroup/get", {
    advertiser_id: tt.advertiserId,
    filtering: { campaign_ids: [campaignId], primary_status: "STATUS_NOT_DELETE" },
    exclude_field_types_in_response: ["NULL_FIELD"],
  })
}

async function readAds(tt: TT, groupIds: string[]): Promise<Map<string, Raw[]>> {
  const ads = groupIds.length ? await fetchAdsForAdGroups(tt, groupIds) : []
  const by = new Map<string, Raw[]>()
  for (const a of ads) {
    const k = String(a.adgroup_id)
    by.set(k, [...(by.get(k) ?? []), a])
  }
  return by
}

function assertCopyable(level: ObjectLevel, o: Raw): void {
  const t = automationType(o)
  if (t === "SMART_PLUS") {
    throw new ProviderError({
      platform: "tiktok",
      code: "unsupported",
      message: "Legacy Smart+ cannot be copied",
      userMessageVi: "Không sao chép được chiến dịch Smart+ đời cũ (TikTok đã ngừng tạo/sửa loại này qua API).",
      hint: "Tạo chiến dịch mới bằng tiktok_create_campaign hoặc trong TikTok Ads Manager.",
    })
  }
  if (isUpgradedSmartPlus(o) && level !== "campaign") {
    throw new ProviderError({
      platform: "tiktok",
      code: "unsupported",
      message: "Upgraded Smart+ ad groups/ads cannot be copied individually",
      userMessageVi: "TikTok chỉ hỗ trợ sao chép Upgraded Smart+ ở cấp chiến dịch (cần allowlist).",
    })
  }
}

export async function copyTikTokObject(
  ctx: ProviderContext<TikTokCredentials>,
  r: CopyRequest,
  opts: MutationOptions & { now?: Date } = {}
): Promise<CopyResult> {
  const tt = ttFromCtx(ctx)
  const now = opts.now ?? new Date()
  const warnings: string[] = []
  let src: Raw
  if (r.level === "campaign") {
    // GMV Max (C3/C6): needs the admin switch; copied as a NEW GMV Max campaign (runs at once) after pre-checks
    const found = (await fetchByIds(tt, "campaign", [r.id])).get(String(r.id)) ?? null
    const gmv = await routeGmvMaxCopy(tt, r, found, opts)
    if (gmv) return gmv
    if (!found) throw campaignNotFound(r.id)
    src = found
  } else {
    src = await fetchOne(tt, r.level, r.id)
  }
  assertCopyable(r.level, src)
  const name = copyName(
    str(r.level === "campaign" ? src.campaign_name : r.level === "ad_group" ? src.adgroup_name : src.ad_name) ?? r.id,
    r.namePrefix,
    r.nameSuffix
  )

  if (r.level === "campaign") {
    if (src.objective_type === "RF_REACH") {
      throw invalid("Không sao chép chiến dịch Reach & Frequency (TikTok không cho tạo ở trạng thái tắt).")
    }
    const tree: Tree = { campaign: src, groups: [], adsByGroup: new Map() }
    if (r.deep) {
      tree.groups = await readAdGroups(tt, r.id)
      tree.adsByGroup = await readAds(tt, tree.groups.map((g) => String(g.adgroup_id)))
    }
    if (isUpgradedSmartPlus(src)) {
      if (!r.deep) throw invalid("Upgraded Smart+ chỉ sao chép được toàn bộ chiến dịch (deep=true).")
      const res = await officialCampaignCopy(tt, src, tree, name, opts, now, warnings, true)
      if (res) return res
      throw new ProviderError({
        platform: "tiktok",
        code: "feature_not_enabled",
        message: "Upgraded Smart+ copy task not allowlisted",
        userMessageVi:
          "Sao chép chiến dịch Upgraded Smart+ cần TikTok mở allowlist cho tài khoản; app không tự sao chép thủ công loại chiến dịch này.",
        hint: "Liên hệ đại diện TikTok hoặc sao chép trong TikTok Ads Manager.",
      })
    }
    if (r.deep) {
      const res = await officialCampaignCopy(tt, src, tree, name, opts, now, warnings, false)
      if (res) return res
    }
    return diyCopyCampaign(tt, tree, name, r, opts, now, warnings)
  }

  if (r.level === "ad_group") {
    const targetCampaignId = r.targetParentId ?? String(src.campaign_id)
    const target = targetCampaignId === String(src.campaign_id) ? null : await fetchOne(tt, "campaign", targetCampaignId)
    if (target) {
      assertCopyable("campaign", target)
      if (isUpgradedSmartPlus(target)) throw invalid("Không chép nhóm quảng cáo thủ công vào chiến dịch Upgraded Smart+.")
      const srcCbo = src.budget_mode === "BUDGET_MODE_INFINITE"
      if (srcCbo !== (target.budget_optimize_on === true)) {
        throw invalid("Chiến dịch đích khác chế độ CBO với nhóm nguồn - TikTok không cho chép giữa CBO và không CBO.")
      }
    }
    const adsByGroup = r.deep ? await readAds(tt, [r.id]) : new Map<string, Raw[]>()
    return diyCopyAdGroups(tt, [src], adsByGroup, targetCampaignId, { [r.id]: name }, r.deep, opts, now, warnings)
  }

  // ad
  const targetAdGroupId = r.targetParentId ?? String(src.adgroup_id)
  if (targetAdGroupId !== String(src.adgroup_id)) {
    const target = await fetchOne(tt, "ad_group", targetAdGroupId)
    assertCopyable("ad_group", target)
  }
  const mappings: CopyMapping[] = []
  await diyCreateAds(tt, targetAdGroupId, [{ src, name }], mappings, opts, warnings)
  return {
    preview: !!opts.dryRun,
    mode: "emulated",
    rootNewId: mappings[0]?.newId ?? null,
    mappings,
    warnings: withTailWarnings(warnings, mappings),
  }
}

function withTailWarnings(warnings: string[], mappings: CopyMapping[]): string[] {
  const out = [...new Set(warnings)]
  if (mappings.some((m) => m.error) && mappings.some((m) => m.newId)) {
    out.push("Có lỗi giữa chừng - các bản sao đã tạo đều đang TẮT; có thể xoá bằng ads_delete_object nếu không dùng.")
  }
  return out
}

// ---------------------------------------------------------------------------
// Official async copy task
// ---------------------------------------------------------------------------

async function officialCampaignCopy(
  tt: TT,
  src: Raw,
  tree: Tree,
  name: string,
  opts: MutationOptions,
  now: Date,
  warnings: string[],
  smartPlus: boolean
): Promise<CopyResult | null> {
  const prefix = smartPlus ? "smart_plus/" : ""
  // Eligibility (Copy a Manual Campaign guide): objective, 1–20 ad groups, ≤50 ads each, no ACO.
  if (!smartPlus) {
    const reasons: string[] = []
    if (!OFFICIAL_COPY_OBJECTIVES.has(String(src.objective_type))) reasons.push("mục tiêu không hỗ trợ")
    if (tree.groups.length < 1 || tree.groups.length > 20) reasons.push("số nhóm quảng cáo ngoài 1–20")
    if (tree.groups.some((g) => g.creative_material_mode === "DYNAMIC")) reasons.push("có nhóm ACO")
    if (tree.groups.some((g) => (tree.adsByGroup.get(String(g.adgroup_id))?.length ?? 0) > 50)) reasons.push("nhóm có >50 quảng cáo")
    if (![...tree.adsByGroup.values()].some((a) => a.length > 0)) reasons.push("không có quảng cáo nào")
    if (reasons.length) {
      warnings.push(`Không dùng được tác vụ sao chép chính thức của TikTok (${reasons.join(", ")}) - chuyển sang sao chép từng phần.`)
      return null
    }
  }
  // Schedule: ad groups that started >12h ago cannot be copied as-is.
  const limit = now.getTime() - 11 * 3_600_000
  const stale = tree.groups.filter((g) => (parseTikTokTime(g.schedule_start_time)?.getTime() ?? now.getTime()) < limit)
  const body: Raw = {
    advertiser_id: tt.advertiserId,
    campaign_id: String(src.campaign_id),
    request_id: makeRequestId(opts.idempotencyKey, "copy-task"),
    operation_status: "DISABLE",
    campaign_name: name,
    deep_copy_mode: "DEFAULT",
  }
  if (!smartPlus) {
    // Copied ad groups and ads default to ENABLE (doc 1788434394151938): CUSTOM mode lists every
    // undeleted ad group / ad explicitly with operation_status DISABLE so nothing starts when the
    // campaign is turned on.
    // Names are sent explicitly (default would be "COPIED_{{original_name}}_{{original_id}}", doc 1788434394151938) so
    // the task result - which carries no source id - can be mapped back by name.
    body.deep_copy_mode = "CUSTOM"
    body.adgroup_list = tree.groups.map((g) => ({
      adgroup_id: String(g.adgroup_id),
      ...(str(g.adgroup_name) ? { adgroup_name: str(g.adgroup_name) } : {}),
      operation_status: "DISABLE",
      ad_list: (tree.adsByGroup.get(String(g.adgroup_id)) ?? []).map((a) => ({
        ad_id: String(a.ad_id),
        ...(str(a.ad_name) ? { ad_name: str(a.ad_name) } : {}),
        operation_status: "DISABLE",
      })),
    }))
  }
  let scheduleNote: string | null = null
  if (stale.length) {
    const endDated = tree.groups.some((g) => g.schedule_type === "SCHEDULE_START_END" || g.budget_mode === "BUDGET_MODE_TOTAL")
    if (endDated) {
      if (smartPlus) {
        warnings.push("Một số nhóm Smart+ có lịch đã qua và có ngày kết thúc - TikTok có thể từ chối bản sao.")
      } else {
        warnings.push("Nhóm quảng cáo có lịch kết thúc đã qua - chuyển sang sao chép từng phần để đặt lại lịch cho từng nhóm.")
        return null
      }
    } else {
      const start = new Date(Math.ceil((now.getTime() + 10 * 60_000) / 60_000) * 60_000)
      body.schedule_type = "SCHEDULE_FROM_NOW"
      body.schedule_start_time = formatTikTokTime(start)
      scheduleNote = `Lịch gốc đã qua nên mọi nhóm trong bản sao bắt đầu từ ${String(body.schedule_start_time)} (UTC).`
    }
  }
  if (opts.dryRun) {
    return {
      preview: true,
      mode: "native",
      rootNewId: null,
      mappings: previewMappings(tree),
      warnings: [
        ...warnings,
        ...(scheduleNote ? [scheduleNote] : []),
        "Sẽ thử tác vụ sao chép chính thức của TikTok (cần allowlist); nếu chưa được mở sẽ tự chuyển sang sao chép từng phần.",
      ],
    }
  }
  let taskId: string
  try {
    const res = await ttPost<{ task_id?: string; adgroup_error_list?: unknown[] }>(
      tt,
      `${prefix}campaign/copy/task/create`,
      body,
      // retried only on throttle codes inside the 10-second request_id window (client.ts tiktokCreateRetryDecision)
      { create: true }
    )
    const errs = res.data.adgroup_error_list ?? []
    taskId = String(res.data.task_id ?? "")
    if (!taskId) {
      warnings.push(`TikTok từ chối tác vụ sao chép: ${joinErrors(errs) || "không rõ lý do"}.`)
      if (smartPlus) throw invalid("TikTok từ chối sao chép chiến dịch Upgraded Smart+.", joinErrors(errs))
      warnings.push("Chuyển sang sao chép từng phần.")
      return null
    }
  } catch (e) {
    if (isProviderError(e) && (e.code === "feature_not_enabled" || e.code === "permission_denied")) {
      if (!smartPlus) warnings.push("Tài khoản chưa được TikTok mở tác vụ sao chép chính thức (allowlist) - chuyển sang sao chép từng phần.")
      return null
    }
    if (isUncertainCreateError(e)) {
      // the task may be running on TikTok: no DIY fallback, no retry (a second copy would be created)
      const pe = isProviderError(e) ? e : null
      throw new ProviderError({
        platform: "tiktok",
        code: pe?.code ?? "upstream_error",
        message: `TikTok copy task create outcome unknown: ${pe?.message ?? String(e)}`,
        userMessageVi: `TikTok không phản hồi rõ khi tạo tác vụ sao chép (${pe?.userMessageVi ?? "lỗi mạng"}) - bản sao "${name.slice(0, 80)}" có thể vẫn đang được tạo.`,
        retryable: false,
        hint: "Kiểm tra trong TikTok Ads Manager (hoặc ads_list_objects level=campaign) trước khi thử lại để tránh tạo trùng; bản sao (nếu có) đang TẮT.",
        upstream: pe?.upstream,
        cause: e,
      })
    }
    throw e
  }

  if (scheduleNote) warnings.push(scheduleNote)
  const taskNote = `task_id ${taskId}`
  const pendingResult = (why: string): CopyResult => ({
    preview: false,
    mode: "native",
    rootNewId: null,
    // structured trace of the task so the caller/AI can follow up even without the new ids
    mappings: [{ level: "campaign", sourceId: String(src.campaign_id), newId: null, error: `Đang xử lý - ${taskNote}` }],
    warnings: [
      ...warnings,
      `${why} (${taskNote}). Chiến dịch bản sao ở trạng thái TẮT - kiểm tra lại sau vài phút bằng ads_list_objects; KHÔNG chạy sao chép lại để tránh tạo trùng.`,
      ...(smartPlus
        ? ["CẢNH BÁO: các nhóm quảng cáo con của bản sao Smart+ có thể đang BẬT (mặc định của TikTok) - hãy tắt chúng trước khi bật chiến dịch."]
        : []),
    ],
  })

  // Poll - any error here must not lose the task_id (the copy is already running on TikTok).
  let result: Raw | null = null
  try {
    const started = Date.now()
    await sleep(COPY_POLL.initialDelayMs, tt.signal)
    for (;;) {
      const res = await ttGet<Raw>(tt, `${prefix}campaign/copy/task/check`, { advertiser_id: tt.advertiserId, task_id: taskId })
      const status = String(res.data.task_status ?? "")
      if (status === "SUCCESS" || status === "FAILURE") {
        result = res.data
        break
      }
      if (Date.now() - started >= COPY_POLL.timeoutMs) break
      await sleep(COPY_POLL.intervalMs, tt.signal)
    }
  } catch (e) {
    const msg = isProviderError(e) ? e.userMessageVi : "lỗi mạng"
    return pendingResult(`Không kiểm tra được tiến độ tác vụ sao chép của TikTok (${msg})`)
  }
  if (!result) return pendingResult("TikTok vẫn đang xử lý tác vụ sao chép")
  const tr = (result.task_result as Raw | undefined) ?? {}
  const newCampaignId = str(tr.campaign_id)
  if (result.task_status === "FAILURE" || !newCampaignId) {
    const errs = joinErrors(tr.campaign_error_infos)
    throw new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: `TikTok copy task ${taskId} failed`,
      userMessageVi: `Tác vụ sao chép của TikTok (${taskNote}) thất bại${errs ? `: ${errs}` : ""}.`,
      hint: "Kiểm tra trong TikTok Ads Manager và xoá bản nháp lỗi nếu có.",
    })
  }
  const mappings: CopyMapping[] = [{ level: "campaign", sourceId: String(src.campaign_id), newId: newCampaignId }]
  const results = (tr.adgroup_result_list as Raw[] | undefined) ?? []
  const used = new Set<number>()
  // every ad group the task created is disabled below - including any that could not be mapped to its source
  const newGroupIds: string[] = results
    .map((x) => (x.adgroup_id && x.adgroup_id !== "0" ? String(x.adgroup_id) : null))
    .filter((id): id is string => !!id)
  tree.groups.forEach((g) => {
    const idx = matchCopyResult(results, used, "adgroup_name", g.adgroup_name, g.adgroup_id)
    const res = idx >= 0 ? results[idx]! : null
    if (idx >= 0) used.add(idx)
    const gid = res && res.adgroup_id && res.adgroup_id !== "0" ? String(res.adgroup_id) : null
    const gErr = joinErrors(res?.adgroup_error_list)
    mappings.push({
      level: "ad_group",
      sourceId: String(g.adgroup_id),
      newId: gid,
      ...(gErr || !gid ? { error: gErr || (res ? "Không sao chép được" : "Không ánh xạ được id nhóm bản sao") } : {}),
    })
    const srcAds = tree.adsByGroup.get(String(g.adgroup_id)) ?? []
    const adResults = (res?.ad_result_list as Raw[] | undefined) ?? []
    const usedAds = new Set<number>()
    srcAds.forEach((a) => {
      const ai = matchCopyResult(adResults, usedAds, "ad_name", a.ad_name, a.ad_id)
      const ar = ai >= 0 ? adResults[ai]! : null
      if (ai >= 0) usedAds.add(ai)
      const newId = ar && ar.is_success ? str(ar.ad_id ?? ar.smart_plus_ad_id) : null
      const err = joinErrors(ar?.ad_error_list)
      mappings.push({
        level: "ad",
        sourceId: objectId("ad", a),
        newId,
        ...(newId ? {} : { error: err || (ar ? "Không sao chép được" : "Không ánh xạ được id quảng cáo bản sao") }),
      })
    })
  })
  // Belt and braces: copied ad groups default to ENABLE (Smart+ copy has no per-group status) - disable them
  // explicitly; if that fails, say loudly that they may be live once the campaign is enabled.
  if (newGroupIds.length) {
    try {
      const objs = newGroupIds.map((id) => ({
        adgroup_id: id,
        campaign_automation_type: smartPlus ? "UPGRADED_SMART_PLUS" : "MANUAL",
      }))
      const applied = await applyStatus(tt, "ad_group", objs, "DISABLE")
      if (applied.failed.length || applied.warnings.length) {
        warnings.push(
          `CẢNH BÁO: chiến dịch bản sao đang TẮT nhưng TikTok chưa xác nhận tắt hết các nhóm quảng cáo con (${applied.warnings.join(" ")}) - các nhóm có thể đang BẬT, kiểm tra và tắt trước khi bật chiến dịch.`
        )
      }
    } catch (e) {
      warnings.push(
        `CẢNH BÁO: chiến dịch bản sao đang TẮT nhưng không xác nhận tắt được các nhóm quảng cáo con (${isProviderError(e) ? e.userMessageVi : "lỗi"})${smartPlus ? "" : " - đã yêu cầu TikTok tạo chúng ở trạng thái TẮT"}; các nhóm có thể đang BẬT - kiểm tra và tắt trước khi bật chiến dịch.`
      )
    }
  }
  if (mappings.some((m) => m.level === "ad_group" && !m.newId)) {
    warnings.push(`Không ánh xạ được id của một số nhóm quảng cáo bản sao (${taskNote}) - kiểm tra trạng thái của chúng trong TikTok Ads Manager trước khi bật chiến dịch.`)
  }
  if (!smartPlus) warnings.push(CAMPAIGN_CREATE_CUTOFF_WARNING)
  return { preview: false, mode: "native", rootNewId: newCampaignId, mappings, warnings: withTailWarnings(warnings, mappings) }
}

/**
 * Index of the copy-task result for a source object: same name (the names are sent in adgroup_list/ad_list), else
 * TikTok's default name "COPIED_{{original_name}}_{{original_id}}" (suffix `_<source id>`). No positional fallback -
 * the result carries no source id, so a guess could map the wrong ids. -1 = not mapped.
 */
export function matchCopyResult(results: Raw[], used: Set<number>, nameKey: string, srcName: unknown, srcId: unknown): number {
  const name = str(srcName)
  let idx = name === null ? -1 : results.findIndex((x, i) => !used.has(i) && str(x[nameKey]) === name)
  if (idx < 0 && str(srcId)) {
    const suffix = `_${String(srcId)}`
    idx = results.findIndex((x, i) => !used.has(i) && (str(x[nameKey]) ?? "").endsWith(suffix))
  }
  return idx
}

/** TikTok error lists are documented as string arrays but sometimes carry objects - never print "[object Object]". */
export function joinErrors(v: unknown): string {
  if (!Array.isArray(v)) return v === undefined || v === null || v === "" ? "" : typeof v === "string" ? v : JSON.stringify(v)
  return v
    .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
    .filter(Boolean)
    .join("; ")
}

function previewMappings(tree: Tree): CopyMapping[] {
  const out: CopyMapping[] = []
  if (tree.campaign) out.push({ level: "campaign", sourceId: String(tree.campaign.campaign_id), newId: null })
  for (const g of tree.groups) {
    out.push({ level: "ad_group", sourceId: String(g.adgroup_id), newId: null })
    for (const a of tree.adsByGroup.get(String(g.adgroup_id)) ?? []) out.push({ level: "ad", sourceId: objectId("ad", a), newId: null })
  }
  return out
}

// ---------------------------------------------------------------------------
// DIY deep copy
// ---------------------------------------------------------------------------

function countAds(adsByGroup: Map<string, Raw[]>, groupIds: string[]): number {
  return groupIds.reduce((n, id) => n + (adsByGroup.get(id)?.length ?? 0), 0)
}

function adWarnings(ads: Raw[], warnings: string[]) {
  if (ads.some((a) => a.identity_type === "CUSTOMIZED_USER")) warnings.push(CUSTOM_IDENTITY_WARNING)
}

async function diyCopyCampaign(
  tt: TT,
  tree: Tree,
  name: string,
  r: CopyRequest,
  opts: MutationOptions,
  now: Date,
  warnings: string[]
): Promise<CopyResult> {
  const src = tree.campaign!
  const groupIds = tree.groups.map((g) => String(g.adgroup_id))
  if (countAds(tree.adsByGroup, groupIds) > MAX_DIY_ADS) {
    throw invalid(`Sao chép từng phần tối đa ${MAX_DIY_ADS} quảng cáo mỗi lần.`, "Sao chép từng nhóm quảng cáo (level=ad_group).")
  }
  warnings.push(CAMPAIGN_CREATE_CUTOFF_WARNING)
  const body = campaignCreateBody(src, tt.advertiserId, name, makeRequestId(opts.idempotencyKey, "campaign"))
  if (opts.dryRun) {
    const groupNames = Object.fromEntries(tree.groups.map((g) => [String(g.adgroup_id), str(g.adgroup_name) ?? ""]))
    const res = await diyCopyAdGroups(tt, tree.groups, tree.adsByGroup, "(mới)", groupNames, r.deep, opts, now, warnings)
    return {
      preview: true,
      mode: "emulated",
      rootNewId: null,
      mappings: [{ level: "campaign", sourceId: String(src.campaign_id), newId: null }, ...res.mappings],
      warnings: res.warnings,
    }
  }
  // retried only on throttle codes within the request_id window; unknown outcome → lookup by name (create-checked.ts)
  const newId = await createChecked(tt, { kind: "campaign", path: "campaign/create", body, name }, warnings)
  if (!newId) throw invalid("TikTok không trả về campaign_id của bản sao.")
  const mappings: CopyMapping[] = [{ level: "campaign", sourceId: String(src.campaign_id), newId }]
  if (!r.deep) {
    return { preview: false, mode: "emulated", rootNewId: newId, mappings, warnings: withTailWarnings(warnings, mappings) }
  }
  const groupNames = Object.fromEntries(tree.groups.map((g) => [String(g.adgroup_id), str(g.adgroup_name) ?? ""]))
  const res = await diyCopyAdGroups(tt, tree.groups, tree.adsByGroup, newId, groupNames, true, opts, now, warnings)
  const all = [...mappings, ...res.mappings]
  return { preview: false, mode: "emulated", rootNewId: newId, mappings: all, warnings: withTailWarnings(warnings, all) }
}

async function diyCopyAdGroups(
  tt: TT,
  groups: Raw[],
  adsByGroup: Map<string, Raw[]>,
  campaignId: string,
  names: Record<string, string>,
  deep: boolean,
  opts: MutationOptions,
  now: Date,
  warnings: string[]
): Promise<CopyResult> {
  const groupIds = groups.map((g) => String(g.adgroup_id))
  if (deep && countAds(adsByGroup, groupIds) > MAX_DIY_ADS) {
    throw invalid(`Sao chép từng phần tối đa ${MAX_DIY_ADS} quảng cáo mỗi lần.`)
  }
  const mappings: CopyMapping[] = []
  for (const [gi, g] of groups.entries()) {
    const sid = String(g.adgroup_id)
    if (g.creative_material_mode === "DYNAMIC") {
      mappings.push({ level: "ad_group", sourceId: sid, newId: null, error: "Nhóm ACO (Automated Creative Optimization) không sao chép được." })
      continue
    }
    const body = adgroupCreateBody(
      g,
      tt.advertiserId,
      campaignId,
      names[sid] ?? str(g.adgroup_name) ?? sid,
      makeRequestId(opts.idempotencyKey, `adgroup:${gi}`),
      now,
      warnings
    )
    const ads = deep ? (adsByGroup.get(sid) ?? []) : []
    if (opts.dryRun) {
      mappings.push({ level: "ad_group", sourceId: sid, newId: null })
      await diyCreateAds(tt, "(mới)", ads.map((a) => ({ src: a })), mappings, opts, warnings)
      continue
    }
    let newGroupId: string | null = null
    try {
      newGroupId = await createChecked(
        tt,
        { kind: "adgroup", path: "adgroup/create", body, name: String(body.adgroup_name), campaignId },
        warnings
      )
      mappings.push({ level: "ad_group", sourceId: sid, newId: newGroupId, ...(newGroupId ? {} : { error: "TikTok không trả về adgroup_id" }) })
    } catch (e) {
      const msg = isProviderError(e) ? `${e.userMessageVi}${e.hint ? ` ${e.hint}` : ""}` : "lỗi không xác định"
      mappings.push({ level: "ad_group", sourceId: sid, newId: null, error: msg })
      for (const a of ads) mappings.push({ level: "ad", sourceId: objectId("ad", a), newId: null, error: "Bỏ qua vì nhóm quảng cáo không tạo được." })
      continue
    }
    if (newGroupId && ads.length) {
      await diyCreateAds(tt, newGroupId, ads.map((a) => ({ src: a })), mappings, opts, warnings)
    }
  }
  return {
    preview: !!opts.dryRun,
    mode: "emulated",
    rootNewId: mappings.find((m) => m.level === "ad_group")?.newId ?? null,
    mappings,
    warnings: withTailWarnings(warnings, mappings),
  }
}

/** Create ads in batches of ≤20 creatives per /ad/create/ call. /ad/create/ has no request_id → never retried. */
async function diyCreateAds(
  tt: TT,
  adgroupId: string,
  items: { src: Raw; name?: string }[],
  mappings: CopyMapping[],
  opts: MutationOptions,
  warnings: string[]
): Promise<void> {
  const eligible: { src: Raw; name?: string }[] = []
  for (const it of items) {
    if (it.src.is_aco === true || automationType(it.src) === "UPGRADED_SMART_PLUS_CREATIVE") {
      mappings.push({ level: "ad", sourceId: objectId("ad", it.src), newId: null, error: "Quảng cáo ACO/Smart+ không sao chép riêng được." })
      continue
    }
    eligible.push(it)
  }
  adWarnings(eligible.map((e) => e.src), warnings)
  for (const batch of chunk(eligible, 20)) {
    if (opts.dryRun) {
      for (const it of batch) mappings.push({ level: "ad", sourceId: objectId("ad", it.src), newId: null })
      continue
    }
    const creatives = batch.map((it) => adCreativeFromSource(it.src, it.name))
    try {
      // never retried (no request_id); an uncertain failure is followed by a lookup by ad name
      const ids = await createAdsChecked(tt, adgroupId, creatives, warnings)
      batch.forEach((it, i) => {
        const newId = ids[i] ?? null
        mappings.push({
          level: "ad",
          sourceId: objectId("ad", it.src),
          newId,
          ...(newId ? {} : { error: `TikTok không trả về ad_id. ${AD_CREATE_VERIFY_HINT}` }),
        })
      })
    } catch (e) {
      const msg = isProviderError(e) ? `${e.userMessageVi}${e.hint ? ` ${e.hint}` : ""}` : "lỗi không xác định"
      for (const it of batch) mappings.push({ level: "ad", sourceId: objectId("ad", it.src), newId: null, error: msg })
    }
  }
}
