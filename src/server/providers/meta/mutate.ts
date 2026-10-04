// Write operations shared by every platform tool: status, budget, simple fields, delete.
// dryRun → read current state only and never mutate. execution_options=["validate_only"] is documented for
// CREATE edges only (act_X/campaigns|adsets|ads); on `POST /{id}` updates it is undocumented and could be ignored
// (= a real write during preview), so update previews are computed from reads alone.
import { ProviderError } from "../errors"
import { fromMetaMinor, metaCurrencyOffset, toMetaMinor } from "../money"
import type {
  BudgetUpdate,
  FieldChange,
  MutationOptions,
  MutationResult,
  ObjectLevel,
  ObjectUpdate,
  ProviderContext,
  TargetStatus,
} from "../types"
import { graph, graphBatch, isIsoDateTimeWithOffset, type MetaCredentials } from "./client"
import { readNode, type RawNode } from "./objects"
import {
  LEVEL_VI,
  assertSameAccount,
  callCtx,
  fmtMoney,
  fromMetaLevel,
  hasBudget,
  invalid,
  toMetaLevel,
  type MetaLevel,
} from "./shared"

export const VALIDATE_ONLY = ["validate_only"]

/**
 * POST with execution_options=["validate_only"]: Meta runs validation without mutating.
 * ONLY for create edges (`act_X/{campaigns,adsets,ads}`) - never call it on `POST /{id}` updates.
 */
export async function validateOnly(
  ctx: ProviderContext<MetaCredentials>,
  path: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!/^act_\d+\/(campaigns|adsets|ads)$/.test(path)) {
    throw new Error(`meta: validate_only is only allowed on create edges, got "${path}"`)
  }
  return graph(callCtx(ctx), {
    method: "POST",
    path,
    params: { ...params, execution_options: VALIDATE_ONLY },
    idempotent: true,
  })
}

/** A field that only exists on that level - requesting it on another level makes Meta reject the read. */
const LEVEL_PROBE: Record<MetaLevel, string> = { campaign: "objective", adset: "optimization_goal", ad: "adset_id" }

function name(node: RawNode): string {
  return typeof node.name === "string" ? node.name : node.id
}

export async function setMetaStatus(
  ctx: ProviderContext<MetaCredentials>,
  objLevel: ObjectLevel,
  ids: string[],
  status: TargetStatus,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const level = toMetaLevel(objLevel)
  const unique = [...new Set(ids.map((i) => i.trim()).filter(Boolean))]
  if (unique.length === 0) throw invalid("Cần ít nhất 1 id.")
  if (unique.length > 50) throw invalid("Tối đa 50 đối tượng mỗi lần bật/tắt.")
  if (unique.some((i) => !/^\d{1,30}$/.test(i))) throw invalid("Id Meta chỉ gồm chữ số.", "Gọi ads_list_objects để lấy đúng id.")

  const call = callCtx(ctx)
  // `GET /?ids=a,b` is rejected from v26.0 (HTTP 500 "The ids query parameter is deprecated") -
  // read every object through one batch call instead (meta.md §1).
  const fields = ["id", "name", "account_id", "status", "effective_status", LEVEL_PROBE[level]].join(",")
  const reads = await graphBatch<RawNode>(
    call,
    unique.map((id) => ({ method: "GET" as const, relative_url: `${id}?fields=${encodeURIComponent(fields)}` })),
    { idempotent: true }
  )
  const target = status === "active" ? "ACTIVE" : "PAUSED"
  const warnings: string[] = []
  const planned: { node: RawNode; change: FieldChange }[] = []
  for (let i = 0; i < unique.length; i++) {
    const id = unique[i]
    const read = reads[i]
    if (!read.ok && !["not_found", "invalid_request"].includes(read.error.code)) throw read.error
    const node = read.ok ? read.body : undefined
    if (!node?.id) {
      throw new ProviderError({
        platform: "meta",
        code: "not_found",
        message: `meta: object ${id} not found`,
        userMessageVi: `Không tìm thấy ${LEVEL_VI[level]} ${id}.`,
        hint: "Gọi ads_list_objects để lấy đúng id.",
      })
    }
    assertSameAccount(ctx, node, LEVEL_VI[level])
    const current = String(node.status ?? "")
    const eff = String(node.effective_status ?? "")
    if (current === "DELETED" || eff === "DELETED") {
      warnings.push(`${name(node)} (${id}) đã bị xoá - bỏ qua.`)
      continue
    }
    if (current === target) {
      warnings.push(`${name(node)} (${id}) đã ở trạng thái ${target} - bỏ qua.`)
      continue
    }
    if (target === "ACTIVE" && (eff === "CAMPAIGN_PAUSED" || eff === "ADSET_PAUSED")) {
      warnings.push(`${name(node)} (${id}) sẽ chưa chạy vì cấp cha đang tạm dừng (${eff}).`)
    }
    if (target === "ACTIVE" && level === "ad") {
      warnings.push(`${name(node)} (${id}) có thể cần Meta duyệt lại trước khi phân phối.`)
    }
    planned.push({
      node,
      change: { objectId: id, objectName: name(node), level: fromMetaLevel(level), field: "status", before: current, after: target },
    })
  }

  if (opts.dryRun || planned.length === 0) {
    return { preview: !!opts.dryRun, changes: planned.map((p) => p.change), warnings }
  }

  const results = await graphBatch(
    call,
    planned.map((p) => ({ method: "POST" as const, relative_url: p.node.id, body: `status=${target}` })),
    { idempotent: true }
  )
  const changes: FieldChange[] = []
  const errors: ProviderError[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const p = planned[i]
    if (r.ok) changes.push(p.change)
    else {
      errors.push(r.error)
      warnings.push(`Không đổi được trạng thái ${name(p.node)} (${p.node.id}): ${r.error.userMessageVi}`)
    }
  }
  if (changes.length === 0 && errors.length) throw errors[0]
  return { preview: false, changes, warnings }
}

export async function updateMetaBudget(
  ctx: ProviderContext<MetaCredentials>,
  u: BudgetUpdate,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const level = toMetaLevel(u.level)
  if (level === "ad") throw invalid("Ngân sách chỉ có ở chiến dịch hoặc nhóm quảng cáo.")
  const currency = ctx.account.currency
  if (!Number.isFinite(u.amount) || u.amount <= 0) throw invalid("Ngân sách phải lớn hơn 0.")

  const fields = ["id", "name", "status", "effective_status", "daily_budget", "lifetime_budget", "budget_remaining"]
  if (level === "adset") fields.push("campaign{id,name,daily_budget,lifetime_budget}", "end_time")
  else fields.push("objective")
  const node = await readNode(ctx, level, u.id, fields)

  const warnings: string[] = []
  if (level === "campaign" && !hasBudget(node)) {
    throw invalid(
      "Chiến dịch này dùng ngân sách ở cấp nhóm quảng cáo (ABO) - hãy sửa ngân sách của từng nhóm quảng cáo.",
      "Gọi ads_list_objects level=ad_group với parent_id là chiến dịch này."
    )
  }
  if (level === "adset") {
    const campaign = node.campaign as { daily_budget?: unknown; lifetime_budget?: unknown } | undefined
    if (hasBudget(campaign)) {
      throw invalid(
        "Nhóm quảng cáo này thuộc chiến dịch dùng ngân sách chiến dịch (CBO/Advantage+ budget) - hãy sửa ngân sách ở cấp chiến dịch.",
        "Gọi ads_update_budget với level=campaign."
      )
    }
  }
  const currentType = Number(node.daily_budget) > 0 ? "daily" : Number(node.lifetime_budget) > 0 ? "lifetime" : null
  if (currentType && currentType !== u.type) {
    throw invalid(
      `Meta không cho đổi loại ngân sách (${currentType === "daily" ? "hằng ngày" : "trọn đời"} → ${u.type === "daily" ? "hằng ngày" : "trọn đời"}).`
    )
  }
  if (!currentType && level === "adset") {
    throw invalid("Nhóm quảng cáo này chưa có ngân sách riêng - không thể đặt ngân sách ở cấp này.")
  }

  const field = u.type === "daily" ? "daily_budget" : "lifetime_budget"
  const minor = toMetaMinor(u.amount, currency)
  if (minor < 1) throw invalid(`Ngân sách quá nhỏ so với đơn vị tiền ${currency}.`)
  const exact = u.amount * metaCurrencyOffset(currency)
  if (Math.abs(exact - minor) > 1e-6) {
    warnings.push(`Ngân sách được làm tròn thành ${fmtMoney(minor / metaCurrencyOffset(currency), currency)}.`)
  }
  const before = fromMetaMinor(node[field] as string | undefined, currency)
  const after = minor / metaCurrencyOffset(currency)
  if (before && before > 0) {
    const pct = ((after - before) / before) * 100
    warnings.push(`Ngân sách ${pct >= 0 ? "tăng" : "giảm"} ${Math.abs(Math.round(pct * 10) / 10)}% (${fmtMoney(before, currency)} → ${fmtMoney(after, currency)}).`)
  }
  if (u.type === "lifetime") {
    const remaining = fromMetaMinor(node.budget_remaining as string | undefined, currency)
    if (before !== null && remaining !== null) {
      const spent = before - remaining
      if (after < spent) warnings.push(`Ngân sách trọn đời mới thấp hơn số đã chi (${fmtMoney(spent, currency)}) - Meta có thể từ chối.`)
    }
  }
  if (level === "adset") warnings.push("Meta giới hạn sửa ngân sách nhóm quảng cáo tối đa 4 lần/giờ.")
  if (node.effective_status === "ACTIVE") warnings.push("Đối tượng đang chạy - thay đổi có hiệu lực ngay và có thể đưa nhóm về giai đoạn học.")

  const change: FieldChange = {
    objectId: node.id,
    objectName: name(node),
    level: fromMetaLevel(level),
    field,
    before,
    after,
  }
  const params = { [field]: minor }
  // Preview from reads only (validate_only is not documented on updates).
  if (opts.dryRun) return { preview: true, changes: [change], warnings }
  await graph(callCtx(ctx), { method: "POST", path: node.id, params, idempotent: true })
  return { preview: false, changes: [change], warnings }
}

export async function updateMetaObject(
  ctx: ProviderContext<MetaCredentials>,
  u: ObjectUpdate,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const level = toMetaLevel(u.level)
  const c = u.changes
  const currency = ctx.account.currency
  if (c.finalUrl !== undefined) {
    throw invalid(
      "Meta không cho sửa URL đích của quảng cáo có sẵn (URL nằm trong creative).",
      "Tạo quảng cáo mới bằng meta_create_ad với URL mới rồi tạm dừng quảng cáo cũ."
    )
  }
  if (level === "ad" && (c.startTime !== undefined || c.endTime !== undefined || c.bidAmount !== undefined)) {
    throw invalid("Quảng cáo Meta chỉ sửa được tên; lịch chạy và giá thầu nằm ở nhóm quảng cáo.")
  }
  if (level === "campaign" && c.bidAmount !== undefined) {
    throw invalid("Giá thầu (bid_amount) nằm ở nhóm quảng cáo, không phải chiến dịch.")
  }
  if (c.startTime === null || c.endTime === null) {
    throw invalid("Không hỗ trợ xoá thời gian bắt đầu/kết thúc; hãy truyền thời điểm cụ thể (ISO-8601 có múi giờ).")
  }
  for (const [k, v] of [["start_time", c.startTime], ["end_time", c.endTime]] as const) {
    if (v !== undefined && !isIsoDateTimeWithOffset(v)) {
      throw invalid(`${k} phải là thời điểm ISO-8601 có múi giờ, ví dụ 2026-10-05T08:00:00+07:00.`)
    }
  }
  if (c.name !== undefined && (c.name.trim().length === 0 || c.name.length > 400)) {
    throw invalid("Tên phải có 1–400 ký tự.")
  }

  const endField = level === "campaign" ? "stop_time" : "end_time"
  // Ads have no start_time/end_time (only ad_schedule_*); requesting them fails with #100.
  const fields = ["id", "name", "status", "effective_status", ...(level === "ad" ? [] : ["start_time", endField])]
  if (level === "adset") fields.push("bid_amount", "bid_strategy", "lifetime_budget", "campaign{bid_strategy}")
  if (level === "campaign") fields.push("objective")
  const node = await readNode(ctx, level, u.id, fields)

  const changes: FieldChange[] = []
  const params: Record<string, unknown> = {}
  const warnings: string[] = []
  const base = { objectId: node.id, objectName: name(node), level: fromMetaLevel(level) }

  if (c.name !== undefined && c.name !== node.name) {
    params.name = c.name.trim()
    changes.push({ ...base, field: "name", before: node.name ?? null, after: params.name })
  }
  if (c.startTime !== undefined) {
    params.start_time = c.startTime
    changes.push({ ...base, field: "start_time", before: node.start_time ?? null, after: c.startTime })
  }
  if (c.endTime !== undefined) {
    if (Date.parse(c.endTime) <= Date.now()) throw invalid("Thời gian kết thúc phải ở tương lai.")
    params[endField] = c.endTime
    changes.push({ ...base, field: endField, before: node[endField] ?? null, after: c.endTime })
  }
  const start = c.startTime ?? (node.start_time as string | undefined)
  const end = c.endTime ?? (node[endField] as string | undefined)
  if (start && end && Date.parse(end) <= Date.parse(start)) throw invalid("Thời gian kết thúc phải sau thời gian bắt đầu.")

  if (c.bidAmount !== undefined && c.bidAmount !== null) {
    if (!Number.isFinite(c.bidAmount) || c.bidAmount <= 0) throw invalid("Giá thầu phải lớn hơn 0.")
    const strategy = String(node.bid_strategy ?? (node.campaign as { bid_strategy?: string } | undefined)?.bid_strategy ?? "")
    if (strategy === "LOWEST_COST_WITHOUT_CAP" || strategy === "") {
      warnings.push("Chiến lược giá thầu hiện tại là chi phí thấp nhất (không giới hạn) - Meta có thể từ chối bid_amount.")
    }
    const minor = toMetaMinor(c.bidAmount, currency)
    params.bid_amount = minor
    changes.push({
      ...base,
      field: "bid_amount",
      before: fromMetaMinor(node.bid_amount as string | undefined, currency),
      after: minor / metaCurrencyOffset(currency),
    })
  } else if (c.bidAmount === null) {
    throw invalid("Không hỗ trợ xoá giá thầu; hãy đổi chiến lược giá thầu trong Ads Manager.")
  }

  if (changes.length === 0) {
    return { preview: !!opts.dryRun, changes: [], warnings: [...warnings, "Không có thay đổi nào so với hiện tại."] }
  }
  if (level === "ad") warnings.push("Sửa quảng cáo có thể khiến Meta duyệt lại.")
  // Preview from reads only (validate_only is not documented on updates).
  if (opts.dryRun) return { preview: true, changes, warnings }
  await graph(callCtx(ctx), { method: "POST", path: node.id, params, idempotent: true })
  return { preview: false, changes, warnings }
}

export async function deleteMetaObject(
  ctx: ProviderContext<MetaCredentials>,
  objLevel: ObjectLevel,
  id: string,
  opts: MutationOptions = {}
): Promise<MutationResult> {
  const level = toMetaLevel(objLevel)
  const node = await readNode(ctx, level, id, ["id", "name", "status", "effective_status", LEVEL_PROBE[level]])
  assertSameAccount(ctx, node, LEVEL_VI[level])
  if (node.status === "DELETED") {
    return { preview: !!opts.dryRun, changes: [], warnings: [`${name(node)} đã bị xoá trước đó.`] }
  }
  const warnings = ["Xoá trên Meta không thể hoàn tác."]
  if (level !== "ad") warnings.push(`Toàn bộ đối tượng con của ${LEVEL_VI[level]} này cũng sẽ bị xoá.`)
  const change: FieldChange = {
    objectId: node.id,
    objectName: name(node),
    level: fromMetaLevel(level),
    field: "status",
    before: node.status ?? null,
    after: "DELETED",
  }
  if (opts.dryRun) return { preview: true, changes: [change], warnings }
  await graph(callCtx(ctx), { method: "POST", path: node.id, params: { status: "DELETED" }, idempotent: true })
  return { preview: false, changes: [change], warnings }
}
