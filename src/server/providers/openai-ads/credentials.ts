import { z } from "zod"
import { ProviderError } from "../errors"
import type { ConnectionGuide, CredentialFieldSpec } from "../types"

export interface OpenAIAdsCredentials {
  apiKey: string
}

export const credentialsSchema = z.object({
  apiKey: z
    .string({ error: "Thiếu API key." })
    .trim()
    .min(20, { error: "API key quá ngắn - hãy dán đầy đủ key." })
    .max(512, { error: "API key quá dài." })
    .regex(/^\S+$/, { error: "API key không được chứa khoảng trắng." }),
})

export function parseCredentials(raw: unknown): OpenAIAdsCredentials {
  // accept the snake_case alias used in some docs/forms
  const input =
    raw && typeof raw === "object" && !("apiKey" in raw) && "api_key" in raw
      ? { apiKey: (raw as { api_key: unknown }).api_key }
      : raw
  const parsed = credentialsSchema.safeParse(input)
  if (!parsed.success) {
    throw new ProviderError({
      platform: "openai_ads",
      code: "invalid_credentials_input",
      message: "Invalid OpenAI Ads credentials input",
      userMessageVi: parsed.error.issues.map((i) => i.message).join(" "),
    })
  }
  return parsed.data
}

export function credentialHint(c: OpenAIAdsCredentials): string {
  return `…${c.apiKey.slice(-4)}`
}

export const credentialFields: CredentialFieldSpec[] = [
  {
    key: "apiKey",
    label: "API key OpenAI Ads",
    type: "secret",
    required: true,
    placeholder: "Dán API key tạo trong ads.openai.com → Settings",
    help: "Mỗi API key chỉ dùng cho đúng 1 tài khoản quảng cáo. Key này KHÁC key của platform.openai.com.",
  },
]

export const guide: ConnectionGuide = {
  summary: "Dán API key tạo trong ads.openai.com (Settings). Mỗi key gắn với đúng 1 tài khoản quảng cáo ChatGPT.",
  steps: [
    {
      title: "Đăng nhập OpenAI Ads Manager",
      detail: "Mở ads.openai.com bằng tài khoản có vai trò Admin trên tài khoản quảng cáo cần kết nối (vai trò Member/Viewer không tạo được key).",
      link: { label: "Mở ads.openai.com", url: "https://ads.openai.com" },
    },
    {
      title: "Tạo API key",
      detail: "Vào Settings → mục API keys → tạo key mới. Key chỉ hiển thị MỘT lần - sao chép ngay và lưu ở nơi an toàn.",
    },
    {
      title: "Dán key vào đây",
      detail: "Dán key vào ô bên trên rồi bấm Kiểm tra. Hệ thống gọi GET /ad_account để lấy tên, tiền tệ và múi giờ của tài khoản, đồng thời kiểm tra các tính năng đang được bật (chuyển đổi, phân khúc báo cáo, giới hạn chi tiêu, bulk).",
    },
    {
      title: "Nhiều tài khoản quảng cáo?",
      detail: "1 key = 1 tài khoản. Muốn quản lý nhiều tài khoản thì tạo key riêng trong từng tài khoản và thêm một kết nối cho mỗi key.",
    },
  ],
  warnings: [
    "Key có toàn quyền chi tiêu trên tài khoản quảng cáo - không chia sẻ cho người khác.",
    "Key của platform.openai.com (API ChatGPT/GPT) KHÔNG dùng được cho OpenAI Ads.",
    "Ngân sách/giá thầu trên OpenAI Ads tính theo micros; ứng dụng tự quy đổi từ đơn vị tiền chính.",
  ],
}
