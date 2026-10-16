// Review (moderation) info of one ad / ad group, attached by ads_get_object as extra.review (C2, v1.1.6).
// Manual ads: GET /ad/review_info/ (doc 1740559669226498) · ad groups: GET /adgroup/review_info/ (1740554277061634) ·
// Upgraded Smart+ ads: GET /smart_plus/ad/review_info/ (1843317465695233). Never throws: a failed review call only adds
// extra.review_error. Platform text (reasons, suggestions, rejected ad text) is untrusted → one line, cleaned, cut;
// no URL is ever returned (Smart+ violation frames are not requested).
import { sanitizeExternalLabel } from "../../../lib/text-safety"
import { ProviderError } from "../errors"
import type { ObjectLevel } from "../types"
import {
  automationType,
  isUpgradedSmartPlus,
  str,
  tiktokTimeToIso,
  ttGet,
  type Raw,
  type TT,
} from "./api"

const MAX_REJECT_INFO = 10
const MAX_REASONS = 5
const MAX_REASON_CHARS = 300
const MAX_SUGGESTION_CHARS = 500
const MAX_TEXT_CHARS = 200
const MAX_ENUM_ITEMS = 50
const MAX_LISTED_ADS = 10

export interface TikTokReviewResult {
  /** extra.review (null when TikTok returned nothing for this object) */
  review: Raw | null
  /** extra.review_error: Vietnamese, why the review info is missing (call failed / no result yet) */
  error: string | null
}

const line = (v: unknown, max: number): string | null =>
  typeof v === "string" ? sanitizeExternalLabel(v, max) : null

/** Enum / code list (placements, age groups, location codes, OS): strings only, cleaned, unique, capped. */
function codes(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out = new Set<string>()
  for (const x of v) {
    const s = line(x, 60)
    if (s) out.add(s)
    if (out.size >= MAX_ENUM_ITEMS) break
  }
  return [...out]
}

function idOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v)
  return line(v, 128)
}

function putCodes(out: Raw, key: string, v: unknown): void {
  const list = codes(v)
  if (list.length) out[key] = list
}

/** reject_info[] → compact entries (reasons ≤5, suggestion, forbidden_*, rejected content ids / text). */
export function rejectInfoOut(v: unknown): Raw[] {
  if (!Array.isArray(v)) return []
  const out: Raw[] = []
  for (const r of v) {
    if (!r || typeof r !== "object") continue
    const o = r as Raw
    const e: Raw = {}
    const reasons = (Array.isArray(o.reasons) ? o.reasons : [])
      .map((x) => line(x, MAX_REASON_CHARS))
      .filter((x): x is string => !!x)
      .slice(0, MAX_REASONS)
    if (reasons.length) e.reasons = reasons
    const suggestion = line(o.suggestion, MAX_SUGGESTION_CHARS)
    if (suggestion) e.suggestion = suggestion
    const spec = line(o.specification, MAX_SUGGESTION_CHARS)
    if (spec) e.specification = spec
    putCodes(e, "forbidden_locations", o.forbidden_locations)
    putCodes(e, "forbidden_ages", o.forbidden_ages)
    putCodes(e, "forbidden_placements", o.forbidden_placements)
    const c =
      o.content_info && typeof o.content_info === "object"
        ? (o.content_info as Raw)
        : null
    if (c) {
      const type = line(c.content_type, 40)
      if (type) e.content_type = type
      const text = line(c.text_content, MAX_TEXT_CHARS)
      if (text) e.text_content = text
      const sub = (k: string, f: string) =>
        c[k] && typeof c[k] === "object" ? idOf((c[k] as Raw)[f]) : null
      const video = sub("video_content", "video_id")
      const image = sub("image_content", "image_id")
      const music =
        sub("carousel_music_content", "music_id") ??
        sub("carousel_music_info", "music_id")
      if (video) e.video_id = video
      if (image) e.image_id = image
      if (music) e.music_id = music
    }
    if (Object.keys(e).length) out.push(e)
    if (out.length >= MAX_REJECT_INFO) break
  }
  return out
}

/** Fields shared by every review record (ad, ad group, Smart+ ad / material). */
export function reviewCore(r: Raw): Raw {
  const out: Raw = { review_status: line(r.review_status, 40) }
  const approved =
    typeof r.is_approved === "boolean"
      ? r.is_approved
      : typeof r.is_pass === "boolean"
        ? r.is_pass
        : null
  if (approved !== null) out.is_approved = approved
  putCodes(out, "forbidden_locations", r.forbidden_locations)
  putCodes(out, "forbidden_ages", r.forbidden_ages)
  putCodes(out, "forbidden_placements", r.forbidden_placements)
  putCodes(out, "forbidden_operation_systems", r.forbidden_operation_systems)
  putCodes(out, "passed_locations", r.passed_locations)
  const reject = rejectInfoOut(r.reject_info)
  if (reject.length) out.reject_info = reject
  // the doc example: is_approved true + PART_AVAILABLE + reject_info = approved for part of the targeting only
  if (
    approved !== false &&
    (r.review_status === "PART_AVAILABLE" ||
      (approved === true && reject.length > 0))
  ) {
    out.partially_approved = true
  }
  return out
}

/** A value of an object keyed by id (TikTok review maps): exact key, else the entry whose id field matches. */
function pick(map: unknown, id: string, idField: string): Raw | null {
  if (!map || typeof map !== "object") return null
  const m = map as Record<string, unknown>
  const direct = m[id]
  if (direct && typeof direct === "object") return direct as Raw
  for (const v of Object.values(m)) {
    if (v && typeof v === "object" && String((v as Raw)[idField] ?? "") === id)
      return v as Raw
  }
  return null
}

function errorVi(e: unknown): string {
  const detail =
    e instanceof ProviderError
      ? sanitizeExternalLabel(e.userMessageVi, 200)
      : null
  return `Không lấy được thông tin duyệt từ TikTok${detail ? `: ${detail}` : ""}. Các trường khác vẫn đúng; thử lại sau hoặc xem trong TikTok Ads Manager.`
}

export const AD_GROUP_REVIEW_UNSUPPORTED =
  "TikTok không có thông tin duyệt cấp nhóm cho nhóm Upgraded Smart+ / GMV Max - xem duyệt theo từng quảng cáo (ads_get_object level=ad)."

/** GMV Max ad group (best effort: GMV Max objects are mostly absent from /adgroup/get/; any GMV_MAX marker counts). */
function isGmvMaxAdGroup(o: Raw): boolean {
  return [o.promotion_type, o.shopping_ads_type, o.campaign_type, o.gmv_max_promotion_type].some(
    (v) => typeof v === "string" && /GMV_MAX/.test(v)
  )
}

const NOT_YET =
  "TikTok chưa trả kết quả duyệt cho đối tượng này (có thể đang chờ duyệt hoặc chưa có quảng cáo)."

async function adReview(
  tt: TT,
  o: Raw,
  id: string
): Promise<TikTokReviewResult> {
  if (isUpgradedSmartPlus(o) || o.smart_plus_ad_id) {
    const spId = String(o.smart_plus_ad_id ?? id)
    const res = await ttGet<{
      smart_plus_ad_review_infos?: Raw[]
      material_review_infos?: Raw[]
    }>(tt, "smart_plus/ad/review_info", {
      advertiser_id: tt.advertiserId,
      smart_plus_ad_ids: [spId],
      lang: "vi",
      // violation frames carry image / landing page URLs → never requested
      extra_info_setting: {
        include_reject_info: true,
        include_violation_frame: false,
      },
    })
    const info =
      (res.data.smart_plus_ad_review_infos ?? []).find(
        (x) => String(x?.smart_plus_ad_id ?? "") === spId
      ) ?? null
    if (!info) return { review: null, error: NOT_YET }
    const review: Raw = {
      source: "smart_plus/ad/review_info",
      ...reviewCore(info),
    }
    const appeal = line(info.appeal_status, 40)
    if (appeal) review.appeal_status = appeal
    const appealReasons = codes(info.appeal_reject_reasons).slice(
      0,
      MAX_REASONS
    )
    if (appealReasons.length) review.appeal_reject_reasons = appealReasons
    const materials = (res.data.material_review_infos ?? []).filter(
      (m) =>
        m &&
        String(m.smart_plus_ad_id ?? spId) === spId &&
        // no review_status yet = still in review, not rejected
        (m.review_status === "PART_AVAILABLE" || m.review_status === "UNAVAILABLE")
    )
    if (materials.length) {
      review.rejected_materials_total = materials.length
      review.rejected_materials = materials
        .slice(0, MAX_LISTED_ADS)
        .map((m) => ({
          ad_material_id: idOf(m.ad_material_id),
          ...reviewCore(m),
        }))
    }
    return { review, error: null }
  }
  const adId = String(o.ad_id ?? id)
  const res = await ttGet<{ ad_review_map?: Record<string, unknown> }>(
    tt,
    "ad/review_info",
    {
      advertiser_id: tt.advertiserId,
      ad_ids: [adId],
    }
  )
  const r = pick(res.data.ad_review_map, adId, "ad_id")
  if (!r) return { review: null, error: NOT_YET }
  return { review: { source: "ad/review_info", ...reviewCore(r) }, error: null }
}

async function adGroupReview(
  tt: TT,
  o: Raw,
  id: string
): Promise<TikTokReviewResult> {
  const res = await ttGet<{
    ad_group_review_map?: Record<string, unknown>
    ad_review_map?: Record<string, unknown>
  }>(tt, "adgroup/review_info", {
    advertiser_id: tt.advertiserId,
    adgroup_ids: [id],
  })
  const g = pick(res.data.ad_group_review_map, id, "adgroup_id")
  if (!g) return { review: null, error: NOT_YET }
  const review: Raw = { source: "adgroup/review_info", ...reviewCore(g) }
  const appeal = line(g.appeal_status, 40)
  if (appeal) review.appeal_status = appeal
  const audited = tiktokTimeToIso(g.last_audit_time)
  if (audited) review.last_audit_time = audited
  // the field table says contain_rejected_ads, the example / v1.3 comparison contains_rejected_ads → read both
  const containsRejected =
    typeof g.contain_rejected_ads === "boolean"
      ? g.contain_rejected_ads
      : typeof g.contains_rejected_ads === "boolean"
        ? g.contains_rejected_ads
        : null
  if (containsRejected !== null) review.contains_rejected_ads = containsRejected
  // v1.2-style group-level reasons still appear in the doc example
  const reasons = (Array.isArray(g.reasons) ? g.reasons : [])
    .map((x) => line(x, MAX_REASON_CHARS))
    .filter((x): x is string => !!x)
  if (reasons.length) review.reasons = reasons.slice(0, MAX_REASONS)
  // Legacy Smart+: the ad ids of a partly / fully rejected group are material ids, not real ads → not listed
  if (automationType(o) !== "SMART_PLUS") {
    const ads = res.data.ad_review_map?.[id]
    if (ads && typeof ads === "object") {
      const rejected = Object.entries(ads as Record<string, unknown>)
        .filter(([, v]) => v && typeof v === "object")
        .map(([k, v]) => ({
          id: idOf((v as Raw).ad_id) ?? idOf(k),
          r: v as Raw,
        }))
        .filter(
          ({ r }) =>
            r.is_approved === false ||
            (typeof r.review_status === "string" &&
              r.review_status !== "ALL_AVAILABLE") ||
            rejectInfoOut(r.reject_info).length > 0
        )
      if (rejected.length) {
        review.rejected_ads_total = rejected.length
        review.rejected_ads = rejected
          .slice(0, MAX_LISTED_ADS)
          .map(({ id: adId, r }) => {
            const core = reviewCore(r)
            if (Array.isArray(core.reject_info))
              core.reject_info = (core.reject_info as Raw[]).slice(0, 3)
            return { ad_id: adId, ...core }
          })
      }
    }
  }
  return { review, error: null }
}

/**
 * Review info of one TikTok ad / ad group (raw /ad/get/ or /adgroup/get/ row `o`, canonical id `id`). Campaigns and
 * deleted objects → nothing (no call). Never throws.
 */
export async function fetchTikTokReview(
  tt: TT,
  level: ObjectLevel,
  o: Raw,
  id: string
): Promise<TikTokReviewResult> {
  if (level !== "ad" && level !== "ad_group")
    return { review: null, error: null }
  if (
    o.operation_status === "DELETE" ||
    /(^|_)DELETE$/.test(str(o.secondary_status) ?? "")
  )
    return { review: null, error: null }
  // /adgroup/review_info/ does not support Upgraded Smart+ (FAQ 1854104036724929) nor GMV Max ad groups → no call,
  // point to the per-ad review instead of a misleading error
  if (level === "ad_group" && (isUpgradedSmartPlus(o) || isGmvMaxAdGroup(o))) {
    return { review: { source: null, note: AD_GROUP_REVIEW_UNSUPPORTED }, error: null }
  }
  try {
    return level === "ad"
      ? await adReview(tt, o, id)
      : await adGroupReview(tt, o, id)
  } catch (e) {
    return { review: null, error: errorVi(e) }
  }
}
