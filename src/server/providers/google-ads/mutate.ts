// Status / budget / field updates / removal for Google Ads.
// updateMask semantics: a field in the mask but absent from the body is CLEARED - masks are always built from the
// exact set of fields we put in the body (plus explicitly cleared fields), never by hand.
import { redactString } from "../../audit/redact"
import { ProviderError } from "../errors"
import { fromMicros } from "../money"
import { todayInTz } from "../dates"
import type { BudgetUpdate, FieldChange, MutationOptions, MutationResult, ObjectLevel, ObjectUpdate, TargetStatus } from "../types"
import { field, str, type GoogleAdsRow, type OperationFailure } from "./client"
import { clientFor, customerIdOf, invalidRequest, notFound, type GCtx } from "./context"
import { toProviderError } from "./errors"
import { assertId } from "./gaql"
import { CAMPAIGN_FIELDS, SERVICE_BY_LEVEL, readCurrent, resolveRefs, resourceNameFor, type ObjRef } from "./objects"
import { isoToAccountLocal } from "./time"
import { moneyToMicros, primeBillableUnit } from "./units"
import { assertNotVideo } from "./youtube"

export const MAX_STATUS_IDS = 50

/** camelCase → snake_case for field masks */
export function toSnake(path: string): string {
  return path
    .split(".")
    .map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join(".")
}

/** Build an update operation whose updateMask lists exactly the set fields + explicitly cleared fields. */
export function buildUpdate(
  resourceName: string,
  set: Record<string, unknown>,
  clear: string[] = []
): { update: Record<string, unknown>; updateMask: string } {
  const keys = Object.keys(set).filter((k) => set[k] !== undefined)
  for (const c of clear) if (keys.includes(c)) throw new Error(`Field ${c} both set and cleared`)
  const update: Record<string, unknown> = { resourceName }
  for (const k of keys) update[k] = set[k]
  const mask = [...keys, ...clear].map(toSnake)
  if (!mask.length) throw new Error("Empty update")
  return { update, updateMask: mask.join(",") }
}

export function failuresToError(failures: OperationFailure[]): ProviderError {
  const errors = failures.map((f) => {
    const [k, v] = (f.code ?? "").split(".")
    return { errorCode: k && v ? { [k]: v } : undefined, message: f.message }
  })
  return toProviderError({
    httpStatus: 400,
    status: "INVALID_ARGUMENT",
    message: failures.map((f) => f.message).join("; "),
    codes: failures.map((f) => f.code).filter((c): c is string => !!c),
    errors,
    reasons: [],
    retryDelayMs: null,
    requestId: null,
  })
}

function displayName(level: ObjectLevel, row: GoogleAdsRow | undefined): string | null {
  if (!row) return null
  switch (level) {
    case "campaign":
      return str(row, "campaign.name")
    case "ad_group":
      return str(row, "ad_group.name")
    case "ad": {
      const h = field(row, "ad_group_ad.ad.responsive_search_ad.headlines")
      const first = Array.isArray(h) ? (h[0] as { text?: string } | undefined)?.text : undefined
      return str(row, "ad_group_ad.ad.name") || first || null
    }
    case "keyword":
      return str(row, "ad_group_criterion.keyword.text")
  }
}

function statusOf(level: ObjectLevel, row: GoogleAdsRow): string | null {
  const f = { campaign: "campaign.status", ad_group: "ad_group.status", ad: "ad_group_ad.status", keyword: "ad_group_criterion.status" }[level]
  return str(row, f)
}

const LEVEL_VI: Record<ObjectLevel, string> = { campaign: "chiến dịch", ad_group: "nhóm quảng cáo", ad: "quảng cáo", keyword: "từ khóa" }

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

/**
 * Which operations of a partialFailure mutate were applied: "all" (no failure), "none" (every operation failed, or a
 * preview with a failure), a Set of operation indexes, or "unknown" (a failure without operation index and no
 * per-operation results to tell which ones succeeded). Google answers one `results` entry per operation, empty for the
 * failed ones.
 */
export function partialSuccesses(
  res: { results: unknown[]; failures: { index: number | null }[] },
  planned: number,
  failed: ReadonlySet<number>,
  dryRun: boolean
): "all" | "none" | "unknown" | Set<number> {
  if (!res.failures.length) return "all"
  // validateOnly: nothing is ever applied
  if (dryRun) return failed.size < planned && !res.failures.some((f) => f.index === null) ? new Set(range(planned).filter((i) => !failed.has(i))) : "none"
  if (!res.failures.some((f) => f.index === null)) {
    const ok = range(planned).filter((i) => !failed.has(i))
    return ok.length ? new Set(ok) : "none"
  }
  if (res.results.length !== planned) return "unknown"
  const ok = range(planned).filter((i) => {
    const r = res.results[i] as { resourceName?: unknown } | null | undefined
    return !failed.has(i) && typeof r?.resourceName === "string" && r.resourceName !== ""
  })
  return ok.length ? new Set(ok) : "none"
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

export async function setStatus(ctx: GCtx, level: ObjectLevel, ids: string[], status: TargetStatus, opts: MutationOptions = {}): Promise<MutationResult> {
  if (!ids.length) throw invalidRequest("No ids", "Cần ít nhất 1 id.")
  if (ids.length > MAX_STATUS_IDS) throw invalidRequest("Too many ids", `Tối đa ${MAX_STATUS_IDS} đối tượng mỗi lần.`)
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const refs = await resolveRefs(client, cid, level, ids)
  const current = await readCurrent(client, cid, level, refs)
  // VIDEO (YouTube) campaigns and their children are read-only through the API
  assertNotVideo(current.values(), "set_status")
  const target = status === "active" ? "ENABLED" : "PAUSED"
  const warnings: string[] = []
  const planned: { ref: ObjRef; before: string | null; name: string | null }[] = []
  for (const ref of refs) {
    const row = current.get(ref.key)
    if (!row) {
      warnings.push(`Không tìm thấy ${LEVEL_VI[level]} ${ref.key} - bỏ qua.`)
      continue
    }
    const before = statusOf(level, row)
    if (before === "REMOVED") {
      warnings.push(`${LEVEL_VI[level]} ${ref.key} đã bị xóa (REMOVED), không thể đổi trạng thái - bỏ qua.`)
      continue
    }
    if (before === target) {
      warnings.push(`${LEVEL_VI[level]} ${ref.key} đã ở trạng thái ${target}.`)
      continue
    }
    planned.push({ ref, before, name: displayName(level, row) })
  }
  if (!planned.length) {
    if (!current.size) throw notFound(LEVEL_VI[level], ids.join(", "))
    return { preview: !!opts.dryRun, changes: [], warnings }
  }
  const ops = planned.map((p) => buildUpdate(resourceNameFor(cid, p.ref), { status: target }))
  const res = await client.mutate(cid, SERVICE_BY_LEVEL[level], ops, { partialFailure: true, validateOnly: !!opts.dryRun })
  const failed = new Set<number>()
  for (const f of res.failures) {
    if (f.index !== null) failed.add(f.index)
    const p = f.index !== null ? planned[f.index] : null
    warnings.push(redactString(`Lỗi với ${p ? `${LEVEL_VI[level]} ${p.ref.key}` : "một đối tượng"}: ${f.code ?? ""} ${f.message}`.trim()))
  }
  const succeeded = partialSuccesses(res, planned.length, failed, !!opts.dryRun)
  if (res.failures.length) {
    // nothing applied (or a preview) → the plain error: the platform changed nothing
    if (succeeded === "none") throw failuresToError(res.failures)
    if (succeeded === "unknown") {
      // a failure without operation index and no per-operation results: some updates MAY be applied → the error
      // carries audit data (logged, never treated as "nothing changed" - no write-quota refund)
      const e = failuresToError(res.failures)
      throw new ProviderError({
        platform: e.platform,
        code: e.code,
        message: `${e.message} (partial failure, outcome unknown)`,
        userMessageVi: `${e.userMessageVi} Google không cho biết thao tác nào đã áp dụng - kiểm tra lại trạng thái bằng ads_list_objects trước khi thử lại.`,
        retryable: false,
        hint: e.hint,
        upstream: e.upstream,
        cause: e,
        toolCode: e.toolCode,
        audit: {
          errorCode: "partial_failure_unknown",
          changes: planned.map((p) => ({ objectId: p.ref.key, objectName: p.name, level, field: "status", before: p.before, after: target })),
        },
      })
    }
    if (res.failures.some((f) => f.index === null)) {
      warnings.push("Google không cho biết thao tác nào lỗi - chỉ ghi nhận các đối tượng Google xác nhận đã đổi.")
    }
  }
  const changes: FieldChange[] = planned
    .filter((_, i) => succeeded === "all" || (succeeded instanceof Set && succeeded.has(i)))
    .map((p) => ({ objectId: p.ref.key, objectName: p.name, level, field: "status", before: p.before, after: target }))
  if (status === "active" && level !== "campaign") {
    warnings.push("Lưu ý: đối tượng chỉ chạy khi chiến dịch và nhóm quảng cáo cha cũng đang bật.")
  }
  return { preview: !!opts.dryRun, changes, warnings }
}

// ---------------------------------------------------------------------------
// updateBudget
// ---------------------------------------------------------------------------

const BUDGET_FIELDS = [...CAMPAIGN_FIELDS, "campaign_budget.resource_name", "campaign_budget.status"]

export async function updateBudget(ctx: GCtx, u: BudgetUpdate, opts: MutationOptions = {}): Promise<MutationResult> {
  if (u.level !== "campaign") {
    throw new ProviderError({
      platform: "google_ads",
      code: "unsupported",
      message: "Google Ads budgets live on campaigns",
      userMessageVi: "Google Ads chỉ có ngân sách ở cấp chiến dịch (không có ngân sách nhóm quảng cáo).",
      hint: "Dùng level = campaign với id chiến dịch.",
    })
  }
  const cid = customerIdOf(ctx)
  const campaignId = assertId(u.id, "campaign_id")
  const client = clientFor(ctx)
  const { rows } = await client.searchAll(cid, `SELECT ${BUDGET_FIELDS.join(", ")} FROM campaign WHERE campaign.id = ${campaignId}`, { maxRows: 1 })
  const row = rows[0]
  if (!row) throw notFound("chiến dịch", campaignId)
  assertNotVideo([row], "update_budget")
  const budgetId = str(row, "campaign_budget.id")
  if (!budgetId) throw invalidRequest("Campaign has no budget", "Chiến dịch này không có ngân sách riêng (có thể dùng ngân sách danh mục).")
  const period = str(row, "campaign_budget.period") ?? "DAILY"
  const isLifetime = period === "CUSTOM_PERIOD"
  if ((u.type === "lifetime") !== isLifetime) {
    throw invalidRequest(
      `Budget period ${period} cannot change`,
      isLifetime
        ? "Ngân sách chiến dịch này là ngân sách tổng (CUSTOM_PERIOD); Google không cho đổi loại ngân sách. Hãy dùng type = lifetime."
        : "Ngân sách chiến dịch này là ngân sách ngày (DAILY); Google không cho đổi loại ngân sách. Hãy dùng type = daily."
    )
  }
  const warnings: string[] = []
  const currency = ctx.account.currency
  await primeBillableUnit(client, cid, currency)
  const micros = moneyToMicros(u.amount, currency, warnings, "Ngân sách")
  const shared = field(row, "campaign_budget.explicitly_shared") === true
  const refCount = Number(str(row, "campaign_budget.reference_count") ?? 0)
  if (shared && refCount > 1) {
    const others = await client.searchAll(
      cid,
      `SELECT campaign.id, campaign.name FROM campaign WHERE campaign_budget.id = ${assertId(budgetId)} AND campaign.status != 'REMOVED'`,
      { maxRows: 200 }
    )
    const list = others.rows
      .filter((r) => str(r, "campaign.id") !== campaignId)
      .map((r) => `${str(r, "campaign.name")} (${str(r, "campaign.id")})`)
    warnings.push(
      `CẢNH BÁO: ngân sách “${str(row, "campaign_budget.name") ?? budgetId}” đang dùng chung cho ${refCount} chiến dịch. ` +
        `Thay đổi sẽ ảnh hưởng cả: ${list.join(", ") || "các chiến dịch khác"}.`
    )
  } else if (shared) {
    warnings.push("Ngân sách này là ngân sách dùng chung (shared) dù hiện chỉ gắn với 1 chiến dịch.")
  }
  if (str(row, "campaign.advertising_channel_type") === "DEMAND_GEN") {
    // Demand Gen minimum 5 USD/day (since 2026-04-01); the equivalent in other currencies is UNVERIFIED → warn only
    if (!isLifetime && currency.toUpperCase() === "USD" && u.amount < 5) {
      warnings.push("Chiến dịch Demand Gen cần ngân sách tối thiểu 5 USD/ngày - Google có thể từ chối mức này.")
    } else if (currency.toUpperCase() !== "USD") {
      warnings.push("Chiến dịch Demand Gen cần ngân sách tối thiểu tương đương 5 USD/ngày (quy đổi theo tiền tệ tài khoản) - nếu thấp hơn Google sẽ từ chối.")
    }
  }
  const amountField = isLifetime ? "totalAmountMicros" : "amountMicros"
  const before = fromMicros(str(row, isLifetime ? "campaign_budget.total_amount_micros" : "campaign_budget.amount_micros"))
  const op = buildUpdate(`customers/${cid}/campaignBudgets/${budgetId}`, { [amountField]: micros })
  await client.mutate(cid, "campaignBudgets", [op], { validateOnly: !!opts.dryRun })
  return {
    preview: !!opts.dryRun,
    changes: [
      {
        objectId: campaignId,
        objectName: str(row, "campaign.name"),
        level: "campaign",
        field: isLifetime ? "lifetime_budget" : "daily_budget",
        before,
        after: fromMicros(micros),
      },
    ],
    warnings,
    effectiveAt: null,
  }
}

// ---------------------------------------------------------------------------
// updateObject
// ---------------------------------------------------------------------------

function unsupportedField(level: ObjectLevel, f: string): ProviderError {
  return invalidRequest(`${f} not editable at ${level}`, `Google Ads không cho sửa “${f}” ở cấp ${LEVEL_VI[level]}.`, hintFor(level, f))
}

function hintFor(level: ObjectLevel, f: string): string | undefined {
  if (f === "bidAmount" && level === "campaign") return "Giá thầu đặt ở cấp ad_group hoặc keyword."
  if (f === "finalUrl" && (level === "campaign" || level === "ad_group")) return "URL đích đặt ở cấp ad hoặc keyword."
  if (f === "name" && level === "keyword") return "Nội dung từ khóa không sửa được - hãy thêm từ khóa mới và tạm dừng từ khóa cũ."
  if (f === "name" && level === "ad") return "Quảng cáo RSA không có tên; nội dung RSA sửa bằng cách tạo quảng cáo mới (google_ads_create_rsa)."
  return undefined
}

function assertUrl(u: string): string {
  try {
    const p = new URL(u)
    if (p.protocol !== "https:" && p.protocol !== "http:") throw new Error()
    return u
  } catch {
    throw invalidRequest("Invalid URL", `URL đích không hợp lệ: ${u.slice(0, 100)}`)
  }
}

export async function updateObject(ctx: GCtx, u: ObjectUpdate, opts: MutationOptions = {}): Promise<MutationResult> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const ch = u.changes ?? {}
  const level = u.level
  if (ch.creative !== undefined) {
    // ad content edits (ObjectUpdate.changes.creative) are TikTok-only
    throw new ProviderError({
      platform: "google_ads",
      code: "unsupported",
      message: "creative update is not supported on Google Ads",
      userMessageVi: "Google Ads không sửa nội dung quảng cáo qua ads_update_object (tiktok_creative chỉ dùng cho TikTok).",
      hint: "Nội dung RSA sửa bằng cách tạo quảng cáo mới (google_ads_create_rsa) rồi tạm dừng quảng cáo cũ.",
    })
  }
  const allowed: Record<ObjectLevel, (keyof ObjectUpdate["changes"])[]> = {
    campaign: ["name", "startTime", "endTime"],
    ad_group: ["name", "bidAmount"],
    ad: ["finalUrl"],
    keyword: ["bidAmount", "finalUrl"],
  }
  const present = (Object.keys(ch) as (keyof ObjectUpdate["changes"])[]).filter((k) => ch[k] !== undefined)
  if (!present.length) throw invalidRequest("No changes", "Không có thay đổi nào.")
  for (const k of present) if (!allowed[level].includes(k)) throw unsupportedField(level, k)

  const [ref] = await resolveRefs(client, cid, level, [u.id])
  const rows = await readCurrent(client, cid, level, [ref!])
  const row = rows.get(ref!.key)
  if (!row) throw notFound(LEVEL_VI[level], u.id)
  assertNotVideo([row], "update_object")
  if (statusOf(level, row) === "REMOVED") throw invalidRequest("Removed", `${LEVEL_VI[level]} đã bị xóa, không sửa được.`)

  const warnings: string[] = []
  const changes: FieldChange[] = []
  const set: Record<string, unknown> = {}
  const clear: string[] = []
  const name = displayName(level, row)
  const currency = ctx.account.currency
  const tz = ctx.account.timezone
  const change = (f: string, before: unknown, after: unknown) => changes.push({ objectId: ref!.key, objectName: name, level, field: f, before, after })

  if (ch.name !== undefined) {
    const n = ch.name.trim()
    if (!n || n.length > 255) throw invalidRequest("Invalid name", "Tên phải từ 1 đến 255 ký tự.")
    set.name = n
    change("name", name, n)
  }
  if (level === "campaign" && (ch.startTime !== undefined || ch.endTime !== undefined)) {
    const today = todayInTz(tz)
    const curStart = str(row, "campaign.start_date_time")
    let newStartDate = curStart?.slice(0, 10) ?? null
    if (ch.startTime !== undefined) {
      if (ch.startTime === null) throw invalidRequest("start cannot be cleared", "Không thể xóa ngày bắt đầu của chiến dịch.")
      const l = isoToAccountLocal(ch.startTime, tz)
      if (l.date < today) throw invalidRequest("start in past", `Ngày bắt đầu (${l.date}) không được ở quá khứ (hôm nay theo múi giờ tài khoản: ${today}).`)
      if (curStart && curStart.slice(0, 10) <= today && str(row, "campaign.status") !== "PAUSED") {
        warnings.push("Chiến dịch có thể đã bắt đầu chạy; Google có thể từ chối đổi ngày bắt đầu.")
      }
      if (l.time !== "00:00:00") warnings.push(`Google Ads đặt lịch theo ngày: giờ bắt đầu được làm tròn về 00:00:00 ngày ${l.date} (giờ tài khoản).`)
      set.startDateTime = `${l.date} 00:00:00`
      newStartDate = l.date
      change("start_time", curStart, set.startDateTime)
    }
    if (ch.endTime !== undefined) {
      const curEnd = str(row, "campaign.end_date_time")
      if (ch.endTime === null) {
        clear.push("endDateTime")
        change("end_time", curEnd, null)
      } else {
        const l = isoToAccountLocal(ch.endTime, tz)
        if (l.date < today) throw invalidRequest("end in past", `Ngày kết thúc (${l.date}) không được ở quá khứ.`)
        if (newStartDate && l.date < newStartDate) throw invalidRequest("end before start", "Ngày kết thúc phải sau ngày bắt đầu.")
        if (l.time !== "23:59:59") warnings.push(`Google Ads đặt lịch theo ngày: giờ kết thúc được làm tròn về 23:59:59 ngày ${l.date} (giờ tài khoản).`)
        set.endDateTime = `${l.date} 23:59:59`
        change("end_time", curEnd, set.endDateTime)
      }
    }
  }
  if (ch.bidAmount !== undefined) {
    if (ch.bidAmount !== null) await primeBillableUnit(client, cid, currency)
    const path = level === "ad_group" ? "ad_group.cpc_bid_micros" : "ad_group_criterion.cpc_bid_micros"
    const before = fromMicros(str(row, path))
    if (ch.bidAmount === null) {
      if (level !== "keyword") throw invalidRequest("bid required", "Nhóm quảng cáo phải có giá thầu CPC.")
      clear.push("cpcBidMicros")
      change("bid_amount", before, null)
      warnings.push("Từ khóa sẽ dùng giá thầu của nhóm quảng cáo.")
    } else {
      set.cpcBidMicros = moneyToMicros(ch.bidAmount, currency, warnings, "Giá thầu")
      change("bid_amount", before, fromMicros(set.cpcBidMicros as string))
    }
  }

  // Ad final URL lives on the Ad resource (ads:mutate), not on ad_group_ad.
  if (level === "ad") {
    const url = assertUrl(ch.finalUrl!)
    const op = buildUpdate(`customers/${cid}/ads/${ref!.id}`, { finalUrls: [url] })
    change("final_url", (field(row, "ad_group_ad.ad.final_urls") as string[] | undefined)?.[0] ?? null, url)
    await client.mutate(cid, "ads", [op], { validateOnly: !!opts.dryRun })
    warnings.push("Đổi URL đích sẽ khiến quảng cáo được xét duyệt lại.")
    return { preview: !!opts.dryRun, changes, warnings }
  }
  if (level === "keyword" && ch.finalUrl !== undefined) {
    const url = assertUrl(ch.finalUrl)
    set.finalUrls = [url]
    change("final_url", null, url)
  }

  const op = buildUpdate(resourceNameFor(cid, ref!), set, clear)
  await client.mutate(cid, SERVICE_BY_LEVEL[level], [op], { validateOnly: !!opts.dryRun })
  return { preview: !!opts.dryRun, changes, warnings }
}

// ---------------------------------------------------------------------------
// deleteObject (REMOVED is irreversible)
// ---------------------------------------------------------------------------

export async function deleteObject(ctx: GCtx, level: ObjectLevel, id: string, opts: MutationOptions = {}): Promise<MutationResult> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const [ref] = await resolveRefs(client, cid, level, [id])
  const rows = await readCurrent(client, cid, level, [ref!])
  const row = rows.get(ref!.key)
  if (!row) throw notFound(LEVEL_VI[level], id)
  assertNotVideo([row], "delete")
  const before = statusOf(level, row)
  if (before === "REMOVED") return { preview: !!opts.dryRun, changes: [], warnings: [`${LEVEL_VI[level]} ${ref!.key} đã bị xóa trước đó.`] }
  const extra: string[] = []
  try {
    // removes are not auto-retried (client.ts); after an error, re-read: Google may have applied it before failing
    await client.mutate(cid, SERVICE_BY_LEVEL[level], [{ remove: resourceNameFor(cid, ref!) }], { validateOnly: !!opts.dryRun })
  } catch (e) {
    if (opts.dryRun) throw e
    const after = await readCurrent(client, cid, level, [ref!]).then(
      (m) => m.get(ref!.key),
      () => undefined
    )
    if (!after || statusOf(level, after) !== "REMOVED") throw e
    extra.push(`Google phản hồi lỗi nhưng ${LEVEL_VI[level]} đã ở trạng thái REMOVED - coi như đã xoá, không gửi lại.`)
  }
  return {
    preview: !!opts.dryRun,
    changes: [{ objectId: ref!.key, objectName: displayName(level, row), level, field: "status", before, after: "REMOVED" }],
    warnings: [
      ...extra,
      `Xóa (REMOVED) trên Google Ads là KHÔNG THỂ HOÀN TÁC - ${LEVEL_VI[level]} không thể bật lại.`,
      ...(level === "campaign" ? ["Mọi nhóm quảng cáo, quảng cáo và từ khóa trong chiến dịch sẽ ngừng phân phát vĩnh viễn."] : []),
    ],
  }
}

