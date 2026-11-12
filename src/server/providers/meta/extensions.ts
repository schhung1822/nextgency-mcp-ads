// Meta-specific MCP tools: create campaign / ad set / ad, update targeting.
// Rules (meta.md §5): every create sends status=PAUSED; ABO campaigns send is_adset_budget_sharing_enabled;
// targeting always carries targeting_automation.advantage_audience; Advantage+ creative features are OPT_OUT unless
// requested; money in MAJOR units converted via toMetaMinor; dryRun = execution_options=["validate_only"].
// meta_create_ad cover (D1-D5): explicit image_hash > image_url > image_drive_file (resolved + uploaded by mcp-core,
// MutationOptions.driveImage) > video only: Meta's own preferred thumbnail of a READY video (preview: the signed uri
// is used for validate_only only; execution: downloaded through opts.fetchImage → adimages → image_hash). The signed
// uri never reaches the preview payload, summaries, changes, warnings or errors (replaced by a label).
// Click-to-message (v1.1.3, D1-D5): SALES ad sets may optimise for CONVERSATIONS or MESSAGING_PURCHASE_CONVERSION
// (Messenger only); ads in an ad set whose destination_type is MESSENGER / WHATSAPP / INSTAGRAM_DIRECT get the matching
// message CTA, an optional link, the ad set's Page and an optional welcome message (page_welcome_message).
// v1.1.4: an existing post may carry a welcome message too (E1, top-level page_welcome_message, read back after the
// create - dedupe); meta_update_ad_creative changes the creative of an existing ad (E2, greeting / content / id).
import { randomBytes } from "node:crypto"

import { z } from "zod"

import { sanitizeExternalLabel } from "../../../lib/text-safety"

import { isProviderError, ProviderError } from "../errors"
import { metaCurrencyOffset, toMetaMinor } from "../money"
import type { FieldChange, MutationOptions, MutationResult, ProviderContext, ProviderExtension } from "../types"
import { actId, graph, graphPage, isIsoDateTimeWithOffset, type MetaCredentials } from "./client"
import { advertisablePages } from "./lookup"
import { ensureMetaVideoInAccount, metaVideoCoverUri, readMetaVideo, uploadMetaCoverFromUri } from "./media"
import { validateOnly } from "./mutate"
import { isGraphFieldError, readNode, type RawNode } from "./objects"
import { type MetaPostCta, readMetaPostCta } from "./pages"
import { assertSameAccount, callCtx, fmtMoney, hasBudget, invalid } from "./shared"
import { buildTargeting, euCountriesIn, hasGeo, placementProblems, targetingInput, targetingProblems } from "./targeting"

export interface MetaWriteResult extends MutationResult {
  /** what was (or would be) sent to Meta - money shown in MAJOR units next to the minor value */
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

const digits = z.string().regex(/^\d{1,30}$/, "Id chỉ gồm chữ số.")
const isoDateTime = z
  .string()
  .refine(isIsoDateTimeWithOffset, "Thời điểm ISO-8601 có múi giờ, vd 2026-10-05T08:00:00+07:00.")
const objectName = z.string().trim().min(1).max(400)
const money = z.number().positive().finite().describe("Đơn vị CHÍNH của tiền tệ tài khoản (vd 200000 = 200.000đ)")

export const OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
] as const
export type Objective = (typeof OBJECTIVES)[number]

export const SPECIAL_AD_CATEGORIES = [
  "HOUSING",
  "EMPLOYMENT",
  "FINANCIAL_PRODUCTS_SERVICES",
  "ISSUES_ELECTIONS_POLITICS",
  "ONLINE_GAMBLING_AND_GAMING",
] as const

export const BID_STRATEGIES = [
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
] as const

export const OPTIMIZATION_GOALS = [
  "REACH",
  "IMPRESSIONS",
  "AD_RECALL_LIFT",
  "THRUPLAY",
  "LINK_CLICKS",
  "LANDING_PAGE_VIEWS",
  "POST_ENGAGEMENT",
  "CONVERSATIONS",
  "PAGE_LIKES",
  "LEAD_GENERATION",
  "QUALITY_LEAD",
  "OFFSITE_CONVERSIONS",
  "VALUE",
  "APP_INSTALLS",
  "MESSAGING_PURCHASE_CONVERSION",
] as const
type OptimizationGoal = (typeof OPTIMIZATION_GOALS)[number]

/** objective → allowed optimization goals (meta.md §5 table; [M] LEADS also allows website/messaging leads). */
export const OBJECTIVE_GOALS: Record<Objective, OptimizationGoal[]> = {
  OUTCOME_AWARENESS: ["REACH", "IMPRESSIONS", "AD_RECALL_LIFT", "THRUPLAY"],
  OUTCOME_TRAFFIC: ["LINK_CLICKS", "LANDING_PAGE_VIEWS"],
  OUTCOME_ENGAGEMENT: ["POST_ENGAGEMENT", "THRUPLAY", "CONVERSATIONS", "PAGE_LIKES", "OFFSITE_CONVERSIONS"],
  OUTCOME_LEADS: ["LEAD_GENERATION", "QUALITY_LEAD", "OFFSITE_CONVERSIONS", "CONVERSATIONS"],
  OUTCOME_SALES: ["OFFSITE_CONVERSIONS", "VALUE", "CONVERSATIONS", "MESSAGING_PURCHASE_CONVERSION"],
  OUTCOME_APP_PROMOTION: ["APP_INSTALLS"],
}

const DESTINATION_TYPES = [
  "WEBSITE",
  "MESSENGER",
  "WHATSAPP",
  "INSTAGRAM_DIRECT",
  "PHONE_CALL",
  "ON_AD",
  "APP",
  "ON_POST",
  "ON_VIDEO",
  "ON_PAGE",
] as const

/**
 * [T 2026-11-12] OUTCOME_ENGAGEMENT goals Meta only accepts with their "on your ad" destination (omitted → 100/2490408,
 * live and non-live campaigns alike); OFFSITE_CONVERSIONS = engagement on the website (LINK_CLICKS /
 * LANDING_PAGE_VIEWS are refused under ENGAGEMENT).
 */
const ENGAGEMENT_DESTINATION: Partial<Record<(typeof OPTIMIZATION_GOALS)[number], (typeof DESTINATION_TYPES)[number]>> = {
  POST_ENGAGEMENT: "ON_POST",
  THRUPLAY: "ON_VIDEO",
  PAGE_LIKES: "ON_PAGE",
  OFFSITE_CONVERSIONS: "WEBSITE",
}

const CUSTOM_EVENT_TYPES = [
  "PURCHASE",
  "LEAD",
  "COMPLETE_REGISTRATION",
  "ADD_TO_CART",
  "INITIATED_CHECKOUT",
  "ADD_PAYMENT_INFO",
  "CONTENT_VIEW",
  "SEARCH",
  "CONTACT",
  "SUBSCRIBE",
  "START_TRIAL",
  "SUBMIT_APPLICATION",
  "SCHEDULE",
  "OTHER",
] as const

export const CTA_TYPES = [
  "LEARN_MORE",
  "SHOP_NOW",
  "BUY_NOW",
  "ORDER_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
  "CONTACT_US",
  "APPLY_NOW",
  "BOOK_NOW",
  "DOWNLOAD",
  "GET_OFFER",
  "GET_QUOTE",
  "WATCH_MORE",
  "SEE_MORE",
  "MESSAGE_PAGE",
  "WHATSAPP_MESSAGE",
  "INSTAGRAM_MESSAGE",
  "CALL_NOW",
  "INSTALL_MOBILE_APP",
  "NO_BUTTON",
  /** [T 2026-11-12] what Ads Manager puts on a live video ad (Xem chi tiết); not in the documented enum */
  "SEE_DETAILS",
  /** live video ads (documented call_to_action_type) */
  "WATCH_LIVE_VIDEO",
] as const

/**
 * Click-to-message destinations (ad set destination_type) → the matching CTA, its app_destination and the default
 * `link` of a link creative (meta.md §5 "Creative nhắn tin"; [M] Instagram has no documented default link → none sent).
 */
const MESSAGING_DESTINATIONS = {
  MESSENGER: { cta: "MESSAGE_PAGE", app: "MESSENGER", link: "https://fb.com/messenger_doc/" },
  WHATSAPP: { cta: "WHATSAPP_MESSAGE", app: "WHATSAPP", link: "https://api.whatsapp.com/send" },
  INSTAGRAM_DIRECT: { cta: "INSTAGRAM_MESSAGE", app: "INSTAGRAM_DIRECT", link: null },
} as const
type MessagingDestination = keyof typeof MESSAGING_DESTINATIONS

function messagingDestination(v: unknown): MessagingDestination | null {
  return typeof v === "string" && Object.hasOwn(MESSAGING_DESTINATIONS, v) ? (v as MessagingDestination) : null
}

/** Prerequisite of MESSAGING_PURCHASE_CONVERSION (Meta Help "Purchases through messaging"), shown in every preview. */
export const MESSAGING_PURCHASE_PREREQUISITE =
  "Tối ưu lượt mua qua tin nhắn chỉ dùng được khi Trang / tài khoản đã đủ điều kiện: trong 30 ngày gần nhất có ít nhất 5 sự kiện mua hàng từ cuộc trò chuyện Messenger gửi về Meta (Conversions API cho nhắn tin doanh nghiệp, hoặc \"Tạo đơn\" trong Meta Business Suite). Chưa đủ thì Meta từ chối mục tiêu này - bước xem trước đã gửi kiểm tra (validate_only) cho Meta, một số trường hợp Meta chỉ báo khi tạo."

/** Advantage+ creative features (developers.facebook.com advantage-creative get-started, 2026-10-02). */
export const CREATIVE_FEATURES = [
  "adapt_to_placement",
  "add_text_overlay",
  "creative_stickers",
  "description_automation",
  "enhance_cta",
  "image_animation",
  "image_background_gen",
  "image_brightness_and_contrast",
  "image_templates",
  "image_text_translation",
  "image_touchups",
  "image_uncrop",
  "inline_comment",
  "media_type_automation",
  "pac_relaxation",
  "product_extensions",
  "reveal_details_over_time",
  "text_optimizations",
  "text_translation",
  "translate_voiceover",
  "video_auto_crop",
  "video_filtering",
  "video_uncrop",
] as const
type CreativeFeature = (typeof CREATIVE_FEATURES)[number]

/** Features explicitly opted OUT per creative format unless the user opts in. [L] per-format compatibility. */
const COMMON_OPT_OUT: CreativeFeature[] = ["text_optimizations", "enhance_cta", "inline_comment", "add_text_overlay"]
const OPT_OUT_BY_FORMAT: Record<"link" | "video" | "existing_post", CreativeFeature[]> = {
  link: [
    ...COMMON_OPT_OUT,
    "description_automation",
    "adapt_to_placement",
    "image_touchups",
    "image_templates",
    "image_brightness_and_contrast",
    "image_uncrop",
    "image_animation",
    "image_background_gen",
  ],
  video: [...COMMON_OPT_OUT, "adapt_to_placement", "video_auto_crop", "video_filtering", "video_uncrop"],
  existing_post: [...COMMON_OPT_OUT],
}

export function creativeFeaturesSpec(
  format: "link" | "video" | "existing_post",
  optIn: CreativeFeature[] = []
): Record<string, { enroll_status: "OPT_IN" | "OPT_OUT" }> {
  const spec: Record<string, { enroll_status: "OPT_IN" | "OPT_OUT" }> = {}
  for (const f of OPT_OUT_BY_FORMAT[format]) spec[f] = { enroll_status: "OPT_OUT" }
  for (const f of optIn) spec[f] = { enroll_status: "OPT_IN" }
  return spec
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minorWithDisplay(amount: number, currency: string) {
  const minor = toMetaMinor(amount, currency)
  if (minor < 1) throw invalid(`Số tiền quá nhỏ so với đơn vị tiền ${currency}.`)
  return { minor, major: minor / metaCurrencyOffset(currency), display: fmtMoney(minor / metaCurrencyOffset(currency), currency) }
}

async function findRecentByName(
  ctx: ProviderContext<MetaCredentials>,
  edge: string,
  name: string,
  sinceMs: number
): Promise<string | null> {
  // AdCreative has no documented created_time: creative names carry a random suffix (meta_update_ad_creative)
  const creatives = edge === "adcreatives"
  try {
    const res = await graphPage<RawNode>(callCtx(ctx), `${actId(ctx.account.externalId)}/${edge}`, {
      fields: creatives ? "id,name" : "id,name,created_time",
      filtering: [{ field: "name", operator: "EQUAL", value: name }],
      limit: creatives ? 25 : 5,
    })
    const hit = res.data.find(
      (n) =>
        n.name === name && (creatives || (typeof n.created_time === "string" && Date.parse(n.created_time) >= sinceMs))
    )
    return hit?.id ?? null
  } catch {
    return null
  }
}

/**
 * Create under /act_{id}/<edge>. Never retried blindly: on timeout/5xx we look the object up by name and
 * creation time before reporting failure (meta.md §7).
 */
async function createObject(
  ctx: ProviderContext<MetaCredentials>,
  edge: "campaigns" | "adsets" | "ads" | "adcreatives",
  payload: Record<string, unknown>,
  warnings: string[]
): Promise<string> {
  // creatives have no delivery status; every campaign / ad set / ad is created PAUSED
  if (edge !== "adcreatives" && payload.status !== "PAUSED") throw new Error("internal: Meta create payload must be PAUSED")
  const started = Date.now()
  try {
    const res = await graph<{ id?: string }>(callCtx(ctx), {
      method: "POST",
      path: `${actId(ctx.account.externalId)}/${edge}`,
      params: payload,
      idempotent: false,
    })
    if (!res.id) throw invalid("Meta không trả id đối tượng mới.")
    return res.id
  } catch (e) {
    if (isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")) {
      const found = await findRecentByName(ctx, edge, String(payload.name), started - 120_000)
      if (found) {
        warnings.push("Meta phản hồi lỗi/timeout nhưng đối tượng đã được tạo - dùng id tìm thấy, không tạo lại.")
        return found
      }
    }
    throw e
  }
}

async function runCreate(
  ctx: ProviderContext<MetaCredentials>,
  edge: "campaigns" | "adsets" | "ads",
  payload: Record<string, unknown>,
  summary: Record<string, unknown>,
  warnings: string[],
  opts: MutationOptions,
  level: "campaign" | "ad_group" | "ad",
  o: { skipValidate?: boolean } = {}
): Promise<MetaWriteResult> {
  const change = (id: string): FieldChange => ({
    objectId: id,
    objectName: String(payload.name),
    level,
    field: "create",
    before: null,
    after: summary,
  })
  if (opts.dryRun) {
    if (!o.skipValidate) await validateOnly(ctx, `${actId(ctx.account.externalId)}/${edge}`, payload)
    return { preview: true, changes: [change("(mới)")], warnings, payload: summary }
  }
  const id = await createObject(ctx, edge, payload, warnings)
  return { preview: false, changes: [change(id)], warnings, payload: summary, createdIds: [id] }
}

// ---------------------------------------------------------------------------
// meta_create_campaign
// ---------------------------------------------------------------------------

export const createCampaignInput = z
  .object({
    name: objectName,
    objective: z.enum(OBJECTIVES),
    special_ad_categories: z
      .array(z.enum(SPECIAL_AD_CATEGORIES))
      .default([])
      .describe("Danh mục quảng cáo đặc biệt (nhà ở, việc làm, tài chính, chính trị, cờ bạc). Bỏ trống nếu không thuộc."),
    special_ad_category_country: z.array(z.string().regex(/^[A-Za-z]{2}$/)).optional(),
    budget: z
      .object({ type: z.enum(["daily", "lifetime"]), amount: money })
      .optional()
      .describe("Có = ngân sách chiến dịch (CBO/Advantage+ campaign budget). Không có = ngân sách ở từng nhóm quảng cáo (ABO)."),
    bid_strategy: z.enum(BID_STRATEGIES).optional().describe("Chỉ dùng với CBO. Mặc định LOWEST_COST_WITHOUT_CAP."),
    adset_budget_sharing: z
      .boolean()
      .default(false)
      .describe("Chỉ dùng với ABO: cho phép nhóm quảng cáo chia sẻ tới 20% ngân sách cho nhau."),
    spend_cap: money.optional().describe("Giới hạn chi tiêu cả chiến dịch (đơn vị chính)."),
    live_video_destination: z
      .enum(["FACEBOOK", "INSTAGRAM"])
      .optional()
      .describe(
        "Bật \"Quảng cáo video trực tiếp\" (livestream): FACEBOOK = video trực tiếp trên Trang Facebook, INSTAGRAM = trên Instagram. Quảng cáo trong chiến dịch dùng bài live (ads_lookup kind=live_videos)."
      ),
  })
  .strict()
export type CreateCampaignInput = z.infer<typeof createCampaignInput>

/**
 * [T 2026-11-12] live video ads need a higher ad set budget: Meta accepted a 100.000 VND/day ad set in a live campaign
 * but refused every ad in it (100/1885272, minimum 259.539 VND/day on that account - the minimum varies); with 2 ads
 * the same ad set needed 519.078 = 2 x 259.539 → the minimum is PER live ad in the ad set.
 */
export const LIVE_ADSET_BUDGET_NOTE =
  "Chiến dịch quảng cáo video trực tiếp: Meta đòi ngân sách nhóm cao hơn nhóm thường, tính theo MỖI quảng cáo live trong nhóm (đã gặp ~260.000 ₫/ngày cho 1 quảng cáo, ~520.000 ₫ cho 2) và chỉ báo lỗi khi tạo quảng cáo - nếu meta_create_ad báo ngân sách quá thấp, tăng ngân sách (ads_update_budget) rồi tạo lại."

/** Notes shown with every live video campaign / ad (meta.md §5 "Quảng cáo video trực tiếp"). */
export const LIVE_VIDEO_NOTES = [
  "Quảng cáo video trực tiếp: mỗi quảng cáo dùng bài live của Trang (ads_lookup kind=live_videos → meta_create_ad creative existing_post).",
  "Khi đang phát, Meta chỉ hiển thị quảng cáo live trên Bảng feed và Reels Facebook; sau khi Meta duyệt có thể mất khoảng 30 phút mới bắt đầu phân phối.",
]

export function buildCampaignPayload(input: CreateCampaignInput, currency: string, warnings: string[]) {
  const payload: Record<string, unknown> = {
    name: input.name,
    objective: input.objective,
    status: "PAUSED",
    buying_type: "AUCTION",
    special_ad_categories: input.special_ad_categories,
  }
  const summary: Record<string, unknown> = { name: input.name, objective: input.objective, status: "PAUSED" }
  if (input.special_ad_categories.length) {
    if (!input.special_ad_category_country?.length) {
      throw invalid("Có danh mục quảng cáo đặc biệt thì phải khai báo special_ad_category_country (vd [\"VN\"]).")
    }
    payload.special_ad_category_country = input.special_ad_category_country.map((c) => c.toUpperCase())
    summary.special_ad_categories = input.special_ad_categories
    warnings.push("Danh mục đặc biệt giới hạn nhắm mục tiêu (tuổi, giới tính, vị trí…).")
  }
  if (input.budget) {
    const b = minorWithDisplay(input.budget.amount, currency)
    payload[input.budget.type === "daily" ? "daily_budget" : "lifetime_budget"] = b.minor
    payload.bid_strategy = input.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP"
    summary.budget_mode = "CBO"
    summary.budget = { type: input.budget.type, amount: b.major, currency, display: b.display, minor_units_sent: b.minor }
    summary.bid_strategy = payload.bid_strategy
    if (input.budget.type === "lifetime") {
      warnings.push("Ngân sách trọn đời: mọi nhóm quảng cáo cần có end_time.")
      warnings.push("Ngân sách trọn đời của chiến dịch sẽ được kiểm tra lại theo lịch chạy của các nhóm quảng cáo khi bật chạy.")
    }
    if (input.bid_strategy && input.bid_strategy !== "LOWEST_COST_WITHOUT_CAP") {
      warnings.push("Chiến lược giá thầu có giới hạn: mỗi nhóm quảng cáo cần bid_amount (hoặc ROAS tối thiểu).")
    }
  } else {
    if (input.bid_strategy) {
      throw invalid("bid_strategy ở cấp chiến dịch chỉ dùng khi có ngân sách chiến dịch (CBO); với ABO hãy đặt ở nhóm quảng cáo.")
    }
    payload.is_adset_budget_sharing_enabled = input.adset_budget_sharing
    summary.budget_mode = "ABO"
    summary.is_adset_budget_sharing_enabled = input.adset_budget_sharing
  }
  if (input.spend_cap !== undefined) {
    const cap = minorWithDisplay(input.spend_cap, currency)
    payload.spend_cap = cap.minor
    summary.spend_cap = { amount: cap.major, currency, display: cap.display, minor_units_sent: cap.minor }
  }
  if (input.live_video_destination) {
    // [T 2026-11-12] Ads Manager's "Quảng cáo video trực tiếp" = campaign promoted_object.live_video_destination
    // (FACEBOOK / INSTAGRAM; FACEBOOK_LIVE → #100), validate_only accepted for every objective tried
    payload.promoted_object = { live_video_destination: input.live_video_destination }
    summary.live_video_destination = input.live_video_destination
    warnings.push(...LIVE_VIDEO_NOTES)
    if (input.live_video_destination === "INSTAGRAM") {
      warnings.push(
        "Video trực tiếp Instagram: Meta thường chạy dạng quảng cáo hợp tác (creator phải cấp quyền quảng cáo) - chưa được kiểm chứng qua công cụ này."
      )
    }
  }
  return { payload, summary }
}

const createCampaign: ProviderExtension<MetaCredentials, CreateCampaignInput, MetaWriteResult> = {
  name: "meta_create_campaign",
  permission: "create",
  title: "Tạo chiến dịch Meta",
  description:
    "Dùng khi cần tạo chiến dịch quảng cáo Facebook/Instagram mới. Chiến dịch luôn được tạo ở trạng thái TẠM DỪNG; " +
    "bật chạy bằng ads_set_status sau khi đã có nhóm quảng cáo và quảng cáo. Chọn objective OUTCOME_* " +
    "(AWARENESS, TRAFFIC, ENGAGEMENT, LEADS, APP_PROMOTION, SALES). Có `budget` = ngân sách chiến dịch (CBO, " +
    "nhóm quảng cáo không có ngân sách riêng); không có `budget` = ngân sách ở từng nhóm (ABO), khi đó có thể bật " +
    "adset_budget_sharing. Tiền theo đơn vị chính của tiền tệ tài khoản (vd 200000 = 200.000đ). Khai báo " +
    "special_ad_categories nếu quảng cáo về nhà ở, việc làm, tài chính, chính trị, cờ bạc. Quảng cáo livestream (video " +
    "trực tiếp): live_video_destination FACEBOOK (hoặc INSTAGRAM), rồi quảng cáo dùng bài live từ ads_lookup " +
    "kind=live_videos. Bước tiếp theo: meta_create_adset.",
  input: createCampaignInput,
  write: true,
  // spend_cap only lowers spend: not a cap target. Lifetime flight is on the ad sets (unknown here).
  moneyOf: (input) =>
    input.budget
      ? [{ kind: input.budget.type === "daily" ? "daily_budget" : "lifetime_budget", amount: input.budget.amount, field: "budget.amount" }]
      : [],
  async run(ctx, input, opts) {
    const warnings: string[] = ["Chiến dịch được tạo ở trạng thái TẠM DỪNG."]
    const { payload, summary } = buildCampaignPayload(input, ctx.account.currency, warnings)
    return runCreate(ctx, "campaigns", payload, summary, warnings, opts, "campaign")
  },
}

// ---------------------------------------------------------------------------
// meta_create_adset
// ---------------------------------------------------------------------------

export const createAdsetInput = z
  .object({
    campaign_id: digits,
    name: objectName,
    optimization_goal: z.enum(OPTIMIZATION_GOALS),
    billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS", "THRUPLAY"]).default("IMPRESSIONS"),
    budget: z
      .object({ type: z.enum(["daily", "lifetime"]), amount: money })
      .optional()
      .describe("Bắt buộc khi chiến dịch dùng ABO; bỏ trống khi chiến dịch dùng CBO."),
    bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"]).optional(),
    bid_amount: money.optional().describe("Giá thầu/chi phí mục tiêu (đơn vị chính) - cần khi BID_CAP hoặc COST_CAP."),
    start_time: isoDateTime
      .optional()
      .describe(
        "ISO-8601 có múi giờ, vd 2026-10-20T00:00:00+07:00. Bỏ trống = bắt đầu ngay khi bật. Muốn chạy từ 00:00 một ngày thì đặt ngay lúc tạo: khi đã tới giờ bắt đầu, không đổi start_time được nữa (chỉ đổi end_time)."
      ),
    end_time: isoDateTime.optional(),
    destination_type: z.enum(DESTINATION_TYPES).optional(),
    promoted_object: z
      .object({
        page_id: digits.optional(),
        pixel_id: digits.optional(),
        custom_event_type: z.enum(CUSTOM_EVENT_TYPES).optional(),
        application_id: digits.optional(),
        object_store_url: z.url().optional(),
      })
      .strict()
      .optional(),
    targeting: targetingInput,
    dsa_beneficiary: z.string().trim().min(1).max(200).optional().describe("Bắt buộc khi nhắm tới nước EU (Digital Services Act)."),
    dsa_payor: z.string().trim().min(1).max(200).optional().describe("Bắt buộc khi nhắm tới nước EU."),
  })
  .strict()
export type CreateAdsetInput = z.infer<typeof createAdsetInput>

/** Messaging goals: the optional dataset (pixel_id) and its custom_event_type go together. */
function pixelPair(po: NonNullable<CreateAdsetInput["promoted_object"]>): void {
  if (!!po.pixel_id !== !!po.custom_event_type) {
    throw invalid(
      "promoted_object.pixel_id và custom_event_type phải đi cùng nhau (vd dataset gắn với Trang + PURCHASE), hoặc bỏ cả hai.",
      "Gọi ads_lookup kind=pixels."
    )
  }
}

/** Validate objective ↔ optimization_goal ↔ promoted_object/destination (meta.md §5 table). */
export function checkAdsetGoal(objective: string, input: CreateAdsetInput): void {
  const allowed = OBJECTIVE_GOALS[objective as Objective]
  if (!allowed) {
    throw invalid(`Chiến dịch có objective ${objective} không được hỗ trợ để tạo nhóm quảng cáo qua công cụ này.`)
  }
  const goal = input.optimization_goal
  if (goal === "MESSAGING_PURCHASE_CONVERSION" && objective !== "OUTCOME_SALES") {
    throw invalid(
      "MESSAGING_PURCHASE_CONVERSION (tối đa lượt mua qua tin nhắn) chỉ dùng với chiến dịch mục tiêu Doanh số (OUTCOME_SALES).",
      "Tạo chiến dịch objective OUTCOME_SALES bằng meta_create_campaign, hoặc dùng CONVERSATIONS."
    )
  }
  if (!allowed.includes(goal)) {
    throw invalid(`Mục tiêu ${objective} chỉ cho phép optimization_goal: ${allowed.join(", ")}.`)
  }
  const po = input.promoted_object ?? {}
  const engagementDest = objective === "OUTCOME_ENGAGEMENT" ? ENGAGEMENT_DESTINATION[goal] : undefined
  if (engagementDest && input.destination_type && input.destination_type !== engagementDest) {
    throw invalid(
      `Chiến dịch Tương tác + ${goal} cần destination_type ${engagementDest} (nhóm này gửi ${input.destination_type}).`,
      `Bỏ destination_type (tự dùng ${engagementDest}) hoặc truyền ${engagementDest}.`
    )
  }
  if (objective === "OUTCOME_AWARENESS" && !po.page_id) throw invalid("Chiến dịch nhận biết cần promoted_object.page_id.")
  if (goal === "PAGE_LIKES" && !po.page_id) throw invalid("PAGE_LIKES cần promoted_object.page_id.")
  if (goal === "CONVERSATIONS") {
    if (!input.destination_type || !["MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT"].includes(input.destination_type)) {
      throw invalid("CONVERSATIONS cần destination_type MESSENGER, WHATSAPP hoặc INSTAGRAM_DIRECT.")
    }
    if (!po.page_id) throw invalid("CONVERSATIONS cần promoted_object.page_id.")
    // [T 2026-11-12] Meta: "performance goal can't be used for the campaign objective" (100/2490408) - Leads + Messenger
    // is only Messenger lead forms in Ads Manager (no longer creatable through the API since v24.0)
    if (objective === "OUTCOME_LEADS" && input.destination_type === "MESSENGER") {
      throw invalid(
        "Chiến dịch Khách hàng tiềm năng (OUTCOME_LEADS) không chạy được CONVERSATIONS tới Messenger - Meta từ chối mục tiêu này.",
        "Quảng cáo tin nhắn Messenger: tạo chiến dịch OUTCOME_SALES (CONVERSATIONS hoặc MESSAGING_PURCHASE_CONVERSION) hoặc OUTCOME_ENGAGEMENT (CONVERSATIONS) bằng meta_create_campaign."
      )
    }
    if (objective === "OUTCOME_SALES") pixelPair(po)
  }
  if (goal === "MESSAGING_PURCHASE_CONVERSION") {
    if (input.destination_type && input.destination_type !== "MESSENGER") {
      throw invalid(
        "Meta chỉ hỗ trợ tối ưu lượt mua qua tin nhắn cho Messenger: destination_type phải là MESSENGER (hoặc bỏ trống).",
        "Với WhatsApp / Instagram Direct hãy dùng optimization_goal CONVERSATIONS."
      )
    }
    if (!po.page_id) {
      throw invalid("MESSAGING_PURCHASE_CONVERSION cần promoted_object.page_id (Trang nhận tin nhắn).", "Gọi ads_lookup kind=pages.")
    }
    pixelPair(po)
    if (po.custom_event_type && po.custom_event_type !== "PURCHASE") {
      throw invalid("MESSAGING_PURCHASE_CONVERSION chỉ nhận custom_event_type PURCHASE.")
    }
    if (input.billing_event !== "IMPRESSIONS") {
      throw invalid("Quảng cáo tối ưu lượt mua qua tin nhắn tính phí theo lượt hiển thị: billing_event phải là IMPRESSIONS.")
    }
  }
  if ((goal === "LEAD_GENERATION" || goal === "QUALITY_LEAD") && input.destination_type === "MESSENGER") {
    throw invalid(
      "Meta API không còn cho tạo quảng cáo tìm khách hàng tiềm năng trong Messenger (từ v24.0) - loại này chỉ tạo được trong Trình quản lý quảng cáo.",
      "Dùng biểu mẫu tức thì (destination_type ON_AD) hoặc mục tiêu CONVERSATIONS (nhắn tin)."
    )
  }
  if ((goal === "LEAD_GENERATION" || goal === "QUALITY_LEAD") && !po.page_id) {
    throw invalid("Quảng cáo tìm khách hàng tiềm năng (biểu mẫu) cần promoted_object.page_id.")
  }
  if (goal === "OFFSITE_CONVERSIONS" || goal === "VALUE") {
    if (!po.pixel_id || !po.custom_event_type) {
      throw invalid("Tối ưu chuyển đổi cần promoted_object.pixel_id và custom_event_type (vd PURCHASE).", "Gọi ads_lookup kind=pixels.")
    }
  }
  if (objective === "OUTCOME_APP_PROMOTION" && (!po.application_id || !po.object_store_url)) {
    throw invalid("Quảng cáo ứng dụng cần promoted_object.application_id và object_store_url.")
  }
}

export function buildAdsetPayload(
  input: CreateAdsetInput,
  campaign: RawNode,
  currency: string,
  warnings: string[]
): { payload: Record<string, unknown>; summary: Record<string, unknown> } {
  const objective = String(campaign.objective ?? "")
  checkAdsetGoal(objective, input)
  const problems = targetingProblems(input.targeting)
  if (problems.length) throw invalid(problems.join(" "))
  if (!hasGeo(input.targeting)) throw invalid("targeting cần ít nhất một vị trí: countries, regions hoặc cities.")

  const cbo = hasBudget(campaign as { daily_budget?: unknown; lifetime_budget?: unknown })
  if (cbo && input.budget) {
    throw invalid("Chiến dịch dùng ngân sách chiến dịch (CBO) - nhóm quảng cáo không được có ngân sách riêng.")
  }
  if (!cbo && !input.budget) {
    throw invalid("Chiến dịch dùng ngân sách nhóm (ABO) - cần truyền budget cho nhóm quảng cáo.")
  }
  if (cbo && input.bid_strategy) {
    throw invalid("Chiến dịch CBO đã có bid_strategy ở cấp chiến dịch - không đặt lại ở nhóm quảng cáo.")
  }

  const campaignLifetime = Number(campaign.lifetime_budget) > 0
  if ((input.budget?.type === "lifetime" || campaignLifetime) && !input.end_time) {
    throw invalid("Ngân sách trọn đời cần end_time.")
  }
  if (campaignLifetime) {
    warnings.push("Chiến dịch dùng ngân sách trọn đời (CBO): khi bật chạy, trần ngân sách được tính theo ngày kết thúc của các nhóm quảng cáo.")
  }
  const now = Date.now()
  if (input.end_time && Date.parse(input.end_time) <= now) throw invalid("end_time phải ở tương lai.")
  if (input.start_time && input.end_time && Date.parse(input.end_time) <= Date.parse(input.start_time)) {
    throw invalid("end_time phải sau start_time.")
  }

  const strategy = cbo ? String(campaign.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP") : (input.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP")
  const messagingPurchase = input.optimization_goal === "MESSAGING_PURCHASE_CONVERSION"
  if (messagingPurchase && strategy !== "LOWEST_COST_WITHOUT_CAP" && strategy !== "COST_CAP") {
    throw invalid(
      `MESSAGING_PURCHASE_CONVERSION chỉ dùng chiến lược giá thầu LOWEST_COST_WITHOUT_CAP hoặc COST_CAP (${cbo ? "chiến dịch" : "nhóm quảng cáo"} đang là ${strategy}).`
    )
  }
  const needsBid = strategy === "LOWEST_COST_WITH_BID_CAP" || strategy === "COST_CAP"
  if (needsBid && input.bid_amount === undefined) throw invalid(`Chiến lược ${strategy} cần bid_amount.`)
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") {
    throw invalid("Chiến lược ROAS tối thiểu chưa được hỗ trợ khi tạo nhóm qua công cụ này.")
  }
  if (!needsBid && input.bid_amount !== undefined) {
    throw invalid("bid_amount chỉ dùng với LOWEST_COST_WITH_BID_CAP hoặc COST_CAP.")
  }

  const eu = euCountriesIn(input.targeting)
  if (eu.length && (!input.dsa_beneficiary || !input.dsa_payor)) {
    throw invalid(
      `Nhắm tới nước EU (${eu.join(", ")}) phải khai báo dsa_beneficiary và dsa_payor (Digital Services Act).`
    )
  }
  if (!eu.length && (input.targeting.regions?.length || input.targeting.cities?.length)) {
    warnings.push("Nếu tỉnh/thành phố được chọn thuộc EU, Meta yêu cầu dsa_beneficiary và dsa_payor.")
  }

  const special = Array.isArray(campaign.special_ad_categories)
    ? (campaign.special_ad_categories as string[]).filter((c) => c && c !== "NONE")
    : []
  if (special.length) warnings.push(`Chiến dịch thuộc danh mục đặc biệt (${special.join(", ")}) - Meta giới hạn nhắm mục tiêu.`)

  const targeting = buildTargeting(input.targeting)
  const placements = placementProblems(targeting)
  if (placements.errors.length) throw invalid(placements.errors.join(" "))
  warnings.push(...placements.warnings)
  const payload: Record<string, unknown> = {
    name: input.name,
    campaign_id: input.campaign_id,
    status: "PAUSED",
    optimization_goal: input.optimization_goal,
    billing_event: input.billing_event,
    targeting,
  }
  const summary: Record<string, unknown> = {
    name: input.name,
    campaign_id: input.campaign_id,
    objective,
    status: "PAUSED",
    optimization_goal: input.optimization_goal,
    billing_event: input.billing_event,
    budget_mode: cbo ? "CBO (ngân sách ở chiến dịch)" : "ABO",
    targeting,
  }
  if (input.budget) {
    const b = minorWithDisplay(input.budget.amount, currency)
    payload[input.budget.type === "daily" ? "daily_budget" : "lifetime_budget"] = b.minor
    summary.budget = { type: input.budget.type, amount: b.major, currency, display: b.display, minor_units_sent: b.minor }
  }
  if (!cbo) {
    payload.bid_strategy = strategy
    summary.bid_strategy = strategy
  }
  if (input.bid_amount !== undefined) {
    const bid = minorWithDisplay(input.bid_amount, currency)
    payload.bid_amount = bid.minor
    summary.bid_amount = { amount: bid.major, currency, display: bid.display, minor_units_sent: bid.minor }
  }
  if (input.start_time) payload.start_time = summary.start_time = input.start_time
  if (input.end_time) payload.end_time = summary.end_time = input.end_time
  let destination = input.destination_type
  if (!destination && (input.optimization_goal === "LEAD_GENERATION" || input.optimization_goal === "QUALITY_LEAD")) {
    destination = "ON_AD"
  }
  if (!destination && messagingPurchase) destination = "MESSENGER"
  if (!destination && campaign.objective === "OUTCOME_ENGAGEMENT") destination = ENGAGEMENT_DESTINATION[input.optimization_goal]
  if (messagingPurchase) warnings.push(MESSAGING_PURCHASE_PREREQUISITE)
  if (destination) payload.destination_type = summary.destination_type = destination
  if (input.promoted_object && Object.keys(input.promoted_object).length) {
    payload.promoted_object = summary.promoted_object = input.promoted_object
  }
  if (input.dsa_beneficiary) payload.dsa_beneficiary = summary.dsa_beneficiary = input.dsa_beneficiary
  if (input.dsa_payor) payload.dsa_payor = summary.dsa_payor = input.dsa_payor
  if (targeting.targeting_automation && (targeting.targeting_automation as { advantage_audience: number }).advantage_audience === 1) {
    warnings.push("Advantage+ audience BẬT: Meta có thể phân phối ngoài độ tuổi/sở thích đã chọn (coi là gợi ý).")
  }
  return { payload, summary }
}

const createAdset: ProviderExtension<MetaCredentials, CreateAdsetInput, MetaWriteResult> = {
  name: "meta_create_adset",
  permission: "create",
  title: "Tạo nhóm quảng cáo Meta",
  description:
    "Dùng khi cần tạo nhóm quảng cáo (ad set) trong một chiến dịch Meta đã có (lấy campaign_id từ ads_list_objects " +
    "hoặc meta_create_campaign). Nhóm luôn được tạo ở trạng thái TẠM DỪNG. optimization_goal phải hợp với objective " +
    "của chiến dịch: AWARENESS→REACH/IMPRESSIONS/AD_RECALL_LIFT/THRUPLAY (+page_id); TRAFFIC→LINK_CLICKS/" +
    "LANDING_PAGE_VIEWS; ENGAGEMENT→POST_ENGAGEMENT/THRUPLAY/PAGE_LIKES (tương tác trên quảng cáo: tự đặt " +
    "destination ON_POST/ON_VIDEO/ON_PAGE), CONVERSATIONS, OFFSITE_CONVERSIONS (website + pixel); LEADS→LEAD_GENERATION/" +
    "QUALITY_LEAD (+page_id); SALES→OFFSITE_CONVERSIONS/VALUE (+pixel_id, custom_event_type), CONVERSATIONS hoặc " +
    "MESSAGING_PURCHASE_CONVERSION. CONVERSATIONS = nhắn tin: destination_type MESSENGER/WHATSAPP/INSTAGRAM_DIRECT + " +
    "page_id. MESSAGING_PURCHASE_CONVERSION = tối đa lượt mua qua tin nhắn: chỉ SALES + Messenger, page_id, " +
    "billing_event IMPRESSIONS, giá thầu LOWEST_COST_WITHOUT_CAP/COST_CAP; Trang cần ≥5 sự kiện mua qua Messenger " +
    "trong 30 ngày, không thì Meta từ chối. Không tạo được quảng cáo khách hàng tiềm năng trong Messenger. Chiến dịch CBO thì " +
    "không truyền budget; ABO thì bắt buộc budget (đơn vị chính). Targeting cần vị trí (countries/regions/cities - " +
    "tra bằng ads_lookup locations), sở thích tra bằng ads_lookup interests; advantage_audience mặc định tắt. " +
    "Nhắm nước EU phải có dsa_beneficiary + dsa_payor. Thời gian ISO-8601 có múi giờ. Bước tiếp: meta_create_ad.",
  input: createAdsetInput,
  write: true,
  moneyOf: (input) => [
    ...(input.budget
      ? [
          {
            kind: input.budget.type === "daily" ? ("daily_budget" as const) : ("lifetime_budget" as const),
            amount: input.budget.amount,
            field: "budget.amount",
            startTime: input.start_time ?? null,
            endTime: input.end_time ?? null,
          },
        ]
      : []),
    ...(input.bid_amount !== undefined ? [{ kind: "bid" as const, amount: input.bid_amount, field: "bid_amount" }] : []),
  ],
  async run(ctx, input, opts) {
    const campaign = await readNode(ctx, "campaign", input.campaign_id, [
      "id",
      "name",
      "objective",
      "daily_budget",
      "lifetime_budget",
      "bid_strategy",
      "special_ad_categories",
      "status",
      "promoted_object",
    ])
    const warnings: string[] = ["Nhóm quảng cáo được tạo ở trạng thái TẠM DỪNG."]
    const { payload, summary } = buildAdsetPayload(input, campaign, ctx.account.currency, warnings)
    const live = rec(campaign.promoted_object)?.live_video_destination
    if (typeof live === "string" && live) {
      summary.live_video_destination = live
      warnings.push(LIVE_ADSET_BUDGET_NOTE)
    }
    // dry run AND execute: the Page must be one this ad account may advertise for
    await assertAdvertisablePages(ctx, [input.promoted_object?.page_id])
    return runCreate(ctx, "adsets", payload, summary, warnings, opts, "ad_group")
  },
}

/**
 * Every given Page id must be in advertisablePages(ctx) (promote_pages of the ad account + me/accounts Pages with the
 * ADVERTISE task) - not any Page id the AI picks. Unrelated to the MCP Page scope (read-only Pages tools only).
 */
async function assertAdvertisablePages(ctx: ProviderContext<MetaCredentials>, ids: (string | undefined)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))]
  if (wanted.length === 0) return
  // cached list first (D4); a Page missing from it is re-read from Meta ONCE before refusing (just assigned Page)
  let allowed = new Set((await advertisablePages(ctx)).map((p) => p.id))
  if (wanted.some((id) => !allowed.has(id))) allowed = new Set((await advertisablePages(ctx, { fresh: true })).map((p) => p.id))
  for (const id of wanted) {
    if (!allowed.has(id)) {
      throw invalid(
        `Trang ${id} không nằm trong danh sách Trang mà tài khoản quảng cáo này được dùng để chạy quảng cáo.`,
        "Gọi ads_lookup kind=pages để lấy page_id hợp lệ."
      )
    }
  }
}

// ---------------------------------------------------------------------------
// meta_create_ad
// ---------------------------------------------------------------------------

const ctaInput = z
  .object({
    type: z.enum(CTA_TYPES),
    link: z.url().optional().describe("Mặc định = link của creative"),
    lead_gen_form_id: digits.optional().describe("Bắt buộc cho quảng cáo biểu mẫu khách hàng tiềm năng"),
  })
  .strict()

/** Google Drive image (cover / link image) - resolved and uploaded by mcp-core (ProviderExtension.driveImageRef). */
const driveImageInput = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .describe(
    "Ảnh trên Google Drive người dùng đưa (file_id / link Drive / mã drf_ từ drive_list_files, drive_sheet_read) - hệ thống tự tải lên khi xác nhận"
  )

const welcomeText = z.string().trim().min(1).max(300)
const welcomeMessageInput = z
  .union([
    welcomeText,
    z
      .object({
        text: welcomeText,
        ice_breakers: z
          .array(z.object({ title: z.string().trim().min(1).max(80), response: z.string().trim().min(1).max(300) }).strict())
          .max(4)
          .optional()
          .describe("Câu hỏi gợi ý khách bấm (tối đa 4): title ≤80 ký tự, response = câu trả lời tự động ≤300 ký tự"),
      })
      .strict(),
    z
      .object({
        from_ad_id: digits.describe(
          "Quảng cáo có sẵn (cùng tài khoản quảng cáo) đang dùng lời chào / mẫu lời chào đã lưu muốn dùng lại"
        ),
      })
      .strict(),
  ])
  .describe(
    "Lời chào khi khách mở Messenger từ quảng cáo (chỉ nhóm quảng cáo đích Messenger): văn bản ≤300 ký tự, {text, ice_breakers} " +
      "(dùng được {{user_first_name}}), hoặc {from_ad_id} = dùng lại NGUYÊN lời chào (cả nút / câu trả lời nhanh) của một quảng " +
      "cáo có sẵn - cách dùng mẫu lời chào đã lưu trong Trình quản lý quảng cáo: chọn quảng cáo đang dùng mẫu đó"
  )
type WelcomeMessageInput = z.infer<typeof welcomeMessageInput>

/** welcome_message {from_ad_id} resolved by readCopiedGreeting(): sent to Meta verbatim, shown sanitised. */
export interface CopiedGreeting {
  adId: string
  raw: string
  shown: GreetingShown
  /** Page of the source ad's creative (null = unknown) */
  page: string | null
}

const linkCreative = z
  .object({
    type: z.literal("link"),
    link: z.url().optional().describe("Trang đích - bắt buộc trừ nhóm quảng cáo nhắn tin"),
    message: z.string().max(5000).optional().describe("Văn bản chính"),
    headline: z.string().max(255).optional(),
    description: z.string().max(255).optional(),
    image_hash: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Từ ads_upload_media"),
    image_url: z.url().optional(),
    image_drive_file: driveImageInput.optional(),
    call_to_action: ctaInput.optional(),
    welcome_message: welcomeMessageInput.optional(),
  })
  .strict()

const videoCreative = z
  .object({
    type: z.literal("video"),
    video_id: digits.describe("Từ ads_upload_media type=video / ads_get_media_upload"),
    image_hash: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Ảnh bìa (thumbnail) từ ads_upload_media"),
    image_url: z.url().optional().describe("Ảnh bìa (thumbnail)"),
    image_drive_file: driveImageInput.optional(),
    message: z.string().max(5000).optional(),
    title: z.string().max(255).optional(),
    link: z.url().optional(),
    call_to_action: ctaInput.optional(),
    welcome_message: welcomeMessageInput.optional(),
  })
  .strict()

const existingPostCreative = z
  .object({
    type: z.literal("existing_post"),
    object_story_id: z.string().regex(/^\d+_\d+$/, "Dạng <PAGE_ID>_<POST_ID>."),
    call_to_action: ctaInput
      .optional()
      .describe(
        "Nút + link của quảng cáo (vd SHOP_NOW / SEE_DETAILS + link website cho quảng cáo livestream chuyển đổi). Bài live: nút đã gắn trên bài luôn thắng; bài chưa có nút thì nút này gắn luôn vào bài. Nhóm nhắn tin tự gắn nút nhắn tin - không truyền."
      ),
    welcome_message: welcomeMessageInput.optional(),
  })
  .strict()

export const createAdInput = z
  .object({
    adset_id: digits,
    name: objectName,
    page_id: digits.optional().describe("Trang chạy quảng cáo (ads_lookup kind=pages). Không cần với existing_post."),
    instagram_user_id: digits.optional().describe("Tài khoản Instagram (ads_lookup kind=instagram_accounts)"),
    creative: z.discriminatedUnion("type", [linkCreative, videoCreative, existingPostCreative]),
    url_tags: z.string().max(1024).optional().describe("Tham số UTM, vd utm_source=facebook&utm_campaign=..."),
    advantage_creative_opt_in: z
      .array(z.enum(CREATIVE_FEATURES))
      .default([])
      .describe("Tính năng Advantage+ creative muốn BẬT; mọi tính năng khác gửi OPT_OUT."),
  })
  .strict()
export type CreateAdInput = z.infer<typeof createAdInput>

/** Message CTAs and the app they open; a message CTA of ANOTHER app is the only CTA a messaging ad set refuses. */
const MESSAGE_CTA_APPS: Partial<Record<(typeof CTA_TYPES)[number], string>> = {
  MESSAGE_PAGE: "MESSENGER",
  WHATSAPP_MESSAGE: "WHATSAPP",
  INSTAGRAM_MESSAGE: "INSTAGRAM_DIRECT",
}

/** Buttons that need no landing page link (existing_post call_to_action) */
const CTA_WITHOUT_LINK: ReadonlySet<string> = new Set(["NO_BUTTON", "WATCH_LIVE_VIDEO", "MESSAGE_PAGE", "WHATSAPP_MESSAGE", "INSTAGRAM_MESSAGE", "CALL_NOW"])

/**
 * `appDestination` = the ad set is click-to-message: whatever CTA type (official CTM examples use LEARN_MORE as well
 * as MESSAGE_PAGE) carries value.app_destination and never value.link.
 */
function buildCta(
  cta: z.infer<typeof ctaInput> | undefined,
  fallbackLink: string | undefined,
  appDestination?: string
): Record<string, unknown> | undefined {
  if (!cta) return undefined
  const value: Record<string, unknown> = {}
  if (appDestination) value.app_destination = appDestination
  else if (cta.type === "MESSAGE_PAGE") value.app_destination = "MESSENGER"
  else if (cta.type === "WHATSAPP_MESSAGE") value.app_destination = "WHATSAPP"
  else if (cta.type === "INSTAGRAM_MESSAGE") value.app_destination = "INSTAGRAM_DIRECT"
  else if (cta.link ?? fallbackLink) value.link = cta.link ?? fallbackLink
  if (cta.lead_gen_form_id) value.lead_gen_form_id = cta.lead_gen_form_id
  return Object.keys(value).length ? { type: cta.type, value } : { type: cta.type }
}

// control (except newline), soft hyphen, bidi, zero-width and BOM characters (U+2028/2029 become newlines first): removed from text shown to customers in Messenger
const WELCOME_UNSAFE =
  /[\u0000-\u0009\u00AD\u180E\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g

function cleanWelcome(raw: string, field: string, max: number, singleLine: boolean): string {
  let s = raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/\t/g, " ")
  if (singleLine) s = s.replace(/\n+/g, " ")
  s = s.replace(WELCOME_UNSAFE, "").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  if (!s) throw invalid(`${field} trống (sau khi bỏ ký tự điều khiển).`)
  if (s.length > max) throw invalid(`${field} tối đa ${max} ký tự.`)
  return s
}

/**
 * welcome_message → page_welcome_message (meta.md §5 "Creative nhắn tin"): plain text, or Meta's VISUAL_EDITOR JSON
 * (as a string) when ice breakers are given. Text is sanitised; limits: text ≤300, title ≤80, response ≤300, ≤4 items.
 */
export function buildWelcomeMessage(
  w: WelcomeMessageInput,
  copied?: CopiedGreeting
): {
  value: string
  shown: GreetingShown
} {
  if (typeof w === "object" && "from_ad_id" in w) {
    // resolved before any payload is built (readCopiedGreeting); a mismatch is a programming error
    if (!copied || copied.adId !== w.from_ad_id) throw invalid(`Chưa đọc được lời chào của quảng cáo ${w.from_ad_id}.`)
    return { value: copied.raw, shown: { ...copied.shown, copied_from_ad_id: copied.adId } }
  }
  const raw = typeof w === "string" ? { text: w } : w
  const text = cleanWelcome(raw.text, "welcome_message.text", 300, false)
  const breakers = (raw.ice_breakers ?? []).map((b, i) => ({
    title: cleanWelcome(b.title, `welcome_message.ice_breakers[${i}].title`, 80, true),
    response: cleanWelcome(b.response, `welcome_message.ice_breakers[${i}].response`, 300, false),
  }))
  if (breakers.length > 4) throw invalid("welcome_message.ice_breakers tối đa 4 câu hỏi.")
  const titles = new Set(breakers.map((b) => b.title.toLowerCase()))
  if (titles.size !== breakers.length) throw invalid("welcome_message.ice_breakers có câu hỏi (title) bị trùng.")
  if (breakers.length === 0) return { value: text, shown: { text } }
  const value = JSON.stringify({
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "ice_breakers",
      message: { ice_breakers: breakers, quick_replies: [], text },
    },
    user_edit: false,
    surface: "visual_editor_new",
  })
  return { value, shown: { text, ice_breakers: breakers } }
}

/** welcome_message: only ad sets whose destination is MESSENGER (same refusal for every creative type and tool). */
function welcomeFor(
  w: WelcomeMessageInput,
  dest: MessagingDestination | null,
  copied?: CopiedGreeting
): ReturnType<typeof buildWelcomeMessage> {
  if (dest !== "MESSENGER") {
    throw invalid(
      dest
        ? `Lời chào tin nhắn (welcome_message) hiện chỉ hỗ trợ nhóm quảng cáo đích Messenger (nhóm này là ${dest}).`
        : "welcome_message chỉ dùng cho quảng cáo nhắn tin: nhóm quảng cáo phải có destination_type MESSENGER (mục tiêu CONVERSATIONS hoặc MESSAGING_PURCHASE_CONVERSION).",
      dest ? "Bỏ welcome_message." : "Bỏ welcome_message, hoặc tạo nhóm quảng cáo nhắn tin Messenger bằng meta_create_adset."
    )
  }
  return buildWelcomeMessage(w, copied)
}

function promotedPageId(v: unknown): string | null {
  const id = v && typeof v === "object" ? (v as { page_id?: unknown }).page_id : undefined
  return typeof id === "string" || typeof id === "number" ? String(id) : null
}

function pageMismatch(pageId: string, adsetPage: string): ProviderError {
  return invalid(
    `Trang ${pageId} khác Trang của nhóm quảng cáo nhắn tin (promoted_object.page_id = ${adsetPage}) - quảng cáo phải dùng đúng Trang nhận tin nhắn.`,
    `Dùng page_id ${adsetPage}.`
  )
}

export function buildAdPayload(input: CreateAdInput, adset: RawNode, warnings: string[], copied?: CopiedGreeting) {
  const c = input.creative
  const campaign = (adset.campaign ?? {}) as { objective?: string; promoted_object?: unknown }
  const goal = String(adset.optimization_goal ?? "")
  const creative: Record<string, unknown> = { name: `${input.name} - creative` }
  // click-to-message ad set (destination MESSENGER / WHATSAPP / INSTAGRAM_DIRECT): matching CTA, the ad set's Page
  const dest = messagingDestination(adset.destination_type)
  const msg = dest ? MESSAGING_DESTINATIONS[dest] : null
  const adsetPage = dest ? promotedPageId(adset.promoted_object) : null
  let welcome: ReturnType<typeof buildWelcomeMessage> | null = null

  if ((goal === "LEAD_GENERATION" || goal === "QUALITY_LEAD") && dest === "MESSENGER") {
    throw invalid(
      "Nhóm quảng cáo tìm khách hàng tiềm năng trong Messenger: Meta API không còn cho tạo quảng cáo loại này (từ v24.0) - hãy tạo trong Trình quản lý quảng cáo."
    )
  }

  if (c.type === "existing_post") {
    creative.object_story_id = c.object_story_id
    // E1: object_story_spec cannot go with object_story_id → the greeting is the top-level page_welcome_message
    if (c.welcome_message !== undefined) welcome = welcomeFor(c.welcome_message, dest, copied)
    if (msg) {
      // [M] CTM docs conflict (an example with object_story_id + creative-level CTA vs "object_story_id not supported"
      // in Limitations): only Messenger gets the documented CTA; WhatsApp / Instagram stay as before (untouched)
      if (dest === "MESSENGER") {
        const postPage = c.object_story_id.split("_")[0]!
        if (adsetPage && postPage !== adsetPage) throw pageMismatch(postPage, adsetPage)
        creative.call_to_action = { type: msg.cta, value: { app_destination: msg.app } }
        warnings.push(`Nhóm quảng cáo nhắn tin (${dest}): bài có sẵn được gắn nút ${msg.cta}.`)
      }
      warnings.push(
        "Bài có sẵn trong nhóm quảng cáo nhắn tin: Meta có thể không nhận (tài liệu Meta chưa thống nhất) - nếu bị từ chối, hãy tạo quảng cáo với creative mới (link / video)."
      )
    }
    if (c.call_to_action) {
      if (msg) {
        throw invalid(
          `Nhóm quảng cáo nhắn tin (${dest}) tự gắn nút nhắn tin cho bài có sẵn - bỏ call_to_action.`,
          "Bỏ call_to_action (nút MESSAGE_PAGE được gắn tự động)."
        )
      }
      const cta = c.call_to_action
      if (!cta.link && !cta.lead_gen_form_id && !CTA_WITHOUT_LINK.has(cta.type)) {
        throw invalid(`Nút ${cta.type} của bài có sẵn cần call_to_action.link (trang đích https).`)
      }
      creative.call_to_action = buildCta(cta, undefined)
      // live posts: the post's own button wins / the first ad's button sticks to the post (checkLivePostCta)
      if (!liveDestination(campaign)) warnings.push("Nút / link gắn ở cấp quảng cáo (creative) - bài viết gốc trên Trang không bị sửa.")
    }
    if (welcome) {
      creative.page_welcome_message = welcome.value
      warnings.push(
        "Lời chào của bài có sẵn gửi ở cấp creative (page_welcome_message): Meta có thể dùng lại creative cũ của cùng bài viết (không có lời chào) - hệ thống đọc lại sau khi tạo để kiểm tra."
      )
    }
  } else {
    if (!input.page_id) throw invalid("Cần page_id (Trang chạy quảng cáo).", "Gọi ads_lookup kind=pages.")
    if (c.welcome_message !== undefined) welcome = welcomeFor(c.welcome_message, dest, copied)
    let ctaIn = c.call_to_action
    if (msg) {
      if (!ctaIn) {
        ctaIn = { type: msg.cta }
        warnings.push(`Nhóm quảng cáo nhắn tin (${dest}): tự dùng nút ${msg.cta}.`)
      } else {
        const otherApp = MESSAGE_CTA_APPS[ctaIn.type]
        if (otherApp && otherApp !== msg.app) {
          throw invalid(
            `Nút ${ctaIn.type} mở ${otherApp}, không khớp nhóm quảng cáo đích ${dest} (dùng ${msg.cta} hoặc nút khác như LEARN_MORE).`,
            `Bỏ call_to_action để hệ thống tự chọn ${msg.cta}.`
          )
        }
        if (ctaIn.lead_gen_form_id) {
          throw invalid("Nhóm quảng cáo nhắn tin không dùng biểu mẫu khách hàng tiềm năng: bỏ call_to_action.lead_gen_form_id.")
        }
      }
      if (dest === "INSTAGRAM_DIRECT" && !input.instagram_user_id) {
        throw invalid("Quảng cáo nhắn tin Instagram Direct cần instagram_user_id.", "Gọi ads_lookup kind=instagram_accounts.")
      }
      if (adsetPage && input.page_id !== adsetPage) throw pageMismatch(input.page_id, adsetPage)
    }
    const spec: Record<string, unknown> = { page_id: input.page_id }
    if (input.instagram_user_id) spec.instagram_user_id = input.instagram_user_id
    const imageSources = [c.image_hash, c.image_url, c.image_drive_file].filter((v) => v !== undefined).length
    if (imageSources > 1) throw invalid("Chỉ truyền một trong image_hash, image_url hoặc image_drive_file.")
    if (c.type === "link") {
      let link = c.link
      if (!link) {
        if (!msg) throw invalid("Creative dạng link cần `link` (trang đích https).")
        if (msg.link) link = msg.link
      }
      if (imageSources === 0) warnings.push("Không có ảnh - Meta sẽ dùng ảnh lấy từ link (nếu có).")
      const linkData: Record<string, unknown> = link ? { link } : {}
      if (c.message) linkData.message = c.message
      if (c.headline) linkData.name = c.headline
      if (c.description) linkData.description = c.description
      if (c.image_hash) linkData.image_hash = c.image_hash
      if (c.image_url) linkData.picture = c.image_url
      const cta = buildCta(ctaIn, link, msg?.app)
      if (cta) linkData.call_to_action = cta
      if (welcome) linkData.page_welcome_message = welcome.value
      spec.link_data = linkData
    } else {
      // no cover given: applyCover() uses Meta's own thumbnail (ready video) - D1
      const videoData: Record<string, unknown> = { video_id: c.video_id }
      if (c.image_hash) videoData.image_hash = c.image_hash
      else if (c.image_url) videoData.image_url = c.image_url
      if (c.message) videoData.message = c.message
      if (c.title) videoData.title = c.title
      const cta = buildCta(ctaIn, c.link, msg?.app)
      if (cta) videoData.call_to_action = cta
      if (welcome) videoData.page_welcome_message = welcome.value
      spec.video_data = videoData
    }
    creative.object_story_spec = spec
  }
  creative.degrees_of_freedom_spec = {
    creative_features_spec: creativeFeaturesSpec(c.type, input.advantage_creative_opt_in),
  }
  if (input.url_tags) creative.url_tags = input.url_tags

  if ((goal === "LEAD_GENERATION" || goal === "QUALITY_LEAD") && c.type !== "existing_post") {
    if (!c.call_to_action?.lead_gen_form_id) {
      throw invalid("Nhóm quảng cáo tối ưu khách hàng tiềm năng cần call_to_action.lead_gen_form_id (biểu mẫu).")
    }
  }
  if (input.advantage_creative_opt_in.length) {
    warnings.push(`Bật Advantage+ creative: ${input.advantage_creative_opt_in.join(", ")}.`)
  }
  const payload: Record<string, unknown> = {
    name: input.name,
    adset_id: input.adset_id,
    status: "PAUSED",
    creative,
  }
  const summary: Record<string, unknown> = {
    name: input.name,
    adset_id: input.adset_id,
    objective: campaign.objective ?? null,
    optimization_goal: goal || null,
    status: "PAUSED",
    creative: structuredClone(creative),
  }
  if (dest) summary.destination_type = dest
  const live = liveDestination(campaign)
  if (live) {
    summary.live_video_destination = live
    warnings.push(LIVE_VIDEO_NOTES[1]!)
    if (c.type !== "existing_post") {
      warnings.push(
        "Chiến dịch quảng cáo video trực tiếp nhưng creative không phải bài live: dùng creative existing_post với id từ ads_lookup kind=live_videos."
      )
    } else if (!msg && !c.call_to_action) {
      warnings.push("Không có call_to_action: quảng cáo dùng nút / link sẵn có của bài live (nếu có).")
    }
  }
  if (welcome) summary.welcome_message = welcome.shown
  if (copied) {
    const target = adsetPage ?? (c.type === "existing_post" ? c.object_story_id.split("_")[0]! : (input.page_id ?? null))
    warnings.push(copiedGreetingNote(copied, target))
  }
  return { payload, summary }
}

/** Labels shown instead of a cover that is not uploaded yet / a signed Meta URL (never in previews or logs). */
export const META_AUTO_COVER_LABEL = "<ảnh bìa Meta tự chọn từ video>"
export function driveCoverLabel(label: string | undefined): string {
  return `<ảnh bìa từ Google Drive: ${label ?? "?"}>`
}

/** Error with every occurrence of the signed uri (and any fbcdn URL) removed - the uri must never leave the adapter. */
function scrubUri(e: unknown, uri: string): unknown {
  if (!isProviderError(e)) return e
  const clean = (s: string | undefined | null) =>
    s ? s.split(uri).join("[ảnh bìa]").replace(/https?:\/\/[^\s"']*fbcdn[^\s"']*/gi, "[ảnh bìa]") : s
  return new ProviderError({
    platform: e.platform,
    code: e.code,
    toolCode: e.toolCode,
    message: clean(e.message) ?? "meta error",
    userMessageVi: clean(e.userMessageVi) ?? "",
    hint: clean(e.hint) ?? undefined,
    retryable: e.retryable,
    retryAfterMs: e.retryAfterMs,
    upstream: e.upstream ? { ...e.upstream, message: clean(e.upstream.message ?? null) } : undefined,
  })
}

/**
 * Cover / link image of meta_create_ad (D1-D5). Mutates payload (what Meta gets) and summary (what is shown/logged).
 * Returns the signed uri used for validate_only (preview, to scrub from errors) and whether validate_only must be
 * skipped (preview of a Drive cover for a video whose own thumbnail is not available yet).
 */
function failedVideoNote(id: string, reason: string | null): string {
  return `Meta báo video ${id} xử lý thất bại${reason ? ` (${reason})` : ""} - quảng cáo nhiều khả năng bị từ chối; nên tải video lên lại.`
}

async function applyCover(
  ctx: ProviderContext<MetaCredentials>,
  c: CreateAdInput["creative"],
  creative: Record<string, unknown>,
  shownCreative: Record<string, unknown>,
  warnings: string[],
  opts: MutationOptions
): Promise<{ uri: string | null; skipValidate: boolean }> {
  if (c.type === "existing_post") return { uri: null, skipValidate: false }
  const key = c.type === "video" ? "video_data" : "link_data"
  const data = (creative.object_story_spec as Record<string, Record<string, unknown>>)[key]!
  const shown = (shownCreative.object_story_spec as Record<string, Record<string, unknown>>)[key]!
  const imageField = c.type === "video" ? "image_url" : "picture"

  if (c.image_drive_file !== undefined) {
    const label = driveCoverLabel(opts.driveImage?.label)
    const hash = opts.driveImage?.imageHash
    if (hash) {
      data.image_hash = shown.image_hash = hash
      shown.image_source = label
      return { uri: null, skipValidate: false }
    }
    if (!opts.dryRun) throw invalid("Lỗi nội bộ: ảnh Google Drive chưa được tải lên trước khi tạo quảng cáo.")
    // preview: nothing uploaded yet (D3)
    shown.image = `${label} - tải lên khi xác nhận`
    if (c.type === "link") return { uri: null, skipValidate: false } // validated without picture meanwhile
    // S-M1: the video's status is read only once it is known to belong to this ad account
    await ensureMetaVideoInAccount(ctx, c.video_id, opts)
    // validate_only needs a thumbnail: Meta's own (ready video) stands in for the Drive image, never shown
    let uri: string | null = null
    try {
      uri = await metaVideoCoverUri(ctx, c.video_id)
    } catch (e) {
      // a failed video is said (C-Low), like with an explicit cover; processing / no thumbnail → Meta checks later
      if (isProviderError(e) && e.toolCode === "video_failed") warnings.push(failedVideoNote(c.video_id, null))
    }
    if (uri) {
      data[imageField] = uri
      return { uri, skipValidate: false }
    }
    warnings.push("Chưa kiểm tra trước với Meta (validate_only) vì ảnh bìa Google Drive chỉ được tải lên khi xác nhận và video chưa có ảnh bìa Meta - Meta sẽ kiểm tra khi tạo.")
    return { uri: null, skipValidate: true }
  }

  if (c.type !== "video") return { uri: null, skipValidate: false }
  if (c.image_hash || c.image_url) {
    // explicit cover (D4): passed through, Meta decides; preview notes a video that is not ready (best effort)
    if (opts.dryRun) {
      // S-M1: no status read of a video not verified to be in this ad account (no warning then - Meta decides)
      const verified = await ensureMetaVideoInAccount(ctx, c.video_id, opts).then(
        () => true,
        () => false
      )
      const st = verified ? await readMetaVideo(callCtx(ctx), c.video_id).catch(() => null) : null
      if (st?.kind === "processing")
        warnings.push(`Video ${c.video_id} còn đang được Meta xử lý${st.progress !== null ? ` (${st.progress}%)` : ""} - Meta có thể từ chối hoặc duyệt chậm nếu tạo quảng cáo ngay.`)
      if (st?.kind === "failed") warnings.push(failedVideoNote(c.video_id, st.error))
    }
    return { uri: null, skipValidate: false }
  }

  // automatic cover (D1-D3): READY video only - processing → video_processing, failed → video_failed.
  // S-M1: an id not known to belong to this ad account → neutral not_found before any status / cover read.
  await ensureMetaVideoInAccount(ctx, c.video_id, opts)
  const uri = await metaVideoCoverUri(ctx, c.video_id, opts.deadlineAt)
  if (opts.dryRun) {
    data.image_url = uri
    shown.image = `${META_AUTO_COVER_LABEL} - tải lên khi xác nhận`
    warnings.push("Không có ảnh bìa: hệ thống sẽ tự dùng ảnh bìa Meta trích từ video (người dùng có thể đưa ảnh bìa riêng qua image_drive_file).")
    return { uri, skipValidate: false }
  }
  const hash = await uploadMetaCoverFromUri(ctx, uri, opts.fetchImage, opts.deadlineAt)
  data.image_hash = shown.image_hash = hash
  shown.image_source = META_AUTO_COVER_LABEL
  warnings.push(`Đã tự dùng ảnh bìa Meta trích từ video (image_hash ${hash}).`)
  return { uri: null, skipValidate: false }
}

/** live_video_destination of a campaign node (FACEBOOK / INSTAGRAM), null = not a live video campaign */
function liveDestination(campaign: { promoted_object?: unknown } | null | undefined): string | null {
  const v = rec(campaign?.promoted_object)?.live_video_destination
  return typeof v === "string" && v ? v : null
}

/** Goals that send people to a website: a Messenger button on the post would defeat them. */
const WEBSITE_GOALS = new Set(["OFFSITE_CONVERSIONS", "VALUE", "LINK_CLICKS", "LANDING_PAGE_VIEWS"])

/**
 * Live video ads (owner-checked 2026-11-12, meta.md §5 "Quảng cáo video trực tiếp"): the button stored ON the live
 * post (by Ads Manager or the first ad that used the post) is shown by EVERY ad of that post; the ad's own button
 * only sticks while the post has none. A post button that does not fit the ad → refused before any write.
 */
async function checkLivePostCta(
  ctx: ProviderContext<MetaCredentials>,
  postId: string,
  ownCta: { type?: unknown; link?: unknown } | null | undefined,
  adset: Record<string, unknown>,
  summary: Record<string, unknown>,
  warnings: string[],
  /** false = the ad already uses this post (its shown button does not change): a mismatch only warns */
  refuse = true
): Promise<void> {
  const dest = messagingDestination(adset.destination_type)
  const ownType = typeof ownCta?.type === "string" && ownCta.type ? ownCta.type : undefined
  const ownLink = typeof ownCta?.link === "string" && ownCta.link ? ownCta.link : undefined
  const wanted: string | undefined = dest ? MESSAGING_DESTINATIONS[dest].cta : ownType
  let cta: MetaPostCta | null
  try {
    cta = await readMetaPostCta(ctx, postId)
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") throw e
    warnings.push(
      "Không đọc được nút đang gắn trên bài live (via cần có vai trò trên Trang): nếu bài đã có nút, Meta hiện nút đó cho mọi quảng cáo dùng bài này."
    )
    return
  }
  summary.live_post_button = cta
  if (!cta) {
    warnings.push(
      wanted
        ? `Bài live chưa có nút: nút ${wanted} của quảng cáo này sẽ gắn luôn vào bài - mọi quảng cáo sau dùng bài này cũng hiện ${wanted}.`
        : "Bài live chưa có nút và quảng cáo không chọn nút (call_to_action)."
    )
    return
  }
  const shown = `${cta.type}${cta.link ? ` (${cta.link})` : ""}`
  const toMessenger = cta.type in MESSAGE_CTA_APPS
  const mismatch = wanted ? cta.type !== wanted : toMessenger && WEBSITE_GOALS.has(String(adset.optimization_goal ?? ""))
  if (mismatch) {
    const what = `Bài live ${postId} đã gắn nút ${shown} - Meta luôn hiện nút này cho mọi quảng cáo dùng bài, không đổi${wanted ? ` sang ${wanted}` : ""} được.`
    if (!refuse) {
      warnings.push(`${what} Quảng cáo này vẫn dùng bài đó nên nút hiển thị không đổi.`)
    } else {
      throw invalid(
        what,
        `Dùng bài live khác chưa có nút (ads_lookup kind=live_videos cho biết nút của từng bài), hoặc đặt quảng cáo này vào nhóm hợp với nút ${cta.type}${toMessenger ? " (nhóm nhắn tin)" : " (bỏ call_to_action hoặc dùng đúng nút này)"}.`
      )
    }
  }
  if (ownLink && cta.link && cta.link !== ownLink) {
    warnings.push(`Bài live đã gắn link ${cta.link}: quảng cáo hiện link này, không phải ${ownLink}.`)
  }
  if (!wanted) warnings.push(`Quảng cáo hiện nút ${shown} đang gắn trên bài live.`)
}

const createAd: ProviderExtension<MetaCredentials, CreateAdInput, MetaWriteResult> = {
  name: "meta_create_ad",
  permission: "create",
  title: "Tạo quảng cáo Meta",
  description:
    "Dùng khi cần tạo quảng cáo trong một nhóm quảng cáo Meta đã có (adset_id từ ads_list_objects hoặc " +
    "meta_create_adset). Quảng cáo luôn TẠM DỪNG khi tạo và phải qua Meta duyệt. Creative tạo kèm: " +
    "`link` (ảnh + link), `video` (video_id từ ads_upload_media / ads_get_media_upload) hoặc `existing_post` " +
    "(object_story_id dạng PAGEID_POSTID; nhóm Messenger thêm được welcome_message). Ảnh (link) / ảnh bìa (video): truyền MỘT trong image_hash (ads_upload_media), " +
    "image_url, hoặc image_drive_file = ảnh Google Drive người dùng đưa (file_id / link Drive / drf_ từ drive_list_files, " +
    "drive_sheet_read) - tự tải ảnh lên khi xác nhận (dùng lại nếu đã tải). Video không có ảnh bìa: hệ thống tự " +
    "lấy ảnh bìa Meta trích từ video khi video đã sẵn sàng; đang xử lý → lỗi video_processing (thử lại sau " +
    "hoặc đưa ảnh bìa), video lỗi → video_failed (tải lên lại). Cần page_id (ads_lookup kind=pages) trừ khi dùng bài " +
    "có sẵn; instagram_user_id tuỳ chọn (ads_lookup kind=instagram_accounts). Nhóm nhắn tin (destination MESSENGER/" +
    "WHATSAPP/INSTAGRAM_DIRECT): thiếu nút thì tự đặt nút nhắn tin khớp, link tuỳ chọn, page_id phải " +
    "là Trang của nhóm; welcome_message (chỉ Messenger) = lời chào + ≤4 câu hỏi gợi ý, hoặc {from_ad_id} = dùng lại " +
    "nguyên lời chào / mẫu lời chào đã lưu (cả nút) của quảng cáo có sẵn; quảng cáo đã có thì dùng " +
    "meta_update_ad_creative. Mọi tính năng Advantage+ creative gửi OPT_OUT trừ khi liệt kê trong advantage_creative_opt_in. Quảng cáo biểu " +
    "mẫu cần call_to_action.lead_gen_form_id. url_tags để gắn UTM.",
  input: createAdInput,
  write: true,
  driveImageRef: (input) => (input.creative.type === "existing_post" ? undefined : input.creative.image_drive_file),
  // automatic video cover: downloads Meta's own thumbnail through mcp-core's guarded fetch
  fetchesPlatformImages: true,
  async run(ctx, input, opts) {
    const adset = await readNode(ctx, "adset", input.adset_id, [
      "id",
      "name",
      "optimization_goal",
      "destination_type",
      "promoted_object",
      "campaign{id,objective,promoted_object}",
    ])
    const warnings: string[] = ["Quảng cáo được tạo ở trạng thái TẠM DỪNG và cần Meta duyệt trước khi chạy."]
    const copied = await readCopiedGreeting(ctx, input.creative.welcome_message)
    const { payload, summary } = buildAdPayload(input, adset, warnings, copied)
    // dry run AND execute: page_id and the Page of an existing post (PAGEID_POSTID) must be advertisable
    const postPage = input.creative.type === "existing_post" ? input.creative.object_story_id.split("_")[0] : undefined
    await assertAdvertisablePages(ctx, [input.page_id, postPage])
    // live video post: the button stored on the post wins for every ad (dry run AND execute - a read only)
    if (liveDestination(rec(adset.campaign)) && input.creative.type === "existing_post") {
      await checkLivePostCta(ctx, input.creative.object_story_id, input.creative.call_to_action, adset, summary, warnings)
    }
    const cover = await applyCover(
      ctx,
      input.creative,
      payload.creative as Record<string, unknown>,
      summary.creative as Record<string, unknown>,
      warnings,
      opts
    )
    try {
      const res = await runCreate(ctx, "ads", payload, summary, warnings, opts, "ad", { skipValidate: cover.skipValidate })
      // E1: existing post + greeting - Meta may have reused the post's old creative (dedupe): read back, warn only
      const sent = (payload.creative as Record<string, unknown>).page_welcome_message
      if (!res.preview && typeof sent === "string" && res.createdIds?.[0]) await checkAdGreeting(ctx, res.createdIds[0], sent, warnings)
      return res
    } catch (e) {
      throw cover.uri ? scrubUri(e, cover.uri) : e
    }
  },
}

// ---------------------------------------------------------------------------
// meta_update_targeting
// ---------------------------------------------------------------------------

export const updateTargetingInput = z
  .object({
    adset_id: digits,
    targeting: targetingInput,
    merge: z
      .boolean()
      .default(true)
      .describe("true = chỉ thay các trường truyền vào, giữ phần còn lại; false = thay toàn bộ targeting."),
  })
  .strict()
export type UpdateTargetingInput = z.infer<typeof updateTargetingInput>

const updateTargeting: ProviderExtension<MetaCredentials, UpdateTargetingInput, MetaWriteResult> = {
  name: "meta_update_targeting",
  permission: "update",
  title: "Sửa nhắm mục tiêu nhóm quảng cáo Meta",
  description:
    "Dùng khi cần đổi nhắm mục tiêu (vị trí, tuổi, giới tính, sở thích, đối tượng tuỳ chỉnh, vị trí hiển thị, " +
    "Advantage+ audience) của một nhóm quảng cáo Meta. Gọi ads_get_object level=ad_group trước để xem targeting hiện " +
    "tại; tra id vị trí/sở thích bằng ads_lookup. Mặc định merge=true: chỉ thay các trường được truyền; merge=false " +
    "thay toàn bộ (khi đó bắt buộc có vị trí). Luôn gửi rõ advantage_audience (giữ giá trị hiện tại nếu không truyền). " +
    "Nhóm đang chạy sẽ áp dụng ngay và có thể quay lại giai đoạn học.",
  input: updateTargetingInput,
  write: true,
  async run(ctx, input, opts) {
    const adset = await readNode(ctx, "adset", input.adset_id, [
      "id",
      "name",
      "status",
      "effective_status",
      "targeting",
      "dsa_beneficiary",
      "dsa_payor",
    ])
    const problems = targetingProblems(input.targeting)
    if (problems.length) throw invalid(problems.join(" "))
    if (!input.merge && !hasGeo(input.targeting)) throw invalid("Thay toàn bộ targeting cần ít nhất một vị trí.")
    const current = (adset.targeting ?? {}) as Record<string, unknown>
    const next = buildTargeting(input.targeting, input.merge ? current : undefined)
    if (!input.merge && next.age_min === undefined) next.age_min = 18
    // placement rules on the MERGED targeting: the ad set's current placements count too (B5)
    const placements = placementProblems(next)
    if (placements.errors.length) throw invalid(placements.errors.join(" "))

    const warnings: string[] = [...placements.warnings]
    const geo = (next.geo_locations ?? {}) as { countries?: string[] }
    const eu = euCountriesIn(geo)
    if (eu.length && (!adset.dsa_beneficiary || !adset.dsa_payor)) {
      warnings.push(`Nhắm tới nước EU (${eu.join(", ")}) nhưng nhóm chưa có dsa_beneficiary/dsa_payor - Meta có thể từ chối.`)
    }
    if (adset.effective_status === "ACTIVE") warnings.push("Nhóm đang chạy - thay đổi áp dụng ngay và có thể quay lại giai đoạn học.")
    const change: FieldChange = {
      objectId: adset.id,
      objectName: typeof adset.name === "string" ? adset.name : adset.id,
      level: "ad_group",
      field: "targeting",
      before: current,
      after: next,
    }
    const params = { targeting: next }
    // Preview from reads only: validate_only is documented for create edges, not for POST /{id} updates.
    if (opts.dryRun) return { preview: true, changes: [change], warnings, payload: params }
    await graph(callCtx(ctx), { method: "POST", path: adset.id, params, idempotent: true })
    return { preview: false, changes: [change], warnings, payload: params }
  },
}

// ---------------------------------------------------------------------------
// Greetings stored on creatives (E1 read-back, meta_update_ad_creative before / after)
// ---------------------------------------------------------------------------

type GreetingShown = {
  text: string
  ice_breakers?: { title: string; response: string }[]
  /** quick-reply buttons (titles) of a greeting made in Ads Manager / a saved template */
  quick_replies?: string[]
  /** buttons of a structured greeting (Ads Manager "JSON_SETUP" / saved template: Messenger button template) */
  buttons?: { title: string; type?: string; url?: string }[]
  /** saved greeting template the greeting comes from (Ads Manager), when Meta stored it */
  template_id?: string
  /** welcome_message {from_ad_id}: the ad the greeting was copied from */
  copied_from_ad_id?: string
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function idStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null
}

/** A greeting in a comparable / displayable form (raw, unsanitised strings). */
interface ParsedGreeting {
  text: string
  iceBreakers: { title: string; response: string }[]
  quickReplies: string[]
  buttons: { title: string; type?: string; url?: string }[]
  templateId: string | null
  /** JSON_SETUP structured message (Messenger text up to 640 characters) */
  structured: boolean
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Titles of quick replies (strings or {title} / {text} objects). */
function quickReplyTitles(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((q) => (typeof q === "string" ? q.trim() : str(rec(q)?.title) || str(rec(q)?.text))).filter((t) => t !== "")
}

/**
 * page_welcome_message as stored by Meta (meta.md §5 "Creative nhắn tin"): plain text; VISUAL_EDITOR JSON
 * (text_format.message: text / ice_breakers / quick_replies - what this app sends); or Ads Manager's JSON_SETUP
 * (saved templates, tested 2026-11-12: {type:"JSON_SETUP", template_id, message_data:{message:{text | attachment:
 * {type:"template", payload:{template_type:"button", text, buttons}}, quick_replies}}}). Other JSON → no text.
 */
function parseGreeting(raw: string): ParsedGreeting {
  const out: ParsedGreeting = { text: "", iceBreakers: [], quickReplies: [], buttons: [], templateId: null, structured: false }
  let j: Record<string, unknown> | null = null
  if (raw.trim().startsWith("{")) {
    try {
      j = rec(JSON.parse(raw))
    } catch {
      j = null
    }
  }
  if (!j) return { ...out, text: raw.trim() }
  out.templateId = idStr(j.template_id)
  const ve = rec(rec(j.text_format)?.message)
  if (ve) {
    out.text = str(ve.text)
    out.iceBreakers = Array.isArray(ve.ice_breakers)
      ? ve.ice_breakers.map((b) => ({ title: str(rec(b)?.title), response: str(rec(b)?.response) }))
      : []
    out.quickReplies = quickReplyTitles(ve.quick_replies)
    return out
  }
  const msg = rec(rec(j.message_data)?.message)
  if (msg) {
    out.structured = true
    const payload = rec(rec(msg.attachment)?.payload)
    const element = Array.isArray(payload?.elements) ? rec(payload.elements[0]) : null
    out.text = str(msg.text) || str(payload?.text) || str(element?.title)
    const buttons = Array.isArray(payload?.buttons) ? payload.buttons : Array.isArray(element?.buttons) ? element.buttons : []
    out.buttons = buttons
      .map((b) => rec(b))
      .filter((b): b is Record<string, unknown> => !!b && str(b.title) !== "")
      .map((b) => ({ title: str(b.title), ...(str(b.type) ? { type: str(b.type) } : {}), ...(str(b.url) ? { url: str(b.url) } : {}) }))
    out.quickReplies = quickReplyTitles(msg.quick_replies)
  }
  return out
}

/** A stored greeting (plain text, VISUAL_EDITOR or JSON_SETUP JSON) as safe display data - platform data, never instructions. */
export function greetingShown(raw: unknown): GreetingShown | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const p = parseGreeting(raw)
  const label = (s: string, max: number) => sanitizeExternalLabel(s, max) ?? ""
  const shown: GreetingShown = { text: label(p.text, p.structured ? 640 : 300) }
  if (p.iceBreakers.length) {
    shown.ice_breakers = p.iceBreakers.slice(0, 4).map((b) => ({ title: label(b.title, 80), response: label(b.response, 300) }))
  }
  const replies = p.quickReplies.slice(0, 13).map((t) => label(t, 80)).filter((t) => t !== "")
  if (replies.length) shown.quick_replies = replies
  if (p.buttons.length) {
    shown.buttons = p.buttons.slice(0, 3).map((b) => ({
      title: label(b.title, 80),
      ...(b.type ? { type: label(b.type, 40) } : {}),
      ...(b.url ? { url: label(b.url, 500) } : {}),
    }))
  }
  if (p.templateId) shown.template_id = p.templateId
  return shown
}

/** What must survive Meta's storage: text, ice breakers, quick replies, buttons (Meta may re-serialise the JSON). */
function greetingKey(raw: string): string {
  const p = parseGreeting(raw)
  return JSON.stringify([
    p.text,
    p.iceBreakers.map((b) => [b.title, b.response]),
    p.quickReplies,
    p.buttons.map((b) => [b.title, b.type ?? "", b.url ?? ""]),
  ])
}

/** Is the greeting Meta stored the one we sent? (Meta may return an existing creative of the same post - dedupe.) */
export function greetingVerdict(sent: string, got: unknown): "match" | "missing" | "different" {
  if (typeof got !== "string" || !got.trim()) return "missing"
  return greetingKey(got) === greetingKey(sent) ? "match" : "different"
}

/**
 * Greeting of a creative: top level (existing post), object_story_spec.link_data / video_data, or
 * asset_feed_spec.additional_data (flexible creatives made in Ads Manager - meta.md §5 "Creative nhắn tin").
 */
function creativeGreeting(c: Record<string, unknown> | null): string | null {
  if (!c) return null
  if (typeof c.page_welcome_message === "string" && c.page_welcome_message.trim()) return c.page_welcome_message
  const spec = rec(c.object_story_spec)
  for (const k of ["link_data", "video_data"]) {
    const g = rec(spec?.[k])?.page_welcome_message
    if (typeof g === "string" && g.trim()) return g
  }
  const extra = rec(rec(c.asset_feed_spec)?.additional_data)?.page_welcome_message
  if (typeof extra === "string" && extra.trim()) return extra
  return null
}

/** Page of a creative: object_story_spec.page_id, else the PAGEID of object_story_id / effective_object_story_id. */
function creativePage(c: Record<string, unknown> | null): string | null {
  if (!c) return null
  const fromSpec = idStr(rec(c.object_story_spec)?.page_id)
  if (fromSpec) return fromSpec
  for (const k of ["object_story_id", "effective_object_story_id"]) {
    const v = c[k]
    if (typeof v === "string" && /^\d+_\d+$/.test(v)) return v.split("_")[0]!
  }
  return null
}

/** Longest greeting copied verbatim (Meta's own JSON: saved templates with buttons are a few KB) */
const COPIED_GREETING_MAX = 20_000

/**
 * welcome_message {from_ad_id}: the greeting stored on an existing ad of THIS ad account (readNode: other accounts →
 * not_found), e.g. an ad made in Ads Manager with a saved greeting template. Sent back to Meta verbatim (buttons /
 * quick replies kept - Meta validates it again: validate_only in the preview); only a sanitised copy is shown.
 */
export async function readCopiedGreeting(
  ctx: ProviderContext<MetaCredentials>,
  w: WelcomeMessageInput | undefined
): Promise<CopiedGreeting | undefined> {
  if (!w || typeof w !== "object" || !("from_ad_id" in w)) return undefined
  const ad = await readNode(ctx, "ad", w.from_ad_id, [
    "name",
    "creative{id,object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec,page_welcome_message}",
  ])
  const c = rec(ad.creative)
  const raw = creativeGreeting(c)
  const choose =
    "Xem lời chào của quảng cáo bằng ads_get_object level=ad; chọn quảng cáo khác đang dùng mẫu lời chào, hoặc truyền welcome_message dạng văn bản / {text, ice_breakers}."
  if (!raw) {
    const flow = idStr(rec(rec(c?.asset_feed_spec)?.additional_data)?.partner_app_welcome_message_flow_id)
    throw invalid(
      flow
        ? `Quảng cáo ${ad.id} dùng luồng chào của ứng dụng đối tác (partner app, flow ${flow}) - chưa hỗ trợ dùng lại.`
        : `Quảng cáo ${ad.id} không có lời chào tin nhắn để dùng lại.`,
      choose
    )
  }
  if (raw.length > COPIED_GREETING_MAX) throw invalid(`Lời chào của quảng cáo ${ad.id} quá dài để dùng lại.`, choose)
  if (raw.trim().startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (!rec(parsed)) throw invalid(`Lời chào của quảng cáo ${ad.id} không đúng định dạng của Meta - không dùng lại được.`, choose)
  }
  return { adId: ad.id, raw, shown: greetingShown(raw) ?? { text: "" }, page: creativePage(c) }
}

/** Shown when a greeting is copied: where it comes from, and a different Page (saved templates belong to a Page). */
function copiedGreetingNote(copied: CopiedGreeting, targetPage: string | null): string {
  const base = `Lời chào lấy nguyên từ quảng cáo ${copied.adId} (giữ cả nút / câu trả lời nhanh nếu có).`
  return copied.page && targetPage && copied.page !== targetPage
    ? `${base} Quảng cáo nguồn thuộc Trang ${copied.page}, khác Trang ${targetPage} của quảng cáo này - kiểm tra lời chào có phù hợp không.`
    : base
}

/**
 * meta_create_ad, existing post + welcome message (E1): Meta may return the existing creative of the same post
 * without the greeting - read the new ad's creative back and warn (the ad exists either way, not a failure).
 */
async function checkAdGreeting(ctx: ProviderContext<MetaCredentials>, adId: string, sent: string, warnings: string[]): Promise<void> {
  let node: RawNode
  try {
    node = await graph<RawNode>(callCtx(ctx), {
      method: "GET",
      path: adId,
      params: { fields: "id,creative{id,page_welcome_message}" },
      idempotent: true,
    })
  } catch {
    warnings.push("Không đọc lại được creative của quảng cáo mới để kiểm tra lời chào - xem lại bằng ads_get_object (level=ad).")
    return
  }
  const cr = rec(node.creative)
  const verdict = greetingVerdict(sent, cr?.page_welcome_message)
  if (verdict === "match") return
  warnings.push(
    `Quảng cáo đã được tạo nhưng creative ${idStr(cr?.id) ?? "?"} ${verdict === "missing" ? "KHÔNG có lời chào" : "có lời chào KHÁC lời chào vừa gửi"} (Meta có thể đã dùng lại creative cũ của cùng bài viết). Thêm / sửa lời chào bằng meta_update_ad_creative (ad_id ${adId}, welcome_message).`
  )
}

// ---------------------------------------------------------------------------
// meta_update_ad_creative (v1.1.4, E2): change the creative of an EXISTING ad (greeting / new content / creative id).
// Creatives are immutable on Meta (POST /{creative_id} takes name/status only - 100/1815573): a new creative is made
// under act_X/adcreatives, read back when it carries a greeting (dedupe of object_story_id creatives), then attached
// with POST /{ad_id} creative={"creative_id"}. The ad keeps its id, status and stats; Meta reviews it again.
// ---------------------------------------------------------------------------

export const updateAdCreativeInput = z
  .object({
    ad_id: digits.describe("Quảng cáo cần đổi (ads_list_objects level=ad)"),
    welcome_message: welcomeMessageInput.optional(),
    creative: z.discriminatedUnion("type", [linkCreative, videoCreative, existingPostCreative]).optional(),
    creative_id: digits.optional().describe("Creative có sẵn của cùng tài khoản quảng cáo"),
    page_id: digits
      .optional()
      .describe("Chỉ với creative link / video: Trang chạy quảng cáo (mặc định Trang của nhóm nhắn tin / creative hiện tại)"),
    instagram_user_id: digits.optional().describe("Chỉ với creative mới (ads_lookup kind=instagram_accounts)"),
    url_tags: z.string().max(1024).optional().describe("UTM của creative mới (khi chỉ đổi lời chào: mặc định giữ UTM hiện tại)"),
    advantage_creative_opt_in: z
      .array(z.enum(CREATIVE_FEATURES))
      .default([])
      .describe("Tính năng Advantage+ creative muốn BẬT cho creative mới; mọi tính năng khác gửi OPT_OUT."),
  })
  .strict()
export type UpdateAdCreativeInput = z.infer<typeof updateAdCreativeInput>

const CREATIVE_READ_FIELDS =
  "id,name,status,object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec,product_set_id,call_to_action,call_to_action_type,page_welcome_message,url_tags,instagram_user_id,authorization_category,platform_customizations"

const AD_FOR_SWAP_FIELDS = [
  "name",
  "status",
  "effective_status",
  "adset{id,name,status,effective_status,destination_type,promoted_object,optimization_goal,is_dynamic_creative}",
  "campaign{id,name,status,effective_status,objective,smart_promotion_type,promoted_object}",
  `creative{${CREATIVE_READ_FIELDS}}`,
]

/** Shown with every preview / result of meta_update_ad_creative. */
export const AD_CREATIVE_SWAP_NOTES = [
  "Quảng cáo giữ nguyên ID, trạng thái và số liệu - chỉ creative (nội dung) được thay.",
  "Meta sẽ duyệt lại quảng cáo sau khi đổi creative (trạng thái có thể tạm là Đang xét duyệt).",
  "Đổi creative là thay đổi lớn: nhóm quảng cáo có thể quay lại giai đoạn học.",
  "Hệ thống không bật / tắt quảng cáo: quảng cáo đang chạy sẽ chạy tiếp sau khi Meta duyệt, đang tạm dừng thì vẫn tạm dừng.",
]
const GREETING_DEDUPE_NOTE =
  "Meta có thể dùng lại creative cũ của bài viết (không có lời chào); nếu vậy hệ thống dừng, không đổi gì trên quảng cáo."
const GREETING_NOT_COPIED_NOTE =
  "Creative mới không chép tính năng Advantage+ creative của creative cũ (gửi OPT_OUT như khi tạo, trừ advantage_creative_opt_in) và các tuỳ chỉnh nâng cao (cắt ảnh, tuỳ chỉnh theo vị trí hiển thị, tuyên bố miễn trừ…)."
const SOCIAL_PROOF_NOTE =
  "Creative mới không dùng bài viết hiện tại của quảng cáo: lượt thích / bình luận / chia sẻ của bài cũ sẽ không còn hiển thị trên quảng cáo."

/** object_story_spec keys copied when only the greeting changes (documented AdCreativeLinkData / VideoData fields; carousel refused). */
const LINK_DATA_KEYS = [
  "link",
  "message",
  "name",
  "description",
  "caption",
  "image_hash",
  "picture",
  "call_to_action",
]
const VIDEO_DATA_KEYS = ["video_id", "image_hash", "image_url", "message", "title", "link_description", "call_to_action"]
const CURRENT_IMAGE_LABEL = "<ảnh hiện tại của creative>"
const SIGNED_URL = /^https?:\/\/[^\s"']*(fbcdn|fbsbx)[^\s"']*$/i
/** legacy Advantage+ shopping / app campaigns: no API updates since 2026-05-19 (meta.md §1) */
const LEGACY_SMART = new Set(["AUTOMATED_SHOPPING_ADS", "SMART_APP_PROMOTION"])

function deadOf(n: Record<string, unknown> | null): string | null {
  for (const v of [n?.status, n?.effective_status]) if (v === "ARCHIVED" || v === "DELETED") return v
  return null
}

function refuseDead(what: string, id: string, status: string | null): void {
  if (!status) return
  throw invalid(
    `${what} ${id} đang ở trạng thái ${status} (đã lưu trữ / đã xoá) - Meta không cho đổi creative.`,
    "Tạo quảng cáo mới bằng meta_create_ad (hoặc sao chép bằng ads_copy_object)."
  )
}

function assertSwappable(
  ad: RawNode,
  adset: Record<string, unknown>,
  campaign: Record<string, unknown>,
  old: Record<string, unknown> | null
): void {
  refuseDead("Quảng cáo", ad.id, deadOf(ad))
  refuseDead("Nhóm quảng cáo chứa quảng cáo", idStr(adset.id) ?? "?", deadOf(adset))
  refuseDead("Chiến dịch chứa quảng cáo", idStr(campaign.id) ?? "?", deadOf(campaign))
  if (typeof campaign.smart_promotion_type === "string" && LEGACY_SMART.has(campaign.smart_promotion_type)) {
    throw invalid(
      "Chiến dịch Advantage+ mua sắm / ứng dụng kiểu cũ: Meta không còn cho sửa qua API (từ 2026-05-19).",
      "Tạo chiến dịch mới bằng meta_create_campaign, hoặc sửa trong Trình quản lý quảng cáo."
    )
  }
  if (adset.is_dynamic_creative === true) {
    throw invalid(
      "Nhóm quảng cáo dùng Dynamic Creative (Meta tự phối nội dung): không đổi creative qua công cụ này.",
      "Sửa trong Trình quản lý quảng cáo, hoặc tạo nhóm / quảng cáo mới."
    )
  }
  if (rec(old?.asset_feed_spec)) {
    throw invalid(
      "Creative hiện tại có nhiều phương án nội dung (asset_feed_spec - định dạng linh hoạt / Dynamic Creative): Meta không cho thay bằng creative thường.",
      "Tạo quảng cáo mới bằng meta_create_ad rồi tạm dừng quảng cáo cũ."
    )
  }
  if (idStr(old?.product_set_id) || idStr(rec(adset.promoted_object)?.product_set_id)) {
    throw invalid("Quảng cáo danh mục sản phẩm (catalog): không đổi creative qua công cụ này.", "Sửa trong Trình quản lý quảng cáo.")
  }
}

/** CTA of a Messenger creative: keep a Messenger message CTA (or any CTA already opening Messenger), else MESSAGE_PAGE. */
function messengerCta(old: unknown): Record<string, unknown> {
  const o = rec(old)
  const type = typeof o?.type === "string" && (CTA_TYPES as readonly string[]).includes(o.type) ? (o.type as (typeof CTA_TYPES)[number]) : null
  const app = type ? MESSAGE_CTA_APPS[type] : undefined
  const keep = type !== null && (app === "MESSENGER" || (!app && rec(o?.value)?.app_destination === "MESSENGER"))
  return { type: keep ? type : "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }
}

function hasContent(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false
  if (Array.isArray(v)) return v.length > 0
  return typeof v !== "object" || Object.keys(v as object).length > 0
}

/** Preview / log copy of a greeting-mode creative: texts read from Meta (platform data) sanitised and capped. */
const SHOWN_TEXT_CAPS: Record<string, number> = {
  message: 500,
  name: 255,
  description: 255,
  caption: 255,
  title: 255,
  link_description: 255,
  link: 500,
}
function cleanShown(c: Record<string, unknown>): Record<string, unknown> {
  if (typeof c.name === "string") c.name = sanitizeExternalLabel(c.name, 400) ?? ""
  const spec = rec(c.object_story_spec)
  for (const k of ["link_data", "video_data"]) {
    const d = rec(spec?.[k])
    if (!d) continue
    for (const [f, cap] of Object.entries(SHOWN_TEXT_CAPS)) if (typeof d[f] === "string") d[f] = sanitizeExternalLabel(d[f], cap) ?? ""
  }
  return c
}

/**
 * Mode welcome_message: the current content with a new greeting. object_story_spec link_data / video_data (preferred:
 * object_story_id may then be the dark post) → documented keys copied + *_data.page_welcome_message; else an existing
 * post → {object_story_id, Messenger CTA, top-level page_welcome_message}; carousel, platform_customizations and any
 * other shape are refused (no degraded copy). `signed` = image URLs read from Meta (sent to Meta only, never shown).
 */
function buildGreetingCreative(
  old: Record<string, unknown> | null,
  welcome: ReturnType<typeof buildWelcomeMessage>,
  input: UpdateAdCreativeInput,
  name: string,
  warnings: string[]
): { creative: Record<string, unknown>; page: string | null; signed: string[] } {
  const creative: Record<string, unknown> = { name }
  const signed: string[] = []
  const postId = typeof old?.object_story_id === "string" && /^\d+_\d+$/.test(old.object_story_id) ? old.object_story_id : null
  const spec = rec(old?.object_story_spec)
  const specKey = rec(spec?.video_data) ? "video_data" : rec(spec?.link_data) ? "link_data" : null
  const toNewContent = "Dùng tham số creative (link / video kèm welcome_message) để tạo nội dung mới."
  if (hasContent(old?.platform_customizations)) {
    throw invalid(
      "Creative hiện tại có tuỳ chỉnh theo nền tảng / vị trí hiển thị (platform_customizations) - không chép an toàn được để chỉ thêm lời chào.",
      toNewContent
    )
  }
  let format: "link" | "video" | "existing_post"
  let page: string | null
  if (old && spec && specKey) {
    const src = rec(spec[specKey])!
    if (specKey === "link_data" && hasContent(src.child_attachments)) {
      throw invalid("Quảng cáo băng chuyền (carousel): không thể chỉ thêm lời chào qua công cụ này.", toNewContent)
    }
    format = specKey === "video_data" ? "video" : "link"
    const data: Record<string, unknown> = {}
    for (const k of specKey === "video_data" ? VIDEO_DATA_KEYS : LINK_DATA_KEYS) {
      if (src[k] !== undefined && src[k] !== null) data[k] = structuredClone(src[k])
    }
    if (data.image_hash) {
      delete data.picture
      delete data.image_url
    }
    for (const k of ["picture", "image_url"]) if (typeof data[k] === "string") signed.push(data[k] as string)
    data.call_to_action = messengerCta(src.call_to_action)
    data.page_welcome_message = welcome.value
    const outSpec: Record<string, unknown> = {}
    page = idStr(spec.page_id)
    if (page) outSpec.page_id = page
    const ig = idStr(spec.instagram_user_id)
    if (ig) outSpec.instagram_user_id = ig
    outSpec[specKey] = data
    creative.object_story_spec = outSpec
    warnings.push(
      "Creative hiện tại được tạo từ nội dung (không phải bài có sẵn): Meta tạo bài quảng cáo mới, lượt thích / bình luận / chia sẻ của bài cũ sẽ không còn hiển thị trên quảng cáo."
    )
  } else if (old && postId) {
    format = "existing_post"
    page = postId.split("_")[0]!
    creative.object_story_id = postId
    creative.call_to_action = messengerCta(old.call_to_action)
    creative.page_welcome_message = welcome.value
    const ig = idStr(old.instagram_user_id)
    if (ig) creative.instagram_user_id = ig
    warnings.push("Giữ nguyên bài viết đang quảng cáo (lượt thích / bình luận giữ nguyên); lời chào gửi ở cấp creative (page_welcome_message).")
    warnings.push(GREETING_DEDUPE_NOTE)
  } else {
    throw invalid(
      "Creative hiện tại của quảng cáo không phải bài viết có sẵn hay ảnh / video + link (vd bộ sưu tập, danh mục, nhiều phương án nội dung) - không thể chỉ thêm lời chào.",
      "Dùng tham số creative (link / video / existing_post kèm welcome_message) để thay nội dung mới."
    )
  }
  const auth = old?.authorization_category
  if (typeof auth === "string" && auth !== "" && auth !== "NONE") creative.authorization_category = auth
  const tags = input.url_tags ?? (typeof old?.url_tags === "string" && old.url_tags ? old.url_tags : undefined)
  creative.degrees_of_freedom_spec = { creative_features_spec: creativeFeaturesSpec(format, input.advantage_creative_opt_in) }
  if (tags) creative.url_tags = tags
  warnings.push(GREETING_NOT_COPIED_NOTE)
  return { creative, page, signed }
}

/** Copy for previews / logs: image URLs read from Meta (signed fbcdn) replaced by a label. */
function scrubShown(v: unknown, signed: string[]): unknown {
  if (typeof v === "string") return signed.includes(v) || SIGNED_URL.test(v) ? CURRENT_IMAGE_LABEL : v
  if (Array.isArray(v)) return v.map((x) => scrubShown(x, signed))
  const r = rec(v)
  if (!r) return v
  return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, scrubShown(x, signed)]))
}

function scrubAll(e: unknown, signed: string[]): unknown {
  return signed.filter((u) => u.length > 0).reduce((err, u) => scrubUri(err, u), e)
}

/** "yyyy-mm-dd hh:mm" in the ad account's time zone (creative names). */
function accountStamp(timezone: string): string {
  const now = new Date()
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now)
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`
  } catch {
    return now.toISOString().slice(0, 16).replace("T", " ")
  }
}

/** A ProviderError with an extra hint sentence (orphan creative id after a failed swap). */
function withHint(e: unknown, extra: string): unknown {
  if (!isProviderError(e)) return e
  return new ProviderError({
    platform: e.platform,
    code: e.code,
    toolCode: e.toolCode,
    message: e.message,
    userMessageVi: e.userMessageVi,
    hint: e.hint ? `${e.hint} ${extra}` : extra,
    retryable: e.retryable,
    retryAfterMs: e.retryAfterMs,
    upstream: e.upstream,
  })
}

/** Read the new creative back: the greeting we sent must be stored (else Meta returned another creative - dedupe). */
async function verifyCreativeGreeting(ctx: ProviderContext<MetaCredentials>, id: string, sent: string): Promise<void> {
  let node: RawNode
  try {
    node = await graph<RawNode>(callCtx(ctx), {
      method: "GET",
      path: id,
      params: { fields: "id,account_id,page_welcome_message,object_story_spec" },
      idempotent: true,
    })
  } catch {
    throw invalid(
      `Không đọc lại được creative ${id} để kiểm tra lời chào - CHƯA đổi creative của quảng cáo.`,
      `Creative ${id} đã được tạo nhưng chưa gắn vào quảng cáo: kiểm tra lại sau rồi gọi meta_update_ad_creative với creative_id=${id}, hoặc thử lại từ đầu.`
    )
  }
  assertSameAccount(ctx, node, "creative")
  const verdict = greetingVerdict(sent, creativeGreeting(node))
  if (verdict === "match") return
  throw invalid(
    `Meta trả về creative ${id} ${verdict === "missing" ? "KHÔNG có lời chào vừa gửi" : "có lời chào KHÁC lời chào vừa gửi"} (Meta có thể đã dùng lại creative cũ của cùng bài viết) - CHƯA đổi creative của quảng cáo.`,
    "Meta có thể đã trả lại creative cũ của bài viết. Gọi lại với tham số creative = nội dung link / video kèm welcome_message (Meta tạo bài quảng cáo mới, mất lượt thích / bình luận của bài cũ), hoặc thêm lời chào trong Trình quản lý quảng cáo."
  )
}

/**
 * POST /{ad_id} creative={"creative_id"}. Not retried blindly: on timeout / 5xx the ad is read back and the swap
 * counts as done when it already shows the new creative. `orphan` = creative made by this call (named in the hint).
 */
async function swapCreative(
  ctx: ProviderContext<MetaCredentials>,
  adId: string,
  creativeId: string,
  orphan: string | null,
  warnings: string[]
): Promise<void> {
  try {
    await graph(callCtx(ctx), { method: "POST", path: adId, params: { creative: { creative_id: creativeId } }, idempotent: false })
  } catch (e) {
    if (isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")) {
      const now = await graph<RawNode>(callCtx(ctx), {
        method: "GET",
        path: adId,
        params: { fields: "id,creative{id}" },
        idempotent: true,
      }).catch(() => null)
      if (idStr(rec(now?.creative)?.id) === creativeId) {
        warnings.push("Meta phản hồi lỗi / timeout nhưng quảng cáo đã nhận creative mới - không gửi lại.")
        return
      }
    }
    throw orphan
      ? withHint(
          e,
          `Creative ${orphan} đã được tạo nhưng CHƯA gắn vào quảng cáo - thử lại bằng meta_update_ad_creative với creative_id=${orphan} (không tạo thêm creative).`
        )
      : e
  }
}

/** Fallback reads when Meta rejects a field (#100): only what every swap needs (refusal fields probed apart). */
const CREATIVE_MIN_FIELDS = "id,name,status,object_story_id,effective_object_story_id,object_story_spec,url_tags"
const AD_FOR_SWAP_MIN_FIELDS = [
  "name",
  "status",
  "effective_status",
  "adset{id,name,status,effective_status,destination_type,promoted_object,optimization_goal}",
  "campaign{id,name,status,effective_status,objective}",
  `creative{${CREATIVE_MIN_FIELDS}}`,
]
/** Fields that decide refusals, probed one node at a time on the fallback path. */
const CREATIVE_PROBE_FIELDS = "asset_feed_spec,product_set_id,platform_customizations"
export const AD_CREATIVE_DEGRADED_NOTE =
  "Meta không trả một số trường của creative (nút, lời chào, Instagram, authorization_category): lời chào hiện tại có thể không hiện trong bản xem trước, nút nhắn tin dùng MESSAGE_PAGE, tài khoản Instagram / phân loại cũ không được giữ."

function noRefusalData(fields: string, what: string) {
  return invalid(
    `Không đọc được ${what} (${fields.split(",").join(" / ")}) để kiểm tra an toàn - không đổi creative qua công cụ này.`,
    "Đổi trong Trình quản lý quảng cáo, hoặc tạo quảng cáo mới bằng meta_create_ad rồi tạm dừng quảng cáo cũ."
  )
}

/** Refusal fields (Dynamic Creative, ASC, asset_feed_spec, catalog…) of one node: unreadable → refuse, never guess. */
async function probeRefusalFields(ctx: ProviderContext<MetaCredentials>, id: string, fields: string, what: string): Promise<RawNode> {
  try {
    return await graph<RawNode>(callCtx(ctx), { method: "GET", path: id, params: { fields: `id,${fields}` }, idempotent: true })
  } catch (e) {
    if (!isGraphFieldError(e)) throw e
    throw noRefusalData(fields, what)
  }
}

function pick(node: Record<string, unknown>, fields: string): Record<string, unknown> {
  return Object.fromEntries(fields.split(",").map((f) => [f, node[f]]))
}

/** The ad with its ad set / campaign / creative; a field Meta rejects (#100) → minimal fields + refusal probe. */
async function readAdForSwap(ctx: ProviderContext<MetaCredentials>, adId: string): Promise<{ ad: RawNode; degraded: boolean }> {
  try {
    return { ad: await readNode(ctx, "ad", adId, AD_FOR_SWAP_FIELDS), degraded: false }
  } catch (e) {
    if (!isGraphFieldError(e)) throw e
  }
  const ad = await readNode(ctx, "ad", adId, AD_FOR_SWAP_MIN_FIELDS) // account check first (readNode)
  const adset = rec(ad.adset) ?? {}
  const adsetId = idStr(adset.id) ?? idStr(ad.adset_id)
  if (!adsetId) throw noRefusalData("is_dynamic_creative", "kiểu của nhóm quảng cáo")
  const adsetExtra = await probeRefusalFields(ctx, adsetId, "is_dynamic_creative", "kiểu của nhóm quảng cáo")
  ad.adset = { ...adset, id: adsetId, is_dynamic_creative: adsetExtra.is_dynamic_creative }
  const campaign = rec(ad.campaign) ?? {}
  const campaignId = idStr(campaign.id) ?? idStr(ad.campaign_id)
  if (!campaignId) throw noRefusalData("smart_promotion_type", "kiểu của chiến dịch")
  const campaignExtra = await probeRefusalFields(ctx, campaignId, "smart_promotion_type", "kiểu của chiến dịch")
  ad.campaign = { ...campaign, id: campaignId, smart_promotion_type: campaignExtra.smart_promotion_type }
  const creative = rec(ad.creative)
  const id = idStr(creative?.id)
  if (creative && id) {
    const extra = await probeRefusalFields(ctx, id, CREATIVE_PROBE_FIELDS, "kiểu của creative")
    ad.creative = { ...creative, ...pick(extra, CREATIVE_PROBE_FIELDS) }
  }
  return { ad, degraded: true }
}

/** An existing creative (mode creative_id) of THIS ad account; same fallback as readAdForSwap. */
async function readCreativeForSwap(
  ctx: ProviderContext<MetaCredentials>,
  id: string
): Promise<{ creative: RawNode; degraded: boolean }> {
  const get = (fields: string) =>
    graph<RawNode>(callCtx(ctx), { method: "GET", path: id, params: { fields: `${fields},account_id` }, idempotent: true })
  try {
    const full = await get(CREATIVE_READ_FIELDS)
    assertSameAccount(ctx, full, "creative")
    return { creative: full, degraded: false }
  } catch (e) {
    if (!isGraphFieldError(e)) throw e
  }
  const min = await get(CREATIVE_MIN_FIELDS)
  assertSameAccount(ctx, min, "creative") // before any further read of a creative of another account
  const extra = await probeRefusalFields(ctx, min.id, CREATIVE_PROBE_FIELDS, "kiểu của creative")
  return { creative: { ...min, ...pick(extra, CREATIVE_PROBE_FIELDS) }, degraded: true }
}

const updateAdCreative: ProviderExtension<MetaCredentials, UpdateAdCreativeInput, MetaWriteResult> = {
  name: "meta_update_ad_creative",
  permission: "update",
  title: "Đổi creative / lời chào của quảng cáo Meta",
  description:
    "Dùng khi cần thêm / đổi lời chào tin nhắn cho quảng cáo Meta ĐÃ CÓ (kể cả quảng cáo từ bài viết có sẵn) hoặc " +
    "thay creative (nội dung) của quảng cáo mà không tạo quảng cáo mới. Gọi ads_list_objects / ads_get_object " +
    "level=ad trước để lấy ad_id và xem creative, lời chào hiện tại. Truyền đúng MỘT trong 3 cách: (1) welcome_message " +
    "= giữ nguyên nội dung (bài có sẵn hoặc ảnh / video + link), chỉ thêm / thay lời chào - nhóm quảng cáo đích " +
    "Messenger; welcome_message {from_ad_id} = dùng lại nguyên lời chào (kể cả mẫu lời chào đã lưu, các nút) của " +
    "quảng cáo khác; (2) creative = nội dung mới như meta_create_ad (link / video / existing_post, kèm welcome_message nếu " +
    "cần, ảnh image_hash / image_url / image_drive_file); (3) creative_id = gắn creative có sẵn của cùng tài khoản. " +
    "Meta không cho sửa creative cũ: hệ thống tạo creative mới, kiểm tra lời chào đã được lưu rồi mới gắn vào quảng " +
    "cáo (bài có sẵn mà Meta trả lại creative cũ không có lời chào → dừng, không đổi gì; khi đó dùng cách (2)). " +
    "Quảng cáo giữ nguyên ID, trạng thái và số liệu; Meta sẽ duyệt lại quảng cáo và nhóm có thể quay lại giai " +
    "đoạn học; đổi sang bài / nội dung khác làm mất lượt thích, bình luận của bài cũ. Không dùng cho quảng cáo đã lưu " +
    "trữ / xoá, nhóm Dynamic Creative, creative nhiều phương án (asset_feed_spec), quảng cáo danh mục hoặc Advantage+ " +
    "mua sắm kiểu cũ. Không đổi ngân sách hay bật / tắt quảng cáo.",
  input: updateAdCreativeInput,
  write: true,
  driveImageRef: (input) => (input.creative && input.creative.type !== "existing_post" ? input.creative.image_drive_file : undefined),
  // a new video creative without a cover: Meta's own thumbnail is downloaded through mcp-core's guarded fetch
  fetchesPlatformImages: true,
  async run(ctx, input, opts) {
    const modes = [input.welcome_message, input.creative, input.creative_id].filter((v) => v !== undefined).length
    if (modes !== 1) {
      throw invalid(
        "Truyền đúng MỘT trong: welcome_message (thêm / đổi lời chào, giữ nội dung), creative (nội dung mới) hoặc creative_id (creative có sẵn).",
        "Xem creative hiện tại bằng ads_get_object level=ad."
      )
    }
    if (!input.creative && (input.page_id !== undefined || input.instagram_user_id !== undefined)) {
      throw invalid("page_id / instagram_user_id chỉ dùng khi truyền creative mới.")
    }
    if (input.creative_id !== undefined && (input.url_tags !== undefined || input.advantage_creative_opt_in.length)) {
      throw invalid("creative_id dùng nguyên creative có sẵn: không truyền url_tags / advantage_creative_opt_in.")
    }

    const read = await readAdForSwap(ctx, input.ad_id)
    const ad = read.ad
    const adset = rec(ad.adset) ?? {}
    const campaign = rec(ad.campaign) ?? {}
    const old = rec(ad.creative)
    assertSwappable(ad, adset, campaign, old)
    const adName = typeof ad.name === "string" && ad.name ? ad.name : ad.id
    const dest = messagingDestination(adset.destination_type)
    const adsetPage = dest ? promotedPageId(adset.promoted_object) : null
    const oldPost = idStr(old?.effective_object_story_id) ?? idStr(old?.object_story_id)
    const warnings: string[] = [...AD_CREATIVE_SWAP_NOTES, ...(read.degraded ? [AD_CREATIVE_DEGRADED_NOTE] : [])]
    // welcome_message {from_ad_id} (either mode): read the source ad's greeting once, before anything is built
    const copied = await readCopiedGreeting(ctx, input.welcome_message ?? input.creative?.welcome_message)
    const before = { creative_id: idStr(old?.id), welcome_message: greetingShown(creativeGreeting(old)) }
    const change = (after: Record<string, unknown>): FieldChange => ({
      objectId: ad.id,
      objectName: adName,
      level: "ad",
      field: "creative",
      before,
      after,
    })

    // (c) an existing creative of this ad account: reads only, then the swap
    if (input.creative_id !== undefined) {
      const targetRead = await readCreativeForSwap(ctx, input.creative_id)
      const target = targetRead.creative
      if (targetRead.degraded && !warnings.includes(AD_CREATIVE_DEGRADED_NOTE)) warnings.push(AD_CREATIVE_DEGRADED_NOTE)
      if (target.status === "DELETED") throw invalid(`Creative ${target.id} đã bị xoá.`, "Chọn creative khác, hoặc truyền creative để tạo mới.")
      if (rec(target.asset_feed_spec) || idStr(target.product_set_id)) {
        throw invalid("Creative này có nhiều phương án nội dung (asset_feed_spec) hoặc thuộc danh mục sản phẩm: không gắn được qua công cụ này.")
      }
      const page = creativePage(target)
      if (adsetPage && page && page !== adsetPage) throw pageMismatch(page, adsetPage)
      await assertAdvertisablePages(ctx, [page ?? undefined])
      const payload = { ad_id: ad.id, ad_name: adName, mode: "creative_id", current: before, creative_id: target.id }
      if (target.id === before.creative_id) {
        return { preview: !!opts.dryRun, changes: [], warnings: ["Quảng cáo đang dùng đúng creative này - không có thay đổi."], payload }
      }
      const targetPost = idStr(target.effective_object_story_id) ?? idStr(target.object_story_id)
      if (oldPost && targetPost !== oldPost) warnings.push(SOCIAL_PROOF_NOTE)
      // live campaign: the button stored on the target's live post is what the ad will show
      if (liveDestination(campaign) && targetPost) {
        await checkLivePostCta(ctx, targetPost, rec(target.call_to_action), adset, payload, warnings, targetPost !== oldPost)
      }
      const after = { creative_id: target.id, welcome_message: greetingShown(creativeGreeting(target)) }
      // preview from reads only (validate_only is not documented on POST /{id} updates)
      if (opts.dryRun) return { preview: true, changes: [change(after)], warnings, payload }
      await swapCreative(ctx, ad.id, target.id, null, warnings)
      return { preview: false, changes: [change(after)], warnings, payload }
    }

    // (a) greeting only / (b) new content: a new creative is created, verified, then attached
    const name = `${adName.slice(0, 300)} - creative ${accountStamp(ctx.account.timezone)} · ${randomBytes(2).toString("hex")}`
    let creative: Record<string, unknown>
    let shown: Record<string, unknown>
    let welcomeShown: GreetingShown | null
    let pages: (string | undefined)[]
    const signed: string[] = []
    let skipValidate = false
    if (input.welcome_message !== undefined) {
      const welcome = welcomeFor(input.welcome_message, dest, copied)
      const built = buildGreetingCreative(old, welcome, input, name, warnings)
      if (adsetPage && built.page && built.page !== adsetPage) throw pageMismatch(built.page, adsetPage)
      if (copied) warnings.push(copiedGreetingNote(copied, adsetPage ?? built.page))
      creative = built.creative
      shown = cleanShown(structuredClone(creative))
      signed.push(...built.signed)
      welcomeShown = welcome.shown
      pages = [built.page ?? undefined]
    } else {
      const c = input.creative!
      let pageId = input.page_id
      if (c.type !== "existing_post" && !pageId) {
        pageId = adsetPage ?? creativePage(old) ?? undefined
        if (pageId) warnings.push(`Không truyền page_id: dùng Trang ${pageId} (${adsetPage ? "Trang của nhóm quảng cáo nhắn tin" : "Trang của creative hiện tại"}).`)
      }
      const oldIg = idStr(rec(old?.object_story_spec)?.instagram_user_id) ?? idStr(old?.instagram_user_id)
      const built = buildAdPayload(
        {
          adset_id: idStr(adset.id) ?? "",
          name: adName,
          page_id: pageId,
          instagram_user_id: input.instagram_user_id ?? (input.page_id === undefined && oldIg ? oldIg : undefined),
          creative: c,
          url_tags: input.url_tags,
          advantage_creative_opt_in: input.advantage_creative_opt_in,
        },
        { ...adset, id: idStr(adset.id) ?? "", campaign },
        warnings,
        copied
      )
      creative = built.payload.creative as Record<string, unknown>
      shown = built.summary.creative as Record<string, unknown>
      creative.name = shown.name = name
      welcomeShown = (built.summary.welcome_message as GreetingShown | undefined) ?? null
      pages = [pageId, c.type === "existing_post" ? c.object_story_id.split("_")[0] : undefined]
      if (oldPost && (c.type !== "existing_post" || c.object_story_id !== oldPost)) warnings.push(SOCIAL_PROOF_NOTE)
    }
    // dry run AND execute: every Page used must be advertisable by this ad account
    await assertAdvertisablePages(ctx, pages)
    if (input.creative) {
      const cover = await applyCover(ctx, input.creative, creative, shown, warnings, opts)
      skipValidate = cover.skipValidate
      if (cover.uri) signed.push(cover.uri)
    }
    const sentGreeting = creativeGreeting(creative)
    const payload: Record<string, unknown> = {
      ad_id: ad.id,
      ad_name: adName,
      mode: input.welcome_message !== undefined ? "welcome_message" : `creative:${input.creative!.type}`,
      current: before,
      new_creative: scrubShown(shown, signed),
      ...(welcomeShown ? { welcome_message: welcomeShown } : {}),
    }
    // live campaign + a post creative: the post's own button wins (same post as now → warn only, the ad keeps it)
    const newPost = idStr(creative.object_story_id)
    if (liveDestination(campaign) && newPost) {
      await checkLivePostCta(ctx, newPost, rec(creative.call_to_action), adset, payload, warnings, newPost !== oldPost)
    }
    const after = (id: string) => ({
      creative_id: id,
      welcome_message: welcomeShown,
      ...(input.creative ? { creative_type: input.creative.type } : {}),
    })
    try {
      if (opts.dryRun) {
        if (!skipValidate) await validateOnly(ctx, `${actId(ctx.account.externalId)}/adcreatives`, creative)
        return { preview: true, changes: [change(after("(mới)"))], warnings, payload }
      }
      const newId = await createObject(ctx, "adcreatives", creative, warnings)
      if (sentGreeting) await verifyCreativeGreeting(ctx, newId, sentGreeting)
      if (newId === before.creative_id) {
        warnings.push("Meta trả lại đúng creative quảng cáo đang dùng (đã có nội dung / lời chào này) - không cần đổi.")
        return { preview: false, changes: [], warnings, payload }
      }
      await swapCreative(ctx, ad.id, newId, newId, warnings)
      return { preview: false, changes: [change(after(newId))], warnings, payload, createdIds: [newId] }
    } catch (e) {
      throw scrubAll(e, signed)
    }
  },
}

export const metaExtensions: ProviderExtension<MetaCredentials>[] = [
  createCampaign,
  createAdset,
  createAd,
  updateTargeting,
  updateAdCreative,
]
