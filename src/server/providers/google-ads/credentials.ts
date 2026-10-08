// Google Ads connection credentials: service account JSON key (recommended) or OAuth client + refresh token.
// parseCredentials() is idempotent: its output can be parsed again (stored credentials are re-validated).
import { z } from "zod"
import { ProviderError } from "../errors"
import type { ConnectionGuide, CredentialFieldSpec } from "../types"

export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

interface CommonCredentials {
  /** MCC used to authenticate (10 digits, no dashes) → header login-customer-id */
  login_customer_id: string | null
  /**
   * Legacy, NEVER sent any more (developer token sunset 2026-09-09: "optional and ignored", future versions reject
   * it). Still parsed so credentials stored before the sunset keep validating; no form field.
   */
  developer_token: string | null
  /** optional allow-list of customer ids (10 digits) */
  customer_ids: string[]
}

export interface ServiceAccountCredentials extends CommonCredentials {
  auth_type: "service_account"
  /** original JSON key text (kept so the form can be re-validated) */
  service_account_json: string
  client_email: string
  private_key: string
  private_key_id: string | null
  project_id: string | null
}

export interface OAuthRefreshTokenCredentials extends CommonCredentials {
  auth_type: "oauth_refresh_token"
  client_id: string
  client_secret: string
  refresh_token: string
}

export type GoogleAdsCredentials = ServiceAccountCredentials | OAuthRefreshTokenCredentials

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v)

const loginCustomerId = z.preprocess(
  (v) => (typeof v === "string" ? (v.replace(/[\s-]/g, "") === "" ? null : v.replace(/[\s-]/g, "")) : v ?? null),
  z
    .string()
    .regex(/^\d{10}$/, "login_customer_id phải gồm 10 chữ số (có thể có dấu gạch, vd 123-456-7890).")
    .nullable()
)

const customerIds = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return []
    const arr = Array.isArray(v) ? v : String(v).split(/[,;\s]+/)
    return [...new Set(arr.map((s) => String(s).replace(/-/g, "").trim()).filter(Boolean))]
  },
  z.array(z.string().regex(/^\d{10}$/, "Mỗi customer ID phải gồm 10 chữ số."))
)

const common = {
  login_customer_id: loginCustomerId,
  developer_token: z.preprocess(emptyToNull, z.string().trim().max(200).nullable().default(null)),
  customer_ids: customerIds,
}

const serviceAccountSchema = z
  .object({
    auth_type: z.literal("service_account"),
    service_account_json: z.string().trim().min(2, "Hãy dán nội dung file JSON key của service account."),
    ...common,
  })
  .transform((v, ctx) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(v.service_account_json)
    } catch {
      ctx.addIssue({ code: "custom", path: ["service_account_json"], message: "Nội dung không phải JSON hợp lệ." })
      return z.NEVER
    }
    const o = (parsed ?? {}) as Record<string, unknown>
    const email = typeof o.client_email === "string" ? o.client_email.trim() : ""
    const key = typeof o.private_key === "string" ? o.private_key : ""
    if (o.type !== undefined && o.type !== "service_account") {
      ctx.addIssue({
        code: "custom",
        path: ["service_account_json"],
        message: 'File JSON không phải khóa service account (trường "type" phải là "service_account").',
      })
      return z.NEVER
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      ctx.addIssue({ code: "custom", path: ["service_account_json"], message: "JSON thiếu client_email." })
      return z.NEVER
    }
    if (!key.includes("PRIVATE KEY")) {
      ctx.addIssue({ code: "custom", path: ["service_account_json"], message: "JSON thiếu private_key." })
      return z.NEVER
    }
    const out: ServiceAccountCredentials = {
      auth_type: "service_account",
      service_account_json: v.service_account_json,
      client_email: email,
      private_key: key,
      private_key_id: typeof o.private_key_id === "string" ? o.private_key_id : null,
      project_id: typeof o.project_id === "string" ? o.project_id : null,
      login_customer_id: v.login_customer_id,
      developer_token: v.developer_token,
      customer_ids: v.customer_ids,
    }
    return out
  })

const oauthSchema = z.object({
  auth_type: z.literal("oauth_refresh_token"),
  client_id: z.string().trim().min(10, "Thiếu OAuth Client ID."),
  client_secret: z.string().trim().min(6, "Thiếu OAuth Client secret."),
  refresh_token: z.string().trim().min(10, "Thiếu refresh token."),
  ...common,
})

export const credentialsSchema = z.discriminatedUnion("auth_type", [serviceAccountSchema, oauthSchema])

export function parseCredentials(raw: unknown): GoogleAdsCredentials {
  const r = credentialsSchema.safeParse(raw)
  if (!r.success) {
    const msgs = r.error.issues.map((i) => i.message)
    throw new ProviderError({
      platform: "google_ads",
      code: "invalid_credentials_input",
      message: `Invalid Google Ads credentials: ${r.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      userMessageVi: msgs.length ? msgs.join(" ") : "Thông tin kết nối Google Ads không hợp lệ.",
    })
  }
  return r.data as GoogleAdsCredentials
}

export function credentialHint(c: GoogleAdsCredentials): string {
  if (c.auth_type === "service_account") return c.client_email
  return `…${c.refresh_token.slice(-4)}`
}

/** Stable, non-secret fingerprint of the credential (cache key component). */
export function credentialIdentity(c: GoogleAdsCredentials): string {
  return c.auth_type === "service_account"
    ? `sa:${c.client_email}:${c.private_key_id ?? c.private_key.length}`
    : `oauth:${c.client_id}:${c.refresh_token.slice(-12)}`
}

// ---------------------------------------------------------------------------
// UI metadata
// ---------------------------------------------------------------------------

export const credentialFields: CredentialFieldSpec[] = [
  {
    key: "auth_type",
    label: "Cách xác thực",
    type: "select",
    required: true,
    options: [
      { value: "service_account", label: "Service account (khuyến nghị)" },
      { value: "oauth_refresh_token", label: "OAuth client + refresh token" },
    ],
    help: "Service account không bị hết hạn sau 7 ngày và không cần đăng nhập lại.",
  },
  {
    key: "service_account_json",
    label: "Nội dung file JSON key của service account",
    type: "textarea",
    required: true,
    placeholder: '{"type": "service_account", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----..."}',
    help: "Mở file .json tải từ Google Cloud và dán toàn bộ nội dung vào đây.",
    showWhen: { key: "auth_type", equals: "service_account" },
  },
  {
    key: "client_id",
    label: "OAuth Client ID",
    type: "text",
    required: true,
    placeholder: "1234567890-abc.apps.googleusercontent.com",
    showWhen: { key: "auth_type", equals: "oauth_refresh_token" },
  },
  {
    key: "client_secret",
    label: "OAuth Client secret",
    type: "secret",
    required: true,
    showWhen: { key: "auth_type", equals: "oauth_refresh_token" },
  },
  {
    key: "refresh_token",
    label: "Refresh token",
    type: "secret",
    required: true,
    placeholder: "1//0g…",
    help: "Lấy bằng lệnh pnpm cli google:refresh-token hoặc OAuth Playground với client của chính bạn.",
    showWhen: { key: "auth_type", equals: "oauth_refresh_token" },
  },
  {
    key: "login_customer_id",
    label: "Login customer ID (MCC)",
    type: "text",
    required: false,
    placeholder: "123-456-7890",
    help: "ID tài khoản người quản lý (MCC) đã cấp quyền. Bắt buộc khi truy cập tài khoản con qua MCC.",
  },
  {
    key: "customer_ids",
    label: "Chỉ dùng các tài khoản",
    type: "text",
    required: false,
    placeholder: "111-222-3333, 444-555-6666",
    help: "Danh sách customer ID cách nhau bởi dấu phẩy. Để trống = tự khám phá mọi tài khoản được cấp quyền.",
  },
]

export const guide: ConnectionGuide = {
  summary:
    "Kết nối Google Ads bằng service account (khuyến nghị) hoặc OAuth refresh token, quyền truy cập API gắn với Google Cloud project của bạn.",
  steps: [
    {
      title: "Tạo hoặc chọn Google Cloud project",
      detail:
        "Vào Google Cloud Console, tạo project mới (nên dùng project cá nhân: tổ chức tạo sau 05/2024 thường chặn tạo khóa service account). Mức truy cập Google Ads API nay gắn với Cloud project của service account/OAuth client (không còn developer token). Project dùng billing dùng thử (free trial) bị từ chối nâng quyền.",
      link: { label: "Google Cloud Console", url: "https://console.cloud.google.com/projectcreate" },
    },
    {
      title: "Bật Google Ads API",
      detail: "APIs & Services → Library → tìm “Google Ads API” → Enable.",
      link: { label: "Google Ads API", url: "https://console.cloud.google.com/apis/library/googleads.googleapis.com" },
    },
    {
      title: "Xin quyền Explorer cho project",
      detail:
        "Google Ads API → Overview → “Upgrade access level” → chọn Explorer (thường được duyệt tự động). Mức Test chỉ gọi được tài khoản thử nghiệm; Explorer cho 2.880 thao tác/ngày trên tài khoản thật, Basic 15.000, Standard không giới hạn (hạn mức “ngày” tính theo 24 giờ trượt).",
      link: { label: "Mức truy cập", url: "https://developers.google.com/google-ads/api/docs/api-policy/access-levels" },
    },
    {
      title: "Tạo service account và khóa JSON",
      detail:
        "IAM & Admin → Service Accounts → Create service account (không cần cấp role Cloud nào) → mở service account → Keys → Add key → Create new key → JSON. Giữ file này bí mật.",
      link: { label: "Service Accounts", url: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
    },
    {
      title: "Thêm email service account vào Google Ads",
      detail:
        "Trong Google Ads (nên làm ở tài khoản người quản lý MCC): Admin → Access and security → Users → “+” → dán email service account (…@….iam.gserviceaccount.com) → quyền Standard (hoặc Read only nếu chỉ xem báo cáo). Không cần domain-wide delegation. Mỗi email chỉ được thêm vào tối đa 20 tài khoản - vì vậy hãy thêm ở MCC và điền Login customer ID.",
    },
    {
      title: "Dán JSON vào form và điền Login customer ID",
      detail:
        "Chọn “Service account”, dán toàn bộ nội dung file JSON. Nếu đã thêm ở MCC, điền ID của MCC (10 số, có thể kèm dấu gạch) vào “Login customer ID”.",
    },
    {
      title: "Cách khác: OAuth client + refresh token",
      detail:
        "Tạo OAuth client (Desktop app) trong chính project của bạn, rồi chạy `docker compose run --rm web pnpm cli google:refresh-token` để đăng nhập và nhận refresh token. Hoặc dùng OAuth Playground: tick “Use your own OAuth credentials”, scope https://www.googleapis.com/auth/adwords (dùng client mặc định của Playground thì token bị thu hồi sau 24 giờ). Người dùng Google Ads bị bắt buộc xác minh 2 bước phải đăng nhập bằng passkey (TOTP/SMS không được chấp nhận; passkey mới có thể cần tới 7 ngày mới dùng được).",
      link: { label: "OAuth Playground", url: "https://developers.google.com/oauthplayground" },
    },
  ],
  requiredScopes: [ADWORDS_SCOPE],
  warnings: [
    "Nếu dùng OAuth: OAuth consent screen phải ở trạng thái “In production” (Publish app) và nên xác minh thương hiệu (Verify Branding). Ở trạng thái “Testing”, refresh token tự hết hạn sau 7 ngày.",
    "Refresh token cũng mất hiệu lực khi không dùng 6 tháng, khi bạn thu hồi quyền hoặc đổi mật khẩu tài khoản Google.",
    "Developer token đã bị Google bỏ từ 09/09/2026 - không cần nhập; app không gửi developer token.",
    "Chiến dịch Video (YouTube) chỉ xem được qua API (báo cáo, danh sách); bật/tắt, ngân sách, sửa phải làm trong Google Ads. Demand Gen (gồm vị trí YouTube) quản lý được.",
    "Mọi chiến dịch mới phải khai báo có/không chứa quảng cáo chính trị EU; app tự đặt “không chứa” trừ khi bạn chọn khác.",
  ],
}
