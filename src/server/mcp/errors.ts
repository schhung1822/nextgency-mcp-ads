// Business / permission errors raised inside tool handlers, and their mapping to tool results
// ({ isError: true, structuredContent: { code, message (VI), platform_error, hint } }).
import { redactString } from "../audit/redact"
import { safeErrorForLog } from "../audit/safe-error"
import { isProviderError } from "../providers/errors"
import type { Platform } from "../providers/types"

/** Status written to mcp_call_logs */
export type CallLogStatus =
  | "success"
  | "error"
  | "denied"
  | "rate_limited"
  | "pending_confirmation"
  | "invalid_request"

export class McpToolError extends Error {
  readonly code: string
  readonly messageVi: string
  readonly hint?: string
  readonly logStatus: CallLogStatus
  readonly details?: Record<string, unknown>
  /** seconds the caller should wait before retrying (write_rate_limited / write_cooldown) - returned as retry_after_seconds */
  readonly retryAfterSec?: number

  constructor(args: {
    code: string
    messageVi: string
    hint?: string
    logStatus?: CallLogStatus
    details?: Record<string, unknown>
    retryAfterSec?: number
  }) {
    super(args.messageVi)
    this.name = "McpToolError"
    this.code = args.code
    this.messageVi = args.messageVi
    this.hint = args.hint
    this.logStatus = args.logStatus ?? "error"
    this.details = args.details
    this.retryAfterSec = retryAfterSeconds(args.retryAfterSec) ?? undefined
  }
}

export function denied(code: string, messageVi: string, hint?: string) {
  return new McpToolError({ code, messageVi, hint, logStatus: "denied" })
}

export function invalid(code: string, messageVi: string, hint?: string) {
  return new McpToolError({ code, messageVi, hint, logStatus: "invalid_request" })
}

export interface PlatformErrorInfo {
  code: string | number | null
  subcode?: string | number | null
  message: string | null
  request_id: string | null
  http_status?: number | null
}

export interface ToolErrorPayload {
  [key: string]: unknown
  code: string
  message: string
  platform: Platform | null
  platform_error: PlatformErrorInfo | null
  hint: string | null
  retryable: boolean
  /** whole seconds to wait before retrying - only present when known (platform Retry-After, MCP write limits) */
  retry_after_seconds?: number
}

/** Longest retry_after_seconds returned (a TikTok daily quota waits until the next UTC midnight). */
export const MAX_RETRY_AFTER_SECONDS = 86_400

/** A positive whole number of seconds (rounded up, capped at MAX_RETRY_AFTER_SECONDS) or null. */
export function retryAfterSeconds(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null
  return Math.min(Math.ceil(v), MAX_RETRY_AFTER_SECONDS)
}

export interface MappedError {
  payload: ToolErrorPayload
  logStatus: CallLogStatus
  /** for logs only (redacted) */
  logMessage: string
  upstreamRequestId: string | null
}

const PROVIDER_HINTS: Partial<Record<string, string>> = {
  auth_invalid: "Token của kết nối đã hết hạn hoặc bị thu hồi - cập nhật token trong trang Kết nối của Ads MCP.",
  permission_denied: "Token thiếu quyền với tài sản này - kiểm tra quyền của app/token trên nền tảng.",
  action_required: "Chủ tài khoản cần hoàn tất yêu cầu của nền tảng (vd xác thực bảo mật) rồi thử lại - không thử lại tự động.",
  not_found: "Gọi ads_list_objects để lấy đúng id.",
  rate_limited: "Nền tảng đang giới hạn tần suất - thử lại sau ít phút.",
  quota_exceeded: "Đã hết hạn mức gọi API trong ngày của nền tảng - thử lại sau.",
  unsupported: "Thao tác này không có trên nền tảng/tài khoản này.",
}

/** mcp_call_logs status of a platform error (a platform rate limit / quota is "rate_limited", like the MCP limits). */
function providerLogStatus(code: string): CallLogStatus {
  if (code === "permission_denied" || code === "action_required") return "denied"
  if (code === "invalid_request") return "invalid_request"
  if (code === "rate_limited" || code === "quota_exceeded") return "rate_limited"
  return "error"
}

/**
 * Map anything thrown by a tool handler to a tool error payload. Never leaks internals: every text that reaches
 * the AI is redacted (provider messages can echo tokens / signed URLs).
 */
export function mapToolError(e: unknown): MappedError {
  if (e instanceof McpToolError) {
    return {
      payload: {
        code: e.code,
        message: redactString(e.messageVi),
        platform: null,
        platform_error: null,
        hint: e.hint ? redactString(e.hint) : null,
        // write_rate_limited / write_cooldown: nothing ran, the same call can be retried after the wait
        retryable: e.retryAfterSec !== undefined,
        ...(e.retryAfterSec !== undefined ? { retry_after_seconds: e.retryAfterSec } : {}),
        ...(e.details ? { details: e.details } : {}),
      },
      logStatus: e.logStatus,
      logMessage: e.messageVi,
      upstreamRequestId: null,
    }
  }
  if (isProviderError(e)) {
    const j = e.toJSON()
    const up = j.upstream
    const retryAfter = retryAfterSeconds(j.retry_after_seconds)
    const platformError: PlatformErrorInfo | null = up
      ? {
          code: up.code ?? null,
          subcode: up.subcode ?? null,
          message: up.message ? redactString(String(up.message)).slice(0, 1000) : null,
          request_id: up.requestId ?? null,
          http_status: up.httpStatus ?? null,
        }
      : null
    return {
      payload: {
        // the specific toolCode (video_processing…) is shown to the AI; hints and log status use the generic class
        code: j.code,
        message: redactString(j.message).slice(0, 1000),
        platform: j.platform,
        platform_error: platformError,
        hint: redactString(j.hint ?? PROVIDER_HINTS[e.code] ?? "").slice(0, 500) || null,
        retryable: j.retryable,
        ...(retryAfter !== null ? { retry_after_seconds: retryAfter } : {}),
      },
      logStatus: providerLogStatus(e.code),
      logMessage: redactString(`${e.message}${up?.message ? ` | ${up.message}` : ""}`).slice(0, 2000),
      upstreamRequestId: up?.requestId ?? null,
    }
  }
  if (e instanceof RangeError) {
    // dates.ts / money.ts throw RangeError with Vietnamese (dates) or technical (money) messages
    const vi = /[À-ỹ]/.test(e.message) ? e.message : "Giá trị không hợp lệ."
    return {
      payload: { code: "invalid_request", message: vi, platform: null, platform_error: null, hint: null, retryable: false },
      logStatus: "invalid_request",
      logMessage: redactString(e.message),
      upstreamRequestId: null,
    }
  }
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
    return {
      payload: {
        code: "timeout",
        message: "Yêu cầu bị huỷ hoặc quá thời gian chờ.",
        platform: null,
        platform_error: null,
        hint: "Thử lại với khoảng ngày ngắn hơn hoặc ít tài khoản hơn.",
        retryable: true,
      },
      logStatus: "error",
      logMessage: redactString(e.message),
      upstreamRequestId: null,
    }
  }
  return {
    payload: {
      code: "internal_error",
      message: "Lỗi hệ thống khi xử lý yêu cầu. Vui lòng thử lại sau.",
      platform: null,
      platform_error: null,
      hint: null,
      retryable: true,
    },
    logStatus: "error",
    // Drizzle errors carry the query params (ciphertext, args…): never the raw message
    logMessage: safeErrorForLog(e),
    upstreamRequestId: null,
  }
}
