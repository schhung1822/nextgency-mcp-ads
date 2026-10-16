// Thin per-account helpers over tiktokRequest + shared TikTok conversions (status, budget, time).
import { ProviderError } from "../errors"
import { roundMoney } from "../money"
import type {
  Budget,
  ConnectionContext,
  NormalizedStatus,
  ObjectLevel,
  ProviderContext,
  UpstreamEvent,
} from "../types"
import { tiktokRequest, type TikTokResult } from "./client"
import type { TikTokCredentials } from "./credentials"

export type Raw = Record<string, unknown>

/** Everything an operation needs for one advertiser. */
export interface TT {
  creds: TikTokCredentials
  advertiserId: string
  currency: string
  timezone: string
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
}

export function ttFromCtx(ctx: ProviderContext<TikTokCredentials>): TT {
  return {
    creds: ctx.credentials,
    advertiserId: ctx.account.externalId,
    currency: ctx.account.currency,
    timezone: ctx.account.timezone,
    signal: ctx.signal,
    onUpstream: ctx.onUpstream,
  }
}

export function ttFromConnection(ctx: ConnectionContext<TikTokCredentials>) {
  return {
    creds: ctx.credentials,
    signal: ctx.signal,
    onUpstream: ctx.onUpstream,
  }
}

export async function ttGet<T = Raw>(
  tt: Pick<TT, "creds" | "signal" | "onUpstream">,
  path: string,
  query: Record<string, unknown>
): Promise<TikTokResult<T>> {
  return tiktokRequest<T>({
    method: "GET",
    path,
    query,
    auth: tt.creds.accessToken,
    appId: tt.creds.appId,
    signal: tt.signal,
    onUpstream: tt.onUpstream,
  })
}

/**
 * POST helper. `retries` defaults to 0: only pass >0 when the write is idempotent
 * (absolute status/budget values, full replacement, or a create carrying the same request_id).
 */
export async function ttPost<T = Raw>(
  tt: Pick<TT, "creds" | "signal" | "onUpstream">,
  path: string,
  body: Record<string, unknown>,
  opts: { retries?: number; timeoutMs?: number; create?: boolean } = {}
): Promise<TikTokResult<T>> {
  return tiktokRequest<T>({
    method: "POST",
    path,
    body,
    auth: tt.creds.accessToken,
    appId: tt.creds.appId,
    retries: opts.retries ?? 0,
    create: opts.create,
    timeoutMs: opts.timeoutMs,
    signal: tt.signal,
    onUpstream: tt.onUpstream,
  })
}

export interface PageInfo {
  page?: number
  page_size?: number
  total_number?: number
  total_page?: number
}

/** Fetch every page of a list endpoint (data.list / data.page_info) up to `max` items. */
export async function ttGetAll<T = Raw>(
  tt: TT,
  path: string,
  query: Record<string, unknown>,
  opts: { listKey?: string; pageSize?: number; max?: number } = {}
): Promise<T[]> {
  const listKey = opts.listKey ?? "list"
  const pageSize = opts.pageSize ?? 1000
  const max = opts.max ?? 5000
  const out: T[] = []
  for (let page = 1; page <= 1000; page++) {
    const res = await ttGet<Raw>(tt, path, { ...query, page, page_size: pageSize })
    const list = (res.data[listKey] as T[] | undefined) ?? []
    out.push(...list)
    const info = (res.data.page_info as PageInfo | undefined) ?? {}
    const totalPage = Number(info.total_page ?? 0)
    if (out.length >= max || list.length === 0 || page >= totalPage) break
  }
  return out.slice(0, max)
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Level helpers
// ---------------------------------------------------------------------------

export type TikTokLevel = "campaign" | "adgroup" | "ad"

export function toTikTokLevel(level: ObjectLevel): TikTokLevel {
  if (level === "campaign") return "campaign"
  if (level === "ad_group") return "adgroup"
  if (level === "ad") return "ad"
  throw new ProviderError({
    platform: "tiktok",
    code: "unsupported",
    message: `TikTok has no ${level} level`,
    userMessageVi: "TikTok không có cấp từ khoá (keyword).",
  })
}

export const LEVEL_VI: Record<ObjectLevel, string> = {
  campaign: "chiến dịch",
  ad_group: "nhóm quảng cáo",
  ad: "quảng cáo",
  keyword: "từ khoá",
}

export type AutomationType = "MANUAL" | "SMART_PLUS" | "UPGRADED_SMART_PLUS" | "UPGRADED_SMART_PLUS_CREATIVE" | string

export function automationType(o: Raw): AutomationType {
  const t = o.campaign_automation_type
  if (typeof t === "string" && t) return t
  if (o.is_smart_performance_campaign === true) return "SMART_PLUS"
  return "MANUAL"
}

export function isUpgradedSmartPlus(o: Raw): boolean {
  const t = automationType(o)
  return t === "UPGRADED_SMART_PLUS" || t === "UPGRADED_SMART_PLUS_CREATIVE"
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  return String(v)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * operation_status + secondary_status → NormalizedStatus. Checked against "Supported secondary statuses for a primary
 * status" (doc 1757239620352002) + Enumerations (1737174886619138) + the Upgraded Smart+ ad statuses, 2026-10-16
 * (providers/tiktok.md §3). Partial review results keep their status; statusDetail() tells them apart.
 */
export function normalizeStatus(operationStatus: unknown, secondaryStatus: unknown): NormalizedStatus {
  const op = typeof operationStatus === "string" ? operationStatus : ""
  const sec = typeof secondaryStatus === "string" ? secondaryStatus : ""
  if (op === "DELETE" || /(^|_)DELETE$/.test(sec)) return "deleted"
  // PRIVACY_POLICY_REJECTED (Upgraded Smart+) and PROMOTE_AD_OFFLINE_AUDIT (RF_CLOSED "Creative not approved") are
  // rejections although they do not end in _DENY
  if (/_DENY$|AUDIT_DENY|REVIEW_DISAPPROVED|NOT_APPROVED|PRIVACY_POLICY_REJECTED$|PROMOTE_AD_OFFLINE_AUDIT$/.test(sec)) return "rejected"
  if (/FROZEN|ACCOUNT_PUNISH/.test(sec) || op === "FROZEN") return "disabled"
  if (op === "DISABLE") return "paused"
  // A child that is ENABLE itself but whose parent is disabled (ADGROUP_STATUS_CAMPAIGN_DISABLE,
  // AD_STATUS_ADGROUP_DISABLE, …) is not delivering → paused, checked BEFORE trusting op === "ENABLE".
  // Primary STATUS_DISABLE also groups AWAITING_RELEASE (SKAN) and the GMV Max authorization / "used by" pauses.
  if (/DISABLE$|AWAITING_RELEASE$|AUTHORIZATION_CANCEL$|USED_BY_(LIVE|PRODUCT)_GMV_MAX$/.test(sec)) return "paused"
  // An edit is in review while the previous version keeps delivering (primary DELIVERY_OK) → active, before the
  // generic *_REAUDIT rule
  if (/SHADOW_ADGROUP_REAUDIT$|DELIVERY_AND_REAUDIT$/.test(sec)) return op === "ENABLE" || !op ? "active" : "unknown"
  // Approved for part of the placements but not delivering yet → still in review (checked 2026-10-08)
  if (/PARTIAL_AUDIT_NO_DELIVERY$/.test(sec)) return "pending_review"
  // Not delivering because an upstream object/account is unavailable, a contract is pending, every keyword was
  // refused, lead collection was switched off or a Reach & Frequency / Promote order is closed → never "active"
  if (
    /_UNAVAILABLE$|CONTRACT_PENDING|SEARCH_KEYWORDS_NOT_AVAILABLE$|COLLECTION_TOGGLED_OFF$|ADVERTISER_ACCOUNT_INVALID$/.test(sec) ||
    /RF_(DEDUCTION_FAILED|NO_VALID_CREATIVE|CLOSED_OTHERS|ADGROUP_INVALID|WITHDRAW_ORDER|ADGROUP_CLOSED)$|PROMOTE_(WITHDRAW_ORDER|ADGROUP_CLOSED)$/.test(sec)
  ) {
    return "disabled"
  }
  if (/_(RE)?AUDIT$|_IN_REVIEW$/.test(sec)) return "pending_review"
  if (/TIME_DONE$|_STATUS_DONE$|RF_TIME_DONE$|RF_TERMINATE$/.test(sec)) return "archived"
  if (op === "ENABLE") return "active"
  if (/DELIVERY_OK$|_ENABLE$/.test(sec)) return "active"
  return "unknown"
}

/**
 * Refinement of a partial review result (AdObjectSummary.statusDetail): "partially_approved" = delivering only where /
 * with what was approved (primary DELIVERY_OK: *_PARTIAL_AUDIT_DELIVERY_OK, *_REVIEW_PARTIALLY_APPROVED, keywords
 * partially approved); "partially_rejected" = *_PARTIAL_AUDIT_DENY (status rejected, part of it was approved).
 * null otherwise. ads_get_object shows the reasons (extra.review, review.ts).
 */
export function statusDetail(secondaryStatus: unknown): "partially_approved" | "partially_rejected" | null {
  const sec = typeof secondaryStatus === "string" ? secondaryStatus : ""
  if (!sec) return null
  if (/PARTIAL_AUDIT_DENY$/.test(sec)) return "partially_rejected"
  if (/PARTIAL_AUDIT_DELIVERY_OK$|REVIEW_PARTIALLY_APPROVED$|SEARCH_KEYWORDS_PARTIAL_APPROVED$/.test(sec)) return "partially_approved"
  return null
}

/**
 * Why an object switched on (status "active") is NOT delivering: secondary statuses of the primary STATUS_NOT_DELIVERY
 * group (doc 1757239620352002) that normalizeStatus keeps as "active" (the owner turned it on). Exposed as
 * extra.delivery_blocked_reason {code, label}. null = nothing known blocks delivery.
 */
const DELIVERY_BLOCKED: readonly (readonly [RegExp, string, string])[] = [
  [/ADGROUP_STATUS_CREATE$/, "no_ads", "nhóm chưa có quảng cáo"],
  [/_CAMPAIGN_EXCEED$/, "campaign_budget_exceeded", "chiến dịch đã hết ngân sách"],
  [/_BUDGET_EXCEED$/, "budget_exceeded", "đã hết ngân sách"],
  [/_BALANCE_EXCEED$|ACCOUNT_BALANCE_INSUFFICIENT$/, "balance_insufficient", "thanh toán không thành công hoặc số dư tài khoản không đủ"],
  [/LIVE_NOT_START$/, "live_not_started", "LIVE chưa bắt đầu"],
  [/_NOT_START$/, "not_started", "ngoài lịch chạy (chưa tới giờ bắt đầu)"],
  [/LIVE_OFFLINE$/, "live_offline", "LIVE đang ngoại tuyến"],
  [/_TRANSCODING_FAIL$/, "transcoding_failed", "video lỗi chuyển mã - cần tải lại / thay video"],
  [/ASSET_AUTHORIZATION_LOST$/, "asset_authorization_lost", "tài sản không dùng được hoặc đã bị thu hồi ủy quyền"],
  [/PIXEL_UNBIND$/, "pixel_unauthorized", "pixel chưa được ủy quyền"],
  [/_QUOTA_LIMIT$/, "quota_limit", "tài khoản hết hạn mức nhóm đang chạy - tạm dừng bớt nhóm khác"],
  [/_PRE_ONLINE$/, "pre_online", "đang chuẩn bị phân phối"],
  [/INDUSTRY_QUALIFICATION_MISSING$/, "qualification_missing", "thiếu giấy phép ngành nghề"],
  [/INDUSTRY_QUALIFICATION_EXPIRED$/, "qualification_expired", "giấy phép ngành nghề đã hết hạn"],
  [/MUSIC_AUTHORIZATION_MISSING$/, "music_authorization_missing", "thiếu bản quyền nhạc"],
  [/PROCESS_AUDIO$/, "processing_audio", "đang xử lý âm thanh (kẹt lâu thì tải lại)"],
  [/NO_AUTHORIZATION_OF_SHOWCASE$/, "showcase_unauthorized", "identity không dùng được (mất quyền showcase)"],
  [/IDENTITY_USED_BY_GMV_MAX_AD$/, "identity_used_by_gmv_max", "identity đang được dùng cho quảng cáo GMV Max"],
  [/RF_NO_DELIVERY_CREATIVE$/, "rf_no_creative", "không có creative hợp lệ (Reach & Frequency)"],
  [/RF_SHORT_BALANCE$/, "rf_short_balance", "số dư thấp hơn số tiền cần trừ (Reach & Frequency)"],
  [/RF_BOOKING$/, "rf_booked", "đã đặt chỗ, chưa phân phối (Reach & Frequency)"],
  [/RF_SCHEDULE$/, "rf_scheduled", "đã lên lịch, chưa phân phối (Reach & Frequency)"],
]

export function deliveryBlockedReason(secondaryStatus: unknown): { code: string; label: string } | null {
  const sec = typeof secondaryStatus === "string" ? secondaryStatus : ""
  // Upgraded Smart+ DELIVERY_AND_TRANSCODING_FAIL still delivers
  if (!sec || /DELIVERY_AND_/.test(sec)) return null
  for (const [re, code, label] of DELIVERY_BLOCKED) if (re.test(sec)) return { code, label }
  return null
}

export function statusRaw(o: Raw): string {
  const op = str(o.operation_status) ?? "?"
  const sec = str(o.secondary_status)
  return sec ? `${op}/${sec}` : op
}

// ---------------------------------------------------------------------------
// Budget (TikTok budgets are already MAJOR units of the account currency)
// ---------------------------------------------------------------------------

export function budgetType(mode: unknown): "daily" | "lifetime" | null {
  if (mode === "BUDGET_MODE_DAY" || mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET") return "daily"
  if (mode === "BUDGET_MODE_TOTAL") return "lifetime"
  return null
}

/**
 * Current budget value (major units). Upgraded Smart+ objects report the in-effect amount in `current_budget`
 * (`budget` may hold a scheduled/next value) → prefer it when present (providers/tiktok.md, checked 2026-10-08).
 */
export function budgetAmount(o: Raw): number {
  const cur = o.current_budget
  if (automationType(o) === "UPGRADED_SMART_PLUS" && cur !== undefined && cur !== null && cur !== "") {
    const n = Number(cur)
    if (Number.isFinite(n) && n > 0) return n
  }
  return Number(o.budget)
}

export function toBudget(o: Raw, level: "campaign" | "ad_group", currency: string): Budget | null {
  const type = budgetType(o.budget_mode)
  const amount = budgetAmount(o)
  if (!type || !Number.isFinite(amount) || amount <= 0) return null
  // BUDGET_MODE_DYNAMIC_DAILY_BUDGET: "Daily costs will not exceed 125% of the average daily budget" (doc
  // 1739381246298114) → flagged so the MCP daily cap is compared with 125% of it
  return o.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" ? { type, amount, currency, level, dynamic: true } : { type, amount, currency, level }
}

/** Value sent to TikTok budget fields: major units, rounded to the currency precision (no float noise). */
export function apiMoney(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ProviderError({
      platform: "tiktok",
      code: "invalid_request",
      message: `Invalid amount ${amount}`,
      userMessageVi: "Số tiền phải lớn hơn 0.",
    })
  }
  return roundMoney(amount, currency) as number
}

// ---------------------------------------------------------------------------
// Time - TikTok schedule times are "YYYY-MM-DD HH:MM:SS" in UTC+0
// ---------------------------------------------------------------------------

const TT_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

export function isTikTokTime(s: string): boolean {
  const m = TT_TIME.exec(s)
  if (!m) return false
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return !Number.isNaN(d.getTime()) && formatTikTokTime(d) === s
}

/** "2026-10-02 07:00:00" (UTC) → Date */
export function parseTikTokTime(s: unknown): Date | null {
  if (typeof s !== "string") return null
  const m = TT_TIME.exec(s.trim())
  if (!m) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatTikTokTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}

export function tiktokTimeToIso(s: unknown): string | null {
  const d = parseTikTokTime(s)
  return d ? d.toISOString() : null
}

/** ISO 8601 (with offset) → TikTok UTC schedule string */
export function isoToTikTokTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new ProviderError({
      platform: "tiktok",
      code: "invalid_request",
      message: `Invalid datetime ${iso}`,
      userMessageVi: `Thời gian không hợp lệ: ${iso}. Dùng ISO 8601 có múi giờ, ví dụ 2026-10-05T08:00:00+07:00.`,
    })
  }
  return formatTikTokTime(d)
}

/** Offset (ms) of `timeZone` at instant `at`: local wall-clock minus UTC. */
export function tzOffsetMs(timeZone: string, at: Date): number {
  let tz = timeZone
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch {
    tz = "UTC"
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Local midnight of `date` (YYYY-MM-DD) in `timeZone` as an ISO string with numeric offset. */
export function zonedMidnightIso(date: string, timeZone: string): string {
  const guess = Date.parse(`${date}T00:00:00Z`)
  let offset = tzOffsetMs(timeZone, new Date(guess))
  // re-evaluate once in case the offset changes between guess and actual instant (DST)
  offset = tzOffsetMs(timeZone, new Date(guess - offset))
  const sign = offset >= 0 ? "+" : "-"
  const abs = Math.abs(offset)
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, "0")
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, "0")
  return `${date}T00:00:00${sign}${hh}:${mm}`
}

/** Local wall-clock "HH:MM" in `timeZone` */
export function localHourMinute(timeZone: string, now: Date): { h: number; m: number } {
  const local = new Date(now.getTime() + tzOffsetMs(timeZone, now))
  return { h: local.getUTCHours(), m: local.getUTCMinutes() }
}

export function invalid(userMessageVi: string, hint?: string): ProviderError {
  return new ProviderError({
    platform: "tiktok",
    code: "invalid_request",
    message: userMessageVi,
    userMessageVi,
    hint,
  })
}

export function notFound(level: ObjectLevel, id: string): ProviderError {
  return new ProviderError({
    platform: "tiktok",
    code: "not_found",
    message: `TikTok ${level} ${id} not found`,
    userMessageVi: `Không tìm thấy ${LEVEL_VI[level]} ${id} trong tài khoản quảng cáo này.`,
    hint: "Gọi ads_list_objects để lấy đúng id.",
  })
}

export function unsupportedVi(what: string, userMessageVi: string): ProviderError {
  return new ProviderError({
    platform: "tiktok",
    code: "unsupported",
    message: `TikTok: ${what} is not supported`,
    userMessageVi,
  })
}
