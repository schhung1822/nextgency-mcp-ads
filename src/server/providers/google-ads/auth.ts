// Access-token minting for Google Ads without google-auth-library:
//  - service account: shared helper src/server/google/service-account.ts (self-signed RS256 JWT → jwt-bearer grant,
//    scope adwords). No `sub` claim (Google Ads accepts service accounts directly, no domain-wide delegation).
//  - OAuth: refresh_token grant.
// Tokens are cached in memory until 5 minutes before expiry, keyed by connection + credential identity (+ scope).
import {
  __clearGoogleTokenCache,
  getGoogleAccessTokenInfo,
  GoogleAuthError,
  invalidateGoogleAccessTokens,
  signGoogleJwt,
} from "../../google/service-account"
import { ProviderError } from "../errors"
import { httpJson } from "../http"
import type { UpstreamEvent } from "../types"
import { ADWORDS_SCOPE, GOOGLE_TOKEN_URL, credentialIdentity, type GoogleAdsCredentials, type OAuthRefreshTokenCredentials, type ServiceAccountCredentials } from "./credentials"

const EARLY_REFRESH_MS = 5 * 60_000

interface CachedToken {
  accessToken: string
  expiresAt: number
}

const cache = new Map<string, CachedToken>()
const inflight = new Map<string, Promise<CachedToken>>()

export interface TokenOptions {
  connectionId?: string
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
  /** ignore the cache (after OAUTH_TOKEN_EXPIRED) */
  forceRefresh?: boolean
  now?: () => number
}

export interface JwtClaims {
  iss: string
  scope: string
  aud: string
  iat: number
  exp: number
}

/** Build and sign the service-account assertion. `aud` is always Google's token endpoint (never token_uri from the JSON). */
export function signServiceAccountJwt(sa: Pick<ServiceAccountCredentials, "client_email" | "private_key" | "private_key_id">, nowMs = Date.now()): string {
  try {
    return signGoogleJwt({ clientEmail: sa.client_email, privateKey: sa.private_key, privateKeyId: sa.private_key_id }, [ADWORDS_SCOPE], nowMs)
  } catch (e) {
    throw invalidKeyError(e)
  }
}

function invalidKeyError(cause: unknown): ProviderError {
  return new ProviderError({
    platform: "google_ads",
    code: "auth_invalid",
    message: "Cannot sign service account JWT (invalid private_key)",
    userMessageVi: "Không ký được JWT: private_key trong file JSON của service account không hợp lệ.",
    hint: "Tải lại khóa JSON mới cho service account và dán lại toàn bộ nội dung.",
    cause,
  })
}

/** cache key of the shared service-account token cache (the helper adds key identity + scope) */
function saCacheKey(connectionId?: string): string {
  return `google_ads:${connectionId ?? "-"}`
}

/** Service accounts: shared helper (scope adwords); its neutral errors mapped to ProviderError as before. */
async function serviceAccountToken(creds: ServiceAccountCredentials, opts: TokenOptions): Promise<CachedToken> {
  try {
    return await getGoogleAccessTokenInfo(
      { clientEmail: creds.client_email, privateKey: creds.private_key, privateKeyId: creds.private_key_id, projectId: creds.project_id },
      [ADWORDS_SCOPE],
      {
        cacheKey: saCacheKey(opts.connectionId),
        signal: opts.signal,
        forceRefresh: opts.forceRefresh,
        now: opts.now,
        onExchange: opts.onUpstream
          ? (e) => opts.onUpstream!({ platform: "google_ads", method: e.method, url: e.url, status: e.status, durationMs: e.durationMs, requestId: e.requestId })
          : undefined,
      }
    )
  } catch (e) {
    if (!(e instanceof GoogleAuthError)) throw e
    if (e.code === "invalid_json") throw invalidKeyError(e)
    if (e.code === "network")
      throw new ProviderError({
        platform: "google_ads",
        code: e.timedOut ? "timeout" : "upstream_error",
        message: `POST ${GOOGLE_TOKEN_URL} failed: ${e.message}`,
        userMessageVi: e.timedOut ? "Nền tảng quảng cáo phản hồi quá chậm (hết thời gian chờ)." : "Không kết nối được tới nền tảng quảng cáo.",
        retryable: true,
        cause: e,
      })
    throw tokenError(creds, e.httpStatus ?? 0, { error: e.oauthError ?? undefined, error_description: e.detail ?? undefined }, e.requestId)
  }
}

function cacheKey(creds: GoogleAdsCredentials, connectionId?: string): string {
  return `${connectionId ?? "-"}|${credentialIdentity(creds)}`
}

/** Get a valid access token (cached). */
export async function getAccessToken(creds: GoogleAdsCredentials, opts: TokenOptions = {}): Promise<string> {
  const t = await getToken(creds, opts)
  return t.accessToken
}

export async function getToken(creds: GoogleAdsCredentials, opts: TokenOptions = {}): Promise<CachedToken> {
  if (creds.auth_type === "service_account") return serviceAccountToken(creds, opts)
  const now = opts.now ?? Date.now
  const key = cacheKey(creds, opts.connectionId)
  if (!opts.forceRefresh) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt - EARLY_REFRESH_MS > now()) return hit
  } else {
    cache.delete(key)
  }
  const pending = inflight.get(key)
  if (pending) return pending
  const p = mint(creds, opts, now)
    .then((t) => {
      cache.set(key, t)
      return t
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export function invalidateToken(creds: GoogleAdsCredentials, connectionId?: string) {
  if (creds.auth_type === "service_account") invalidateGoogleAccessTokens(saCacheKey(connectionId))
  else cache.delete(cacheKey(creds, connectionId))
}

/** test helper */
export function __clearTokenCache() {
  cache.clear()
  inflight.clear()
  __clearGoogleTokenCache()
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

/** OAuth refresh_token grant (service accounts go through serviceAccountToken). */
async function mint(creds: OAuthRefreshTokenCredentials, opts: TokenOptions, now: () => number): Promise<CachedToken> {
  const body = new URLSearchParams()
  body.set("grant_type", "refresh_token")
  body.set("client_id", creds.client_id)
  body.set("client_secret", creds.client_secret)
  body.set("refresh_token", creds.refresh_token)
  const res = await httpJson<TokenResponse>({
    platform: "google_ads",
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: opts.signal,
    onUpstream: opts.onUpstream,
    retries: 2,
    timeoutMs: 30_000,
    retryOn: (r) => r.status >= 500 || r.status === 429,
  })
  const b = (res.body && typeof res.body === "object" ? res.body : {}) as TokenResponse
  if (res.status === 200 && b.access_token) {
    const ttl = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 3600
    return { accessToken: b.access_token, expiresAt: now() + ttl * 1000 }
  }
  throw tokenError(creds, res.status, b, res.requestId)
}

export function tokenError(creds: GoogleAdsCredentials, status: number, b: TokenResponse, requestId: string | null): ProviderError {
  const err = b.error ?? `http_${status}`
  const desc = (b.error_description ?? "").slice(0, 300)
  const upstream = { code: err, message: desc || null, httpStatus: status, requestId }
  const isSa = creds.auth_type === "service_account"
  if (err === "invalid_grant") {
    return new ProviderError({
      platform: "google_ads",
      code: "auth_invalid",
      message: `Google token endpoint: invalid_grant ${desc}`,
      userMessageVi: isSa
        ? "Google từ chối khóa service account (invalid_grant): khóa đã bị xóa/vô hiệu hóa, service account bị tắt hoặc đồng hồ máy chủ bị lệch."
        : "Refresh token đã hết hạn hoặc bị thu hồi (invalid_grant). Hãy lấy refresh token mới và dán lại.",
      hint: isSa
        ? "Tạo khóa JSON mới cho service account và dán lại; kiểm tra giờ hệ thống máy chủ (NTP)."
        : "Bẫy 7 ngày: nếu OAuth consent screen đang ở trạng thái “Testing”, refresh token tự hết hạn sau 7 ngày - vào Google Cloud → OAuth consent screen → Publish app (In production) và xác minh thương hiệu (Verify Branding) rồi lấy token mới bằng `pnpm cli google:refresh-token`. Người dùng bị bắt buộc xác minh 2 bước cần đăng nhập bằng passkey (TOTP/SMS không được chấp nhận). Token cũng chết khi không dùng 6 tháng, bị thu hồi hoặc đổi mật khẩu. Khuyến nghị: chuyển sang service account để tránh hết hạn.",
      upstream,
    })
  }
  if (err === "invalid_client" || err === "unauthorized_client") {
    return new ProviderError({
      platform: "google_ads",
      code: "auth_invalid",
      message: `Google token endpoint: ${err} ${desc}`,
      userMessageVi: isSa
        ? "Service account không hợp lệ hoặc đã bị xóa/vô hiệu hóa."
        : "OAuth Client ID/Client secret không đúng, hoặc refresh token được cấp cho client khác.",
      hint: isSa ? "Kiểm tra service account còn tồn tại và đang bật trong Google Cloud." : "Dùng đúng client đã tạo refresh token.",
      upstream,
    })
  }
  if (err === "invalid_scope") {
    return new ProviderError({
      platform: "google_ads",
      code: "auth_invalid",
      message: `Google token endpoint: invalid_scope ${desc}`,
      userMessageVi: "Token không có quyền Google Ads (scope adwords).",
      hint: "Lấy lại refresh token với scope https://www.googleapis.com/auth/adwords.",
      upstream,
    })
  }
  const transient = status >= 500 || status === 429
  return new ProviderError({
    platform: "google_ads",
    code: transient ? "upstream_error" : "auth_invalid",
    message: `Google token endpoint error ${status}: ${err} ${desc}`,
    userMessageVi: transient ? "Máy chủ xác thực Google đang lỗi tạm thời, thử lại sau." : "Không lấy được access token Google.",
    retryable: transient,
    upstream,
  })
}
