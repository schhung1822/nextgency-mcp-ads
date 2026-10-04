// Emulated copy (OpenAI Ads has no native copy): campaign → ad groups → ads, every new object PAUSED,
// a distinct Idempotency-Key per object (derived from the caller's key so a retried copy never duplicates),
// settings carried over (bidding_type, budget, targeting, landing_page_configuration,
// conversion_event_setting_ids, bidding_config, context_hints, product_set) and creative file_id reused.
import { isProviderError, ProviderError } from "../errors"
import type { CopyMapping, CopyRequest, CopyResult, MutationOptions } from "../types"
import { canonicalJson, deriveIdempotencyKey, listAll, oaRequest, PLATFORM } from "./client"
import { uploadImageUrl } from "./media"
import { fetchRaw, resolveParentId, type Ctx, type RawAd, type RawAdGroup, type RawCampaign } from "./objects"
import { adGroupCreateParams, campaignCreateParams, copyName, creativeToParams, landingPageToParams } from "./payloads"

/** 04-mcp-design §6: deep copy creates at most 50 ads per call. */
export const MAX_COPY_ADS = 50
const MAX_COPY_AD_GROUPS = 50

function invalid(message: string, vi: string, hint?: string) {
  return new ProviderError({ platform: PLATFORM, code: "invalid_request", message, userMessageVi: vi, hint })
}

function errText(e: unknown): string {
  return isProviderError(e) ? `${e.userMessageVi}${e.upstream?.requestId ? ` (request id ${e.upstream.requestId})` : ""}` : (e as Error).message
}

interface Plan {
  campaign?: RawCampaign
  groups: { src: RawAdGroup; ads: RawAd[] }[]
  /** campaign that receives copied ad groups (level ad_group) */
  targetCampaignId?: string
  /** ad group that receives copied ads (level ad) */
  targetAdGroupId?: string
  ads?: RawAd[]
}

export async function copyObject(ctx: Ctx, r: CopyRequest, opts: MutationOptions = {}): Promise<CopyResult> {
  const warnings: string[] = []
  // Deterministic, never random: the caller's per-request key (pending-action id) when given, otherwise a hash of
  // the account + canonical copy request, so re-running the same copy cannot create duplicates.
  const keyBase =
    opts.idempotencyKey ?? deriveIdempotencyKey("copy", ctx.account.externalId, canonicalJson({ ...r, allowIncomplete: undefined }))
  const keyFor = (kind: string, sourceId: string) => deriveIdempotencyKey(keyBase, kind, sourceId)
  const rename = (n: string) => copyName(n, r.namePrefix, r.nameSuffix ?? (r.namePrefix ? undefined : " - bản sao"))

  // ---- read phase (also the whole dry run) ----
  const plan: Plan = { groups: [] }
  if (r.level === "campaign") {
    plan.campaign = await fetchRaw<RawCampaign>(ctx, "campaign", r.id)
    if (r.targetParentId) warnings.push("Campaign không có đối tượng cha - bỏ qua targetParentId.")
    if (r.deep) {
      const groups = await listAll<RawAdGroup>(ctx, "/ad_groups", { campaign_id: r.id }, { maxItems: MAX_COPY_AD_GROUPS + 1 })
      if (groups.items.length > MAX_COPY_AD_GROUPS) {
        throw invalid("Too many ad groups", `Campaign có hơn ${MAX_COPY_AD_GROUPS} ad group - quá lớn để sao chép một lần.`)
      }
      for (const g of groups.items) {
        if (g.status === "archived") continue
        const ads = await listAll<RawAd>(ctx, "/ads", { ad_group_id: g.id }, { maxItems: MAX_COPY_ADS + 1 })
        plan.groups.push({ src: g, ads: ads.items.filter((a) => a.status !== "archived") })
      }
    }
  } else if (r.level === "ad_group") {
    const src = await fetchRaw<RawAdGroup>(ctx, "ad_group", r.id)
    plan.targetCampaignId = r.targetParentId ?? src.campaign_id ?? (await resolveParentId(ctx, "ad_group", r.id)) ?? undefined
    if (!plan.targetCampaignId) {
      throw invalid(
        "Parent campaign unknown",
        "Không xác định được campaign chứa ad group này (OpenAI không trả về campaign cha).",
        "Truyền targetParentId = id campaign đích."
      )
    }
    const ads = r.deep ? (await listAll<RawAd>(ctx, "/ads", { ad_group_id: r.id }, { maxItems: MAX_COPY_ADS + 1 })).items : []
    plan.groups.push({ src, ads: ads.filter((a) => a.status !== "archived") })
    const target = await fetchRaw<RawCampaign>(ctx, "campaign", plan.targetCampaignId)
    if (target.status === "archived") throw invalid("Target archived", "Campaign đích đã lưu trữ - không thể thêm ad group.")
    const strategy = src.bidding_config?.strategy
    if ((strategy === "maximize_clicks" || strategy === "maximize_conversions") && typeof target.budget?.daily_spend_limit_micros !== "number") {
      warnings.push("Ad group dùng Maximize nhưng campaign đích không có ngân sách hằng ngày - OpenAI sẽ từ chối.")
    }
  } else {
    const src = await fetchRaw<RawAd>(ctx, "ad", r.id)
    plan.targetAdGroupId = r.targetParentId ?? src.ad_group_id ?? (await resolveParentId(ctx, "ad", r.id)) ?? undefined
    if (!plan.targetAdGroupId) {
      throw invalid(
        "Parent ad group unknown",
        "Không xác định được ad group chứa quảng cáo này (OpenAI không trả về ad group cha).",
        "Truyền targetParentId = id ad group đích."
      )
    }
    const target = await fetchRaw<RawAdGroup>(ctx, "ad_group", plan.targetAdGroupId)
    if (target.status === "archived") throw invalid("Target archived", "Ad group đích đã lưu trữ - không thể thêm quảng cáo.")
    plan.ads = [src]
  }

  const totalAds = plan.ads?.length ?? plan.groups.reduce((n, g) => n + g.ads.length, 0)
  if (totalAds > MAX_COPY_ADS) {
    throw invalid("Too many ads", `Sao chép sâu tối đa ${MAX_COPY_ADS} quảng cáo mỗi lần (đang có ${totalAds}).`, "Sao chép từng ad group.")
  }

  warnings.push("Mọi bản sao được tạo ở trạng thái TẠM DỪNG - bật bằng ads_set_status khi sẵn sàng.")
  if (totalAds > 0) warnings.push("Quảng cáo sao chép là quảng cáo mới nên phải được OpenAI DUYỆT LẠI trước khi phân phối.")
  if (plan.campaign) {
    const nowS = Math.floor(Date.now() / 1000)
    if (plan.campaign.end_time !== null && plan.campaign.end_time <= nowS) {
      warnings.push("Campaign gốc đã kết thúc - bản sao không đặt thời điểm kết thúc; hãy đặt lịch mới trước khi bật.")
    }
    if (plan.campaign.start_time !== null && plan.campaign.start_time <= nowS) {
      warnings.push("Thời điểm bắt đầu của campaign gốc đã qua - bản sao bắt đầu ngay khi được bật.")
    }
    if (plan.campaign.bidding_type === "conversions") warnings.push("Bản sao giữ nguyên sự kiện chuyển đổi tối ưu của campaign gốc.")
  }

  const mappings: CopyMapping[] = []
  if (opts.dryRun) {
    if (plan.campaign) mappings.push({ level: "campaign", sourceId: plan.campaign.id, newId: null })
    for (const g of plan.groups) {
      mappings.push({ level: "ad_group", sourceId: g.src.id, newId: null })
      for (const a of g.ads) mappings.push({ level: "ad", sourceId: a.id, newId: null })
    }
    for (const a of plan.ads ?? []) mappings.push({ level: "ad", sourceId: a.id, newId: null })
    return { preview: true, mode: "emulated", rootNewId: null, mappings, warnings }
  }

  // ---- write phase ----
  let rootNewId: string | null = null
  let campaignId = plan.targetCampaignId ?? null
  if (plan.campaign) {
    const src = plan.campaign
    const body = campaignCreateParams(src, rename(src.name))
    const nowS = Math.floor(Date.now() / 1000)
    if (src.start_time !== null && src.start_time > nowS) body.start_time = src.start_time
    if (src.end_time !== null && src.end_time > nowS) body.end_time = src.end_time
    try {
      const created = await oaRequest<RawCampaign>(ctx, {
        method: "POST",
        path: "/campaigns",
        body,
        idempotencyKey: keyFor("campaign", src.id),
      })
      campaignId = created.id
      rootNewId = created.id
      mappings.push({ level: "campaign", sourceId: src.id, newId: created.id })
    } catch (e) {
      mappings.push({ level: "campaign", sourceId: src.id, newId: null, error: errText(e) })
      for (const g of plan.groups) {
        mappings.push({ level: "ad_group", sourceId: g.src.id, newId: null, error: "Bỏ qua vì tạo campaign thất bại." })
        for (const a of g.ads) mappings.push({ level: "ad", sourceId: a.id, newId: null, error: "Bỏ qua vì tạo campaign thất bại." })
      }
      warnings.push("Sao chép thất bại ở bước tạo campaign - không có gì được tạo.")
      return { preview: false, mode: "emulated", rootNewId: null, mappings, warnings }
    }
  }

  for (const g of plan.groups) {
    let newGroupId: string | null = null
    try {
      // ad-group copy keeps the original name inside the same campaign unless renamed; deep campaign copy keeps names
      const name = r.level === "ad_group" ? rename(g.src.name) : g.src.name
      const created = await oaRequest<RawAdGroup>(ctx, {
        method: "POST",
        path: "/ad_groups",
        body: adGroupCreateParams(g.src, campaignId!, name),
        idempotencyKey: keyFor("ad_group", g.src.id),
      })
      newGroupId = created.id
      if (r.level === "ad_group") rootNewId = created.id
      mappings.push({ level: "ad_group", sourceId: g.src.id, newId: created.id })
    } catch (e) {
      mappings.push({ level: "ad_group", sourceId: g.src.id, newId: null, error: errText(e) })
      for (const a of g.ads) mappings.push({ level: "ad", sourceId: a.id, newId: null, error: "Bỏ qua vì tạo ad group thất bại." })
      continue
    }
    for (const a of g.ads) {
      const m = await copyAd(ctx, a, newGroupId, a.name, keyFor("ad", a.id), warnings)
      mappings.push(m)
    }
  }

  for (const a of plan.ads ?? []) {
    const m = await copyAd(ctx, a, plan.targetAdGroupId!, rename(a.name), keyFor("ad", a.id), warnings)
    mappings.push(m)
    rootNewId = m.newId
  }

  const failed = mappings.filter((m) => m.error).length
  if (failed) warnings.push(`${failed} đối tượng không sao chép được - xem chi tiết trong mappings.`)
  return { preview: false, mode: "emulated", rootNewId, mappings, warnings }
}

async function copyAd(
  ctx: Ctx,
  src: RawAd,
  adGroupId: string,
  name: string,
  idempotencyKey: string,
  warnings: string[]
): Promise<CopyMapping> {
  try {
    const creative = creativeToParams(src.creative)
    if (!creative.file_id && src.creative.image_url && src.creative.type === "chat_card") {
      creative.file_id = await uploadImageUrl(ctx, src.creative.image_url)
      if (src.creative.image_crop) creative.image_crop = { ...src.creative.image_crop }
      warnings.push(`Quảng cáo ${src.name}: ảnh được tải lại từ image_url vì không có file_id.`)
    }
    const body: Record<string, unknown> = { ad_group_id: adGroupId, name, status: "paused", creative }
    const lp = landingPageToParams(src.landing_page_configuration)
    if (lp) body.landing_page_configuration = lp
    const created = await oaRequest<RawAd>(ctx, { method: "POST", path: "/ads", body, idempotencyKey })
    return { level: "ad", sourceId: src.id, newId: created.id }
  } catch (e) {
    return { level: "ad", sourceId: src.id, newId: null, error: errText(e) }
  }
}
