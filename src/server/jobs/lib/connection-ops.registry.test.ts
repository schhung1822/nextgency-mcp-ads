// Regression: "Kiểm tra lại" / "Đồng bộ tài khoản" in a freshly started web process (nothing registered the
// adapters yet) answered "Nền tảng này chưa được hỗ trợ." - verifyCredentials must register them itself.
import { describe, expect, it, vi } from "vitest"

vi.mock("@/server/providers/meta", () => ({
  metaProvider: {
    platform: "meta",
    validateCredentials: vi.fn(async () => ({
      valid: true,
      scopes: ["ads_read"],
      tokenExpiresAt: null,
    })),
    listAdAccounts: vi.fn(async () => []),
  },
}))

import { hasProvider } from "@/server/providers/registry"

import { verifyCredentials } from "./connection-ops"

describe("verifyCredentials", () => {
  it("tự đăng ký adapter khi registry còn trống (web vừa khởi động)", async () => {
    expect(hasProvider("meta")).toBe(false)
    const out = await verifyCredentials(
      "meta",
      { accessToken: "x" },
      { listAccounts: false, listPages: false }
    )
    expect(out.check.valid).toBe(true)
    expect(hasProvider("meta")).toBe(true)
  })
})
