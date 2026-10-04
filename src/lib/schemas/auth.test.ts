import { describe, expect, it } from "vitest"

import { auth as tAuth } from "@/lib/i18n/vi/auth"

import { authErrorMessage, backupCodeSchema, changePasswordSchema, safeNextPath, setupSchema } from "./auth"
import { generateTempPassword } from "./users"

describe("safeNextPath", () => {
  it("chỉ nhận đường dẫn tương đối cùng site", () => {
    expect(safeNextPath("/users")).toBe("/users")
    expect(safeNextPath("/mcp-servers/1?tab=logs")).toBe("/mcp-servers/1?tab=logs")
  })
  it("chặn open redirect và trang auth", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/login", "/setup", "/api/auth/x", "", null, undefined, "/a\nb"]) {
      expect(safeNextPath(bad as string)).toBeNull()
    }
  })
})

describe("authErrorMessage", () => {
  it("map mã lỗi Better Auth sang tiếng Việt", () => {
    expect(authErrorMessage("INVALID_EMAIL_OR_PASSWORD")).toBe(tAuth.errors.INVALID_EMAIL_OR_PASSWORD)
    expect(authErrorMessage("BANNED_USER")).toBe(tAuth.errors.BANNED_USER)
    expect(authErrorMessage("ACCOUNT_LOCKED")).toBe(tAuth.errors.ACCOUNT_LOCKED)
  })
  it("dùng status khi không có mã, mặc định thông điệp chung", () => {
    expect(authErrorMessage(undefined, 429)).toBe(tAuth.errors.TOO_MANY_REQUESTS)
    expect(authErrorMessage("SOMETHING_NEW")).toBe(tAuth.errors.GENERIC)
  })
})

describe("schemas", () => {
  it("setup: mật khẩu ≥ 12 ký tự và nhập lại khớp", () => {
    const ok = setupSchema.safeParse({ name: "A", email: "A@B.vn", password: "x".repeat(12), confirmPassword: "x".repeat(12), setupToken: "t" })
    expect(ok.success && ok.data.email).toBe("a@b.vn")
    expect(setupSchema.safeParse({ name: "A", email: "a@b.vn", password: "short", confirmPassword: "short", setupToken: "t" }).success).toBe(false)
    expect(setupSchema.safeParse({ name: "A", email: "a@b.vn", password: "x".repeat(12), confirmPassword: "y".repeat(12), setupToken: "t" }).success).toBe(false)
  })
  it("đổi mật khẩu: mật khẩu mới phải khác mật khẩu cũ", () => {
    const r = changePasswordSchema.safeParse({ currentPassword: "a".repeat(12), newPassword: "a".repeat(12), confirmPassword: "a".repeat(12) })
    expect(r.success).toBe(false)
  })
  it("mã dự phòng chấp nhận có/không có gạch nối", () => {
    expect(backupCodeSchema.parse("abcde12345")).toBe("abcde-12345")
    expect(backupCodeSchema.parse(" AbCdE-12345 ")).toBe("AbCdE-12345")
    expect(backupCodeSchema.safeParse("abc").success).toBe(false)
  })
})

describe("generateTempPassword", () => {
  it("đủ dài, đúng định dạng, không lặp", () => {
    const a = generateTempPassword()
    const b = generateTempPassword()
    expect(a).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/)
    expect(a.length).toBeGreaterThanOrEqual(12)
    expect(a).not.toBe(b)
    expect(a).not.toMatch(/[01lIO]/)
  })
})
