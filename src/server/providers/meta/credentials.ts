import { z } from "zod"

import { ProviderError } from "../errors"
import type { ConnectionGuide, CredentialFieldSpec } from "../types"
import type { MetaCredentials } from "./client"

export const META_REQUIRED_SCOPES = ["ads_management", "ads_read"] as const
export const META_RECOMMENDED_SCOPES = ["pages_show_list", "pages_read_engagement"] as const
/** optional: business info of ad accounts / Business ID listing */
export const META_OPTIONAL_SCOPES = ["business_management", "pages_manage_ads"] as const

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v)
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v)

export const metaCredentialsSchema = z.object({
  accessToken: z.preprocess(
    trimmed,
    z
      .string({ error: "Thiếu access token." })
      .min(20, "Access token quá ngắn.")
      .max(2048, "Access token quá dài.")
      .regex(/^[A-Za-z0-9_\-|.]+$/, "Access token chứa ký tự không hợp lệ (có thể bị dán thừa khoảng trắng/dấu ngoặc).")
  ),
  appId: z.preprocess(
    (v) => emptyToUndefined(trimmed(v)),
    z.string().regex(/^\d{5,20}$/, "App ID chỉ gồm chữ số.").optional()
  ),
  appSecret: z.preprocess(
    (v) => emptyToUndefined(trimmed(v)),
    z.string().regex(/^[a-f0-9]{32}$/i, "App Secret phải gồm 32 ký tự hex.").optional()
  ),
  businessId: z.preprocess(
    (v) => emptyToUndefined(trimmed(v)),
    z.string().regex(/^\d{5,20}$/, "Business ID chỉ gồm chữ số.").optional()
  ),
})

/** Accepts form keys (snake_case, see credentialFields) or camelCase. */
export function parseMetaCredentials(raw: unknown): MetaCredentials {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const candidate = {
    accessToken: r.access_token ?? r.accessToken,
    appId: r.app_id ?? r.appId,
    appSecret: r.app_secret ?? r.appSecret,
    businessId: r.business_id ?? r.businessId,
  }
  const parsed = metaCredentialsSchema.safeParse(candidate)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join(" ")
    throw new ProviderError({
      platform: "meta",
      code: "invalid_credentials_input",
      message: `Invalid Meta credentials input: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      userMessageVi: msg || "Thông tin kết nối Meta không hợp lệ.",
    })
  }
  const c = parsed.data
  if (c.appSecret && !c.appId) {
    throw new ProviderError({
      platform: "meta",
      code: "invalid_credentials_input",
      message: "appSecret given without appId",
      userMessageVi: "Có App Secret thì cần nhập kèm App ID.",
    })
  }
  const out: MetaCredentials = { accessToken: c.accessToken }
  if (c.appId) out.appId = c.appId
  if (c.appSecret) out.appSecret = c.appSecret
  if (c.businessId) out.businessId = c.businessId
  return out
}

export function metaCredentialHint(c: MetaCredentials): string {
  return `…${c.accessToken.slice(-4)}`
}

export const metaCredentialFields: CredentialFieldSpec[] = [
  {
    key: "access_token",
    label: "Access token",
    type: "secret",
    required: true,
    placeholder: "EAAG…",
    help: "Token cá nhân của via (lấy trong Graph API Explorer) - 1 token dùng được mọi TKQC và Trang via được phân quyền, trên mọi BM. Cũng chấp nhận System User token.",
  },
  {
    key: "app_id",
    label: "App ID",
    type: "text",
    required: false,
    placeholder: "123456789012345",
    help: "Nên nhập: kèm App Secret để hệ thống tự đổi token ngắn hạn (1–2 giờ) sang token dài hạn (~60 ngày) và theo dõi hạn token.",
  },
  {
    key: "app_secret",
    label: "App Secret",
    type: "secret",
    required: false,
    help: "Nên nhập (App Dashboard → App settings → Basic). Dùng để đổi token dài hạn và gửi appsecret_proof khi app bật “Require App Secret”.",
  },
  {
    key: "business_id",
    label: "Business ID",
    type: "text",
    required: false,
    placeholder: "Không cần khi dùng token cá nhân",
    help: "Không bắt buộc. Chỉ dùng khi muốn lấy thêm tài khoản thuộc một Business cụ thể (cần quyền business_management).",
  },
]

export const metaGuide: ConnectionGuide = {
  summary:
    "Dán token cá nhân của via (app dev của bạn) - 1 token quản lý được mọi tài khoản quảng cáo và Trang mà via được phân quyền, không cần qua BM.",
  steps: [
    {
      title: "Tạo app trên Meta for Developers",
      detail:
        "Đăng nhập developers.facebook.com bằng chính via quản lý các TKQC → My Apps → Create App → chọn use case “Create & manage ads with Marketing API” (không cần gắn Business). Via phải là Admin/Developer của app.",
      link: { label: "Meta for Developers", url: "https://developers.facebook.com/apps/" },
    },
    {
      title: "Chuyển app sang chế độ Live",
      detail:
        "App Dashboard → App Mode = Live (cần điền Privacy Policy URL). Nếu app còn ở Development, Meta sẽ từ chối tạo quảng cáo với creative mới (lỗi 1885183).",
    },
    {
      title: "Lấy App ID và App Secret",
      detail: "App Dashboard → App settings → Basic: sao chép App ID và bấm Show để lấy App Secret.",
    },
    {
      title: "Tạo token trong Graph API Explorer",
      detail:
        "Mở Graph API Explorer → chọn đúng app ở mục Meta App → User or Page: chọn “User Token” → Add permissions: ads_management, ads_read, pages_show_list, pages_read_engagement (tuỳ chọn: business_management, pages_manage_ads; muốn đọc bài viết & chỉ số Trang thêm read_insights, pages_read_user_content; muốn AI đọc tin nhắn Messenger của Trang thêm pages_messaging - nếu không thấy các quyền này, thêm use case “Manage everything on your Page” cho app) → Generate Access Token → đồng ý cấp quyền cho mọi TKQC/Trang cần dùng.",
      link: { label: "Graph API Explorer", url: "https://developers.facebook.com/tools/explorer/" },
    },
    {
      title: "Dán vào form kết nối",
      detail:
        "Dán token vào ô Access token, điền App ID + App Secret. Hệ thống tự đổi token ngắn hạn sang token dài hạn (~60 ngày) và liệt kê toàn bộ TKQC của via trên mọi BM.",
    },
    {
      title: "Gia hạn khi sắp hết hạn",
      detail:
        "Token cá nhân sống khoảng 60 ngày. Trước 7 ngày hệ thống báo trên Tổng quan; khi đó lặp lại bước tạo token rồi bấm “Thay token” trong trang kết nối.",
    },
  ],
  requiredScopes: [...META_REQUIRED_SCOPES, ...META_RECOMMENDED_SCOPES],
  warnings: [
    "Token có toàn quyền chi tiền quảng cáo trên mọi TKQC của via - không chia sẻ cho người khác.",
    "Via đổi mật khẩu, bị checkpoint hoặc gỡ app thì token mất hiệu lực - cần tạo token mới.",
    "Không cần App Review khi via là Admin/Developer của app (Standard Access).",
    "Cách khác: System User token trong Business Settings (không hết hạn) nhưng chỉ thấy tài sản của 1 BM.",
  ],
}
