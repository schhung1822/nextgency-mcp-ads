// ads_copy_object for Meta - strategy from meta.md §6:
//   campaign: shallow campaign copy → copy each ad set into the new campaign (deep_copy only when it has ≤3 ads,
//             the sync limit) → otherwise copy each ad individually into the new ad set.
//   Every copy is PAUSED (status_option=PAUSED). A failure in one branch does not stop the others.
// Copies are creates: never retried blindly (idempotent=false).
import { isProviderError } from "../errors"
import type { CopyMapping, CopyRequest, CopyResult, MutationOptions, ProviderContext } from "../types"
import { graph, graphAll, type MetaCredentials } from "./client"
import { readNode, type RawNode } from "./objects"
import { callCtx, hasBudget, invalid, toMetaLevel } from "./shared"

/** Meta's synchronous deep-copy limit (child ads). */
export const SYNC_DEEP_COPY_MAX_ADS = 3
/** Guardrail: max ads copied per call (04-mcp-design.md §6). */
export const MAX_ADS_PER_COPY = 50

interface CopiesResponse {
  copied_campaign_id?: string
  copied_adset_id?: string
  copied_ad_id?: string
  ad_object_ids?: { ad_object_type?: string; source_id?: string; copied_id?: string }[]
}

interface RenameOpts {
  rename_strategy: "ONLY_TOP_LEVEL_RENAME" | "NO_RENAME" | "DEEP_RENAME"
  rename_prefix?: string
  rename_suffix?: string
}

function topRename(r: CopyRequest): RenameOpts | undefined {
  if (!r.namePrefix && !r.nameSuffix) return undefined // Meta default: localized " - Copy" on the top level only
  return {
    rename_strategy: "ONLY_TOP_LEVEL_RENAME",
    ...(r.namePrefix ? { rename_prefix: r.namePrefix } : {}),
    ...(r.nameSuffix ? { rename_suffix: r.nameSuffix } : {}),
  }
}

const NO_RENAME: RenameOpts = { rename_strategy: "NO_RENAME" }

/** Special ad categories Meta calls HEF (housing, employment, financial products / services; CREDIT = old name). */
const HEF_CATEGORIES = new Set(["HOUSING", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES", "CREDIT"])

/**
 * [H] changelog v26 (all versions from 2026-10-27): ad sets of HEF campaigns with constrained targeting (custom
 * audiences, detailed targeting) must set `advantage_audience` explicitly on `POST act/adsets` AND
 * `POST /{adset}/copies`, else Meta errors. [?] The copies edge takes no targeting parameter (reference read
 * 2026-10-16), so the copy can only inherit the source's targeting: a source without the explicit flag gets a warning
 * (preview and execute) telling the AI to set it with meta_update_targeting first. Never changes the source by itself.
 */
export function hefAdvantageAudienceProblem(adset: RawNode, specialAdCategories: unknown): string | null {
  const cats = Array.isArray(specialAdCategories) ? specialAdCategories.map(String) : []
  if (!cats.some((c) => HEF_CATEGORIES.has(c))) return null
  const t = (adset.targeting && typeof adset.targeting === "object" ? adset.targeting : {}) as Record<string, unknown>
  const auto = (t.targeting_automation && typeof t.targeting_automation === "object" ? t.targeting_automation : {}) as Record<string, unknown>
  if (auto.advantage_audience !== undefined && auto.advantage_audience !== null) return null
  const constrained = ["custom_audiences", "flexible_spec", "interests", "behaviors"].some((k) => Array.isArray(t[k]) && (t[k] as unknown[]).length > 0)
  if (!constrained) return null
  return (
    `Nhóm ${typeof adset.name === "string" ? adset.name : adset.id} (${adset.id}) thuộc chiến dịch danh mục đặc biệt (nhà ở / việc làm / tài chính), có đối tượng tuỳ chỉnh / nhắm chi tiết nhưng chưa đặt rõ advantage_audience - từ 27/10/2026 Meta từ chối sao chép nhóm như vậy. ` +
    `Đặt rõ trước bằng meta_update_targeting (adset_id=${adset.id}, targeting.advantage_audience true/false) rồi sao chép lại.`
  )
}

function errMsg(e: unknown): string {
  // only curated Vietnamese messages reach the AI (a raw Error message may carry internals)
  return isProviderError(e) ? e.userMessageVi : "lỗi không xác định"
}

interface AdsetPlan {
  adset: RawNode
  ads: RawNode[]
}

async function listAdsOf(ctx: ProviderContext<MetaCredentials>, parentId: string): Promise<RawNode[]> {
  const res = await graphAll<RawNode>(callCtx(ctx), `${parentId}/ads`, { fields: "id,name,adset_id,status", limit: 200 }, 1000)
  return res.data
}

async function copyCall(
  ctx: ProviderContext<MetaCredentials>,
  sourceId: string,
  params: Record<string, unknown>
): Promise<CopiesResponse> {
  return graph<CopiesResponse>(callCtx(ctx), {
    method: "POST",
    path: `${sourceId}/copies`,
    params: { ...params, status_option: "PAUSED" },
    idempotent: false,
  })
}

/** Copy one ad set into `targetCampaignId`, then its ads (deep natively when ≤3 ads). */
async function copyAdsetBranch(
  ctx: ProviderContext<MetaCredentials>,
  plan: AdsetPlan,
  targetCampaignId: string,
  rename: RenameOpts | undefined,
  deep: boolean,
  mappings: CopyMapping[],
  warnings: string[]
): Promise<string | null> {
  const { adset, ads } = plan
  const nativeDeep = deep && ads.length > 0 && ads.length <= SYNC_DEEP_COPY_MAX_ADS
  let newAdsetId: string
  let res: CopiesResponse
  try {
    res = await copyCall(ctx, adset.id, {
      campaign_id: targetCampaignId,
      deep_copy: nativeDeep,
      ...(rename ? { rename_options: rename } : {}),
    })
    if (!res.copied_adset_id) throw new Error("Meta không trả copied_adset_id")
    newAdsetId = res.copied_adset_id
  } catch (e) {
    mappings.push({ level: "ad_group", sourceId: adset.id, newId: null, error: errMsg(e) })
    if (deep) {
      for (const ad of ads) {
        mappings.push({ level: "ad", sourceId: ad.id, newId: null, error: "Bỏ qua vì sao chép nhóm quảng cáo thất bại." })
      }
    }
    warnings.push(`Không sao chép được nhóm quảng cáo ${adset.name ?? adset.id}: ${errMsg(e)}`)
    return null
  }
  mappings.push({ level: "ad_group", sourceId: adset.id, newId: newAdsetId })
  if (!deep || ads.length === 0) return newAdsetId

  if (nativeDeep) {
    const copied = new Map(
      (res.ad_object_ids ?? [])
        .filter((o) => (o.ad_object_type ?? "").toLowerCase() === "ad" && o.source_id)
        .map((o) => [o.source_id!, o.copied_id ?? null])
    )
    for (const ad of ads) {
      const newId = copied.get(ad.id) ?? null
      mappings.push(
        newId
          ? { level: "ad", sourceId: ad.id, newId }
          : { level: "ad", sourceId: ad.id, newId: null, error: "Meta không trả id bản sao của quảng cáo này." }
      )
    }
    return newAdsetId
  }

  for (const ad of ads) {
    try {
      const r = await copyCall(ctx, ad.id, { adset_id: newAdsetId, rename_options: NO_RENAME })
      if (!r.copied_ad_id) throw new Error("Meta không trả copied_ad_id")
      mappings.push({ level: "ad", sourceId: ad.id, newId: r.copied_ad_id })
    } catch (e) {
      mappings.push({ level: "ad", sourceId: ad.id, newId: null, error: errMsg(e) })
      warnings.push(`Không sao chép được quảng cáo ${ad.name ?? ad.id}: ${errMsg(e)}`)
    }
  }
  return newAdsetId
}

function plannedMappings(plans: AdsetPlan[], deep: boolean): CopyMapping[] {
  const out: CopyMapping[] = []
  for (const p of plans) {
    out.push({ level: "ad_group", sourceId: p.adset.id, newId: null })
    if (deep) for (const ad of p.ads) out.push({ level: "ad", sourceId: ad.id, newId: null })
  }
  return out
}

function finish(result: CopyResult): CopyResult {
  const failed = result.mappings.filter((m) => m.error).length
  if (!result.preview) {
    result.warnings.unshift(
      failed
        ? `Đã sao chép ${result.mappings.length - failed}/${result.mappings.length} đối tượng; ${failed} lỗi (xem cột error).`
        : `Đã sao chép ${result.mappings.length} đối tượng.`
    )
  }
  result.warnings.push("Mọi bản sao ở trạng thái TẠM DỪNG; quảng cáo mới cần Meta duyệt trước khi chạy.")
  return result
}

export async function copyMetaObject(
  ctx: ProviderContext<MetaCredentials>,
  r: CopyRequest,
  opts: MutationOptions = {}
): Promise<CopyResult> {
  const level = toMetaLevel(r.level)
  const warnings: string[] = []
  const rename = topRename(r)
  if ((r.namePrefix?.length ?? 0) > 100 || (r.nameSuffix?.length ?? 0) > 100) throw invalid("Tiền tố/hậu tố tên tối đa 100 ký tự.")

  if (level === "campaign") {
    if (r.targetParentId) warnings.push("Chiến dịch không có cấp cha - bỏ qua target_parent_id.")
    const campaign = await readNode(ctx, "campaign", r.id, [
      "id",
      "name",
      "objective",
      "daily_budget",
      "lifetime_budget",
      "smart_promotion_type",
      "special_ad_categories",
    ])
    if (campaign.smart_promotion_type === "AUTOMATED_SHOPPING_ADS" || campaign.smart_promotion_type === "SMART_APP_PROMOTION") {
      throw invalid("Meta không còn cho sao chép chiến dịch Advantage+ Shopping/App kiểu cũ (ASC/AAC).")
    }
    let plans: AdsetPlan[] = []
    if (r.deep) {
      const adsets = await graphAll<RawNode>(callCtx(ctx), `${r.id}/adsets`, { fields: "id,name,end_time,status,targeting", limit: 200 }, 1000)
      const ads = await listAdsOf(ctx, r.id)
      const total = ads.length
      if (total > MAX_ADS_PER_COPY) {
        throw invalid(
          `Chiến dịch có ${total} quảng cáo - vượt giới hạn ${MAX_ADS_PER_COPY} quảng cáo mỗi lần sao chép.`,
          "Sao chép từng nhóm quảng cáo (level=ad_group) thay vì cả chiến dịch."
        )
      }
      plans = adsets.data.map((s) => ({ adset: s, ads: ads.filter((a) => String(a.adset_id) === s.id) }))
      for (const p of plans) {
        if (typeof p.adset.end_time === "string" && Date.parse(p.adset.end_time) < Date.now()) {
          warnings.push(`Nhóm ${p.adset.name ?? p.adset.id} đã hết lịch chạy - bản sao giữ lịch cũ, cần sửa end_time trước khi bật.`)
        }
        const hef = hefAdvantageAudienceProblem(p.adset, campaign.special_ad_categories)
        if (hef) warnings.push(hef)
      }
    }
    if (opts.dryRun) {
      return finish({
        preview: true,
        mode: r.deep ? "emulated" : "native",
        rootNewId: null,
        mappings: [{ level: "campaign", sourceId: campaign.id, newId: null }, ...plannedMappings(plans, r.deep)],
        warnings: [
          ...warnings,
          r.deep
            ? `Sẽ sao chép chiến dịch + ${plans.length} nhóm quảng cáo + ${plans.reduce((n, p) => n + p.ads.length, 0)} quảng cáo (nhóm ≤${SYNC_DEEP_COPY_MAX_ADS} quảng cáo sao chép sâu 1 lệnh, còn lại sao chép từng quảng cáo).`
            : "Sẽ chỉ sao chép chiến dịch (không kèm nhóm/quảng cáo con).",
        ],
      })
    }
    // 1. shallow campaign copy - failure here stops everything (nothing else can be copied)
    const res = await copyCall(ctx, campaign.id, { deep_copy: false, ...(rename ? { rename_options: rename } : {}) })
    const newCampaignId = res.copied_campaign_id
    if (!newCampaignId) throw invalid("Meta không trả id chiến dịch bản sao.")
    const mappings: CopyMapping[] = [{ level: "campaign", sourceId: campaign.id, newId: newCampaignId }]
    // 2/3. each ad set (children keep their names), then ads
    for (const p of plans) {
      await copyAdsetBranch(ctx, p, newCampaignId, NO_RENAME, true, mappings, warnings)
    }
    return finish({ preview: false, mode: r.deep ? "emulated" : "native", rootNewId: newCampaignId, mappings, warnings })
  }

  if (level === "adset") {
    const adset = await readNode(ctx, "adset", r.id, [
      "id",
      "name",
      "daily_budget",
      "lifetime_budget",
      "end_time",
      "targeting",
      "campaign{special_ad_categories}",
    ])
    const targetCampaignId = r.targetParentId ?? String(adset.campaign_id)
    let categories = (adset.campaign as { special_ad_categories?: unknown } | undefined)?.special_ad_categories
    if (r.targetParentId && r.targetParentId !== String(adset.campaign_id)) {
      const target = await readNode(ctx, "campaign", r.targetParentId, ["id", "name", "daily_budget", "lifetime_budget", "objective", "special_ad_categories"])
      categories = target.special_ad_categories
      if (hasBudget(target) && hasBudget(adset)) {
        warnings.push("Chiến dịch đích dùng ngân sách chiến dịch (CBO) nhưng nhóm nguồn có ngân sách riêng - Meta có thể từ chối.")
      }
      if (!hasBudget(target) && !hasBudget(adset)) {
        warnings.push("Chiến dịch đích dùng ngân sách nhóm (ABO) nhưng nhóm nguồn không có ngân sách - Meta có thể từ chối.")
      }
    }
    // HEF + constrained targeting without the explicit flag: Meta refuses the copy from 2026-10-27 (only the source can
    // carry the flag). Warned, not refused: whether a read-back targeting shows an implicit flag is unverified [?]
    const hef = hefAdvantageAudienceProblem(adset, categories)
    if (hef) warnings.push(hef)
    const ads = r.deep ? await listAdsOf(ctx, adset.id) : []
    if (ads.length > MAX_ADS_PER_COPY) {
      throw invalid(`Nhóm quảng cáo có ${ads.length} quảng cáo - vượt giới hạn ${MAX_ADS_PER_COPY} mỗi lần sao chép.`)
    }
    const plan: AdsetPlan = { adset, ads }
    if (opts.dryRun) {
      return finish({
        preview: true,
        mode: r.deep && ads.length > SYNC_DEEP_COPY_MAX_ADS ? "emulated" : "native",
        rootNewId: null,
        mappings: plannedMappings([plan], r.deep),
        warnings: [...warnings, `Sẽ sao chép vào chiến dịch ${targetCampaignId}.`],
      })
    }
    const mappings: CopyMapping[] = []
    const newId = await copyAdsetBranch(ctx, plan, targetCampaignId, rename, r.deep, mappings, warnings)
    if (!newId) {
      // the root itself failed - surface as an error rather than an empty success
      const err = mappings[0]?.error ?? "Sao chép thất bại."
      throw invalid(`Không sao chép được nhóm quảng cáo: ${err}`)
    }
    return finish({
      preview: false,
      mode: r.deep && ads.length > SYNC_DEEP_COPY_MAX_ADS ? "emulated" : "native",
      rootNewId: newId,
      mappings,
      warnings,
    })
  }

  // ad
  const ad = await readNode(ctx, "ad", r.id, ["id", "name", "adset_id"])
  const targetAdsetId = r.targetParentId ?? String(ad.adset_id)
  if (r.targetParentId && r.targetParentId !== String(ad.adset_id)) {
    await readNode(ctx, "adset", r.targetParentId, ["id", "name"])
  }
  if (opts.dryRun) {
    return finish({
      preview: true,
      mode: "native",
      rootNewId: null,
      mappings: [{ level: "ad", sourceId: ad.id, newId: null }],
      warnings: [...warnings, `Sẽ sao chép vào nhóm quảng cáo ${targetAdsetId}.`],
    })
  }
  const res = await copyCall(ctx, ad.id, { adset_id: targetAdsetId, ...(rename ? { rename_options: rename } : {}) })
  if (!res.copied_ad_id) throw invalid("Meta không trả id quảng cáo bản sao.")
  return finish({
    preview: false,
    mode: "native",
    rootNewId: res.copied_ad_id,
    mappings: [{ level: "ad", sourceId: ad.id, newId: res.copied_ad_id }],
    warnings,
  })
}
