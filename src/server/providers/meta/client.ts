// Graph API request helper for the Meta adapter.
// - Every call goes through httpJson (timeout, abort, jittered retry, token bucket, upstream events).
// - access_token (+ optional appsecret_proof) is sent as a query param on GET and in the form body on POST,
//   both are redacted from reported URLs by http.ts.
// - Meta errors are mapped to ProviderError (meta.md §7); usage headers drive coolDown() (circuit breaker).
import { createHash, createHmac } from "node:crypto"

import { sanitizeExternalLabel } from "../../../lib/text-safety"
import { ProviderError, type ProviderErrorCode } from "../errors"
import { httpJson, type HttpResponse } from "../http"
import { RateLimitWaitError, coolDown, type BucketSpec } from "../rate-limit"
import type { UpstreamEvent } from "../types"

export interface MetaCredentials {
  accessToken: string
  appId?: string
  appSecret?: string
  businessId?: string
}

export const META_GRAPH_HOST = "https://graph.facebook.com"
export const META_VIDEO_HOST = "https://graph-video.facebook.com"

export function metaApiVersion(): string {
  return process.env.META_API_VERSION ?? "v26.0"
}

/** Mutable timings so tests can make polling instant. */
export const META_TIMINGS = {
  /** async insights poll interval (grows ×1.5 up to 10 s) */
  pollIntervalMs: 2_000,
  /** max time spent waiting for an async report inside one tool call */
  asyncReportMaxWaitMs: 90_000,
  /** max time waiting for an uploaded video to become ready */
  videoMaxWaitMs: 60_000,
}

/** Sustained per-ad-account request rate. Real limits are enforced via usage headers + coolDown(). */
const BUCKET_SPEC: BucketSpec = { ratePerSec: 4, burst: 8 }

export interface MetaCallContext {
  credentials: MetaCredentials
  /** "act_123" - used for the rate-limit bucket */
  accountId?: string | null
  /** Page id - Page-token calls are throttled per Page (BUC type "pages", meta.md §10.6) */
  pageId?: string | null
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
}

export type GraphParams = Record<string, unknown>

export interface GraphRequest {
  method: "GET" | "POST" | "DELETE"
  /** path without version, e.g. "act_123/insights" or "123456" */
  path: string
  params?: GraphParams
  /**
   * Safe to retry on transient errors (GET, status/budget updates). Creates/copies/uploads must be false
   * (no blind retry after a timeout - meta.md §7).
   */
  idempotent?: boolean
  host?: "graph" | "video"
  timeoutMs?: number
  /** override the token sent as access_token (debug_token with an app token) and skip appsecret_proof */
  accessTokenOverride?: string
  /** send this Page access token instead of the user token; appsecret_proof is computed from IT (meta.md §10.3) */
  pageAccessToken?: string
  /** do not treat insights "too much data" (code 1) as retryable */
  insights?: boolean
  /** send POST params as multipart/form-data (large payloads such as base64 image bytes); Blob/File params are sent as file parts */
  multipart?: boolean
  /** called with the raw Graph error object before it is mapped and thrown (e.g. resumable upload error_data offsets) */
  onGraphError?: (err: GraphErrorBody) => void
}

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex")
}

export function actId(externalId: string): string {
  const id = externalId.trim()
  return id.startsWith("act_") ? id : `act_${id}`
}

export function accountNumericId(externalId: string): string {
  return externalId.trim().replace(/^act_/, "")
}

function bucketKey(ctx: MetaCallContext): string {
  if (ctx.pageId) return `meta:page:${ctx.pageId}`
  if (ctx.accountId) return `meta:${actId(ctx.accountId)}`
  const h = createHash("sha256").update(ctx.credentials.accessToken).digest("hex").slice(0, 16)
  return `meta:token:${h}`
}

function encodeParam(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v)
}

function authParams(ctx: MetaCallContext, req: GraphRequest): Record<string, string> {
  if (req.accessTokenOverride) return { access_token: req.accessTokenOverride }
  if (req.pageAccessToken) {
    const page: Record<string, string> = { access_token: req.pageAccessToken }
    if (ctx.credentials.appSecret) page.appsecret_proof = appSecretProof(req.pageAccessToken, ctx.credentials.appSecret)
    return page
  }
  const out: Record<string, string> = { access_token: ctx.credentials.accessToken }
  if (ctx.credentials.appSecret) {
    out.appsecret_proof = appSecretProof(ctx.credentials.accessToken, ctx.credentials.appSecret)
  }
  return out
}

export interface GraphErrorBody {
  message?: string
  type?: string
  code?: number
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
  fbtrace_id?: string
  is_transient?: boolean
  /** extra data (object or JSON string), e.g. resumable upload offsets */
  error_data?: unknown
}

const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014])

export function isThrottleCode(code: number | undefined): boolean {
  return code !== undefined && THROTTLE_CODES.has(code)
}

function extractError(body: unknown): GraphErrorBody | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error
    if (e && typeof e === "object") return e as GraphErrorBody
  }
  return null
}

const ENDED = {
  vi: "Quảng cáo / nhóm quảng cáo / chiến dịch này đã lưu trữ hoặc đã xoá - Meta chỉ cho đổi tên, không đổi được nội dung.",
  hint: "Tạo quảng cáo mới bằng meta_create_ad (hoặc sao chép bằng ads_copy_object).",
}
const POST_UNAVAILABLE = {
  vi: "Bài viết không dùng được cho quảng cáo (đã xoá, chưa đăng, không thuộc Trang của quảng cáo, hoặc token không có quyền quảng cáo bài này).",
  hint: "Kiểm tra bài bằng meta_list_page_posts / meta_get_post, hoặc chọn bài khác.",
}

/** Creative / ad edit subcodes (usually under code 100) → Vietnamese message + hint. Never retried. */
const CREATIVE_ERRORS: Record<number, { vi: string; hint: string }> = {
  1815471: {
    vi: "Lời chào tin nhắn (page_welcome_message) không hợp lệ cho quảng cáo đích Messenger.",
    hint: "Rút gọn lời chào (≤300 ký tự), bỏ ký tự lạ, thử lại không kèm câu hỏi gợi ý; lời chào chỉ dùng cho nhóm quảng cáo đích Messenger.",
  },
  1815573: {
    vi: "Meta không cho sửa nội dung của creative đã tạo.",
    hint: "Dùng meta_update_ad_creative: hệ thống tạo creative mới rồi gắn vào quảng cáo.",
  },
  1885088: ENDED,
  // [H] error reference: "part of a scheduled ad set that has reached its end date" - fixable by extending end_time
  1487007: {
    vi: "Nhóm quảng cáo đã qua ngày kết thúc (end_time) - Meta không cho sửa nhóm / quảng cáo trong nhóm cho tới khi gia hạn lịch chạy.",
    hint: "Gia hạn end_time của nhóm quảng cáo ra tương lai bằng ads_update_object (level=ad_group, end_time ISO-8601 có múi giờ) rồi thử lại.",
  },
  1487056: ENDED,
  // [H] error reference: "This Ad Account has already too many archived adgroups."
  1487990: {
    vi: "Tài khoản quảng cáo đã có quá nhiều đối tượng được lưu trữ - Meta không cho lưu trữ thêm.",
    hint: "Xoá bớt đối tượng đã lưu trữ cũ (ads_delete_object) hoặc dùng paused thay cho lưu trữ.",
  },
  1487566: ENDED,
  1885998: {
    vi: "Creative không khớp kiểu nhóm quảng cáo (nhóm dùng Dynamic Creative cần creative nhiều phương án và ngược lại).",
    hint: "Không đổi creative của quảng cáo Dynamic Creative qua MCP; sửa trong Trình quản lý quảng cáo.",
  },
  3858355: {
    vi: "Quảng cáo định dạng linh hoạt: ảnh / video đầu tiên phải khớp creative - Meta không cho thay creative kiểu này.",
    hint: "Tạo quảng cáo mới bằng meta_create_ad rồi tạm dừng quảng cáo cũ.",
  },
  1885029: {
    vi: "Trang của creative khác Trang của đối tượng đang quảng cáo (promoted_object của nhóm quảng cáo).",
    hint: "Dùng đúng Trang của nhóm quảng cáo (ads_get_object level=ad_group → promoted_object.page_id).",
  },
  1885557: POST_UNAVAILABLE,
  2490155: POST_UNAVAILABLE,
  2446289: POST_UNAVAILABLE,
  1487472: POST_UNAVAILABLE,
}

/** Signed Meta CDN URLs (fbcdn / fbsbx) that Graph errors may echo (image of a creative, video thumbnail). */
const SIGNED_CDN_URL = /https?:\/\/[^\s"']*(?:fbcdn|fbsbx)[^\s"']*/gi

function scrubSignedUrls(s: string | undefined): string | undefined {
  return s === undefined ? undefined : s.replace(SIGNED_CDN_URL, "[ảnh]")
}

/** Map a Graph error payload (+ HTTP status) to a ProviderError. Never includes the token or a signed CDN URL. */
export function mapGraphError(
  err: GraphErrorBody | null,
  httpStatus: number,
  requestId: string | null,
  extra: { retryAfterMs?: number } = {}
): ProviderError {
  // Meta's texts may echo a signed image URL of the creative: never in messages, hints or upstream info
  if (err) {
    err = {
      ...err,
      message: scrubSignedUrls(err.message),
      error_user_title: scrubSignedUrls(err.error_user_title),
      error_user_msg: scrubSignedUrls(err.error_user_msg),
    }
  }
  const code = err?.code
  const sub = err?.error_subcode
  const upstream = {
    code: code ?? null,
    subcode: sub ?? null,
    message: err?.message ?? null,
    requestId: err?.fbtrace_id ?? requestId,
    httpStatus,
  }
  const userMsg = err?.error_user_msg
    ? `${err.error_user_title ? `${err.error_user_title}: ` : ""}${err.error_user_msg}`
    : null
  const make = (
    c: ProviderErrorCode,
    vi: string,
    opts: { retryable?: boolean; hint?: string; retryAfterMs?: number } = {}
  ) =>
    new ProviderError({
      platform: "meta",
      code: c,
      message: `Meta API error ${code ?? httpStatus}${sub ? `/${sub}` : ""}: ${err?.message ?? "HTTP " + httpStatus}`,
      userMessageVi: vi,
      retryable: opts.retryable ?? false,
      hint: opts.hint,
      upstream,
      retryAfterMs: opts.retryAfterMs,
    })

  // A Page edge called with the user token (a bug on our side, not a dead token): 190 WITHOUT subcode "must be called
  // with a Page Access Token", or 210 "A page access token is required" (meta.md §7, tested live). Never auth_invalid -
  // that would mark a healthy connection invalid.
  if ((code === 190 && !sub && /page access token/i.test(err?.message ?? "")) || code === 210) {
    return make("invalid_request", "Thao tác với Trang này cần page access token (lỗi nội bộ của Ads MCP).", {
      hint: "Báo quản trị viên; token của kết nối vẫn còn dùng được.",
    })
  }
  if (code === 190 || code === 102) {
    const reason =
      sub === 463
        ? "Token đã hết hạn."
        : sub === 460
          ? "Token mất hiệu lực do đổi mật khẩu."
          : sub === 458
            ? "Người dùng đã gỡ ứng dụng."
            : "Token không hợp lệ hoặc đã bị thu hồi."
    return make("auth_invalid", `Kết nối Meta không còn hợp lệ: ${reason} Hãy tạo token mới và cập nhật kết nối.`, {
      hint: "Tạo token mới (Graph API Explorer hoặc System User) rồi bấm “Thay token” trong trang kết nối.",
    })
  }
  if (code === 613 && sub === 1487632) {
    return make(
      "quota_exceeded",
      "Meta chỉ cho đổi ngân sách nhóm quảng cáo tối đa 4 lần mỗi giờ. Hãy thử lại sau.",
      { retryAfterMs: extra.retryAfterMs ?? 3_600_000 }
    )
  }
  if (code === 17 && sub === 1885172) {
    return make("quota_exceeded", "Giới hạn chi tiêu chiến dịch chỉ được đổi tối đa 10 lần mỗi ngày.")
  }
  if (code === 613 && sub === 1487225) {
    return make("quota_exceeded", "Tài khoản đã chạm giới hạn số quảng cáo được tạo. Hãy thử lại sau.")
  }
  if (isThrottleCode(code)) {
    return make(
      "rate_limited",
      "Meta đang giới hạn tần suất gọi API cho tài khoản này. Hãy thử lại sau ít phút.",
      { retryable: true, retryAfterMs: extra.retryAfterMs ?? 60_000, hint: "Đợi rồi gọi lại; không gọi dồn." }
    )
  }
  if (code === 368) {
    return make("rate_limited", "Meta tạm chặn thao tác này do nghi ngờ lạm dụng. Hãy thử lại sau.", {
      retryable: true,
      retryAfterMs: extra.retryAfterMs ?? 15 * 60_000,
    })
  }
  // 31 "This request requires the user to take a pending action" (e.g. subcode 3858385: Meta suspects unauthorized
  // access and blocks creating / editing ads until the account is verified in Ads Manager). Only the account owner can
  // clear it on Meta; retrying is useless and the token itself is still valid (not permission_denied: a health check
  // must not mark the connection invalid).
  if (code === 31) {
    return make(
      "action_required",
      userMsg ?? "Meta yêu cầu chủ tài khoản hoàn tất một bước xác thực trước khi tiếp tục (ví dụ xác thực bảo mật trong Trình quản lý quảng cáo).",
      {
        hint: "Không thử lại. Nhờ người sở hữu token (hoặc admin tài khoản quảng cáo / Business) đăng nhập Trình quản lý quảng cáo, làm theo yêu cầu xác thực của Meta, rồi thử lại. Không cần thay token.",
      }
    )
  }
  if (code === 10 || code === 294 || (code !== undefined && code >= 200 && code <= 299)) {
    return make(
      "permission_denied",
      userMsg ?? "Token không có quyền với tài sản này (thiếu quyền hoặc chưa được gán tài khoản quảng cáo/Trang).",
      { hint: "Gán tài khoản quảng cáo/Trang cho System User và kiểm tra quyền ads_management." }
    )
  }
  if (code === 2635) {
    return make("invalid_request", "Phiên bản Marketing API đang dùng đã ngừng hỗ trợ.", {
      hint: "Cập nhật META_API_VERSION lên phiên bản mới nhất.",
    })
  }
  if (code === 803 || (code === 100 && sub === 33)) {
    return make("not_found", "Không tìm thấy đối tượng (hoặc token không có quyền xem).", {
      hint: "Gọi ads_list_objects để lấy đúng id.",
    })
  }
  if (code === 100 && sub === 4834011) {
    return make(
      "invalid_request",
      userMsg ??
        "Chiến dịch không có ngân sách chiến dịch phải khai báo is_adset_budget_sharing_enabled (true/false).",
      { hint: "Truyền adset_budget_sharing khi tạo chiến dịch ABO." }
    )
  }
  if (code === 100 && sub === 1885183) {
    return make("invalid_request", userMsg ?? "Ứng dụng Meta đang ở chế độ Development nên không tạo được quảng cáo.", {
      hint: "Chuyển app sang chế độ Live trong App Dashboard.",
    })
  }
  // 100/2490408 "Optimization Goal Isn't Available" - seen with MESSAGING_PURCHASE_CONVERSION on a non-SALES campaign;
  // [L] probably also what an ineligible Page / ad account gets (meta.md §5 "Mua hàng qua tin nhắn"). Never retried.
  if (code === 100 && sub === 2490408) {
    const metaSays = sanitizeExternalLabel(userMsg, 300)
    return make(
      "invalid_request",
      "Mục tiêu tối ưu này không dùng được cho chiến dịch / Trang này (thường do objective của chiến dịch không cho phép mục tiêu đó)." +
        (metaSays ? ` Meta báo: ${metaSays}` : "") +
        " Nếu là MESSAGING_PURCHASE_CONVERSION (tối đa lượt mua qua tin nhắn): chiến dịch phải là OUTCOME_SALES và Trang / tài khoản quảng cáo phải đủ điều kiện - ít nhất 5 sự kiện mua hàng từ cuộc trò chuyện Messenger gửi về Meta trong 30 ngày (Conversions API cho nhắn tin doanh nghiệp, hoặc \"Tạo đơn\" trong Meta Business Suite).",
      {
        hint: "Đối chiếu optimization_goal với objective của chiến dịch. Với mua qua tin nhắn: kiểm tra trong Trình quản lý quảng cáo (Doanh số → Ứng dụng nhắn tin → chỉ chọn Messenger) có lựa chọn \"Tối đa hoá số lượt mua qua tin nhắn\" không; chưa có thì dùng optimization_goal CONVERSATIONS.",
      }
    )
  }
  // 100/1885272 [T 2026-11-12] budget below Meta's minimum - also returned when an AD is created in a live video ad set
  // whose budget is fine for normal ads (live ads need more); Meta's text names the minimum
  if (code === 100 && sub === 1885272) {
    const metaSays = sanitizeExternalLabel(userMsg, 300)
    return make("invalid_request", metaSays ? `Meta báo: ${metaSays}` : "Ngân sách thấp hơn mức tối thiểu của Meta.", {
      hint: "Tăng ngân sách của nhóm quảng cáo / chiến dịch bằng ads_update_budget (quảng cáo video trực tiếp cần ngân sách cao hơn quảng cáo thường), rồi thử lại.",
    })
  }
  // 100/1885760 [T 2026-11-12]: a campaign budget (CBO) with lowest cost needs the SAME optimization goal in every ad set
  if (code === 100 && sub === 1885760) {
    const metaSays = sanitizeExternalLabel(userMsg, 300)
    return make(
      "invalid_request",
      "Chiến dịch dùng ngân sách chiến dịch (CBO, chi phí thấp nhất): mọi nhóm quảng cáo phải cùng optimization_goal." +
        (metaSays ? ` Meta báo: ${metaSays}` : ""),
      {
        hint: "Dùng cùng optimization_goal với các nhóm đã có (xem bằng ads_list_objects level=ad_group), hoặc tạo chiến dịch mới bằng meta_create_campaign cho mục tiêu khác.",
      }
    )
  }
  // creative / ad edit errors (v1.1.4 E3, meta.md §5 "Đổi creative"): Vietnamese text + Meta's own message (one line)
  const creativeErr = (sub !== undefined ? CREATIVE_ERRORS[sub] : undefined) ?? (code !== undefined ? CREATIVE_ERRORS[code] : undefined)
  if (creativeErr) {
    const metaSays = sanitizeExternalLabel(userMsg, 300)
    return make("invalid_request", creativeErr.vi + (metaSays ? ` Meta báo: ${metaSays}` : ""), { hint: creativeErr.hint })
  }
  if (code === 1 || code === 2 || err?.is_transient) {
    return make("upstream_error", "Meta đang gặp lỗi tạm thời. Hãy thử lại sau.", { retryable: true })
  }
  if (code === 100 || code === 3858079 || code === 3858081 || sub === 3858079 || sub === 3858081) {
    return make("invalid_request", userMsg ?? `Meta từ chối yêu cầu: ${err?.message ?? "tham số không hợp lệ"}.`)
  }
  if (httpStatus >= 500) {
    return make("upstream_error", "Meta đang gặp lỗi máy chủ. Hãy thử lại sau.", { retryable: true })
  }
  if (httpStatus === 404) return make("not_found", "Không tìm thấy đối tượng trên Meta.")
  return make("unknown", userMsg ?? `Meta trả lỗi: ${err?.message ?? `HTTP ${httpStatus}`}.`)
}

interface BucUsageEntry {
  type?: string
  call_count?: number
  total_cputime?: number
  total_time?: number
  estimated_time_to_regain_access?: number
}

function parseJsonHeader(v: string | null): unknown {
  if (!v) return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/**
 * Read usage headers and cool the bucket down when Meta reports throttling or high utilisation.
 * Returns the suggested wait (ms) when throttled, else 0.
 */
export function applyUsageHeaders(headers: Headers, key: string): number {
  let waitMs = 0
  let maxPct = 0
  const buc = parseJsonHeader(headers.get("x-business-use-case-usage"))
  if (buc && typeof buc === "object") {
    for (const entries of Object.values(buc as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      for (const e of entries as BucUsageEntry[]) {
        maxPct = Math.max(maxPct, e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0)
        // estimated_time_to_regain_access is in minutes
        if (e.estimated_time_to_regain_access && e.estimated_time_to_regain_access > 0) {
          waitMs = Math.max(waitMs, e.estimated_time_to_regain_access * 60_000)
        }
      }
    }
  }
  const acc = parseJsonHeader(headers.get("x-ad-account-usage")) as {
    acc_id_util_pct?: number
    reset_time_duration?: number
  } | null
  if (acc && typeof acc === "object") {
    maxPct = Math.max(maxPct, acc.acc_id_util_pct ?? 0)
    if ((acc.acc_id_util_pct ?? 0) >= 100 && acc.reset_time_duration) {
      waitMs = Math.max(waitMs, acc.reset_time_duration * 1_000)
    }
  }
  const ins = parseJsonHeader(headers.get("x-fb-ads-insights-throttle")) as {
    app_id_util_pct?: number
    acc_id_util_pct?: number
  } | null
  if (ins && typeof ins === "object") {
    maxPct = Math.max(maxPct, ins.app_id_util_pct ?? 0, ins.acc_id_util_pct ?? 0)
  }
  const app = parseJsonHeader(headers.get("x-app-usage")) as {
    call_count?: number
    total_cputime?: number
    total_time?: number
  } | null
  if (app && typeof app === "object") {
    maxPct = Math.max(maxPct, app.call_count ?? 0, app.total_cputime ?? 0, app.total_time ?? 0)
  }
  if (waitMs === 0 && maxPct >= 100) waitMs = 60_000
  if (waitMs > 0) {
    coolDown(key, waitMs)
    return waitMs
  }
  // proactive slow-down above 75% utilisation
  if (maxPct >= 90) coolDown(key, 5_000)
  else if (maxPct >= 75) coolDown(key, 1_000)
  return 0
}

function retryDecision(req: GraphRequest) {
  return (res: HttpResponse): boolean => {
    if (!req.idempotent) return false
    const err = extractError(res.body)
    if (err) {
      if (isThrottleCode(err.code) || err.code === 368) return false // circuit breaker, never hammer
      if (req.insights && err.code === 1) return false // "reduce the amount of data" → caller switches to async
      return err.code === 1 || err.code === 2 || err.is_transient === true
    }
    return res.status >= 500
  }
}

/** Perform one Graph call and return the parsed body, or throw ProviderError. */
export async function graph<T = Record<string, unknown>>(ctx: MetaCallContext, req: GraphRequest): Promise<T> {
  const host = req.host === "video" ? META_VIDEO_HOST : META_GRAPH_HOST
  const path = req.path.replace(/^\/+/, "")
  const url = `${host}/${metaApiVersion()}/${path}`
  const key = bucketKey(ctx)
  const auth = authParams(ctx, req)
  const params = req.params ?? {}

  let query: Record<string, unknown> | undefined
  let body: URLSearchParams | FormData | undefined
  if (req.method === "GET") {
    query = { ...params, ...auth }
  } else {
    const form = req.multipart ? new FormData() : new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      if (v instanceof Blob && form instanceof FormData) {
        form.set(k, v)
        continue
      }
      form.set(k, encodeParam(v))
    }
    for (const [k, v] of Object.entries(auth)) form.set(k, v)
    body = form
  }

  let res: HttpResponse<unknown>
  try {
    res = await httpJson<unknown>({
      platform: "meta",
      method: req.method,
      url,
      query,
      body,
      headers: body instanceof URLSearchParams ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      signal: ctx.signal,
      timeoutMs: req.timeoutMs,
      retries: req.idempotent ? 2 : 0,
      retryOn: retryDecision(req),
      bucket: { key, spec: BUCKET_SPEC },
      onUpstream: ctx.onUpstream,
      requestIdHeader: "x-fb-trace-id",
      redactQueryKeys: ["input_token"],
    })
  } catch (e) {
    if (e instanceof RateLimitWaitError) {
      throw new ProviderError({
        platform: "meta",
        code: "rate_limited",
        message: e.message,
        userMessageVi: "Tài khoản quảng cáo này đang bị Meta giới hạn tần suất. Hãy thử lại sau ít phút.",
        retryable: true,
        retryAfterMs: e.retryAfterMs,
      })
    }
    throw e
  }

  const waitMs = applyUsageHeaders(res.headers, key)
  const err = extractError(res.body)
  if (err || res.status >= 400) {
    if (err) req.onGraphError?.(err)
    if (err && isThrottleCode(err.code)) {
      const ms = waitMs || 60_000
      coolDown(key, ms)
      throw mapGraphError(err, res.status, res.requestId, { retryAfterMs: ms })
    }
    throw mapGraphError(err, res.status, res.requestId)
  }
  if (res.body === null || typeof res.body !== "object") {
    throw new ProviderError({
      platform: "meta",
      code: "upstream_error",
      message: `Meta returned a non-JSON body (HTTP ${res.status})`,
      userMessageVi: "Meta trả về dữ liệu không đọc được.",
      retryable: true,
      upstream: { httpStatus: res.status, requestId: res.requestId },
    })
  }
  return res.body as T
}

export interface GraphPage<T> {
  data: T[]
  paging?: { cursors?: { before?: string; after?: string }; next?: string }
}

/** GET one page of an edge. Returns rows + the `after` cursor when more pages exist. */
export async function graphPage<T>(
  ctx: MetaCallContext,
  path: string,
  params: GraphParams,
  opts: { insights?: boolean } = {}
): Promise<{ data: T[]; after: string | null }> {
  const page = await graph<GraphPage<T>>(ctx, { method: "GET", path, params, idempotent: true, insights: opts.insights })
  const data = Array.isArray(page.data) ? page.data : []
  const after = page.paging?.next ? (page.paging.cursors?.after ?? null) : null
  return { data, after }
}

/** GET every page of an edge (bounded by maxItems). */
export async function graphAll<T>(
  ctx: MetaCallContext,
  path: string,
  params: GraphParams,
  maxItems = 5_000
): Promise<{ data: T[]; truncated: boolean }> {
  const out: T[] = []
  let after: string | null = null
  for (;;) {
    const page: { data: T[]; after: string | null } = await graphPage<T>(ctx, path, after ? { ...params, after } : params)
    out.push(...page.data)
    if (out.length >= maxItems) return { data: out.slice(0, maxItems), truncated: page.after !== null || out.length > maxItems }
    if (!page.after) return { data: out, truncated: false }
    after = page.after
  }
}

export interface BatchOp {
  method: "GET" | "POST"
  relative_url: string
  /** url-encoded body for POST */
  body?: string
}

export type BatchResult<T = Record<string, unknown>> = { ok: true; body: T } | { ok: false; error: ProviderError }

/** Graph batch API (≤50 ops per call). Each op is reported individually. */
export async function graphBatch<T = Record<string, unknown>>(
  ctx: MetaCallContext,
  ops: BatchOp[],
  opts: { idempotent?: boolean; pageAccessToken?: string } = {}
): Promise<BatchResult<T>[]> {
  const results: BatchResult<T>[] = []
  for (let i = 0; i < ops.length; i += 50) {
    const chunk = ops.slice(i, i + 50)
    const resp = await graph<unknown>(ctx, {
      method: "POST",
      path: "",
      params: { batch: chunk, include_headers: false },
      idempotent: opts.idempotent ?? false,
      pageAccessToken: opts.pageAccessToken,
    })
    const arr = Array.isArray(resp) ? resp : []
    for (let j = 0; j < chunk.length; j++) {
      const item = arr[j] as { code?: number; body?: string } | null | undefined
      if (!item) {
        results.push({
          ok: false,
          error: new ProviderError({
            platform: "meta",
            code: "timeout",
            message: "Batch operation returned no result",
            userMessageVi: "Meta không trả kết quả cho thao tác này (có thể chưa thực hiện).",
            retryable: true,
          }),
        })
        continue
      }
      let parsed: unknown = null
      try {
        parsed = item.body ? JSON.parse(item.body) : null
      } catch {
        parsed = item.body ?? null
      }
      const err = extractError(parsed)
      if (err || (item.code ?? 200) >= 400) {
        const mapped = mapGraphError(err, item.code ?? 500, null)
        // each batch op counts against the limits on its own - honour per-op throttling too
        if (mapped.code === "rate_limited") coolDown(bucketKey(ctx), mapped.retryAfterMs ?? 60_000)
        results.push({ ok: false, error: mapped })
      } else {
        results.push({ ok: true, body: (parsed ?? {}) as T })
      }
    }
  }
  return results
}

/** Validate ISO-8601 datetime WITH offset (Z or ±hh:mm). */
export function isIsoDateTimeWithOffset(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return false
  return Number.isFinite(Date.parse(s))
}
