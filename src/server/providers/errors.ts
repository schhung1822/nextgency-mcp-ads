import type { Platform } from "./types"

export type ProviderErrorCode =
  | "invalid_credentials_input"
  | "auth_invalid" // token revoked/expired/invalid → mark connection invalid
  | "permission_denied" // missing scope / not assigned to asset
  | "not_found"
  | "invalid_request" // bad params, validation rejected by platform
  | "rate_limited"
  | "quota_exceeded" // daily quota, do not retry soon
  | "unsupported" // capability not available on this platform/account
  | "feature_not_enabled" // gated feature (403/404 on OpenAI, allowlisted features…)
  | "conflict"
  | "timeout"
  | "upstream_error" // 5xx / transient
  | "unknown"

export interface UpstreamErrorInfo {
  code?: string | number | null
  subcode?: string | number | null
  message?: string | null
  requestId?: string | null
  httpStatus?: number | null
}

export class ProviderError extends Error {
  readonly platform: Platform
  readonly code: ProviderErrorCode
  readonly retryable: boolean
  /** Vietnamese, safe to show to users / AI */
  readonly userMessageVi: string
  readonly hint?: string
  readonly upstream?: UpstreamErrorInfo
  /** Retry-After in ms when known */
  readonly retryAfterMs?: number

  constructor(args: {
    platform: Platform
    code: ProviderErrorCode
    message: string
    userMessageVi: string
    retryable?: boolean
    hint?: string
    upstream?: UpstreamErrorInfo
    retryAfterMs?: number
    cause?: unknown
  }) {
    super(args.message, { cause: args.cause })
    this.name = "ProviderError"
    this.platform = args.platform
    this.code = args.code
    this.retryable = args.retryable ?? false
    this.userMessageVi = args.userMessageVi
    this.hint = args.hint
    this.upstream = args.upstream
    this.retryAfterMs = args.retryAfterMs
  }

  toJSON() {
    return {
      platform: this.platform,
      code: this.code,
      message: this.userMessageVi,
      hint: this.hint,
      retryable: this.retryable,
      upstream: this.upstream,
    }
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError
}

export function unsupported(platform: Platform, what: string): ProviderError {
  return new ProviderError({
    platform,
    code: "unsupported",
    message: `${platform}: ${what} is not supported`,
    userMessageVi: `Nền tảng này không hỗ trợ: ${what}.`,
  })
}
