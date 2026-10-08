// Campaign / ad group / ad reads: /campaign/get/, /adgroup/get/, /ad/get/ (+ /smart_plus/*/get/ for
// Upgraded Smart+ detail). Always `exclude_field_types_in_response=["NULL_FIELD"]`.
import { ProviderError } from "../errors"
import type {
  AdObjectDetail,
  AdObjectSummary,
  ListQuery,
  NormalizedStatus,
  ObjectLevel,
  ObjectPage,
  ProviderContext,
} from "../types"
import {
  automationType,
  chunk,
  invalid,
  normalizeStatus,
  notFound,
  statusRaw,
  str,
  tiktokTimeToIso,
  toBudget,
  toTikTokLevel,
  ttFromCtx,
  ttGet,
  ttGetAll,
  type Raw,
  type TT,
} from "./api"
import type { TikTokCredentials } from "./credentials"

const EXCLUDE_NULL = ["NULL_FIELD"]
const MAX_PAGE_SIZE = 1000

const GET_PATH = { campaign: "campaign/get", adgroup: "adgroup/get", ad: "ad/get" } as const
const SMART_PLUS_GET_PATH = {
  campaign: "smart_plus/campaign/get",
  adgroup: "smart_plus/adgroup/get",
  ad: "smart_plus/ad/get",
} as const

/** Canonical ad id: Upgraded Smart+ creatives (rows of /ad/get/) are grouped under their smart_plus_ad_id. */
export function adCanonicalId(o: Raw): string {
  if (automationType(o) === "UPGRADED_SMART_PLUS_CREATIVE" && o.smart_plus_ad_id) return String(o.smart_plus_ad_id)
  return String(o.ad_id_v2 ?? o.ad_id)
}

export function objectId(level: ObjectLevel, o: Raw): string {
  if (level === "campaign") return String(o.campaign_id)
  if (level === "ad_group") return String(o.adgroup_id)
  return adCanonicalId(o)
}

export function objectName(level: ObjectLevel, o: Raw): string {
  if (level === "campaign") return str(o.campaign_name) ?? ""
  if (level === "ad_group") return str(o.adgroup_name) ?? ""
  return str(o.ad_name) ?? ""
}

/** operation_status (what the owner switched) → Meta-style configured status read by mcp/budget-flight isConfiguredOn. */
export function configuredStatus(operationStatus: unknown): "ACTIVE" | "PAUSED" | "DELETED" | null {
  if (operationStatus === "ENABLE") return "ACTIVE"
  if (operationStatus === "DISABLE") return "PAUSED"
  if (operationStatus === "DELETE") return "DELETED"
  return null
}

export function toSummary(level: ObjectLevel, o: Raw, currency: string): AdObjectSummary {
  const base: AdObjectSummary = {
    id: objectId(level, o),
    level,
    name: objectName(level, o),
    status: normalizeStatus(o.operation_status, o.secondary_status),
    statusRaw: statusRaw(o),
    createdTime: tiktokTimeToIso(o.create_time),
  }
  const extra: Raw = { campaign_automation_type: automationType(o) }
  const configured = configuredStatus(o.operation_status)
  if (configured) extra.configuredStatus = configured
  if (level === "campaign") {
    base.budget = toBudget(o, "campaign", currency)
    base.objective = str(o.objective_type)
    extra.budget_mode = str(o.budget_mode)
    extra.budget_optimize_on = o.budget_optimize_on === true
    if (o.virtual_objective_type) extra.virtual_objective_type = o.virtual_objective_type
  } else if (level === "ad_group") {
    base.campaignId = str(o.campaign_id)
    base.parentId = str(o.campaign_id)
    base.budget = toBudget(o, "ad_group", currency)
    base.startTime = tiktokTimeToIso(o.schedule_start_time)
    base.endTime = o.schedule_type === "SCHEDULE_FROM_NOW" ? null : tiktokTimeToIso(o.schedule_end_time)
    extra.budget_mode = str(o.budget_mode)
    extra.cbo = o.budget_mode === "BUDGET_MODE_INFINITE"
    extra.optimization_goal = str(o.optimization_goal)
    extra.billing_event = str(o.billing_event)
    extra.bid_type = str(o.bid_type)
    extra.placement_type = str(o.placement_type)
    const scheduled = Number(o.scheduled_budget)
    if (Number.isFinite(scheduled) && scheduled > 0) extra.scheduled_budget_next_day = scheduled
  } else {
    base.campaignId = str(o.campaign_id)
    base.parentId = str(o.adgroup_id)
    extra.ad_format = str(o.ad_format)
    extra.identity_type = str(o.identity_type)
    extra.landing_page_url = str(o.landing_page_url)
    if (automationType(o) === "UPGRADED_SMART_PLUS_CREATIVE") extra.creative_ad_id = str(o.ad_id)
  }
  base.extra = extra
  return base
}

// ---------------------------------------------------------------------------
// Fetching by ids
// ---------------------------------------------------------------------------

/**
 * Fetch raw objects by id (any status, deleted included). For ads the ids are matched through
 * `ad_ids_v2` (Manual ad id or Upgraded Smart+ ad id), falling back to `ad_ids`.
 */
export async function fetchByIds(tt: TT, level: ObjectLevel, ids: string[]): Promise<Map<string, Raw>> {
  const tl = toTikTokLevel(level)
  const out = new Map<string, Raw>()
  const unique = [...new Set(ids.map(String))]
  for (const batch of chunk(unique, 100)) {
    const filtering: Raw = { primary_status: "STATUS_ALL" }
    if (tl === "campaign") filtering.campaign_ids = batch
    else if (tl === "adgroup") filtering.adgroup_ids = batch
    else filtering.ad_ids_v2 = batch
    const list = await ttGetAll<Raw>(tt, GET_PATH[tl], {
      advertiser_id: tt.advertiserId,
      filtering,
      exclude_field_types_in_response: EXCLUDE_NULL,
    })
    for (const o of list) {
      const id = objectId(level, o)
      if (batch.includes(id) && !out.has(id)) out.set(id, o)
      // ad_ids_v2 rows of Manual ads carry ad_id == ad_id_v2
      if (tl === "ad" && batch.includes(String(o.ad_id)) && !out.has(String(o.ad_id))) out.set(String(o.ad_id), o)
    }
    if (tl === "ad") {
      const missing = batch.filter((id) => !out.has(id))
      if (missing.length) {
        const legacy = await ttGetAll<Raw>(tt, GET_PATH.ad, {
          advertiser_id: tt.advertiserId,
          filtering: { primary_status: "STATUS_ALL", ad_ids: missing },
          exclude_field_types_in_response: EXCLUDE_NULL,
        })
        for (const o of legacy) if (missing.includes(String(o.ad_id))) out.set(String(o.ad_id), o)
      }
    }
  }
  return out
}

export async function fetchOne(tt: TT, level: ObjectLevel, id: string): Promise<Raw> {
  const o = (await fetchByIds(tt, level, [id])).get(String(id))
  if (!o) throw notFound(level, id)
  return o
}

/** Detail of an Upgraded Smart+ object from the dedicated endpoint (full config). */
async function fetchSmartPlus(tt: TT, level: ObjectLevel, id: string): Promise<Raw | null> {
  const tl = toTikTokLevel(level)
  const filtering: Raw =
    tl === "campaign" ? { campaign_ids: [id] } : tl === "adgroup" ? { adgroup_ids: [id] } : { smart_plus_ad_ids: [id] }
  const res = await ttGet<{ list?: Raw[] }>(tt, SMART_PLUS_GET_PATH[tl], {
    advertiser_id: tt.advertiserId,
    filtering,
    page: 1,
    page_size: 10,
  })
  return res.data.list?.[0] ?? null
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface ListCursor {
  p: number
  f: string
}

function listFingerprint(q: ListQuery): string {
  return JSON.stringify([q.level, q.parentId ?? null, q.statuses ?? null, q.nameContains ?? null, q.limit])
}

function primaryStatusFor(statuses: NormalizedStatus[] | undefined): string {
  if (!statuses?.length) return "STATUS_NOT_DELETE"
  if (statuses.includes("deleted")) return statuses.length === 1 ? "STATUS_DELETE" : "STATUS_ALL"
  if (statuses.length === 1 && statuses[0] === "paused") return "STATUS_DISABLE"
  return "STATUS_NOT_DELETE"
}

export async function listTikTokObjects(ctx: ProviderContext<TikTokCredentials>, q: ListQuery): Promise<ObjectPage> {
  const tt = ttFromCtx(ctx)
  const tl = toTikTokLevel(q.level)
  const warnings: string[] = []
  const limit = Math.max(1, Math.min(q.limit || 50, MAX_PAGE_SIZE))
  const fp = listFingerprint(q)
  let page = 1
  if (q.cursor) {
    try {
      const c = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")) as ListCursor
      if (c.f !== fp || !Number.isInteger(c.p) || c.p < 1) throw new Error("mismatch")
      page = c.p
    } catch {
      throw invalid("Cursor không hợp lệ hoặc không khớp với truy vấn.", "Gọi lại ads_list_objects không kèm cursor.")
    }
  }
  const filtering: Raw = { primary_status: primaryStatusFor(q.statuses) }
  if (q.parentId) {
    if (tl === "adgroup") filtering.campaign_ids = [q.parentId]
    else if (tl === "ad") filtering.adgroup_ids = [q.parentId]
    else warnings.push("Chiến dịch không có cấp cha - đã bỏ qua parentId.")
  }
  const needle = q.nameContains?.trim() || null
  if (needle && tl === "campaign") filtering.campaign_name = needle
  if (needle && tl === "adgroup") filtering.adgroup_name = needle

  const res = await ttGet<{ list?: Raw[]; page_info?: { total_page?: number } }>(tt, GET_PATH[tl], {
    advertiser_id: tt.advertiserId,
    filtering,
    exclude_field_types_in_response: EXCLUDE_NULL,
    page,
    page_size: limit,
  })
  const list = res.data.list ?? []
  const totalPage = Number(res.data.page_info?.total_page ?? 0)
  let items = dedupeAds(q.level, list).map((o) => toSummary(q.level, o, tt.currency))
  if (needle) {
    const n = needle.toLowerCase()
    items = items.filter((i) => i.name.toLowerCase().includes(n))
  }
  if (q.statuses?.length) items = items.filter((i) => q.statuses!.includes(i.status))
  if (tl === "ad" && list.some((o) => automationType(o) === "UPGRADED_SMART_PLUS_CREATIVE")) {
    warnings.push("Quảng cáo Upgraded Smart+ được gộp theo smart_plus_ad_id (mỗi quảng cáo có thể gồm nhiều creative).")
  }
  if ((q.statuses?.length || (needle && tl === "ad")) && items.length < list.length) {
    warnings.push("Một phần bộ lọc được áp dụng sau khi lấy dữ liệu nên trang này có thể ít hơn giới hạn.")
  }
  const nextCursor =
    page < totalPage ? Buffer.from(JSON.stringify({ p: page + 1, f: fp } satisfies ListCursor)).toString("base64url") : null
  return { items, nextCursor, warnings }
}

function dedupeAds(level: ObjectLevel, list: Raw[]): Raw[] {
  if (level !== "ad") return list
  const seen = new Set<string>()
  return list.filter((o) => {
    const id = adCanonicalId(o)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

// ---------------------------------------------------------------------------
// Detail (+ children tree)
// ---------------------------------------------------------------------------

function toDetail(level: ObjectLevel, o: Raw, currency: string, smartPlus: Raw | null): AdObjectDetail {
  const summary = toSummary(level, o, currency)
  const config: Raw = { ...o }
  if (smartPlus) config.smart_plus = smartPlus
  return { ...summary, config }
}

const MAX_TREE_ADGROUPS = 200
const MAX_TREE_ADS = 500

export async function getTikTokObject(
  ctx: ProviderContext<TikTokCredentials>,
  level: ObjectLevel,
  id: string,
  opts: { includeChildren?: boolean } = {}
): Promise<AdObjectDetail> {
  const tt = ttFromCtx(ctx)
  toTikTokLevel(level)
  const o = await fetchOne(tt, level, id)
  const smartPlus = automationType(o) === "UPGRADED_SMART_PLUS" ? await fetchSmartPlus(tt, level, id).catch(() => null) : null
  const detail = toDetail(level, o, tt.currency, smartPlus)
  if (!opts.includeChildren || level === "ad") return detail

  if (level === "campaign") {
    const groups = await ttGetAll<Raw>(
      tt,
      GET_PATH.adgroup,
      {
        advertiser_id: tt.advertiserId,
        filtering: { campaign_ids: [id], primary_status: "STATUS_NOT_DELETE" },
        exclude_field_types_in_response: EXCLUDE_NULL,
      },
      { max: MAX_TREE_ADGROUPS }
    )
    const ads = await fetchAdsForAdGroups(
      tt,
      groups.map((g) => String(g.adgroup_id))
    )
    detail.children = groups.map((g) => {
      const gd = toDetail("ad_group", g, tt.currency, null)
      gd.children = dedupeAds("ad", ads.filter((a) => String(a.adgroup_id) === String(g.adgroup_id))).map((a) =>
        toDetail("ad", a, tt.currency, null)
      )
      return gd
    })
  } else {
    const ads = await fetchAdsForAdGroups(tt, [id])
    detail.children = dedupeAds("ad", ads).map((a) => toDetail("ad", a, tt.currency, null))
  }
  return detail
}

export async function fetchAdsForAdGroups(tt: TT, adgroupIds: string[]): Promise<Raw[]> {
  const out: Raw[] = []
  for (const batch of chunk(adgroupIds, 100)) {
    if (!batch.length) continue
    out.push(
      ...(await ttGetAll<Raw>(
        tt,
        GET_PATH.ad,
        {
          advertiser_id: tt.advertiserId,
          filtering: { adgroup_ids: batch, primary_status: "STATUS_NOT_DELETE" },
          exclude_field_types_in_response: EXCLUDE_NULL,
        },
        { max: MAX_TREE_ADS }
      ))
    )
    if (out.length >= MAX_TREE_ADS) break
  }
  return out
}

export function assertNotLegacySmartPlus(level: ObjectLevel, o: Raw, action: string): void {
  if (automationType(o) === "SMART_PLUS") {
    throw new ProviderError({
      platform: "tiktok",
      code: "unsupported",
      message: `Legacy Smart+ ${level} cannot be ${action}`,
      userMessageVi: `Đây là chiến dịch Smart+ đời cũ (TikTok đã ngừng tạo/sửa qua API từ 2026) - không thể ${action}.`,
      hint: "Thao tác trực tiếp trong TikTok Ads Manager.",
    })
  }
}
