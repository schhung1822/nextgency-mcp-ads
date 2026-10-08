// Google Ads REST error parsing: both GoogleAdsFailure details and google.rpc.ErrorInfo (infrastructure).
// https://developers.google.com/google-ads/api/docs/best-practices/understand-api-errors
import { ProviderError, type ProviderErrorCode } from "../errors"

export interface GoogleAdsErrorItem {
  /** e.g. { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" } */
  errorCode?: Record<string, string>
  message?: string
  trigger?: unknown
  location?: { fieldPathElements?: { fieldName?: string; index?: number }[] }
  details?: { quotaErrorDetails?: { retryDelay?: string; rateScope?: string; rateName?: string } } & Record<string, unknown>
}

export interface ParsedGoogleError {
  httpStatus: number
  status: string | null
  message: string
  /** "quotaError.RESOURCE_EXHAUSTED" */
  codes: string[]
  errors: GoogleAdsErrorItem[]
  /** google.rpc.ErrorInfo reasons (SERVICE_DISABLED, ACCESS_TOKEN_EXPIRED…) */
  reasons: string[]
  retryDelayMs: number | null
  requestId: string | null
}

interface RestErrorBody {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: Record<string, unknown>[]
  }
}

/** "30s" / "1.5s" → ms */
export function parseDuration(v: unknown): number | null {
  if (typeof v !== "string") return null
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim())
  return m ? Math.round(Number(m[1]) * 1000) : null
}

export function errorCodeString(code: Record<string, string> | undefined): string | null {
  if (!code) return null
  const [k, v] = Object.entries(code)[0] ?? []
  return k ? `${k}.${v}` : null
}

/** Parse google.rpc.Status shaped details (also used for partialFailureError). */
export function parseFailureDetails(details: Record<string, unknown>[] | undefined): {
  errors: GoogleAdsErrorItem[]
  reasons: string[]
  retryDelayMs: number | null
  requestId: string | null
} {
  const errors: GoogleAdsErrorItem[] = []
  const reasons: string[] = []
  let retryDelayMs: number | null = null
  let requestId: string | null = null
  for (const d of details ?? []) {
    const type = String(d["@type"] ?? "")
    if (type.endsWith("GoogleAdsFailure")) {
      for (const e of (d.errors as GoogleAdsErrorItem[] | undefined) ?? []) {
        errors.push(e)
        const rd = parseDuration(e.details?.quotaErrorDetails?.retryDelay)
        if (rd !== null) retryDelayMs = Math.max(retryDelayMs ?? 0, rd)
      }
      if (typeof d.requestId === "string") requestId = d.requestId
    } else if (type.endsWith("google.rpc.ErrorInfo")) {
      if (typeof d.reason === "string") reasons.push(d.reason)
    } else if (type.endsWith("google.rpc.RetryInfo")) {
      const rd = parseDuration(d.retryDelay)
      if (rd !== null) retryDelayMs = Math.max(retryDelayMs ?? 0, rd)
    }
  }
  return { errors, reasons, retryDelayMs, requestId }
}

export function parseGoogleError(httpStatus: number, body: unknown, headerRequestId: string | null): ParsedGoogleError {
  const b = (body && typeof body === "object" ? body : {}) as RestErrorBody
  const err = b.error ?? {}
  const parsed = parseFailureDetails(err.details)
  return {
    httpStatus,
    status: err.status ?? null,
    message: typeof err.message === "string" ? err.message : typeof body === "string" ? body.slice(0, 300) : `HTTP ${httpStatus}`,
    codes: parsed.errors.map((e) => errorCodeString(e.errorCode)).filter((x): x is string => !!x),
    errors: parsed.errors,
    reasons: parsed.reasons,
    retryDelayMs: parsed.retryDelayMs,
    requestId: parsed.requestId ?? headerRequestId,
  }
}

function fieldPath(e: GoogleAdsErrorItem): string {
  const els = e.location?.fieldPathElements ?? []
  return els.map((x) => (x.index !== undefined ? `${x.fieldName}[${x.index}]` : x.fieldName)).join(".")
}

export function summarizeErrors(errors: GoogleAdsErrorItem[], max = 5): string {
  return errors
    .slice(0, max)
    .map((e) => {
      const p = fieldPath(e)
      return `${errorCodeString(e.errorCode) ?? "error"}: ${(e.message ?? "").slice(0, 200)}${p ? ` (${p})` : ""}`
    })
    .join("; ")
}

/** Whether the request should be retried (decided from the raw response, before mapping). */
export function retryDecision(p: ParsedGoogleError, idempotent: boolean): boolean | number {
  const has = (c: string) => p.codes.includes(c)
  // Rejected before execution → always safe to retry.
  if (has("quotaError.RESOURCE_TEMPORARILY_EXHAUSTED") || has("quotaError.EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION")) {
    return p.retryDelayMs ?? 5_000
  }
  if (has("quotaError.RESOURCE_EXHAUSTED")) return false
  // Transaction aborted → nothing applied → safe to retry.
  if (has("databaseError.CONCURRENT_MODIFICATION")) return p.retryDelayMs ?? 2_000
  if (p.httpStatus === 429) return p.reasons.includes("RATE_LIMIT_EXCEEDED") ? p.retryDelayMs ?? 5_000 : false
  if (!idempotent) return false
  if (p.httpStatus === 409 && p.status === "ABORTED") return p.retryDelayMs ?? 2_000
  if (has("internalError.TRANSIENT_ERROR") || has("internalError.INTERNAL_ERROR") || has("internalError.DEADLINE_EXCEEDED")) return true
  return p.httpStatus === 500 || p.httpStatus === 502 || p.httpStatus === 503 || p.httpStatus === 504
}

/** Token expired/invalid → caller should mint a fresh token and retry once. */
export function isExpiredTokenError(p: ParsedGoogleError): boolean {
  if (p.codes.some((c) => c === "authenticationError.OAUTH_TOKEN_EXPIRED" || c === "authenticationError.OAUTH_TOKEN_INVALID")) return true
  if (p.reasons.includes("ACCESS_TOKEN_EXPIRED")) return true
  return p.httpStatus === 401 && p.status === "UNAUTHENTICATED" && p.codes.length === 0
}

interface Mapping {
  code: ProviderErrorCode
  vi: string
  hint?: string
  retryable?: boolean
}

const CODE_MAP: Record<string, Mapping> = {
  "quotaError.RESOURCE_TEMPORARILY_EXHAUSTED": {
    code: "rate_limited",
    vi: "Google Ads đang giới hạn tần suất gọi API cho tài khoản/project này. Thử lại sau ít phút.",
    retryable: true,
  },
  "quotaError.EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION": {
    code: "rate_limited",
    vi: "Truy vấn tốn quá nhiều tài nguyên trong thời gian ngắn. Thử lại sau hoặc thu hẹp khoảng ngày.",
    retryable: true,
  },
  "quotaError.EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION": {
    code: "quota_exceeded",
    vi: "Truy vấn tốn quá nhiều tài nguyên trong thời gian dài. Hãy giảm tần suất/khối lượng truy vấn.",
  },
  "quotaError.RESOURCE_EXHAUSTED": {
    code: "quota_exceeded",
    vi: "Đã hết hạn mức thao tác Google Ads API trong 24 giờ của Cloud project (Explorer: 2.880 thao tác/ngày, Basic: 15.000).",
    hint: "Hạn mức tính theo 24 giờ trượt - chờ vài giờ rồi thử lại, hoặc xin nâng mức Basic/Standard cho project.",
  },
  "quotaError.ACCESS_PROHIBITED": {
    code: "permission_denied",
    vi: "Cloud project bị cấm truy cập Google Ads API.",
  },
  "authenticationError.OAUTH_TOKEN_EXPIRED": { code: "auth_invalid", vi: "Access token Google đã hết hạn." },
  "authenticationError.OAUTH_TOKEN_INVALID": { code: "auth_invalid", vi: "Access token Google không hợp lệ." },
  "authenticationError.OAUTH_TOKEN_REVOKED": {
    code: "auth_invalid",
    vi: "Quyền truy cập Google đã bị thu hồi.",
    hint: "Lấy refresh token mới (hoặc khóa service account mới) và dán lại.",
  },
  "authenticationError.OAUTH_TOKEN_DISABLED": { code: "auth_invalid", vi: "Token Google đã bị vô hiệu hóa." },
  "authenticationError.NOT_ADS_USER": {
    code: "permission_denied",
    vi: "Tài khoản Google/service account này chưa được thêm vào Google Ads.",
    hint: "Trong Google Ads (ưu tiên MCC): Admin → Access and security → Users → thêm email service account với quyền Standard.",
  },
  "authenticationError.CUSTOMER_NOT_FOUND": { code: "not_found", vi: "Không tìm thấy tài khoản Google Ads (customer ID sai?)." },
  "authenticationError.CLIENT_CUSTOMER_ID_INVALID": { code: "invalid_request", vi: "Customer ID không hợp lệ." },
  "authenticationError.TWO_STEP_VERIFICATION_NOT_ENROLLED": {
    code: "auth_invalid",
    vi: "Tài khoản Google chưa bật xác minh 2 bước nên không dùng được API.",
    hint: "Bật xác minh 2 bước bằng passkey (Google Ads không chấp nhận TOTP/SMS cho người dùng bị bắt buộc; passkey mới có thể cần tới 7 ngày), hoặc chuyển sang service account.",
  },
  "authorizationError.USER_PERMISSION_DENIED": {
    code: "permission_denied",
    vi: "Không có quyền truy cập tài khoản Google Ads này.",
    hint: "Nếu quyền được cấp qua tài khoản người quản lý (MCC), hãy điền login_customer_id = ID của MCC trong cấu hình kết nối; đồng thời kiểm tra email đã được thêm làm user.",
  },
  "authorizationError.INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION": {
    code: "permission_denied",
    vi: "login_customer_id (MCC) không quản lý tài khoản này.",
    hint: "Sửa login_customer_id thành MCC thực sự quản lý tài khoản, hoặc để trống nếu truy cập trực tiếp.",
  },
  "authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION": {
    code: "permission_denied",
    vi: "Cloud project chưa được duyệt truy cập tài khoản thật (đang ở mức Test).",
    hint: "Mức truy cập thuộc Cloud project của OAuth client/service account: Google Cloud → Google Ads API → Overview → “Upgrade access level” → xin mức Explorer (thường duyệt tự động). Project dùng billing dùng thử (free trial) bị từ chối; nếu project được nâng cấp sau 09/09/2026 vẫn không được duyệt, hãy dùng một Cloud project mới.",
  },
  "authorizationError.ACTION_NOT_PERMITTED": {
    code: "permission_denied",
    vi: "Mức truy cập API hiện tại của Cloud project không cho phép thao tác này.",
    hint: "Xin mức Explorer/Basic cho project trong Google Cloud → Google Ads API → Overview → “Upgrade access level”.",
  },
  "authorizationError.DEVELOPER_TOKEN_NOT_APPROVED": {
    code: "permission_denied",
    vi: "Quyền truy cập API chưa được duyệt cho tài khoản thật.",
    hint: "Developer token đã bị bỏ - mức truy cập nay thuộc Cloud project của OAuth client/service account: xin mức Explorer trong Google Cloud → Google Ads API → Overview. Project dùng billing dùng thử bị từ chối; project nâng cấp sau 09/09/2026 không được duyệt thì dùng Cloud project mới.",
  },
  "authorizationError.PROJECT_DISABLED": {
    code: "feature_not_enabled",
    vi: "Cloud project đã bị vô hiệu hóa hoặc chưa bật Google Ads API.",
    hint: "Bật Google Ads API trong Google Cloud Console (APIs & Services → Library).",
  },
  "authorizationError.CUSTOMER_NOT_ENABLED": {
    code: "permission_denied",
    vi: "Tài khoản Google Ads chưa kích hoạt xong hoặc đã bị hủy/đình chỉ.",
  },
  "authorizationError.ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT": {
    code: "permission_denied",
    vi: "Tài khoản Google Ads đang bị đình chỉ nên không thể thay đổi.",
  },
  "authorizationError.METRIC_ACCESS_DENIED": { code: "permission_denied", vi: "Không có quyền xem chỉ số này." },
  "mutateError.EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED": {
    code: "invalid_request",
    vi: "Tài khoản còn chiến dịch chưa khai báo có/không chứa quảng cáo chính trị EU nên Google chặn mọi thay đổi chiến dịch.",
    hint: "Khai báo ở cấp tài khoản trong giao diện Google Ads (cài đặt tài khoản) hoặc gọi tool google_ads_declare_eu_political cho từng chiến dịch, rồi thử lại.",
  },
  "criterionError.MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION": {
    code: "invalid_request",
    vi: "Tài khoản chưa tự khai báo có/không chứa quảng cáo chính trị EU nên Google từ chối thay đổi nhắm mục tiêu này.",
    hint: "Khai báo ở cấp tài khoản trong giao diện Google Ads (cài đặt tài khoản), rồi thử lại. Trạng thái khai báo xem được qua customer.contains_eu_political_advertising.",
  },
  "contextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT": {
    code: "invalid_request",
    vi: "Google Ads không cho phép thao tác này trong ngữ cảnh hiện tại (vd từ 30/09/2026 chiến dịch Tìm kiếm không còn nhắm mục tiêu ngôn ngữ thủ công).",
    hint: "Bỏ phần nhắm mục tiêu ngôn ngữ (Google tự xác định ngôn ngữ) hoặc thao tác trong giao diện Google Ads.",
  },
  "videoCampaignError.MUTATE_REQUIRES_RESERVATION": {
    code: "unsupported",
    vi: "Chiến dịch Video (YouTube) chỉ xem được qua API - hãy chỉnh trong Google Ads.",
  },
  "operationAccessDeniedError.OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE": {
    code: "unsupported",
    vi: "Loại chiến dịch này không cho phép thao tác qua API (vd chiến dịch Video/YouTube chỉ xem được).",
    hint: "Thao tác trực tiếp trong giao diện Google Ads.",
  },
  "campaignBudgetError.BUDGET_BELOW_DAILY_MINIMUM": {
    code: "invalid_request",
    vi: "Ngân sách thấp hơn mức tối thiểu hằng ngày của Google Ads (Demand Gen: tối thiểu tương đương 5 USD/ngày từ 01/04/2026).",
    hint: "Tăng ngân sách ngày (hoặc ngân sách trọn đời chia theo số ngày) rồi thử lại.",
  },
  "mutateError.RESOURCE_NOT_FOUND": { code: "not_found", vi: "Không tìm thấy đối tượng cần sửa. Gọi ads_list_objects để lấy đúng id." },
  "requestError.RESOURCE_NOT_FOUND": { code: "not_found", vi: "Không tìm thấy đối tượng. Gọi ads_list_objects để lấy đúng id." },
  "requestError.INVALID_PAGE_TOKEN": { code: "invalid_request", vi: "Cursor phân trang không hợp lệ - hãy truy vấn lại từ đầu." },
  "requestError.EXPIRED_PAGE_TOKEN": { code: "invalid_request", vi: "Cursor phân trang đã hết hạn - hãy truy vấn lại từ đầu." },
  "requestError.CANNOT_BE_EXECUTED_BY_MANAGER_ACCOUNT": {
    code: "invalid_request",
    vi: "Không thể thực hiện thao tác này trên tài khoản người quản lý (MCC). Hãy chọn tài khoản con.",
  },
  "queryError.REQUESTED_METRICS_FOR_MANAGER": {
    code: "invalid_request",
    vi: "Tài khoản người quản lý (MCC) không có số liệu quảng cáo. Hãy chọn từng tài khoản con.",
  },
  "databaseError.CONCURRENT_MODIFICATION": {
    code: "conflict",
    vi: "Đối tượng đang được sửa đồng thời bởi thao tác khác. Thử lại sau vài giây.",
    retryable: true,
  },
  "internalError.INTERNAL_ERROR": { code: "upstream_error", vi: "Google Ads API lỗi nội bộ tạm thời.", retryable: true },
  "internalError.TRANSIENT_ERROR": { code: "upstream_error", vi: "Google Ads API lỗi tạm thời.", retryable: true },
  "internalError.DEADLINE_EXCEEDED": { code: "timeout", vi: "Google Ads API xử lý quá lâu.", retryable: true },
}

const REASON_MAP: Record<string, Mapping> = {
  SERVICE_DISABLED: {
    code: "feature_not_enabled",
    vi: "Google Ads API chưa được bật trong Cloud project.",
    hint: "Google Cloud Console → APIs & Services → Library → Google Ads API → Enable, đợi vài phút rồi thử lại.",
  },
  ACCESS_TOKEN_EXPIRED: { code: "auth_invalid", vi: "Access token Google đã hết hạn." },
  CREDENTIALS_MISSING: { code: "auth_invalid", vi: "Thiếu thông tin xác thực Google." },
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: {
    code: "auth_invalid",
    vi: "Token không có scope Google Ads (adwords).",
    hint: "Lấy lại refresh token với scope https://www.googleapis.com/auth/adwords.",
  },
  RATE_LIMIT_EXCEEDED: { code: "rate_limited", vi: "Vượt giới hạn tần suất của Google API.", retryable: true },
  USER_PROJECT_DENIED: { code: "permission_denied", vi: "Cloud project không có quyền dùng API này." },
}

// priority: the most actionable code wins
const PRIORITY = [
  "mutateError.EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED",
  "criterionError.MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION",
  "videoCampaignError.MUTATE_REQUIRES_RESERVATION",
  "operationAccessDeniedError.OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE",
  "quotaError.RESOURCE_EXHAUSTED",
  "quotaError.RESOURCE_TEMPORARILY_EXHAUSTED",
  "authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
  "authorizationError.USER_PERMISSION_DENIED",
]

function byHttpStatus(status: number): Mapping {
  if (status === 401) return { code: "auth_invalid", vi: "Google từ chối thông tin xác thực." }
  if (status === 403) return { code: "permission_denied", vi: "Không có quyền thực hiện thao tác Google Ads này." }
  if (status === 404) return { code: "not_found", vi: "Không tìm thấy tài nguyên Google Ads." }
  if (status === 409) return { code: "conflict", vi: "Xung đột khi ghi dữ liệu, thử lại sau.", retryable: true }
  if (status === 429) return { code: "rate_limited", vi: "Google Ads đang giới hạn tần suất gọi API.", retryable: true }
  if (status === 504) return { code: "timeout", vi: "Google Ads API phản hồi quá chậm.", retryable: true }
  if (status >= 500) return { code: "upstream_error", vi: "Google Ads API đang lỗi tạm thời.", retryable: true }
  return { code: "invalid_request", vi: "Google Ads từ chối yêu cầu." }
}

export function toProviderError(p: ParsedGoogleError): ProviderError {
  const primary = PRIORITY.find((c) => p.codes.includes(c)) ?? p.codes.find((c) => CODE_MAP[c]) ?? p.codes[0] ?? null
  const reason = p.reasons.find((r) => REASON_MAP[r]) ?? p.reasons[0] ?? null
  const m: Mapping = (primary && CODE_MAP[primary]) || (reason && REASON_MAP[reason]) || byHttpStatus(p.httpStatus)
  const detail = p.errors.length ? summarizeErrors(p.errors) : p.message
  // For generic validation errors include Google's message (Vietnamese prefix + upstream detail, no secrets inside).
  const vi = !CODE_MAP[primary ?? ""] && !REASON_MAP[reason ?? ""] && p.errors.length ? `${m.vi} Chi tiết: ${summarizeErrors(p.errors, 3)}` : m.vi
  return new ProviderError({
    platform: "google_ads",
    code: m.code,
    message: `Google Ads API ${p.httpStatus} ${p.status ?? ""}: ${detail}`.slice(0, 2_000),
    userMessageVi: vi,
    hint: m.hint,
    retryable: m.retryable ?? false,
    retryAfterMs: m.code === "rate_limited" ? p.retryDelayMs ?? undefined : undefined,
    upstream: {
      code: primary ?? reason ?? p.status,
      subcode: p.codes.length > 1 ? p.codes.slice(0, 5).join(",") : null,
      message: detail.slice(0, 1_000),
      requestId: p.requestId,
      httpStatus: p.httpStatus,
    },
  })
}
