// Low-level TikTok API for Business client.
// - Base https://business-api.tiktok.com/open_api/<version>/<path>/  (keep the trailing slash - without it TikTok
//   answers HTTP 308). Override with env TIKTOK_BASE_URL (https only), e.g. the sandbox
//   https://sandbox-ads.tiktok.com/open_api
// - Header `Access-Token` (not Authorization: Bearer)
// - GET params: arrays/objects JSON-encoded (http.buildUrl does this)
// - HTTP is almost always 200: the envelope `code` decides success (0 ok, 20001 partial success)
// Spec: .claude/docs/providers/tiktok.md §1, §6.
import { createHash, randomBytes } from "node:crypto"
import { ProviderError, type ProviderErrorCode } from "../errors"
import { httpJson, type HttpResponse } from "../http"
import { coolDown, RateLimitWaitError, type BucketSpec } from "../rate-limit"
import type { UpstreamEvent } from "../types"

/** Production base URL (default of env TIKTOK_BASE_URL). */
export const TIKTOK_BASE_URL = "https://business-api.tiktok.com/open_api"

/**
 * Base URL from env TIKTOK_BASE_URL (sandbox: https://sandbox-ads.tiktok.com/open_api), default production.
 * Only https:// without credentials/query is accepted - the access token is sent to this host.
 */
export function tiktokBaseUrl(): string {
  const raw = process.env.TIKTOK_BASE_URL?.trim()
  if (!raw) return TIKTOK_BASE_URL
  let u: URL | null = null
  try {
    u = new URL(raw)
  } catch {
    u = null
  }
  if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
    throw new ProviderError({
      platform: "tiktok",
      code: "unsupported",
      message: "Invalid TIKTOK_BASE_URL (https only)",
      userMessageVi: "Cấu hình TIKTOK_BASE_URL không hợp lệ - chỉ chấp nhận địa chỉ https:// (không kèm tham số).",
      hint: "Bỏ trống TIKTOK_BASE_URL để dùng máy chủ chính thức của TikTok.",
    })
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`
}

export function tiktokApiVersion(): string {
  return process.env.TIKTOK_API_VERSION ?? "v1.3"
}

/** "campaign/get" | "/campaign/get/" → "/campaign/get/" */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "")
  return `/${trimmed}/`
}

export function tiktokUrl(path: string): string {
  return `${tiktokBaseUrl()}/${tiktokApiVersion()}${normalizePath(path)}`
}

/** Client-side token bucket per developer app + endpoint (TikTok counts limits per app, per endpoint). */
export function bucketSpecFor(path: string): BucketSpec {
  const p = normalizePath(path)
  switch (p) {
    case "/ad/create/":
      return { ratePerSec: 5 }
    case "/campaign/copy/task/create/":
    case "/smart_plus/campaign/copy/task/create/":
      return { ratePerSec: 1 }
    case "/campaign/copy/task/check/":
    case "/smart_plus/campaign/copy/task/check/":
      return { ratePerSec: 2 }
    case "/report/task/create/":
      return { ratePerSec: 1 }
    default:
      return { ratePerSec: 10 }
  }
}

export function bucketKeyFor(appId: string | null | undefined, path: string): string {
  return `tiktok:${appId || "noapp"}:${normalizePath(path)}`
}

export interface TikTokEnvelope<T = unknown> {
  code?: number
  message?: string
  request_id?: string
  data?: T
}

export interface TikTokResult<T> {
  data: T
  code: number
  message: string
  requestId: string | null
  headers: Headers
}

export interface TikTokRequest {
  method: "GET" | "POST"
  path: string
  query?: Record<string, unknown>
  body?: unknown
  /** access token; null for endpoints that must not receive it (/oauth2/access_token/) */
  auth: string | null
  /** developer app id - rate-limit bucket key */
  appId?: string | null
  /** retries for transient errors. Default: 2 for GET, 0 for POST (caller opts in when the write is idempotent) */
  retries?: number
  /**
   * Create call carrying a request_id: retried ONLY on codes where TikTok certainly did not execute the request
   * (throttled: 40100/40133) and only while the request_id still deduplicates (see tiktokCreateRetryDecision).
   * Overrides `retries`.
   */
  create?: boolean
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
  timeoutMs?: number
}

const THROTTLE_COOLDOWN_MS = 5 * 60_000
const RETRYABLE_CODES = new Set([40133, 40202, 50000, 50002, 60001])

function isServerCode(code: number): boolean {
  return (code >= 50000 && code < 60000) || code === 60001
}

/** Decide whether a TikTok response should be retried (body code or HTTP status). */
export function tiktokRetryDecision(res: HttpResponse): boolean | number {
  if (res.status === 429 || res.status >= 500) return true
  const body = res.body as TikTokEnvelope | null
  const code = typeof body?.code === "number" ? body.code : null
  if (code === null) return false
  if (code === 40133) return 2_000 // per-advertiser throttle → short backoff
  if (RETRYABLE_CODES.has(code) || isServerCode(code)) return true
  return false
}

/** TikTok deduplicates a request_id for 10 s (create endpoints) - retries of a create stay inside this window. */
export const CREATE_RETRY_WINDOW_MS = 8_000
/** Throttle codes: the request was rejected before being processed → certainly not executed. */
const CREATE_NOT_EXECUTED = new Set([40100, 40133])

/**
 * Retry decision for creates (campaign/ad group/copy task): never on 5xx/timeouts/50000/40202 (the object may already
 * exist - the caller looks it up instead), only on 40100/40133 and only when the retry is sent within
 * CREATE_RETRY_WINDOW_MS of the first attempt (same request_id → deduplicated even if TikTok did run it).
 */
export function tiktokCreateRetryDecision(firstSentAt: number, now: () => number = Date.now): (res: HttpResponse) => boolean | number {
  return (res) => {
    const body = res.body as TikTokEnvelope | null
    const code = typeof body?.code === "number" ? body.code : null
    if (code === null || !CREATE_NOT_EXECUTED.has(code)) return false
    const delay = code === 40133 ? 2_000 : 1_000
    // + 400 ms jitter added by httpJson
    return now() - firstSentAt + delay + 400 < CREATE_RETRY_WINDOW_MS ? delay : false
  }
}

/** Perform one TikTok API call and unwrap the envelope. Throws ProviderError on any non-0/20001 code. */
export async function tiktokRequest<T = unknown>(req: TikTokRequest): Promise<TikTokResult<T>> {
  const path = normalizePath(req.path)
  const url = tiktokUrl(path)
  const headers: Record<string, string> = {}
  if (req.auth !== null) {
    if (!req.auth) {
      throw new ProviderError({
        platform: "tiktok",
        code: "auth_invalid",
        message: "Missing TikTok access token",
        userMessageVi: "Thiếu access token TikTok.",
      })
    }
    headers["Access-Token"] = req.auth
  }
  const bucketKey = bucketKeyFor(req.appId, path)
  const events: UpstreamEvent[] = []
  let res: HttpResponse<TikTokEnvelope<T> | string | null>
  try {
    res = await httpJson<TikTokEnvelope<T> | string | null>({
      platform: "tiktok",
      method: req.method,
      url,
      headers,
      query: req.query,
      body: req.method === "POST" ? (req.body ?? {}) : undefined,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      retries: req.create ? 2 : (req.retries ?? (req.method === "GET" ? 2 : 0)),
      retryOn: req.create ? tiktokCreateRetryDecision(Date.now()) : tiktokRetryDecision,
      bucket: { key: bucketKey, spec: bucketSpecFor(path) },
      requestIdHeader: "x-tt-logid",
      redactQueryKeys: ["secret", "auth_code"],
      onUpstream: (e) => events.push(e),
    })
  } catch (e) {
    for (const ev of events) req.onUpstream?.(ev)
    if (e instanceof RateLimitWaitError) {
      throw new ProviderError({
        platform: "tiktok",
        code: "rate_limited",
        message: `TikTok client-side rate limit busy for ${path}`,
        userMessageVi: "Đang chạm giới hạn tần suất gọi API TikTok cho thao tác này. Hãy thử lại sau ít phút.",
        retryable: true,
        retryAfterMs: e.retryAfterMs,
      })
    }
    throw e
  }
  const body = res.body && typeof res.body === "object" ? (res.body as TikTokEnvelope<T>) : null
  const requestId = (body?.request_id as string | undefined) ?? res.requestId ?? null
  events.forEach((ev, i) => req.onUpstream?.(i === events.length - 1 ? { ...ev, requestId } : ev))

  if (!body || typeof body.code !== "number") {
    const hint =
      res.status === 404 ? "Kiểm tra đường dẫn endpoint (TikTok yêu cầu dấu / ở cuối URL)." : undefined
    throw new ProviderError({
      platform: "tiktok",
      code: res.status >= 500 ? "upstream_error" : res.status === 404 ? "not_found" : "unknown",
      message: `TikTok ${req.method} ${path} returned HTTP ${res.status} without an API envelope`,
      userMessageVi: "TikTok trả về phản hồi không đúng định dạng.",
      retryable: res.status >= 500,
      hint,
      upstream: { httpStatus: res.status, requestId },
    })
  }
  if (body.code !== 0 && body.code !== 20001) {
    const err = mapTikTokError(body.code, body.message ?? "", requestId, res.status)
    if (body.code === 40100 || body.code === 40016) {
      coolDown(bucketKey, err.retryAfterMs ?? THROTTLE_COOLDOWN_MS)
    }
    throw err
  }
  return {
    data: (body.data ?? ({} as T)) as T,
    code: body.code,
    message: body.message ?? "OK",
    requestId,
    headers: res.headers,
  }
}

function msUntilNextUtcMidnight(now = Date.now()): number {
  const d = new Date(now)
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return next - now
}

interface CodeInfo {
  code: ProviderErrorCode
  vi: string
  retryable?: boolean
  hint?: string
}

const SCOPE_HINT =
  "Bật thêm scope cho developer app (Ad Account Mgmt, Ads Mgmt, Reporting, Creative, Pixel) rồi cho advertiser cấp quyền lại."

function codeInfo(code: number, message: string): CodeInfo {
  switch (code) {
    case 40000:
    case 40002:
    case 40009:
    case 40010:
    case 40014:
    case 40065:
    case 40700:
    case 41002:
      return { code: "invalid_request", vi: "Tham số gửi lên TikTok không hợp lệ." }
    case 40011:
      return {
        code: "invalid_request",
        vi: "Danh sách id gửi lên TikTok quá dài hoặc không hợp lệ.",
        hint: "Hãy chia nhỏ danh sách id (mỗi lần ít id hơn) rồi thử lại.",
      }
    case 40006:
    case 40051:
      return {
        code: "unsupported",
        vi: "Endpoint/phiên bản API TikTok này không khả dụng cho app hoặc tài khoản.",
        hint: "Kiểm tra TIKTOK_API_VERSION (mặc định v1.3) và quyền của developer app.",
      }
    case 40008:
    case 41001:
      return { code: "unsupported", vi: "Endpoint TikTok này không khả dụng." }
    case 40001:
    case 40125:
    case 40119:
    case 40124:
      return {
        code: "permission_denied",
        vi: "Token TikTok không có quyền thực hiện thao tác này (thiếu scope hoặc không được gán tài sản).",
        hint: SCOPE_HINT,
      }
    case 40102:
    case 40104:
    case 40105:
    case 40106:
      return {
        code: "auth_invalid",
        vi: "Access token TikTok không hợp lệ hoặc đã bị thu hồi. Hãy kết nối lại.",
        hint: "Cho advertiser cấp quyền lại và dán access token mới.",
      }
    case 40101:
    case 40113:
      return {
        code: "auth_invalid",
        vi: "App ID hoặc Secret TikTok không đúng (hoặc app đã bị khoá).",
        hint: "Kiểm tra App ID/Secret tại My Apps → App Detail → Basic Information.",
      }
    case 40110:
    case 40115:
    case 40116:
      return {
        code: "invalid_request",
        vi: "auth_code không hợp lệ, đã dùng hoặc đã hết hạn (auth_code chỉ sống 1 giờ và dùng 1 lần).",
        hint: "Mở lại Advertiser authorization URL để lấy auth_code mới.",
      }
    case 40007:
    case 40300:
    case 40301:
    case 40905:
      return { code: "not_found", vi: "Không tìm thấy đối tượng trên TikTok.", hint: "Gọi ads_list_objects để lấy đúng id." }
    case 40100:
    case 40016:
      return {
        code: /QPD|per day|daily/i.test(message) ? "quota_exceeded" : "rate_limited",
        vi: "Developer app đã chạm giới hạn tần suất của TikTok cho thao tác này. Đã tạm dừng gọi endpoint này 5 phút.",
        retryable: true,
      }
    case 40133:
    case 40132:
      return {
        code: "rate_limited",
        vi: "Tài khoản quảng cáo đang bị TikTok giới hạn tần suất gọi API. Hãy thử lại sau ít phút.",
        retryable: true,
      }
    case 40118:
      return {
        code: "feature_not_enabled",
        vi: "Tính năng này chưa được TikTok mở cho app/tài khoản (cần allowlist qua đại diện TikTok).",
      }
    case 40202:
      return { code: "conflict", vi: "Xung đột ghi dữ liệu trên TikTok. Hãy thử lại.", retryable: true }
    case 40050:
      return { code: "conflict", vi: "Yêu cầu trùng lặp (cùng request_id) - TikTok đã xử lý yêu cầu trước đó." }
    case 40201:
      return { code: "conflict", vi: "Tác vụ TikTok chưa sẵn sàng.", retryable: true }
    case 40901:
      return { code: "conflict", vi: "Video đang được TikTok chuyển mã. Hãy thử lại sau.", retryable: true }
    case 40911:
      return { code: "conflict", vi: "Tên file đã tồn tại trong tài khoản quảng cáo." }
    case 40502:
      return { code: "quota_exceeded", vi: "Đã đạt số lượng quảng cáo tối đa (50 quảng cáo/nhóm)." }
    case 40902:
    case 40903:
    case 40912:
    case 40913:
      return { code: "invalid_request", vi: "TikTok không tải được file từ URL đã cung cấp.", retryable: true }
    case 40900:
      return {
        code: "invalid_request",
        vi: "Mã kiểm tra MD5 (signature) không khớp với dữ liệu file đã gửi.",
        retryable: true,
      }
    case 40904:
    case 40906:
    case 40907:
    case 40908:
    case 40910:
    case 40914:
    case 40915:
      return { code: "invalid_request", vi: "File không hợp lệ hoặc không đúng yêu cầu của TikTok." }
    case 41000:
      return { code: "permission_denied", vi: "IP máy chủ nằm trong danh sách quốc gia bị TikTok chặn." }
    default:
      if (isServerCode(code)) {
        return { code: "upstream_error", vi: "TikTok đang gặp lỗi hệ thống hoặc bảo trì. Hãy thử lại sau.", retryable: true }
      }
      return { code: "unknown", vi: "TikTok trả về lỗi." }
  }
}

/** Map a TikTok envelope error code to a normalized ProviderError (never includes credentials). */
export function mapTikTokError(
  code: number,
  message: string,
  requestId: string | null = null,
  httpStatus: number | null = 200
): ProviderError {
  const info = codeInfo(code, message)
  let retryAfterMs: number | undefined
  if (code === 40100 || code === 40016) {
    retryAfterMs = info.code === "quota_exceeded" ? msUntilNextUtcMidnight() : THROTTLE_COOLDOWN_MS
  } else if (code === 40133 || code === 40132) {
    retryAfterMs = 10_000
  }
  const safeMessage = (message || "").slice(0, 500)
  return new ProviderError({
    platform: "tiktok",
    code: info.code,
    message: `TikTok error ${code}: ${safeMessage}`,
    userMessageVi: safeMessage ? `${info.vi} (TikTok: ${safeMessage})` : info.vi,
    retryable: info.retryable ?? false,
    hint: info.hint,
    retryAfterMs,
    upstream: { code, message: safeMessage, requestId, httpStatus },
  })
}

// ---------------------------------------------------------------------------
// Request ids (idempotency) - string of a positive int64
// ---------------------------------------------------------------------------


const INT63_MASK = (BigInt(1) << BigInt(63)) - BigInt(1)

function bytesToInt63(buf: Buffer): string {
  let v = BigInt(0)
  for (let i = 0; i < 8; i++) v = (v << BigInt(8)) | BigInt(buf[i]!)
  v = v & INT63_MASK
  if (v === BigInt(0)) v = BigInt(1)
  return v.toString()
}

/**
 * TikTok `request_id` (int64 as string). Deterministic when derived from an idempotency key
 * (same key + salt → same id, so a client retry within TikTok's 10-second window is deduplicated);
 * random otherwise.
 */
export function makeRequestId(idempotencyKey?: string | null, salt = ""): string {
  if (idempotencyKey) {
    if (!salt && /^\d{1,18}$/.test(idempotencyKey) && BigInt(idempotencyKey) > BigInt(0)) return idempotencyKey
    return bytesToInt63(createHash("sha256").update(`${idempotencyKey}\u0000${salt}`).digest())
  }
  return bytesToInt63(randomBytes(8))
}
