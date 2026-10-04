// OpenAI-specific MCP tools. Money inputs are MAJOR units of the account currency (adapter → micros).
// Every create is PAUSED and carries a deterministic Idempotency-Key (derived from opts.idempotencyKey - the
// pending-action id - or from a hash of the canonical input; never random).
import { z } from "zod"
import { isProviderError, ProviderError } from "../errors"
import { fromMicros } from "../money"
import type { ExtensionMoneyItem, FieldChange, MutationOptions, MutationResult, ProviderContext, ProviderExtension } from "../types"
import { createIdempotencyKey, listAll, oaRequest, PLATFORM } from "./client"
import { getConversions, type ConversionsResult } from "./conversions"
import type { OpenAIAdsCredentials } from "./credentials"
import { assertImageUrl, uploadImageUrl } from "./media"
import {
  bidFromRaw,
  fetchRaw,
  resolveParentId,
  unixToIso,
  type RawAd,
  type RawAdGroup,
  type RawBiddingConfig,
  type RawCampaign,
} from "./objects"
import { bidMeaningVi, bidMicros, biddingToParams, budgetParams, isoToUnix, microsInt, writeApplied } from "./payloads"

type Ctx = ProviderContext<OpenAIAdsCredentials>

function invalid(message: string, vi: string, hint?: string) {
  return new ProviderError({ platform: PLATFORM, code: "invalid_request", message, userMessageVi: vi, hint })
}

function define<I, O>(e: ProviderExtension<OpenAIAdsCredentials, I, O>): ProviderExtension<OpenAIAdsCredentials, I, O> {
  return e
}

const nonBlank = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { error: `Tối thiểu ${min} ký tự.` })
    .max(max, { error: `Tối đa ${max} ký tự.` })

const isoDateTime = z.string().describe("Thời điểm ISO 8601 có múi giờ, vd 2026-10-05T00:00:00+07:00")
const httpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/\S+$/i, { error: "URL phải bắt đầu bằng http:// hoặc https://" })

const PLATFORMS = ["ios_app", "android_app", "web", "desktop_web", "ios_web", "android_web"] as const

const CAMPAIGN_RULES = {
  impressions: { billing: "impression", strategies: ["fixed_bid"] },
  clicks: { billing: "click", strategies: ["fixed_bid", "maximize_clicks"] },
  conversions: { billing: "click", strategies: ["fixed_bid", "maximize_conversions"] },
} as const satisfies Record<string, { billing: "impression" | "click"; strategies: readonly string[] }>

type BiddingType = keyof typeof CAMPAIGN_RULES
type Strategy = "fixed_bid" | "maximize_clicks" | "maximize_conversions"

const isMaximize = (s: string | undefined) => s === "maximize_clicks" || s === "maximize_conversions"

function createChange(level: "campaign" | "ad_group" | "ad", after: Record<string, unknown>, id: string | null = null): FieldChange {
  return { objectId: id ?? "(mới)", objectName: (after.name as string) ?? null, level, field: "create", before: null, after }
}

// ---------------------------------------------------------------------------
// openai_ads_create_campaign
// ---------------------------------------------------------------------------

const createCampaignInput = z.object({
  name: nonBlank(3, 1000).describe("Tên campaign (3–1000 ký tự)"),
  description: z.string().max(5000).optional(),
  bidding_type: z
    .enum(["impressions", "clicks", "conversions"])
    .describe("Mục tiêu/kiểu giá thầu - KHÔNG đổi được sau khi tạo. conversions cần conversion_event_setting_id."),
  budget: z.object({
    type: z.enum(["daily", "lifetime"]).describe("daily = theo ngày (bắt buộc nếu dùng Maximize); lifetime = trọn đời"),
    amount: z.number().positive().describe("Số tiền theo đơn vị chính của tiền tệ tài khoản (tối thiểu 1)"),
  }),
  conversion_event_setting_id: z.string().min(1).optional().describe("Bắt buộc khi bidding_type=conversions (ads_lookup conversion_events)"),
  countries: z
    .array(z.string().regex(/^[A-Za-z]{2}$/, { error: "Mã quốc gia ISO-2, vd VN" }))
    .max(250)
    .optional()
    .describe("Mã quốc gia ISO-2, vd [\"VN\"]"),
  location_ids: z.array(z.string().min(1)).max(2500).optional().describe("id địa điểm từ ads_lookup kind=locations"),
  all_locations: z
    .boolean()
    .optional()
    .describe("Chỉ đặt true khi người dùng muốn chạy ở MỌI địa điểm khả dụng; nếu không phải truyền countries hoặc location_ids"),
  excluded_location_ids: z.array(z.string().min(1)).max(2500).optional(),
  platforms: z.array(z.enum(PLATFORMS)).optional().describe("Bỏ trống = mọi nền tảng ChatGPT"),
  custom_audience_ids: z.array(z.string().min(1)).optional(),
  excluded_custom_audience_ids: z.array(z.string().min(1)).optional(),
  start_time: isoDateTime.optional(),
  end_time: isoDateTime.optional(),
  url_query_template: z.string().max(2048).optional().describe("Tham số UTM thêm vào URL đích, hỗ trợ {campaign_id} {ad_id} {oppref}"),
})
type CreateCampaignInput = z.infer<typeof createCampaignInput>

async function runCreateCampaign(ctx: Ctx, input: CreateCampaignInput, opts: MutationOptions): Promise<MutationResult> {
  const currency = ctx.account.currency
  const warnings: string[] = [
    `bidding_type "${input.bidding_type}" là cố định - muốn đổi phải tạo campaign mới.`,
    "Campaign được tạo ở trạng thái TẠM DỪNG; cần thêm ad group + quảng cáo rồi bật bằng ads_set_status.",
  ]
  const budget = budgetParams(input.budget.type, input.budget.amount, currency, warnings)
  if (input.budget.type === "lifetime") {
    warnings.push("Ngân sách trọn đời không dùng được với chiến lược Maximize; có thể đổi sang hằng ngày sau nhưng không đổi ngược lại.")
  }
  warnings.push("Mức ngân sách ngày tối thiểu phụ thuộc tiền tệ - OpenAI sẽ báo mức yêu cầu nếu thấp hơn.")

  const body: Record<string, unknown> = { name: input.name, status: "paused", budget, bidding_type: input.bidding_type }
  if (input.description) body.description = input.description

  if (input.bidding_type === "conversions") {
    if (!input.conversion_event_setting_id) {
      throw invalid("conversion event required", "Campaign chuyển đổi cần đúng 1 conversion_event_setting_id (ads_lookup kind=conversion_events).")
    }
    await assertConversionEvent(ctx, input.conversion_event_setting_id)
    body.conversion_event_setting_ids = [input.conversion_event_setting_id]
    warnings.push("Campaign chuyển đổi tối ưu theo sự kiện đã chọn và tính phí theo lượt nhấp.")
  } else if (input.conversion_event_setting_id) {
    throw invalid("conversion event not allowed", "Chỉ campaign bidding_type=conversions mới chọn sự kiện chuyển đổi.")
  }

  const start = input.start_time ? isoToUnix(input.start_time, "start_time") : undefined
  const end = input.end_time ? isoToUnix(input.end_time, "end_time") : undefined
  if (start !== undefined && end !== undefined && end <= start) throw invalid("end <= start", "end_time phải sau start_time.")
  if (end !== undefined && end * 1000 <= Date.now()) throw invalid("end in past", "end_time đã qua.")
  if (start !== undefined) body.start_time = start
  if (end !== undefined) body.end_time = end

  const targeting: Record<string, unknown> = {}
  const locations: Record<string, unknown> = {}
  if (input.countries?.length) locations.countries = input.countries.map((c) => c.toUpperCase())
  if (input.location_ids?.length) locations.include = input.location_ids.map((id) => ({ id }))
  if (Object.keys(locations).length) {
    if (input.all_locations) {
      throw invalid("all_locations with locations", "Đã chọn all_locations=true nhưng vẫn truyền countries/location_ids - chỉ chọn một cách.")
    }
    targeting.locations = locations
  } else if (input.all_locations === true) {
    warnings.push("all_locations=true: campaign phân phối ở MỌI địa điểm khả dụng của OpenAI Ads.")
  } else {
    throw invalid(
      "locations required",
      "Cần chọn địa điểm: truyền countries (vd [\"VN\"]) hoặc location_ids (ads_lookup kind=locations).",
      "Chỉ đặt all_locations=true khi người dùng xác nhận muốn chạy ở mọi địa điểm."
    )
  }
  if (input.excluded_location_ids?.length) targeting.excluded_locations = { include: input.excluded_location_ids.map((id) => ({ id })) }
  if (input.platforms?.length) targeting.platforms = { included: [...new Set(input.platforms)] }
  if (input.custom_audience_ids?.length) targeting.custom_audiences = { ids: input.custom_audience_ids }
  if (input.excluded_custom_audience_ids?.length) targeting.excluded_custom_audiences = { ids: input.excluded_custom_audience_ids }
  if (Object.keys(targeting).length) body.targeting = targeting
  if (input.url_query_template) body.landing_page_configuration = { query_string_template: input.url_query_template }

  const summary: Record<string, unknown> = {
    ...body,
    budget: { type: input.budget.type, amount: fromMicros(Object.values(budget)[0]!), currency },
    start_time: start !== undefined ? unixToIso(start) : null,
    end_time: end !== undefined ? unixToIso(end) : null,
  }
  if (opts.dryRun) return { preview: true, changes: [createChange("campaign", summary)], warnings, createdIds: [] }

  const created = await oaRequest<RawCampaign>(ctx, {
    method: "POST",
    path: "/campaigns",
    body,
    idempotencyKey: createIdempotencyKey(ctx.account.externalId, "openai_ads_create_campaign", input, opts.idempotencyKey),
  })
  return { preview: false, changes: [createChange("campaign", summary, created.id)], warnings, createdIds: [created.id] }
}

async function assertConversionEvent(ctx: Ctx, id: string) {
  try {
    const { items } = await listAll<{ id: string; archived: boolean; event_type: string; name: string }>(
      ctx,
      "/conversions/event_settings",
      {},
      { maxItems: 1_000, gated: true }
    )
    const found = items.find((s) => s.id === id)
    if (!found) throw invalid("Unknown conversion event", `Không tìm thấy sự kiện chuyển đổi ${id} trong tài khoản.`, "Gọi ads_lookup kind=conversion_events.")
    if (found.archived) throw invalid("Archived conversion event", `Sự kiện chuyển đổi ${found.name} đã lưu trữ - chọn sự kiện đang hoạt động.`)
  } catch (e) {
    if (isProviderError(e) && e.code === "feature_not_enabled") {
      throw new ProviderError({
        platform: PLATFORM,
        code: "feature_not_enabled",
        message: "Conversions not enabled",
        userMessageVi: "Tài khoản chưa bật Conversions - không tạo được campaign tối ưu chuyển đổi.",
        hint: "Liên hệ đội OpenAI Ads để bật conversion tracking/bidding.",
        upstream: e.upstream,
      })
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// openai_ads_create_ad_group
// ---------------------------------------------------------------------------

const multiplierInput = z.object({
  custom_audience_id: z.string().min(1),
  multiplier: z.number().min(0.1).max(10).describe("Hệ số giá thầu 0,1–10 (chỉ với fixed_bid)"),
})

const biddingInput = z.object({
  strategy: z
    .enum(["fixed_bid", "maximize_clicks", "maximize_conversions"])
    .optional()
    .describe("Bỏ trống: có max_bid → fixed_bid; không có → Maximize theo mục tiêu campaign"),
  max_bid: z
    .number()
    .positive()
    .optional()
    .describe(
      "Giá thầu theo đơn vị tiền chính. Campaign conversions (oCPC): đây là CPA MỤC TIÊU (giá cho mỗi chuyển đổi). Campaign clicks: giá tối đa mỗi lượt nhấp. Campaign impressions: giá MỖI lượt hiển thị, KHÔNG phải CPM (CPM 60 → 0,06)."
    ),
  billing_event_type: z.enum(["impression", "click"]).optional().describe("Tự suy ra từ bidding_type của campaign nếu bỏ trống"),
  audience_bid_multipliers: z.array(multiplierInput).max(100).optional(),
})

const contextHints = z.array(z.string().trim().min(1).max(1000)).max(2000)

const createAdGroupInput = z.object({
  campaign_id: z.string().min(1).describe("id campaign (ads_list_objects level=campaign)"),
  name: nonBlank(3, 1000),
  description: z.string().max(5000).optional(),
  context_hints: contextHints
    .optional()
    .describe("Tối đa 2.000 gợi ý ngữ cảnh dạng câu tự do (KHÔNG phải từ khoá) mô tả cuộc trò chuyện nên hiện quảng cáo"),
  bidding: biddingInput,
})
type CreateAdGroupInput = z.infer<typeof createAdGroupInput>

interface ResolvedBidding {
  config: RawBiddingConfig
  warnings: string[]
}

/** Validate a bidding config against the campaign objective/billing/strategy table and budget type. */
export function resolveBidding(
  campaign: Pick<RawCampaign, "bidding_type" | "budget">,
  b: z.infer<typeof biddingInput>,
  current?: RawBiddingConfig,
  currency = "USD"
): ResolvedBidding {
  const warnings: string[] = []
  const bt = (campaign.bidding_type ?? "impressions") as BiddingType
  const rule = CAMPAIGN_RULES[bt]
  if (!rule) throw invalid("Unknown bidding_type", `bidding_type ${campaign.bidding_type} của campaign không được hỗ trợ.`)
  const billing = b.billing_event_type ?? rule.billing
  if (billing !== rule.billing) {
    throw invalid("billing mismatch", `Campaign ${bt} phải tính phí theo ${rule.billing} (không phải ${billing}).`)
  }
  const currentStrategy = current?.strategy as Strategy | undefined
  let strategy: Strategy | undefined = b.strategy
  if (!strategy) {
    if (b.max_bid !== undefined) strategy = "fixed_bid"
    else if (currentStrategy && (rule.strategies as readonly string[]).includes(currentStrategy)) strategy = currentStrategy
    else strategy = bt === "clicks" ? "maximize_clicks" : bt === "conversions" ? "maximize_conversions" : "fixed_bid"
  }
  if (!(rule.strategies as readonly string[]).includes(strategy)) {
    throw invalid(
      "strategy mismatch",
      `Chiến lược ${strategy} không hợp lệ cho campaign ${bt}. Hợp lệ: ${rule.strategies.join(", ")}.`
    )
  }
  const config: RawBiddingConfig = { billing_event_type: billing, strategy }
  if (strategy === "fixed_bid") {
    const bid =
      b.max_bid !== undefined
        ? bidMicros(b.max_bid, currency, { perImpression: billing === "impression", warnings })
        : current?.strategy === "fixed_bid"
          ? current.max_bid_micros
          : undefined
    if (bid === undefined) {
      throw invalid(
        "max_bid required",
        bt === "conversions"
          ? "fixed_bid của campaign chuyển đổi bắt buộc có max_bid = CPA mục tiêu (giá cho mỗi chuyển đổi)."
          : "fixed_bid bắt buộc có max_bid (giá mỗi sự kiện tính phí)."
      )
    }
    config.max_bid_micros = bid
    const multipliers =
      b.audience_bid_multipliers?.map((m) => ({
        custom_audience_id: m.custom_audience_id,
        bid_multiplier_micros: microsInt(m.multiplier, "multiplier"),
      })) ??
      (current?.strategy === "fixed_bid" ? (current.custom_audience_bid_multipliers ?? []) : [])
    config.custom_audience_bid_multipliers = multipliers
    if (billing === "impression") {
      warnings.push(`Giá thầu ${fromMicros(bid)} là cho MỖI lượt hiển thị (tương đương CPM ${(fromMicros(bid)! * 1000).toLocaleString("vi-VN")}).`)
    }
    if (bt === "conversions") {
      warnings.push(`Campaign tối ưu chuyển đổi (oCPC): max_bid ${fromMicros(bid)} ${currency} là CPA MỤC TIÊU (giá cho mỗi chuyển đổi), không phải giá mỗi lượt nhấp.`)
    }
  } else {
    if (b.max_bid !== undefined) throw invalid("max_bid with maximize", "Chiến lược Maximize không nhận max_bid - bỏ max_bid hoặc dùng fixed_bid.")
    if (b.audience_bid_multipliers?.length) throw invalid("multipliers with maximize", "Hệ số giá thầu theo tệp đối tượng chỉ dùng với fixed_bid.")
    if (typeof campaign.budget?.daily_spend_limit_micros !== "number") {
      throw invalid(
        "maximize needs daily budget",
        "Chiến lược Maximize cần campaign có ngân sách HẰNG NGÀY.",
        "Đổi ngân sách campaign sang daily (ads_update_budget) trước, hoặc dùng fixed_bid."
      )
    }
    config.custom_audience_bid_multipliers = []
  }
  return { config, warnings }
}

function biddingSummary(c: RawBiddingConfig, currency: string, biddingType?: string | null) {
  return {
    billing_event_type: c.billing_event_type,
    strategy: c.strategy ?? null,
    max_bid: bidFromRaw(c),
    ...(biddingType !== undefined ? { max_bid_meaning: bidMeaningVi(biddingType, c.billing_event_type) } : {}),
    currency,
    custom_audience_bid_multipliers: (c.custom_audience_bid_multipliers ?? []).map((m) => ({
      custom_audience_id: m.custom_audience_id,
      multiplier: fromMicros(m.bid_multiplier_micros),
    })),
  }
}

async function runCreateAdGroup(ctx: Ctx, input: CreateAdGroupInput, opts: MutationOptions): Promise<MutationResult> {
  const campaign = await fetchRaw<RawCampaign>(ctx, "campaign", input.campaign_id)
  if (campaign.status === "archived") throw invalid("Campaign archived", "Campaign đã lưu trữ - không thể thêm ad group.")
  const { config, warnings } = resolveBidding(campaign, input.bidding, undefined, ctx.account.currency)
  warnings.push("Ad group được tạo ở trạng thái TẠM DỪNG.")
  if (!input.context_hints?.length) warnings.push("Chưa có context_hints - OpenAI sẽ tự suy ra ngữ cảnh từ quảng cáo/landing page.")
  const body: Record<string, unknown> = {
    campaign_id: campaign.id,
    name: input.name,
    status: "paused",
    bidding_config: config,
  }
  if (input.description) body.description = input.description
  if (input.context_hints?.length) body.context_hints = input.context_hints
  const summary = {
    ...body,
    campaign_name: campaign.name,
    bidding_config: biddingSummary(config, ctx.account.currency, campaign.bidding_type ?? null),
    context_hints_count: input.context_hints?.length ?? 0,
    context_hints: undefined,
  }
  if (opts.dryRun) return { preview: true, changes: [createChange("ad_group", summary)], warnings, createdIds: [] }
  const created = await oaRequest<RawAdGroup>(ctx, {
    method: "POST",
    path: "/ad_groups",
    body,
    // required for Maximize Results; always sent
    idempotencyKey: createIdempotencyKey(ctx.account.externalId, "openai_ads_create_ad_group", input, opts.idempotencyKey),
  })
  return { preview: false, changes: [createChange("ad_group", summary, created.id)], warnings, createdIds: [created.id] }
}

// ---------------------------------------------------------------------------
// openai_ads_create_ad
// ---------------------------------------------------------------------------

const createAdInput = z
  .object({
    ad_group_id: z.string().min(1).describe("id ad group (ads_list_objects level=ad_group)"),
    name: nonBlank(3, 1000).describe("Tên nội bộ của quảng cáo"),
    title: nonBlank(3, 50).describe("Tiêu đề chat card (3–50 ký tự)"),
    body: nonBlank(1, 100).describe("Nội dung chat card (tối đa 100 ký tự)"),
    target_url: httpUrl.describe("URL đích, phải truy cập/crawl được"),
    file_id: z.string().min(1).optional().describe("file_id từ ads_upload_media"),
    image_url: httpUrl.optional().describe("Hoặc URL ảnh công khai (JPEG/PNG/WebP ≥640×640) - sẽ được tải lên trước"),
    image_crop: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
      .optional()
      .describe("Vùng cắt vuông (tỷ lệ 0–1 của ảnh gốc)"),
  })
  .refine((v) => !!v.file_id !== !!v.image_url, { error: "Cần đúng một trong file_id hoặc image_url." })
type CreateAdInput = z.infer<typeof createAdInput>

async function runCreateAd(ctx: Ctx, input: CreateAdInput, opts: MutationOptions): Promise<MutationResult> {
  const group = await fetchRaw<RawAdGroup>(ctx, "ad_group", input.ad_group_id)
  if (group.status === "archived") throw invalid("Ad group archived", "Ad group đã lưu trữ - không thể thêm quảng cáo.")
  const warnings = [
    "Quảng cáo được tạo ở trạng thái TẠM DỪNG và sẽ được OpenAI xét duyệt (review_status=in_review) trước khi phân phối.",
  ]
  if (input.image_url) assertImageUrl(input.image_url)
  const creative: Record<string, unknown> = {
    type: "chat_card",
    title: input.title,
    body: input.body,
    target_url: input.target_url,
  }
  if (input.file_id) creative.file_id = input.file_id
  if (input.image_crop) creative.image_crop = input.image_crop
  const body: Record<string, unknown> = { ad_group_id: group.id, name: input.name, status: "paused", creative }
  const summary = { ...body, ad_group_name: group.name, image_url: input.image_url ?? null }
  if (opts.dryRun) {
    if (input.image_url) warnings.push("Ảnh sẽ được tải lên OpenAI khi xác nhận.")
    return { preview: true, changes: [createChange("ad", summary)], warnings, createdIds: [] }
  }
  if (input.image_url) creative.file_id = await uploadImageUrl(ctx, input.image_url)
  const created = await oaRequest<RawAd>(ctx, {
    method: "POST",
    path: "/ads",
    body,
    idempotencyKey: createIdempotencyKey(ctx.account.externalId, "openai_ads_create_ad", input, opts.idempotencyKey),
  })
  return {
    preview: false,
    changes: [createChange("ad", { ...summary, file_id: creative.file_id }, created.id)],
    warnings,
    createdIds: [created.id],
  }
}

// ---------------------------------------------------------------------------
// openai_ads_update_ad_group (context hints / bidding)
// ---------------------------------------------------------------------------

const updateAdGroupInput = z.object({
  ad_group_id: z.string().min(1),
  campaign_id: z.string().min(1).optional().describe("id campaign cha (giúp kiểm tra chiến lược hợp lệ; tự tra nếu bỏ trống)"),
  name: nonBlank(3, 1000).optional(),
  description: z.string().max(5000).nullable().optional(),
  context_hints: z
    .object({
      mode: z.enum(["replace", "add", "remove"]).describe("replace = thay toàn bộ; add = thêm; remove = bỏ các gợi ý"),
      hints: contextHints,
    })
    .optional(),
  bidding: biddingInput.optional(),
})
type UpdateAdGroupInput = z.infer<typeof updateAdGroupInput>

async function runUpdateAdGroup(ctx: Ctx, input: UpdateAdGroupInput, opts: MutationOptions): Promise<MutationResult> {
  const raw = await fetchRaw<RawAdGroup>(ctx, "ad_group", input.ad_group_id)
  const { body, changes, warnings } = await planAdGroupUpdate(ctx, input, raw)
  if (changes.length === 0) {
    warnings.push("Không có thay đổi so với hiện tại.")
    return { preview: !!opts.dryRun, changes, warnings }
  }
  if (!opts.dryRun) {
    await oaRequest<RawAdGroup>(ctx, {
      method: "POST",
      path: `/ad_groups/${encodeURIComponent(raw.id)}`,
      body,
      // success only when every changed field is visible (updated_at alone may move for unrelated reasons)
      verify: async (sent) => {
        const r = await fetchRaw<RawAdGroup>(ctx, "ad_group", raw.id)
        return writeApplied(sent as Record<string, unknown>, r as unknown as Record<string, unknown>) ? r : null
      },
      // 409: re-read and re-merge the same requested change on top of the fresh object
      rebuild: async () => {
        const fresh = await fetchRaw<RawAdGroup>(ctx, "ad_group", raw.id)
        const again = await planAdGroupUpdate(ctx, input, fresh)
        return again.changes.length ? again.body : null
      },
    })
  }
  return { preview: !!opts.dryRun, changes, warnings }
}

async function planAdGroupUpdate(
  ctx: Ctx,
  input: UpdateAdGroupInput,
  raw: RawAdGroup
): Promise<{ body: Record<string, unknown>; changes: FieldChange[]; warnings: string[] }> {
  if (raw.status === "archived") throw invalid("Ad group archived", "Ad group đã lưu trữ - không thể chỉnh sửa.")
  const currency = ctx.account.currency
  const body: Record<string, unknown> = {}
  const changes: FieldChange[] = []
  const warnings: string[] = []
  const base = { objectId: raw.id, objectName: raw.name, level: "ad_group" as const }

  if (input.name !== undefined && input.name !== raw.name) {
    body.name = input.name
    changes.push({ ...base, field: "name", before: raw.name, after: input.name })
  }
  if (input.description !== undefined && input.description !== raw.description) {
    body.description = input.description
    changes.push({ ...base, field: "description", before: raw.description, after: input.description })
  }
  if (input.context_hints) {
    const current = raw.context_hints ?? []
    const { mode, hints } = input.context_hints
    let next: string[]
    if (mode === "replace") next = [...new Set(hints)]
    else if (mode === "add") next = [...new Set([...current, ...hints])]
    else {
      const drop = new Set(hints)
      next = current.filter((h) => !drop.has(h))
    }
    if (next.length > 2000) throw invalid("Too many hints", `Tối đa 2.000 context_hints (sẽ là ${next.length}).`)
    const same = next.length === current.length && next.every((h, i) => h === current[i])
    if (!same) {
      body.context_hints = next // full list (update replaces the list)
      changes.push({ ...base, field: "context_hints", before: current, after: next })
    }
  }
  if (input.bidding) {
    const campaignId = input.campaign_id ?? raw.campaign_id ?? (await resolveParentId(ctx, "ad_group", raw.id))
    let campaign: Pick<RawCampaign, "bidding_type" | "budget"> | null = null
    if (campaignId) campaign = await fetchRaw<RawCampaign>(ctx, "campaign", campaignId)
    let config: RawBiddingConfig
    if (campaign) {
      const resolved = resolveBidding(campaign, input.bidding, raw.bidding_config, currency)
      config = resolved.config
      warnings.push(...resolved.warnings)
    } else {
      // campaign unknown: merge without the objective table; OpenAI validates compatibility
      warnings.push("Không xác định được campaign cha - tính hợp lệ của chiến lược sẽ do OpenAI kiểm tra.")
      config = biddingToParams(raw.bidding_config)
      if (input.bidding.billing_event_type) config.billing_event_type = input.bidding.billing_event_type
      if (input.bidding.strategy) config.strategy = input.bidding.strategy
      if (input.bidding.max_bid !== undefined) {
        config.max_bid_micros = bidMicros(input.bidding.max_bid, currency, { perImpression: config.billing_event_type === "impression", warnings })
        config.strategy ??= "fixed_bid"
      }
      if (isMaximize(config.strategy)) {
        if (input.bidding.max_bid !== undefined) throw invalid("max_bid with maximize", "Chiến lược Maximize không nhận max_bid.")
        delete config.max_bid_micros
        config.custom_audience_bid_multipliers = []
      } else if (input.bidding.audience_bid_multipliers) {
        config.custom_audience_bid_multipliers = input.bidding.audience_bid_multipliers.map((m) => ({
          custom_audience_id: m.custom_audience_id,
          bid_multiplier_micros: microsInt(m.multiplier, "multiplier"),
        }))
      }
      if (config.strategy === "fixed_bid" && typeof config.max_bid_micros !== "number") {
        throw invalid("max_bid required", "fixed_bid bắt buộc có max_bid.")
      }
    }
    const bt = campaign ? (campaign.bidding_type ?? null) : undefined
    const before = biddingSummary(raw.bidding_config, currency, bt)
    const after = biddingSummary(config, currency, bt)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      body.bidding_config = config // full object (update replaces bidding_config)
      changes.push({ ...base, field: "bidding_config", before, after })
      if (isMaximize(raw.bidding_config?.strategy) !== isMaximize(config.strategy)) {
        warnings.push("Đổi giữa fixed_bid và Maximize thay đổi cách ad group đặt giá - hiệu quả có thể dao động vài ngày.")
      }
      if (raw.bidding_config?.custom_audience_bid_multipliers?.length && !config.custom_audience_bid_multipliers?.length) {
        warnings.push("Hệ số giá thầu theo tệp đối tượng sẽ bị xoá; muốn khôi phục phải nhập lại.")
      }
    }
  }
  return { body, changes, warnings }
}

// ---------------------------------------------------------------------------
// openai_ads_get_conversions
// ---------------------------------------------------------------------------

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Định dạng YYYY-MM-DD" })

const getConversionsInput = z.object({
  level: z.enum(["campaign", "ad_group", "ad"]),
  entity_ids: z.array(z.string().min(1)).max(500).optional().describe("Bỏ trống = tổng toàn tài khoản"),
  date_from: ymd.describe("Ngày bắt đầu theo múi giờ tài khoản"),
  date_to: ymd.describe("Ngày kết thúc (bao gồm), tối đa 365 ngày"),
  granularity: z.enum(["day", "total"]).default("total"),
  breakdown: z.enum(["country", "device"]).optional(),
  attribution_window_days: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional().describe("Cửa sổ sau nhấp, mặc định 30"),
  view_through_attribution_window_days: z.union([z.literal(0), z.literal(1)]).optional().describe("Cửa sổ sau xem, mặc định 1; 0 = bỏ"),
  attribution_time_basis: z.enum(["ad_event_time", "conversion_time"]).optional(),
  include_events: z.boolean().optional().describe("Thêm chi tiết từng sự kiện (kể cả sự kiện không phải mục tiêu)"),
  event_names: z.array(z.string().min(1).max(256)).min(1).max(500).optional(),
})
type GetConversionsInput = z.infer<typeof getConversionsInput>

function runGetConversions(ctx: Ctx, input: GetConversionsInput): Promise<ConversionsResult> {
  return getConversions(ctx, {
    level: input.level,
    entityIds: input.entity_ids,
    from: input.date_from,
    to: input.date_to,
    granularity: input.granularity,
    breakdown: input.breakdown,
    attributionWindowDays: input.attribution_window_days,
    viewThroughWindowDays: input.view_through_attribution_window_days,
    timeBasis: input.attribution_time_basis,
    includeEvents: input.include_events,
    eventNames: input.event_names,
  })
}

// ---------------------------------------------------------------------------

/** Effective maximum bid for the MCP bid cap: max_bid × the largest audience multiplier (≥ 1). */
export function biddingMoney(b: z.infer<typeof biddingInput> | undefined): ExtensionMoneyItem[] {
  if (!b || b.max_bid === undefined) return []
  const mult = Math.max(1, ...(b.audience_bid_multipliers ?? []).map((m) => m.multiplier))
  return [{ kind: "bid", amount: b.max_bid * mult, field: mult > 1 ? "bidding.max_bid × audience_bid_multipliers" : "bidding.max_bid" }]
}

export const extensions: ProviderExtension<OpenAIAdsCredentials>[] = [
  define({
    name: "openai_ads_create_campaign",
    permission: "create",
    title: "Tạo campaign OpenAI Ads",
    description:
      "Dùng khi cần tạo campaign quảng cáo ChatGPT (OpenAI Ads) mới. Campaign luôn được tạo ở trạng thái tạm dừng. " +
      "Chọn bidding_type (impressions | clicks | conversions) - không đổi được sau khi tạo; conversions cần conversion_event_setting_id lấy từ ads_lookup kind=conversion_events. " +
      "Ngân sách nhập theo đơn vị tiền chính của tài khoản (daily hoặc lifetime, tối thiểu 1). BẮT BUỘC nhắm địa điểm bằng mã quốc gia ISO-2 (countries) hoặc id từ ads_lookup kind=locations - chỉ đặt all_locations=true khi người dùng muốn chạy mọi nơi; " +
      "nền tảng ChatGPT qua platforms. OpenAI Ads không có nhắm tuổi/giới tính/sở thích/từ khoá. Sau khi tạo: openai_ads_create_ad_group → openai_ads_create_ad → ads_set_status.",
    input: createCampaignInput,
    write: true,
    moneyOf: (input) => [
      {
        kind: input.budget.type === "daily" ? "daily_budget" : "lifetime_budget",
        amount: input.budget.amount,
        field: "budget.amount",
        startTime: input.start_time ?? null,
        endTime: input.end_time ?? null,
      },
    ],
    run: runCreateCampaign,
  }),
  define({
    name: "openai_ads_create_ad_group",
    permission: "create",
    title: "Tạo ad group OpenAI Ads",
    description:
      "Dùng khi cần thêm ad group vào một campaign OpenAI Ads (lấy campaign_id bằng ads_list_objects). Ad group luôn tạo ở trạng thái tạm dừng. " +
      "context_hints: tối đa 2.000 câu mô tả ngữ cảnh hội thoại phù hợp (không phải từ khoá). " +
      "Giá thầu phải khớp mục tiêu campaign: impressions → impression + fixed_bid; clicks → click + fixed_bid hoặc maximize_clicks; conversions → click + fixed_bid hoặc maximize_conversions. " +
      "Maximize cần campaign có ngân sách hằng ngày và không nhận max_bid. max_bid theo đơn vị tiền chính: campaign conversions → CPA MỤC TIÊU (giá mỗi chuyển đổi); clicks → giá tối đa mỗi lượt nhấp; impressions → giá MỖI lượt hiển thị (không phải CPM).",
    input: createAdGroupInput,
    write: true,
    moneyOf: (input) => biddingMoney(input.bidding),
    run: runCreateAdGroup,
  }),
  define({
    name: "openai_ads_create_ad",
    permission: "create",
    title: "Tạo quảng cáo OpenAI Ads",
    description:
      "Dùng khi cần tạo quảng cáo chat card trong một ad group OpenAI Ads (lấy ad_group_id bằng ads_list_objects). Quảng cáo tạo ở trạng thái tạm dừng và phải được OpenAI duyệt. " +
      "Cần title 3–50 ký tự, body tối đa 100 ký tự, target_url truy cập được, và ảnh: file_id (từ ads_upload_media) hoặc image_url công khai (JPEG/PNG/WebP ≥640×640, sẽ được tải lên trước). " +
      "Bật chạy bằng ads_set_status sau khi kiểm tra.",
    input: createAdInput,
    write: true,
    run: runCreateAd,
  }),
  define({
    name: "openai_ads_update_ad_group",
    permission: "update",
    title: "Sửa ad group OpenAI Ads",
    description:
      "Dùng khi cần sửa context_hints (thay toàn bộ, thêm hoặc bớt) hoặc cấu hình giá thầu của ad group OpenAI Ads (đổi max_bid, chuyển fixed_bid ↔ Maximize, hệ số giá theo tệp đối tượng). " +
      "Gọi ads_get_object level=ad_group trước để xem cấu hình hiện tại. Hệ thống đọc cấu hình hiện tại, ghép thay đổi và gửi lại đầy đủ (OpenAI thay thế cả danh sách/đối tượng). " +
      "Giá tiền theo đơn vị tiền chính: với campaign conversions, max_bid là CPA MỤC TIÊU (giá mỗi chuyển đổi).",
    input: updateAdGroupInput,
    write: true,
    moneyOf: (input) => biddingMoney(input.bidding),
    run: runUpdateAdGroup,
  }),
  define({
    name: "openai_ads_get_conversions",
    permission: "read",
    title: "Báo cáo chuyển đổi OpenAI Ads",
    description:
      "Dùng khi cần số chuyển đổi mục tiêu (click-through/view-through) và doanh thu đơn hàng được ghi nhận của OpenAI Ads theo campaign/ad group/ad, theo ngày hoặc tổng kỳ, có thể chia theo quốc gia/thiết bị. " +
      "Lấy id bằng ads_list_objects; bỏ trống entity_ids để lấy tổng toàn tài khoản. Tối đa 365 ngày; báo cáo lớn được tự chia nhỏ. " +
      "Chỉ dùng được khi tài khoản đã bật Conversions. Doanh thu theo đơn vị tiền chính; null nghĩa là không có dữ liệu.",
    input: getConversionsInput,
    write: false,
    run: (ctx, input) => runGetConversions(ctx, input),
  }),
]
