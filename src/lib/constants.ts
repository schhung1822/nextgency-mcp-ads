import type { Platform } from "@/server/providers/types"
import type { Permission } from "@/server/mcp/types"

export const APP_NAME = "Ads MCP"
export const APP_FULL_NAME = "Ads MCP by: noti.vn"

export const PLATFORM_LABELS: Record<Platform, string> = {
  meta: "Meta",
  tiktok: "TikTok",
  google_ads: "Google Ads",
  openai_ads: "OpenAI Ads",
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  read: "Xem",
  status: "Bật/Tắt",
  update: "Sửa",
  copy: "Sao chép",
  create: "Tạo mới",
  delete: "Xoá/Lưu trữ",
}

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  read: "Xem danh sách tài khoản, chiến dịch và toàn bộ chỉ số theo ngày.",
  status: "Chạy hoặc tạm dừng chiến dịch, nhóm quảng cáo, quảng cáo.",
  update: "Đổi tên, ngân sách, giá thầu, lịch chạy, nhắm mục tiêu.",
  copy: "Nhân bản chiến dịch/nhóm/quảng cáo (bản sao luôn ở trạng thái tạm dừng - trừ TikTok GMV Max: chạy ngay).",
  create: "Tạo chiến dịch, nhóm, quảng cáo mới và tải ảnh/video (luôn tạo ở trạng thái tạm dừng - trừ TikTok GMV Max: chạy ngay).",
  delete: "Xoá hoặc lưu trữ vĩnh viễn - KHÔNG thể hoàn tác.",
}

export const ROLE_LABELS = { admin: "Quản trị viên", staff: "Nhân viên" } as const
export type Role = keyof typeof ROLE_LABELS
