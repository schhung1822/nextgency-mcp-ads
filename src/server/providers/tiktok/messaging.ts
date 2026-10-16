// TikTok messaging ads (manual LEAD_GENERATION campaigns): ad group destination (TikTok direct messages or an instant
// messaging app), the messaging rules of /ad/create/, and the two helper tools tiktok_messaging_assets (read) and
// tiktok_create_welcome_message (create). Spec: .claude/docs/providers/tiktok.md "Quảng cáo nhắn tin" (official docs
// 1774482992153601 DM, 1774482999036930 IM apps, 1739499616346114 /adgroup/create/, 1739953377508354 /ad/create/,
// 1822106113771521 + 1822106498804738 welcome messages, 1816979158055937 event sets, 1820826387779586 /page/get/,
// 1740218420781057 /identity/get/, 1774488637039618 /tool/phone_region_code/).
// Ids (auto_message_id, page_id, event set ids, Facebook Page ids) stay strings end to end - never Number().
import { createHash } from "node:crypto"
import { z } from "zod"
import { cutText, sanitizeExternalLabel, UNSAFE_TEXT_CHARS } from "../../../lib/text-safety"
import { isProviderError, ProviderError } from "../errors"
import type { MutationOptions, MutationResult, ProviderContext, ProviderExtension } from "../types"
import { invalid, parseTikTokTime, str, ttFromCtx, ttGet, ttPost, type Raw, type TT } from "./api"
import { isUncertainCreateError } from "./create-checked"
import type { TikTokCredentials } from "./credentials"
import { fetchIdentityList } from "./lookup"

export const PROMO_DM = "LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE"
export const PROMO_IM = "LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE"

export const MESSAGING_DESTINATIONS = ["TIKTOK_DM", "MESSENGER", "WHATSAPP", "ZALO", "LINE", "IM_URL"] as const
export type MessagingDestination = (typeof MESSAGING_DESTINATIONS)[number]
const APP_TYPES = ["MESSENGER", "WHATSAPP", "ZALO", "LINE", "IM_URL"]
/** messaging_app_type values that only support optimization_goal CLICK [H 1739499616346114] */
const CLICK_ONLY = new Set(["ZALO", "LINE", "IM_URL"])

const DEST_VI: Record<MessagingDestination, string> = {
  TIKTOK_DM: "Tin nhắn TikTok (Direct Message)",
  MESSENGER: "Messenger",
  WHATSAPP: "WhatsApp",
  ZALO: "Zalo",
  LINE: "LINE",
  IM_URL: "Đường dẫn ứng dụng nhắn tin (IM_URL)",
}

/** /adgroup/create/ fields of a messaging ad group - all immutable after create [H] */
export const MESSAGING_ADGROUP_KEYS = [
  "messaging_app_type",
  "messaging_app_account_id",
  "phone_region_code",
  "phone_region_calling_code",
  "phone_number",
  "message_event_set_id",
] as const

const SPEC_KEYS = [
  "facebook_page_id",
  "line_business_id",
  "phone_region_code",
  "phone_region_calling_code",
  "phone_number",
  "message_event_set_id",
] as const
type SpecKey = (typeof SPEC_KEYS)[number]

const ALLOWED_SPEC_KEYS: Record<MessagingDestination, readonly SpecKey[]> = {
  TIKTOK_DM: [],
  MESSENGER: ["facebook_page_id", "message_event_set_id"],
  WHATSAPP: ["phone_region_code", "phone_region_calling_code", "phone_number", "message_event_set_id"],
  ZALO: ["phone_region_code", "phone_region_calling_code", "phone_number"],
  LINE: ["line_business_id"],
  IM_URL: [],
}

// control / bidi / zero-width characters refused in links
const UNSAFE_LINK_CHARS = /[\p{Cc}\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

/** /ad/create/ `deeplink`: "<scheme>:…" form, no control / bidi characters, never javascript: / data: / vbscript: / file:. */
export const deeplinkSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((v) => !UNSAFE_LINK_CHARS.test(v), { error: "deeplink chứa ký tự điều khiển / ký tự ẩn." })
  .refine((v) => /^[a-z][a-z0-9+.-]*:/i.test(v), { error: "deeplink phải bắt đầu bằng scheme, ví dụ whatsapp://send?phone=…" })
  .refine((v) => !/^(javascript|data|vbscript|file):/i.test(v), { error: "deeplink không được dùng scheme javascript:, data:, vbscript: hoặc file:." })

const digitsId = (label: string) => z.string().trim().regex(/^\d{1,30}$/, { error: `${label} phải là chuỗi chữ số.` })

export const messagingInput = z
  .strictObject({
    destination: z
      .enum(MESSAGING_DESTINATIONS)
      .describe("TIKTOK_DM = nhắn tin TikTok; MESSENGER / WHATSAPP / ZALO / LINE = ứng dụng nhắn tin; IM_URL = link ứng dụng nhắn tin tự chọn"),
    facebook_page_id: digitsId("facebook_page_id").optional().describe("MESSENGER: ID Trang Facebook (chỉ chữ số)"),
    line_business_id: z
      .string()
      .trim()
      .regex(/^[^\s\p{Cc}]{1,100}$/u, { error: "line_business_id không hợp lệ." })
      .optional()
      .describe("LINE: LINE Business ID"),
    phone_region_code: z.string().trim().optional().describe("WHATSAPP / ZALO: mã vùng 2 chữ cái, mặc định VN"),
    phone_region_calling_code: z.string().trim().optional().describe("WHATSAPP / ZALO: mã gọi quốc gia, mặc định +84"),
    phone_number: z
      .string()
      .trim()
      .max(32)
      .optional()
      .describe("WHATSAPP / ZALO: số trong nước chỉ gồm chữ số, bỏ số 0 đầu (0901 234 567 → 901234567)"),
    message_event_set_id: digitsId("message_event_set_id")
      .optional()
      .describe("Chỉ khi CONVERSATION và tài khoản ứng dụng chưa khớp event set (tiktok_messaging_assets kind=message_event_sets)"),
  })
  .describe("Quảng cáo nhắn tin (chiến dịch LEAD_GENERATION): công cụ tự đặt promotion_type, messaging_app_* và vị trí chỉ TikTok")
export type MessagingInput = z.infer<typeof messagingInput>

/** Fields of tiktok_create_adgroup the messaging rules read (subset of CreateAdGroupInput). */
export interface AdGroupMessagingFields {
  messaging?: MessagingInput
  promotion_type?: string
  optimization_goal: string
  optimization_event?: string
  age_groups?: string[]
  pixel_id?: string
  bid_type: string
  pacing: string
  placement_type: "automatic" | "manual"
  placements?: string[]
  advanced?: Record<string, unknown>
}

export interface ResolvedMessaging {
  destination: MessagingDestination
  /** set on the /adgroup/create/ body (overrides promotion_type / placement fields) */
  fields: Raw
  /** `advanced` without the messaging keys and promotion_type (they are in `fields`) */
  advanced: Raw | undefined
}

export function isMessagingPromotion(p: unknown): boolean {
  return p === PROMO_DM || p === PROMO_IM
}

export const PHONE_HINT =
  "Ví dụ số 0901 234 567 ở Việt Nam: phone_region_code=VN, phone_region_calling_code=+84, phone_number=901234567 (mã khác: tiktok_messaging_assets kind=phone_region_codes)."

/** An id from the raw `advanced` path: digit strings only (a JSON number may already have lost digits). */
function rawId(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v !== "string") throw invalid(`${field} phải là chuỗi (không phải số) để giữ đủ chữ số.`, "Truyền dạng chuỗi, ví dụ \"123456789012345\".")
  return v.trim()
}

/** Messaging spec of the legacy path: raw promotion_type LEAD_GEN_CLICK_TO_* (+ advanced.messaging_*). */
function legacySpec(promo: string, adv: Raw, goal: string): MessagingInput {
  if (promo === PROMO_DM) {
    const extra = MESSAGING_ADGROUP_KEYS.filter((k) => adv[k] !== undefined)
    if (extra.length) throw invalid(`Nhóm tin nhắn TikTok (${PROMO_DM}) không dùng ${extra.join(", ")}.`)
    return { destination: "TIKTOK_DM" }
  }
  const rawApp = adv.messaging_app_type
  const app = rawApp === undefined ? (goal === "CLICK" ? "IM_URL" : null) : String(rawApp)
  if (!app) {
    throw invalid(
      "Nhóm nhắn tin qua ứng dụng với optimization_goal CONVERSATION cần messaging_app_type.",
      "Dùng tham số messaging {destination: MESSENGER | WHATSAPP, …} thay cho promotion_type/advanced."
    )
  }
  if (!APP_TYPES.includes(app)) throw invalid(`messaging_app_type "${app.slice(0, 40)}" không hợp lệ (MESSENGER, WHATSAPP, ZALO, LINE, IM_URL).`)
  const account = rawId(adv.messaging_app_account_id, "messaging_app_account_id")
  const spec: MessagingInput = { destination: app as MessagingDestination }
  if (app === "MESSENGER") spec.facebook_page_id = account
  else if (app === "LINE") spec.line_business_id = account
  else if (account !== undefined) {
    throw invalid(
      app === "IM_URL"
        ? "IM_URL không dùng messaging_app_account_id."
        : `${app}: không truyền messaging_app_account_id (TikTok tự điền từ số điện thoại).`
    )
  }
  for (const k of ["phone_region_code", "phone_region_calling_code", "phone_number"] as const) {
    const v = adv[k]
    if (v !== undefined && v !== null) spec[k] = typeof v === "string" ? v : String(v)
  }
  const ev = rawId(adv.message_event_set_id, "message_event_set_id")
  if (ev !== undefined) spec.message_event_set_id = ev
  return spec
}

/** WhatsApp / Zalo phone trio: digits only, national number without the trunk 0, region default VN (+84). */
export function phoneFields(spec: MessagingInput, dest: MessagingDestination, warnings: string[]): Raw {
  const label = dest === "ZALO" ? "Zalo" : "WhatsApp Business"
  if (!spec.phone_number) throw invalid(`${DEST_VI[dest]} cần phone_number (số ${label} của doanh nghiệp).`, PHONE_HINT)
  let region = spec.phone_region_code?.trim().toUpperCase() || undefined
  let calling = spec.phone_region_calling_code?.trim() || undefined
  if (!region && !calling) {
    region = "VN"
    calling = "+84"
    warnings.push("Chưa có mã vùng số điện thoại - mặc định Việt Nam (VN, +84).")
  } else if (region === "VN" && !calling) calling = "+84"
  else if (calling === "+84" && !region) region = "VN"
  if (!region || !calling) {
    throw invalid("Cần cả phone_region_code (vd VN) và phone_region_calling_code (vd +84).", "Tra mã bằng tiktok_messaging_assets kind=phone_region_codes.")
  }
  if (!/^[A-Z]{2}$/.test(region)) throw invalid("phone_region_code phải là mã vùng 2 chữ cái (vd VN).")
  if (!/^\+\d{1,4}$/.test(calling)) throw invalid("phone_region_calling_code phải có dạng +<mã> (vd +84).")
  if (region === "VN" && calling !== "+84") throw invalid("Mã vùng VN đi với phone_region_calling_code +84.")
  // formatting characters only (spaces, dots, dashes, brackets) - anything else is refused, the number is never echoed
  const digits = spec.phone_number.replace(/[\s.\-()]/g, "")
  if (!/^\d+$/.test(digits)) throw invalid("phone_number chỉ gồm chữ số (không có dấu +, chữ cái hay ký tự khác).", PHONE_HINT)
  if (region === "VN") {
    // VN trunk prefix 0 / country code 84 (format inferred - providers/tiktok.md §9 UNVERIFIED)
    if (digits.startsWith("0")) throw invalid("phone_number không có số 0 ở đầu: bỏ số 0 đầu của số trong nước.", PHONE_HINT)
    if (digits.startsWith("84") && digits.length >= 11) {
      throw invalid("phone_number không kèm mã quốc gia 84 (mã đã nằm trong phone_region_calling_code).", PHONE_HINT)
    }
    if (digits.length < 9 || digits.length > 10) throw invalid("Số điện thoại Việt Nam (đã bỏ số 0 đầu) phải có 9-10 chữ số.", PHONE_HINT)
  } else {
    if (digits.length < 4 || digits.length > 15) throw invalid("phone_number phải có 4-15 chữ số.", PHONE_HINT)
    warnings.push(
      `Định dạng phone_number cho mã vùng ${region} chưa được TikTok mô tả rõ - đang gửi nguyên các chữ số đã nhập; nếu TikTok từ chối, thử bỏ số 0 đầu (số trong nước, không kèm mã quốc gia).`
    )
  }
  return { phone_region_code: region, phone_region_calling_code: calling, phone_number: digits }
}

/**
 * Messaging ad group (new `messaging` parameter, or the legacy raw promotion_type LEAD_GEN_CLICK_TO_*MESSAGE path):
 * validates the official rules and returns the body fields. null = not a messaging ad group (body built as before).
 */
export function resolveAdGroupMessaging(
  input: AdGroupMessagingFields,
  objective: string,
  warnings: string[]
): ResolvedMessaging | null {
  const adv: Raw = { ...((input.advanced ?? {}) as Raw) }
  const advPromo = typeof adv.promotion_type === "string" ? adv.promotion_type : undefined
  const rawPromo = input.promotion_type ?? advPromo
  if (!input.messaging && !isMessagingPromotion(rawPromo)) return null

  let spec: MessagingInput
  if (input.messaging) {
    spec = input.messaging
    const derived = spec.destination === "TIKTOK_DM" ? PROMO_DM : PROMO_IM
    if (rawPromo && rawPromo !== derived) {
      throw invalid(
        `promotion_type ${rawPromo.slice(0, 60)} mâu thuẫn với messaging.destination ${spec.destination}.`,
        "Bỏ promotion_type - công cụ tự đặt khi có messaging."
      )
    }
    const dup = MESSAGING_ADGROUP_KEYS.filter((k) => adv[k] !== undefined)
    if (dup.length) throw invalid(`Đã có messaging nên không truyền ${dup.join(", ")} trong advanced.`, "Đặt các giá trị này trong messaging.")
  } else {
    spec = legacySpec(rawPromo!, adv, input.optimization_goal)
  }
  for (const k of MESSAGING_ADGROUP_KEYS) delete adv[k]
  delete adv.promotion_type

  const dest = spec.destination
  const goal = input.optimization_goal
  if (objective !== "LEAD_GENERATION") {
    throw invalid(
      `Quảng cáo nhắn tin (${DEST_VI[dest]}) chỉ tạo được trong chiến dịch mục tiêu LEAD_GENERATION - chiến dịch này là ${objective || "không rõ"}.`,
      "Tạo chiến dịch bằng tiktok_create_campaign với objective LEAD_GENERATION."
    )
  }
  if (goal !== "CLICK" && goal !== "CONVERSATION") {
    throw invalid(`Nhóm nhắn tin chỉ nhận optimization_goal CLICK (nên dùng) hoặc CONVERSATION, không phải ${goal}.`)
  }
  if (goal === "CONVERSATION" && CLICK_ONLY.has(dest)) throw invalid(`${DEST_VI[dest]} chỉ hỗ trợ optimization_goal CLICK.`)
  if (goal === "CLICK" && input.optimization_event) throw invalid("optimization_goal CLICK không dùng optimization_event (bỏ trống).")
  if (goal === "CONVERSATION" && input.optimization_event && input.optimization_event !== "MESSAGE") {
    throw invalid("Với CONVERSATION, optimization_event chỉ được là MESSAGE hoặc bỏ trống.")
  }
  if (input.age_groups?.includes("AGE_13_17")) throw invalid("Quảng cáo nhắn tin không nhắm độ tuổi 13-17 (bỏ AGE_13_17).")
  if (input.pixel_id) throw invalid("Nhóm nhắn tin không dùng pixel_id.")
  if (input.bid_type === "BID_TYPE_NO_BID" && input.pacing === "PACING_MODE_FAST") {
    throw invalid("Nhóm nhắn tin dùng BID_TYPE_NO_BID chỉ chạy được pacing PACING_MODE_SMOOTH.")
  }
  if (adv.promotion_target_type !== undefined) throw invalid("Nhóm nhắn tin không truyền promotion_target_type.")
  if (adv.search_result_enabled === true) throw invalid("Nhóm nhắn tin không bật search_result_enabled (để false hoặc bỏ trống).")
  if (adv.creative_material_mode !== undefined && adv.creative_material_mode !== "CUSTOM") {
    throw invalid("Nhóm nhắn tin chỉ dùng creative_material_mode CUSTOM (không có ACO / Smart Creative).")
  }
  for (const k of ["included_pangle_audience_package_ids", "excluded_pangle_audience_package_ids"]) {
    if (adv[k] !== undefined) throw invalid(`Nhóm nhắn tin không dùng ${k}.`)
  }
  if (goal === "CLICK") {
    for (const k of ["click_attribution_window", "view_attribution_window", "attribution_event_count"]) {
      if (adv[k] !== undefined) throw invalid(`optimization_goal CLICK không dùng ${k}.`)
    }
  }

  // per-destination account fields
  if (spec.message_event_set_id !== undefined && goal !== "CONVERSATION") {
    throw invalid("message_event_set_id chỉ dùng với optimization_goal CONVERSATION.")
  }
  const extra = SPEC_KEYS.filter((k) => spec[k] !== undefined && !ALLOWED_SPEC_KEYS[dest].includes(k))
  if (extra.length) throw invalid(`${DEST_VI[dest]} không dùng ${extra.join(", ")}.`)

  const fields: Raw = {
    promotion_type: dest === "TIKTOK_DM" ? PROMO_DM : PROMO_IM,
    placement_type: "PLACEMENT_TYPE_NORMAL",
    placements: ["PLACEMENT_TIKTOK"],
  }
  if (dest !== "TIKTOK_DM") fields.messaging_app_type = dest
  if (dest === "MESSENGER") {
    if (!spec.facebook_page_id || !/^\d{1,30}$/.test(spec.facebook_page_id)) {
      throw invalid("Messenger cần facebook_page_id = ID Trang Facebook (chỉ chữ số).", "Xem ở Trang Facebook → Giới thiệu → Minh bạch về Trang.")
    }
    fields.messaging_app_account_id = spec.facebook_page_id
  } else if (dest === "LINE") {
    if (!spec.line_business_id || !/^[^\s\p{Cc}]{1,100}$/u.test(spec.line_business_id)) throw invalid("LINE cần line_business_id (LINE Business ID).")
    fields.messaging_app_account_id = spec.line_business_id
  } else if (dest === "WHATSAPP" || dest === "ZALO") {
    Object.assign(fields, phoneFields(spec, dest, warnings))
    if (dest === "WHATSAPP") warnings.push("WhatsApp: dùng số WhatsApp Business API đã kết nối công cụ quản lý tin nhắn (MMT).")
  }
  if (spec.message_event_set_id !== undefined) {
    if (!/^\d{1,30}$/.test(spec.message_event_set_id)) throw invalid("message_event_set_id phải là chuỗi chữ số.")
    fields.message_event_set_id = spec.message_event_set_id
  }

  // placement: TikTok only (automatic placement is refused by TikTok for messaging)
  if (input.placement_type === "manual" && input.placements?.length && !(input.placements.length === 1 && input.placements[0] === "PLACEMENT_TIKTOK")) {
    throw invalid(
      "Quảng cáo nhắn tin chỉ chạy ở vị trí TikTok: dùng placements [\"PLACEMENT_TIKTOK\"] hoặc bỏ trống để công cụ tự đặt."
    )
  }
  if (input.placement_type === "automatic") {
    warnings.push("Quảng cáo nhắn tin bắt buộc vị trí thủ công chỉ TikTok - đã đặt PLACEMENT_TYPE_NORMAL + PLACEMENT_TIKTOK.")
  }
  if (goal === "CONVERSATION") {
    warnings.push("optimization_goal CONVERSATION cần TikTok mở allowlist cho tài khoản - nếu bị từ chối, dùng CLICK.")
    if (dest === "TIKTOK_DM") {
      warnings.push(
        "Tin nhắn TikTok tối ưu CONVERSATION: quảng cáo chỉ dùng identity TT_USER có can_manage_message = true; tài khoản ủy quyền qua Business Center (BC_AUTH_TT) cần nhóm tối ưu CLICK."
      )
    }
  }
  warnings.push(
    `Nhóm nhắn tin (${DEST_VI[dest]}): ứng dụng, tài khoản / số điện thoại và message_event_set_id không sửa được sau khi tạo. Chỉ nhắm được các thị trường TikTok hỗ trợ (có Việt Nam).`
  )
  return { destination: dest, fields, advanced: Object.keys(adv).length ? adv : input.advanced ? {} : undefined }
}

// ---------------------------------------------------------------------------
// /ad/create/ rules of messaging ad groups
// ---------------------------------------------------------------------------

export interface MessagingGroup {
  dm: boolean
  /** MESSENGER | WHATSAPP | ZALO | LINE | IM_URL; null = instant messaging app type not readable */
  appType: string | null
  goal: string
}

/** Messaging kind of an ad group read from /adgroup/get/ (null = not a messaging ad group). */
export function messagingGroupOf(group: Raw): MessagingGroup | null {
  const p = str(group.promotion_type)
  const goal = str(group.optimization_goal) ?? "CLICK"
  if (p === PROMO_DM) return { dm: true, appType: null, goal }
  if (p === PROMO_IM) {
    const t = str(group.messaging_app_type)
    return { dm: false, appType: t && APP_TYPES.includes(t) ? t : null, goal }
  }
  return null
}

/** Creative fields the messaging rules look at */
export const MESSAGING_CREATIVE_KEYS = [
  "auto_message_id",
  "page_id",
  "deeplink",
  "deeplink_type",
  "fallback_type",
  "tracking_message_event_set_id",
] as const

/** Creative fields that exist ONLY for messaging ad groups (page_id / deeplink* / fallback_type are general fields) */
export const MESSAGING_ONLY_CREATIVE_KEYS = ["auto_message_id", "tracking_message_event_set_id"] as const

export interface MessagingCreativeFields {
  ad_format: string
  identity_type: string
  call_to_action?: string
  landing_page_url?: string
  auto_message_id?: string
  page_id?: string
  deeplink?: string
  deeplink_type?: string
  fallback_type?: string
  tracking_message_event_set_id?: string
}

/**
 * Messaging rules of one creative. Returns the fields to override (call_to_action defaulted to SEND_MESSAGE).
 * Non-messaging ad groups: the messaging-only fields are refused, nothing else changes.
 */
export function checkMessagingCreative(
  c: MessagingCreativeFields,
  where: string,
  group: MessagingGroup | null,
  warnings: string[]
): Raw {
  const present = (keys: readonly (keyof MessagingCreativeFields)[]) => keys.filter((k) => c[k] !== undefined)
  if (!group) {
    const used = present(MESSAGING_ONLY_CREATIVE_KEYS)
    if (used.length) {
      throw invalid(
        `${where}: ${used.join(", ")} chỉ dùng cho nhóm quảng cáo nhắn tin (auto_message_id: nhóm ${PROMO_DM}; tracking_message_event_set_id: nhóm ${PROMO_IM}).`,
        "Bỏ các trường này, hoặc tạo nhóm nhắn tin bằng tiktok_create_adgroup với messaging."
      )
    }
    return {}
  }
  if (c.ad_format !== "SINGLE_VIDEO" && c.ad_format !== "CAROUSEL_ADS") {
    throw invalid(`${where}: quảng cáo nhắn tin chỉ dùng SINGLE_VIDEO hoặc CAROUSEL_ADS (không có ảnh đơn).`)
  }
  const out: Raw = {}
  let cta = c.call_to_action
  if (!cta) {
    cta = "SEND_MESSAGE"
    out.call_to_action = cta
    warnings.push(`${where}: chưa có call_to_action - đã đặt SEND_MESSAGE (Gửi tin nhắn).`)
  }
  const refuse = (keys: readonly (keyof MessagingCreativeFields)[], why: string) => {
    const used = present(keys)
    if (used.length) throw invalid(`${where}: ${why} không dùng ${used.join(", ")}.`)
  }

  if (group.dm) {
    if (cta !== "SEND_MESSAGE") throw invalid(`${where}: quảng cáo tin nhắn TikTok bắt buộc call_to_action SEND_MESSAGE.`)
    refuse(["landing_page_url", "page_id", "deeplink", "deeplink_type", "fallback_type", "tracking_message_event_set_id"], "quảng cáo tin nhắn TikTok")
    if (!c.auto_message_id) {
      throw invalid(
        `${where}: quảng cáo tin nhắn TikTok cần auto_message_id (lời chào).`,
        "Tra bằng tiktok_messaging_assets kind=welcome_messages hoặc tạo bằng tiktok_create_welcome_message."
      )
    }
    if (c.identity_type !== "TT_USER" && c.identity_type !== "BC_AUTH_TT") {
      throw invalid(
        `${where}: tin nhắn TikTok chỉ dùng Spark Ads với identity TT_USER hoặc BC_AUTH_TT.`,
        "Tra bằng tiktok_messaging_assets kind=dm_identities (cần can_manage_message = true)."
      )
    }
    if (group.goal === "CONVERSATION" && c.identity_type !== "TT_USER") {
      // Rule of the /ad/create/ doc (TT_USER only for CONVERSATION); BC_AUTH_TT works with CLICK. The ad group's messaging
      // fields (optimization_goal included) cannot be edited after creation → switching to CLICK means a new ad group.
      throw invalid(
        `${where}: nhóm tin nhắn TikTok tối ưu CONVERSATION chỉ dùng identity TT_USER. Có 2 cách: (1) dùng identity TT_USER có can_manage_message = true; (2) muốn dùng tài khoản ủy quyền qua Business Center (BC_AUTH_TT) thì tạo nhóm tin nhắn mới tối ưu CLICK (trường nhắn tin / mục tiêu tối ưu của nhóm không sửa được sau khi tạo).`,
        "Tra identity bằng tiktok_messaging_assets kind=dm_identities; tạo nhóm mới bằng tiktok_create_adgroup với messaging {destination: TIKTOK_DM} và optimization_goal CLICK."
      )
    }
    return out
  }

  if (cta === "CALL_NOW") throw invalid(`${where}: quảng cáo nhắn tin qua ứng dụng không dùng call_to_action CALL_NOW (nên dùng SEND_MESSAGE).`)
  refuse(["auto_message_id"], "nhóm nhắn tin qua ứng dụng (auto_message_id chỉ cho tin nhắn TikTok)")
  if (c.page_id !== undefined && group.goal !== "CLICK") throw invalid(`${where}: page_id (TikTok Instant Page) chỉ dùng khi nhóm tối ưu CLICK.`)
  if (c.tracking_message_event_set_id !== undefined) {
    if (group.goal !== "CLICK" || !(group.appType === "MESSENGER" || group.appType === "WHATSAPP") || c.page_id !== undefined) {
      throw invalid(`${where}: tracking_message_event_set_id chỉ dùng khi nhóm tối ưu CLICK, ứng dụng Messenger hoặc WhatsApp và không có page_id.`)
    }
  }
  if (group.appType === null) {
    warnings.push(`${where}: không đọc được messaging_app_type của nhóm - chỉ kiểm tra các quy tắc chung của quảng cáo nhắn tin.`)
    return out
  }
  if (group.appType !== "IM_URL") {
    refuse(
      ["landing_page_url", "deeplink", "deeplink_type", "fallback_type"],
      `nhóm ${group.appType} (TikTok tự tạo đường dẫn tới ứng dụng từ cấu hình nhóm - không tự gửi link wa.me / m.me / zalo.me)`
    )
    return out
  }
  // IM_URL: landing_page_url (https universal / App link), deeplink + WEBSITE fallback, or an Instant Page
  if (c.page_id !== undefined) {
    refuse(["landing_page_url", "deeplink", "deeplink_type", "fallback_type"], "quảng cáo IM_URL dùng page_id")
    return out
  }
  if (!c.landing_page_url) {
    throw invalid(`${where}: nhóm IM_URL cần landing_page_url (link https của ứng dụng nhắn tin, vd https://zalo.me/…) hoặc page_id.`)
  }
  if (!/^https:\/\//i.test(c.landing_page_url)) throw invalid(`${where}: landing_page_url của nhóm IM_URL phải là link https.`)
  if (c.deeplink === undefined) {
    refuse(["deeplink_type", "fallback_type"], "quảng cáo không có deeplink")
  } else if (c.fallback_type !== "WEBSITE") {
    throw invalid(`${where}: deeplink cần fallback_type WEBSITE (mở landing_page_url khi chưa cài ứng dụng).`)
  } else if (c.deeplink_type !== undefined && c.deeplink_type !== "NORMAL") {
    throw invalid(`${where}: quảng cáo nhắn tin chỉ dùng deeplink_type NORMAL.`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// project sanitiser (lib/text-safety UNSAFE_TEXT_CHARS: controls except tab / newline, C1, bidi, zero-width, BOM, soft
// hyphen, variation selectors, Unicode tag characters) + U+180E as in the Meta welcome cleaner
const EXTRA_UNSAFE = /\u180E/g
const stripUnsafe = (s: string) => s.replace(UNSAFE_TEXT_CHARS, "").replace(EXTRA_UNSAFE, "")
/** CRLF / CR / U+2028 / U+2029 → newline, tab → space */
const lines = (s: string) => s.normalize("NFC").replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/\t/g, " ")

/** Text written to TikTok (welcome message): unsafe characters removed, length checked after cleaning. */
function cleanWelcomeText(raw: string, field: string, max: number, singleLine: boolean): string {
  let s = lines(raw)
  if (singleLine) s = s.replace(/\n+/g, " ")
  s = stripUnsafe(s).replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  if (!s) throw invalid(`${field} trống (sau khi bỏ ký tự điều khiển).`)
  if (s.length > max) throw invalid(`${field} tối đa ${max} ký tự.`)
  return s
}

/** Text read from TikTok shown to the AI: unsafe characters removed, newlines kept, cut at `max` (surrogate-safe). */
function outText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const s = stripUnsafe(lines(v)).trim()
  if (!s) return null
  return cutText(s, max)
}

const label = (v: unknown, max = 120) => (typeof v === "string" ? sanitizeExternalLabel(v, max) : null)
/** enum-like / short free strings from TikTok (status, app type, account id, identity id…) */
const short = (v: unknown) => label(typeof v === "number" || typeof v === "boolean" ? String(v) : v, 64)
/** numeric ids from TikTok: digit strings only (a JSON number above 2^53 has already lost digits → null) */
function idOut(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : ""
  return /^\d{1,30}$/.test(s) ? s : null
}
/** https URL from TikTok: unsafe characters and whitespace removed first, then https only */
function httpsOut(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = stripUnsafe(v).replace(/\s+/g, "")
  return /^https:\/\/[^/]/i.test(s) && s.length <= 500 ? s : null
}

// ---------------------------------------------------------------------------
// tiktok_messaging_assets (read)
// ---------------------------------------------------------------------------

export const ASSET_KINDS = ["welcome_messages", "dm_identities", "instant_pages", "message_event_sets", "phone_region_codes"] as const

export const messagingAssetsInput = z.object({
  kind: z.enum(ASSET_KINDS),
  messaging_app_type: z
    .enum(["MESSENGER", "WHATSAPP", "ZALO"])
    .optional()
    .describe("Bắt buộc với message_event_sets"),
  messaging_app_account_id: digitsId("messaging_app_account_id")
    .optional()
    .describe("Bắt buộc với message_event_sets: ID Trang Facebook / số WhatsApp gồm mã quốc gia (84901234567) / Zalo OA ID"),
  identity_authorized_bc_id: digitsId("identity_authorized_bc_id")
    .optional()
    .describe("dm_identities: ID Business Center để liệt kê thêm tài khoản TikTok ủy quyền qua BC (BC_AUTH_TT)"),
  q: z.string().trim().max(100).optional().describe("Lọc theo tên / nội dung (trong trang kết quả)"),
  page: z.number().int().min(1).max(1000).default(1),
  limit: z.number().int().min(1).max(100).default(50),
})
export type MessagingAssetsInput = z.infer<typeof messagingAssetsInput>

function matchesQ(q: string | undefined, ...vals: unknown[]): boolean {
  if (!q) return true
  const n = q.toLowerCase()
  return vals.some((v) => typeof v === "string" && v.toLowerCase().includes(n))
}

interface ListPage {
  list: Raw[]
  totalPage: number
  total: number | null
}

function pageOf(data: Raw, ...keys: string[]): ListPage {
  let list: Raw[] = []
  for (const k of keys) {
    if (Array.isArray(data[k])) {
      list = data[k] as Raw[]
      break
    }
  }
  const info = (data.page_info as Raw | undefined) ?? {}
  const total = info.total_number === undefined ? null : Number(info.total_number)
  return { list, totalPage: Number(info.total_page ?? 1), total: Number.isFinite(total) ? total : null }
}

/** Welcome message as returned by /creative/auto_message/get/ (list key is `list` in the table, `auto_message_list` in the example). */
export function mapWelcome(m: Raw) {
  const w = (m.welcome_message as Raw | undefined) ?? {}
  const qs = Array.isArray(w.suggested_questions) ? (w.suggested_questions as Raw[]) : []
  return {
    auto_message_id: idOut(m.auto_message_id),
    title: label(w.title, 120),
    content: outText(w.content, 300),
    suggested_questions: qs
      .filter((x): x is Raw => !!x && typeof x === "object" && !Array.isArray(x))
      .slice(0, 3)
      .map((x) => ({ question: label(x.question, 100), answer: outText(x.answer, 600) })),
    audit_status: short(m.audit_status),
    create_time: short(m.create_time),
  }
}

async function runMessagingAssets(ctx: ProviderContext<TikTokCredentials>, input: MessagingAssetsInput) {
  const tt = ttFromCtx(ctx)
  const q = input.q || undefined
  const warnings: string[] = []
  switch (input.kind) {
    case "welcome_messages": {
      const res = await ttGet<Raw>(tt, "creative/auto_message/get", {
        advertiser_id: tt.advertiserId,
        auto_message_type: "WELCOME_MESSAGE",
        page: input.page,
        page_size: input.limit,
      })
      const p = pageOf(res.data, "list", "auto_message_list")
      const items = p.list.map(mapWelcome).filter((m) => matchesQ(q, m.title, m.content))
      if (!p.list.length && input.page === 1) warnings.push("Chưa có lời chào nào - tạo bằng tiktok_create_welcome_message.")
      if (items.some((m) => m.audit_status === "REJECTED")) warnings.push("Lời chào REJECTED (bị từ chối) không dùng được cho quảng cáo.")
      return { kind: input.kind, items, page: input.page, total: p.total, next_page: input.page < p.totalPage ? input.page + 1 : null, warnings }
    }
    case "instant_pages": {
      const res = await ttGet<Raw>(tt, "page/get", {
        advertiser_id: tt.advertiserId,
        business_types: ["TIKTOK_INSTANT_PAGE"],
        status: "PUBLISHED",
        page: input.page,
        page_size: input.limit,
      })
      const p = pageOf(res.data, "list")
      const items = p.list
        .map((pg) => ({
          page_id: idOut(pg.page_id),
          title: label(pg.title, 120),
          status: short(pg.status),
          template_name: label(pg.template_name, 80),
          messaging_app_type: short(pg.messaging_app_type),
          messaging_app_account_id: short(pg.messaging_app_account_id),
          supported_objectives: Array.isArray(pg.supported_objectives)
            ? pg.supported_objectives.slice(0, 12).map(short).filter((x): x is string => !!x)
            : null,
          preview_url: httpsOut(pg.preview_url),
        }))
        .filter((pg) => matchesQ(q, pg.title))
      warnings.push(
        "page_id dùng trong tiktok_create_ads (chỉ nhóm tối ưu CLICK); messaging_app_type / messaging_app_account_id của trang phải khớp nhóm quảng cáo. Instant Page tạo trong TikTok Ads Manager."
      )
      return { kind: input.kind, items, page: input.page, total: p.total, next_page: input.page < p.totalPage ? input.page + 1 : null, warnings }
    }
    case "message_event_sets": {
      if (!input.messaging_app_type || !input.messaging_app_account_id) {
        throw invalid(
          "message_event_sets cần messaging_app_type và messaging_app_account_id.",
          "MESSENGER: ID Trang Facebook; WHATSAPP: số gồm mã quốc gia, chỉ chữ số (vd 84901234567); ZALO: Zalo OA ID."
        )
      }
      const res = await ttGet<Raw>(tt, "ctm/message_event_set/get", {
        advertiser_id: tt.advertiserId,
        messaging_app_type: input.messaging_app_type,
        messaging_app_account_id: input.messaging_app_account_id,
      })
      const ev = (e: unknown) => {
        const r = (e as Raw | null) ?? null
        if (!r || !r.message_event_set_id) return null
        const id = idOut(r.message_event_set_id)
        if (!id) return null
        return { message_event_set_id: id, message_event_name: label(r.message_event_name, 120), create_time: short(r.create_time) }
      }
      const matched = ev(res.data.matched_event_set)
      const list = Array.isArray(res.data.message_event_set_list) ? (res.data.message_event_set_list as Raw[]) : []
      const items = list.map(ev).filter((x): x is NonNullable<typeof x> => !!x && matchesQ(q, x.message_event_name))
      warnings.push(
        matched
          ? "Tài khoản ứng dụng đã khớp event set (matched_event_set): TikTok tự điền message_event_set_id - không cần truyền."
          : "Chưa khớp event set: nhóm tối ưu CONVERSATION cần message_event_set_id lấy từ danh sách (tạo event set trong TikTok Events Manager)."
      )
      return { kind: input.kind, matched_event_set: matched, items: items.slice(0, input.limit), warnings }
    }
    case "dm_identities": {
      const all = await fetchIdentityList(tt)
      // /identity/get/ without identity_type may not list every BC_AUTH_TT identity: query identity_type=BC_AUTH_TT +
      // identity_authorized_bc_id (doc 1740218420781057) for the Business Centers we know (input / listed), ≤3
      const bcIds = [
        ...new Set([
          ...(input.identity_authorized_bc_id ? [input.identity_authorized_bc_id] : []),
          ...all.filter((i) => i.identity_type === "BC_AUTH_TT").map((i) => idOut(i.identity_authorized_bc_id)).filter((x): x is string => !!x),
        ]),
      ].slice(0, 3)
      for (const bc of bcIds) {
        try {
          const res = await ttGet<{ identity_list?: Raw[] }>(tt, "identity/get", {
            advertiser_id: tt.advertiserId,
            identity_type: "BC_AUTH_TT",
            identity_authorized_bc_id: bc,
            page: 1,
            page_size: 100,
          })
          for (const i of res.data.identity_list ?? []) {
            if (!all.some((x) => String(x.identity_id) === String(i.identity_id) && x.identity_type === i.identity_type)) all.push(i)
          }
        } catch {
          warnings.push(`Không đọc được tài khoản TikTok ủy quyền qua Business Center ${bc}.`)
        }
      }
      const items = all
        .filter((i) => i.identity_type === "TT_USER" || i.identity_type === "BC_AUTH_TT")
        .map((i) => ({
          identity_id: short(i.identity_id),
          identity_type: short(i.identity_type),
          identity_authorized_bc_id: idOut(i.identity_authorized_bc_id),
          display_name: label(i.display_name, 80),
          username: label(i.username, 80),
          available_status: short(i.available_status),
          can_manage_message: typeof i.can_manage_message === "boolean" ? i.can_manage_message : null,
        }))
        .filter((i) => matchesQ(q, i.display_name, i.username, i.identity_id))
      const start = (input.page - 1) * input.limit
      if (!items.some((i) => i.can_manage_message === true)) {
        warnings.push(
          "Danh sách chưa có tài khoản TikTok nào nhắn tin được (can_manage_message = true). Tài khoản ủy quyền qua Business Center (BC_AUTH_TT) có thể không hiện ở đây - kiểm tra trong Business Center hoặc gọi lại kèm identity_authorized_bc_id. Cấp quyền: TT_USER - \"Read and manage messages\" trong cài đặt người dùng TikTok Ads Manager; BC_AUTH_TT - quản trị Business Center gán tài khoản với quyền POST + DIRECT_MESSAGE. Tài khoản TikTok phải cho \"Mọi người\" (Everyone) nhắn tin."
        )
      }
      return {
        kind: input.kind,
        items: items.slice(start, start + input.limit),
        page: input.page,
        total: items.length,
        next_page: start + input.limit < items.length ? input.page + 1 : null,
        warnings,
      }
    }
    case "phone_region_codes": {
      const res = await ttGet<Raw>(tt, "tool/phone_region_code", { advertiser_id: tt.advertiserId })
      const list = Array.isArray(res.data.phone_region_code_infos) ? (res.data.phone_region_code_infos as Raw[]) : []
      const items = list
        .map((r) => ({
          phone_region_code: short(r.phone_region_code),
          phone_region_name: label(r.phone_region_name, 80),
          phone_region_calling_code: short(r.phone_region_calling_code),
        }))
        .filter((r) => matchesQ(q, r.phone_region_code, r.phone_region_name, r.phone_region_calling_code))
      const start = (input.page - 1) * input.limit
      return {
        kind: input.kind,
        items: items.slice(start, start + input.limit),
        page: input.page,
        total: items.length,
        next_page: start + input.limit < items.length ? input.page + 1 : null,
        warnings: ["Dùng phone_region_code + phone_region_calling_code cho messaging WHATSAPP / ZALO của tiktok_create_adgroup."],
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tiktok_create_welcome_message (create)
// ---------------------------------------------------------------------------

export const welcomeMessageInput = z.object({
  title: z.string().max(100).optional().describe("Tên trong thư viện lời chào (để phân biệt); bỏ trống → tự đặt từ nội dung"),
  content: z.string().min(1).max(200).describe("Lời chào gửi khi khách bấm quảng cáo, ≤200 ký tự"),
  suggested_questions: z
    .array(
      z.object({
        question: z.string().min(1).max(70).describe("≤70 ký tự"),
        answer: z.string().min(1).max(500).describe("Trả lời tự động, ≤500 ký tự"),
      })
    )
    .min(1)
    .max(3)
    .optional()
    .describe("1–3 câu hỏi gợi ý; bỏ trống → 1 câu mặc định"),
})
export type WelcomeMessageInput = z.infer<typeof welcomeMessageInput>

/** Neutral suggested question used when none is given (TikTok requires 1-3). */
export const DEFAULT_SUGGESTED_QUESTION = {
  question: "Tôi muốn được tư vấn",
  answer: "Cảm ơn bạn đã nhắn tin! Shop sẽ phản hồi bạn sớm nhất.",
}

export interface WelcomeMessageBody {
  title: string
  content: string
  suggested_questions: { question: string; answer: string }[]
}

export function buildWelcomeMessage(input: WelcomeMessageInput, warnings: string[]): WelcomeMessageBody {
  const content = cleanWelcomeText(input.content, "content", 200, false)
  let questions = (input.suggested_questions ?? []).map((x, i) => ({
    question: cleanWelcomeText(x.question, `suggested_questions[${i}].question`, 70, true),
    answer: cleanWelcomeText(x.answer, `suggested_questions[${i}].answer`, 500, false),
  }))
  if (!questions.length) {
    questions = [DEFAULT_SUGGESTED_QUESTION]
    warnings.push(
      `TikTok cần 1-3 câu hỏi gợi ý - đã dùng câu mặc định "${DEFAULT_SUGGESTED_QUESTION.question}". Truyền suggested_questions để tự đặt.`
    )
  }
  const given = input.title === undefined ? "" : input.title.trim()
  let title: string
  if (given) title = cleanWelcomeText(given, "title", 100, true)
  else {
    // deterministic (same on preview and execution) and distinctive (lookup key after a timeout)
    const hash = createHash("sha256").update(JSON.stringify([content, questions])).digest("hex").slice(0, 6)
    title = `${sanitizeExternalLabel(content, 40) ?? "Lời chào"} #${hash}`
  }
  return { title, content, suggested_questions: questions }
}

const LOOKUP_SKEW_MS = 10 * 60_000

/** Welcome message with this exact title + content created at/after `sinceMs` (newest first), null if none. */
async function findWelcome(tt: TT, wm: WelcomeMessageBody, sinceMs: number): Promise<string | null> {
  const hits: { id: string; t: number }[] = []
  for (let page = 1; page <= 5; page++) {
    const res = await ttGet<Raw>(tt, "creative/auto_message/get", {
      advertiser_id: tt.advertiserId,
      auto_message_type: "WELCOME_MESSAGE",
      page,
      page_size: 100,
    })
    const p = pageOf(res.data, "list", "auto_message_list")
    for (const m of p.list) {
      const w = (m.welcome_message as Raw | undefined) ?? {}
      const id = idOut(m.auto_message_id)
      const t = parseTikTokTime(m.create_time)?.getTime() ?? null
      // only a record with a readable create_time inside the window counts as "just created"
      if (id && w.title === wm.title && w.content === wm.content && t !== null && t >= sinceMs) hits.push({ id, t })
    }
    if (!p.list.length || page >= p.totalPage) break
  }
  hits.sort((a, b) => b.t - a.t)
  return hits[0]?.id ?? null
}

export const WELCOME_VERIFY_HINT =
  "Có thể lời chào đã được tạo - kiểm tra bằng tiktok_messaging_assets kind=welcome_messages trước khi tạo lại."

async function runCreateWelcome(
  ctx: ProviderContext<TikTokCredentials>,
  input: WelcomeMessageInput,
  opts: MutationOptions
): Promise<MutationResult & { payload: Raw }> {
  const tt = ttFromCtx(ctx)
  const warnings = [
    "Lời chào được lưu vào thư viện của tài khoản quảng cáo và TikTok sẽ duyệt; lời chào gắn vào quảng cáo không đổi được sau khi tạo quảng cáo.",
  ]
  const wm = buildWelcomeMessage(input, warnings)
  const payload: Raw = { auto_message_type: "WELCOME_MESSAGE", welcome_message: wm }
  if (opts.dryRun) {
    return { preview: true, changes: [{ objectId: "(mới)", field: "welcome_message", before: null, after: wm }], warnings, payload }
  }
  const started = Date.now()
  let id: string | null
  try {
    // no request_id on this endpoint → sent once, never retried
    const res = await ttPost<Raw>(tt, "creative/auto_message/create", { advertiser_id: tt.advertiserId, ...payload }, { retries: 0 })
    id = idOut(res.data.auto_message_id)
  } catch (e) {
    if (!isUncertainCreateError(e)) throw e
    const found = await findWelcome(tt, wm, started - LOOKUP_SKEW_MS).catch(() => null)
    if (!found) {
      const pe = isProviderError(e) ? e : null
      throw new ProviderError({
        platform: "tiktok",
        code: pe?.code ?? "upstream_error",
        message: `TikTok welcome message create outcome unknown: ${pe?.message ?? String(e)}`,
        userMessageVi: `TikTok không phản hồi rõ khi tạo lời chào (${pe?.userMessageVi ?? "lỗi mạng"}).`,
        retryable: false,
        hint: WELCOME_VERIFY_HINT,
        upstream: pe?.upstream,
        cause: e,
      })
    }
    warnings.push(`TikTok phản hồi lỗi/timeout nhưng lời chào đã được tạo (auto_message_id ${found}) - dùng id này, không tạo lại.`)
    id = found
  }
  if (!id) {
    throw new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: "TikTok returned no valid auto_message_id",
      userMessageVi: "TikTok không trả về auto_message_id hợp lệ.",
      retryable: false,
      hint: WELCOME_VERIFY_HINT,
    })
  }
  return {
    preview: false,
    changes: [{ objectId: id, field: "welcome_message", before: null, after: { auto_message_id: id, ...wm } }],
    warnings,
    createdIds: [id],
    payload,
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MESSAGING_DEADLINE_NOTE = "Lưu ý: TikTok ngừng tạo chiến dịch thủ công qua API sau 31/12/2026."

export const messagingExtensions: ProviderExtension<TikTokCredentials>[] = [
  {
    name: "tiktok_messaging_assets",
    permission: "read",
    title: "Tài sản quảng cáo nhắn tin TikTok",
    description: `Dùng khi chuẩn bị quảng cáo nhắn tin TikTok (chiến dịch LEAD_GENERATION) để xem tài sản cần có trước khi tạo nhóm / quảng cáo. kind: welcome_messages = lời chào cho tin nhắn TikTok (auto_message_id; chưa có thì tạo bằng tiktok_create_welcome_message); dm_identities = tài khoản TikTok TT_USER / BC_AUTH_TT (thêm identity_authorized_bc_id để liệt kê tài khoản ủy quyền qua BC), can_manage_message phải là true (TT_USER: cấp quyền "Read and manage messages" trong TikTok Ads Manager; BC_AUTH_TT: quản trị Business Center gán quyền DIRECT_MESSAGE; tài khoản TikTok phải cho "Mọi người" nhắn tin); instant_pages = TikTok Instant Page đã xuất bản (page_id, chỉ nhóm tối ưu CLICK); message_event_sets = event set cho CONVERSATION, cần messaging_app_type + messaging_app_account_id (ID Trang Facebook / số WhatsApp gồm mã quốc gia như 84901234567 / Zalo OA ID) và quyền CTX Events Management của developer app; phone_region_codes = mã vùng cho WhatsApp / Zalo. Chỉ đọc. Bước tiếp theo: tiktok_create_adgroup với messaging rồi tiktok_create_ads. ${MESSAGING_DEADLINE_NOTE}`,
    input: messagingAssetsInput,
    write: false,
    run: (ctx, input) => runMessagingAssets(ctx, input as MessagingAssetsInput),
  },
  {
    name: "tiktok_create_welcome_message",
    permission: "create",
    title: "Tạo lời chào tin nhắn TikTok",
    description: `Dùng khi cần lời chào (welcome message) cho quảng cáo tin nhắn TikTok - bắt buộc với nhóm messaging.destination = TIKTOK_DM. Gọi tiktok_messaging_assets kind=welcome_messages trước: đã có lời chào cùng nội dung thì dùng lại auto_message_id đó. content ≤200 ký tự; suggested_questions 1-3 câu {question ≤70, answer ≤500} (bỏ trống → tool thêm 1 câu mặc định "Tôi muốn được tư vấn" - cho người dùng thấy câu này trong bản xem trước); title để phân biệt trong thư viện (bỏ trống → tự đặt). Kết quả: created_ids[0] = auto_message_id dùng trong tiktok_create_ads. TikTok duyệt lời chào; quảng cáo đã tạo không đổi được lời chào. Không tự thử lại khi lỗi mạng để tránh tạo trùng. ${MESSAGING_DEADLINE_NOTE}`,
    input: welcomeMessageInput,
    write: true,
    // a library entry, not an ad object: no "created paused" note
    createsAdObject: false,
    run: (ctx, input, opts) => runCreateWelcome(ctx, input as WelcomeMessageInput, opts),
  },
]
