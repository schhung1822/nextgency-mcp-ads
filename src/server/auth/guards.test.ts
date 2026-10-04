import { describe, expect, it } from "vitest"

import { users as tUsers } from "@/lib/i18n/vi/users"

import {
  ADMIN_ENDPOINT_PATHS,
  checkAdminEndpoint,
  checkUserOp,
  isQualifyingAdmin,
  isValidRole,
  roleChangeOp,
  verifySetupToken,
  type GuardUser,
} from "./guards"

const admin = (id: string, over: Partial<GuardUser> = {}): GuardUser => ({
  id,
  role: "admin",
  banned: false,
  twoFactorEnabled: true,
  ...over,
})
const staff = (id: string, over: Partial<GuardUser> = {}): GuardUser => ({
  id,
  role: "staff",
  banned: false,
  twoFactorEnabled: false,
  ...over,
})

describe("isQualifyingAdmin", () => {
  it("chỉ tính admin đang hoạt động và đã bật 2FA", () => {
    expect(isQualifyingAdmin(admin("a"))).toBe(true)
    expect(isQualifyingAdmin(admin("a", { twoFactorEnabled: false }))).toBe(false)
    expect(isQualifyingAdmin(admin("a", { banned: true }))).toBe(false)
    expect(isQualifyingAdmin(staff("s", { twoFactorEnabled: true }))).toBe(false)
  })
  it("vai trò phải đúng chính xác 'admin'", () => {
    expect(isQualifyingAdmin(admin("a", { role: "Admin" }))).toBe(false)
    expect(isQualifyingAdmin(admin("a", { role: "admin,staff" }))).toBe(false)
    expect(isQualifyingAdmin(admin("a", { role: null }))).toBe(false)
  })
})

describe("checkUserOp", () => {
  it("không cho admin thao tác với chính mình", () => {
    const r = checkUserOp({ actorId: "a", target: admin("a"), op: "demote", otherQualifyingAdmins: 5 })
    expect(r).toEqual({ ok: false, error: tUsers.errors.self })
    expect(checkUserOp({ actorId: "a", target: admin("a"), op: "resetPassword", otherQualifyingAdmins: 5 }).ok).toBe(false)
  })

  it.each(["demote", "ban", "delete", "reset2fa"] as const)(
    "chặn %s admin cuối cùng còn 2FA",
    (op) => {
      const r = checkUserOp({ actorId: "x", target: admin("b"), op, otherQualifyingAdmins: 0 })
      expect(r).toEqual({ ok: false, error: tUsers.errors.lastAdmin })
    }
  )

  it("cho phép khi còn admin khác đủ điều kiện", () => {
    expect(checkUserOp({ actorId: "x", target: admin("b"), op: "ban", otherQualifyingAdmins: 1 })).toEqual({ ok: true })
  })

  it("thao tác không làm mất quyền admin thì không cần đếm admin", () => {
    for (const op of ["promote", "unban", "resetPassword", "revokeSessions"] as const) {
      expect(checkUserOp({ actorId: "x", target: admin("b"), op, otherQualifyingAdmins: 0 }).ok).toBe(true)
    }
  })

  it("target không phải admin đủ điều kiện thì không bị chặn bởi luật admin cuối", () => {
    expect(checkUserOp({ actorId: "x", target: staff("s"), op: "delete", otherQualifyingAdmins: 0 }).ok).toBe(true)
    expect(
      checkUserOp({ actorId: "x", target: admin("b", { twoFactorEnabled: false }), op: "demote", otherQualifyingAdmins: 0 }).ok
    ).toBe(true)
  })
})

describe("roleChangeOp / isValidRole", () => {
  it("xác định demote/promote/không đổi", () => {
    expect(roleChangeOp("admin", "staff")).toBe("demote")
    expect(roleChangeOp("staff", "admin")).toBe("promote")
    expect(roleChangeOp("staff", "staff")).toBeNull()
    expect(roleChangeOp(null, "admin")).toBe("promote")
  })
  it("chỉ nhận đúng 'admin' hoặc 'staff'", () => {
    expect(isValidRole("admin")).toBe(true)
    expect(isValidRole("staff")).toBe(true)
    for (const bad of ["Admin", "user", "admin,staff", ["admin"], "", null, undefined]) expect(isValidRole(bad)).toBe(false)
  })
})

describe("checkAdminEndpoint", () => {
  const base = { hasRequestContext: true }

  it("tắt hẳn impersonation và update-user", () => {
    for (const path of ["/admin/impersonate-user", "/admin/stop-impersonating", "/admin/update-user"]) {
      const r = checkAdminEndpoint({ ...base, path, caller: admin("a"), body: { userId: "b" } })
      expect(r).toMatchObject({ ok: false, code: "ADMIN_ENDPOINT_DISABLED" })
    }
  })

  it("yêu cầu phiên đăng nhập", () => {
    expect(checkAdminEndpoint({ ...base, path: "/admin/list-users", caller: null })).toMatchObject({
      ok: false,
      status: "UNAUTHORIZED",
    })
  })

  it("người gọi phải là admin đã bật 2FA, đang hoạt động", () => {
    for (const caller of [staff("s"), admin("a", { twoFactorEnabled: false }), admin("a", { banned: true }), admin("a", { role: "Admin" })]) {
      expect(checkAdminEndpoint({ ...base, path: "/admin/list-users", caller })).toMatchObject({ ok: false, code: "FORBIDDEN" })
    }
    expect(checkAdminEndpoint({ ...base, path: "/admin/list-users", caller: admin("a") })).toEqual({ ok: true })
  })

  it("không cho tự đổi vai trò / tự khoá / tự xoá", () => {
    for (const path of ["/admin/set-role", "/admin/ban-user", "/admin/remove-user"]) {
      const r = checkAdminEndpoint({ ...base, path, caller: admin("a"), body: { userId: "a", role: "staff" }, target: admin("a"), otherQualifyingAdmins: 3 })
      expect(r).toMatchObject({ ok: false, code: "SELF_ACTION" })
    }
  })

  it("giữ lại ít nhất 1 admin có 2FA", () => {
    const common = { ...base, caller: admin("a"), target: admin("b"), otherQualifyingAdmins: 0 }
    expect(checkAdminEndpoint({ ...common, path: "/admin/set-role", body: { userId: "b", role: "staff" } })).toMatchObject({ ok: false, code: "LAST_ADMIN" })
    expect(checkAdminEndpoint({ ...common, path: "/admin/ban-user", body: { userId: "b" } })).toMatchObject({ ok: false, code: "LAST_ADMIN" })
    expect(checkAdminEndpoint({ ...common, path: "/admin/remove-user", body: { userId: "b" } })).toMatchObject({ ok: false, code: "LAST_ADMIN" })
    // promoting never removes an admin
    expect(checkAdminEndpoint({ ...common, path: "/admin/set-role", body: { userId: "b", role: "admin" } })).toEqual({ ok: true })
    expect(checkAdminEndpoint({ ...common, otherQualifyingAdmins: 1, path: "/admin/ban-user", body: { userId: "b" } })).toEqual({ ok: true })
  })

  it("set-role chỉ nhận vai trò hợp lệ (không mảng, không chuỗi lạ)", () => {
    for (const role of [["admin"], "user", "admin,staff", "ADMIN", undefined]) {
      expect(
        checkAdminEndpoint({ ...base, path: "/admin/set-role", caller: admin("a"), body: { userId: "b", role }, target: staff("b"), otherQualifyingAdmins: 1 })
      ).toMatchObject({ ok: false, code: "INVALID_ROLE" })
    }
  })

  it("gọi qua HTTP (/api/auth/admin/*) luôn 404, kể cả admin hợp lệ", () => {
    for (const path of ADMIN_ENDPOINT_PATHS) {
      const r = checkAdminEndpoint({ ...base, viaHttp: true, path, caller: admin("a"), body: { userId: "b", role: "staff" } })
      expect(r).toEqual({ ok: false, status: "NOT_FOUND", code: "NOT_FOUND" })
    }
  })

  it("create-user không header: chỉ khi được đánh dấu tin cậy (/setup) hoặc DB chưa có user", () => {
    const p = { path: "/admin/create-user", caller: null, hasRequestContext: false, body: { role: "admin" } }
    expect(checkAdminEndpoint(p)).toMatchObject({ ok: false, status: "UNAUTHORIZED" })
    expect(checkAdminEndpoint({ ...p, userCount: 3 })).toMatchObject({ ok: false, status: "UNAUTHORIZED" })
    expect(checkAdminEndpoint({ ...p, trustedServerCall: true })).toEqual({ ok: true })
    expect(checkAdminEndpoint({ ...p, userCount: 0 })).toEqual({ ok: true })
    // the trusted flag never applies to other endpoints
    expect(
      checkAdminEndpoint({ path: "/admin/set-role", caller: null, hasRequestContext: false, trustedServerCall: true, body: { userId: "b", role: "admin" } })
    ).toMatchObject({ ok: false, status: "UNAUTHORIZED" })
  })

  it("create-user: có header thì phải là admin", () => {
    expect(checkAdminEndpoint({ path: "/admin/create-user", caller: null, hasRequestContext: true, body: { role: "admin" } })).toMatchObject({ ok: false, status: "UNAUTHORIZED" })
    expect(checkAdminEndpoint({ path: "/admin/create-user", caller: staff("s"), hasRequestContext: true, body: {} })).toMatchObject({ ok: false, code: "FORBIDDEN" })
    expect(checkAdminEndpoint({ path: "/admin/create-user", caller: admin("a"), hasRequestContext: true, body: { role: "staff" } })).toEqual({ ok: true })
  })

  it("create-user: chặn trường `data` (banned/role tuỳ ý) và role lạ", () => {
    expect(
      checkAdminEndpoint({ path: "/admin/create-user", caller: admin("a"), hasRequestContext: true, body: { data: { banned: true } } })
    ).toMatchObject({ ok: false, code: "FIELD_NOT_ALLOWED" })
    expect(
      checkAdminEndpoint({ path: "/admin/create-user", caller: null, hasRequestContext: false, body: { role: ["admin"] } })
    ).toMatchObject({ ok: false, code: "INVALID_ROLE" })
  })
})

describe("verifySetupToken", () => {
  const TOKEN = "s3cret-token-value-0123456789"
  it("so khớp đúng token", () => {
    expect(verifySetupToken(TOKEN, TOKEN)).toBe(true)
    expect(verifySetupToken(`  ${TOKEN} `, TOKEN)).toBe(true)
  })
  it("từ chối token sai, rỗng, hoặc khi chưa cấu hình", () => {
    expect(verifySetupToken("wrong", TOKEN)).toBe(false)
    expect(verifySetupToken(TOKEN.slice(0, -1), TOKEN)).toBe(false)
    expect(verifySetupToken("", TOKEN)).toBe(false)
    expect(verifySetupToken(undefined, TOKEN)).toBe(false)
    expect(verifySetupToken("anything", undefined)).toBe(false)
    expect(verifySetupToken("anything", "   ")).toBe(false)
    expect(verifySetupToken("", "")).toBe(false)
  })
  it("SETUP_TOKEN quá ngắn (< 24 ký tự) thì /setup luôn đóng", () => {
    expect(verifySetupToken("short-token-1234", "short-token-1234")).toBe(false)
  })
})

// Owner decision 2026-10-02: 2FA is optional unless require_2fa_admin / require_2fa_all is on, so "qualifying
// admin" (the one that keeps the system manageable) is just an active admin when the policy is off.
describe("chính sách 2FA tắt (mặc định): admin không có 2FA vẫn là admin đủ điều kiện", () => {
  const noTwoFa = (id: string) => admin(id, { twoFactorEnabled: false })

  it("isQualifyingAdmin(requireTwoFactor=false) chỉ cần admin đang hoạt động", () => {
    expect(isQualifyingAdmin(noTwoFa("a"), false)).toBe(true)
    expect(isQualifyingAdmin(admin("a", { banned: true, twoFactorEnabled: false }), false)).toBe(false)
    expect(isQualifyingAdmin(staff("s"), false)).toBe(false)
    // strict (policy on) is the default when the caller does not say
    expect(isQualifyingAdmin(noTwoFa("a"))).toBe(false)
    expect(isQualifyingAdmin(noTwoFa("a"), true)).toBe(false)
  })

  it("checkUserOp: admin cuối cùng (không có 2FA) được bảo vệ khi chính sách tắt, không còn là 'admin cuối' khi chính sách bật", () => {
    for (const op of ["demote", "ban", "delete", "reset2fa"] as const) {
      expect(checkUserOp({ actorId: "x", target: noTwoFa("b"), op, otherQualifyingAdmins: 0, requireAdminTwoFactor: false })).toEqual({
        ok: false,
        error: tUsers.errors.lastAdmin,
      })
      // policy ON: an admin without 2FA does not count as a qualifying admin → nothing to protect
      expect(checkUserOp({ actorId: "x", target: noTwoFa("b"), op, otherQualifyingAdmins: 0, requireAdminTwoFactor: true })).toEqual({ ok: true })
    }
  })

  it("checkAdminEndpoint: người gọi là admin không 2FA được phép khi chính sách tắt, bị từ chối khi bật hoặc không nói rõ", () => {
    const call = { path: "/admin/list-users", hasRequestContext: true, caller: noTwoFa("a") }
    expect(checkAdminEndpoint({ ...call, requireAdminTwoFactor: false })).toEqual({ ok: true })
    expect(checkAdminEndpoint({ ...call, requireAdminTwoFactor: true })).toMatchObject({ ok: false, code: "FORBIDDEN" })
    expect(checkAdminEndpoint({ ...call })).toMatchObject({ ok: false, code: "FORBIDDEN" }) // default = strictest
  })

  it("checkAdminEndpoint: luật admin cuối cùng tính theo chính sách", () => {
    const common = { hasRequestContext: true, caller: noTwoFa("a"), target: noTwoFa("b"), otherQualifyingAdmins: 0 }
    expect(
      checkAdminEndpoint({ ...common, requireAdminTwoFactor: false, path: "/admin/ban-user", body: { userId: "b" } })
    ).toMatchObject({ ok: false, code: "LAST_ADMIN" })
    expect(checkAdminEndpoint({ ...common, requireAdminTwoFactor: true, path: "/admin/ban-user", body: { userId: "b" } })).toMatchObject({
      ok: false,
      code: "FORBIDDEN", // under the strict policy the caller (no 2FA) is not a qualifying admin at all
    })
  })
})
