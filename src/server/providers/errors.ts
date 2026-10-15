import type { FieldChange, Platform } from "./types"

export type ProviderErrorCode =
  | "invalid_credentials_input"
  | "auth_invalid" // token revoked/expired/invalid → mark connection invalid
  | "permission_denied" // missing scope / not assigned to asset
  | "action_required" // the account owner must act on the platform first (security checkpoint…); token still valid
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

/**
 * What the MCP call log must record for a FAILED write whose outcome is uncertain (e.g. a TikTok GMV Max create that
 * timed out and was not found): the logged error_code (instead of the error code) and the changes column. Never shown
 * to the client.
 */
export interface ProviderErrorAudit {
  errorCode: string
  changes: FieldChange[]
}

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
  /** log-only data of an uncertain write (ProviderErrorAudit) */
  readonly audit?: ProviderErrorAudit
  /**
   * Specific code shown to the AI instead of `code` (e.g. "video_processing", "video_failed") so it can react; `code`
   * keeps the generic class used for log status / retries.
   */
  readonly toolCode?: string

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
    audit?: ProviderErrorAudit
    toolCode?: string
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
    this.audit = args.audit
    this.toolCode = args.toolCode
  }

  toJSON() {
    return {
      platform: this.platform,
      code: this.toolCode ?? this.code,
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

/** The same provider error with log-only audit data (ProviderErrorAudit); a non-provider error is wrapped first. */
export function withErrorAudit(e: unknown, platform: Platform, audit: ProviderErrorAudit): ProviderError {
  const pe = isProviderError(e) ? e : null
  return new ProviderError({
    platform: pe?.platform ?? platform,
    code: pe?.code ?? "upstream_error",
    message: pe?.message ?? `network / unknown error: ${String(e)}`,
    userMessageVi: pe?.userMessageVi ?? "Lỗi mạng hoặc lỗi không xác định khi gọi nền tảng.",
    retryable: pe?.retryable ?? false,
    hint: pe?.hint,
    upstream: pe?.upstream,
    retryAfterMs: pe?.retryAfterMs,
    cause: pe?.cause ?? e,
    audit,
    toolCode: pe?.toolCode,
  })
}

export function unsupported(platform: Platform, what: string): ProviderError {
  return new ProviderError({
    platform,
    code: "unsupported",
    message: `${platform}: ${what} is not supported`,
    userMessageVi: `Nền tảng này không hỗ trợ: ${what}.`,
  })
}
