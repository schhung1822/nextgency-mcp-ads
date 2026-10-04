// Admin user management end to end (real Better Auth + real DB in a private throw-away database):
// create / role change / password reset / 2FA reset / ban / sessions / delete, self-action and last-admin rules
// under both 2FA policies, re-auth gates, and the activity_logs row each mutation must leave.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("./temp-db")
  const t = await createTempDb("usersadmin")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
const flags = vi.hoisted(() => ({ failLog: false }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())
// lets a test make the activity_logs insert fail, to prove the business change rolls back with it
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...actual,
    logActivity: async (...args: Parameters<typeof actual.logActivity>) => {
      if (flags.failLog) throw new Error("simulated activity log failure")
      return actual.logActivity(...args)
    },
  }
})

import { and, desc, eq } from "drizzle-orm"

import { db } from "@/server/db/client"
import { activityLogs, connections, session as sessionTable, twoFactor, user } from "@/server/db/schema"
import { encryptSecret } from "@/server/crypto/secret-box"

import {
  actAs,
  anonymousHeaders,
  authHttp,
  closeDb,
  cookieOf,
  createTestUser,
  enableTotp,
  PASSWORD,
  randomIp,
  runAs,
  setSettingRaw,
  signIn,
  totp,
  uid,
  type Signed,
  type TestUser,
} from "./harness"

const hasDb = !!tmp
const P = `tua_${uid()}`

const actions = async () => import("@/server/actions/users")
const account = async () => import("@/server/actions/account")
const settingsActions = async () => import("@/server/actions/settings")

let adminA: TestUser
let adminB: TestUser
let staff1: TestUser
let staff2: TestUser
let sA: Signed

async function row(id: string) {
  const [r] = await db.select().from(user).where(eq(user.id, id))
  return r!
}

async function lastLog(action: string, targetId?: string) {
  const rows = await db
    .select()
    .from(activityLogs)
    .where(and(eq(activityLogs.action, action), targetId ? eq(activityLogs.targetId, targetId) : undefined))
    .orderBy(desc(activityLogs.createdAt))
    .limit(1)
  return rows[0]
}

async function logCount(action: string, status?: "success" | "failure") {
  const rows = await db
    .select({ id: activityLogs.id })
    .from(activityLogs)
    .where(and(eq(activityLogs.action, action), status ? eq(activityLogs.status, status) : undefined))
  return rows.length
}

async function sessionCount(userId: string) {
  return (await db.select({ id: sessionTable.id }).from(sessionTable).where(eq(sessionTable.userId, userId))).length
}

describe.skipIf(!hasDb)("admin user management (DB + Better Auth)", () => {
  beforeAll(async () => {
    adminA = await createTestUser(P, "adminA", { role: "admin" })
    adminB = await createTestUser(P, "adminB", { role: "admin" })
    staff1 = await createTestUser(P, "staff1", { role: "staff" })
    staff2 = await createTestUser(P, "staff2", { role: "staff" })
    sA = await signIn(adminA)
    actAs(sA)
  })

  afterAll(async () => {
    await closeDb()
    await tmp?.drop()
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("tạo người dùng", () => {
    it("admin tạo nhân viên: mật khẩu tạm bắt buộc đổi, createdById, nhật ký cùng actor/ip/ua", async () => {
      const { createUserAction } = await actions()
      actAs(sA)
      const email = `${P}_new1@example.test`
      const r = await createUserAction({ name: "Nhân viên mới", email: email.toUpperCase(), role: "staff", password: "Tam-Mat-Khau-1" })
      expect(r.ok).toBe(true)
      const [created] = await db.select().from(user).where(eq(user.email, email))
      expect(created).toMatchObject({ role: "staff", mustChangePassword: true, createdById: adminA.id, banned: false })
      const log = await lastLog("user.create", created!.id)
      expect(log).toMatchObject({ actorId: adminA.id, actorEmail: adminA.email, actorRole: "admin", status: "success", targetType: "user" })
      expect(log!.ip).toBe(sA.ip)
      expect(log!.userAgent).toBe("vitest/people")
      expect(JSON.stringify(log!.metadata)).not.toContain("Tam-Mat-Khau-1")
      // the new user can sign in with the temp password
      await expect(signIn({ ...adminA, id: created!.id, email, password: "Tam-Mat-Khau-1", role: "staff" })).resolves.toBeTruthy()
    })

    it("mật khẩu tối thiểu 8 ký tự (7 bị từ chối, 8 được nhận)", async () => {
      const { createUserAction } = await actions()
      actAs(sA)
      const bad = await createUserAction({ name: "X", email: `${P}_short@example.test`, role: "staff", password: "Abcdef7" })
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.fieldErrors?.password).toMatch(/8 ký tự/)
      expect(await db.select().from(user).where(eq(user.email, `${P}_short@example.test`))).toHaveLength(0)
      const good = await createUserAction({ name: "X", email: `${P}_eight@example.test`, role: "staff", password: "Abcdef78" })
      expect(good.ok).toBe(true)
    })

    it("nhân viên không tạo được người dùng; không có dòng nào được tạo", async () => {
      const { createUserAction } = await actions()
      const s = await signIn(staff1)
      actAs(s)
      const r = await createUserAction({ name: "Hack", email: `${P}_hack@example.test`, role: "admin", password: "Hack-Mat-Khau-1" })
      expect(r).toMatchObject({ ok: false, error: "Bạn không có quyền thực hiện thao tác này." })
      expect(await db.select().from(user).where(eq(user.email, `${P}_hack@example.test`))).toHaveLength(0)
    })

    it("tạo ADMIN cần xác thực lại: thiếu → yêu cầu, sai mật khẩu → từ chối + nhật ký reauth, đúng → tạo", async () => {
      const { createUserAction } = await actions()
      actAs(sA)
      const email = `${P}_newadmin@example.test`
      const input = { name: "Admin mới", email, role: "admin", password: "Admin-Moi-2026" }
      const missing = await createUserAction(input)
      expect(missing.ok).toBe(false)
      expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0)

      const wrong = await createUserAction({ ...input, reauth: { password: "sai-mat-khau-123" } })
      expect(wrong).toMatchObject({ ok: false })
      expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0)
      const fail = await lastLog("user.create")
      expect(fail).toMatchObject({ status: "failure", actorId: adminA.id })
      expect(fail!.metadata).toMatchObject({ reauth: true })

      const ok = await createUserAction({ ...input, reauth: { password: PASSWORD } })
      expect(ok.ok).toBe(true)
      const [created] = await db.select().from(user).where(eq(user.email, email))
      expect(created).toMatchObject({ role: "admin", mustChangePassword: true, createdById: adminA.id })
    })

    it("email trùng → lỗi tiếng Việt + nhật ký thất bại, không tạo bản sao", async () => {
      const { createUserAction } = await actions()
      actAs(sA)
      const before = await logCount("user.create", "failure")
      const r = await createUserAction({ name: "Trùng", email: staff1.email, role: "staff", password: "Abcdef78" })
      expect(r).toMatchObject({ ok: false, error: "Email này đã có tài khoản. Dùng email khác." })
      expect(await logCount("user.create", "failure")).toBe(before + 1)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("đổi vai trò", () => {
    it("cần mật khẩu của admin; sai mật khẩu không đổi gì", async () => {
      const { changeUserRoleAction } = await actions()
      actAs(sA)
      const r = await changeUserRoleAction({ userId: staff2.id, role: "admin", password: "sai-mat-khau-123" })
      expect(r.ok).toBe(false)
      expect((await row(staff2.id)).role).toBe("staff")
    })

    it("nâng lên admin rồi hạ về nhân viên: có before/after trong nhật ký, tự đổi chính mình bị chặn", async () => {
      const { changeUserRoleAction } = await actions()
      actAs(sA)
      expect((await changeUserRoleAction({ userId: staff2.id, role: "admin", password: PASSWORD })).ok).toBe(true)
      expect((await row(staff2.id)).role).toBe("admin")
      expect((await lastLog("user.role.change", staff2.id))!.metadata).toEqual({ before: { role: "staff" }, after: { role: "admin" } })
      expect((await changeUserRoleAction({ userId: staff2.id, role: "staff", password: PASSWORD })).ok).toBe(true)
      expect((await row(staff2.id)).role).toBe("staff")

      const self = await changeUserRoleAction({ userId: adminA.id, role: "staff", password: PASSWORD })
      expect(self).toMatchObject({ ok: false })
      expect((await row(adminA.id)).role).toBe("admin")
    })

    it("vai trò lạ / cùng vai trò bị từ chối; nhân viên không đổi được vai trò", async () => {
      const { changeUserRoleAction } = await actions()
      actAs(sA)
      expect((await changeUserRoleAction({ userId: staff2.id, role: "superuser", password: PASSWORD })).ok).toBe(false)
      expect((await changeUserRoleAction({ userId: staff2.id, role: "staff", password: PASSWORD }))).toMatchObject({
        ok: false,
        error: "Người dùng đã có vai trò này.",
      })
      const s = await signIn(staff1)
      actAs(s)
      expect(await changeUserRoleAction({ userId: staff1.id, role: "admin", password: PASSWORD })).toMatchObject({
        ok: false,
        error: "Bạn không có quyền thực hiện thao tác này.",
      })
      expect((await row(staff1.id)).role).toBe("staff")
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("đặt lại mật khẩu / 2FA", () => {
    it("đặt lại mật khẩu nhân viên: mật khẩu cũ chết, phiên bị thu hồi, buộc đổi, log không chứa mật khẩu", async () => {
      const { resetUserPasswordAction } = await actions()
      const victim = await createTestUser(P, "rp1", { role: "staff" })
      await signIn(victim)
      expect(await sessionCount(victim.id)).toBe(1)
      actAs(sA)
      const r = await resetUserPasswordAction({ userId: victim.id, password: "Mat-Khau-Tam-2" })
      expect(r.ok).toBe(true)
      expect(await sessionCount(victim.id)).toBe(0)
      expect((await row(victim.id)).mustChangePassword).toBe(true)
      await expect(signIn(victim)).rejects.toThrow(/sign-in/)
      await expect(signIn(victim, randomIp(), "Mat-Khau-Tam-2")).resolves.toBeTruthy()
      const log = await lastLog("user.password.reset", victim.id)
      expect(log).toMatchObject({ status: "success", actorId: adminA.id })
      expect(JSON.stringify(log!.metadata)).not.toContain("Mat-Khau-Tam-2")
    })

    it("đặt lại mật khẩu: tối thiểu 8 ký tự; không tự đặt lại chính mình", async () => {
      const { resetUserPasswordAction } = await actions()
      actAs(sA)
      const short = await resetUserPasswordAction({ userId: staff1.id, password: "Abcde12" })
      expect(short.ok).toBe(false)
      const self = await resetUserPasswordAction({ userId: adminA.id, password: "Mat-Khau-Tam-3" })
      expect(self).toMatchObject({ ok: false })
    })

    it("đặt lại mật khẩu của ADMIN khác cần xác thực lại", async () => {
      const { resetUserPasswordAction } = await actions()
      actAs(sA)
      const missing = await resetUserPasswordAction({ userId: adminB.id, password: "Mat-Khau-Tam-4" })
      expect(missing.ok).toBe(false)
      await expect(signIn(adminB, randomIp(), "Mat-Khau-Tam-4")).rejects.toThrow()
      const wrong = await resetUserPasswordAction({ userId: adminB.id, password: "Mat-Khau-Tam-4", reauth: { password: "nope-nope-1" } })
      expect(wrong.ok).toBe(false)
      const ok = await resetUserPasswordAction({ userId: adminB.id, password: "Mat-Khau-Tam-4", reauth: { password: PASSWORD } })
      expect(ok.ok).toBe(true)
      adminB = { ...adminB, password: "Mat-Khau-Tam-4" }
      await expect(signIn(adminB)).resolves.toBeTruthy()
    })

    it("đặt lại 2FA của nhân viên: xoá bí mật + mã dự phòng + thiết bị tin cậy, thu hồi phiên", async () => {
      const { resetUserTwoFactorAction } = await actions()
      const victim = await createTestUser(P, "r2fa", { role: "staff" })
      const sv = await signIn(victim)
      await enableTotp(sv)
      expect((await row(victim.id)).twoFactorEnabled).toBe(true)
      actAs(sA)
      expect((await resetUserTwoFactorAction({ userId: victim.id })).ok).toBe(true)
      expect((await row(victim.id)).twoFactorEnabled).toBe(false)
      expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, victim.id))).toHaveLength(0)
      expect(await sessionCount(victim.id)).toBe(0)
      expect((await lastLog("user.2fa.reset", victim.id))!.metadata).toEqual({
        before: { twoFactorEnabled: true },
        after: { twoFactorEnabled: false },
      })
    })

    it("đặt lại 2FA của ADMIN khác cần xác thực lại; tự đặt lại chính mình bị chặn", async () => {
      const { resetUserTwoFactorAction } = await actions()
      actAs(sA)
      expect((await resetUserTwoFactorAction({ userId: adminB.id })).ok).toBe(false)
      expect((await resetUserTwoFactorAction({ userId: adminB.id, reauth: { password: "sai-sai-sai-1" } })).ok).toBe(false)
      expect((await resetUserTwoFactorAction({ userId: adminB.id, reauth: { password: PASSWORD } })).ok).toBe(true)
      expect(await resetUserTwoFactorAction({ userId: adminA.id, reauth: { password: PASSWORD } })).toMatchObject({ ok: false })
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("khoá / mở khoá", () => {
    it("khoá: xoá phiên, không đăng nhập được, cookie cũ vô hiệu; mở khoá: đăng nhập lại được", async () => {
      const { setUserBannedAction } = await actions()
      const { requireUserForAction } = await import("@/server/auth/session")
      const victim = await createTestUser(P, "ban1", { role: "staff" })
      const sv = await signIn(victim)
      actAs(sv)
      await expect(requireUserForAction()).resolves.toBeTruthy()

      actAs(sA)
      expect((await setUserBannedAction({ userId: victim.id, banned: true })).ok).toBe(true)
      expect(await sessionCount(victim.id)).toBe(0)
      expect((await lastLog("user.ban", victim.id))!.metadata).toEqual({ before: { banned: false }, after: { banned: true } })

      actAs(sv) // stale cookie of the banned user
      await expect(requireUserForAction()).rejects.toThrow(/Phiên đăng nhập/)

      const res = await authHttp("/sign-in/email", { body: { email: victim.email, password: victim.password } })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code?: string }).code).toBe("BANNED_USER")

      actAs(sA)
      expect((await setUserBannedAction({ userId: victim.id, banned: false })).ok).toBe(true)
      await expect(signIn(victim)).resolves.toBeTruthy()
      expect(await lastLog("user.unban", victim.id)).toBeTruthy()
    })

    it("cookie cũ của người bị khoá không dùng được kể cả khi phiên còn trong DB (banned đặt trực tiếp)", async () => {
      const { requireUserForAction, getSession } = await import("@/server/auth/session")
      const victim = await createTestUser(P, "ban2", { role: "staff" })
      const sv = await signIn(victim)
      await db.update(user).set({ banned: true }).where(eq(user.id, victim.id))
      actAs(sv)
      expect(await getSession()).toBeNull()
      await expect(requireUserForAction()).rejects.toThrow()
    })

    it("không tự khoá mình; nhân viên không khoá được ai", async () => {
      const { setUserBannedAction } = await actions()
      actAs(sA)
      expect(await setUserBannedAction({ userId: adminA.id, banned: true })).toMatchObject({ ok: false })
      expect((await row(adminA.id)).banned).toBe(false)
      const s = await signIn(staff1)
      actAs(s)
      expect(await setUserBannedAction({ userId: staff2.id, banned: true })).toMatchObject({
        ok: false,
        error: "Bạn không có quyền thực hiện thao tác này.",
      })
      expect((await row(staff2.id)).banned).toBe(false)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("phiên đăng nhập", () => {
    it("admin thu hồi một phiên / tất cả phiên của người khác; không thu hồi phiên của chính mình; id phiên của người khác không bị xoá", async () => {
      const { revokeUserSessionsAction, listUserSessionsAction } = await actions()
      const victim = await createTestUser(P, "sess", { role: "staff" })
      const s1 = await signIn(victim)
      await signIn(victim)
      actAs(sA)
      const list = await listUserSessionsAction({ userId: victim.id })
      expect(list.ok && list.data.length).toBe(2)
      // list never exposes the token
      expect(JSON.stringify(list)).not.toContain(s1.cookie.split("=")[1]!.split(".")[0]!)
      const one = await revokeUserSessionsAction({ userId: victim.id, sessionId: s1.sessionId })
      expect(one.ok && one.data.count).toBe(1)
      // a session id of ANOTHER user under this target user's id → nothing deleted
      const other = await revokeUserSessionsAction({ userId: victim.id, sessionId: sA.sessionId })
      expect(other.ok && other.data.count).toBe(0)
      expect(await sessionCount(adminA.id)).toBeGreaterThan(0)
      const all = await revokeUserSessionsAction({ userId: victim.id })
      expect(all.ok && all.data.count).toBe(1)
      expect(await revokeUserSessionsAction({ userId: adminA.id })).toMatchObject({ ok: false })
      expect(await lastLog("user.sessions.revoke", victim.id)).toBeTruthy()
    })

    it("nhân viên không xem/thu hồi phiên của người khác", async () => {
      const { revokeUserSessionsAction, listUserSessionsAction } = await actions()
      const s = await signIn(staff1)
      actAs(s)
      expect(await listUserSessionsAction({ userId: adminA.id })).toMatchObject({ ok: false })
      expect(await revokeUserSessionsAction({ userId: adminA.id })).toMatchObject({ ok: false })
      expect(await sessionCount(adminA.id)).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("xoá người dùng", () => {
    it("xoá nhân viên không còn tài nguyên; còn kết nối thì từ chối; không tự xoá", async () => {
      const { deleteUserAction } = await actions()
      const victim = await createTestUser(P, "del1", { role: "staff" })
      const owner = await createTestUser(P, "del2", { role: "staff" })
      await db.insert(connections).values({
        ownerId: owner.id,
        platform: "meta",
        name: `${P} conn`,
        credentialsEncrypted: encryptSecret("x", "connection:test:credentials"),
      })
      actAs(sA)
      const blocked = await deleteUserAction({ userId: owner.id })
      expect(blocked.ok).toBe(false)
      if (!blocked.ok) expect(blocked.error).toMatch(/1 kết nối/)
      expect(await row(owner.id)).toBeTruthy()

      expect((await deleteUserAction({ userId: victim.id })).ok).toBe(true)
      expect(await db.select().from(user).where(eq(user.id, victim.id))).toHaveLength(0)
      expect((await lastLog("user.delete", victim.id))!.metadata).toMatchObject({ email: victim.email, role: "staff" })

      expect(await deleteUserAction({ userId: adminA.id })).toMatchObject({ ok: false })
      const s = await signIn(staff1)
      actAs(s)
      expect(await deleteUserAction({ userId: staff2.id })).toMatchObject({ ok: false, error: "Bạn không có quyền thực hiện thao tác này." })
      expect(await row(staff2.id)).toBeTruthy()
      await db.delete(connections).where(eq(connections.ownerId, owner.id))
    })

    it("xoá admin đã tạo người khác không làm hỏng người được tạo (createdById chỉ là chuỗi tham chiếu)", async () => {
      const { deleteUserAction } = await actions()
      const creator = await createTestUser(P, "creator", { role: "admin" })
      const child = await createTestUser(P, "child", { role: "staff", createdById: creator.id })
      actAs(sA)
      expect((await deleteUserAction({ userId: creator.id })).ok).toBe(true)
      expect((await row(child.id)).createdById).toBe(creator.id)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("luật 'luôn còn ≥1 admin' theo chính sách 2FA (không khoá chủ hệ thống)", () => {
    it("chính sách tắt: admin duy nhất không có 2FA vẫn quản lý được; không thể tự hạ/khoá/xoá nên luôn còn admin", async () => {
      await setSettingRaw("require_2fa_admin", false)
      const { changeUserRoleAction, setUserBannedAction, deleteUserAction } = await actions()
      const solo = await createTestUser(P, "solo", { role: "admin" })
      const ss = await signIn(solo)
      actAs(ss)
      const target = await createTestUser(P, "solotarget", { role: "staff" })
      expect((await setUserBannedAction({ userId: target.id, banned: true })).ok).toBe(true)
      expect(await changeUserRoleAction({ userId: solo.id, role: "staff", password: PASSWORD })).toMatchObject({ ok: false })
      expect(await setUserBannedAction({ userId: solo.id, banned: true })).toMatchObject({ ok: false })
      expect(await deleteUserAction({ userId: solo.id })).toMatchObject({ ok: false })
      expect((await row(solo.id)).role).toBe("admin")
    })

    it("admin A (có 2FA) hạ admin B (không 2FA) khi chính sách admin bật: được; B bị chặn thao tác nhưng vẫn bật được 2FA", async () => {
      const { changeUserRoleAction, createUserAction } = await actions()
      const { beginTwoFactorSetupAction } = await account()
      const a = await createTestUser(P, "polA", { role: "admin" })
      const b = await createTestUser(P, "polB", { role: "admin" })
      const ta = await enableTotp(await signIn(a))
      const sb = await signIn(b)
      await setSettingRaw("require_2fa_admin", true)
      try {
        // B has no 2FA → blocked from user management, but allowed to start enrolment
        actAs(sb)
        expect(await createUserAction({ name: "x", email: `${P}_polx@example.test`, role: "staff", password: "Abcdef78" })).toMatchObject({
          ok: false,
          error: "Hệ thống yêu cầu bật xác thực 2 bước trước khi tiếp tục.",
        })
        const begin = await beginTwoFactorSetupAction({ password: b.password })
        expect(begin.ok).toBe(true)
        let sb2 = sb
        if (begin.ok) {
          const r = await authHttp("/two-factor/verify-totp", {
            body: { code: totp(begin.data.secret) },
            headers: { cookie: sb.cookie },
          })
          expect(r.status).toBe(200)
          // the session is rotated when 2FA gets enabled → continue with the new cookie
          sb2 = { ...sb, cookie: cookieOf(r), headers: anonymousHeaders(sb.ip, { cookie: cookieOf(r) }) }
        }
        expect((await row(b.id)).twoFactorEnabled).toBe(true)
        // now B can work again
        actAs(sb2)
        expect((await createUserAction({ name: "x", email: `${P}_polx@example.test`, role: "staff", password: "Abcdef78" })).ok).toBe(true)

        // A demotes B (A is a qualifying admin): fine
        actAs(ta.signed)
        const demote = await changeUserRoleAction({ userId: b.id, role: "staff", password: a.password, code: totp(ta.secret) })
        expect(demote.ok).toBe(true)
        expect((await row(b.id)).role).toBe("staff")
      } finally {
        await setSettingRaw("require_2fa_admin", false)
      }
    })

    it("chính sách bật mà admin duy nhất chưa có 2FA: vẫn đăng nhập + bật được 2FA (không kẹt)", async () => {
      const { beginTwoFactorSetupAction } = await account()
      const { updateSettingsAction } = await settingsActions()
      const { requireUserForAction } = await import("@/server/auth/session")
      // make `sole` the ONLY active admin: demote/ban everyone else directly
      await db.update(user).set({ role: "staff" }).where(and(eq(user.role, "admin")))
      const sole = await createTestUser(P, "sole", { role: "admin" })
      const ss = await signIn(sole)
      actAs(ss)
      const saved = await updateSettingsAction({
        log_retention_months_mcp: 3,
        log_retention_months_staff: 3,
        require_2fa_admin: true,
        require_2fa_all: false,
        session_max_hours: 12,
      })
      expect(saved.ok).toBe(true)
      try {
        await expect(requireUserForAction({ role: "admin" })).rejects.toThrow(/xác thực 2 bước/)
        // password step of a fresh sign-in still works (no 2FA yet → plain session)
        const again = await signIn(sole)
        actAs(again)
        const begin = await beginTwoFactorSetupAction({ password: sole.password })
        expect(begin.ok).toBe(true)
        if (begin.ok) {
          const v = await authHttp("/two-factor/verify-totp", { body: { code: totp(begin.data.secret) }, headers: { cookie: again.cookie } })
          expect(v.status).toBe(200)
          actAs({ ...again, cookie: cookieOf(v), headers: anonymousHeaders(again.ip, { cookie: cookieOf(v) }) })
        }
        await expect(requireUserForAction({ role: "admin" })).resolves.toBeTruthy()
      } finally {
        await setSettingRaw("require_2fa_admin", false)
      }
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("nhật ký ghi cùng transaction với thay đổi: ghi nhật ký lỗi thì thay đổi bị huỷ", () => {
    it("đặt lại 2FA, thu hồi phiên của người khác, đổi tên, thu hồi phiên của tôi", async () => {
      const { resetUserTwoFactorAction, revokeUserSessionsAction } = await actions()
      const { updateProfileAction, revokeOtherSessionsAction } = await account()
      const victim = await createTestUser(P, "atomic", { role: "staff" })
      const adminX = await createTestUser(P, "atomicadmin", { role: "admin" }) // earlier tests demoted adminA
      const sA = await signIn(adminX)
      const sv = await signIn(victim)
      await signIn(victim) // a second device (before 2FA exists: password sign-in would need a code afterwards)
      const tv = await enableTotp(sv)
      const before = await sessionCount(victim.id)

      flags.failLog = true
      try {
        actAs(sA)
        expect((await resetUserTwoFactorAction({ userId: victim.id })).ok).toBe(false)
        expect((await row(victim.id)).twoFactorEnabled).toBe(true)
        expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, victim.id))).toHaveLength(1)
        expect(await sessionCount(victim.id)).toBe(before)

        expect((await revokeUserSessionsAction({ userId: victim.id })).ok).toBe(false)
        expect(await sessionCount(victim.id)).toBe(before)

        actAs(tv.signed)
        expect((await updateProfileAction({ name: "Tên không được lưu" })).ok).toBe(false)
        expect((await row(victim.id)).name).not.toBe("Tên không được lưu")
        expect((await revokeOtherSessionsAction()).ok).toBe(false)
        expect(await sessionCount(victim.id)).toBe(before)
      } finally {
        flags.failLog = false
      }
      // …and once logging works again the same operations succeed and leave exactly one row each
      actAs(sA)
      expect((await resetUserTwoFactorAction({ userId: victim.id })).ok).toBe(true)
      expect((await row(victim.id)).twoFactorEnabled).toBe(false)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("hai admin thao tác lẫn nhau cùng lúc (khoá toàn cục): luôn còn đúng một admin", () => {
    it("hai admin hạ vai trò nhau song song", async () => {
      const { changeUserRoleAction } = await actions()
      const a = await createTestUser(P, "race1", { role: "admin" })
      const b = await createTestUser(P, "race2", { role: "admin" })
      // make a and b the only admins: demote everyone else
      await db.update(user).set({ role: "staff" }).where(and(eq(user.role, "admin"), eq(user.banned, false)))
      await db.update(user).set({ role: "admin" }).where(eq(user.id, a.id))
      await db.update(user).set({ role: "admin" }).where(eq(user.id, b.id))
      const sa = await signIn(a)
      const sb = await signIn(b)
      // two real concurrent requests, each with its own session
      const demote = (s: Signed, target: TestUser) =>
        runAs(s, () => changeUserRoleAction({ userId: target.id, role: "staff", password: s.user.password }))
      const [first, second] = await Promise.all([demote(sa, b), demote(sb, a)])
      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1) // the loser is refused (no longer an admin)
      expect(await db.select().from(user).where(eq(user.role, "admin"))).toHaveLength(1)
    })

    it("hai admin khoá nhau song song", async () => {
      const { setUserBannedAction } = await actions()
      const a = await createTestUser(P, "race3", { role: "admin" })
      const b = await createTestUser(P, "race4", { role: "admin" })
      await db.update(user).set({ role: "staff" }).where(eq(user.role, "admin"))
      await db.update(user).set({ role: "admin" }).where(eq(user.id, a.id))
      await db.update(user).set({ role: "admin" }).where(eq(user.id, b.id))
      const [sa, sb] = [await signIn(a), await signIn(b)]
      const ban = (s: Signed, target: TestUser) => runAs(s, () => setUserBannedAction({ userId: target.id, banned: true }))
      const [first, second] = await Promise.all([ban(sa, b), ban(sb, a)])
      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
      const active = await db.select().from(user).where(and(eq(user.role, "admin"), eq(user.banned, false)))
      expect(active).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("tắt 2FA theo chính sách (admin cũng được tắt khi chính sách không bắt buộc)", () => {
    it("admin tắt được 2FA khi chính sách tắt; bị chặn khi require_2fa_admin bật", async () => {
      const { disableTwoFactorAction } = await account()
      const a = await createTestUser(P, "dis1", { role: "admin" })
      const t = await enableTotp(await signIn(a))
      actAs(t.signed)
      await setSettingRaw("require_2fa_admin", true)
      try {
        const blocked = await disableTwoFactorAction({ password: a.password, code: totp(t.secret) })
        expect(blocked).toMatchObject({ ok: false, error: expect.stringMatching(/bắt buộc quản trị viên/) })
        expect((await row(a.id)).twoFactorEnabled).toBe(true)
      } finally {
        await setSettingRaw("require_2fa_admin", false)
      }
      const wrong = await disableTwoFactorAction({ password: "nope-nope-1", code: totp(t.secret) })
      expect(wrong).toMatchObject({ ok: false, error: "Mật khẩu hoặc mã xác thực không đúng." })
      expect((await row(a.id)).twoFactorEnabled).toBe(true)
      const ok = await disableTwoFactorAction({ password: a.password, code: totp(t.secret) })
      expect(ok).toMatchObject({ ok: true })
      expect((await row(a.id)).twoFactorEnabled).toBe(false)
      expect(await logCount("auth.2fa.disable", "success")).toBeGreaterThan(0)
    })

    it("nhân viên tắt được khi chỉ require_2fa_admin; bị chặn khi require_2fa_all", async () => {
      const { disableTwoFactorAction } = await account()
      const u = await createTestUser(P, "dis2", { role: "staff" })
      const t = await enableTotp(await signIn(u))
      actAs(t.signed)
      await setSettingRaw("require_2fa_all", true)
      try {
        expect(await disableTwoFactorAction({ password: u.password, code: totp(t.secret) })).toMatchObject({
          ok: false,
          error: "Hệ thống đang yêu cầu mọi người dùng bật xác thực 2 bước.",
        })
        expect((await row(u.id)).twoFactorEnabled).toBe(true)
      } finally {
        await setSettingRaw("require_2fa_all", false)
      }
      await setSettingRaw("require_2fa_admin", true)
      try {
        expect((await disableTwoFactorAction({ password: u.password, code: totp(t.secret) })).ok).toBe(true)
      } finally {
        await setSettingRaw("require_2fa_admin", false)
      }
    })
  })
})
