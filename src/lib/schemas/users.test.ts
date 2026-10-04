import { describe, expect, it } from "vitest"

import {
  changePasswordSchema,
  currentPasswordSchema,
  newPasswordSchema,
  PASSWORD_MAX,
  PASSWORD_MIN,
  setupSchema,
} from "./auth"
import {
  banSchema,
  changeRoleSchema,
  createUserSchema,
  generateTempPassword,
  resetPasswordSchema,
  revokeSessionsSchema,
  userIdSchema,
  userTargetSchema,
} from "./users"

const pw = (n: number) => `Aa1${"x".repeat(Math.max(0, n - 3))}`.slice(0, n)

describe("mật khẩu: tối thiểu 8, tối đa 128 ở mọi nơi nhập mật khẩu mới", () => {
  it("hằng số khớp quyết định của chủ dự án (8) và cấu hình Better Auth (128)", () => {
    expect(PASSWORD_MIN).toBe(8)
    expect(PASSWORD_MAX).toBe(128)
  })

  it("newPasswordSchema: 7 từ chối, 8 và 128 nhận, 129 từ chối", () => {
    expect(newPasswordSchema.safeParse(pw(7)).success).toBe(false)
    expect(newPasswordSchema.safeParse(pw(8)).success).toBe(true)
    expect(newPasswordSchema.safeParse(pw(128)).success).toBe(true)
    expect(newPasswordSchema.safeParse(pw(129)).success).toBe(false)
    expect(newPasswordSchema.safeParse("").success).toBe(false)
    expect(newPasswordSchema.safeParse(undefined).success).toBe(false)
    expect(newPasswordSchema.safeParse(12345678).success).toBe(false)
  })

  it("thông báo lỗi là tiếng Việt, nêu đúng giới hạn", () => {
    const short = newPasswordSchema.safeParse(pw(7))
    expect(!short.success && short.error.issues[0]!.message).toBe("Mật khẩu cần ít nhất 8 ký tự.")
    const long = newPasswordSchema.safeParse(pw(129))
    expect(!long.success && long.error.issues[0]!.message).toBe("Mật khẩu tối đa 128 ký tự.")
  })

  it("mật khẩu hiện tại (nhập lại) không bị luật độ dài mới: tài khoản cũ vẫn đăng nhập/xác thực lại được", () => {
    expect(currentPasswordSchema.safeParse("a").success).toBe(true)
    expect(currentPasswordSchema.safeParse("").success).toBe(false)
    expect(currentPasswordSchema.safeParse(pw(129)).success).toBe(false)
  })

  it("setup / đổi mật khẩu / tạo người dùng / đặt lại mật khẩu cùng áp luật 8 ký tự", () => {
    const setup = (p: string) => setupSchema.safeParse({ name: "A", email: "a@b.vn", password: p, confirmPassword: p, setupToken: "t" })
    expect(setup(pw(7)).success).toBe(false)
    expect(setup(pw(8)).success).toBe(true)

    const change = (p: string) => changePasswordSchema.safeParse({ currentPassword: "old-password", newPassword: p, confirmPassword: p })
    expect(change(pw(7)).success).toBe(false)
    expect(change(pw(8)).success).toBe(true)

    const create = (p: string) => createUserSchema.safeParse({ name: "A", email: "a@b.vn", role: "staff", password: p })
    expect(create(pw(7)).success).toBe(false)
    expect(create(pw(8)).success).toBe(true)

    const reset = (p: string) => resetPasswordSchema.safeParse({ userId: "u1", password: p })
    expect(reset(pw(7)).success).toBe(false)
    expect(reset(pw(8)).success).toBe(true)
  })
})

describe("người dùng: vai trò + id", () => {
  it("chỉ nhận đúng 'admin' | 'staff'", () => {
    for (const role of ["superuser", "ADMIN", "admin,staff", ["admin"], null, undefined, ""]) {
      expect(createUserSchema.safeParse({ name: "A", email: "a@b.vn", role, password: pw(8) }).success, String(role)).toBe(false)
      expect(changeRoleSchema.safeParse({ userId: "u1", role, password: "x" }).success, String(role)).toBe(false)
    }
    expect(createUserSchema.safeParse({ name: "A", email: "a@b.vn", role: "admin", password: pw(8) }).success).toBe(true)
  })

  it("email được chuẩn hoá chữ thường và kiểm tra định dạng", () => {
    const r = createUserSchema.safeParse({ name: "A", email: "  Nhan.Vien@Example.COM ", role: "staff", password: pw(8) })
    expect(r.success && r.data.email).toBe("nhan.vien@example.com")
    for (const bad of ["", "khong-phai-email", "a@", "@b.vn", "a b@c.vn", "x".repeat(250) + "@b.vn"]) {
      expect(createUserSchema.safeParse({ name: "A", email: bad, role: "staff", password: pw(8) }).success, bad).toBe(false)
    }
  })

  it("id người dùng chỉ gồm [A-Za-z0-9_-] tối đa 64 ký tự (không cho ký tự lạ vào truy vấn/URL)", () => {
    expect(userIdSchema.safeParse("aB3_-xyz").success).toBe(true)
    for (const bad of ["", "a b", "a;b", "../x", "a'b", "a".repeat(65), "<script>"]) expect(userIdSchema.safeParse(bad).success, bad).toBe(false)
    expect(userTargetSchema.safeParse({ userId: "x" }).success).toBe(true)
    expect(banSchema.safeParse({ userId: "x", banned: "true" }).success).toBe(false)
    expect(revokeSessionsSchema.safeParse({ userId: "x", sessionId: "../y" }).success).toBe(false)
  })

  it("tên: bắt buộc, ≤ 100 ký tự, cắt khoảng trắng", () => {
    expect(createUserSchema.safeParse({ name: "   ", email: "a@b.vn", role: "staff", password: pw(8) }).success).toBe(false)
    expect(createUserSchema.safeParse({ name: "x".repeat(101), email: "a@b.vn", role: "staff", password: pw(8) }).success).toBe(false)
    const ok = createUserSchema.safeParse({ name: "  Lan  ", email: "a@b.vn", role: "staff", password: pw(8) })
    expect(ok.success && ok.data.name).toBe("Lan")
  })
})

describe("generateTempPassword", () => {
  it("luôn đạt luật mật khẩu mới (≥ 8, ≤ 128) và tạo-người-dùng/đặt-lại chấp nhận nó (1000 mẫu)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const p = generateTempPassword()
      expect(newPasswordSchema.safeParse(p).success).toBe(true)
      expect(p.length).toBeGreaterThanOrEqual(PASSWORD_MIN)
      seen.add(p)
    }
    expect(seen.size).toBe(1000)
  })

  it("không có ký tự dễ nhầm (0 O 1 l I) nên đọc to / gõ lại được", () => {
    for (let i = 0; i < 200; i++) expect(generateTempPassword()).not.toMatch(/[01lIO]/)
  })

  it("tham số nhóm/độ dài tuỳ chỉnh vẫn cho đủ ký tự", () => {
    expect(generateTempPassword(2, 4)).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/)
    expect(generateTempPassword(1, 12)).toHaveLength(12)
  })
})
