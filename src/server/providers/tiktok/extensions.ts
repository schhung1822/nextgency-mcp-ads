// TikTok-specific MCP tools (registered by mcp-core): create campaign / ad group / ads, update targeting.
// Every create sends operation_status "DISABLE" (TikTok defaults to ENABLE!). Campaign and ad group
// creates carry a request_id (int64 string, idempotent for 10 s; derived from idempotencyKey when given).
// /ad/create/ has no request_id in v1.3 → never retried automatically.
// Money in MAJOR units of the account currency (TikTok budgets/bids are major units too).
import { z } from "zod"
import type { ExtensionMoneyItem, FieldChange, MutationOptions, MutationResult, ProviderContext, ProviderExtension } from "../types"
import {
  apiMoney,
  automationType,
  formatTikTokTime,
  invalid,
  isTikTokTime,
  isUpgradedSmartPlus,
  normalizeStatus,
  parseTikTokTime,
  ttFromCtx,
  ttGet,
  type Raw,
  type TT,
} from "./api"
import { createAdsChecked } from "./ad-create"
import { makeRequestId } from "./client"
import { createChecked } from "./create-checked"
import { CAMPAIGN_CREATE_CUTOFF_WARNING } from "./copy"
import type { TikTokCredentials } from "./credentials"
import { fetchOne } from "./objects"
import { fullAdgroupUpdate } from "./mutate"
import { gmvMaxExtensions } from "./gmv-max"
import { gmvMaxWriteExtensions } from "./gmv-max-write"
import { smartPlusExtension } from "./smart-plus"
import { assertNotGmvMaxCampaign } from "./gmv-max-detect"
import {
  checkMessagingCreative,
  deeplinkSchema,
  MESSAGING_DEADLINE_NOTE,
  messagingExtensions,
  messagingGroupOf,
  messagingInput,
  resolveAdGroupMessaging,
  type MessagingGroup,
} from "./messaging"

export type CreateResult = MutationResult & { payload?: Raw }

const CUTOFF = Date.parse("2027-01-01T00:00:00Z")

// ---------------------------------------------------------------------------
// Shared enums / validation tables
// ---------------------------------------------------------------------------

export const OBJECTIVES = [
  "REACH",
  "TRAFFIC",
  "VIDEO_VIEWS",
  "ENGAGEMENT",
  "APP_PROMOTION",
  "LEAD_GENERATION",
  "WEB_CONVERSIONS",
  "PRODUCT_SALES",
] as const

/** optimization_goal → required billing_event (tiktok.md §4) */
export const GOAL_BILLING: Record<string, "CPC" | "CPM" | "CPV" | "OCPM"> = {
  CLICK: "CPC",
  PAGE_VISIT: "CPC",
  SHOW: "CPM",
  REACH: "CPM",
  ENGAGED_VIEW: "CPV",
  ENGAGED_VIEW_FIFTEEN: "CPV",
  CONVERT: "OCPM",
  INSTALL: "OCPM",
  IN_APP_EVENT: "OCPM",
  TRAFFIC_LANDING_PAGE_VIEW: "OCPM",
  LEAD_GENERATION: "OCPM",
  CONVERSATION: "OCPM",
  FOLLOWERS: "OCPM",
  VALUE: "OCPM",
}
const GOALS = Object.keys(GOAL_BILLING) as [string, ...string[]]

const PLACEMENTS = ["PLACEMENT_TIKTOK", "PLACEMENT_PANGLE", "PLACEMENT_GLOBAL_APP_BUNDLE"] as const
const AGE_GROUPS = ["AGE_13_17", "AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"] as const
const numericId = z.string().regex(/^\d+$/, { error: "Id phải là chuỗi số." })
const ttTime = z
  .string()
  .refine(isTikTokTime, { error: "Thời gian phải dạng \"YYYY-MM-DD HH:MM:SS\" theo giờ UTC (UTC+0)." })
const money = z.number().positive().finite()

function summaryChange(id: string, field: string, after: unknown): FieldChange {
  return { objectId: id, field, before: null, after }
}

/** Never let `advanced` override safety-critical fields. */
const PROTECTED = new Set(["advertiser_id", "campaign_id", "adgroup_id", "operation_status", "request_id", "creatives"])

function mergeAdvanced(body: Raw, advanced: Raw | undefined, warnings: string[]): void {
  if (!advanced) return
  for (const [k, v] of Object.entries(advanced)) {
    if (PROTECTED.has(k)) {
      warnings.push(`Đã bỏ qua trường nâng cao "${k}" (do hệ thống quản lý).`)
      continue
    }
    if (!(k in body)) body[k] = v
    else warnings.push(`Trường nâng cao "${k}" trùng với tham số chính nên đã bỏ qua.`)
  }
}

// ---------------------------------------------------------------------------
// tiktok_create_campaign
// ---------------------------------------------------------------------------

export const createCampaignInput = z.object({
  name: z.string().trim().min(1).max(512).describe("Tên chiến dịch (không emoji)"),
  objective: z.enum(OBJECTIVES).describe("objective_type của TikTok"),
  app_promotion_type: z.enum(["APP_INSTALL", "APP_RETARGETING", "APP_PREREGISTRATION"]).optional(),
  campaign_product_source: z.enum(["CATALOG", "STORE"]).optional().describe("Bắt buộc khi objective = PRODUCT_SALES"),
  cbo: z.boolean().default(false).describe("Bật tối ưu ngân sách chiến dịch (Campaign Budget Optimization)"),
  budget_type: z
    .enum(["unlimited", "daily", "dynamic_daily", "lifetime"])
    .default("unlimited")
    .describe("unlimited chỉ khi không CBO; dynamic_daily chỉ khi CBO"),
  budget: money.optional().describe("Ngân sách theo đơn vị chính của tiền tệ tài khoản"),
  special_industries: z.array(z.enum(["HOUSING", "EMPLOYMENT", "CREDIT"])).optional(),
  is_search_campaign: z.boolean().optional(),
})
export type CreateCampaignInput = z.infer<typeof createCampaignInput>

const BUDGET_MODE: Record<string, string> = {
  unlimited: "BUDGET_MODE_INFINITE",
  daily: "BUDGET_MODE_DAY",
  dynamic_daily: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
  lifetime: "BUDGET_MODE_TOTAL",
}

export function buildCampaignCreateBody(tt: TT, input: CreateCampaignInput, requestId: string, warnings: string[]): Raw {
  if (input.cbo && input.budget_type === "unlimited") {
    throw invalid("Chiến dịch CBO cần ngân sách daily, dynamic_daily hoặc lifetime.")
  }
  if (!input.cbo && input.budget_type === "dynamic_daily") {
    throw invalid("dynamic_daily chỉ dùng cho chiến dịch CBO.")
  }
  if (
    !input.cbo &&
    input.budget_type === "daily" &&
    ["REACH", "VIDEO_VIEWS", "ENGAGEMENT"].includes(input.objective)
  ) {
    throw invalid("TikTok đã ngừng ngân sách hằng ngày cấp chiến dịch (không CBO) cho REACH/VIDEO_VIEWS/ENGAGEMENT.", "Dùng lifetime hoặc unlimited.")
  }
  if (input.budget_type !== "unlimited" && input.budget === undefined) throw invalid("Thiếu budget.")
  if (input.objective === "APP_PROMOTION" && !input.app_promotion_type) throw invalid("APP_PROMOTION cần app_promotion_type.")
  if (input.objective === "PRODUCT_SALES" && !input.campaign_product_source) {
    throw invalid("PRODUCT_SALES cần campaign_product_source (tính năng cần allowlist).")
  }
  const body: Raw = {
    advertiser_id: tt.advertiserId,
    campaign_name: input.name,
    objective_type: input.objective,
    budget_mode: BUDGET_MODE[input.budget_type],
    operation_status: "DISABLE",
    request_id: requestId,
  }
  if (input.cbo) body.budget_optimize_on = true
  if (input.budget_type !== "unlimited") body.budget = apiMoney(input.budget!, tt.currency)
  if (input.app_promotion_type) body.app_promotion_type = input.app_promotion_type
  if (input.campaign_product_source) body.campaign_product_source = input.campaign_product_source
  if (input.special_industries?.length) body.special_industries = input.special_industries
  if (input.is_search_campaign !== undefined) body.is_search_campaign = input.is_search_campaign
  if (input.budget_type === "unlimited" && input.budget !== undefined) {
    warnings.push("budget bị bỏ qua vì budget_type = unlimited.")
    delete body.budget
  }
  return body
}

async function runCreateCampaign(
  ctx: ProviderContext<TikTokCredentials>,
  input: CreateCampaignInput,
  opts: MutationOptions
): Promise<CreateResult> {
  const tt = ttFromCtx(ctx)
  const warnings = [CAMPAIGN_CREATE_CUTOFF_WARNING, "Chiến dịch được tạo ở trạng thái TẮT (DISABLE)."]
  if (Date.now() >= CUTOFF) warnings.push("Đã qua mốc 31/12/2026 - TikTok có thể từ chối tạo chiến dịch thủ công.")
  const body = buildCampaignCreateBody(tt, input, makeRequestId(opts.idempotencyKey, "campaign"), warnings)
  const payload = { ...body }
  delete payload.advertiser_id
  if (opts.dryRun) {
    return { preview: true, changes: [summaryChange("(mới)", "campaign", payload)], warnings, payload }
  }
  // retried only on throttle codes within the request_id window; unknown outcome → lookup by name (create-checked.ts)
  const id = await createChecked(tt, { kind: "campaign", path: "campaign/create", body, name: input.name }, warnings)
  if (!id) throw invalid("TikTok không trả về campaign_id.")
  return { preview: false, changes: [summaryChange(id, "campaign", payload)], warnings, createdIds: [id], payload }
}

// ---------------------------------------------------------------------------
// tiktok_create_adgroup
// ---------------------------------------------------------------------------

export const createAdGroupInput = z.object({
  campaign_id: numericId,
  name: z.string().trim().min(1).max(512),
  promotion_type: z
    .string()
    .optional()
    .describe("Vị trí tối ưu: WEBSITE, APP_ANDROID, APP_IOS, INSTANT_FORM…; bắt buộc trừ REACH/VIDEO_VIEWS/ENGAGEMENT; quảng cáo nhắn tin dùng messaging thay cho trường này"),
  placement_type: z.enum(["automatic", "manual"]).default("automatic"),
  placements: z.array(z.enum(PLACEMENTS)).min(1).optional().describe("Bắt buộc khi placement_type = manual; không đổi được sau khi tạo"),
  location_ids: z.array(numericId).min(1).max(3000).describe("Id số của địa điểm (VN = 1562822) - tra bằng ads_lookup kind=locations"),
  gender: z.enum(["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"]).optional(),
  age_groups: z.array(z.enum(AGE_GROUPS)).optional(),
  languages: z.array(z.string().min(2).max(10)).optional(),
  audience_ids: z.array(numericId).optional(),
  excluded_audience_ids: z.array(numericId).optional(),
  interest_category_ids: z.array(numericId).optional(),
  operating_systems: z.array(z.enum(["ANDROID", "IOS"])).max(1).optional(),
  budget_type: z
    .enum(["daily", "dynamic_daily", "lifetime"])
    .optional()
    .describe("Bỏ trống nếu chiến dịch CBO; dynamic_daily = ngân sách ngày linh hoạt (BUDGET_MODE_DYNAMIC_DAILY_BUDGET)"),
  budget: money.optional().describe("Đơn vị chính của tiền tệ tài khoản (USD tối đa 2 chữ số thập phân; VND/JPY số nguyên)"),
  schedule_start_time: ttTime.optional().describe("UTC \"YYYY-MM-DD HH:MM:SS\"; mặc định ~15 phút nữa"),
  schedule_end_time: ttTime.optional().describe("UTC; bắt buộc với ngân sách lifetime"),
  optimization_goal: z.enum(GOALS),
  billing_event: z.enum(["CPC", "CPM", "CPV", "OCPM"]).optional().describe("Tự suy ra từ optimization_goal nếu bỏ trống"),
  bid_type: z.enum(["BID_TYPE_NO_BID", "BID_TYPE_CUSTOM"]).default("BID_TYPE_NO_BID"),
  bid_amount: money.optional().describe("Giá thầu (bid_price cho CPC/CPM/CPV, conversion_bid_price cho OCPM)"),
  pacing: z.enum(["PACING_MODE_SMOOTH", "PACING_MODE_FAST"]).default("PACING_MODE_SMOOTH"),
  pixel_id: numericId.optional(),
  optimization_event: z.string().optional().describe("Sự kiện chuyển đổi (vd SHOPPING, ON_WEB_ORDER, FORM) - bắt buộc với CONVERT/VALUE"),
  app_id: z.string().optional(),
  messaging: messagingInput.optional(),
  advanced: z.record(z.string(), z.unknown()).optional().describe("Trường /adgroup/create/ khác (nâng cao)"),
})
export type CreateAdGroupInput = z.infer<typeof createAdGroupInput>

export function buildAdGroupCreateBody(
  tt: TT,
  campaign: Raw,
  input: CreateAdGroupInput,
  requestId: string,
  now: Date,
  warnings: string[]
): Raw {
  const cbo = campaign.budget_optimize_on === true
  const objective = String(campaign.objective_type ?? "")
  const campaignMode = String(campaign.budget_mode ?? "")
  const billing = GOAL_BILLING[input.optimization_goal]!
  // messaging ad group (`messaging`, or a raw promotion_type LEAD_GEN_CLICK_TO_*MESSAGE): official rules + body fields
  const msg = resolveAdGroupMessaging(input, objective, warnings)
  const promotionType = msg ? String(msg.fields.promotion_type) : input.promotion_type
  if (!cbo && campaignMode === "BUDGET_MODE_DAY" && ["REACH", "VIDEO_VIEWS", "ENGAGEMENT"].includes(objective)) {
    throw invalid(
      `Chiến dịch ${objective} không CBO đang dùng ngân sách hằng ngày cấp chiến dịch - TikTok không còn hỗ trợ cấu hình này nên không tạo thêm nhóm quảng cáo được.`,
      "Tạo chiến dịch mới với ngân sách lifetime hoặc unlimited (hoặc bật CBO)."
    )
  }
  if (!cbo && campaignMode === "BUDGET_MODE_DAY" && input.budget_type === "lifetime") {
    throw invalid(
      "Chiến dịch đang dùng ngân sách hằng ngày nên nhóm quảng cáo không dùng được ngân sách trọn đời (lifetime).",
      "Dùng budget_type daily hoặc dynamic_daily."
    )
  }
  if (input.billing_event && input.billing_event !== billing) {
    throw invalid(`optimization_goal ${input.optimization_goal} phải đi với billing_event ${billing}, không phải ${input.billing_event}.`)
  }
  if (!["REACH", "VIDEO_VIEWS", "ENGAGEMENT"].includes(objective) && !promotionType) {
    throw invalid(`Chiến dịch mục tiêu ${objective} cần promotion_type (vd WEBSITE).`)
  }
  if (input.optimization_goal === "CONVERT" && (!input.pixel_id || !input.optimization_event)) {
    throw invalid("optimization_goal CONVERT cần pixel_id và optimization_event.", "Tra pixel bằng ads_lookup kind=pixels.")
  }
  if (input.optimization_goal === "VALUE" && (!input.optimization_event || (!input.pixel_id && !input.app_id))) {
    throw invalid("optimization_goal VALUE cần optimization_event và pixel_id (web) hoặc app_id (app).")
  }
  if (input.pixel_id && !["CONVERT", "VALUE"].includes(input.optimization_goal)) {
    throw invalid("pixel_id chỉ dùng với optimization_goal CONVERT hoặc VALUE.")
  }
  if (!msg && input.placement_type === "manual" && !input.placements?.length) throw invalid("placement_type manual cần placements.")
  if (input.bid_type === "BID_TYPE_CUSTOM" && input.bid_amount === undefined) throw invalid("BID_TYPE_CUSTOM cần bid_amount.")
  if (input.bid_type === "BID_TYPE_NO_BID" && input.bid_amount !== undefined) {
    warnings.push("bid_amount bị bỏ qua vì bid_type = BID_TYPE_NO_BID.")
  }

  // schedule (UTC)
  const minStart = now.getTime() - 12 * 3_600_000
  const start = input.schedule_start_time
    ? parseTikTokTime(input.schedule_start_time)!
    : new Date(Math.ceil((now.getTime() + 15 * 60_000) / 60_000) * 60_000)
  if (start.getTime() < minStart) throw invalid("schedule_start_time không được sớm hơn hiện tại quá 12 giờ.")
  const end = input.schedule_end_time ? parseTikTokTime(input.schedule_end_time)! : null
  if (end && end.getTime() <= start.getTime()) throw invalid("schedule_end_time phải sau schedule_start_time.")

  const body: Raw = {
    advertiser_id: tt.advertiserId,
    campaign_id: input.campaign_id,
    adgroup_name: input.name,
    request_id: requestId,
    operation_status: "DISABLE",
    placement_type: input.placement_type === "automatic" ? "PLACEMENT_TYPE_AUTOMATIC" : "PLACEMENT_TYPE_NORMAL",
    location_ids: input.location_ids,
    optimization_goal: input.optimization_goal,
    billing_event: billing,
    bid_type: input.bid_type,
    pacing: input.pacing,
    schedule_type: end ? "SCHEDULE_START_END" : "SCHEDULE_FROM_NOW",
    schedule_start_time: formatTikTokTime(start),
  }
  if (end) body.schedule_end_time = formatTikTokTime(end)
  if (input.placement_type === "manual") body.placements = input.placements
  if (input.promotion_type) body.promotion_type = input.promotion_type
  for (const k of [
    "gender",
    "age_groups",
    "languages",
    "audience_ids",
    "excluded_audience_ids",
    "interest_category_ids",
    "operating_systems",
    "pixel_id",
    "optimization_event",
    "app_id",
  ] as const) {
    if (input[k] !== undefined) body[k] = input[k]
  }
  if (input.bid_type === "BID_TYPE_CUSTOM") {
    const amount = apiMoney(input.bid_amount!, tt.currency)
    if (billing === "OCPM") body.conversion_bid_price = amount
    else body.bid_price = amount
  }
  if (cbo) {
    if (input.budget !== undefined || input.budget_type) warnings.push("Chiến dịch dùng CBO nên ngân sách nhóm bị bỏ qua.")
    body.budget_mode = "BUDGET_MODE_INFINITE"
  } else {
    if (!input.budget_type || input.budget === undefined) throw invalid("Chiến dịch không CBO: cần budget_type và budget cho nhóm quảng cáo.")
    body.budget_mode = BUDGET_MODE[input.budget_type]
    body.budget = apiMoney(input.budget, tt.currency)
    if (input.budget_type === "lifetime" && !end) throw invalid("Ngân sách lifetime cần schedule_end_time.")
  }
  // SCHEDULE_FROM_NOW (no end time) only works with a daily budget mode (ad group, or the campaign when CBO)
  const effectiveMode = cbo ? campaignMode : String(body.budget_mode)
  if (!end && effectiveMode === "BUDGET_MODE_TOTAL") {
    throw invalid(
      "Lịch chạy liên tục (không có schedule_end_time) chỉ dùng với ngân sách hằng ngày - chiến dịch đang dùng ngân sách trọn đời.",
      "Thêm schedule_end_time."
    )
  }
  if (msg) Object.assign(body, msg.fields)
  mergeAdvanced(body, msg ? msg.advanced : (input.advanced as Raw | undefined), warnings)
  return body
}

async function runCreateAdGroup(
  ctx: ProviderContext<TikTokCredentials>,
  input: CreateAdGroupInput,
  opts: MutationOptions & { now?: Date }
): Promise<CreateResult> {
  const tt = ttFromCtx(ctx)
  const campaign = await fetchOne(tt, "campaign", input.campaign_id)
  if (normalizeStatus(campaign.operation_status, campaign.secondary_status) === "deleted") {
    throw invalid(`Chiến dịch ${input.campaign_id} đã bị xoá.`)
  }
  // GMV Max campaigns have no ad groups in the API: no ad group is added to them (fail closed when unverifiable)
  await assertNotGmvMaxCampaign(tt, campaign)
  if (automationType(campaign) !== "MANUAL") {
    throw invalid("Chỉ tạo được nhóm quảng cáo trong chiến dịch thủ công (Manual); Smart+ cần endpoint riêng/allowlist.")
  }
  const warnings = ["Nhóm quảng cáo được tạo ở trạng thái TẮT (DISABLE). Thời gian lịch tính theo UTC."]
  const body = buildAdGroupCreateBody(tt, campaign, input, makeRequestId(opts.idempotencyKey, "adgroup"), opts.now ?? new Date(), warnings)
  const payload = { ...body }
  delete payload.advertiser_id
  if (opts.dryRun) return { preview: true, changes: [summaryChange("(mới)", "ad_group", payload)], warnings, payload }
  const id = await createChecked(tt, { kind: "adgroup", path: "adgroup/create", body, name: input.name, campaignId: input.campaign_id }, warnings)
  if (!id) throw invalid("TikTok không trả về adgroup_id.")
  return { preview: false, changes: [summaryChange(id, "ad_group", payload)], warnings, createdIds: [id], payload }
}

// ---------------------------------------------------------------------------
// tiktok_create_ads
// ---------------------------------------------------------------------------

const creativeInput = z.object({
  ad_name: z.string().trim().min(1).max(512),
  ad_format: z.enum(["SINGLE_VIDEO", "SINGLE_IMAGE", "CAROUSEL_ADS"]),
  identity_type: z.enum(["TT_USER", "BC_AUTH_TT", "AUTH_CODE", "CUSTOMIZED_USER"]).describe("Spark Ads: TT_USER/BC_AUTH_TT/AUTH_CODE"),
  identity_id: z.string().min(1),
  identity_authorized_bc_id: z.string().optional().describe("Bắt buộc với BC_AUTH_TT"),
  video_id: z.string().optional(),
  tiktok_item_id: z.string().optional().describe("Id bài đăng TikTok (Spark Ads pull)"),
  image_ids: z.array(z.string()).max(35).optional().describe("Ảnh; với video non-Spark/push là ảnh bìa (1 ảnh)"),
  ad_text: z.string().max(100).optional(),
  call_to_action: z.string().optional().describe("LEARN_MORE, SHOP_NOW, SIGN_UP, ORDER_NOW, CONTACT_US, SEND_MESSAGE…"),
  landing_page_url: z.url().optional(),
  display_name: z.string().max(40).optional(),
  avatar_icon_web_uri: z.string().optional(),
  // general /ad/create/ fields (doc 1739953377508354); messaging ad groups add their own rules (checkMessagingCreative).
  // Ids stay digit strings.
  page_id: numericId.optional().describe("Id trang (Instant Form / TikTok Instant Page) - tra bằng tiktok_messaging_assets kind=instant_pages"),
  deeplink: deeplinkSchema.optional().describe("Link mở ứng dụng (scheme://…); nhóm IM_URL cần kèm fallback_type WEBSITE + landing_page_url"),
  deeplink_type: z.enum(["NORMAL", "DEFERRED_DEEPLINK"]).optional(),
  fallback_type: z.enum(["APP_INSTALL", "WEBSITE", "UNSET"]).optional(),
  // messaging ad groups only
  auto_message_id: numericId.optional().describe("Nhóm tin nhắn TikTok: id lời chào (bắt buộc)"),
  tracking_message_event_set_id: numericId.optional().describe("Tuỳ chọn: đo cuộc trò chuyện (CLICK + Messenger/WhatsApp, không page_id)"),
})

export const createAdsInput = z.object({
  adgroup_id: numericId,
  creatives: z.array(creativeInput).min(1).max(20),
})
export type CreateAdsInput = z.infer<typeof createAdsInput>

export function validateCreative(
  c: z.infer<typeof creativeInput>,
  idx: number,
  warnings: string[],
  group: MessagingGroup | null = null
): Raw {
  const where = `creatives[${idx}] (${c.ad_name})`
  // messaging ad groups: format / CTA / identity / destination rules; other ad groups refuse the messaging-only fields
  const messagingPatch = checkMessagingCreative(c, where, group, warnings)
  if (c.identity_type === "BC_AUTH_TT" && !c.identity_authorized_bc_id) {
    throw invalid(`${where}: BC_AUTH_TT cần identity_authorized_bc_id.`)
  }
  if (c.identity_type === "AUTH_CODE" && !c.tiktok_item_id) throw invalid(`${where}: AUTH_CODE cần tiktok_item_id.`)
  if (c.identity_type === "CUSTOMIZED_USER" && c.tiktok_item_id) {
    throw invalid(`${where}: CUSTOMIZED_USER không dùng được tiktok_item_id.`)
  }
  if (c.ad_format === "SINGLE_VIDEO") {
    if (!c.video_id && !c.tiktok_item_id) throw invalid(`${where}: video cần video_id hoặc tiktok_item_id.`)
    if (c.video_id && (!c.image_ids || c.image_ids.length !== 1)) {
      throw invalid(`${where}: video tải lên (video_id) cần đúng 1 ảnh bìa trong image_ids.`, "Tải ảnh bìa bằng ads_upload_media.")
    }
  } else if (!c.image_ids?.length && !(c.ad_format === "CAROUSEL_ADS" && c.tiktok_item_id)) {
    // Spark photo post (CAROUSEL_ADS + tiktok_item_id) brings its own images
    throw invalid(`${where}: ${c.ad_format} cần image_ids.`)
  }
  if (c.ad_format === "SINGLE_IMAGE" && c.image_ids && c.image_ids.length !== 1) {
    throw invalid(`${where}: SINGLE_IMAGE chỉ nhận 1 ảnh.`)
  }
  if (c.identity_type === "CUSTOMIZED_USER") {
    warnings.push(
      `${where}: Custom Identity (CUSTOMIZED_USER) không còn tạo quảng cáo mới trên vị trí TikTok/Tự động (tài khoản từ 15/01/2026 bị chặn hoàn toàn) - nên dùng Spark Ads.`
    )
    if (!c.display_name) warnings.push(`${where}: nên có display_name cho quảng cáo không dùng Spark.`)
  }
  if (!c.tiktok_item_id && !c.ad_text) throw invalid(`${where}: cần ad_text.`)
  const creative: Raw = { ...c, ...messagingPatch, operation_status: "DISABLE" }
  for (const k of Object.keys(creative)) if (creative[k] === undefined) delete creative[k]
  return creative
}

async function runCreateAds(
  ctx: ProviderContext<TikTokCredentials>,
  input: CreateAdsInput,
  opts: MutationOptions
): Promise<CreateResult> {
  const tt = ttFromCtx(ctx)
  const group = await fetchOne(tt, "ad_group", input.adgroup_id)
  if (normalizeStatus(group.operation_status, group.secondary_status) === "deleted") {
    throw invalid(`Nhóm quảng cáo ${input.adgroup_id} đã bị xoá.`)
  }
  if (automationType(group) !== "MANUAL" || isUpgradedSmartPlus(group)) {
    throw invalid("Chỉ tạo được quảng cáo trong nhóm quảng cáo thủ công (Manual).")
  }
  if (group.creative_material_mode === "DYNAMIC") {
    throw invalid("Nhóm ACO (Automated Creative Optimization) không tạo quảng cáo thường được.")
  }
  const warnings = ["Quảng cáo được tạo ở trạng thái TẮT (DISABLE) và sẽ qua kiểm duyệt của TikTok."]
  const messaging = messagingGroupOf(group)
  const creatives = input.creatives.map((c, i) => validateCreative(c, i, warnings, messaging))
  const existing = await ttGet<{ page_info?: { total_number?: number } }>(tt, "ad/get", {
    advertiser_id: tt.advertiserId,
    filtering: { adgroup_ids: [input.adgroup_id], primary_status: "STATUS_NOT_DELETE" },
    page: 1,
    page_size: 1,
  })
  const count = Number(existing.data.page_info?.total_number ?? 0)
  if (count + creatives.length > 50) {
    throw invalid(`Nhóm quảng cáo đã có ${count} quảng cáo; TikTok cho tối đa 50 quảng cáo/nhóm.`)
  }
  const payload = { adgroup_id: input.adgroup_id, creatives }
  if (opts.dryRun) return { preview: true, changes: [summaryChange("(mới)", "ads", payload)], warnings, payload }
  // no request_id on /ad/create/ (v1.3) → no automatic retry; after a timeout/5xx look the ads up by name
  // before reporting failure, and never mark the failure retryable (duplicates spend money).
  const ids = (await createAdsChecked(tt, input.adgroup_id, creatives, warnings)).filter((id): id is string => !!id)
  return { preview: false, changes: ids.map((id) => summaryChange(id, "ad", "created")), warnings, createdIds: ids, payload }
}

// ---------------------------------------------------------------------------
// tiktok_update_targeting
// ---------------------------------------------------------------------------

export const updateTargetingInput = z
  .object({
    adgroup_id: numericId,
    location_ids: z.array(numericId).min(1).max(3000).optional(),
    gender: z.enum(["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"]).optional(),
    age_groups: z.array(z.enum(AGE_GROUPS)).optional().describe("[] = mọi độ tuổi được phép"),
    languages: z.array(z.string().min(2).max(10)).optional(),
    audience_ids: z.array(numericId).optional(),
    excluded_audience_ids: z.array(numericId).optional(),
    interest_category_ids: z.array(numericId).optional(),
    interest_keyword_ids: z.array(numericId).optional(),
    operating_systems: z.array(z.enum(["ANDROID", "IOS"])).max(1).optional(),
    network_types: z.array(z.enum(["WIFI", "2G", "3G", "4G", "5G"])).optional(),
    device_price_ranges: z.array(z.number().int().min(0)).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "adgroup_id" && v[k as keyof typeof v] !== undefined), {
    error: "Cần ít nhất 1 trường targeting cần sửa.",
  })
export type UpdateTargetingInput = z.infer<typeof updateTargetingInput>

async function runUpdateTargeting(
  ctx: ProviderContext<TikTokCredentials>,
  input: UpdateTargetingInput,
  opts: MutationOptions
): Promise<MutationResult> {
  const tt = ttFromCtx(ctx)
  const { adgroup_id, ...rest } = input
  const changes: Raw = {}
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) changes[k] = v
  return fullAdgroupUpdate(tt, adgroup_id, changes, opts, [
    "TikTok /adgroup/update/ thay thế toàn bộ cấu hình: app đã đọc cấu hình hiện tại và gửi lại đầy đủ, chỉ thay các trường targeting được yêu cầu.",
  ])
}

/** TikTok "YYYY-MM-DD HH:MM:SS" (UTC) → ISO, for the lifetime-budget flight. */
const ttIso = (t: string | undefined) => (t ? `${t.replace(" ", "T")}Z` : null)

/** Money of tiktok_create_adgroup for the MCP caps (incl. money-like keys passed through `advanced`). */
export function adGroupMoney(input: CreateAdGroupInput): ExtensionMoneyItem[] {
  const items: ExtensionMoneyItem[] = []
  if (input.budget !== undefined && input.budget_type) {
    items.push({
      kind: input.budget_type === "lifetime" ? "lifetime_budget" : "daily_budget",
      amount: input.budget,
      field: "budget",
      startTime: ttIso(input.schedule_start_time),
      endTime: ttIso(input.schedule_end_time),
      // flexible daily budget: TikTok may spend up to 125%/day → cap checked against amount × 1.25
      ...(input.budget_type === "dynamic_daily" ? { dynamic: true as const } : {}),
    })
  }
  if (input.bid_amount !== undefined) items.push({ kind: "bid", amount: input.bid_amount, field: "bid_amount" })
  for (const [k, v] of Object.entries((input.advanced ?? {}) as Raw)) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN
    if (!Number.isFinite(n)) continue
    if (/budget/i.test(k)) items.push({ kind: "daily_budget", amount: n, field: `advanced.${k}` })
    else if (/bid|price|cpa|cost_cap/i.test(k)) items.push({ kind: "bid", amount: n, field: `advanced.${k}` })
  }
  return items
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const tiktokExtensions: ProviderExtension<TikTokCredentials>[] = [
  {
    name: "tiktok_create_campaign",
    permission: "create",
    title: "Tạo chiến dịch TikTok",
    description:
      "Dùng khi cần tạo chiến dịch TikTok thủ công (Manual) mới. Gọi ads_list_accounts trước để biết account_id và tiền tệ. Chiến dịch luôn được tạo ở trạng thái TẮT; chỉ ads_set_status mới bật chạy. objective là objective_type của TikTok; cbo=true bật tối ưu ngân sách chiến dịch (cần budget_type daily/dynamic_daily/lifetime); không CBO có thể để unlimited và đặt ngân sách ở nhóm quảng cáo. Tiền theo đơn vị chính của tiền tệ tài khoản. Lưu ý: TikTok ngừng cho tạo chiến dịch thủ công qua API sau 31/12/2026. Bước tiếp theo: tiktok_create_adgroup.",
    input: createCampaignInput,
    write: true,
    moneyOf: (raw) => {
      const input = raw as CreateCampaignInput
      if (input.budget_type === "unlimited" || input.budget === undefined) return []
      return [
        {
          kind: input.budget_type === "lifetime" ? "lifetime_budget" : "daily_budget",
          amount: input.budget,
          field: "budget",
          // CBO flexible daily budget: TikTok may spend up to 125%/day → cap checked against amount × 1.25
          ...(input.budget_type === "dynamic_daily" ? { dynamic: true as const } : {}),
        },
      ]
    },
    run: (ctx, input, opts) => runCreateCampaign(ctx, input as CreateCampaignInput, opts),
  },
  {
    name: "tiktok_create_adgroup",
    permission: "create",
    title: "Tạo nhóm quảng cáo TikTok",
    description:
      `Dùng khi cần tạo nhóm quảng cáo trong một chiến dịch TikTok thủ công. Gọi ads_list_objects (level=campaign) để lấy campaign_id và ads_lookup (locations, pixels, interests, custom_audiences) để lấy id. location_ids là id số (Việt Nam = 1562822). Lịch dạng \"YYYY-MM-DD HH:MM:SS\" theo UTC; budget_type daily | dynamic_daily | lifetime (lifetime cần schedule_end_time; không có ngày kết thúc thì phải dùng ngân sách ngày; chiến dịch đặt ngân sách ngày không nhận nhóm lifetime); chiến dịch CBO thì bỏ trống ngân sách nhóm. billing_event tự suy ra từ optimization_goal (CLICK/PAGE_VISIT→CPC, SHOW/REACH→CPM, ENGAGED_VIEW→CPV, còn lại→OCPM). CONVERT/VALUE cần pixel_id + optimization_event. Vị trí (placements) không đổi được sau khi tạo. Quảng cáo nhắn tin (chiến dịch LEAD_GENERATION): truyền messaging {destination: TIKTOK_DM | MESSENGER + facebook_page_id | WHATSAPP / ZALO + phone_number (số trong nước bỏ số 0; mã vùng mặc định VN +84) | LINE + line_business_id | IM_URL}; công cụ tự đặt promotion_type và vị trí chỉ TikTok; optimization_goal CLICK (CONVERSATION cần allowlist, không cho Zalo/LINE/IM_URL; tin nhắn TikTok tối ưu CONVERSATION chỉ nhận identity TT_USER - muốn dùng BC_AUTH_TT thì tạo nhóm tối ưu CLICK); không nhắm 13-17; trường nhắn tin không sửa được sau khi tạo; xem trước tài sản bằng tiktok_messaging_assets. Nhóm luôn được tạo ở trạng thái TẮT. Bước tiếp theo: tiktok_create_ads. ${MESSAGING_DEADLINE_NOTE}`,
    input: createAdGroupInput,
    write: true,
    moneyOf: (raw) => adGroupMoney(raw as CreateAdGroupInput),
    run: (ctx, input, opts) => runCreateAdGroup(ctx, input as CreateAdGroupInput, opts),
  },
  {
    name: "tiktok_create_ads",
    permission: "create",
    title: "Tạo quảng cáo TikTok",
    description:
      "Dùng khi cần tạo 1–20 quảng cáo trong một nhóm quảng cáo TikTok thủ công. Cần ads_lookup kind=identities để lấy identity (ưu tiên Spark Ads: TT_USER, BC_AUTH_TT, AUTH_CODE - Custom Identity CUSTOMIZED_USER không còn tạo được trên vị trí TikTok cho nhiều tài khoản) và ads_upload_media để có video_id/image_id. Video tải lên (video_id) cần đúng 1 ảnh bìa trong image_ids; Spark Ads từ bài đăng dùng tiktok_item_id. Tối đa 50 quảng cáo mỗi nhóm. Nhóm nhắn tin: chỉ SINGLE_VIDEO / CAROUSEL_ADS, call_to_action SEND_MESSAGE (tự đặt nếu bỏ trống); tin nhắn TikTok cần auto_message_id (tiktok_messaging_assets kind=welcome_messages hoặc tiktok_create_welcome_message) và identity TT_USER / BC_AUTH_TT có can_manage_message (nhóm tối ưu CONVERSATION: chỉ TT_USER); Messenger / WhatsApp / Zalo / LINE không gửi landing_page_url (TikTok tự tạo link), có thể dùng page_id (Instant Page, CLICK); IM_URL cần landing_page_url https hoặc page_id. Quảng cáo luôn được tạo ở trạng thái TẮT và qua kiểm duyệt; không tự thử lại khi lỗi mạng để tránh tạo trùng.",
    input: createAdsInput,
    write: true,
    run: (ctx, input, opts) => runCreateAds(ctx, input as CreateAdsInput, opts),
  },
  {
    name: "tiktok_update_targeting",
    permission: "update",
    title: "Sửa đối tượng nhóm quảng cáo TikTok",
    description:
      "Dùng khi cần sửa targeting (địa điểm, giới tính, độ tuổi, ngôn ngữ, tệp đối tượng, sở thích, hệ điều hành…) của một nhóm quảng cáo TikTok thủ công. Gọi ads_get_object (level=ad_group) để xem targeting hiện tại và ads_lookup để lấy id. Chỉ truyền các trường cần đổi: app đọc cấu hình hiện tại rồi gửi lại đầy đủ vì /adgroup/update/ của TikTok thay thế toàn bộ. Mảng rỗng [] nghĩa là bỏ điều kiện đó. Không áp dụng cho Upgraded Smart+.",
    input: updateTargetingInput,
    write: true,
    run: (ctx, input, opts) => runUpdateTargeting(ctx, input as UpdateTargetingInput, opts),
  },
  // Upgraded Smart+ create (campaign → ad group → ad, all DISABLE; allowlist-only) - smart-plus.ts
  smartPlusExtension,
  // messaging ads: prerequisites (read) + welcome messages (create) - messaging.ts
  ...messagingExtensions,
  // GMV Max (TikTok Shop): analysis tools (gmv-max.ts) + reads / writes behind the admin-only MCP switch (gmv-max-write.ts)
  ...gmvMaxExtensions,
  ...gmvMaxWriteExtensions,
]
