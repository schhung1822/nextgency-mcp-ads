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
import { z } from "zod"

import { isProviderError, ProviderError } from "../errors"
import { metaCurrencyOffset, toMetaMinor } from "../money"
import type { FieldChange, MutationOptions, MutationResult, ProviderContext, ProviderExtension } from "../types"
import { actId, graph, graphPage, isIsoDateTimeWithOffset, type MetaCredentials } from "./client"
import { advertisablePages } from "./lookup"
import { ensureMetaVideoInAccount, metaVideoCoverUri, readMetaVideo, uploadMetaCoverFromUri } from "./media"
import { validateOnly } from "./mutate"
import { readNode, type RawNode } from "./objects"
import { callCtx, fmtMoney, hasBudget, invalid } from "./shared"
import { buildTargeting, euCountriesIn, hasGeo, targetingInput, targetingProblems } from "./targeting"

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
  OUTCOME_ENGAGEMENT: ["POST_ENGAGEMENT", "THRUPLAY", "CONVERSATIONS", "PAGE_LIKES"],
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
] as const

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
  try {
    const res = await graphPage<RawNode>(callCtx(ctx), `${actId(ctx.account.externalId)}/${edge}`, {
      fields: "id,name,created_time",
      filtering: [{ field: "name", operator: "EQUAL", value: name }],
      limit: 5,
    })
    const hit = res.data.find(
      (n) => n.name === name && typeof n.created_time === "string" && Date.parse(n.created_time) >= sinceMs
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
  edge: "campaigns" | "adsets" | "ads",
  payload: Record<string, unknown>,
  warnings: string[]
): Promise<string> {
  if (payload.status !== "PAUSED") throw new Error("internal: Meta create payload must be PAUSED")
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
  })
  .strict()
export type CreateCampaignInput = z.infer<typeof createCampaignInput>

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
    "special_ad_categories nếu quảng cáo về nhà ở, việc làm, tài chính, chính trị, cờ bạc. Bước tiếp theo: meta_create_adset.",
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
    start_time: isoDateTime.optional(),
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
  if (objective === "OUTCOME_AWARENESS" && !po.page_id) throw invalid("Chiến dịch nhận biết cần promoted_object.page_id.")
  if (goal === "PAGE_LIKES" && !po.page_id) throw invalid("PAGE_LIKES cần promoted_object.page_id.")
  if (goal === "CONVERSATIONS") {
    if (!input.destination_type || !["MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT"].includes(input.destination_type)) {
      throw invalid("CONVERSATIONS cần destination_type MESSENGER, WHATSAPP hoặc INSTAGRAM_DIRECT.")
    }
    if (!po.page_id) throw invalid("CONVERSATIONS cần promoted_object.page_id.")
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
    "LANDING_PAGE_VIEWS; ENGAGEMENT→POST_ENGAGEMENT/THRUPLAY/CONVERSATIONS/PAGE_LIKES; LEADS→LEAD_GENERATION/" +
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
    ])
    const warnings: string[] = ["Nhóm quảng cáo được tạo ở trạng thái TẠM DỪNG."]
    const { payload, summary } = buildAdsetPayload(input, campaign, ctx.account.currency, warnings)
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
  const allowed = new Set((await advertisablePages(ctx)).map((p) => p.id)) // one lookup per run
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
  ])
  .describe(
    "Lời chào khi khách mở Messenger từ quảng cáo (chỉ nhóm quảng cáo đích Messenger): văn bản ≤300 ký tự hoặc {text, ice_breakers}; dùng được {{user_first_name}}"
  )
type WelcomeMessageInput = z.infer<typeof welcomeMessageInput>

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
export function buildWelcomeMessage(w: WelcomeMessageInput): {
  value: string
  shown: { text: string; ice_breakers?: { title: string; response: string }[] }
} {
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

export function buildAdPayload(input: CreateAdInput, adset: RawNode, warnings: string[]) {
  const c = input.creative
  const campaign = (adset.campaign ?? {}) as { objective?: string }
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
  } else {
    if (!input.page_id) throw invalid("Cần page_id (Trang chạy quảng cáo).", "Gọi ads_lookup kind=pages.")
    if (c.welcome_message !== undefined) {
      if (dest !== "MESSENGER") {
        throw invalid(
          dest
            ? `Lời chào tin nhắn (welcome_message) hiện chỉ hỗ trợ nhóm quảng cáo đích Messenger (nhóm này là ${dest}).`
            : "welcome_message chỉ dùng cho quảng cáo nhắn tin: nhóm quảng cáo phải có destination_type MESSENGER (mục tiêu CONVERSATIONS hoặc MESSAGING_PURCHASE_CONVERSION).",
          dest ? "Bỏ welcome_message." : "Bỏ welcome_message, hoặc tạo nhóm quảng cáo nhắn tin Messenger bằng meta_create_adset."
        )
      }
      welcome = buildWelcomeMessage(c.welcome_message)
    }
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
  if (welcome) summary.welcome_message = welcome.shown
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
  input: CreateAdInput,
  payload: Record<string, unknown>,
  summary: Record<string, unknown>,
  warnings: string[],
  opts: MutationOptions
): Promise<{ uri: string | null; skipValidate: boolean }> {
  const c = input.creative
  if (c.type === "existing_post") return { uri: null, skipValidate: false }
  const key = c.type === "video" ? "video_data" : "link_data"
  const data = ((payload.creative as Record<string, unknown>).object_story_spec as Record<string, Record<string, unknown>>)[key]!
  const shown = ((summary.creative as Record<string, unknown>).object_story_spec as Record<string, Record<string, unknown>>)[key]!
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

const createAd: ProviderExtension<MetaCredentials, CreateAdInput, MetaWriteResult> = {
  name: "meta_create_ad",
  permission: "create",
  title: "Tạo quảng cáo Meta",
  description:
    "Dùng khi cần tạo quảng cáo trong một nhóm quảng cáo Meta đã có (adset_id từ ads_list_objects hoặc " +
    "meta_create_adset). Quảng cáo luôn được tạo ở trạng thái TẠM DỪNG và phải qua Meta duyệt. Creative tạo kèm: " +
    "`link` (ảnh + link), `video` (video_id từ ads_upload_media / ads_get_media_upload) hoặc `existing_post` " +
    "(object_story_id dạng PAGEID_POSTID). Ảnh (link) / ảnh bìa (video): truyền MỘT trong image_hash (ads_upload_media), " +
    "image_url, hoặc image_drive_file = ảnh Google Drive người dùng đưa (file_id / link Drive / drf_ từ drive_list_files, " +
    "drive_sheet_read) - hệ thống tự tải ảnh lên khi xác nhận (dùng lại nếu đã tải). Video không có ảnh bìa: hệ thống tự " +
    "lấy ảnh bìa Meta trích từ video khi video đã sẵn sàng; video đang xử lý → lỗi video_processing (thử lại sau ít phút " +
    "hoặc đưa ảnh bìa), video lỗi → video_failed (tải video lên lại). Cần page_id (ads_lookup kind=pages) trừ khi dùng bài " +
    "có sẵn; instagram_user_id tuỳ chọn (ads_lookup kind=instagram_accounts). Nhóm nhắn tin (destination MESSENGER/" +
    "WHATSAPP/INSTAGRAM_DIRECT): thiếu nút thì tự đặt MESSAGE_PAGE/WHATSAPP_MESSAGE/INSTAGRAM_MESSAGE, link tuỳ chọn, page_id phải " +
    "là Trang của nhóm; welcome_message (chỉ Messenger) = lời chào + tối đa 4 câu hỏi gợi ý. Mọi tính năng Advantage+ creative " +
    "(tự sửa ảnh, đổi chữ, thêm nhạc…) gửi OPT_OUT trừ khi liệt kê trong advantage_creative_opt_in. Quảng cáo biểu " +
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
      "campaign{id,objective}",
    ])
    const warnings: string[] = ["Quảng cáo được tạo ở trạng thái TẠM DỪNG và cần Meta duyệt trước khi chạy."]
    const { payload, summary } = buildAdPayload(input, adset, warnings)
    // dry run AND execute: page_id and the Page of an existing post (PAGEID_POSTID) must be advertisable
    const postPage = input.creative.type === "existing_post" ? input.creative.object_story_id.split("_")[0] : undefined
    await assertAdvertisablePages(ctx, [input.page_id, postPage])
    const cover = await applyCover(ctx, input, payload, summary, warnings, opts)
    try {
      return await runCreate(ctx, "ads", payload, summary, warnings, opts, "ad", { skipValidate: cover.skipValidate })
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

    const warnings: string[] = []
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

export const metaExtensions: ProviderExtension<MetaCredentials>[] = [
  createCampaign,
  createAdset,
  createAd,
  updateTargeting,
]
