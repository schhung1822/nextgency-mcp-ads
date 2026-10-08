// TikTok API for Business - credentials form, Vietnamese guide and the auth_code → token exchange.
// Spec: .claude/docs/providers/tiktok.md §2.
import { z } from "zod"
import { ProviderError } from "../errors"
import type { ConnectionGuide, CredentialFieldSpec, UpstreamEvent } from "../types"
import { normalizeScopeIds } from "./accounts"
import { tiktokRequest } from "./client"

export interface TikTokCredentials {
  /** Long-term advertiser access token (does not expire until revoked) */
  accessToken: string
  /** Developer app id (needed for /oauth2/advertiser/get/) */
  appId: string
  /** Developer app secret (needed for /oauth2/advertiser/get/) */
  secret: string
}

const nonEmpty = (label: string) =>
  z
    .string({ error: `Thiếu ${label}.` })
    .trim()
    .min(1, { error: `Thiếu ${label}.` })

export const tiktokCredentialsSchema = z.object({
  accessToken: nonEmpty("Access token").max(512, { error: "Access token quá dài." }),
  appId: nonEmpty("App ID")
    .max(64)
    .regex(/^\d+$/, { error: "App ID chỉ gồm chữ số." }),
  secret: nonEmpty("Secret").max(256),
})

export function parseTikTokCredentials(raw: unknown): TikTokCredentials {
  const r = tiktokCredentialsSchema.safeParse(raw)
  if (!r.success) {
    const msg = r.error.issues.map((i) => i.message).join(" ")
    throw new ProviderError({
      platform: "tiktok",
      code: "invalid_credentials_input",
      message: "Invalid TikTok credentials input",
      userMessageVi: msg || "Thông tin kết nối TikTok không hợp lệ.",
    })
  }
  return r.data
}

export function tiktokCredentialHint(c: TikTokCredentials): string {
  const t = c.accessToken
  return t.length <= 4 ? "****" : `…${t.slice(-4)}`
}

export const tiktokCredentialFields: CredentialFieldSpec[] = [
  {
    key: "accessToken",
    label: "Access token (dài hạn)",
    type: "secret",
    required: true,
    placeholder: "Dán access token của advertiser",
    help: "Token dài hạn lấy được sau khi advertiser cấp quyền cho app. Hoặc chọn Cách nhập: Đổi auth_code để hệ thống tự lấy token.",
  },
  {
    key: "appId",
    label: "App ID",
    type: "text",
    required: true,
    placeholder: "Ví dụ: 7312345678901234567",
    help: "Xem tại TikTok API for Business → My Apps → App Detail → Basic Information.",
  },
  {
    key: "secret",
    label: "Secret của app",
    type: "secret",
    required: true,
    placeholder: "Secret của developer app",
    help: "Cần để tìm các tài khoản quảng cáo đã cấp quyền cho app. Không bao giờ hiển thị lại.",
  },
]

export const tiktokGuide: ConnectionGuide = {
  summary:
    "Tạo developer app trên TikTok API for Business, cho advertiser cấp quyền rồi dán access token dài hạn (hoặc dán auth_code để app tự đổi).",
  steps: [
    {
      title: "Đăng ký developer và tạo app",
      detail:
        "Đăng nhập TikTok API for Business → Become a developer: xác minh email (bấm Send Code, mã dùng lại được trong 48 giờ), điền hồ sơ developer và chờ hồ sơ được duyệt. Sau đó vào My Apps → Create App (tối đa 5 app mỗi developer). TikTok duyệt app trong khoảng 2–3 ngày làm việc.",
      link: { label: "Mở TikTok API for Business", url: "https://business-api.tiktok.com/portal" },
    },
    {
      title: "Chọn quyền (scope) cho app",
      detail:
        "Bật các nhóm quyền: Ad Account Management, Ads Management, Reporting, Creative Management (ảnh, video, identity) và Pixel Management. Tuỳ chọn: Audience Management (để tra cứu tệp đối tượng). Đổi scope sau này: app bị duyệt lại 2–3 ngày làm việc, rồi advertiser phải cấp quyền lại để token có quyền mới.",
    },
    {
      title: "Khai báo Redirect URL",
      detail:
        "Trong app, thêm Advertiser redirect URL đúng bằng địa chỉ Ads MCP đang chạy: {APP_URL}/connections/new (sao chép nguyên văn, đừng dùng localhost hay website khác). Sau khi advertiser đồng ý, TikTok chuyển hướng về đúng trang thêm kết nối này, kèm tham số auth_code trên thanh địa chỉ.",
    },
    {
      title: "Cho advertiser cấp quyền",
      detail:
        "Mở \"Advertiser authorization URL\" của app, đăng nhập tài khoản quản trị tài khoản quảng cáo và chọn các tài khoản cần kết nối rồi bấm đồng ý.",
    },
    {
      title: "Lấy access token",
      detail:
        "Đổi auth_code NGAY (sống tối đa 1 giờ, chỉ dùng được 1 lần): khi TikTok chuyển về trang này, form tự mở chế độ \"Đổi auth_code\", điền sẵn mã và xoá mã khỏi thanh địa chỉ - chỉ cần điền App ID, Secret rồi bấm đổi để app tự lấy token. Hoặc tự đổi rồi dán access token dài hạn vào ô Access token.",
    },
    {
      title: "Điền App ID và Secret",
      detail:
        "Sao chép App ID và Secret ở trang Basic Information của app, dán vào form rồi bấm Kiểm tra kết nối.",
    },
  ],
  requiredScopes: [
    "Ad Account Management",
    "Ads Management",
    "Reporting",
    "Creative Management",
    "Pixel Management",
    "Audience Management (tuỳ chọn)",
  ],
  warnings: [
    "Access token dài hạn của advertiser không hết hạn và không cần làm mới - chỉ mất hiệu lực khi advertiser thu hồi quyền (TikTok For Business → cài đặt Authorization → chọn app → Remove). Hãy giữ bí mật.",
    "Thiếu quyền thường chỉ lộ ra khi gọi API (lỗi 40001): khi đó cần bật thêm scope cho app và cho advertiser cấp quyền lại.",
    "Từ sau 31/12/2026 TikTok không cho tạo chiến dịch thủ công (Manual) qua API.",
  ],
}

export interface ExchangeAuthCodeResult {
  accessToken: string
  /**
   * Scope ids granted to the token as digit strings (first-level ids like "1","2" or child ids like "10","200";
   * some ids are 19-digit, so never Number()).
   */
  scope: string[]
  advertiserIds: string[]
}

const exchangeInput = z.object({
  appId: nonEmpty("App ID").regex(/^\d+$/, { error: "App ID chỉ gồm chữ số." }),
  secret: nonEmpty("Secret"),
  authCode: nonEmpty("auth_code").max(512),
})

/**
 * UI helper ("Đổi auth_code"): exchange a one-time auth_code (valid 1 hour) for a long-term access token.
 * POST /oauth2/access_token/ - JSON only, no Access-Token header. Never logs the code or the token.
 * This is the only endpoint that returns the token's `scope` - store it in connections.meta.
 */
export async function exchangeAuthCode(
  input: { appId: string; secret: string; authCode: string },
  opts: { signal?: AbortSignal; onUpstream?: (e: UpstreamEvent) => void } = {}
): Promise<ExchangeAuthCodeResult> {
  const parsed = exchangeInput.safeParse(input)
  if (!parsed.success) {
    throw new ProviderError({
      platform: "tiktok",
      code: "invalid_credentials_input",
      message: "Invalid auth_code exchange input",
      userMessageVi: parsed.error.issues.map((i) => i.message).join(" "),
    })
  }
  const { appId, secret, authCode } = parsed.data
  const res = await tiktokRequest<{ access_token?: string; scope?: unknown[]; advertiser_ids?: string[] }>({
    method: "POST",
    path: "oauth2/access_token",
    body: { app_id: appId, secret, auth_code: authCode, return_advertiser_ids: true },
    auth: null,
    appId,
    retries: 0,
    signal: opts.signal,
    onUpstream: opts.onUpstream,
  })
  const token = res.data?.access_token
  if (!token) {
    throw new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: "TikTok did not return an access token",
      userMessageVi: "TikTok không trả về access token. Hãy tạo auth_code mới và thử lại.",
      upstream: { requestId: res.requestId },
    })
  }
  return {
    accessToken: token,
    scope: Array.isArray(res.data.scope) ? normalizeScopeIds(res.data.scope) : [],
    advertiserIds: Array.isArray(res.data.advertiser_ids) ? res.data.advertiser_ids.map(String) : [],
  }
}
