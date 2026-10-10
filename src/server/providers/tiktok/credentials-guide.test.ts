// tiktokGuide (Thêm kết nối → TikTok Ads): the app must take FULL permissions (every scope group, incl. all GMV MAX
// children, GMV MAX Report and Onsite Commerce Store), and the GMV Max caution follows the admin-only MCP switch rule.
import { describe, expect, it } from "vitest"

import { tiktokGuide } from "./credentials"

describe("tiktokGuide - toàn quyền + quy tắc GMV Max mới", () => {
  it("bước scope bảo tick tất cả, liệt kê đủ ô con GMV MAX", () => {
    const step = tiktokGuide.steps.find((s) => s.title.includes("scope"))!
    expect(step.title).toContain("tick tất cả")
    for (const k of [
      "tick HẾT",
      "Ad Account Management",
      "Creative Management",
      "Pixel Management",
      "Audience Management",
      "GMV MAX (Store Management)",
      "Identity And Video",
      "TRỪ 2 ô GMV MAX → Session",
      "GMV MAX → Exclusive Authorization",
      "KHÔNG tick",
      "custom anchor",
      "GMV MAX Report",
      "Onsite Commerce Store",
      "Mọi nhóm quyền khác",
    ])
      expect(step.detail).toContain(k)
  })

  it("requiredScopes: không còn '(tuỳ chọn)', có GMV MAX + Onsite Commerce Store", () => {
    const scopes = tiktokGuide.requiredScopes!
    expect(scopes.some((s) => s.includes("tuỳ chọn"))).toBe(false)
    expect(scopes).toContain("Ads Management → GMV MAX")
    expect(scopes).toContain("Reporting → GMV MAX Report")
    expect(scopes).toContain("Onsite Commerce Store")
  })

  it("lưu ý: AI chỉ đổi GMV Max khi quản trị viên bật trong MCP, luôn xác nhận 2 bước, tạo/sao chép chạy ngay", () => {
    const w = tiktokGuide.warnings!.join(" ")
    expect(w).not.toContain("AI không được sửa")
    expect(w).toContain("quản trị viên bật")
    expect(w).toContain("xác nhận 2 bước")
    expect(w).toContain("CHẠY NGAY")
  })
})
