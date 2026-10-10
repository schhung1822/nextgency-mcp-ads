// TikTok GMV Max (TikTok Shop) - READ helpers + the three analysis tiktok_gmv_max_* MCP tools (writes: gmv-max-write.ts).
// Endpoints (v1.3, research 2026-10-10, providers/tiktok.md §GMV Max):
//   GET /gmv_max/store/list/     shops of the ad account + GMV Max readiness (no pagination)
//   GET /gmv_max/campaign/get/   GMV Max campaigns; filtering.gmv_max_promotion_types REQUIRED
//                                (PRODUCT_GMV_MAX | LIVE_GMV_MAX); page_size 1-100; no budget/ROI/store in rows
//   GET /campaign/gmv_max/info/  ONE campaign per call: budget (daily, major units), roas_bid, auto budget,
//                                promotion days, schedule (UTC+0), identities, posts (temporary media URLs!)
//   GET /gmv_max/report/get/     store_ids max 1; dimensions from fixed groupings per level; filtering is an
//                                OBJECT; no breakdown ≤365 days, stat_time_day ≤30 days; page_size ≤1000;
//                                values are strings (LIVE all_shops_* are numbers); money in the ad account
//                                currency (never read `currency` from rows - undocumented/inconsistent)
// Nothing here writes (writes live in gmv-max-write.ts, behind the admin-only MCP switch). Temporary media URLs (thumbnails, profile images, covers, previews) are never returned.
import { z } from "zod"
import {
  assertRange,
  daysBetweenInclusive,
  DATE_PRESETS,
  resolvePreset,
  splitRange,
} from "../dates"
import { isProviderError, ProviderError } from "../errors"
import { num, roundMoney } from "../money"
import type {
  DateRange,
  NormalizedStatus,
  ProviderContext,
  ProviderExtension,
  ReportPage,
} from "../types"
import {
  chunk,
  invalid,
  normalizeStatus,
  parseTikTokTime,
  statusRaw,
  str,
  tiktokTimeToIso,
  ttFromCtx,
  ttGet,
  tzOffsetMs,
  type PageInfo,
  type Raw,
  type TT,
} from "./api"
import { tiktokRequest } from "./client"
import type { TikTokCredentials } from "./credentials"
import {
  detectGmvMaxCampaigns,
  gmvMaxCandidateIds,
  gmvMaxCheckFailure,
  gmvMaxErrorText,
} from "./gmv-max-detect"
import {
  GMV_MAX_ACCOUNT_LEVEL_DELETED_NOTE,
  GMV_MAX_BOOST_FALLBACK_NOTE,
  GMV_MAX_CAUTION,
  GMV_MAX_LEGACY_AUTO_BUDGET_NOTE,
  GMV_MAX_NOT_IN_REPORT_WARNING,
  GMV_MAX_REPORT_NOTES,
  GMV_MAX_SESSIONS_NOT_INCLUDED,
  gmvMaxBudgetUnverifiedMessage,
  gmvMaxScopeHint,
} from "./gmv-max-text"

export type GmvMaxType = "PRODUCT" | "LIVE"
export const GMV_MAX_TYPES: readonly GmvMaxType[] = ["PRODUCT", "LIVE"]
/** Value of filtering.gmv_max_promotion_types on /gmv_max/campaign/get/ (the report uses plain PRODUCT/LIVE). */
export const GMV_MAX_PROMOTION_TYPE: Record<GmvMaxType, string> = {
  PRODUCT: "PRODUCT_GMV_MAX",
  LIVE: "LIVE_GMV_MAX",
}

/** What a read needs: token + advertiser (+ abort/upstream log). */
type TTRead = Pick<TT, "creds" | "advertiserId" | "signal" | "onUpstream">

/** First date with GMV Max data for most metrics (net_cost goes back to 2023-09-01). */
export const GMV_MAX_DATA_START = "2024-09-27"
export const GMV_MAX_DAY_WINDOW = 30
export const GMV_MAX_TOTAL_MAX_DAYS = 365
const CAMPAIGN_PAGE_SIZE = 100
const REPORT_PAGE_SIZE = 1000
/** /campaign/gmv_max/info/ is one call per campaign → cap */
export const GMV_MAX_MAX_DETAILS = 20
/** Shops iterated by the report when store_id is omitted (one shop per report call). */
export const GMV_MAX_MAX_SHOPS = 5
const MAX_REPORT_CALLS = 40
/** Keep tool results under the MCP structured-content cap (24k chars) */
const MAX_RESULT_CHARS = 20_000

const numericId = z.string().regex(/^\d+$/, { error: "Id phải là chuỗi số." })
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Ngày dạng YYYY-MM-DD." })

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function moneyOf(v: unknown, currency: string): number | null {
  return roundMoney(num(v), currency)
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null
}

/** "YYYY-MM-DD HH:MM:SS" UTC+0 → same format in the account time zone (null when unparsable). */
export function utcToAccountLocal(s: unknown, timezone: string): string | null {
  const d = parseTikTokTime(s)
  if (!d) return null
  const local = new Date(d.getTime() + tzOffsetMs(timezone, d))
  return local.toISOString().slice(0, 19).replace("T", " ")
}

/**
 * identity_list entry (doc 1822000968821762) → ALLOW-LISTED scalar fields only (ids, type, user name). Nested
 * objects and anything else (e.g. temporary profile_image URLs) are never passed through.
 */
export function mapGmvMaxIdentity(o: Raw): Raw {
  return {
    identity_id: scalar(o.identity_id),
    identity_type: scalar(o.identity_type),
    identity_authorized_bc_id: scalar(o.identity_authorized_bc_id),
    identity_authorized_shop_id: scalar(o.identity_authorized_shop_id),
    store_id: scalar(o.store_id),
    user_name: scalar(o.user_name),
    display_name: scalar(o.display_name),
  }
}

/** A nested object of a platform row ({} when absent or not an object). */
function objectOf(v: unknown): Raw {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {}
}

/** String of a scalar (string / number) value; objects, arrays, booleans and empty values → null. */
function scalar(v: unknown): string | null {
  if (typeof v === "string") return v === "" ? null : v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  return null
}

// ---------------------------------------------------------------------------
// Shops: /gmv_max/store/list/
// ---------------------------------------------------------------------------

export interface GmvMaxShop {
  store_id: string
  store_name: string | null
  store_code: string | null
  store_status: string | null
  /** your Business Center permission on the shop: AD_PROMOTION | MANAGER | UNSET */
  store_role: string | null
  targeting_region_codes: string[]
  is_gmv_max_available: boolean
  is_owner_bc: boolean | null
  business_center: {
    bc_id: string | null
    bc_name: string | null
    user_role: string | null
  }
  /** the ONE ad account authorized for GMV Max on this shop (name only when it is this account) */
  gmv_max_ad_account: {
    advertiser_id: string | null
    advertiser_name: string | null
    advertiser_status: string | null
  } | null
  authorized_for_this_account: boolean
  /** usable for GMV Max by THIS ad account */
  ready: boolean
  issues: string[]
}

export async function fetchGmvMaxStoresRaw(
  tt: Pick<TT, "creds" | "signal" | "onUpstream">,
  advertiserId: string
): Promise<Raw[]> {
  const res = await ttGet<{ store_list?: Raw[] }>(tt, "gmv_max/store/list", {
    advertiser_id: advertiserId,
  })
  return Array.isArray(res.data.store_list) ? res.data.store_list : []
}

/**
 * /gmv_max/store/list/ may return SEVERAL rows for one store_id (one per Business Center with access: the owner BC and
 * partner BCs, is_owner_bc). The row to use for THIS advertiser: ready rows first (GMV Max available + exclusively
 * authorized for this ad account), then rows with the AD_PROMOTION role, then the owner BC; ties keep TikTok's order.
 * null when the store is not listed.
 */
export function pickGmvMaxStoreRow(
  rows: Raw[],
  storeId: string,
  advertiserId: string
): Raw | null {
  const same = rows.filter((r) => String(r.store_id ?? "") === storeId)
  if (!same.length) return null
  const score = (r: Raw) => {
    const s = mapGmvMaxShop(r, advertiserId)
    return (
      (s.ready ? 8 : 0) +
      (s.store_role === "AD_PROMOTION" ? 4 : 0) +
      (s.authorized_for_this_account ? 2 : 0) +
      (r.is_owner_bc === true ? 1 : 0)
    )
  }
  let best = same[0]!
  for (const r of same.slice(1)) if (score(r) > score(best)) best = r
  return best
}

/** One row per store_id (pickGmvMaxStoreRow), in first-seen order. */
export function uniqueGmvMaxStoreRows(
  rows: Raw[],
  advertiserId: string
): Raw[] {
  const ids = [...new Set(rows.map((r) => String(r.store_id ?? "")))]
  return ids
    .map((id) => pickGmvMaxStoreRow(rows, id, advertiserId))
    .filter((r): r is Raw => r !== null)
}

export function mapGmvMaxShop(raw: Raw, advertiserId: string): GmvMaxShop {
  const bc = (raw.store_authorized_bc_info as Raw | undefined) ?? {}
  const ex = raw.exclusive_authorized_advertiser_info as Raw | undefined
  const exId = ex ? str(ex.advertiser_id) : null
  const available = raw.is_gmv_max_available === true
  const authorized = !!exId && exId === String(advertiserId)
  const role = str(raw.store_role)
  const userRole = str(bc.user_role)
  const storeStatus = str(raw.store_status)
  const issues: string[] = []
  if (!available)
    issues.push(
      "TikTok báo cửa hàng chưa dùng được cho GMV Max (is_gmv_max_available = false)."
    )
  // issues are server-written sentences only: platform values (ids, names, roles, statuses) stay in their own fields
  if (!exId) {
    issues.push(
      "Cửa hàng chưa cấp quyền GMV Max (độc quyền) cho tài khoản quảng cáo nào."
    )
  } else if (!authorized) {
    issues.push(
      "Quyền GMV Max của cửa hàng đang thuộc một tài khoản QC khác (xem gmv_max_ad_account.advertiser_id). Mỗi cửa hàng chỉ có 1 tài khoản GMV Max; đổi tài khoản sẽ tự tắt chiến dịch GMV Max của tài khoản cũ."
    )
  }
  const exStatus = ex ? str(ex.advertiser_status) : null
  if (exStatus && exStatus !== "STATUS_ENABLE")
    issues.push(
      "Tài khoản GMV Max của cửa hàng không ở trạng thái hoạt động (xem gmv_max_ad_account.advertiser_status)."
    )
  if (role !== "AD_PROMOTION") {
    issues.push(
      'Quyền của bạn trên cửa hàng (store_role) chưa phải "Quảng bá quảng cáo" (AD_PROMOTION) - cần cấp quyền này trong Business Center.'
    )
  }
  if (userRole && userRole !== "ADMIN")
    issues.push(
      "Người dùng của token chưa là Admin của Business Center được cấp cửa hàng."
    )
  if (storeStatus && storeStatus !== "ACTIVE")
    issues.push("Cửa hàng chưa ở trạng thái hoạt động (xem store_status).")
  return {
    store_id: String(raw.store_id ?? ""),
    store_name: str(raw.store_name),
    store_code: str(raw.store_code),
    store_status: storeStatus,
    store_role: role,
    targeting_region_codes: Array.isArray(raw.targeting_region_codes)
      ? raw.targeting_region_codes.map(String)
      : [],
    is_gmv_max_available: available,
    is_owner_bc: bool(raw.is_owner_bc),
    business_center: {
      bc_id: str(bc.bc_id) ?? str(raw.store_authorized_bc_id),
      bc_name: str(bc.bc_name),
      user_role: userRole,
    },
    // another ad account (not granted to this MCP): id + status only, never its name
    gmv_max_ad_account: ex
      ? {
          advertiser_id: exId,
          advertiser_name: authorized ? str(ex.advertiser_name) : null,
          advertiser_status: exStatus,
        }
      : null,
    authorized_for_this_account: authorized,
    ready: available && authorized,
    issues,
  }
}

export const gmvMaxShopsInput = z.object({})

export async function runGmvMaxShops(
  ctx: ProviderContext<TikTokCredentials>
): Promise<Raw> {
  const tt = ttFromCtx(ctx)
  // one row per store (TikTok lists a store once per Business Center with access): the row usable by this account
  const shops = uniqueGmvMaxStoreRows(
    await fetchGmvMaxStoresRaw(tt, tt.advertiserId),
    tt.advertiserId
  ).map((s) => mapGmvMaxShop(s, tt.advertiserId))
  const ready = shops.filter((s) => s.ready).length
  const warnings: string[] = []
  if (!shops.length) {
    warnings.push(
      'Tài khoản quảng cáo không truy cập được cửa hàng TikTok Shop nào. Cần: cửa hàng nằm trong cùng Business Center, người dùng là Admin BC, cửa hàng được gán quyền "Quảng bá quảng cáo" (AD_PROMOTION), tài khoản QC có vai trò Admin/Operator.'
    )
  } else if (!ready) {
    warnings.push(
      "Chưa có cửa hàng nào sẵn sàng GMV Max cho tài khoản này - xem issues của từng cửa hàng."
    )
  }
  return {
    advertiser_id: tt.advertiserId,
    shops,
    summary: { total: shops.length, ready_for_this_account: ready },
    warnings,
    caution: GMV_MAX_CAUTION,
  }
}

// ---------------------------------------------------------------------------
// Campaigns: /gmv_max/campaign/get/ + /campaign/gmv_max/info/
// ---------------------------------------------------------------------------

/** GMV Max campaign secondary statuses (doc 1757239620352002) → Vietnamese explanation. */
export const GMV_MAX_SECONDARY_STATUS_VI: Record<string, string> = {
  CAMPAIGN_STATUS_ENABLE: "Đang bật.",
  CAMPAIGN_STATUS_DISABLE: "Đã tắt.",
  CAMPAIGN_STATUS_DELETE: "Đã xoá.",
  CAMPAIGN_STATUS_TTS_TT_ASSET_UNAVAILABLE:
    "Không phân phối: tài sản không khả dụng.",
  CAMPAIGN_STATUS_TTS_TT_IDENTITY_UNAVAILABLE:
    "Không phân phối: tài khoản TikTok không khả dụng.",
  CAMPAIGN_STATUS_TIKTOK_SHOP_UNAVAILABLE:
    "Không phân phối: cửa hàng TikTok Shop không khả dụng.",
  CAMPAIGN_STATUS_REVIEW_DISAPPROVED: "Không phân phối: không được duyệt.",
  CAMPAIGN_STATUS_AD_UNAVAILABLE:
    "Không phân phối: không có quảng cáo khả dụng.",
  CAMPAIGN_STATUS_PRODUCT_UNAVAILABLE:
    "Không phân phối: sản phẩm không khả dụng.",
  CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY:
    "Không phân phối: tài khoản QC không được duyệt.",
  CAMPAIGN_STATUS_ADVERTISER_AUDIT:
    "Không phân phối: tài khoản QC đang được xét duyệt.",
  ADVERTISER_CONTRACT_PENDING:
    "Không phân phối: hợp đồng tài khoản QC chưa có hiệu lực.",
  ADVERTISER_ACCOUNT_PUNISH: "Không phân phối: tài khoản QC bị phạt/hạn chế.",
  CAMPAIGN_STATUS_BUDGET_EXCEED:
    "Không phân phối: chiến dịch đã hết ngân sách.",
  CAMPAIGN_STATUS_IDENTITY_USED_BY_GMV_MAX_AD:
    "Không phân phối: tài khoản TikTok đang được quảng cáo GMV Max khác dùng.",
  CAMPAIGN_STATUS_TTS_ACCOUNT_BALANCE_INSUFFICIENT:
    "Không phân phối: số dư tài khoản không đủ.",
  CAMPAIGN_STATUS_LIVE_GMV_MAX_AUTHORIZATION_CANCEL:
    "Tạm dừng: tài khoản TikTok chính thức đã cấp quyền GMV Max cho tài khoản QC khác.",
  CAMPAIGN_STATUS_PRODUCT_GMV_MAX_AUTHORIZATION_CANCEL:
    "Tạm dừng: cửa hàng đã cấp quyền GMV Max cho tài khoản QC khác.",
  CAMPAIGN_STATUS_IDENTITY_USED_BY_LIVE_GMV_MAX:
    "Tạm dừng: tài khoản TikTok đang được một chiến dịch LIVE GMV Max khác dùng.",
  CAMPAIGN_STATUS_PRODUCT_USED_BY_PRODUCT_GMV_MAX:
    "Tạm dừng: đang có chiến dịch Product GMV Max khác của cửa hàng này chạy.",
  CAMPAIGN_STATUS_AWAITING_RELEASE: "Đang chờ phát hành.",
}

/**
 * GMV Max secondary status → primary status group (doc 1757239620352002 "For GMV Max Campaigns") and our normalized
 * status. The not-delivering group is never "active" even when operation_status is ENABLE.
 */
const GMV_MAX_STATUS_GROUP: Record<
  string,
  { primary: string; status: NormalizedStatus }
> = {
  CAMPAIGN_STATUS_ENABLE: { primary: "STATUS_DELIVERY_OK", status: "active" },
  CAMPAIGN_STATUS_DELETE: { primary: "STATUS_DELETE", status: "deleted" },
  // STATUS_DISABLE (Inactive)
  CAMPAIGN_STATUS_DISABLE: { primary: "STATUS_DISABLE", status: "paused" },
  CAMPAIGN_STATUS_LIVE_GMV_MAX_AUTHORIZATION_CANCEL: {
    primary: "STATUS_DISABLE",
    status: "paused",
  },
  CAMPAIGN_STATUS_PRODUCT_GMV_MAX_AUTHORIZATION_CANCEL: {
    primary: "STATUS_DISABLE",
    status: "paused",
  },
  CAMPAIGN_STATUS_IDENTITY_USED_BY_LIVE_GMV_MAX: {
    primary: "STATUS_DISABLE",
    status: "paused",
  },
  CAMPAIGN_STATUS_PRODUCT_USED_BY_PRODUCT_GMV_MAX: {
    primary: "STATUS_DISABLE",
    status: "paused",
  },
  CAMPAIGN_STATUS_AWAITING_RELEASE: {
    primary: "STATUS_DISABLE",
    status: "paused",
  },
  // STATUS_NOT_DELIVERY (Not delivering)
  CAMPAIGN_STATUS_REVIEW_DISAPPROVED: {
    primary: "STATUS_NOT_DELIVERY",
    status: "rejected",
  },
  CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY: {
    primary: "STATUS_NOT_DELIVERY",
    status: "rejected",
  },
  CAMPAIGN_STATUS_ADVERTISER_AUDIT: {
    primary: "STATUS_NOT_DELIVERY",
    status: "pending_review",
  },
  CAMPAIGN_STATUS_TTS_TT_ASSET_UNAVAILABLE: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_TTS_TT_IDENTITY_UNAVAILABLE: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_TIKTOK_SHOP_UNAVAILABLE: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_AD_UNAVAILABLE: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_PRODUCT_UNAVAILABLE: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  ADVERTISER_CONTRACT_PENDING: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  ADVERTISER_ACCOUNT_PUNISH: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_BUDGET_EXCEED: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_IDENTITY_USED_BY_GMV_MAX_AD: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
  CAMPAIGN_STATUS_TTS_ACCOUNT_BALANCE_INSUFFICIENT: {
    primary: "STATUS_NOT_DELIVERY",
    status: "disabled",
  },
}

/** Normalized status of a GMV Max campaign row (+ the documented primary status group, null when unknown). */
export function gmvMaxStatus(
  operationStatus: unknown,
  secondaryStatus: unknown
): { status: NormalizedStatus; primary_status: string | null } {
  const sec = typeof secondaryStatus === "string" ? secondaryStatus : ""
  const known = GMV_MAX_STATUS_GROUP[sec]
  if (known) return { status: known.status, primary_status: known.primary }
  const status = normalizeStatus(operationStatus, secondaryStatus)
  // an undocumented secondary status next to ENABLE: do not claim the campaign is delivering
  if (status === "active" && sec && !/_ENABLE$|DELIVERY_OK$/.test(sec))
    return { status: "unknown", primary_status: null }
  return { status, primary_status: null }
}

const ROI_PROTECTION_VI: Record<string, string> = {
  IN_EFFECT:
    "Đủ điều kiện Bảo vệ ROI hôm nay (giữ nguyên ROI, không tạm dừng, không bật Max delivery để giữ điều kiện).",
  NOT_ELIGIBLE:
    "Không đủ điều kiện Bảo vệ ROI hôm nay (đã sửa ROI, tạm dừng, bật Max delivery hoặc có vấn đề cửa hàng/tài khoản/sản phẩm).",
}

export interface GmvMaxCampaignPage {
  list: Raw[]
  total: number
  truncated: boolean
}

/** All GMV Max campaigns of one type (page_size 100, up to `max`). `extra` = additional filtering keys. */
export async function listGmvMaxCampaignsRaw(
  tt: TTRead,
  type: GmvMaxType,
  extra: Raw,
  max: number
): Promise<GmvMaxCampaignPage> {
  const out: Raw[] = []
  let total = 0
  for (let page = 1; page <= 100; page++) {
    const res = await ttGet<{ list?: Raw[]; page_info?: PageInfo }>(
      tt,
      "gmv_max/campaign/get",
      {
        advertiser_id: tt.advertiserId,
        filtering: {
          ...extra,
          gmv_max_promotion_types: [GMV_MAX_PROMOTION_TYPE[type]],
        },
        page,
        page_size: CAMPAIGN_PAGE_SIZE,
      }
    )
    const list = Array.isArray(res.data.list) ? res.data.list : []
    out.push(...list)
    total = Number(res.data.page_info?.total_number ?? out.length) || out.length
    const totalPage = Number(res.data.page_info?.total_page ?? 0)
    if (out.length >= max || list.length === 0 || page >= totalPage) break
  }
  return {
    list: out.slice(0, max),
    total: Math.max(total, out.length),
    truncated: out.length > max || total > max,
  }
}

/**
 * Which of `ids` are GMV Max campaigns (checked against /gmv_max/campaign/get/ for both promotion types,
 * ≤100 ids per call). Throws on API failure - callers decide (fail closed for writes, silent for listings).
 */
export async function fetchGmvMaxTypes(
  tt: TTRead,
  ids: string[]
): Promise<Map<string, GmvMaxType>> {
  const out = new Map<string, GmvMaxType>()
  const unique = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id))
  for (const type of GMV_MAX_TYPES) {
    for (const batch of chunk(
      unique.filter((id) => !out.has(id)),
      100
    )) {
      const { list } = await listGmvMaxCampaignsRaw(
        tt,
        type,
        { campaign_ids: batch },
        batch.length
      )
      for (const c of list) {
        const id = str(c.campaign_id)
        if (id && batch.includes(id)) out.set(id, type)
      }
    }
  }
  if (out.size) rememberGmvMaxPresence(tt, true)
  return out
}

export function mapGmvMaxCampaign(raw: Raw, type: GmvMaxType): Raw {
  const sec = str(raw.secondary_status)
  const roi = str(raw.roi_protection_compensation_status)
  const st = gmvMaxStatus(raw.operation_status, raw.secondary_status)
  return {
    campaign_id: String(raw.campaign_id ?? ""),
    campaign_name: str(raw.campaign_name),
    type,
    status: st.status,
    primary_status: st.primary_status,
    status_raw: statusRaw(raw),
    status_note: sec ? (GMV_MAX_SECONDARY_STATUS_VI[sec] ?? null) : null,
    operation_status: str(raw.operation_status),
    created_time: tiktokTimeToIso(raw.create_time),
    modified_time: tiktokTimeToIso(raw.modify_time),
    roi_protection_compensation_status: roi,
    roi_protection_note: roi ? (ROI_PROTECTION_VI[roi] ?? null) : null,
  }
}

function budgetBoost(b: Raw, currency: string) {
  return {
    budget_increase_percentage: num(b.budget_increase_percentage),
    increase_limit: num(b.increase_limit),
    remained_times: num(b.remained_times),
    next_increase: moneyOf(b.next_increase, currency),
    maximum_budget: moneyOf(b.maximum_budget, currency),
  }
}

/** Documented worst case of the API auto budget: +300 % per increase × 10 increases → 31 × the daily budget. */
export const GMV_MAX_MAX_BOOST_FACTOR = 31
/** Legacy auto_budget_enabled (to be deprecated): "may automatically increase by up to 10 times". */
export const GMV_MAX_LEGACY_BOOST_FACTOR = 10

export interface GmvMaxDailySpend {
  /** configured daily budget (major units), null when not returned */
  daily_budget: number | null
  /** worst-case spend of ONE day (major units), null when no budget is known */
  max_possible_daily_spend: number | null
  notes: string[]
}

/**
 * Worst-case daily spend of a GMV Max campaign from /campaign/gmv_max/info/ (doc 1822000968821762):
 * max of the daily budget, each ENABLED boost (auto_budget / promotion_days: its maximum_budget and
 * budget × (1 + budget_increase_percentage % × increase_limit) - a boost without either → 31 × budget), and the legacy
 * auto_budget_enabled flag (budget × 10). Max delivery / Creative boost sessions spend on top (noted, not included).
 */
export function gmvMaxWorstCaseDaily(
  raw: Raw,
  currency: string
): GmvMaxDailySpend {
  const daily = moneyOf(raw.budget, currency)
  const candidates: number[] = []
  const notes: string[] = []
  const times = (factor: number) => roundMoney((daily ?? 0) * factor, currency)
  if (daily !== null) candidates.push(daily)
  const boost = (b: Raw | undefined, enabled: boolean) => {
    if (!b || !enabled) return
    let known = false
    const max = moneyOf(b.maximum_budget, currency)
    if (max !== null && max > 0) {
      candidates.push(max)
      known = true
    }
    const pct = num(b.budget_increase_percentage)
    const limit = num(b.increase_limit)
    if (
      daily !== null &&
      pct !== null &&
      limit !== null &&
      pct >= 0 &&
      limit >= 0
    ) {
      candidates.push(
        roundMoney((daily * (100 + pct * limit)) / 100, currency)!
      )
      known = true
    }
    if (!known && daily !== null) {
      candidates.push(times(GMV_MAX_MAX_BOOST_FACTOR)!)
      if (!notes.includes(GMV_MAX_BOOST_FALLBACK_NOTE))
        notes.push(GMV_MAX_BOOST_FALLBACK_NOTE)
    }
  }
  const autoRaw = raw.auto_budget as Raw | undefined
  const promoRaw = raw.promotion_days as Raw | undefined
  boost(autoRaw, autoRaw?.auto_budget_enabled === true)
  boost(promoRaw, promoRaw?.is_enabled === true)
  if (raw.auto_budget_enabled === true && daily !== null) {
    candidates.push(times(GMV_MAX_LEGACY_BOOST_FACTOR)!)
    notes.push(GMV_MAX_LEGACY_AUTO_BUDGET_NOTE)
  }
  notes.push(GMV_MAX_SESSIONS_NOT_INCLUDED)
  return {
    daily_budget: daily,
    max_possible_daily_spend: candidates.length
      ? roundMoney(Math.max(...candidates), currency)
      : null,
    notes,
  }
}

/** /campaign/gmv_max/info/ data → safe details (money in major units of the account currency, no media URLs). */
export function mapGmvMaxInfo(
  raw: Raw,
  currency: string,
  timezone: string
): Raw {
  const autoRaw = raw.auto_budget as Raw | undefined
  const promoRaw = raw.promotion_days as Raw | undefined
  const autoEnabled = autoRaw?.auto_budget_enabled === true
  const promoEnabled = promoRaw?.is_enabled === true
  const auto = autoRaw
    ? { enabled: autoEnabled, ...budgetBoost(autoRaw, currency) }
    : null
  const promo = promoRaw
    ? {
        is_enabled: promoEnabled,
        auto_schedule_enabled: bool(promoRaw.auto_schedule_enabled),
        custom_schedule_list: Array.isArray(promoRaw.custom_schedule_list)
          ? (promoRaw.custom_schedule_list as Raw[]).map((s) => ({
              start_date: str(s.start_time),
              end_date: str(s.end_time),
            }))
          : [],
        roas_bid_multiplier: num(promoRaw.roas_bid_multiplier),
        adjusted_target_roi: num(promoRaw.adjusted_roas_bid),
        estimated_gross_revenue_increase: str(
          promoRaw.estimated_gross_revenue_increase
        ),
        ...budgetBoost(promoRaw, currency),
      }
    : null
  // worst-case spend of one day (Max delivery / Creative boost session budgets come on top and are not included)
  const worst = gmvMaxWorstCaseDaily(raw, currency)
  const legacyAuto = bool(raw.auto_budget_enabled)
  const itemGroups = Array.isArray(raw.item_group_ids)
    ? raw.item_group_ids.map(String)
    : []
  const items = Array.isArray(raw.item_list)
    ? (raw.item_list as unknown[]).filter(
        (i): i is Raw => !!i && typeof i === "object"
      )
    : []
  const anchors = Array.isArray(raw.custom_anchor_video_list)
    ? raw.custom_anchor_video_list
    : []
  return {
    store_id: str(raw.store_id),
    store_authorized_bc_id: str(raw.store_authorized_bc_id),
    shopping_ads_type: str(raw.shopping_ads_type),
    product_specific_type: str(raw.product_specific_type),
    item_group_count: itemGroups.length,
    item_group_ids: itemGroups.slice(0, 50),
    optimization_goal: str(raw.optimization_goal),
    deep_bid_type: str(raw.deep_bid_type),
    target_roi: num(raw.roas_bid),
    currency,
    daily_budget: worst.daily_budget,
    auto_budget: auto,
    legacy_auto_budget_enabled: legacyAuto,
    promotion_days: promo,
    max_possible_daily_spend: worst.max_possible_daily_spend,
    max_possible_daily_spend_notes: worst.notes,
    schedule: {
      type: str(raw.schedule_type),
      start_time_utc: tiktokTimeToIso(raw.schedule_start_time),
      end_time_utc:
        raw.schedule_type === "SCHEDULE_FROM_NOW"
          ? null
          : tiktokTimeToIso(raw.schedule_end_time),
      start_time_account_tz: utcToAccountLocal(
        raw.schedule_start_time,
        timezone
      ),
      end_time_account_tz:
        raw.schedule_type === "SCHEDULE_FROM_NOW"
          ? null
          : utcToAccountLocal(raw.schedule_end_time, timezone),
    },
    roi_protection_enabled: bool(raw.roi_protection_enabled),
    placements: Array.isArray(raw.placements) ? raw.placements.map(String) : [],
    location_ids: Array.isArray(raw.location_ids)
      ? raw.location_ids.map(String)
      : [],
    age_groups: Array.isArray(raw.age_groups) ? raw.age_groups.map(String) : [],
    product_video_specific_type: str(raw.product_video_specific_type),
    affiliate_posts_enabled: bool(raw.affiliate_posts_enabled),
    accelerate_testing_for_new_videos: str(
      raw.accelerate_testing_for_new_videos
    ),
    identities: Array.isArray(raw.identity_list)
      ? (raw.identity_list as unknown[])
          .filter((i): i is Raw => !!i && typeof i === "object")
          .slice(0, 20)
          .map(mapGmvMaxIdentity)
      : [],
    post_count: items.length,
    posts: items.slice(0, 20).map((it) => {
      const identity = objectOf(it.identity_info)
      const video = objectOf(it.video_info)
      return {
        item_id: scalar(it.item_id),
        text: scalar(it.text)?.slice(0, 120) ?? null,
        spu_ids: Array.isArray(it.spu_id_list)
          ? it.spu_id_list.map(scalar).filter((v): v is string => !!v)
          : [],
        identity_id: scalar(identity.identity_id),
        identity_type: scalar(identity.identity_type),
        user_name: scalar(identity.user_name),
        video_id: scalar(video.video_id),
      }
    }),
    custom_post_count: anchors.length,
  }
}

export async function fetchGmvMaxInfo(
  tt: TTRead,
  campaignId: string
): Promise<Raw> {
  const res = await ttGet<Raw>(tt, "campaign/gmv_max/info", {
    advertiser_id: tt.advertiserId,
    campaign_id: campaignId,
  })
  return res.data
}

const CAMPAIGN_STATUS_FILTER: Record<string, string> = {
  active: "STATUS_DELIVERY_OK",
  paused: "STATUS_DISABLE",
  deleted: "STATUS_DELETE",
}

export const gmvMaxCampaignsInput = z.object({
  type: z
    .enum(["PRODUCT", "LIVE"])
    .optional()
    .describe(
      "PRODUCT = GMV Max sản phẩm, LIVE = GMV Max LIVE; bỏ trống = cả hai"
    ),
  store_id: numericId
    .optional()
    .describe("Id cửa hàng TikTok Shop (lấy bằng tiktok_gmv_max_shops)"),
  campaign_ids: z.array(numericId).min(1).max(100).optional(),
  status: z
    .enum(["active", "paused", "deleted"])
    .optional()
    .describe("Bỏ trống = mặc định của TikTok (không gồm đã xoá)"),
  name_contains: z.string().trim().min(1).max(200).optional(),
  include_details: z
    .boolean()
    .default(false)
    .describe(
      `Lấy thêm ngân sách ngày, ROI mục tiêu, tăng ngân sách tự động, lịch chạy… (1 lần gọi/chiến dịch, tối đa ${GMV_MAX_MAX_DETAILS} chiến dịch)`
    ),
  limit: z.number().int().min(1).max(500).default(100),
})
export type GmvMaxCampaignsInput = z.infer<typeof gmvMaxCampaignsInput>

export async function runGmvMaxCampaigns(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxCampaignsInput
): Promise<Raw> {
  const tt = ttFromCtx(ctx)
  const types = input.type ? [input.type] : [...GMV_MAX_TYPES]
  const extra: Raw = {}
  if (input.store_id) extra.store_ids = [input.store_id]
  if (input.campaign_ids?.length) extra.campaign_ids = input.campaign_ids
  if (input.status) extra.primary_status = CAMPAIGN_STATUS_FILTER[input.status]
  // documented filter (doc 1826463372290177); the local substring filter below stays as a safety net
  if (input.name_contains) extra.campaign_name = input.name_contains
  const warnings: string[] = []
  const campaigns: Raw[] = []
  let truncated = false
  let firstError: unknown = null
  let failed = 0
  for (const type of types) {
    try {
      const page = await listGmvMaxCampaignsRaw(tt, type, extra, input.limit)
      if (page.truncated) truncated = true
      campaigns.push(...page.list.map((c) => mapGmvMaxCampaign(c, type)))
    } catch (e) {
      if (!isProviderError(e)) throw e
      failed++
      firstError ??= e
      warnings.push(
        `Không lấy được chiến dịch GMV Max loại ${type}: ${gmvMaxErrorText(e)}`
      )
    }
  }
  if (failed === types.length && firstError) throw firstError
  let list = campaigns
  const needle = input.name_contains?.toLowerCase()
  if (needle)
    list = list.filter((c) =>
      String(c.campaign_name ?? "")
        .toLowerCase()
        .includes(needle)
    )
  if (list.length > input.limit) {
    truncated = true
    list = list.slice(0, input.limit)
  }
  if (list.length) rememberGmvMaxPresence(tt, true)
  if (truncated)
    warnings.push(
      `Kết quả bị giới hạn ${input.limit} chiến dịch - lọc theo store_id/type/status để xem phần còn lại.`
    )
  if (input.include_details) {
    const targets = list.slice(0, GMV_MAX_MAX_DETAILS)
    if (list.length > GMV_MAX_MAX_DETAILS) {
      warnings.push(
        `Chỉ lấy chi tiết cho ${GMV_MAX_MAX_DETAILS} chiến dịch đầu tiên (mỗi chiến dịch 1 lần gọi API) - lọc campaign_ids để xem chiến dịch khác.`
      )
    }
    for (const c of targets) {
      try {
        c.details = mapGmvMaxInfo(
          await fetchGmvMaxInfo(tt, String(c.campaign_id)),
          tt.currency,
          tt.timezone
        )
      } catch (e) {
        if (!isProviderError(e)) throw e
        c.details_error = gmvMaxErrorText(e)
      }
    }
  }
  if (!list.length) {
    warnings.push(
      "Không có chiến dịch GMV Max nào khớp bộ lọc (hoặc token chưa có quyền GMV Max / tài khoản chưa là tài khoản GMV Max của cửa hàng)."
    )
    if (needle)
      warnings.push(
        "TikTok có thể so tên chiến dịch chính xác (chưa xác minh) - thử tên đầy đủ hoặc bỏ name_contains rồi tự lọc."
      )
  }
  return {
    advertiser_id: tt.advertiserId,
    currency: tt.currency,
    timezone: tt.timezone,
    campaigns: list,
    count: list.length,
    truncated,
    warnings,
    notes: [
      "Thời gian tạo/sửa là UTC (ISO). Tiền theo đơn vị chính của tiền tệ tài khoản.",
      "Xem chỉ số bằng tiktok_gmv_max_report (chi tiêu GMV Max có thể không nằm đầy đủ trong ads_get_report - không cộng hai báo cáo).",
    ],
    caution: GMV_MAX_CAUTION,
  }
}

// ---------------------------------------------------------------------------
// Report: /gmv_max/report/get/
// ---------------------------------------------------------------------------

export const GMV_MAX_REPORT_LEVELS = [
  "account",
  "campaign",
  "product",
  "creative",
  "live_room",
] as const
export type GmvMaxReportLevel = (typeof GMV_MAX_REPORT_LEVELS)[number]

/** Money metrics (ad account currency, major units) → rounded to the currency precision. */
export const GMV_MAX_MONEY_METRICS = new Set([
  "cost",
  "net_cost",
  "cost_per_order",
  "gross_revenue",
  "target_roi_budget",
  "max_delivery_budget",
  "all_shops_cost_per_order",
  "all_shops_gross_revenue",
  "cost_per_live_view",
  "cost_per_10_second_live_view",
])
/** Text attributes (everything else numeric). */
const TEXT_METRICS = new Set([
  "campaign_id",
  "campaign_name",
  "operation_status",
  "bid_type",
  "schedule_type",
  "schedule_start_time",
  "schedule_end_time",
  "tt_account_name",
  "identity_id",
  "product_name",
  "item_group_id",
  "product_status",
  "creative_delivery_status",
  "live_name",
  "live_status",
  "live_launched_time",
  "live_duration",
])
const UTC_TIME_METRICS = new Set(["schedule_start_time", "schedule_end_time"])
/** Text attributes where TikTok sends "0" / "-1" for "none". */
const PLACEHOLDER_METRICS = new Set(["tt_account_name", "identity_id"])

const CORE = [
  "cost",
  "net_cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
]
const LIVE_EXTRA = [
  "all_shops_orders",
  "all_shops_gross_revenue",
  "all_shops_roi",
  "all_shops_cost_per_order",
  "live_views",
  "cost_per_live_view",
  "10_second_live_views",
  "cost_per_10_second_live_view",
  "live_follows",
]
const CAMPAIGN_ATTRS = [
  "campaign_name",
  "operation_status",
  "bid_type",
  "roas_bid",
  "target_roi_budget",
  "max_delivery_budget",
  "schedule_type",
  "schedule_start_time",
  "schedule_end_time",
]
const CREATIVE_METRICS = [
  "creative_delivery_status",
  "cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
  "product_impressions",
  "product_clicks",
  "product_click_rate",
  "ad_click_rate",
  "ad_conversion_rate",
  "ad_video_view_rate_2s",
  "ad_video_view_rate_6s",
  "ad_video_view_rate_p25",
  "ad_video_view_rate_p50",
  "ad_video_view_rate_p75",
  "ad_video_view_rate_p100",
]

export const gmvMaxReportInput = z.object({
  level: z
    .enum(GMV_MAX_REPORT_LEVELS)
    .default("account")
    .describe(
      "account = tổng GMV Max của cửa hàng; campaign; product (SPU, chỉ PRODUCT); creative (bài đăng, chỉ PRODUCT); live_room (phiên LIVE, chỉ LIVE)"
    ),
  type: z
    .enum(["PRODUCT", "LIVE"])
    .optional()
    .describe("Bắt buộc trừ level=account (bỏ trống ở account = cả hai loại)"),
  store_id: numericId
    .optional()
    .describe(
      `Id cửa hàng; bỏ trống = mọi cửa hàng tài khoản truy cập được (tối đa ${GMV_MAX_MAX_SHOPS}, ưu tiên cửa hàng đã cấp quyền GMV Max cho tài khoản này)`
    ),
  date_preset: z
    .enum(DATE_PRESETS)
    .optional()
    .describe("Thay cho date_from/date_to; mặc định last_7d"),
  date_from: isoDate
    .optional()
    .describe("YYYY-MM-DD theo múi giờ tài khoản QC"),
  date_to: isoDate.optional(),
  breakdown: z
    .enum(["none", "day"])
    .default("none")
    .describe("day = theo ngày (tự chia đoạn ≤30 ngày)"),
  campaign_ids: z
    .array(numericId)
    .min(1)
    .max(100)
    .optional()
    .describe("Bắt buộc với product/creative/live_room; tuỳ chọn với campaign"),
  item_group_ids: z
    .array(numericId)
    .min(1)
    .max(100)
    .optional()
    .describe("Id sản phẩm (SPU) - bắt buộc với creative"),
  include_deleted: z
    .boolean()
    .default(true)
    .describe("Cấp campaign: gồm cả chiến dịch đã xoá (đủ chi tiêu)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(200)
    .describe("Số dòng tối đa"),
})
export type GmvMaxReportInput = z.infer<typeof gmvMaxReportInput>

export interface GmvMaxReportPlan {
  level: GmvMaxReportLevel
  type: GmvMaxType | null
  range: DateRange
  windows: DateRange[]
  /** id dimensions (without stat_time_day) */
  idDims: string[]
  dimensions: string[]
  metrics: string[]
  filtering: Raw | null
  sortField: string | null
  warnings: string[]
}

function resolveRange(
  input: GmvMaxReportInput,
  timezone: string,
  now: Date,
  warnings: string[]
): DateRange {
  let range: DateRange
  if (input.date_from || input.date_to) {
    if (!input.date_from || !input.date_to)
      throw invalid("Cần cả date_from và date_to (YYYY-MM-DD).")
    if (input.date_preset)
      warnings.push("Đã dùng date_from/date_to (bỏ qua date_preset).")
    range = { from: input.date_from, to: input.date_to }
  } else {
    range = resolvePreset(input.date_preset ?? "last_7d", timezone, now)
    if (!input.date_preset)
      warnings.push(
        `Không truyền khoảng ngày - dùng 7 ngày gần nhất (${range.from} → ${range.to}).`
      )
  }
  try {
    return assertRange(range)
  } catch (e) {
    if (e instanceof RangeError)
      throw invalid(
        e.message,
        "Dùng ngày dạng YYYY-MM-DD, date_from ≤ date_to."
      )
    throw e
  }
}

/** Validate the request against the official dimension groupings / required filters (research §5) and plan the calls. */
export function planGmvMaxReport(
  input: GmvMaxReportInput,
  timezone: string,
  now: Date = new Date()
): GmvMaxReportPlan {
  const warnings: string[] = []
  const level = input.level
  const type = (input.type ?? null) as GmvMaxType | null
  const campaignIds = input.campaign_ids ?? []
  const itemGroupIds = input.item_group_ids ?? []

  if (level !== "account" && !type)
    throw invalid(`Báo cáo GMV Max cấp ${level} cần type PRODUCT hoặc LIVE.`)
  if ((level === "product" || level === "creative") && type !== "PRODUCT") {
    throw invalid(
      `Cấp ${level} chỉ có ở GMV Max sản phẩm (type=PRODUCT).`,
      "Với LIVE dùng level=live_room."
    )
  }
  if (level === "live_room" && type !== "LIVE")
    throw invalid("Cấp live_room chỉ có ở GMV Max LIVE (type=LIVE).")
  if (
    (level === "product" || level === "creative" || level === "live_room") &&
    !campaignIds.length
  ) {
    throw invalid(
      `Cấp ${level} cần campaign_ids (1-100 id).`,
      "Lấy id bằng tiktok_gmv_max_campaigns hoặc báo cáo level=campaign."
    )
  }
  if (level === "creative" && !itemGroupIds.length) {
    throw invalid(
      "Cấp creative cần item_group_ids (id sản phẩm SPU, 1-100 id).",
      "Lấy id bằng báo cáo level=product."
    )
  }
  if (level === "account" && campaignIds.length)
    warnings.push(
      "Cấp account không lọc theo chiến dịch - đã bỏ qua campaign_ids."
    )
  if (level !== "creative" && itemGroupIds.length)
    warnings.push(
      `Cấp ${level} không lọc theo sản phẩm - đã bỏ qua item_group_ids.`
    )

  const range = resolveRange(input, timezone, now, warnings)
  const days = daysBetweenInclusive(range)
  if (days > GMV_MAX_TOTAL_MAX_DAYS) {
    throw invalid(
      `Báo cáo GMV Max tối đa ${GMV_MAX_TOTAL_MAX_DAYS} ngày mỗi lần.`,
      "Thu hẹp khoảng ngày."
    )
  }
  const day = input.breakdown === "day"
  const windows: DateRange[] = day
    ? splitRange(range, GMV_MAX_DAY_WINDOW)
    : [range]
  if (range.from < GMV_MAX_DATA_START) {
    warnings.push(
      `Dữ liệu GMV Max chỉ có từ ${GMV_MAX_DATA_START} (riêng net_cost từ 2023-09-01) - các ngày trước đó sẽ trống.`
    )
  }

  // dimensions + metrics per level (official groupings; attribute metrics only with ONE campaign id + ONE id dimension)
  let idDims: string[]
  let metrics: string[]
  let filtering: Raw | null = null
  const single = campaignIds.length === 1
  switch (level) {
    case "account":
      idDims = ["advertiser_id"]
      metrics = [...CORE]
      if (type) filtering = { gmv_max_promotion_types: [type] }
      // TikTok: "by default, the response only includes undeleted campaigns"; no campaign_statuses at this level
      warnings.push(GMV_MAX_ACCOUNT_LEVEL_DELETED_NOTE)
      break
    case "campaign":
      idDims = ["campaign_id"]
      metrics = [
        ...CAMPAIGN_ATTRS,
        ...(type === "LIVE" ? ["tt_account_name", "identity_id"] : []),
        ...CORE,
        ...(type === "LIVE" ? LIVE_EXTRA : []),
      ]
      filtering = { gmv_max_promotion_types: [type] }
      if (campaignIds.length) filtering.campaign_ids = campaignIds
      if (input.include_deleted) filtering.campaign_statuses = ["STATUS_ALL"]
      else
        warnings.push(
          "Không gồm chiến dịch đã xoá (include_deleted=false) - tổng chi tiêu có thể thiếu phần của chiến dịch đã xoá; đặt include_deleted=true để có tổng đầy đủ."
        )
      break
    case "product":
      idDims = single ? ["item_group_id"] : ["campaign_id", "item_group_id"]
      metrics = [
        ...(single ? ["product_name", "product_status", "bid_type"] : []),
        "cost",
        "orders",
        "cost_per_order",
        "gross_revenue",
        "roi",
      ]
      filtering = { campaign_ids: campaignIds }
      if (!single)
        warnings.push(
          "Nhiều chiến dịch: TikTok không trả tên/trạng thái sản phẩm (chỉ id) - lọc 1 campaign_id để có tên sản phẩm."
        )
      break
    case "creative":
      idDims = ["campaign_id", "item_group_id", "item_id"]
      metrics = [...CREATIVE_METRICS]
      filtering = { campaign_ids: campaignIds, item_group_ids: itemGroupIds }
      if (day)
        warnings.push("Creative theo ngày: TikTok chỉ trả các dòng có chi phí.")
      warnings.push("item_id = -1 là thẻ sản phẩm (không có bài đăng).")
      break
    case "live_room":
      idDims = single ? ["room_id"] : ["campaign_id", "room_id"]
      metrics = [
        ...(single
          ? ["live_name", "live_status", "live_launched_time", "live_duration"]
          : []),
        ...CORE,
        ...LIVE_EXTRA,
      ]
      filtering = { campaign_ids: campaignIds }
      if (!single)
        warnings.push(
          "Nhiều chiến dịch: TikTok không trả tên/trạng thái phiên LIVE (chỉ id) - lọc 1 campaign_id để có tên."
        )
      else
        warnings.push(
          "live_launched_time là giờ theo múi giờ tài khoản QC (không phải UTC)."
        )
      break
  }
  return {
    level,
    type,
    range,
    windows,
    idDims,
    dimensions: day ? [...idDims, "stat_time_day"] : [...idDims],
    metrics,
    filtering,
    sortField: !day && level !== "account" ? "cost" : null,
    warnings,
  }
}

/** One report metric value → number (money rounded to the currency) / text. Never NaN. */
export function parseGmvMaxMetric(
  key: string,
  value: unknown,
  currency: string
): number | string | null {
  if (TEXT_METRICS.has(key)) {
    if (UTC_TIME_METRICS.has(key)) return tiktokTimeToIso(value) ?? str(value)
    const s = str(value)
    // LIVE: no TikTok account → placeholder "0" / "-1"
    if (PLACEHOLDER_METRICS.has(key) && (s === "0" || s === "-1")) return null
    return s
  }
  if (GMV_MAX_MONEY_METRICS.has(key)) return moneyOf(value, currency)
  return num(value)
}

export function mapGmvMaxReportRow(
  item: Raw,
  plan: GmvMaxReportPlan,
  currency: string,
  storeId: string
): Raw {
  const dims = (item.dimensions as Raw | undefined) ?? {}
  const m = (item.metrics as Raw | undefined) ?? {}
  const row: Raw = { store_id: storeId }
  const day = str(dims.stat_time_day)
  if (day) row.date = day.slice(0, 10)
  for (const d of plan.idDims) row[d] = str(dims[d])
  for (const k of plan.metrics) {
    if (k in m) row[k] = parseGmvMaxMetric(k, m[k], currency)
  }
  return row
}

const SUM_KEYS = [
  "cost",
  "net_cost",
  "gross_revenue",
  "orders",
  "all_shops_orders",
  "all_shops_gross_revenue",
]

/** Totals of additive metrics (account / campaign levels only - other levels may overlap). */
export function gmvMaxTotals(rows: Raw[], currency: string): Raw {
  const sums: Record<string, number> = {}
  for (const r of rows) {
    for (const k of SUM_KEYS) {
      const v = r[k]
      if (typeof v === "number" && Number.isFinite(v))
        sums[k] = (sums[k] ?? 0) + v
    }
  }
  const out: Raw = {}
  for (const [k, v] of Object.entries(sums))
    out[k] = GMV_MAX_MONEY_METRICS.has(k)
      ? roundMoney(v, currency)
      : Math.round(v)
  const cost = sums.cost ?? 0
  if (cost > 0 && sums.gross_revenue !== undefined)
    out.roi = Math.round((sums.gross_revenue / cost) * 100) / 100
  if (sums.orders) out.cost_per_order = roundMoney(cost / sums.orders, currency)
  return out
}

type ReportData = { list?: Raw[]; page_info?: PageInfo; total_metrics?: Raw }

/**
 * Shops for a report without store_id: EVERY shop of /gmv_max/store/list/ (a shop authorized earlier may still hold
 * this account's past GMV Max spend) - authorized to this account first, then GMV-Max-available ones, then the rest.
 */
export function orderReportShops(all: GmvMaxShop[]): GmvMaxShop[] {
  const rank = (s: GmvMaxShop) =>
    s.authorized_for_this_account ? 0 : s.is_gmv_max_available ? 1 : 2
  return all
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s)
}

export async function runGmvMaxReport(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxReportInput,
  now: Date = new Date()
): Promise<Raw> {
  const tt = ttFromCtx(ctx)
  const plan = planGmvMaxReport(input, tt.timezone, now)
  const warnings = [...plan.warnings]

  // shops: one shop per report call
  let shops: { store_id: string; store_name: string | null }[]
  if (input.store_id) {
    shops = [{ store_id: input.store_id, store_name: null }]
  } else {
    // several rows per store (owner / partner BCs): one per store, the one usable by this ad account
    const all = uniqueGmvMaxStoreRows(
      await fetchGmvMaxStoresRaw(tt, tt.advertiserId),
      tt.advertiserId
    )
      .map((s) => mapGmvMaxShop(s, tt.advertiserId))
      .filter((s) => /^\d+$/.test(s.store_id))
    const ordered = orderReportShops(all)
    const picked = ordered.slice(0, GMV_MAX_MAX_SHOPS)
    const skipped = ordered.slice(GMV_MAX_MAX_SHOPS)
    if (skipped.length) {
      warnings.push(
        `Tài khoản truy cập ${ordered.length} cửa hàng - chỉ lấy ${GMV_MAX_MAX_SHOPS} cửa hàng (ưu tiên cửa hàng đã cấp quyền GMV Max cho tài khoản này); bỏ qua ${skipped.length} cửa hàng: ${skipped.map((s) => s.store_id).join(", ")}. Truyền store_id để xem từng cửa hàng.`
      )
    }
    shops = picked.map((s) => ({
      store_id: s.store_id,
      store_name: s.store_name,
    }))
    if (!shops.length) {
      warnings.push(
        "Tài khoản không truy cập được cửa hàng TikTok Shop nào - gọi tiktok_gmv_max_shops để xem lý do, hoặc truyền store_id."
      )
    } else if (!picked.some((s) => s.authorized_for_this_account)) {
      warnings.push(
        "Chưa cửa hàng nào cấp quyền GMV Max cho tài khoản này - vẫn lấy báo cáo của các cửa hàng tài khoản truy cập được (có thể có dữ liệu cũ của các chiến dịch trước đây)."
      )
    }
  }

  const rows: Raw[] = []
  const shopSummaries: Raw[] = []
  let truncated = false
  let calls = 0
  let failed = 0
  let firstError: unknown = null
  outer: for (const shop of shops) {
    let shopRows = 0
    try {
      for (const win of plan.windows) {
        for (let page = 1; page <= 100; page++) {
          if (calls >= MAX_REPORT_CALLS || rows.length >= input.limit) {
            truncated = true
            break outer
          }
          const query: Raw = {
            advertiser_id: tt.advertiserId,
            store_ids: [shop.store_id],
            start_date: win.from,
            end_date: win.to,
            dimensions: plan.dimensions,
            metrics: plan.metrics,
            page,
            page_size: REPORT_PAGE_SIZE,
          }
          if (plan.filtering) query.filtering = plan.filtering
          if (plan.sortField) {
            query.sort_field = plan.sortField
            query.sort_type = "DESC"
          }
          const res = await ttGet<ReportData>(tt, "gmv_max/report/get", query)
          calls++
          const list = Array.isArray(res.data.list) ? res.data.list : []
          for (const item of list) {
            if (rows.length >= input.limit) {
              truncated = true
              break
            }
            rows.push(
              mapGmvMaxReportRow(item, plan, tt.currency, shop.store_id)
            )
            shopRows++
          }
          const totalPage = Number(res.data.page_info?.total_page ?? 0)
          if (list.length === 0 || page >= totalPage) break
        }
      }
    } catch (e) {
      if (!isProviderError(e) || shops.length === 1) throw e
      failed++
      firstError ??= e
      warnings.push(`Cửa hàng ${shop.store_id}: ${gmvMaxErrorText(e)}`)
    } finally {
      shopSummaries.push({
        store_id: shop.store_id,
        store_name: shop.store_name,
        rows: shopRows,
      })
    }
  }
  if (shops.length && failed === shops.length && firstError) throw firstError
  if (plan.windows.length > 1) {
    warnings.push(
      `Khoảng ngày được chia thành ${plan.windows.length} đoạn ≤${GMV_MAX_DAY_WINDOW} ngày (giới hạn của TikTok) rồi ghép lại.`
    )
  }
  const totals =
    !truncated &&
    !failed &&
    (plan.level === "account" || plan.level === "campaign")
      ? gmvMaxTotals(rows, tt.currency)
      : null
  if (truncated)
    warnings.push(
      `Kết quả bị cắt (giới hạn ${input.limit} dòng / ${MAX_REPORT_CALLS} lần gọi) - thu hẹp ngày, lọc store_id hoặc campaign_ids.`
    )

  const result: Raw = {
    advertiser_id: tt.advertiserId,
    currency: tt.currency,
    timezone: tt.timezone,
    level: plan.level,
    type: plan.type,
    breakdown: input.breakdown,
    date_range: plan.range,
    shops: shopSummaries,
    row_count: rows.length,
    rows,
    totals,
    truncated,
    warnings,
    notes: [...GMV_MAX_REPORT_NOTES],
    caution: GMV_MAX_CAUTION,
  }
  // stay under the MCP structured-content cap: trim rows (totals were computed on every fetched row)
  if (JSON.stringify(result).length > MAX_RESULT_CHARS) {
    const kept: Raw[] = []
    let size = JSON.stringify({ ...result, rows: [] }).length + 400
    for (const r of rows) {
      size += JSON.stringify(r).length + 1
      if (size > MAX_RESULT_CHARS) break
      kept.push(r)
    }
    result.rows = kept
    result.truncated = true
    warnings.push(
      `Kết quả lớn - chỉ hiển thị ${kept.length}/${rows.length} dòng (tổng totals vẫn tính trên ${rows.length} dòng). Thu hẹp ngày hoặc lọc để xem đủ.`
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Activation guardrail (ads_set_status → active): worst-case daily spend of GMV Max campaigns
// ---------------------------------------------------------------------------

export interface GmvMaxActivationSpend {
  id: string
  name: string | null
  type: GmvMaxType
  daily_budget: number | null
  /** worst-case spend of one day, major units of the ad account currency */
  max_possible_daily_spend: number
  notes: string[]
}

/**
 * /campaign/get/ rows about to be switched ON → GMV Max campaigns among them (detected, fail closed) with their
 * worst-case daily spend from /campaign/gmv_max/info/ (gmvMaxWorstCaseDaily). Throws a ProviderError when the GMV Max
 * status of a candidate or the budget of a GMV Max campaign cannot be read - the caller refuses the activation when
 * the MCP has a daily cap. No candidate → no call.
 */
export async function gmvMaxActivationSpend(
  tt: TT,
  rows: Raw[]
): Promise<GmvMaxActivationSpend[]> {
  const candidates = gmvMaxCandidateIds(rows)
  if (!candidates.length) return []
  let gmv: Map<string, GmvMaxType>
  try {
    gmv = await detectGmvMaxCampaigns(tt, rows)
  } catch (e) {
    throw gmvMaxCheckFailure(e, candidates.join(", "))
  }
  const names = new Map(
    rows.map((r) => [String(r.campaign_id), str(r.campaign_name)])
  )
  const out: GmvMaxActivationSpend[] = []
  for (const id of candidates) {
    const type = gmv.get(id)
    if (!type) continue
    let info: Raw
    try {
      info = await fetchGmvMaxInfo(tt, id)
    } catch (e) {
      if (isProviderError(e) && e.code === "auth_invalid") throw e
      const denied = isProviderError(e) && e.code === "permission_denied"
      throw new ProviderError({
        platform: "tiktok",
        code: denied ? "permission_denied" : "upstream_error",
        message: `GMV Max info unavailable for campaign ${id} (activation budget check)`,
        userMessageVi: gmvMaxBudgetUnverifiedMessage(id),
        hint: denied
          ? gmvMaxScopeHint("/campaign/gmv_max/info/")
          : `TikTok: ${gmvMaxErrorText(e)}`.slice(0, 400),
        retryable: denied ? false : isProviderError(e) ? e.retryable : true,
        upstream: isProviderError(e) ? e.upstream : undefined,
        cause: e,
      })
    }
    const w = gmvMaxWorstCaseDaily(info, tt.currency)
    if (w.max_possible_daily_spend === null) {
      throw new ProviderError({
        platform: "tiktok",
        code: "upstream_error",
        message: `GMV Max info of campaign ${id} has no budget (activation budget check)`,
        userMessageVi: gmvMaxBudgetUnverifiedMessage(id),
      })
    }
    out.push({
      id,
      name: names.get(id) ?? null,
      type,
      daily_budget: w.daily_budget,
      max_possible_daily_spend: w.max_possible_daily_spend,
      notes: w.notes,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// "Account has GMV Max campaigns" probe (D5) - cached 10 min per (developer app, advertiser), in-process, never throws
// ---------------------------------------------------------------------------

export const GMV_MAX_PROBE_TTL_MS = 10 * 60_000
/** The probe must never slow ads_get_report down: one attempt, short timeout. */
export const GMV_MAX_PROBE_TIMEOUT_MS = 5_000
const probeCache = new Map<string, { at: number; value: boolean | null }>()

export function __resetGmvMaxProbeCache(): void {
  probeCache.clear()
}

/** Cache key: developer app (connection credentials) + advertiser - never the advertiser alone. */
export function gmvMaxPresenceKey(
  tt: Pick<TT, "creds" | "advertiserId">
): string {
  return `${tt.creds.appId ?? "-"}:${tt.advertiserId}`
}

/** Record a finding (e.g. campaigns found while tagging a list) without an extra call. */
export function rememberGmvMaxPresence(
  tt: Pick<TT, "creds" | "advertiserId">,
  value: boolean | null,
  now: number = Date.now()
): void {
  if (probeCache.size > 5_000) probeCache.clear()
  probeCache.set(gmvMaxPresenceKey(tt), { at: now, value })
}

/** Cached probe result (no API call): true/false/null(unknown or failed) or undefined when not cached / expired. */
export function peekGmvMaxPresence(
  tt: Pick<TT, "creds" | "advertiserId">,
  now: number = Date.now()
): boolean | null | undefined {
  const hit = probeCache.get(gmvMaxPresenceKey(tt))
  if (!hit || now - hit.at >= GMV_MAX_PROBE_TTL_MS) return undefined
  return hit.value
}

/**
 * Does the ad account have GMV Max campaigns? /gmv_max/campaign/get/ page_size 1 for PRODUCT then LIVE, called with
 * tiktokRequest directly: no retry, ~5 s timeout. true / false, or null when the check failed (no scope, network…).
 * Never throws; every result (true / false / null) is cached 10 minutes.
 */
export async function accountHasGmvMax(
  tt: TTRead,
  now: number = Date.now()
): Promise<boolean | null> {
  const cached = peekGmvMaxPresence(tt, now)
  if (cached !== undefined) return cached
  let value: boolean | null = false
  try {
    for (const type of GMV_MAX_TYPES) {
      const res = await tiktokRequest<{ list?: Raw[]; page_info?: PageInfo }>({
        method: "GET",
        path: "gmv_max/campaign/get",
        query: {
          advertiser_id: tt.advertiserId,
          fields: ["campaign_id"],
          filtering: {
            gmv_max_promotion_types: [GMV_MAX_PROMOTION_TYPE[type]],
          },
          page: 1,
          page_size: 1,
        },
        auth: tt.creds.accessToken,
        appId: tt.creds.appId,
        retries: 0,
        timeoutMs: GMV_MAX_PROBE_TIMEOUT_MS,
        signal: tt.signal,
        onUpstream: tt.onUpstream,
      })
      const list = Array.isArray(res.data?.list) ? res.data.list : []
      if (
        list.length > 0 ||
        Number(res.data?.page_info?.total_number ?? 0) > 0
      ) {
        value = true
        break
      }
    }
  } catch {
    value = null
  }
  rememberGmvMaxPresence(tt, value, now)
  return value
}

/** D5: add the "GMV Max may not be in this report" warning to a TikTok ads_get_report page. Never throws. */
export async function withGmvMaxReportWarning(
  ctx: ProviderContext<TikTokCredentials>,
  page: ReportPage
): Promise<ReportPage> {
  try {
    if (
      (await accountHasGmvMax(ttFromCtx(ctx))) === true &&
      !page.warnings.includes(GMV_MAX_NOT_IN_REPORT_WARNING)
    ) {
      return {
        ...page,
        warnings: [...page.warnings, GMV_MAX_NOT_IN_REPORT_WARNING],
      }
    }
  } catch {
    // never fail the report because of the probe
  }
  return page
}

// ---------------------------------------------------------------------------
// MCP tools (registered through tiktokExtensions) - read only
// ---------------------------------------------------------------------------

const PREREQ =
  'Cần: developer app có quyền Ads Management > GMV MAX và Reporting > GMV MAX Report (advertiser đã cấp quyền lại), cửa hàng TikTok Shop cùng Business Center và tài khoản QC là "GMV Max account" của cửa hàng.'

export const gmvMaxExtensions: ProviderExtension<TikTokCredentials>[] = [
  {
    name: "tiktok_gmv_max_shops",
    permission: "read",
    title: "Cửa hàng GMV Max (TikTok Shop)",
    description:
      'Dùng khi cần kiểm tra tài khoản quảng cáo TikTok đã sẵn sàng GMV Max (TikTok Shop) chưa, hoặc khi người dùng hỏi "kiểm tra cửa hàng GMV Max": liệt kê cửa hàng TikTok Shop tài khoản truy cập được, cửa hàng nào dùng được GMV Max, tài khoản QC nào đang giữ quyền GMV Max độc quyền của cửa hàng, vai trò trong Business Center / trên cửa hàng, thị trường, và lý do chưa sẵn sàng (issues). ' +
      "Chỉ đọc. Gọi ads_list_accounts trước để lấy account_id. Lấy store_id ở đây cho tiktok_gmv_max_campaigns và tiktok_gmv_max_report. " +
      PREREQ +
      " GMV Max dùng để XEM và PHÂN TÍCH chỉ số; hạn chế bật/tắt hay chỉnh sửa.",
    input: gmvMaxShopsInput,
    write: false,
    run: (ctx) => runGmvMaxShops(ctx),
  },
  {
    name: "tiktok_gmv_max_campaigns",
    permission: "read",
    title: "Chiến dịch GMV Max (TikTok Shop)",
    description:
      "Dùng khi cần danh sách chiến dịch GMV Max (Product GMV Max và LIVE GMV Max) của tài khoản TikTok: tên, loại PRODUCT/LIVE, trạng thái (kèm giải thích tiếng Việt), Bảo vệ ROI. " +
      "include_details=true lấy thêm ngân sách ngày, ROI mục tiêu, tăng ngân sách tự động, ngày khuyến mãi, chi tiêu tối đa có thể mỗi ngày, cửa hàng, lịch chạy (tối đa 20 chiến dịch). " +
      "Chiến dịch GMV Max có thể không hiện trong ads_list_objects. Chỉ đọc. Thay đổi GMV Max chỉ khi quản trị viên đã bật quyền GMV Max cho MCP: bật/tắt ads_set_status, ngân sách ads_update_budget, ROI / tăng ngân sách tự động / ngày khuyến mãi / sản phẩm tiktok_gmv_max_update, video tiktok_gmv_max_creatives, sao chép ads_copy_object, tạo tiktok_gmv_max_create, xoá ads_delete_object. " +
      "Gọi ads_list_accounts trước; lọc theo cửa hàng bằng store_id từ tiktok_gmv_max_shops. Tiền theo đơn vị chính của tiền tệ tài khoản. " +
      PREREQ +
      " GMV Max dùng để XEM và PHÂN TÍCH; hạn chế bật/tắt hay chỉnh sửa.",
    input: gmvMaxCampaignsInput,
    write: false,
    run: (ctx, input) => runGmvMaxCampaigns(ctx, input as GmvMaxCampaignsInput),
  },
  {
    name: "tiktok_gmv_max_report",
    permission: "read",
    title: "Báo cáo GMV Max (TikTok Shop)",
    description:
      "Dùng khi cần chỉ số GMV Max (chi phí, chi phí thực net_cost, số đơn, doanh thu gộp gross_revenue, ROI) theo cấp account / campaign / product (SPU) / creative (bài đăng) / live_room, tổng kỳ hoặc theo ngày. " +
      "Chi tiêu GMV Max có thể không nằm (đầy đủ) trong ads_get_report - không cộng hai báo cáo vì có thể bị trùng hoặc sai. ROI/số đơn GMV Max gồm cả đơn tự nhiên nên không so với ROAS của ads_get_report. Cấp account chỉ tính chiến dịch chưa xoá; tổng chi tiêu đầy đủ dùng level=campaign. " +
      "type PRODUCT/LIVE bắt buộc trừ level=account; product/creative chỉ PRODUCT, live_room chỉ LIVE; product/live_room cần campaign_ids, creative cần thêm item_group_ids (lấy từ báo cáo product). " +
      "Ngày YYYY-MM-DD theo múi giờ tài khoản, tối đa 365 ngày; theo ngày được tự chia đoạn 30 ngày. Bỏ trống store_id = mọi cửa hàng tài khoản truy cập được (tối đa 5, ưu tiên cửa hàng đã cấp quyền GMV Max). Một số chỉ số trễ tới 11 giờ; dữ liệu từ 2024-09-27. " +
      "Gọi trước: ads_list_accounts, tiktok_gmv_max_shops / tiktok_gmv_max_campaigns. Dùng để XEM và PHÂN TÍCH; hạn chế bật/tắt hay chỉnh sửa GMV Max.",
    input: gmvMaxReportInput,
    write: false,
    run: (ctx, input) => runGmvMaxReport(ctx, input as GmvMaxReportInput),
  },
]
