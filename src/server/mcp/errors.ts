// Business / permission errors raised inside tool handlers, and their mapping to tool results
// ({ isError: true, structuredContent: { code, message (VI), platform_error, hint } }).
import { redactString } from "../audit/redact"
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

  constructor(args: {
    code: string
    messageVi: string
    hint?: string
    logStatus?: CallLogStatus
    details?: Record<string, unknown>
  }) {
    super(args.messageVi)
    this.name = "McpToolError"
    this.code = args.code
    this.messageVi = args.messageVi
    this.hint = args.hint
    this.logStatus = args.logStatus ?? "error"
    this.details = args.details
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
  not_found: "Gọi ads_list_objects để lấy đúng id.",
  rate_limited: "Nền tảng đang giới hạn tần suất - thử lại sau ít phút.",
  quota_exceeded: "Đã hết hạn mức gọi API trong ngày của nền tảng - thử lại sau.",
  unsupported: "Thao tác này không có trên nền tảng/tài khoản này.",
}

/** Map anything thrown by a tool handler to a tool error payload. Never leaks internals. */
export function mapToolError(e: unknown): MappedError {
  if (e instanceof McpToolError) {
    return {
      payload: {
        code: e.code,
        message: e.messageVi,
        platform: null,
        platform_error: null,
        hint: e.hint ?? null,
        retryable: false,
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
        code: j.code,
        message: j.message,
        platform: j.platform,
        platform_error: platformError,
        hint: j.hint ?? PROVIDER_HINTS[j.code] ?? null,
        retryable: j.retryable,
      },
      logStatus: j.code === "permission_denied" ? "denied" : j.code === "invalid_request" ? "invalid_request" : "error",
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
  const msg = e instanceof Error ? e.message : String(e)
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
    logMessage: redactString(msg).slice(0, 2000),
    upstreamRequestId: null,
  }
}
