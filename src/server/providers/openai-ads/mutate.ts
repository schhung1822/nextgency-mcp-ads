// Writes on existing objects: status, budget, generic fields, archive.
// Rules: read current state first (before/after + dryRun preview); nested objects are sent in full
// (POST /{type}/{id} replaces budget/bidding_config/creative…); 503/timeout → re-read before any retry.
import { isProviderError, ProviderError } from "../errors"
import { fromMicros } from "../money"
import type {
  BudgetUpdate,
  FieldChange,
  MutationOptions,
  MutationResult,
  ObjectLevel,
  ObjectUpdate,
  TargetStatus,
} from "../types"
import { oaRequest, PLATFORM } from "./client"
import { uploadImageUrl } from "./media"
import {
  assertOaLevel,
  bidFromRaw,
  budgetFromRaw,
  fetchRaw,
  LEVEL_PATH,
  unixToIso,
  type Ctx,
  type OaLevel,
  type RawAd,
  type RawAdGroup,
  type RawCampaign,
  type RawObject,
} from "./objects"
import { bidMeaningVi, bidMicros, biddingToParams, budgetParams, creativeToParams, isoToUnix, writeApplied } from "./payloads"

export const MAX_STATUS_BATCH = 50

function invalid(message: string, vi: string, hint?: string) {
  return new ProviderError({ platform: PLATFORM, code: "invalid_request", message, userMessageVi: vi, hint })
}

function unsupportedHere(message: string, vi: string, hint?: string) {
  return new ProviderError({ platform: PLATFORM, code: "unsupported", message, userMessageVi: vi, hint })
}

function objPath(level: OaLevel, id: string) {
  return `${LEVEL_PATH[level]}/${encodeURIComponent(id)}`
}

// ---------------------------------------------------------------------------
// setStatus → POST /{type}/{id}/activate|pause
// ---------------------------------------------------------------------------

export async function setStatus(
  ctx: Ctx,
  levelIn: ObjectLevel,
  ids: string[],
  status: TargetStatus,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const level = assertOaLevel(levelIn)
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw invalid("No ids", "Cần ít nhất 1 id.")
  if (unique.length > MAX_STATUS_BATCH) throw invalid("Too many ids", `Tối đa ${MAX_STATUS_BATCH} đối tượng mỗi lần.`)
  const action = status === "active" ? "activate" : "pause"
  const changes: FieldChange[] = []
  const warnings: string[] = []
  const failures: string[] = []

  for (const id of unique) {
    try {
      const current = await fetchRaw<RawObject>(ctx, level, id)
      if (current.status === "archived") {
        warnings.push(`${current.name} (${id}) đã lưu trữ (archived) - không thể bật/tắt lại.`)
        continue
      }
      if (current.status === status) {
        warnings.push(`${current.name} (${id}) đã ở trạng thái ${status} - bỏ qua.`)
        continue
      }
      if (level === "ad" && status === "active") {
        const review = (current as RawAd).review_status
        if (review === "in_review") warnings.push(`Quảng cáo ${current.name} đang chờ duyệt - chỉ phân phối sau khi được duyệt.`)
        if (review === "rejected") warnings.push(`Quảng cáo ${current.name} đã bị từ chối - bật lên cũng không phân phối.`)
      }
      let after = status as string
      if (!opts.dryRun) {
        const res = await oaRequest<RawObject>(ctx, {
          method: "POST",
          path: `${objPath(level, id)}/${action}`,
          verify: async () => {
            const r = await fetchRaw<RawObject>(ctx, level, id)
            return r.status === status ? r : null
          },
        })
        after = res?.status ?? status
      }
      changes.push({ objectId: id, objectName: current.name, level, field: "status", before: current.status, after })
    } catch (e) {
      if (unique.length === 1) throw e
      // only curated Vietnamese messages reach the AI (a raw Error message may carry internals)
      failures.push(`${id}: ${isProviderError(e) ? e.userMessageVi : "lỗi không xác định"}`)
    }
  }
  if (failures.length) {
    if (changes.length === 0 && failures.length === unique.length) {
      throw new ProviderError({
        platform: PLATFORM,
        code: "upstream_error",
        message: "All status changes failed",
        userMessageVi: `Không đổi được trạng thái đối tượng nào: ${failures.join("; ")}`,
      })
    }
    warnings.push(`Một số đối tượng lỗi: ${failures.join("; ")}`)
  }
  if (status === "active" && level !== "campaign") {
    warnings.push("Đối tượng chỉ phân phối khi campaign/ad group cha cũng đang bật và quảng cáo đã được duyệt.")
  }
  return { preview: !!opts.dryRun, changes, warnings, effectiveAt: null }
}

// ---------------------------------------------------------------------------
// updateBudget → POST /campaigns/{id} { budget: {…full object…} }
// ---------------------------------------------------------------------------

export async function updateBudget(ctx: Ctx, u: BudgetUpdate, opts: MutationOptions = {}): Promise<MutationResult> {
  if (u.level === "ad_group") {
    throw unsupportedHere(
      "OpenAI Ads has no ad-group budget",
      "OpenAI Ads không có ngân sách ở cấp ad group - ngân sách nằm ở campaign và dùng chung cho mọi ad group của campaign đó.",
      "Gọi ads_get_object cho ad group để biết campaign cha, rồi đổi ngân sách của campaign (level=campaign)."
    )
  }
  const currency = ctx.account.currency
  const raw = await fetchRaw<RawCampaign>(ctx, "campaign", u.id)
  if (raw.status === "archived") throw invalid("Campaign archived", "Campaign đã lưu trữ - không thể đổi ngân sách.")
  const before = budgetFromRaw(raw.budget, currency)
  if (before?.type === "daily" && u.type === "lifetime") {
    throw invalid(
      "Cannot switch daily → lifetime",
      "OpenAI Ads không cho đổi ngân sách hằng ngày sang trọn đời. Muốn dùng ngân sách trọn đời phải tạo campaign mới.",
      "Giữ type=daily, hoặc sao chép campaign rồi tạo mới với ngân sách trọn đời."
    )
  }
  const warnings: string[] = []
  const budget = budgetParams(u.type, u.amount, currency, warnings) // full budget object: exactly one field
  if (before?.type === "lifetime" && u.type === "daily") {
    warnings.push("Đổi từ ngân sách trọn đời sang hằng ngày: sau đó KHÔNG thể đổi ngược lại trọn đời.")
  }
  if (before?.type === "lifetime" && u.type === "lifetime" && u.amount < before.amount) {
    warnings.push("Ngân sách trọn đời không được thấp hơn số tiền campaign đã chi - OpenAI sẽ từ chối nếu vi phạm.")
  }
  if (before?.type === "daily" && u.type === "daily" && u.amount < before.amount) {
    warnings.push("Giảm ngân sách ngày: OpenAI có thể từ chối nếu thấp hơn giá thầu hiệu lực của ad group, hoặc dưới mức tối thiểu theo tiền tệ.")
  }
  if (raw.status === "active") warnings.push("Campaign đang chạy - ngân sách mới áp dụng ngay.")
  const change: FieldChange = {
    objectId: raw.id,
    objectName: raw.name,
    level: "campaign",
    field: "budget",
    before: before ? { type: before.type, amount: before.amount, currency } : null,
    after: { type: u.type, amount: fromMicros(Object.values(budget)[0]!), currency },
  }
  if (!opts.dryRun) {
    const target = Object.entries(budget)[0]!
    const res = await oaRequest<RawCampaign>(ctx, {
      method: "POST",
      path: objPath("campaign", raw.id),
      body: { budget },
      // the budget body is absolute (no merge with current state) → resending it after a 409 is not stale
      rebuild: async () => ({ budget }),
      verify: async () => {
        const r = await fetchRaw<RawCampaign>(ctx, "campaign", raw.id)
        return (r.budget as Record<string, unknown>)?.[target[0]] === target[1] ? r : null
      },
    })
    const after = budgetFromRaw(res?.budget, currency)
    if (after) change.after = { type: after.type, amount: after.amount, currency }
  }
  return { preview: !!opts.dryRun, changes: [change], warnings, effectiveAt: null }
}

// ---------------------------------------------------------------------------
// updateObject → GET → merge → POST /{type}/{id}
// ---------------------------------------------------------------------------

export async function updateObject(ctx: Ctx, u: ObjectUpdate, opts: MutationOptions = {}): Promise<MutationResult> {
  const level = assertOaLevel(u.level)
  const c = u.changes ?? {}
  const keys = (Object.keys(c) as (keyof typeof c)[]).filter((k) => c[k] !== undefined)
  if (keys.length === 0) throw invalid("No changes", "Không có thay đổi nào.")
  const raw = await fetchRaw<RawObject>(ctx, level, u.id)
  const { body, changes, warnings } = await planObjectUpdate(ctx, level, raw, c, opts)
  if (changes.length === 0) {
    warnings.push("Giá trị mới trùng giá trị hiện tại - không có gì để cập nhật.")
    return { preview: !!opts.dryRun, changes, warnings, effectiveAt: null }
  }
  if (!opts.dryRun) {
    await oaRequest<RawObject>(ctx, {
      method: "POST",
      path: objPath(level, raw.id),
      body,
      // success only when the changed fields themselves are visible (not merely a new updated_at)
      verify: async (sent) => {
        const r = await fetchRaw<RawObject>(ctx, level, raw.id)
        return writeApplied(sent as Record<string, unknown>, r as unknown as Record<string, unknown>) ? r : null
      },
      // 409 revision conflict: re-read and re-merge the requested change instead of resending a stale object
      rebuild: async () => {
        const fresh = await fetchRaw<RawObject>(ctx, level, raw.id)
        const again = await planObjectUpdate(ctx, level, fresh, c, opts)
        return again.changes.length ? again.body : null
      },
    })
  }
  return { preview: !!opts.dryRun, changes, warnings, effectiveAt: null }
}

/** Merge the requested changes onto `raw` → full write body (nested objects replaced whole) + before/after. */
async function planObjectUpdate(
  ctx: Ctx,
  level: OaLevel,
  raw: RawObject,
  c: ObjectUpdate["changes"],
  opts: MutationOptions
): Promise<{ body: Record<string, unknown>; changes: FieldChange[]; warnings: string[] }> {
  if (raw.status === "archived") throw invalid("Object archived", "Đối tượng đã lưu trữ (archived) - không thể chỉnh sửa.")
  const currency = ctx.account.currency
  const body: Record<string, unknown> = {}
  const changes: FieldChange[] = []
  const warnings: string[] = []
  const base = { objectId: raw.id, objectName: raw.name, level }

  if (c.name !== undefined) {
    const name = c.name.trim()
    if (name.length < 3 || name.length > 1000) throw invalid("Bad name", "Tên phải dài 3–1000 ký tự.")
    if (name !== raw.name) {
      body.name = name
      changes.push({ ...base, field: "name", before: raw.name, after: name })
    }
  }

  if (c.startTime !== undefined || c.endTime !== undefined) {
    if (level !== "campaign") {
      throw unsupportedHere("Schedule lives on the campaign", "Lịch chạy (start/end) chỉ đặt ở cấp campaign trên OpenAI Ads.", "Đổi lịch của campaign cha.")
    }
    const cam = raw as RawCampaign
    const start = c.startTime === undefined ? cam.start_time : c.startTime === null ? null : isoToUnix(c.startTime, "startTime")
    const end = c.endTime === undefined ? cam.end_time : c.endTime === null ? null : isoToUnix(c.endTime, "endTime")
    if (start !== null && end !== null && end <= start) throw invalid("end <= start", "Thời điểm kết thúc phải sau thời điểm bắt đầu.")
    if (end !== null && end * 1000 < Date.now() && c.endTime !== undefined) {
      warnings.push("Thời điểm kết thúc đã qua - campaign sẽ không phân phối.")
    }
    if (c.startTime !== undefined && start !== cam.start_time) {
      body.start_time = start
      changes.push({ ...base, field: "start_time", before: unixToIso(cam.start_time), after: unixToIso(start) })
    }
    if (c.endTime !== undefined && end !== cam.end_time) {
      body.end_time = end
      changes.push({ ...base, field: "end_time", before: unixToIso(cam.end_time), after: unixToIso(end) })
    }
  }

  if (c.bidAmount !== undefined) {
    if (level !== "ad_group") {
      throw unsupportedHere("Bid lives on the ad group", "Giá thầu chỉ đặt ở cấp ad group (bidding_config) trên OpenAI Ads.", "Dùng level=ad_group.")
    }
    const g = raw as RawAdGroup
    const strategy = g.bidding_config?.strategy
    if (strategy === "maximize_clicks" || strategy === "maximize_conversions" || strategy === "automated_bid") {
      throw invalid(
        "Ad group uses automatic bidding",
        `Ad group đang dùng chiến lược ${strategy} (OpenAI tự đặt giá) - không có giá thầu để sửa.`,
        "Dùng openai_ads_update_ad_group để chuyển sang fixed_bid kèm max_bid."
      )
    }
    if (c.bidAmount === null) throw invalid("Bid required", "Fixed bid bắt buộc có giá thầu - không thể xoá.")
    const billing = g.bidding_config?.billing_event_type
    const micros = bidMicros(c.bidAmount, currency, { perImpression: billing === "impression", warnings })
    const merged = { ...biddingToParams(g.bidding_config), max_bid_micros: micros }
    if (!merged.strategy && !g.bidding_config?.strategy) merged.strategy = "fixed_bid"
    const beforeBid = bidFromRaw(g.bidding_config)
    // oCPC: on a conversions campaign max_bid_micros is the target CPA → label it so (campaign read when known)
    let biddingType: string | null = null
    if (g.campaign_id) {
      biddingType = (await fetchRaw<RawCampaign>(ctx, "campaign", g.campaign_id).catch(() => null))?.bidding_type ?? null
    }
    const meaning = bidMeaningVi(biddingType, billing)
    if (micros !== g.bidding_config?.max_bid_micros) {
      body.bidding_config = merged // full object (update replaces bidding_config)
      // field name stays stable for logs; the meaning (CPA mục tiêu…) is spelled out in the warnings
      changes.push({ ...base, field: "max_bid", before: beforeBid, after: fromMicros(micros) })
    }
    if (biddingType === "conversions") {
      warnings.push(`Campaign tối ưu chuyển đổi (oCPC): giá thầu là ${meaning}, không phải giá mỗi lượt nhấp.`)
    } else if (billing === "impression") {
      warnings.push(
        "Ad group tính phí theo lượt hiển thị: giá thầu là cho MỖI lượt hiển thị, không phải CPM (CPM 60 → nhập 0,06)."
      )
    } else if (!biddingType) {
      warnings.push("Nếu campaign cha tối ưu chuyển đổi (conversions), giá thầu này là CPA MỤC TIÊU (giá cho mỗi chuyển đổi).")
    }
    if (beforeBid && beforeBid > 0) {
      const ratio = c.bidAmount / beforeBid
      if (ratio >= 10 || ratio <= 0.1) {
        warnings.push(`Giá thầu thay đổi ${ratio >= 10 ? "tăng" : "giảm"} hơn 10 lần so với hiện tại - kiểm tra lại đơn vị (${meaning}).`)
      }
    }
  }

  if (c.finalUrl !== undefined) {
    if (level !== "ad") {
      throw unsupportedHere("URL lives on the ad creative", "URL đích nằm trong creative của quảng cáo (level=ad).", "Dùng level=ad.")
    }
    const ad = raw as RawAd
    if (!/^https?:\/\//i.test(c.finalUrl) || c.finalUrl.length > 2048) {
      throw invalid("Bad URL", "URL đích phải là http(s) và tối đa 2.048 ký tự.")
    }
    if (c.finalUrl !== ad.creative?.target_url) {
      const creative = creativeToParams(ad.creative)
      creative.target_url = c.finalUrl
      if (!ad.creative.file_id && ad.creative.image_url && ad.creative.type === "chat_card") {
        // the read shape may expose only image_url; re-upload so the full creative keeps its image
        if (opts.dryRun) {
          warnings.push("Creative hiện không trả file_id - khi xác nhận, ảnh hiện tại sẽ được tải lại để giữ nguyên hình.")
        } else {
          creative.file_id = await uploadImageUrl(ctx, ad.creative.image_url)
          if (ad.creative.image_crop) creative.image_crop = { ...ad.creative.image_crop }
        }
      }
      body.creative = creative // full creative object
      changes.push({ ...base, field: "target_url", before: ad.creative?.target_url ?? null, after: c.finalUrl })
      warnings.push("Sửa creative khiến quảng cáo phải được OpenAI DUYỆT LẠI - có thể tạm ngưng phân phối trong lúc duyệt.")
    }
  }
  return { body, changes, warnings }
}

// ---------------------------------------------------------------------------
// deleteObject → POST /{type}/{id}/archive (irreversible)
// ---------------------------------------------------------------------------

export async function deleteObject(ctx: Ctx, levelIn: ObjectLevel, id: string, opts: MutationOptions = {}): Promise<MutationResult> {
  const level = assertOaLevel(levelIn)
  const raw = await fetchRaw<RawObject>(ctx, level, id)
  const warnings = [
    "OpenAI Ads không có xoá - đối tượng sẽ được LƯU TRỮ (archive) và KHÔNG THỂ khôi phục hay bật lại.",
  ]
  if (level !== "ad") warnings.push("Lưu trữ đối tượng cha sẽ dừng phân phối của mọi đối tượng con.")
  if (raw.status === "archived") {
    return { preview: !!opts.dryRun, changes: [], warnings: ["Đối tượng đã ở trạng thái lưu trữ - không cần thao tác."], effectiveAt: null }
  }
  let after = "archived"
  if (!opts.dryRun) {
    const res = await oaRequest<RawObject>(ctx, {
      method: "POST",
      path: `${objPath(level, id)}/archive`,
      verify: async () => {
        const r = await fetchRaw<RawObject>(ctx, level, id)
        return r.status === "archived" ? r : null
      },
    })
    after = res?.status ?? "archived"
  }
  return {
    preview: !!opts.dryRun,
    changes: [{ objectId: raw.id, objectName: raw.name, level, field: "status", before: raw.status, after }],
    warnings,
    effectiveAt: null,
  }
}
