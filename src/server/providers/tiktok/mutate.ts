// Writes on existing objects: status, budget, generic fields, delete.
// Every write first reads the current object (for routing by campaign_automation_type, validation and
// the before/after preview). dryRun = read + compute, never write.
// Spec: .claude/docs/providers/tiktok.md §4 (status 1–20 ids/call; /adgroup/update/ = FULL replacement;
// /adgroup/budget/update/ daily = scheduled for next day 00:00 account TZ; /ad/update/ patch_update).
import { addDays, todayInTz } from "../dates"
import { ProviderError } from "../errors"
import { roundMoney } from "../money"
import type {
  BudgetUpdate,
  FieldChange,
  MutationOptions,
  MutationResult,
  ObjectLevel,
  ObjectUpdate,
  ProviderContext,
  TargetStatus,
} from "../types"
import {
  apiMoney,
  automationType,
  budgetAmount,
  budgetType,
  chunk,
  invalid,
  isoToTikTokTime,
  isUpgradedSmartPlus,
  LEVEL_VI,
  localHourMinute,
  normalizeStatus,
  notFound,
  parseTikTokTime,
  toTikTokLevel,
  ttFromCtx,
  ttPost,
  zonedMidnightIso,
  type Raw,
  type TikTokLevel,
  type TT,
} from "./api"
import type { TikTokCredentials } from "./credentials"
import { assertNotLegacySmartPlus, fetchByIds, fetchOne, objectId, objectName } from "./objects"

export const STATUS_BATCH = 20
/** Writes that set absolute values are idempotent → safe to retry on transient errors. */
const IDEMPOTENT_RETRIES = 2

type OpStatus = "ENABLE" | "DISABLE" | "DELETE"

// ---------------------------------------------------------------------------
// Status routing
// ---------------------------------------------------------------------------

function statusRoute(tl: TikTokLevel, o: Raw): { path: string; idsKey: string; id: string } {
  if (isUpgradedSmartPlus(o)) {
    if (tl === "ad") {
      return {
        path: "smart_plus/ad/status/update",
        idsKey: "smart_plus_ad_ids",
        id: String(o.smart_plus_ad_id ?? o.ad_id_v2 ?? o.ad_id),
      }
    }
    return {
      path: `smart_plus/${tl}/status/update`,
      idsKey: `${tl}_ids`,
      id: String(tl === "campaign" ? o.campaign_id : o.adgroup_id),
    }
  }
  const id = String(tl === "campaign" ? o.campaign_id : tl === "adgroup" ? o.adgroup_id : o.ad_id)
  return { path: `${tl}/status/update`, idsKey: `${tl}_ids`, id }
}

export interface ApplyStatusResult {
  /** TikTok ids the status was applied to */
  sent: string[]
  /** objects TikTok did NOT update (code 20001 partial success) */
  failed: Raw[]
  warnings: string[]
}

/**
 * Send status updates grouped by endpoint, ≤20 ids per call. Code 20001 (partial success): the ids TikTok returns
 * in data.<level>_ids are the updated ones, the rest of the batch failed (reported as warnings, not as changes).
 * When a partial success carries no id list, the batch is kept as sent with a "verify" warning (UNVERIFIED shape).
 */
export async function applyStatus(tt: TT, level: ObjectLevel, objs: Raw[], op: OpStatus): Promise<ApplyStatusResult> {
  const tl = toTikTokLevel(level)
  const groups = new Map<string, { idsKey: string; ids: string[] }>()
  for (const o of objs) {
    const r = statusRoute(tl, o)
    const g = groups.get(r.path) ?? { idsKey: r.idsKey, ids: [] }
    if (!g.ids.includes(r.id)) g.ids.push(r.id)
    groups.set(r.path, g)
  }
  const sent: string[] = []
  const failedIds = new Set<string>()
  const warnings: string[] = []
  for (const [path, g] of groups) {
    for (const batch of chunk(g.ids, STATUS_BATCH)) {
      const res = await ttPost<Raw>(
        tt,
        path,
        { advertiser_id: tt.advertiserId, [g.idsKey]: batch, operation_status: op },
        { retries: IDEMPOTENT_RETRIES }
      )
      if (res.code !== 20001) {
        sent.push(...batch)
        continue
      }
      const okList = res.data?.[g.idsKey]
      if (!Array.isArray(okList)) {
        sent.push(...batch)
        warnings.push(
          `TikTok báo chỉ thành công một phần khi đổi trạng thái ${LEVEL_VI[level]} (${batch.join(", ")}) nhưng không cho biết id nào lỗi - kiểm tra lại bằng ads_list_objects.`
        )
        continue
      }
      const ok = new Set(okList.map(String))
      const bad = batch.filter((id) => !ok.has(id))
      sent.push(...batch.filter((id) => ok.has(id)))
      for (const id of bad) failedIds.add(id)
      if (bad.length) {
        warnings.push(
          `TikTok không đổi được trạng thái ${LEVEL_VI[level]} ${bad.join(", ")} (thành công một phần${res.message && res.message !== "OK" ? `: ${res.message.slice(0, 200)}` : ""}) - các id này giữ nguyên trạng thái cũ.`
        )
      }
    }
  }
  const failed = objs.filter((o) => failedIds.has(statusRoute(tl, o).id))
  return { sent, failed, warnings }
}

async function resolveAll(tt: TT, level: ObjectLevel, ids: string[]): Promise<Raw[]> {
  const found = await fetchByIds(tt, level, ids)
  const missing = ids.filter((id) => !found.has(String(id)))
  if (missing.length) throw notFound(level, missing.join(", "))
  return ids.map((id) => found.get(String(id))!)
}

export async function setTikTokStatus(
  ctx: ProviderContext<TikTokCredentials>,
  level: ObjectLevel,
  ids: string[],
  status: TargetStatus,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const tt = ttFromCtx(ctx)
  toTikTokLevel(level)
  if (!ids.length) throw invalid("Cần ít nhất 1 id.")
  const op: OpStatus = status === "active" ? "ENABLE" : "DISABLE"
  const objs = await resolveAll(tt, level, [...new Set(ids.map(String))])
  const warnings: string[] = []
  const changes: FieldChange[] = []
  const todo: Raw[] = []
  for (const o of objs) {
    const id = objectId(level, o)
    const before = normalizeStatus(o.operation_status, o.secondary_status)
    if (before === "deleted") {
      warnings.push(`${LEVEL_VI[level]} ${id} đã bị xoá - không thể đổi trạng thái.`)
      continue
    }
    if (o.operation_status === op) {
      warnings.push(`${LEVEL_VI[level]} ${id} đã ở trạng thái ${status === "active" ? "bật" : "tạm dừng"}.`)
      continue
    }
    if (automationType(o) === "SMART_PLUS") {
      warnings.push(`${LEVEL_VI[level]} ${id} thuộc Smart+ đời cũ - dùng endpoint thủ công, kết quả có thể bị TikTok từ chối.`)
    }
    if (automationType(o) === "UPGRADED_SMART_PLUS_CREATIVE") {
      warnings.push(`Id ${id} là creative của quảng cáo Upgraded Smart+ - trạng thái sẽ áp dụng cho cả quảng cáo Smart+.`)
    }
    if (status === "active" && typeof o.secondary_status === "string" && /CAMPAIGN_DISABLE|ADGROUP_DISABLE/.test(o.secondary_status)) {
      warnings.push(`${LEVEL_VI[level]} ${id} sẽ bật nhưng cấp cha đang tạm dừng nên vẫn chưa chạy.`)
    }
    changes.push({
      objectId: id,
      objectName: objectName(level, o),
      level,
      field: "status",
      before,
      after: status,
    })
    todo.push(o)
  }
  if (opts.dryRun || !todo.length) return { preview: !!opts.dryRun, changes, warnings }
  const applied = await applyStatus(tt, level, todo, op)
  warnings.push(...applied.warnings)
  // partial success: only objects TikTok actually updated are reported as changes
  const failed = new Set(applied.failed.map((o) => objectId(level, o)))
  return { preview: false, changes: changes.filter((ch) => !failed.has(ch.objectId)), warnings }
}

export async function deleteTikTokObject(
  ctx: ProviderContext<TikTokCredentials>,
  level: ObjectLevel,
  id: string,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const tt = ttFromCtx(ctx)
  toTikTokLevel(level)
  const o = await fetchOne(tt, level, id)
  const before = normalizeStatus(o.operation_status, o.secondary_status)
  const warnings = ["Xoá trên TikTok là vĩnh viễn, không hoàn tác được."]
  if (before === "deleted") {
    return { preview: !!opts.dryRun, changes: [], warnings: [`${LEVEL_VI[level]} ${id} đã bị xoá trước đó.`] }
  }
  if (level !== "ad") warnings.push(`Xoá ${LEVEL_VI[level]} sẽ dừng toàn bộ đối tượng con bên trong.`)
  const changes: FieldChange[] = [
    { objectId: objectId(level, o), objectName: objectName(level, o), level, field: "status", before, after: "deleted" },
  ]
  if (opts.dryRun) return { preview: true, changes, warnings }
  const applied = await applyStatus(tt, level, [o], "DELETE")
  if (applied.failed.length) {
    throw new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: `TikTok partial success: ${level} ${id} not deleted`,
      userMessageVi: `TikTok không xoá được ${LEVEL_VI[level]} ${id}. ${applied.warnings.join(" ")}`.trim(),
      retryable: false,
    })
  }
  return { preview: false, changes, warnings: [...warnings, ...applied.warnings] }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Next local midnight of the ad account as ISO 8601 with offset (TikTok scheduled_budget effective time). */
export function nextDayMidnightIso(timezone: string, now: Date = new Date()): string {
  return zonedMidnightIso(addDays(todayInTz(timezone, now), 1), timezone)
}

/** TikTok forbids budget changes 23:55–00:00 in the ad account time zone. */
export function inBudgetLockWindow(timezone: string, now: Date = new Date()): boolean {
  const { h, m } = localHourMinute(timezone, now)
  return h === 23 && m >= 55
}

function fmtMoney(v: number | null, currency: string): string {
  if (v === null) return "-"
  return `${new Intl.NumberFormat("vi-VN").format(roundMoney(v, currency) as number)} ${currency}`
}

export async function updateTikTokBudget(
  ctx: ProviderContext<TikTokCredentials>,
  u: BudgetUpdate,
  opts: MutationOptions & { now?: Date } = {}
): Promise<MutationResult> {
  const tt = ttFromCtx(ctx)
  const now = opts.now ?? new Date()
  const amount = apiMoney(u.amount, tt.currency)
  const level: ObjectLevel = u.level
  const o = await fetchOne(tt, level, u.id)
  assertNotLegacySmartPlus(level, o, "đổi ngân sách")
  const status = normalizeStatus(o.operation_status, o.secondary_status)
  if (status === "deleted") throw invalid(`${LEVEL_VI[level]} ${u.id} đã bị xoá.`)
  const currentType = budgetType(o.budget_mode)
  const currentAmount = Number.isFinite(budgetAmount(o)) ? budgetAmount(o) : null
  const warnings: string[] = []

  if (level === "ad_group" && o.budget_mode === "BUDGET_MODE_INFINITE") {
    throw invalid(
      "Nhóm quảng cáo này thuộc chiến dịch tối ưu ngân sách (CBO) - ngân sách nằm ở cấp chiến dịch.",
      "Gọi ads_update_budget với level=campaign và id chiến dịch."
    )
  }
  if (!currentType) {
    throw invalid(
      `${LEVEL_VI[level]} ${u.id} đang để ngân sách không giới hạn (${String(o.budget_mode ?? "?")}) - TikTok không cho đổi chế độ ngân sách sau khi tạo.`
    )
  }
  if (currentType !== u.type) {
    throw invalid(
      `${LEVEL_VI[level]} ${u.id} đang dùng ngân sách ${currentType === "daily" ? "hằng ngày" : "trọn đời"}; TikTok không cho đổi sang loại khác sau khi tạo.`,
      `Gọi lại với type=${currentType}.`
    )
  }
  warnings.push("TikTok yêu cầu ngân sách mới ≥ 105% số đã chi trong kỳ hiện tại, nếu thấp hơn sẽ bị từ chối.")
  // Budget lock 23:55–00:00 account time (doc 1739591133130817). Applied to every budget write - campaign
  // and Smart+ included - so a change is never half-applied around midnight.
  if (inBudgetLockWindow(tt.timezone, now)) {
    throw new ProviderError({
      platform: "tiktok",
      code: "conflict",
      message: "TikTok budget lock window 23:55-00:00",
      userMessageVi: "TikTok khoá thay đổi ngân sách từ 23:55 đến 00:00 (giờ tài khoản). Hãy thử lại sau 00:00.",
      retryable: true,
    })
  }

  let path: string
  let body: Record<string, unknown>
  let effectiveAt: string | null = null
  if (level === "campaign") {
    if (isUpgradedSmartPlus(o)) {
      path = "smart_plus/campaign/update"
      body = { advertiser_id: tt.advertiserId, campaign_id: String(o.campaign_id), budget: amount }
    } else {
      path = "campaign/update"
      body = { advertiser_id: tt.advertiserId, campaign_id: String(o.campaign_id), budget: amount }
      // /campaign/update/ does not document when a new budget takes effect (unlike ad group scheduled_budget).
      warnings.push(
        "TikTok không công bố thời điểm hiệu lực khi đổi ngân sách chiến dịch qua API (thường áp dụng ngay) - kiểm tra lại trong TikTok Ads Manager sau khi đổi."
      )
    }
  } else if (isUpgradedSmartPlus(o)) {
    // Smart+ ad group budget update takes effect immediately (no scheduled budget).
    path = "smart_plus/adgroup/budget/update"
    body = { advertiser_id: tt.advertiserId, budget: [{ adgroup_id: String(o.adgroup_id), budget: amount }] }
  } else {
    path = "adgroup/budget/update"
    if (u.type === "lifetime") {
      body = { advertiser_id: tt.advertiserId, budget: [{ adgroup_id: String(o.adgroup_id), budget: amount }] }
    } else {
      body = {
        advertiser_id: tt.advertiserId,
        scheduled_budget: [{ adgroup_id: String(o.adgroup_id), scheduled_budget: amount }],
      }
      effectiveAt = nextDayMidnightIso(tt.timezone, now)
      warnings.push(
        `Ngân sách hằng ngày của nhóm quảng cáo TikTok chỉ có hiệu lực từ 00:00 ngày mai theo giờ tài khoản (${effectiveAt}); hôm nay vẫn dùng ${fmtMoney(currentAmount, tt.currency)}.`
      )
      const scheduled = Number(o.scheduled_budget)
      if (Number.isFinite(scheduled) && scheduled > 0) {
        warnings.push(`Đã có ngân sách hẹn giờ ${fmtMoney(scheduled, tt.currency)} cho ngày mai - sẽ bị thay thế.`)
      }
    }
  }
  const changes: FieldChange[] = [
    {
      objectId: u.id,
      objectName: objectName(level, o),
      level,
      field: u.type === "daily" ? "daily_budget" : "lifetime_budget",
      before: currentAmount,
      after: amount,
    },
  ]
  if (opts.dryRun) return { preview: true, changes, warnings, effectiveAt }
  await ttPost(tt, path, body, { retries: IDEMPOTENT_RETRIES })
  return { preview: false, changes, warnings, effectiveAt }
}

// ---------------------------------------------------------------------------
// Ad group full replacement
// ---------------------------------------------------------------------------

/**
 * Fields accepted by POST /adgroup/update/ (API reference "Update an ad group", v1.3, read 2026-10-02).
 * The endpoint is a FULL replacement: every field below that the ad group currently has must be sent back,
 * otherwise TikTok resets it. Everything else returned by /adgroup/get/ is read-only or immutable
 * (ids, times, statuses, placements, optimization_goal, billing_event, budget_mode, promotion_type…).
 */
export const ADGROUP_UPDATE_FIELDS = [
  "adgroup_name",
  "catalog_authorized_bc_id",
  "deep_funnel_optimization_status",
  "deep_funnel_event_source",
  "deep_funnel_event_source_id",
  "deep_funnel_optimization_event",
  "comment_disabled",
  "share_disabled",
  "blocked_pangle_app_ids",
  "search_result_enabled",
  "automated_keywords_enabled",
  "search_keywords",
  "audience_type",
  "audience_rule",
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
  "exclude_age_under_eighteen",
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
  "contextual_tag_ids",
  "brand_safety_type",
  "category_exclusion_ids",
  "vertical_sensitivity_id",
  "budget",
  "schedule_type",
  "schedule_start_time",
  "schedule_end_time",
  "dayparting",
  "frequency",
  "frequency_schedule",
  "secondary_optimization_event",
  "bid_type",
  "bid_price",
  "conversion_bid_price",
  "deep_bid_type",
  "roas_bid",
  "deep_cpa_bid",
  "next_day_retention",
  "pacing",
  "is_hfss",
  "is_lhf_compliance",
] as const

/** Deprecated by TikTok (cannot be enabled any more) - never echoed back. */
const ADGROUP_DEPRECATED = new Set(["auto_targeting_enabled", "targeting_expansion"])

/** true when the ad group's schedule_start_time is already in the past. */
export function hasStarted(current: Raw, now: Date = new Date()): boolean {
  const started = parseTikTokTime(current.schedule_start_time)
  return !!started && started.getTime() <= now.getTime()
}

export function isCboAdGroup(current: Raw): boolean {
  return current.budget_mode === "BUDGET_MODE_INFINITE"
}

/**
 * Build the full /adgroup/update/ body: current values of every updatable field, overlaid with `changes`.
 * CBO ad groups never send `budget`/`bid_type` (owned by the campaign).
 * `budget` is sent ONLY when the caller changes it: the doc does not mark it required, and re-sending the current value
 * is checked against "at least 105% of the current spend" - a rename / targeting / end-date edit late in the day could
 * be rejected (UNVERIFIED whether omitting it is accepted everywhere; a budget rejection is mapped to a clear message).
 */
export function buildAdgroupUpdatePayload(advertiserId: string, current: Raw, changes: Raw, now: Date = new Date()): Raw {
  const body: Raw = { advertiser_id: advertiserId, adgroup_id: String(current.adgroup_id) }
  const cbo = isCboAdGroup(current)
  for (const k of ADGROUP_UPDATE_FIELDS) {
    if (cbo && (k === "budget" || k === "bid_type")) continue
    if (k === "budget" && !("budget" in changes)) continue
    const v = k in changes ? changes[k] : current[k]
    if (v === undefined || v === null) continue
    body[k] = v
  }
  for (const k of Object.keys(changes)) {
    if (ADGROUP_DEPRECATED.has(k)) continue
    if (!(ADGROUP_UPDATE_FIELDS as readonly string[]).includes(k)) {
      throw invalid(`Trường ${k} không sửa được qua /adgroup/update/.`)
    }
  }
  // schedule consistency: SCHEDULE_FROM_NOW never carries an end time
  if (body.schedule_type === "SCHEDULE_FROM_NOW") delete body.schedule_end_time
  // "This field cannot be updated if the schedule_start_time for the ad group is earlier than the current
  // time" (doc 1739586761631745), and schedule_start_time is required together with schedule_type →
  // when the group already started and the caller changes neither start nor end, drop the whole schedule
  // block (start + type + end) so TikTok keeps it as is. When the caller changes the end (schedule_end_time /
  // schedule_type), the OLD start time is sent unchanged next to it (UNVERIFIED: assumed accepted because the
  // value does not change - providers/tiktok.md §4).
  if (!("schedule_start_time" in changes) && hasStarted(current, now)) {
    const changesEnd = "schedule_end_time" in changes || "schedule_type" in changes
    if (!changesEnd) {
      delete body.schedule_start_time
      delete body.schedule_type
      delete body.schedule_end_time
    }
  }
  return body
}

function diffChanges(id: string, name: string, level: ObjectLevel, current: Raw, next: Raw, keys: string[]): FieldChange[] {
  return keys
    .filter((k) => JSON.stringify(current[k] ?? null) !== JSON.stringify(next[k] ?? null))
    .map((k) => ({ objectId: id, objectName: name, level, field: k, before: current[k] ?? null, after: next[k] ?? null }))
}

/** GET → merge → strip read-only → full POST /adgroup/update/ */
export async function fullAdgroupUpdate(
  tt: TT,
  adgroupId: string,
  changes: Raw,
  opts: MutationOptions,
  warnings: string[] = []
): Promise<MutationResult> {
  const current = await fetchOne(tt, "ad_group", adgroupId)
  assertNotLegacySmartPlus("ad_group", current, "sửa")
  if (isUpgradedSmartPlus(current)) {
    throw invalid(
      "Nhóm quảng cáo Upgraded Smart+ không sửa được qua /adgroup/update/.",
      "Dùng ads_update_object (tên/lịch/giá thầu) - các trường khác chỉnh trong TikTok Ads Manager."
    )
  }
  if (normalizeStatus(current.operation_status, current.secondary_status) === "deleted") {
    throw invalid(`Nhóm quảng cáo ${adgroupId} đã bị xoá.`)
  }
  const body = buildAdgroupUpdatePayload(tt.advertiserId, current, changes)
  const changed = diffChanges(adgroupId, objectName("ad_group", current), "ad_group", current, body, Object.keys(changes))
  if (!changed.length) {
    return { preview: !!opts.dryRun, changes: [], warnings: [...warnings, "Không có thay đổi nào so với hiện tại."] }
  }
  if (opts.dryRun) return { preview: true, changes: changed, warnings }
  try {
    await ttPost(tt, "adgroup/update", body, { retries: IDEMPOTENT_RETRIES })
  } catch (e) {
    throw budgetRejection(e, "budget" in body) ?? e
  }
  return { preview: false, changes: changed, warnings }
}

/**
 * /adgroup/update/ rejected because of the budget (missing budget, or "should be at least 105% of the current spend")
 * → clear Vietnamese message; null when the error is about something else.
 */
export function budgetRejection(e: unknown, budgetSent: boolean): ProviderError | null {
  if (!(e instanceof ProviderError) || e.code !== "invalid_request") return null
  const msg = e.upstream?.message ?? ""
  if (!/budget/i.test(msg)) return null
  return new ProviderError({
    platform: "tiktok",
    code: "invalid_request",
    message: e.message,
    userMessageVi: budgetSent
      ? `TikTok từ chối cập nhật nhóm quảng cáo vì ngân sách: ngân sách phải ≥ 105% số đã chi trong kỳ hiện tại. (TikTok: ${msg.slice(0, 300)})`
      : `TikTok từ chối cập nhật nhóm quảng cáo vì thiếu/không hợp lệ ngân sách (app không gửi lại ngân sách khi bạn không đổi ngân sách). (TikTok: ${msg.slice(0, 300)})`,
    hint: "Thử lại vào đầu ngày (khi số đã chi còn thấp), hoặc đổi ngân sách bằng ads_update_budget / sửa trực tiếp trong TikTok Ads Manager.",
    retryable: false,
    upstream: e.upstream,
    cause: e,
  })
}

// ---------------------------------------------------------------------------
// Generic object update (name / schedule / bid / final URL)
// ---------------------------------------------------------------------------

/**
 * Fields of a creative accepted by POST /ad/update/ (full mode). Used when a change is not covered by
 * patch_update (e.g. landing_page_url): current values are echoed back so nothing is reset to null.
 */
export const AD_UPDATE_CREATIVE_FIELDS = [
  "ad_name",
  "identity_id",
  "identity_type",
  "identity_authorized_bc_id",
  "product_specific_type",
  "item_group_ids",
  "product_set_id",
  "sku_ids",
  "ad_format",
  "vertical_video_strategy",
  "dynamic_format",
  "video_id",
  "image_ids",
  "carousel_image_index",
  "end_card_cta",
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
  "deeplink",
  "deeplink_type",
  "shopping_ads_deeplink_type",
  "deeplink_utm_params",
  "shopping_ads_fallback_type",
  "fallback_type",
  "dynamic_destination",
  "instant_product_page_used",
  "page_image_index",
  "aigc_disclosure_type",
  "disclaimer_type",
  "disclaimer_text",
  "disclaimer_clickable_texts",
  "tracking_pixel_id",
  "tracking_app_id",
  "tracking_offline_event_set_ids",
  "vast_moat_enabled",
  "viewability_postbid_partner",
  "viewability_vast_url",
  "brand_safety_postbid_partner",
  "brand_safety_vast_url",
  "impression_tracking_url",
  "click_tracking_url",
  "video_view_tracking_url",
  "playable_url",
  "creative_type",
  "app_name",
  "display_name",
  "avatar_icon_web_uri",
  "creative_authorized",
] as const

/** Fields supported by patch_update=true on /ad/update/. */
export const AD_PATCH_FIELDS = new Set([
  "ad_name",
  "identity_id",
  "identity_type",
  "identity_authorized_bc_id",
  "video_id",
  "image_ids",
  "music_id",
  "tiktok_item_id",
  "ad_text",
  "ad_texts",
])

export function buildAdUpdateBody(advertiserId: string, current: Raw, changes: Raw): { body: Raw; patch: boolean } {
  const patch = Object.keys(changes).every((k) => AD_PATCH_FIELDS.has(k))
  const creative: Raw = { ad_id: String(current.ad_id) }
  if (patch) {
    Object.assign(creative, changes)
  } else {
    for (const k of AD_UPDATE_CREATIVE_FIELDS) {
      const v = k in changes ? changes[k] : current[k]
      if (v === undefined || v === null) continue
      creative[k] = v
    }
  }
  const body: Raw = { advertiser_id: advertiserId, adgroup_id: String(current.adgroup_id), creatives: [creative] }
  if (patch) body.patch_update = true
  return { body, patch }
}

/**
 * Upgraded Smart+ ads hold a LIST of landing pages and the list is replaced as a whole: replace only the first entry
 * (keeping its other fields and every other URL), warn when the ad has several.
 */
export function smartPlusLandingPages(current: unknown, url: string): { list: Raw[]; before: string | null; warning: string | null } {
  const list = Array.isArray(current) ? current.filter((x): x is Raw => !!x && typeof x === "object") : []
  if (!list.length) return { list: [{ landing_page_url: url }], before: null, warning: null }
  const first = list[0]!
  return {
    list: [{ ...first, landing_page_url: url }, ...list.slice(1)],
    before: typeof first.landing_page_url === "string" ? first.landing_page_url : null,
    warning:
      list.length > 1
        ? `Quảng cáo Smart+ này có ${list.length} URL đích - chỉ thay URL đầu tiên, giữ nguyên ${list.length - 1} URL còn lại.`
        : null,
  }
}

function toScheduleTime(iso: string, field: string): string {
  try {
    return isoToTikTokTime(iso)
  } catch {
    throw invalid(`${field} không hợp lệ: ${iso}`)
  }
}

export async function updateTikTokObject(
  ctx: ProviderContext<TikTokCredentials>,
  u: ObjectUpdate,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const tt = ttFromCtx(ctx)
  const c = u.changes
  const keys = Object.keys(c).filter((k) => (c as Raw)[k] !== undefined)
  if (!keys.length) throw invalid("Không có trường nào cần sửa.")
  if (c.name !== undefined && !c.name.trim()) throw invalid("Tên không được để trống.")
  const reject = (fields: string[]) => {
    const bad = keys.filter((k) => fields.includes(k))
    if (bad.length) throw invalid(`Không sửa được ${bad.join(", ")} ở cấp ${LEVEL_VI[u.level]} trên TikTok.`)
  }

  if (u.level === "campaign") {
    reject(["startTime", "endTime", "bidAmount", "finalUrl"])
    const o = await fetchOne(tt, "campaign", u.id)
    assertNotLegacySmartPlus("campaign", o, "sửa")
    const name = c.name!.trim()
    const changes: FieldChange[] = [
      { objectId: u.id, objectName: objectName("campaign", o), level: "campaign", field: "name", before: o.campaign_name ?? null, after: name },
    ]
    if (opts.dryRun) return { preview: true, changes, warnings: [] }
    const path = isUpgradedSmartPlus(o) ? "smart_plus/campaign/update" : "campaign/update"
    await ttPost(tt, path, { advertiser_id: tt.advertiserId, campaign_id: String(o.campaign_id), campaign_name: name }, { retries: IDEMPOTENT_RETRIES })
    return { preview: false, changes, warnings: [] }
  }

  if (u.level === "ad_group") {
    reject(["finalUrl"])
    const current = await fetchOne(tt, "ad_group", u.id)
    assertNotLegacySmartPlus("ad_group", current, "sửa")
    const ch: Raw = {}
    const warnings: string[] = []
    if (c.name !== undefined) ch.adgroup_name = c.name.trim()
    if (c.startTime !== undefined) {
      if (c.startTime === null) throw invalid("Không thể bỏ thời gian bắt đầu của nhóm quảng cáo.")
      if (hasStarted(current)) {
        throw invalid(
          "Nhóm quảng cáo đã tới thời gian bắt đầu - TikTok không cho đổi thời gian bắt đầu nữa.",
          "Chỉ đổi được thời gian kết thúc (endTime)."
        )
      }
      ch.schedule_start_time = toScheduleTime(c.startTime, "startTime")
    }
    if (c.endTime !== undefined) {
      if (c.endTime === null) {
        if (current.budget_mode === "BUDGET_MODE_TOTAL") {
          throw invalid("Nhóm dùng ngân sách trọn đời bắt buộc có thời gian kết thúc.")
        }
        ch.schedule_type = "SCHEDULE_FROM_NOW"
      } else {
        ch.schedule_type = "SCHEDULE_START_END"
        ch.schedule_end_time = toScheduleTime(c.endTime, "endTime")
      }
      // buildAdgroupUpdatePayload echoes the current start time unchanged (schedule_start_time is required
      // together with schedule_type)
    }
    const startForCheck = ch.schedule_start_time ?? current.schedule_start_time
    if (startForCheck && ch.schedule_end_time) {
      const s = parseTikTokTime(startForCheck)
      const e = parseTikTokTime(ch.schedule_end_time)!
      if (s && e.getTime() <= s.getTime()) throw invalid("Thời gian kết thúc phải sau thời gian bắt đầu.")
      if (e.getTime() <= Date.now()) throw invalid("Thời gian kết thúc phải ở tương lai.")
    }
    if (c.bidAmount !== undefined) {
      if (c.bidAmount === null) throw invalid("Không thể xoá giá thầu; hãy đặt một giá trị cụ thể.")
      if (current.bid_type !== "BID_TYPE_CUSTOM") {
        throw invalid(
          `Nhóm quảng cáo đang dùng chiến lược giá thầu ${String(current.bid_type ?? "tự động")} - chỉ đổi giá thầu được khi bid_type = BID_TYPE_CUSTOM.`
        )
      }
      const amount = apiMoney(c.bidAmount, tt.currency)
      if (current.billing_event === "OCPM") ch.conversion_bid_price = amount
      else ch.bid_price = amount
    }
    if (isUpgradedSmartPlus(current)) {
      // Upgraded Smart+ update is incremental
      const body: Raw = { advertiser_id: tt.advertiserId, adgroup_id: u.id, ...ch }
      const changes = diffChanges(u.id, objectName("ad_group", current), "ad_group", current, body, Object.keys(ch))
      if (opts.dryRun || !changes.length) return { preview: !!opts.dryRun, changes, warnings }
      await ttPost(tt, "smart_plus/adgroup/update", body, { retries: IDEMPOTENT_RETRIES })
      return { preview: false, changes, warnings }
    }
    return fullAdgroupUpdate(tt, u.id, ch, opts, warnings)
  }

  if (u.level === "ad") {
    reject(["startTime", "endTime", "bidAmount"])
    const current = await fetchOne(tt, "ad", u.id)
    assertNotLegacySmartPlus("ad", current, "sửa")
    if (normalizeStatus(current.operation_status, current.secondary_status) === "deleted") {
      throw invalid(`Quảng cáo ${u.id} đã bị xoá.`)
    }
    const ch: Raw = {}
    if (c.name !== undefined) ch.ad_name = c.name.trim()
    if (c.finalUrl !== undefined) {
      if (!/^https?:\/\//i.test(c.finalUrl)) throw invalid("URL đích phải bắt đầu bằng http:// hoặc https://.")
      ch.landing_page_url = c.finalUrl
    }
    const name = objectName("ad", current)
    if (isUpgradedSmartPlus(current)) {
      const spId = String(current.smart_plus_ad_id ?? current.ad_id_v2 ?? current.ad_id)
      const body: Raw = { advertiser_id: tt.advertiserId, smart_plus_ad_id: spId }
      const spWarnings: string[] = []
      const before: Raw = { ...current }
      if (ch.ad_name !== undefined) body.ad_name = ch.ad_name
      if (ch.landing_page_url !== undefined) {
        const r = smartPlusLandingPages(current.landing_page_url_list, String(ch.landing_page_url))
        body.landing_page_url_list = r.list
        before.landing_page_url = r.before
        if (r.warning) spWarnings.push(r.warning)
      }
      const changes = diffChanges(spId, name, "ad", before, ch, Object.keys(ch))
      if (opts.dryRun || !changes.length) return { preview: !!opts.dryRun, changes, warnings: spWarnings }
      await ttPost(tt, "smart_plus/ad/update", body, { retries: IDEMPOTENT_RETRIES })
      return { preview: false, changes, warnings: spWarnings }
    }
    if (current.is_aco === true) {
      throw invalid("Quảng cáo ACO/Smart Creative không sửa được qua /ad/update/.", "Chỉnh trong TikTok Ads Manager.")
    }
    const { body, patch } = buildAdUpdateBody(tt.advertiserId, current, ch)
    const warnings = patch
      ? []
      : ["Đổi URL đích cần gửi lại toàn bộ creative (TikTok không hỗ trợ cập nhật một phần cho trường này); quảng cáo sẽ được duyệt lại."]
    const changes = diffChanges(u.id, name, "ad", current, ch, Object.keys(ch))
    if (!changes.length) return { preview: !!opts.dryRun, changes, warnings: ["Không có thay đổi nào so với hiện tại."] }
    if (opts.dryRun) return { preview: true, changes, warnings }
    await ttPost(tt, "ad/update", body, { retries: IDEMPOTENT_RETRIES })
    return { preview: false, changes, warnings }
  }
  throw invalid("TikTok không có cấp từ khoá.")
}
