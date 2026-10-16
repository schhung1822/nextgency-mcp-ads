// tiktok_create_smart_plus (v1.1.6, E1): create a TikTok Upgraded Smart+ campaign → ad group → ad, or only the lower levels
// under an existing Upgraded Smart+ campaign_id / adgroup_id. Scope: WEB_CONVERSIONS (website) and LEAD_GENERATION
// (Instant Form, website, TikTok direct messages, instant messaging apps). No APP_PROMOTION, catalog, Search Ads, phone
// call, multi-destination, Custom Identity, Goal-based budget increase (AUTO_BUDGET_INCREASE is always refused).
// Official docs (read 2026-10-16, copies in the v1.1.6 research): campaign create 1843312852800706, ad group create
// 1843314887930946, ad create 1843317390059522, gets 1843312818332930 / 1843314879617026 / 1843317378982914, guides
// web 1847302878676994, Instant Form 1843324592169986, lead website 1843324606213121, DM 1847302969710913, IM apps
// 1847302988449921, creative combinations 1847839781968897, targeting modes 1847839827327106, dynamic CTA
// 1740307296329730 / 1739362202742785 / 1739091950439426, return codes 1737172488964097.
// Safety: operation_status "DISABLE" at all three levels (TikTok defaults to ENABLE) + read back (re-disabled when not
// DISABLE); campaign / ad group creates carry a deterministic request_id (derived from the confirmed idempotency key) and
// are retried only on throttle codes; /smart_plus/ad/create/ has no request_id → never retried; an unknown outcome is
// looked up (name + creation time) before failing. A failure after something was created reports the created (paused)
// ids and how to continue without creating duplicates.
// [?] = not verified with a real allowlisted account (sandbox has no Smart+) - see providers/tiktok.md.
import { z } from "zod"
import { sanitizeExternalLabel } from "../../../lib/text-safety"
import { isProviderError, ProviderError } from "../errors"
import type {
  ExtensionMoneyItem,
  FieldChange,
  MutationOptions,
  MutationResult,
  ProviderContext,
  ProviderExtension,
} from "../types"
import {
  apiMoney,
  formatTikTokTime,
  invalid,
  isTikTokTime,
  parseTikTokTime,
  str,
  ttFromCtx,
  ttGet,
  ttPost,
  type Raw,
  type TT,
} from "./api"
import { makeRequestId } from "./client"
import { isUncertainCreateError } from "./create-checked"
import type { TikTokCredentials } from "./credentials"
import {
  phoneFields,
  PROMO_DM,
  PROMO_IM,
  type MessagingDestination,
} from "./messaging"

// ---------------------------------------------------------------------------
// Enums / tables
// ---------------------------------------------------------------------------

/** Destinations ("goal") supported by the tool → objective / promotion_type / promotion_target_type. */
export const SMART_PLUS_GOALS = [
  "WEBSITE",
  "LEAD_FORM",
  "LEAD_WEBSITE",
  "TIKTOK_DM",
  "MESSENGER",
  "WHATSAPP",
  "ZALO",
  "LINE",
  "IM_URL",
] as const
export type SmartPlusGoal = (typeof SMART_PLUS_GOALS)[number]

const IM_GOALS = new Set<SmartPlusGoal>([
  "MESSENGER",
  "WHATSAPP",
  "ZALO",
  "LINE",
  "IM_URL",
])

/** optimization_goal values per destination (first = default when omitted; null = must be given) [H guides]. */
const GOAL_OPTIMIZATION: Record<
  SmartPlusGoal,
  { allowed: string[]; fallback: string | null }
> = {
  WEBSITE: {
    allowed: ["CLICK", "CONVERT", "TRAFFIC_LANDING_PAGE_VIEW"],
    fallback: null,
  },
  LEAD_FORM: { allowed: ["LEAD_GENERATION"], fallback: "LEAD_GENERATION" },
  LEAD_WEBSITE: { allowed: ["WEBSITE_ENGAGEMENT", "CONVERT"], fallback: null },
  TIKTOK_DM: { allowed: ["CLICK", "CONVERSATION"], fallback: "CLICK" },
  MESSENGER: { allowed: ["CLICK", "CONVERSATION"], fallback: "CLICK" },
  WHATSAPP: { allowed: ["CLICK", "CONVERSATION"], fallback: "CLICK" },
  ZALO: { allowed: ["CLICK", "CONVERSATION"], fallback: "CLICK" },
  LINE: { allowed: ["CLICK"], fallback: "CLICK" },
  IM_URL: { allowed: ["CLICK"], fallback: "CLICK" },
}
const OPTIMIZATION_GOALS = [
  "CLICK",
  "CONVERT",
  "TRAFFIC_LANDING_PAGE_VIEW",
  "LEAD_GENERATION",
  "WEBSITE_ENGAGEMENT",
  "CONVERSATION",
] as const

const GOAL_VI: Record<SmartPlusGoal, string> = {
  WEBSITE: "Website (chuyển đổi trên web)",
  LEAD_FORM: "Khách hàng tiềm năng - Instant Form",
  LEAD_WEBSITE: "Khách hàng tiềm năng - Website",
  TIKTOK_DM: "Tin nhắn TikTok",
  MESSENGER: "Messenger",
  WHATSAPP: "WhatsApp",
  ZALO: "Zalo",
  LINE: "LINE",
  IM_URL: "Đường dẫn ứng dụng nhắn tin (IM_URL)",
}

export function objectiveOf(
  goal: SmartPlusGoal
): "WEB_CONVERSIONS" | "LEAD_GENERATION" {
  return goal === "WEBSITE" ? "WEB_CONVERSIONS" : "LEAD_GENERATION"
}

function promotionOf(goal: SmartPlusGoal): {
  promotion_type: string
  promotion_target_type?: string
} {
  if (goal === "WEBSITE") return { promotion_type: "WEBSITE" }
  if (goal === "LEAD_FORM")
    return {
      promotion_type: "LEAD_GENERATION",
      promotion_target_type: "INSTANT_PAGE",
    }
  if (goal === "LEAD_WEBSITE")
    return {
      promotion_type: "LEAD_GENERATION",
      promotion_target_type: "EXTERNAL_WEBSITE",
    }
  if (goal === "TIKTOK_DM") return { promotion_type: PROMO_DM }
  return { promotion_type: PROMO_IM }
}

/** Destination of an existing Upgraded Smart+ ad group (null = outside the tool's scope). */
export function goalOfAdGroup(g: Raw): SmartPlusGoal | null {
  const p = str(g.promotion_type)
  if (p === "WEBSITE") return "WEBSITE"
  if (p === "LEAD_GENERATION") {
    const t = str(g.promotion_target_type)
    return t === "INSTANT_PAGE"
      ? "LEAD_FORM"
      : t === "EXTERNAL_WEBSITE"
        ? "LEAD_WEBSITE"
        : null
  }
  if (p === PROMO_DM) return "TIKTOK_DM"
  if (p === PROMO_IM) {
    const app =
      str(g.messaging_app_type) ??
      (str(g.optimization_goal) === "CLICK" ? "IM_URL" : null)
    return app && IM_GOALS.has(app as SmartPlusGoal)
      ? (app as SmartPlusGoal)
      : null
  }
  return null
}

const MAX_ADGROUPS_PER_CAMPAIGN = 30
const MAX_ADS_PER_ADGROUP = 30
/** Clock skew tolerance between our clock and TikTok's create_time (same as create-checked.ts). */
const LOOKUP_SKEW_MS = 10 * 60_000
/** Recommended CTA groups put into one dynamic CTA portfolio (doc gives no limit [?]). */
const CTA_GROUPS = 5
const READBACK_RETRIES = 2

export const ALLOWLIST_MESSAGE =
  "Tài khoản quảng cáo này chưa được TikTok mở Upgraded Smart+ qua API (tạo/sửa chiến dịch Smart+ cần allowlist) - liên hệ đại diện TikTok (sales rep) để được mở."
export const SMART_PLUS_CUTOFF_NOTE =
  "TikTok ngừng tạo chiến dịch thủ công (Manual) qua API sau 31/12/2026 - từ đó Upgraded Smart+ là cách duy nhất tạo chiến dịch mới qua API."

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const numericId = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,30}$/, { error: `${label} phải là chuỗi chữ số.` })
/** Media / identity ids: printable id characters only (image ids may contain "/"). */
const assetId = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.:\/-]{1,256}$/, { error: `${label} không hợp lệ.` })
const ttTime = z
  .string()
  .refine(isTikTokTime, {
    error: 'Thời gian phải dạng "YYYY-MM-DD HH:MM:SS" theo giờ UTC (UTC+0).',
  })
const money = z.number().positive().finite()
// control / bidi / zero-width characters refused in names and texts sent to TikTok
const UNSAFE = /[\p{Cc}\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u
// emoji: refused by TikTok in campaign_name / adgroup_name / ad_name / ad_text [H] (©, ®, ™ are not emoji here)
const EMOJI = /(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}/u
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !UNSAFE.test(s), {
      error: "Chuỗi chứa ký tự điều khiển / ký tự ẩn.",
    })
    .refine((s) => !EMOJI.test(s), {
      error: "TikTok không nhận emoji trong tên / nội dung quảng cáo - bỏ emoji.",
    })
const autoBudgetField = z
  .string()
  .optional()
  .describe(
    "Không hỗ trợ: AUTO_BUDGET_INCREASE (tự tăng ngân sách) luôn bị từ chối vì trần chi ngày không kiểm soát được"
  )
const httpUrl = z
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u) && !UNSAFE.test(u), {
    error: "Link phải bắt đầu bằng http:// hoặc https://.",
  })

const campaignSpec = z.strictObject({
  name: safeText(512).describe("Tên chiến dịch (không emoji)"),
  objective: z
    .enum(["WEB_CONVERSIONS", "LEAD_GENERATION"])
    .optional()
    .describe("Tự suy ra từ adgroup.goal nếu bỏ trống"),
  cbo: z
    .boolean()
    .default(true)
    .describe(
      "true (mặc định TikTok) = ngân sách chiến dịch; false = ngân sách theo nhóm"
    ),
  budget_type: z
    .enum(["daily", "lifetime", "unlimited"])
    .describe(
      "daily = ngân sách ngày (Smart+ linh hoạt tới 125%/ngày); lifetime = trọn đời; unlimited chỉ khi cbo=false"
    ),
  budget: money.optional().describe("Đơn vị chính của tiền tệ tài khoản"),
  budget_auto_adjust_strategy: autoBudgetField,
})

const messagingSpec = z
  .strictObject({
    facebook_page_id: numericId("facebook_page_id")
      .optional()
      .describe("MESSENGER: ID Trang Facebook"),
    line_business_id: z
      .string()
      .trim()
      .regex(/^[^\s\p{Cc}]{1,100}$/u, {
        error: "line_business_id không hợp lệ.",
      })
      .optional()
      .describe("LINE: LINE Business ID"),
    zalo_oa_id: numericId("zalo_oa_id")
      .optional()
      .describe("ZALO + CONVERSATION: ID Zalo Official Account"),
    phone_region_code: z
      .string()
      .trim()
      .max(4)
      .optional()
      .describe("WHATSAPP / ZALO (CLICK): mã vùng, mặc định VN"),
    phone_region_calling_code: z
      .string()
      .trim()
      .max(6)
      .optional()
      .describe("Mặc định +84"),
    phone_number: z
      .string()
      .trim()
      .max(32)
      .optional()
      .describe("Số trong nước bỏ số 0 đầu (0901234567 → 901234567)"),
    message_event_set_id: numericId("message_event_set_id")
      .optional()
      .describe("Chỉ CONVERSATION khi tài khoản ứng dụng chưa khớp event set"),
  })
  .describe(
    "Tài khoản ứng dụng nhắn tin (goal MESSENGER / WHATSAPP / ZALO / LINE)"
  )

const adGroupSpec = z.strictObject({
  name: safeText(512),
  goal: z
    .enum(SMART_PLUS_GOALS)
    .describe(
      "Đích tối ưu: WEBSITE | LEAD_FORM | LEAD_WEBSITE | TIKTOK_DM | MESSENGER | WHATSAPP | ZALO | LINE | IM_URL"
    ),
  optimization_goal: z.enum(OPTIMIZATION_GOALS).optional(),
  pixel_id: numericId("pixel_id").optional(),
  optimization_event: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{2,64}$/, { error: "optimization_event không hợp lệ." })
    .optional()
    .describe(
      "Sự kiện pixel (vd SHOPPING, FORM, ON_WEB_REGISTER) - bắt buộc với CONVERT / LEAD_WEBSITE"
    ),
  bid_type: z.enum(["max_delivery", "cost_cap"]).default("max_delivery"),
  bid_amount: money
    .optional()
    .describe("Cost cap (Target CPA) - chỉ khi ngân sách ngày"),
  budget_type: z
    .enum(["daily", "lifetime"])
    .optional()
    .describe("Chỉ khi chiến dịch không CBO"),
  budget: money.optional(),
  budget_auto_adjust_strategy: autoBudgetField,
  schedule_start_time: ttTime.optional().describe("UTC; mặc định ~15 phút nữa"),
  schedule_end_time: ttTime
    .optional()
    .describe("UTC; bắt buộc với ngân sách lifetime"),
  placement: z
    .enum(["automatic", "tiktok_only"])
    .optional()
    .describe(
      "Mặc định automatic; nhắn tin luôn tiktok_only; không đổi được sau khi tạo"
    ),
  targeting_mode: z
    .enum(["automatic", "automatic_suggestions", "manual"])
    .default("automatic"),
  location_ids: z
    .array(numericId("location_ids"))
    .min(1)
    .max(3000)
    .describe("VN = 1562822 (ads_lookup kind=locations)"),
  min_age: z
    .enum(["OVER_EIGHTEEN", "OVER_TWENTY_FIVE"])
    .optional()
    .describe("Chỉ chế độ automatic*"),
  languages: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, {
          error: "Mã ngôn ngữ không hợp lệ.",
        })
    )
    .max(50)
    .optional(),
  operating_systems: z
    .array(z.enum(["ANDROID", "IOS"]))
    .max(1)
    .optional(),
  excluded_audience_ids: z
    .array(numericId("excluded_audience_ids"))
    .max(100)
    .optional(),
  age_groups: z
    .array(
      z.enum(["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"])
    )
    .optional()
    .describe("Chỉ automatic_suggestions (gợi ý) / manual"),
  gender: z
    .enum(["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"])
    .optional(),
  audience_ids: z.array(numericId("audience_ids")).max(100).optional(),
  interest_category_ids: z
    .array(numericId("interest_category_ids"))
    .max(500)
    .optional(),
  interest_keyword_ids: z
    .array(numericId("interest_keyword_ids"))
    .max(500)
    .optional(),
  messaging: messagingSpec.optional(),
})

const creativeSpec = z.strictObject({
  identity_type: z
    .enum(["TT_USER", "BC_AUTH_TT", "AUTH_CODE"])
    .describe("Spark Ads (ads_lookup kind=identities)"),
  identity_id: assetId("identity_id"),
  identity_authorized_bc_id: numericId("identity_authorized_bc_id")
    .optional()
    .describe("Bắt buộc với BC_AUTH_TT"),
  tiktok_item_id: numericId("tiktok_item_id")
    .optional()
    .describe("Bài đăng có sẵn (Spark Pull) - không kèm video/ảnh/ad_texts"),
  ad_format: z
    .enum(["SINGLE_VIDEO", "CAROUSEL_ADS"])
    .optional()
    .describe(
      "tiktok_item_id: SINGLE_VIDEO (video, mặc định) hoặc CAROUSEL_ADS (bài ảnh)"
    ),
  video_id: assetId("video_id")
    .optional()
    .describe("Video tải lên (Spark Push) + cover_image_id"),
  cover_image_id: assetId("cover_image_id").optional(),
  image_ids: z
    .array(assetId("image_ids"))
    .min(1)
    .max(35)
    .optional()
    .describe("Carousel (Spark Push) + music_id"),
  music_id: assetId("music_id").optional().describe("Chỉ carousel tải lên (image_ids)"),
})

const adSpec = z.strictObject({
  name: safeText(512).optional().describe("Mặc định = tên nhóm"),
  creatives: z.array(creativeSpec).min(1).max(50),
  ad_texts: z
    .array(safeText(100))
    .min(1)
    .max(5)
    .optional()
    .describe(
      "1-5 nội dung; bắt buộc khi dùng video/ảnh tải lên, không dùng với tiktok_item_id"
    ),
  landing_page_url: httpUrl
    .optional()
    .describe("WEBSITE / LEAD_WEBSITE / IM_URL"),
  instant_page_id: numericId("instant_page_id")
    .optional()
    .describe(
      "LEAD_FORM: Instant Form (bắt buộc); LEAD_WEBSITE / ứng dụng nhắn tin + CLICK: Instant Page"
    ),
  auto_message_id: numericId("auto_message_id")
    .optional()
    .describe("TIKTOK_DM: lời chào (bắt buộc)"),
  call_to_action_id: numericId("call_to_action_id")
    .optional()
    .describe("CTA động có sẵn; bỏ trống = tự tạo từ gợi ý TikTok"),
})

export const smartPlusInput = z.object({
  campaign_id: numericId("campaign_id")
    .optional()
    .describe("Chiến dịch Upgraded Smart+ có sẵn (thay cho campaign)"),
  campaign: campaignSpec.optional(),
  adgroup_id: numericId("adgroup_id")
    .optional()
    .describe("Nhóm Upgraded Smart+ có sẵn: chỉ tạo quảng cáo"),
  adgroup: adGroupSpec.optional(),
  ad: adSpec.optional().describe("Bỏ trống = chỉ tạo chiến dịch / nhóm"),
})
export type SmartPlusInput = z.infer<typeof smartPlusInput>
type CampaignSpec = z.infer<typeof campaignSpec>
type AdGroupSpec = z.infer<typeof adGroupSpec>
type AdSpec = z.infer<typeof adSpec>

// ---------------------------------------------------------------------------
// Money (MCP caps) - every Smart+ daily budget is a flexible one (≤125%/day) [H + M]
// ---------------------------------------------------------------------------

const ttIso = (t: string | undefined) => (t ? `${t.replace(" ", "T")}Z` : null)

export function smartPlusMoney(input: SmartPlusInput): ExtensionMoneyItem[] {
  const items: ExtensionMoneyItem[] = []
  const g = input.adgroup
  const flight = {
    startTime: ttIso(g?.schedule_start_time),
    endTime: ttIso(g?.schedule_end_time),
  }
  const push = (type: string | undefined, amount: number, field: string) =>
    items.push(
      type === "lifetime"
        ? { kind: "lifetime_budget", amount, field, ...flight }
        : // CBO dynamic daily / ad group dynamic daily: ≤125%/day; non-CBO campaign daily limit counted the same way (conservative)
          { kind: "daily_budget", amount, field, dynamic: true }
    )
  if (input.campaign?.budget !== undefined)
    push(input.campaign.budget_type, input.campaign.budget, "campaign.budget")
  if (g?.budget !== undefined) push(g.budget_type, g.budget, "adgroup.budget")
  if (g?.bid_amount !== undefined)
    items.push({
      kind: "bid",
      amount: g.bid_amount,
      field: "adgroup.bid_amount",
    })
  return items
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ALLOWLIST_RE = /allow\s?list|white\s?list|not\s+(on|in)\s+the\s+allow/i

const SCOPE_HINTS: Record<string, string> = {
  campaign:
    "Developer app cần quyền Ads Management > Create and Update Campaigns - bật trong My Apps rồi cho advertiser cấp quyền lại.",
  adgroup:
    "Developer app cần quyền Ads Management > Ad Group > Create and Update Ad Groups - bật trong My Apps rồi cho advertiser cấp quyền lại.",
  ad: "Developer app cần quyền Ads Management > Ad > Create and Update Ads - bật trong My Apps rồi cho advertiser cấp quyền lại.",
  cta: "Developer app cần quyền Creative Management > Creative Recommendation > CTA Recommendation - bật trong My Apps rồi cho advertiser cấp quyền lại, hoặc truyền ad.call_to_action_id có sẵn.",
}

type Step = "campaign" | "adgroup" | "ad" | "cta"

/** Smart+ specific Vietnamese message for allowlist / scope errors (40118 [H]; other codes with an allowlist text [?]). */
export function smartPlusError(e: unknown, step: Step): unknown {
  if (!isProviderError(e)) return e
  const code = e.upstream?.code
  const msg = String(e.upstream?.message ?? "")
  if (
    step !== "cta" &&
    (code === 40118 ||
      e.code === "feature_not_enabled" ||
      ALLOWLIST_RE.test(msg))
  ) {
    return new ProviderError({
      platform: "tiktok",
      code: "feature_not_enabled",
      message: e.message,
      userMessageVi: ALLOWLIST_MESSAGE,
      hint: "Trong lúc chờ allowlist: dùng tiktok_create_campaign / tiktok_create_adgroup / tiktok_create_ads (chiến dịch thủ công, còn tạo được tới 31/12/2026).",
      upstream: e.upstream,
      cause: e,
    })
  }
  if (code === 40001 || code === 40125) {
    return new ProviderError({
      platform: "tiktok",
      code: e.code,
      message: e.message,
      userMessageVi: e.userMessageVi,
      hint: SCOPE_HINTS[step],
      upstream: e.upstream,
      cause: e,
    })
  }
  return e
}

interface Created {
  level: "campaign" | "ad_group" | "ad"
  id: string
  name: string
}

const LEVEL_VI: Record<Created["level"], string> = {
  campaign: "chiến dịch",
  ad_group: "nhóm quảng cáo",
  ad: "quảng cáo",
}

/** A failure after at least one object was created: ids (all paused) + how to continue without duplicates. */
function partialError(
  e: unknown,
  created: Created[],
  failed: Step,
  ctaId: string | null = null
): ProviderError {
  const pe = isProviderError(e) ? e : null
  const list = [
    ...created.map((c) => `${LEVEL_VI[c.level]} ${c.id}`),
    ...(ctaId ? [`CTA động (portfolio) ${ctaId}`] : []),
  ].join(", ")
  const camp = created.find((c) => c.level === "campaign")
  const group = created.find((c) => c.level === "ad_group")
  const next =
    failed === "adgroup" && camp
      ? `Sửa lỗi rồi gọi lại tiktok_create_smart_plus với campaign_id="${camp.id}" (bỏ campaign) để không tạo trùng chiến dịch.`
      : group
        ? `Sửa lỗi rồi gọi lại tiktok_create_smart_plus với adgroup_id="${group.id}" (chỉ ad) để không tạo trùng.`
        : "Kiểm tra trong TikTok Ads Manager trước khi thử lại."
  const reuseCta = ctaId ? ` Truyền ad.call_to_action_id="${ctaId}" để dùng lại CTA động vừa tạo.` : ""
  return new ProviderError({
    platform: "tiktok",
    code: pe?.code ?? "unknown",
    message: `Upgraded Smart+ create stopped at ${failed}: ${pe?.message ?? String(e)}`,
    userMessageVi: `Tạo Upgraded Smart+ dừng giữa chừng ở bước ${failed === "adgroup" ? "nhóm quảng cáo" : failed === "ad" ? "quảng cáo" : failed === "cta" ? "CTA động" : failed}: ${pe?.userMessageVi ?? "lỗi không rõ"} ĐÃ TẠO (đang TẮT, chưa chi tiền): ${list}.`,
    retryable: false,
    hint: `${next}${reuseCta} Hoặc xoá bản nháp bằng ads_delete_object.${pe?.hint ? ` ${pe.hint}` : ""}`,
    upstream: pe?.upstream,
    cause: e,
    audit: {
      errorCode: "smart_plus_partial_create",
      changes: [
        ...created.map((c): FieldChange => ({
          objectId: c.id,
          level: c.level,
          field: "created",
          before: null,
          after: "đã tạo (tạm dừng)",
        })),
        ...(ctaId ? [{ objectId: ctaId, field: "cta_portfolio", before: null, after: "CTA động (portfolio) mới" }] : []),
      ],
    },
  })
}

// ---------------------------------------------------------------------------
// Reads (existing parents, read-back, lookups after an unknown outcome)
// ---------------------------------------------------------------------------

const GET_PATH = {
  campaign: "smart_plus/campaign/get",
  adgroup: "smart_plus/adgroup/get",
  ad: "smart_plus/ad/get",
} as const
const ID_FILTER = {
  campaign: "campaign_ids",
  adgroup: "adgroup_ids",
  ad: "smart_plus_ad_ids",
} as const
const ID_KEY = {
  campaign: "campaign_id",
  adgroup: "adgroup_id",
  ad: "smart_plus_ad_id",
} as const
const NAME_KEY = {
  campaign: "campaign_name",
  adgroup: "adgroup_name",
  ad: "ad_name",
} as const
type SpLevel = keyof typeof GET_PATH

/** Smart+ gets report ENABLE / DISABLE (/ FROZEN) only: deletion shows in secondary_status *_DELETE / effective_status. */
export function isDeleted(o: Raw): boolean {
  const sec = str(o.secondary_status) ?? ""
  return str(o.operation_status) === "DELETE" || /(^|_)DELETE$/.test(sec) || str(o.effective_status) === "DELETED"
}

async function getSmartPlus(
  tt: TT,
  level: SpLevel,
  id: string
): Promise<Raw | null> {
  const res = await ttGet<{ list?: Raw[] }>(tt, GET_PATH[level], {
    advertiser_id: tt.advertiserId,
    filtering: { [ID_FILTER[level]]: [id] },
    page: 1,
    page_size: 10,
  })
  return (res.data.list ?? []).find((o) => str(o[ID_KEY[level]]) === id) ?? null
}

async function countChildren(
  tt: TT,
  level: "adgroup" | "ad",
  parentKey: "campaign_ids" | "adgroup_ids",
  parentId: string
): Promise<number> {
  const res = await ttGet<{
    list?: Raw[]
    page_info?: { total_number?: number }
  }>(tt, GET_PATH[level], {
    advertiser_id: tt.advertiserId,
    filtering: { [parentKey]: [parentId] },
    page: 1,
    page_size: 1,
  })
  const n = Number(res.data.page_info?.total_number)
  return Number.isFinite(n) ? n : (res.data.list ?? []).length
}

/** Objects named `name` created at/after `sinceMs` (newest first) - lookup after an uncertain create. */
async function findCreated(
  tt: TT,
  level: SpLevel,
  name: string,
  parent: Raw,
  sinceMs: number
): Promise<string[]> {
  const res = await ttGet<{ list?: Raw[] }>(tt, GET_PATH[level], {
    advertiser_id: tt.advertiserId,
    // /smart_plus/adgroup/get/ has no creation_filter_start_time (doc 1843314879617026) → create_time filtered below
    filtering:
      level === "adgroup"
        ? parent
        : { ...parent, creation_filter_start_time: formatTikTokTime(new Date(sinceMs)) },
    page: 1,
    page_size: 100,
  })
  return (res.data.list ?? [])
    .map((o) => ({
      id: str(o[ID_KEY[level]]),
      name: str(o[NAME_KEY[level]]),
      t: parseTikTokTime(o.create_time)?.getTime() ?? null,
    }))
    .filter(
      (o): o is { id: string; name: string | null; t: number } =>
        !!o.id && o.name === name && o.t !== null && o.t >= sinceMs
    )
    .sort((a, b) => b.t - a.t)
    .map((o) => o.id)
}

/**
 * POST one Smart+ create. Campaign / ad group (request_id): retried only on throttle codes (client `create`); ad: never
 * retried. Unknown outcome (timeout / 5xx / 40050) → looked up by name + creation time; not found → non-retryable error.
 */
async function createOne(
  tt: TT,
  level: SpLevel,
  body: Raw,
  name: string,
  parent: Raw,
  warnings: string[],
  now: () => number
): Promise<string> {
  const started = now()
  const label = LEVEL_VI[level === "adgroup" ? "ad_group" : level]
  try {
    const res = await ttPost<Raw>(
      tt,
      `smart_plus/${level}/create`,
      body,
      level === "ad" ? { retries: 0 } : { create: true }
    )
    const id =
      str(res.data[ID_KEY[level]]) ??
      (level === "ad" ? str(res.data.ad_id) : null)
    if (!id) throw invalid(`TikTok không trả về id ${label} Upgraded Smart+.`)
    return id
  } catch (e) {
    if (!isUncertainCreateError(e)) throw smartPlusError(e, level)
    let found: string[] = []
    try {
      found = await findCreated(
        tt,
        level,
        name,
        parent,
        started - LOOKUP_SKEW_MS
      )
    } catch {
      found = []
    }
    if (found.length === 0) {
      const pe = isProviderError(e) ? e : null
      throw new ProviderError({
        platform: "tiktok",
        code: pe?.code ?? "upstream_error",
        message: `TikTok Smart+ ${level} create outcome unknown: ${pe?.message ?? String(e)}`,
        userMessageVi: `TikTok không phản hồi rõ khi tạo ${label} Upgraded Smart+ (${pe?.userMessageVi ?? "lỗi mạng"}). Chưa thấy ${label} mới cùng tên.`,
        retryable: false,
        hint: `Có thể ${label} "${name.slice(0, 80)}" đã được tạo (đang TẮT) - kiểm tra bằng ads_list_objects hoặc TikTok Ads Manager trước khi thử lại để tránh tạo trùng.`,
        upstream: pe?.upstream,
        cause: e,
      })
    }
    warnings.push(
      found.length === 1
        ? `TikTok phản hồi lỗi/timeout nhưng ${label} đã được tạo (id ${found[0]}) - dùng id tìm thấy, không tạo lại.`
        : `TikTok phản hồi lỗi/timeout; tìm thấy ${found.length} ${label} mới cùng tên (id ${found.join(", ")}) - dùng id mới nhất ${found[0]}; xoá bản thừa (đang TẮT).`
    )
    return found[0]!
  }
}

/** Read back a created object; anything but DISABLE is switched off at once (red warning). Never throws. */
async function readBack(
  tt: TT,
  level: SpLevel,
  id: string,
  warnings: string[]
): Promise<Raw> {
  const label = LEVEL_VI[level === "adgroup" ? "ad_group" : level]
  let o: Raw | null = null
  for (let i = 0; i <= READBACK_RETRIES && !o; i++) {
    try {
      o = await getSmartPlus(tt, level, id)
    } catch {
      o = null
    }
  }
  if (!o) {
    warnings.push(
      `Chưa đọc lại được ${label} ${id} (TikTok có thể hiển thị trễ) - kiểm tra trạng thái TẮT bằng ads_get_object.`
    )
    return { id }
  }
  const op = str(o.operation_status)
  if (op && op !== "DISABLE") {
    try {
      await ttPost(
        tt,
        `smart_plus/${level}/status/update`,
        {
          advertiser_id: tt.advertiserId,
          [ID_FILTER[level]]: [id],
          operation_status: "DISABLE",
        },
        { retries: 2 }
      )
      warnings.push(
        `CẢNH BÁO: ${label} ${id} được TikTok tạo ở trạng thái ${op.slice(0, 20)} - đã tắt lại ngay (DISABLE). Kiểm tra lại bằng ads_get_object.`
      )
      o = { ...o, operation_status: "DISABLE" }
    } catch {
      warnings.push(
        `CẢNH BÁO NGHIÊM TRỌNG: ${label} ${id} đang ở trạng thái ${op.slice(0, 20)} và chưa tắt lại được - tắt ngay bằng ads_set_status status=paused.`
      )
    }
  }
  return o
}

/** Sanitized summary of a created object (platform data is untrusted). */
function summaryOf(level: SpLevel, id: string, o: Raw) {
  return {
    id,
    name: sanitizeExternalLabel(str(o[NAME_KEY[level]]), 120),
    operation_status: sanitizeExternalLabel(str(o.operation_status), 20),
    secondary_status: sanitizeExternalLabel(str(o.secondary_status), 60),
  }
}

// ---------------------------------------------------------------------------
// Body builders (pure)
// ---------------------------------------------------------------------------

const CAMPAIGN_BUDGET_MODE = {
  cbo: {
    daily: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
    lifetime: "BUDGET_MODE_TOTAL",
  },
  noCbo: {
    daily: "BUDGET_MODE_DAY",
    lifetime: "BUDGET_MODE_TOTAL",
    unlimited: "BUDGET_MODE_INFINITE",
  },
} as const

function refuseAutoBudget(v: string | undefined, where: string): void {
  if (v === undefined || v === "" || v === "UNSET") return
  throw invalid(
    `${where}: không hỗ trợ budget_auto_adjust_strategy=${v.slice(0, 40)} (Goal-based budget increase tự tăng ngân sách tới 10 lần/ngày - vượt kiểm soát trần chi của MCP).`,
    "Bỏ trường này; muốn tăng ngân sách hãy dùng ads_update_budget."
  )
}

export function buildCampaignBody(
  tt: TT,
  c: CampaignSpec,
  goal: SmartPlusGoal,
  requestId: string
): Raw {
  refuseAutoBudget(c.budget_auto_adjust_strategy, "campaign")
  const objective = objectiveOf(goal)
  if (c.objective && c.objective !== objective) {
    throw invalid(
      `campaign.objective ${c.objective} không khớp adgroup.goal ${goal} (cần ${objective}).`,
      "Bỏ campaign.objective - công cụ tự suy ra."
    )
  }
  if (c.cbo && c.budget_type === "unlimited")
    throw invalid(
      "Chiến dịch CBO cần budget_type daily hoặc lifetime (unlimited chỉ khi cbo=false)."
    )
  if (c.budget_type !== "unlimited" && c.budget === undefined)
    throw invalid("Thiếu campaign.budget.")
  if (c.budget_type === "unlimited" && c.budget !== undefined)
    throw invalid(
      "budget_type unlimited không nhận campaign.budget (đặt ngân sách ở nhóm)."
    )
  const mode = c.cbo
    ? CAMPAIGN_BUDGET_MODE.cbo[c.budget_type as "daily" | "lifetime"]
    : CAMPAIGN_BUDGET_MODE.noCbo[c.budget_type]
  const body: Raw = {
    advertiser_id: tt.advertiserId,
    request_id: requestId,
    campaign_name: c.name,
    objective_type: objective,
    operation_status: "DISABLE",
    budget_optimize_on: c.cbo,
    budget_mode: mode,
    // locked: no Search Ads / catalog / iOS 14 dedicated campaign in this tool
    is_search_campaign: false,
    catalog_enabled: false,
    campaign_type: "REGULAR_CAMPAIGN",
  }
  if (objective === "WEB_CONVERSIONS") body.sales_destination = "WEBSITE"
  if (c.budget !== undefined) body.budget = apiMoney(c.budget, tt.currency)
  return body
}

/** What the ad group builder needs to know about its campaign (new or existing). */
export interface CampaignInfo {
  cbo: boolean
  /** BUDGET_MODE_* of the campaign */
  budgetMode: string
  objective: string
}

function messagingFields(
  g: AdGroupSpec,
  goal: SmartPlusGoal,
  optGoal: string,
  warnings: string[]
): Raw {
  const m = g.messaging ?? {}
  const present = (Object.keys(m) as (keyof typeof m)[]).filter(
    (k) => m[k] !== undefined
  )
  const allowed: Record<string, (keyof typeof m)[]> = {
    MESSENGER: ["facebook_page_id", "message_event_set_id"],
    WHATSAPP: [
      "phone_region_code",
      "phone_region_calling_code",
      "phone_number",
      "message_event_set_id",
    ],
    ZALO:
      optGoal === "CLICK"
        ? ["phone_region_code", "phone_region_calling_code", "phone_number"]
        : ["zalo_oa_id", "message_event_set_id"],
    LINE: ["line_business_id"],
    IM_URL: [],
  }
  if (!IM_GOALS.has(goal)) {
    if (present.length)
      throw invalid(
        `adgroup.messaging chỉ dùng cho goal MESSENGER / WHATSAPP / ZALO / LINE (đang là ${goal}).`
      )
    return {}
  }
  const extra = present.filter((k) => !allowed[goal]!.includes(k))
  if (extra.length) {
    const why =
      goal === "ZALO"
        ? optGoal === "CLICK"
          ? " (Zalo + CLICK chỉ nhận số điện thoại Zalo)"
          : " (Zalo + CONVERSATION chỉ nhận Zalo Official Account)"
        : ""
    throw invalid(`${GOAL_VI[goal]} không dùng ${extra.join(", ")}${why}.`)
  }
  if (m.message_event_set_id !== undefined && optGoal !== "CONVERSATION") {
    throw invalid(
      "message_event_set_id chỉ dùng với optimization_goal CONVERSATION."
    )
  }
  const out: Raw = { messaging_app_type: goal }
  if (goal === "MESSENGER") {
    if (!m.facebook_page_id)
      throw invalid(
        "Messenger cần messaging.facebook_page_id (ID Trang Facebook, chỉ chữ số)."
      )
    out.messaging_app_account_id = m.facebook_page_id
  } else if (goal === "LINE") {
    if (!m.line_business_id)
      throw invalid("LINE cần messaging.line_business_id.")
    out.messaging_app_account_id = m.line_business_id
  } else if (goal === "WHATSAPP" || (goal === "ZALO" && optGoal === "CLICK")) {
    const dest: MessagingDestination = goal
    // Smart+ sends the phone as an object phone_info{…} (manual: 3 flat fields) [H 1843314887930946]
    out.phone_info = phoneFields({ destination: dest, ...m }, dest, warnings)
    if (goal === "ZALO") out.zalo_id_type = "ZALO_PHONE_ACCOUNT"
  } else if (goal === "ZALO") {
    if (!m.zalo_oa_id)
      throw invalid(
        "Zalo + CONVERSATION cần messaging.zalo_oa_id (Zalo Official Account ID).",
        "Hoặc dùng optimization_goal CLICK với số điện thoại Zalo."
      )
    out.zalo_id_type = "ZALO_OFFICIAL_ACCOUNT"
    out.messaging_app_account_id = m.zalo_oa_id
  }
  if (m.message_event_set_id !== undefined)
    out.message_event_set_id = m.message_event_set_id
  return out
}

/** Effective optimization_goal of an ad group spec (validated against the destination). */
export function optimizationGoalOf(g: AdGroupSpec): string {
  const t = GOAL_OPTIMIZATION[g.goal]
  const opt = g.optimization_goal ?? t.fallback
  if (!opt)
    throw invalid(
      `goal ${g.goal} cần optimization_goal (${t.allowed.join(" | ")}).`
    )
  if (!t.allowed.includes(opt))
    throw invalid(
      `goal ${g.goal} chỉ nhận optimization_goal ${t.allowed.join(" | ")}, không phải ${opt}.`
    )
  return opt
}

export function buildAdGroupBody(
  tt: TT,
  g: AdGroupSpec,
  campaign: CampaignInfo,
  campaignId: string,
  requestId: string,
  now: Date,
  warnings: string[]
): Raw {
  refuseAutoBudget(g.budget_auto_adjust_strategy, "adgroup")
  const goal = g.goal
  const objective = objectiveOf(goal)
  if (campaign.objective && campaign.objective !== objective) {
    throw invalid(
      `Chiến dịch mục tiêu ${campaign.objective} không nhận nhóm goal ${goal} (cần chiến dịch ${objective}).`
    )
  }
  const opt = optimizationGoalOf(g)
  const messaging = goal === "TIKTOK_DM" || IM_GOALS.has(goal)

  // pixel / event [H guides]
  const pixelGoal =
    (goal === "WEBSITE" && opt === "CONVERT") || goal === "LEAD_WEBSITE"
  if (pixelGoal && (!g.pixel_id || !g.optimization_event)) {
    throw invalid(
      `${GOAL_VI[goal]} với ${opt} cần pixel_id và optimization_event.`,
      "Tra pixel bằng ads_lookup kind=pixels."
    )
  }
  if (!pixelGoal && g.pixel_id)
    throw invalid(`pixel_id không dùng với ${GOAL_VI[goal]} / ${opt}.`)
  if (!pixelGoal && g.optimization_event) {
    const okEvent =
      messaging && opt === "CONVERSATION" && g.optimization_event === "MESSAGE"
    const lpv =
      goal === "WEBSITE" &&
      opt === "TRAFFIC_LANDING_PAGE_VIEW" &&
      g.optimization_event === "LANDING_PAGE_VIEW"
    if (!okEvent && !lpv)
      throw invalid(
        `optimization_event không dùng với ${GOAL_VI[goal]} / ${opt}.`
      )
  }

  // budget: CBO → none at ad group level; non-CBO → BUDGET_MODE_TOTAL | BUDGET_MODE_DYNAMIC_DAILY_BUDGET [H]
  let groupMode: string | null = null
  if (campaign.cbo) {
    if (g.budget !== undefined || g.budget_type)
      throw invalid(
        "Chiến dịch dùng CBO (ngân sách chiến dịch) nên không đặt ngân sách nhóm - bỏ adgroup.budget / budget_type."
      )
  } else {
    if (!g.budget_type || g.budget === undefined)
      throw invalid(
        "Chiến dịch không CBO: nhóm cần budget_type (daily | lifetime) và budget."
      )
    if (
      campaign.budgetMode === "BUDGET_MODE_DAY" &&
      g.budget_type === "lifetime"
    ) {
      throw invalid(
        "Chiến dịch đặt giới hạn ngân sách ngày nên nhóm chỉ dùng budget_type daily."
      )
    }
    groupMode =
      g.budget_type === "lifetime"
        ? "BUDGET_MODE_TOTAL"
        : "BUDGET_MODE_DYNAMIC_DAILY_BUDGET"
  }
  const effectiveMode = campaign.cbo ? campaign.budgetMode : groupMode
  const daily = effectiveMode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET"

  // bid [H]: cost cap only with a daily budget; CLICK → bid_price, others → conversion_bid_price
  if (g.bid_type === "cost_cap") {
    if (g.bid_amount === undefined)
      throw invalid("bid_type cost_cap cần bid_amount (Target CPA).")
    if (!daily)
      throw invalid(
        "Cost cap (Target CPA) chỉ dùng khi ngân sách là ngân sách ngày (chiến dịch CBO daily hoặc nhóm daily)."
      )
  } else if (g.bid_amount !== undefined) {
    throw invalid("bid_amount chỉ dùng với bid_type cost_cap.")
  }

  // schedule (UTC) [H]
  const minStart = now.getTime() - 12 * 3_600_000
  const start = g.schedule_start_time
    ? parseTikTokTime(g.schedule_start_time)!
    : new Date(Math.ceil((now.getTime() + 15 * 60_000) / 60_000) * 60_000)
  if (start.getTime() < minStart)
    throw invalid("schedule_start_time không được sớm hơn hiện tại quá 12 giờ.")
  if (start.getTime() >= Date.parse("2028-01-01T00:00:00Z"))
    throw invalid("schedule_start_time phải trước 2028-01-01.")
  const end = g.schedule_end_time ? parseTikTokTime(g.schedule_end_time)! : null
  if (end && end.getTime() <= start.getTime())
    throw invalid("schedule_end_time phải sau schedule_start_time.")
  if (!end && !daily)
    throw invalid(
      "Ngân sách trọn đời (lifetime) cần schedule_end_time; chạy liên tục chỉ dùng với ngân sách ngày."
    )

  // targeting [H 1847839827327106]: fields outside the mode are silently ignored by TikTok → refused here
  const mode = g.targeting_mode
  const suggestionKeys = [
    "age_groups",
    "gender",
    "audience_ids",
    "interest_category_ids",
    "interest_keyword_ids",
  ] as const
  const used = suggestionKeys.filter((k) => g[k] !== undefined)
  if (mode === "automatic" && used.length) {
    throw invalid(
      `targeting_mode automatic không nhận ${used.join(", ")} (TikTok sẽ âm thầm bỏ qua).`,
      "Dùng targeting_mode automatic_suggestions (chỉ là gợi ý) hoặc manual (nhắm cứng)."
    )
  }
  if (mode === "manual" && g.min_age)
    throw invalid(
      "min_age chỉ dùng cho targeting_mode automatic*; chế độ manual dùng age_groups."
    )
  // languages / operating_systems / excluded_audience_ids: audience controls of every mode (doc 1843314887930946)
  const spec: Raw = { location_ids: g.location_ids }
  if (mode !== "manual") spec.spc_audience_age = g.min_age ?? "OVER_EIGHTEEN"
  for (const k of [
    "languages",
    "operating_systems",
    "excluded_audience_ids",
    ...suggestionKeys,
  ] as const) {
    if (g[k] !== undefined) spec[k] = g[k]
  }

  const body: Raw = {
    advertiser_id: tt.advertiserId,
    campaign_id: campaignId,
    request_id: requestId,
    adgroup_name: g.name,
    operation_status: "DISABLE",
    ...promotionOf(goal),
    optimization_goal: opt,
    billing_event: opt === "CLICK" ? "CPC" : "OCPM",
    bid_type: g.bid_type === "cost_cap" ? "BID_TYPE_CUSTOM" : "BID_TYPE_NO_BID",
    schedule_type: end ? "SCHEDULE_START_END" : "SCHEDULE_FROM_NOW",
    schedule_start_time: formatTikTokTime(start),
    targeting_optimization_mode: mode === "manual" ? "MANUAL" : "AUTOMATIC",
    targeting_spec: spec,
  }
  if (mode === "automatic_suggestions") body.suggestion_audience_enabled = true
  else if (mode === "automatic") body.suggestion_audience_enabled = false
  if (end) body.schedule_end_time = formatTikTokTime(end)
  if (g.pixel_id) body.pixel_id = g.pixel_id
  if (g.optimization_event) body.optimization_event = g.optimization_event
  if (g.bid_type === "cost_cap")
    body[opt === "CLICK" ? "bid_price" : "conversion_bid_price"] = apiMoney(
      g.bid_amount!,
      tt.currency
    )
  if (groupMode) {
    body.budget_mode = groupMode
    body.budget = apiMoney(g.budget!, tt.currency)
  }

  // placement [H]: messaging → TikTok only (NORMAL); automatic → fields omitted (TikTok decides); immutable
  if (messaging) {
    if (g.placement === "automatic")
      throw invalid(
        "Quảng cáo nhắn tin Smart+ chỉ chạy ở vị trí TikTok - dùng placement tiktok_only hoặc bỏ trống."
      )
    body.placement_type = "PLACEMENT_TYPE_NORMAL"
    body.placements = ["PLACEMENT_TIKTOK"]
  } else if (g.placement === "tiktok_only") {
    body.placement_type = "PLACEMENT_TYPE_NORMAL"
    body.placements = ["PLACEMENT_TIKTOK"]
  }
  Object.assign(body, messagingFields(g, goal, opt, warnings))
  if (messaging && opt === "CONVERSATION") {
    warnings.push(
      "optimization_goal CONVERSATION có thể cần TikTok allowlist (tài liệu Smart+ không nói rõ) - nếu bị từ chối, dùng CLICK. [?]"
    )
  }
  if (messaging)
    warnings.push(
      "Nhóm nhắn tin: ứng dụng, tài khoản / số điện thoại và vị trí không sửa được sau khi tạo."
    )
  return body
}

/** Ad body; `ctaId` = dynamic CTA portfolio id (placeholder in previews). */
export function buildAdBody(
  tt: TT,
  a: AdSpec,
  goal: SmartPlusGoal,
  optGoal: string,
  adgroupId: string,
  defaultName: string,
  ctaId: string | null
): Raw {
  const where = "ad"
  const pull = a.creatives.filter((c) => c.tiktok_item_id !== undefined)
  if (pull.length && pull.length !== a.creatives.length) {
    throw invalid(
      `${where}: không trộn bài đăng có sẵn (tiktok_item_id) với video/ảnh tải lên trong cùng 1 quảng cáo.`,
      "Tách thành 2 quảng cáo. [?]"
    )
  }
  const isPull = pull.length > 0
  const creative_list = a.creatives.map((c, i) => {
    const w = `ad.creatives[${i}]`
    if (c.identity_type === "BC_AUTH_TT" && !c.identity_authorized_bc_id)
      throw invalid(`${w}: BC_AUTH_TT cần identity_authorized_bc_id.`)
    if (c.identity_type !== "BC_AUTH_TT" && c.identity_authorized_bc_id)
      throw invalid(`${w}: identity_authorized_bc_id chỉ dùng với BC_AUTH_TT.`)
    const info: Raw = {
      identity_type: c.identity_type,
      identity_id: c.identity_id,
    }
    if (c.identity_authorized_bc_id)
      info.identity_authorized_bc_id = c.identity_authorized_bc_id
    if (c.tiktok_item_id) {
      if (c.video_id || c.cover_image_id || c.image_ids)
        throw invalid(
          `${w}: tiktok_item_id không kèm video_id / cover_image_id / image_ids.`
        )
      info.ad_format = c.ad_format ?? "SINGLE_VIDEO"
      info.tiktok_item_id = c.tiktok_item_id
      // Spark Pull: no music_info (creative combinations doc 1847839781968897; the ad create doc says "required" for a
      // Pull photo post - conflict [?]) → the post keeps its own sound
      if (c.music_id)
        throw invalid(`${w}: bài đăng có sẵn (tiktok_item_id) dùng nhạc của bài - bỏ music_id.`)
    } else {
      if (c.identity_type === "AUTH_CODE")
        throw invalid(
          `${w}: AUTH_CODE chỉ dùng với bài đăng có sẵn (tiktok_item_id).`
        )
      if (c.video_id) {
        if (c.image_ids || c.music_id)
          throw invalid(
            `${w}: video (video_id) không kèm image_ids / music_id.`
          )
        if (!c.cover_image_id)
          throw invalid(
            `${w}: video tải lên cần cover_image_id (ảnh bìa).`,
            "Tải ảnh bìa bằng ads_upload_media."
          )
        if (c.ad_format && c.ad_format !== "SINGLE_VIDEO")
          throw invalid(`${w}: video dùng ad_format SINGLE_VIDEO.`)
        info.ad_format = "SINGLE_VIDEO"
        info.video_info = { video_id: c.video_id }
        info.image_info = [{ web_uri: c.cover_image_id }]
      } else if (c.image_ids) {
        if (c.cover_image_id)
          throw invalid(`${w}: cover_image_id chỉ dùng cho video.`)
        if (!c.music_id)
          throw invalid(`${w}: carousel (image_ids) cần music_id.`)
        if (c.ad_format && c.ad_format !== "CAROUSEL_ADS")
          throw invalid(`${w}: ảnh dùng ad_format CAROUSEL_ADS.`)
        info.ad_format = "CAROUSEL_ADS"
        info.image_info = c.image_ids.map((id) => ({ web_uri: id }))
        info.music_info = { music_id: c.music_id }
      } else {
        throw invalid(
          `${w}: cần tiktok_item_id, hoặc video_id + cover_image_id, hoặc image_ids + music_id.`
        )
      }
    }
    return { creative_info: info }
  })
  if (isPull && a.ad_texts)
    throw invalid(
      "ad_texts không dùng với bài đăng có sẵn (tiktok_item_id) - nội dung lấy từ bài đăng."
    )
  if (!isPull && !a.ad_texts)
    throw invalid("Video/ảnh tải lên cần ad_texts (1-5 nội dung).")

  const body: Raw = {
    advertiser_id: tt.advertiserId,
    adgroup_id: adgroupId,
    ad_name: a.name ?? defaultName,
    operation_status: "DISABLE",
    creative_list,
  }
  if (a.ad_texts) body.ad_text_list = a.ad_texts.map((t) => ({ ad_text: t }))

  // destination [H guides]
  const refuse = (keys: (keyof AdSpec)[], why: string) => {
    const bad = keys.filter((k) => a[k] !== undefined)
    if (bad.length) throw invalid(`${why} không dùng ${bad.join(", ")}.`)
  }
  if (goal !== "TIKTOK_DM")
    refuse(
      ["auto_message_id"],
      `${GOAL_VI[goal]} (auto_message_id chỉ cho Tin nhắn TikTok)`
    )
  if (goal === "WEBSITE") {
    refuse(["instant_page_id"], "Website")
    if (!a.landing_page_url) throw invalid("Website cần ad.landing_page_url.")
  } else if (goal === "LEAD_FORM") {
    refuse(["landing_page_url"], "Instant Form")
    if (!a.instant_page_id)
      throw invalid(
        "LEAD_FORM cần ad.instant_page_id (Instant Form - tiktok_messaging_assets kind=instant_pages)."
      )
  } else if (goal === "LEAD_WEBSITE") {
    if (!!a.landing_page_url === !!a.instant_page_id)
      throw invalid(
        "LEAD_WEBSITE cần đúng 1 trong 2: ad.landing_page_url hoặc ad.instant_page_id."
      )
  } else if (goal === "TIKTOK_DM") {
    refuse(
      ["landing_page_url", "instant_page_id", "call_to_action_id"],
      "Tin nhắn TikTok"
    )
    if (!a.auto_message_id) {
      throw invalid(
        "Tin nhắn TikTok cần ad.auto_message_id (đúng 1 lời chào).",
        "Tra bằng tiktok_messaging_assets kind=welcome_messages hoặc tạo bằng tiktok_create_welcome_message."
      )
    }
    const notDm = a.creatives.filter(
      (c) => c.identity_type !== "TT_USER" && c.identity_type !== "BC_AUTH_TT"
    )
    if (notDm.length)
      throw invalid(
        "Tin nhắn TikTok chỉ dùng identity TT_USER hoặc BC_AUTH_TT có can_manage_message.",
        "Tra bằng tiktok_messaging_assets kind=dm_identities."
      )
  } else {
    // instant messaging apps [H 1847302988449921]
    if (a.instant_page_id && optGoal !== "CLICK")
      throw invalid(
        "instant_page_id (Instant Page) chỉ dùng khi nhóm tối ưu CLICK."
      )
    if (goal === "IM_URL") {
      if (!!a.landing_page_url === !!a.instant_page_id)
        throw invalid(
          "IM_URL cần đúng 1 trong 2: ad.landing_page_url (link http/https của ứng dụng nhắn tin) hoặc ad.instant_page_id."
        )
    } else {
      refuse(
        ["landing_page_url"],
        `${GOAL_VI[goal]} (TikTok tự tạo link tới ứng dụng từ cấu hình nhóm)`
      )
    }
  }
  if (a.landing_page_url)
    body.landing_page_url_list = [{ landing_page_url: a.landing_page_url }]
  if (a.instant_page_id) body.page_list = [{ page_id: a.instant_page_id }]

  // CTA [H guides]: DM → static SEND_MESSAGE; every other destination (Spark identity) → dynamic CTA portfolio
  const config: Raw = {}
  if (goal === "TIKTOK_DM") {
    body.call_to_action_list = [{ call_to_action: "SEND_MESSAGE" }]
    body.auto_message_list = [{ auto_message_id: a.auto_message_id }]
  } else {
    config.call_to_action_id =
      a.call_to_action_id ?? ctaId ?? "(tạo khi xác nhận)"
  }
  // no automatic creative additions / edits outside the user's control [M]; auto-add is valid only for these
  // destinations [H 1843317390059522]; [] for the enhancements is assumed accepted everywhere [?]
  if (
    goal === "WEBSITE" ||
    goal === "LEAD_FORM" ||
    goal === "LEAD_WEBSITE" ||
    goal === "MESSENGER" ||
    goal === "WHATSAPP"
  ) {
    config.creative_auto_add_toggle = false
  }
  config.creative_auto_enhancement_strategy_list = []
  body.ad_configuration = config
  return body
}

// ---------------------------------------------------------------------------
// Dynamic CTA (/creative/cta/recommend/ new_version → /creative/portfolio/create/) [H 1740307296329730]
// ---------------------------------------------------------------------------

async function createDynamicCta(
  tt: TT,
  goal: SmartPlusGoal,
  optGoal: string,
  warnings: string[]
): Promise<string> {
  const base: Raw = {
    advertiser_id: tt.advertiserId,
    new_version: true,
    objective_type: objectiveOf(goal),
    promotion_type: promotionOf(goal).promotion_type,
    optimization_goal: optGoal,
  }
  let groups: { asset_ids?: unknown; asset_content?: unknown }[] = []
  try {
    // language "vi" for Vietnamese CTA texts [?]: refused → TikTok default (en)
    try {
      groups =
        (
          await ttGet<{ recommend_assets?: typeof groups }>(
            tt,
            "creative/cta/recommend",
            { ...base, language: "vi" }
          )
        ).data.recommend_assets ?? []
    } catch (e) {
      if (!isProviderError(e) || e.code !== "invalid_request") throw e
      groups =
        (
          await ttGet<{ recommend_assets?: typeof groups }>(
            tt,
            "creative/cta/recommend",
            base
          )
        ).data.recommend_assets ?? []
      warnings.push(
        "TikTok không nhận ngôn ngữ CTA tiếng Việt - CTA động dùng ngôn ngữ mặc định của TikTok."
      )
    }
  } catch (e) {
    throw smartPlusError(e, "cta")
  }
  const content = groups
    .map((g) => ({
      asset_content:
        typeof g.asset_content === "string" ? g.asset_content : null,
      asset_ids: Array.isArray(g.asset_ids)
        ? g.asset_ids.map(String).filter((s) => /^\d{1,30}$/.test(s))
        : [],
    }))
    .filter(
      (g): g is { asset_content: string; asset_ids: string[] } =>
        !!g.asset_content && g.asset_ids.length > 0
    )
    .slice(0, CTA_GROUPS)
  if (!content.length) {
    throw invalid(
      "TikTok không trả về CTA gợi ý để tạo CTA động.",
      "Truyền ad.call_to_action_id (CTA động có sẵn trong tài khoản) rồi thử lại."
    )
  }
  let id: string | null
  try {
    // no request_id on /creative/portfolio/create/ → never retried (a duplicate portfolio is harmless)
    const res = await ttPost<{ creative_portfolio_id?: unknown }>(
      tt,
      "creative/portfolio/create",
      {
        advertiser_id: tt.advertiserId,
        creative_portfolio_type: "CTA",
        portfolio_content: content,
      },
      { retries: 0 }
    )
    id = str(res.data.creative_portfolio_id)
  } catch (e) {
    throw smartPlusError(e, "cta")
  }
  if (!id)
    throw invalid("TikTok không trả về creative_portfolio_id của CTA động.")
  const labels = content
    .map((c) => sanitizeExternalLabel(c.asset_content, 40))
    .filter(Boolean)
  warnings.push(
    `Đã tạo CTA động (portfolio ${id}) từ gợi ý của TikTok: ${labels.join(", ")}.`
  )
  return id
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function summaryChange(
  id: string,
  level: FieldChange["level"],
  field: string,
  after: unknown
): FieldChange {
  return { objectId: id, level, field, before: null, after }
}

function stripPrivate(body: Raw): Raw {
  const out = { ...body }
  delete out.advertiser_id
  delete out.request_id
  return out
}

export type SmartPlusResult = MutationResult & { payload?: Raw }

export async function runCreateSmartPlus(
  ctx: ProviderContext<TikTokCredentials>,
  input: SmartPlusInput,
  opts: MutationOptions & { now?: Date }
): Promise<SmartPlusResult> {
  const tt = ttFromCtx(ctx)
  const now = opts.now ?? new Date()
  const clock = () => Date.now()
  const warnings: string[] = [
    "Upgraded Smart+ chỉ tạo được khi tài khoản đã được TikTok allowlist (chưa có → TikTok từ chối, chưa tạo gì).",
    "Mọi cấp được tạo ở trạng thái TẮT (DISABLE); bật chạy bằng ads_set_status. Lịch tính theo UTC.",
    SMART_PLUS_CUTOFF_NOTE,
  ]

  // ---- mode
  if (input.adgroup_id) {
    if (input.campaign || input.campaign_id || input.adgroup) {
      throw invalid(
        "Khi có adgroup_id chỉ tạo quảng cáo: bỏ campaign / campaign_id / adgroup."
      )
    }
    if (!input.ad) throw invalid("adgroup_id cần ad (quảng cáo cần tạo).")
  } else {
    if (!input.adgroup)
      throw invalid(
        "Cần adgroup (hoặc adgroup_id có sẵn để chỉ tạo quảng cáo)."
      )
    if (!!input.campaign === !!input.campaign_id)
      throw invalid(
        "Cần đúng 1 trong 2: campaign (tạo mới) hoặc campaign_id (chiến dịch Upgraded Smart+ có sẵn)."
      )
  }

  // ---- existing parents
  let campaignInfo: CampaignInfo | null = null
  let goal: SmartPlusGoal
  let optGoal: string
  let groupName: string
  if (input.adgroup_id) {
    const g = await getSmartPlus(tt, "adgroup", input.adgroup_id)
    if (!g || isDeleted(g)) {
      throw invalid(
        `Không tìm thấy nhóm quảng cáo Upgraded Smart+ ${input.adgroup_id} (nhóm thủ công dùng tiktok_create_ads).`
      )
    }
    const derived = goalOfAdGroup(g)
    if (!derived)
      throw invalid(
        "Nhóm này có đích tối ưu ngoài phạm vi công cụ (ứng dụng, catalog, gọi điện, đa đích…) - tạo quảng cáo trong TikTok Ads Manager."
      )
    goal = derived
    optGoal =
      str(g.optimization_goal) ?? GOAL_OPTIMIZATION[goal].fallback ?? "CLICK"
    groupName = str(g.adgroup_name) ?? "Smart+"
    const ads = await countChildren(tt, "ad", "adgroup_ids", input.adgroup_id)
    if (ads + 1 > MAX_ADS_PER_ADGROUP)
      throw invalid(
        `Nhóm đã có ${ads} quảng cáo; TikTok cho tối đa ${MAX_ADS_PER_ADGROUP} quảng cáo / nhóm Upgraded Smart+.`
      )
  } else {
    goal = input.adgroup!.goal
    optGoal = optimizationGoalOf(input.adgroup!)
    groupName = input.adgroup!.name
    if (input.campaign_id) {
      const c = await getSmartPlus(tt, "campaign", input.campaign_id)
      const automation = c ? str(c.campaign_automation_type) : null
      if (
        !c ||
        isDeleted(c) ||
        (automation && !automation.startsWith("UPGRADED_SMART_PLUS"))
      ) {
        throw invalid(
          `Không tìm thấy chiến dịch Upgraded Smart+ ${input.campaign_id} (chiến dịch thủ công dùng tiktok_create_adgroup).`
        )
      }
      if (c.is_search_campaign === true || c.catalog_enabled === true) {
        throw invalid(
          "Chiến dịch Search Ads / catalog nằm ngoài phạm vi công cụ - tạo nhóm trong TikTok Ads Manager."
        )
      }
      const objective = str(c.objective_type) ?? ""
      if (
        objective === "WEB_CONVERSIONS" &&
        str(c.sales_destination) &&
        str(c.sales_destination) !== "WEBSITE"
      ) {
        throw invalid(
          "Chiến dịch bán hàng qua ứng dụng / web + app nằm ngoài phạm vi công cụ."
        )
      }
      campaignInfo = {
        cbo: c.budget_optimize_on !== false,
        budgetMode: str(c.budget_mode) ?? "",
        objective,
      }
      const groups = await countChildren(
        tt,
        "adgroup",
        "campaign_ids",
        input.campaign_id
      )
      if (str(c.smart_plus_adgroup_mode) === "SINGLE" && groups >= 1) {
        throw invalid(
          "Chiến dịch này chỉ cho 1 nhóm quảng cáo (smart_plus_adgroup_mode SINGLE) và đã có nhóm.",
          "Dùng adgroup_id của nhóm đó để thêm quảng cáo."
        )
      }
      if (groups + 1 > MAX_ADGROUPS_PER_CAMPAIGN)
        throw invalid(
          `Chiến dịch đã có ${groups} nhóm; TikTok cho tối đa ${MAX_ADGROUPS_PER_CAMPAIGN} nhóm / chiến dịch Upgraded Smart+.`
        )
      if (campaignInfo.cbo)
        warnings.push(
          "Chiến dịch CBO: promotion, mục tiêu tối ưu, sự kiện, giá thầu phải giống các nhóm đã có - TikTok từ chối nếu khác."
        )
    } else {
      const c = input.campaign!
      campaignInfo = {
        cbo: c.cbo,
        budgetMode: c.cbo
          ? CAMPAIGN_BUDGET_MODE.cbo[
              c.budget_type === "lifetime" ? "lifetime" : "daily"
            ]
          : CAMPAIGN_BUDGET_MODE.noCbo[c.budget_type],
        objective: objectiveOf(goal),
      }
    }
  }

  // ---- bodies (validated before anything is sent)
  const campaignBody = input.campaign
    ? buildCampaignBody(
        tt,
        input.campaign,
        goal,
        makeRequestId(opts.idempotencyKey, "smart_plus_campaign")
      )
    : null
  const adGroupBody = input.adgroup
    ? buildAdGroupBody(
        tt,
        input.adgroup,
        campaignInfo!,
        input.campaign_id ?? "(mới)",
        makeRequestId(opts.idempotencyKey, "smart_plus_adgroup"),
        now,
        warnings
      )
    : null
  const needsCta =
    !!input.ad && goal !== "TIKTOK_DM" && !input.ad.call_to_action_id
  const adBody = input.ad
    ? buildAdBody(
        tt,
        input.ad,
        goal,
        optGoal,
        input.adgroup_id ?? "(mới)",
        groupName,
        null
      )
    : null
  if (needsCta)
    warnings.push(
      "Quảng cáo dùng CTA động: khi xác nhận, công cụ tạo 1 CTA động (portfolio) từ gợi ý của TikTok ngay trước khi tạo quảng cáo."
    )
  if (input.adgroup && input.adgroup.targeting_mode !== "manual") {
    warnings.push(
      "Nhắm chọn tự động của Smart+: địa điểm / tuổi tối thiểu / ngôn ngữ / loại trừ là giới hạn cứng; age_groups, gender, sở thích (automatic_suggestions) chỉ là gợi ý."
    )
  }

  const payload: Raw = {}
  if (campaignBody) payload.campaign = stripPrivate(campaignBody)
  if (adGroupBody) payload.adgroup = stripPrivate(adGroupBody)
  if (adBody) payload.ad = stripPrivate(adBody)

  if (opts.dryRun) {
    const changes: FieldChange[] = []
    if (campaignBody)
      changes.push(
        summaryChange(
          "(mới)",
          "campaign",
          "smart_plus_campaign",
          payload.campaign
        )
      )
    if (adGroupBody)
      changes.push(
        summaryChange(
          "(mới)",
          "ad_group",
          "smart_plus_adgroup",
          payload.adgroup
        )
      )
    if (adBody)
      changes.push(summaryChange("(mới)", "ad", "smart_plus_ad", payload.ad))
    return { preview: true, changes, warnings, payload }
  }

  // ---- execute: campaign → ad group → (dynamic CTA portfolio, only when an ad follows) → ad. Stop at the first
  // failure; everything already written (objects + CTA portfolio) is reported and logged (partial audit).
  const created: Created[] = []
  let ctaId: string | null = null

  let campaignId = input.campaign_id ?? null
  let adgroupId = input.adgroup_id ?? null
  let step: Step = "campaign"
  try {
    if (campaignBody) {
      step = "campaign"
      campaignId = await createOne(
        tt,
        "campaign",
        campaignBody,
        input.campaign!.name,
        { campaign_name: input.campaign!.name },
        warnings,
        clock
      )
      created.push({
        level: "campaign",
        id: campaignId,
        name: input.campaign!.name,
      })
    }
    if (adGroupBody) {
      step = "adgroup"
      adGroupBody.campaign_id = campaignId
      adgroupId = await createOne(
        tt,
        "adgroup",
        adGroupBody,
        input.adgroup!.name,
        { campaign_ids: [campaignId], adgroup_name: input.adgroup!.name },
        warnings,
        clock
      )
      created.push({
        level: "ad_group",
        id: adgroupId,
        name: input.adgroup!.name,
      })
    }
    if (adBody) {
      if (needsCta) {
        step = "cta"
        ctaId = await createDynamicCta(tt, goal, optGoal, warnings)
      }
      step = "ad"
      adBody.adgroup_id = adgroupId
      if (ctaId) (adBody.ad_configuration as Raw).call_to_action_id = ctaId
      const adName = String(adBody.ad_name)
      const adId = await createOne(
        tt,
        "ad",
        adBody,
        adName,
        { adgroup_ids: [adgroupId] },
        warnings,
        clock
      )
      created.push({ level: "ad", id: adId, name: adName })
    }
  } catch (e) {
    if (created.length || ctaId) throw partialError(e, created, step, ctaId)
    throw e
  }

  // ---- read back: every created object must be DISABLE
  const changes: FieldChange[] = []
  for (const c of created) {
    const level: SpLevel = c.level === "ad_group" ? "adgroup" : c.level
    const o = await readBack(tt, level, c.id, warnings)
    const field = `smart_plus_${level}`
    const body =
      level === "campaign"
        ? campaignBody
        : level === "adgroup"
          ? adGroupBody
          : adBody
    changes.push({
      ...summaryChange(c.id, c.level, field, {
        ...summaryOf(level, c.id, o),
        config: body ? stripPrivate(body) : null,
      }),
      objectName: sanitizeExternalLabel(c.name, 120),
    })
  }
  if (ctaId) changes.push({ objectId: ctaId, field: "cta_portfolio", before: null, after: "CTA động (portfolio) mới" })
  return {
    preview: false,
    changes,
    warnings,
    createdIds: created.map((c) => c.id),
    payload,
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const smartPlusExtension: ProviderExtension<TikTokCredentials> = {
  name: "tiktok_create_smart_plus",
  permission: "create",
  title: "Tạo Upgraded Smart+ TikTok",
  description:
    "Dùng khi cần tạo chiến dịch TikTok Upgraded Smart+ (chiến dịch → nhóm → quảng cáo), hoặc chỉ nhóm/quảng cáo trong chiến dịch/nhóm Smart+ có sẵn (campaign_id / adgroup_id). CẦN TikTok allowlist tài khoản (chưa có → báo lỗi, không tạo gì). TikTok ngừng tạo chiến dịch thủ công qua API sau 31/12/2026, sau đó đây là cách duy nhất. Gọi ads_list_accounts (tiền tệ), ads_lookup (locations, pixels, identities), ads_upload_media (video/ảnh) trước. adgroup.goal: WEBSITE (cần landing_page_url; CONVERT cần pixel_id + optimization_event) | LEAD_FORM (instant_page_id) | LEAD_WEBSITE (pixel + event; landing_page_url hoặc instant_page_id) | TIKTOK_DM (auto_message_id - tiktok_messaging_assets / tiktok_create_welcome_message; identity TT_USER/BC_AUTH_TT) | MESSENGER / WHATSAPP / ZALO / LINE (adgroup.messaging) | IM_URL. Ngân sách theo đơn vị chính của tiền tệ tài khoản; ngân sách ngày Smart+ linh hoạt tới 125%/ngày; cbo=true đặt ngân sách ở chiến dịch, cbo=false đặt ở nhóm; không hỗ trợ AUTO_BUDGET_INCREASE. Creative Spark Ads: tiktok_item_id (không ad_texts) hoặc video_id + cover_image_id / image_ids + music_id (cần 1-5 ad_texts). CTA: tin nhắn TikTok = SEND_MESSAGE, còn lại tự tạo CTA động. Mọi cấp tạo ở trạng thái TẮT; lỗi giữa chừng trả id đã tạo để làm tiếp bằng campaign_id / adgroup_id.",
  input: smartPlusInput,
  write: true,
  moneyOf: (raw) => smartPlusMoney(raw as SmartPlusInput),
  run: (ctx, input, opts) =>
    runCreateSmartPlus(ctx, input as SmartPlusInput, opts),
}
