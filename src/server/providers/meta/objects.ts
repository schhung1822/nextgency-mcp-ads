// ads_list_objects / ads_get_object for Meta (campaigns, ad sets, ads).
import { createHash } from "node:crypto"

import { isProviderError, ProviderError } from "../errors"
import { fromMetaMinor } from "../money"
import type {
  AdObjectDetail,
  AdObjectSummary,
  ListQuery,
  ObjectLevel,
  ObjectPage,
  ProviderContext,
} from "../types"
import { actId, graph, graphAll, graphPage, type MetaCredentials } from "./client"
import {
  LEVEL_EDGE,
  assertSameAccount,
  base64UrlJson,
  budgetFromNode,
  callCtx,
  effectiveStatusesFor,
  noMatchingStatus,
  fromMetaLevel,
  invalid,
  invalidCursor,
  mapEffectiveStatus,
  parseBase64UrlJson,
  toMetaLevel,
  type MetaLevel,
} from "./shared"

export const SUMMARY_FIELDS: Record<MetaLevel, string[]> = {
  campaign: [
    "id",
    "name",
    "account_id",
    "status",
    "effective_status",
    "objective",
    "daily_budget",
    "lifetime_budget",
    "budget_remaining",
    "bid_strategy",
    "buying_type",
    "special_ad_categories",
    "start_time",
    "stop_time",
    "created_time",
    "updated_time",
  ],
  adset: [
    "id",
    "name",
    "account_id",
    "campaign_id",
    "status",
    "effective_status",
    "daily_budget",
    "lifetime_budget",
    "budget_remaining",
    "bid_strategy",
    "bid_amount",
    "billing_event",
    "optimization_goal",
    "destination_type",
    "start_time",
    "end_time",
    "created_time",
    "updated_time",
  ],
  ad: [
    "id",
    "name",
    "account_id",
    "campaign_id",
    "adset_id",
    "status",
    "effective_status",
    "created_time",
    "updated_time",
  ],
}

export const DETAIL_EXTRA_FIELDS: Record<MetaLevel, string[]> = {
  campaign: ["configured_status", "spend_cap", "is_adset_budget_sharing_enabled", "issues_info", "smart_promotion_type", "promoted_object"],
  adset: [
    "configured_status",
    "targeting",
    "promoted_object",
    "attribution_spec",
    "is_dynamic_creative",
    "dsa_beneficiary",
    "dsa_payor",
    "issues_info",
    "learning_stage_info",
  ],
  ad: [
    "configured_status",
    "creative{id,name,title,body,image_hash,image_url,video_id,object_story_id,effective_object_story_id,object_story_spec,url_tags,call_to_action_type,call_to_action,page_welcome_message,thumbnail_url}",
    "ad_review_feedback",
    "issues_info",
    "tracking_specs",
  ],
}

/**
 * Ad detail fields before v1.1.4 (no creative call_to_action / page_welcome_message): the read is retried ONCE with
 * them when Meta rejects a requested field (#100), so a field Meta does not serve never breaks ads_get_object.
 */
const AD_DETAIL_FIELDS_V113 = [
  "configured_status",
  "creative{id,name,title,body,image_hash,image_url,video_id,object_story_id,effective_object_story_id,object_story_spec,url_tags,call_to_action_type,thumbnail_url}",
  "ad_review_feedback",
  "issues_info",
  "tracking_specs",
]

/** Meta rejected a requested field ("(#100) Tried accessing nonexisting field …"): code 100, no subcode / a field message. */
export function isGraphFieldError(e: unknown): boolean {
  if (!isProviderError(e) || e.code !== "invalid_request" || e.upstream?.code !== 100) return false
  return e.upstream.subcode === null || e.upstream.subcode === undefined || /field/i.test(e.upstream.message ?? "")
}

export type RawNode = Record<string, unknown> & { id: string }

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

export function toSummary(node: RawNode, level: MetaLevel, currency: string): AdObjectSummary {
  const statusRaw = str(node.effective_status) ?? str(node.status) ?? "UNKNOWN"
  const out: AdObjectSummary = {
    id: node.id,
    level: fromMetaLevel(level),
    name: str(node.name) ?? node.id,
    status: mapEffectiveStatus(statusRaw),
    statusRaw,
    createdTime: str(node.created_time),
    startTime: str(node.start_time),
    endTime: level === "campaign" ? str(node.stop_time) : str(node.end_time),
  }
  if (level === "campaign") {
    out.campaignId = node.id
    out.parentId = null
    out.objective = str(node.objective)
    out.budget = budgetFromNode(node, currency, "campaign")
    out.extra = {
      configuredStatus: str(node.status),
      bidStrategy: str(node.bid_strategy),
      budgetRemaining: fromMetaMinor(node.budget_remaining as string | undefined, currency),
      specialAdCategories: node.special_ad_categories ?? [],
      budgetMode: out.budget ? "CBO" : "ABO",
    }
  } else if (level === "adset") {
    out.campaignId = str(node.campaign_id)
    out.parentId = str(node.campaign_id)
    out.budget = budgetFromNode(node, currency, "ad_group")
    out.extra = {
      configuredStatus: str(node.status),
      optimizationGoal: str(node.optimization_goal),
      billingEvent: str(node.billing_event),
      bidStrategy: str(node.bid_strategy),
      bidAmount: fromMetaMinor(node.bid_amount as string | undefined, currency),
      budgetRemaining: fromMetaMinor(node.budget_remaining as string | undefined, currency),
      destinationType: str(node.destination_type),
    }
  } else {
    out.campaignId = str(node.campaign_id)
    out.parentId = str(node.adset_id)
    out.budget = null
    out.extra = { configuredStatus: str(node.status) }
  }
  return out
}

const SUMMARY_KEYS = new Set([
  "id",
  "name",
  "status",
  "effective_status",
  "created_time",
  "start_time",
  "end_time",
  "stop_time",
  "campaign_id",
  "adset_id",
  "account_id",
  "objective",
])

export function toDetail(node: RawNode, level: MetaLevel, currency: string): AdObjectDetail {
  const summary = toSummary(node, level, currency)
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (SUMMARY_KEYS.has(k)) continue
    // money fields are converted to MAJOR units for the AI
    if (["daily_budget", "lifetime_budget", "budget_remaining", "bid_amount", "spend_cap"].includes(k)) {
      config[k] = fromMetaMinor(v as string | undefined, currency)
      continue
    }
    config[k] = v
  }
  if (Object.keys(config).some((k) => ["daily_budget", "lifetime_budget", "bid_amount", "spend_cap"].includes(k))) {
    config.money_unit = `major (${currency})`
  }
  return { ...summary, config }
}

interface ListCursor {
  v: 1
  fp: string
  after: string
}

function listFingerprint(ctx: ProviderContext<MetaCredentials>, q: ListQuery): string {
  return createHash("sha256")
    .update(JSON.stringify([ctx.account.externalId, q.level, q.parentId ?? null, q.statuses ?? null, q.nameContains ?? null]))
    .digest("hex")
    .slice(0, 16)
}

export async function listMetaObjects(ctx: ProviderContext<MetaCredentials>, q: ListQuery): Promise<ObjectPage> {
  const level = toMetaLevel(q.level)
  const call = callCtx(ctx)
  const warnings: string[] = []
  // B3: Meta errors on an edge query whose effective_status filter contains DELETED ("Manage Your Ad Object's
  // Status" [H]); deleted objects are readable by id only. Report filters still accept DELETED (report.ts).
  const wantsDeleted = q.statuses?.some((s) => s === "deleted" || s === "removed") ?? false
  const statuses = q.statuses?.filter((s) => s !== "deleted" && s !== "removed")
  if (wantsDeleted && !statuses?.length) {
    throw invalid(
      "Meta không cho liệt kê đối tượng đã xoá (DELETED) - đối tượng đã xoá chỉ đọc được theo id.",
      "Dùng ads_get_object với id cụ thể, hoặc ads_get_report (bật include_deleted) để xem chi tiêu của đối tượng đã xoá; cần đối tượng đã lưu trữ thì lọc statuses: [\"archived\"]."
    )
  }
  if (wantsDeleted) warnings.push("Meta không liệt kê đối tượng đã xoá - đã bỏ deleted/removed khỏi bộ lọc trạng thái.")
  const fp = listFingerprint(ctx, q)
  let after: string | null = null
  if (q.cursor) {
    const c = parseBase64UrlJson<ListCursor>(q.cursor)
    if (!c || c.v !== 1 || c.fp !== fp || typeof c.after !== "string") throw invalidCursor()
    after = c.after
  }

  let path = `${actId(ctx.account.externalId)}/${LEVEL_EDGE[level]}`
  if (q.parentId) {
    if (level === "campaign") {
      warnings.push("Chiến dịch không có cấp cha - bỏ qua parent_id.")
    } else {
      if (!/^\d{1,30}$/.test(q.parentId)) {
        throw new ProviderError({
          platform: "meta",
          code: "invalid_request",
          message: `meta: invalid parent id ${q.parentId}`,
          userMessageVi: "parent_id không hợp lệ (id Meta chỉ gồm chữ số).",
        })
      }
      // verify parent belongs to this account before listing its children
      const parentLevel: MetaLevel = level === "adset" ? "campaign" : "adset"
      const parent = await graph<RawNode>(call, {
        method: "GET",
        path: q.parentId,
        params: { fields: "id,account_id" },
        idempotent: true,
      })
      assertSameAccount(ctx, parent, parentLevel === "campaign" ? "chiến dịch" : "nhóm quảng cáo")
      path = `${q.parentId}/${LEVEL_EDGE[level]}`
    }
  }

  const params: Record<string, unknown> = {
    fields: SUMMARY_FIELDS[level].join(","),
    limit: Math.min(Math.max(Math.trunc(q.limit) || 50, 1), 200),
  }
  if (statuses?.length) {
    const raw = effectiveStatusesFor(statuses, level)
    if (!raw.length) throw noMatchingStatus(level)
    params.effective_status = raw
  }
  if (q.nameContains) params.filtering = [{ field: "name", operator: "CONTAIN", value: q.nameContains }]
  if (after) params.after = after

  const page = await graphPage<RawNode>(call, path, params)
  const items = page.data.map((n) => toSummary(n, level, ctx.account.currency))
  return {
    items,
    nextCursor: page.after ? base64UrlJson({ v: 1, fp, after: page.after } satisfies ListCursor) : null,
    warnings,
  }
}

/** Read one node with the given fields and verify it belongs to the context's ad account. */
export async function readNode(
  ctx: ProviderContext<MetaCredentials>,
  level: MetaLevel,
  id: string,
  fields: string[]
): Promise<RawNode> {
  if (!/^\d{1,30}$/.test(id)) {
    throw new ProviderError({
      platform: "meta",
      code: "invalid_request",
      message: `meta: invalid object id ${id}`,
      userMessageVi: `Id "${id}" không hợp lệ (id Meta chỉ gồm chữ số).`,
      hint: "Gọi ads_list_objects để lấy đúng id.",
    })
  }
  const f = new Set([...fields, "id", "account_id", ...(level === "campaign" ? [] : ["campaign_id"])])
  const node = await graph<RawNode>(callCtx(ctx), {
    method: "GET",
    path: id,
    params: { fields: [...f].join(",") },
    idempotent: true,
  })
  assertSameAccount(ctx, node, levelVi(level))
  // a campaign id passed as an ad set (etc.) - Meta would 100 on unknown fields; double-check shape
  if (level !== "campaign" && !node.campaign_id) {
    throw new ProviderError({
      platform: "meta",
      code: "not_found",
      message: `meta: ${id} is not a ${level}`,
      userMessageVi: `Id ${id} không phải ${levelVi(level)}.`,
      hint: "Kiểm tra lại level của đối tượng.",
    })
  }
  return node
}

function levelVi(level: MetaLevel): string {
  return level === "campaign" ? "chiến dịch" : level === "adset" ? "nhóm quảng cáo" : "quảng cáo"
}

const MAX_TREE_ADS = 500

export async function getMetaObject(
  ctx: ProviderContext<MetaCredentials>,
  objLevel: ObjectLevel,
  id: string,
  opts: { includeChildren?: boolean } = {}
): Promise<AdObjectDetail> {
  const level = toMetaLevel(objLevel)
  const fields = [...SUMMARY_FIELDS[level], ...DETAIL_EXTRA_FIELDS[level]]
  const node = await readNode(ctx, level, id, fields).catch((e: unknown) => {
    // v1.1.4 E4 guard: a creative field Meta rejects (#100) → one retry with the v1.1.3 field list (silent: the detail
    // has no warnings; the fields are only missing from config.creative)
    if (level !== "ad" || !isGraphFieldError(e)) throw e
    return readNode(ctx, level, id, [...SUMMARY_FIELDS.ad, ...AD_DETAIL_FIELDS_V113])
  })
  const currency = ctx.account.currency
  const detail = toDetail(node, level, currency)
  if (!opts.includeChildren || level === "ad") return detail

  const call = callCtx(ctx)
  if (level === "campaign") {
    const adsets = await graphAll<RawNode>(
      call,
      `${id}/adsets`,
      { fields: [...SUMMARY_FIELDS.adset, "targeting", "promoted_object"].join(","), limit: 200 },
      MAX_TREE_ADS
    )
    const ads = await graphAll<RawNode>(call, `${id}/ads`, { fields: SUMMARY_FIELDS.ad.join(","), limit: 200 }, MAX_TREE_ADS)
    const byAdset = new Map<string, AdObjectDetail[]>()
    for (const a of ads.data) {
      const k = String(a.adset_id ?? "")
      if (!byAdset.has(k)) byAdset.set(k, [])
      byAdset.get(k)!.push(toDetail(a, "ad", currency))
    }
    detail.children = adsets.data.map((s) => ({ ...toDetail(s, "adset", currency), children: byAdset.get(s.id) ?? [] }))
    if (adsets.truncated || ads.truncated) detail.config.children_truncated = true
  } else {
    const ads = await graphAll<RawNode>(call, `${id}/ads`, { fields: SUMMARY_FIELDS.ad.join(","), limit: 200 }, MAX_TREE_ADS)
    detail.children = ads.data.map((a) => toDetail(a, "ad", currency))
    if (ads.truncated) detail.config.children_truncated = true
  }
  return detail
}
