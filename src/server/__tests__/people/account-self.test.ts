// Self-service + sign-in flows (real Better Auth + DB in a private database): forced password change, password
// length boundaries, profile, own sessions, sign-out, 2FA sign-in (TOTP / backup code / trusted device), the HTTP
// allowlist of /api/auth/*, and "no user enumeration" parity of the sign-in answers.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("./temp-db")
  const t = await createTempDb("accountself")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())

import { and, desc, eq, like } from "drizzle-orm"

import { db } from "@/server/db/client"
import { activityLogs, session as sessionTable, user, verification } from "@/server/db/schema"

import {
  actAs,
  authHttp,
  closeDb,
  cookieOf,
  createTestUser,
  enableTotp,
  PASSWORD,
  randomIp,
  signIn,
  signInWithTotp,
  totp,
  uid,
  type TestUser,
} from "./harness"

const hasDb = !!tmp
const P = `tas_${uid()}`

const account = async () => import("@/server/actions/account")

async function row(id: string) {
  const [r] = await db.select().from(user).where(eq(user.id, id))
  return r!
}
async function logs(action: string, actorId: string) {
  return db
    .select()
    .from(activityLogs)
    .where(and(eq(activityLogs.action, action), eq(activityLogs.actorId, actorId)))
    .orderBy(desc(activityLogs.createdAt))
}
const sessionRows = async (userId: string) => db.select().from(sessionTable).where(eq(sessionTable.userId, userId))

describe.skipIf(!hasDb)("tài khoản của tôi + đăng nhập (DB + Better Auth)", () => {
  beforeAll(async () => {
    await createTestUser(P, "anchor", { role: "admin" })
  })
  afterAll(async () => {
    await closeDb()
    await tmp?.drop()
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("đổi mật khẩu (bắt buộc ở lần đăng nhập đầu)", () => {
    it("kiểm tra độ dài 8–128, trùng khớp, khác mật khẩu cũ - trước khi chạm vào dữ liệu", async () => {
      const { changePasswordAction } = await account()
      const u = await createTestUser(P, "pw1", { role: "staff", mustChangePassword: true, password: "Temp-Pass-1234" })
      actAs(await signIn(u))
      const base = { currentPassword: "Temp-Pass-1234", newPassword: "Abcdef78", confirmPassword: "Abcdef78" }

      const short = await changePasswordAction({ ...base, newPassword: "Abcde78", confirmPassword: "Abcde78" })
      expect(short).toMatchObject({ ok: false, fieldErrors: { newPassword: "Mật khẩu cần ít nhất 8 ký tự." } })
      const long = await changePasswordAction({ ...base, newPassword: "a".repeat(129), confirmPassword: "a".repeat(129) })
      expect(long).toMatchObject({ ok: false, fieldErrors: { newPassword: "Mật khẩu tối đa 128 ký tự." } })
      const mismatch = await changePasswordAction({ ...base, confirmPassword: "Abcdef79" })
      expect(mismatch).toMatchObject({ ok: false, fieldErrors: { confirmPassword: "Mật khẩu nhập lại không khớp." } })
      const same = await changePasswordAction({ currentPassword: "Temp-Pass-1234", newPassword: "Temp-Pass-1234", confirmPassword: "Temp-Pass-1234" })
      expect(same).toMatchObject({ ok: false, fieldErrors: { newPassword: "Mật khẩu mới phải khác mật khẩu hiện tại." } })
      expect((await row(u.id)).mustChangePassword).toBe(true)
    })

    it("mật khẩu hiện tại sai: từ chối + nhật ký thất bại (reauth); không đổi gì", async () => {
      const { changePasswordAction } = await account()
      const u = await createTestUser(P, "pw2", { role: "staff", mustChangePassword: true })
      actAs(await signIn(u))
      const r = await changePasswordAction({ currentPassword: "sai-sai-sai-1", newPassword: "Abcdef78", confirmPassword: "Abcdef78" })
      expect(r).toMatchObject({ ok: false, error: "Mật khẩu hoặc mã xác thực không đúng." })
      expect((await row(u.id)).mustChangePassword).toBe(true)
      const [l] = await logs("auth.password.change", u.id)
      expect(l).toMatchObject({ status: "failure", actorRole: "staff" })
      expect(l!.metadata).toMatchObject({ reauth: true })
    })

    it("đổi thành công mật khẩu 8 ký tự: bỏ cờ buộc đổi, thu hồi thiết bị khác, mật khẩu cũ chết, có nhật ký, không lộ mật khẩu", async () => {
      const { changePasswordAction } = await account()
      const u = await createTestUser(P, "pw3", { role: "staff", mustChangePassword: true })
      const s = await signIn(u)
      await signIn(u) // second device
      expect(await sessionRows(u.id)).toHaveLength(2)
      // a "trust this device" entry (2FA skip cookie) must not survive the password change
      const trustId = `trust-device-${P}-pw3`
      await db.insert(verification).values({ id: trustId, identifier: trustId, value: u.id, expiresAt: new Date(Date.now() + 86_400_000) })
      actAs(s)
      const r = await changePasswordAction({ currentPassword: PASSWORD, newPassword: "NewPass8", confirmPassword: "NewPass8" })
      expect(r).toMatchObject({ ok: true })
      expect(await db.select().from(verification).where(eq(verification.id, trustId))).toHaveLength(0)
      expect((await row(u.id)).mustChangePassword).toBe(false)
      // other devices are gone (Better Auth keeps/rotates only the current one)
      expect((await sessionRows(u.id)).length).toBeLessThanOrEqual(1)
      await expect(signIn(u)).rejects.toThrow(/sign-in/)
      await expect(signIn(u, randomIp(), "NewPass8")).resolves.toBeTruthy()
      const [l] = await logs("auth.password.change", u.id)
      expect(l).toMatchObject({ status: "success", targetType: "user", targetId: u.id, actorEmail: u.email })
      expect(JSON.stringify(await db.select().from(activityLogs).where(like(activityLogs.actorEmail, `${P}%`)))).not.toMatch(/NewPass8|Correct-Horse/)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("hồ sơ + phiên của tôi", () => {
    it("đổi tên: kiểm tra độ dài, ghi nhật ký before/after, tên không đổi thì không ghi", async () => {
      const { updateProfileAction } = await account()
      const u = await createTestUser(P, "prof", { role: "staff" })
      actAs(await signIn(u))
      expect(await updateProfileAction({ name: "   " })).toMatchObject({ ok: false })
      expect(await updateProfileAction({ name: "x".repeat(101) })).toMatchObject({ ok: false })
      expect(await updateProfileAction({ name: "Tên Mới" })).toMatchObject({ ok: true })
      expect((await row(u.id)).name).toBe("Tên Mới")
      const l = await logs("user.update", u.id)
      expect(l).toHaveLength(1)
      expect(l[0]!.metadata).toEqual({ before: { name: `${P} prof` }, after: { name: "Tên Mới" } })
      await updateProfileAction({ name: "Tên Mới" })
      expect(await logs("user.update", u.id)).toHaveLength(1)
    })

    it("thu hồi phiên của tôi: chỉ phiên của chính mình, không thu hồi phiên hiện tại, ghi nhật ký", async () => {
      const { revokeMySessionAction, revokeOtherSessionsAction } = await account()
      const u = await createTestUser(P, "mys", { role: "staff" })
      const other = await createTestUser(P, "mys2", { role: "staff" })
      const s1 = await signIn(u)
      const s2 = await signIn(u)
      const so = await signIn(other)
      actAs(s1)
      // another user's session id → nothing happens to it
      await revokeMySessionAction(so.sessionId)
      expect(await sessionRows(other.id)).toHaveLength(1)
      // the current session cannot be revoked through "revoke one"
      await revokeMySessionAction(s1.sessionId)
      expect((await sessionRows(u.id)).map((r) => r.id)).toContain(s1.sessionId)
      await revokeMySessionAction(s2.sessionId)
      expect((await sessionRows(u.id)).map((r) => r.id)).toEqual([s1.sessionId])
      await signIn(u)
      await revokeOtherSessionsAction()
      expect((await sessionRows(u.id)).map((r) => r.id)).toEqual([s1.sessionId])
      const l = await logs("user.sessions.revoke", u.id)
      expect(l.length).toBeGreaterThanOrEqual(2)
      expect(l[0]!.metadata).toMatchObject({ self: true })
    })

    it("đăng xuất xoá phiên và ghi auth.logout", async () => {
      const { signOutAction } = await import("@/server/actions/auth")
      const u = await createTestUser(P, "out", { role: "staff" })
      const s = await signIn(u)
      actAs(s)
      await expect(signOutAction()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") })
      expect(await sessionRows(u.id)).toHaveLength(0)
      expect(await logs("auth.logout", u.id)).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("bề mặt HTTP /api/auth/* chỉ gồm những gì trình duyệt thật sự dùng", () => {
    it("mọi endpoint khác (đổi mật khẩu, sửa hồ sơ, thu hồi phiên, danh sách phiên, 2FA enable/disable…) trả 404 qua HTTP, kể cả khi đã đăng nhập", async () => {
      const u = await createTestUser(P, "http", { role: "staff" })
      const s = await signIn(u)
      const probes: [string, string][] = [
        ["POST", "/change-password"],
        ["POST", "/update-user"],
        ["POST", "/revoke-session"],
        ["POST", "/revoke-sessions"],
        ["POST", "/revoke-other-sessions"],
        ["GET", "/list-sessions"],
        ["GET", "/list-accounts"],
        ["POST", "/two-factor/enable"],
        ["POST", "/two-factor/disable"],
        ["POST", "/two-factor/get-totp-uri"],
        ["POST", "/two-factor/generate-backup-codes"],
        ["POST", "/sign-up/email"],
        ["POST", "/change-email"],
        ["POST", "/delete-user"],
        ["POST", "/request-password-reset"],
        ["POST", "/reset-password"],
        ["POST", "/set-password"],
      ]
      for (const [method, path] of probes) {
        const withSession = await authHttp(path, { method, headers: { cookie: s.cookie }, body: method === "POST" ? {} : undefined })
        expect(withSession.status, `${method} ${path} (signed in)`).toBe(404)
        const anon = await authHttp(path, { method, body: method === "POST" ? {} : undefined })
        expect(anon.status, `${method} ${path} (anonymous)`).toBe(404)
      }
      // nothing happened to the account/session
      expect((await row(u.id)).name).toBe(`${P} http`)
      expect(await sessionRows(u.id)).toHaveLength(1)
    })

    it("các endpoint trình duyệt cần vẫn hoạt động: get-session, sign-out, sign-in, ok", async () => {
      const u = await createTestUser(P, "http2", { role: "staff" })
      const s = await signIn(u)
      expect((await authHttp("/get-session", { method: "GET", headers: { cookie: s.cookie } })).status).toBe(200)
      expect((await authHttp("/ok", { method: "GET" })).status).toBe(200)
      const out = await authHttp("/sign-out", { headers: { cookie: s.cookie }, body: {} })
      expect(out.status).toBe(200)
      expect(await sessionRows(u.id)).toHaveLength(0)
      expect((await logs("auth.logout", u.id)).length).toBe(1)
    })

    // Origin/CSRF checks of Better Auth are disabled by the library itself when NODE_ENV=test → covered by the
    // Playwright spec tests/e2e/authz-matrix.spec.ts (real server, NODE_ENV=development).
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("đăng nhập: không lộ tài khoản nào tồn tại", () => {
    it("email không tồn tại và mật khẩu sai trả lời giống hệt nhau (status, mã, nội dung, không cookie)", async () => {
      const u = await createTestUser(P, "enum", { role: "staff" })
      const wrong = await authHttp("/sign-in/email", { body: { email: u.email, password: "sai-sai-sai-1" } })
      const unknown = await authHttp("/sign-in/email", { body: { email: `${P}_nobody@example.test`, password: "sai-sai-sai-1" } })
      expect(wrong.status).toBe(401)
      expect(unknown.status).toBe(wrong.status)
      expect(await unknown.json()).toEqual(await wrong.json())
      expect(cookieOf(wrong)).toBe("")
      expect(cookieOf(unknown)).toBe("")
    })

    it("giới hạn tốc độ đăng nhập: lần thứ 6 trong 1 phút từ cùng một IP bị Better Auth chặn 429 (trước ngưỡng khoá 10 lần)", async () => {
      const u = await createTestUser(P, "ratelimit", { role: "staff" })
      const ip = randomIp()
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) statuses.push((await authHttp("/sign-in/email", { body: { email: u.email, password: `sai-sai-${i}-xx` }, ip })).status)
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
      expect(statuses[5]).toBe(429)
      // another IP is unaffected
      expect((await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip: randomIp() })).status).toBe(200)
    })

    it("mật khẩu tối thiểu 8 ký tự cũng được Better Auth bắt ở mức thấp nhất (admin đặt lại / người dùng đổi trực tiếp qua API server)", async () => {
      const { getAuth } = await import("@/server/auth/auth")
      const u = await createTestUser(P, "bapw", { role: "staff" })
      const s = await signIn(u)
      await expect(
        getAuth().api.changePassword({ body: { currentPassword: u.password, newPassword: "Abcde12" }, headers: s.headers })
      ).rejects.toMatchObject({ body: { code: "PASSWORD_TOO_SHORT" } })
      await expect(
        getAuth().api.changePassword({ body: { currentPassword: u.password, newPassword: "a".repeat(129) }, headers: s.headers })
      ).rejects.toMatchObject({ body: { code: "PASSWORD_TOO_LONG" } })
    })

    it("email viết hoa/khoảng trắng vẫn đăng nhập được và được chuẩn hoá khi đếm khoá", async () => {
      const u = await createTestUser(P, "case", { role: "staff" })
      const r = await authHttp("/sign-in/email", { body: { email: `  ${u.email.toUpperCase()} `.trim(), password: PASSWORD } })
      expect(r.status).toBe(200)
    })

    it("nhật ký đăng nhập thất bại ghi email + lý do, không ghi mật khẩu; thành công ghi IP/thiết bị", async () => {
      const u = await createTestUser(P, "logs", { role: "staff" })
      const ip = randomIp()
      await authHttp("/sign-in/email", { body: { email: u.email, password: "Wrong-Password-77" }, ip })
      await signIn(u, ip)
      const failure = (await logs("auth.login.failure", u.id))[0]!
      expect(failure).toMatchObject({ status: "failure", actorEmail: u.email, ip, userAgent: "vitest/people" })
      expect(failure.metadata).toMatchObject({ reason: "INVALID_EMAIL_OR_PASSWORD" })
      const success = (await logs("auth.login.success", u.id))[0]!
      expect(success).toMatchObject({ status: "success", ip })
      expect(JSON.stringify([failure, success])).not.toMatch(/Wrong-Password-77|Correct-Horse/)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("2FA khi đăng nhập", () => {
    it("tài khoản bật 2FA: bước mật khẩu chưa cấp phiên; mã sai → 401 + nhật ký; mã đúng → phiên; mã dự phòng dùng được 1 lần", async () => {
      const u = await createTestUser(P, "2fa", { role: "staff" })
      const t = await enableTotp(await signIn(u))
      const ip = randomIp()
      const first = await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip })
      expect(((await first.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)
      const challenge = cookieOf(first)
      expect(challenge).toMatch(/two_factor/)
      expect(challenge).not.toMatch(/session_token/)
      const sessionsBefore = (await sessionRows(u.id)).length

      const bad = await authHttp("/two-factor/verify-totp", { body: { code: "000000" }, headers: { cookie: challenge }, ip })
      expect(bad.status).toBe(401)
      expect((await sessionRows(u.id)).length).toBe(sessionsBefore)
      expect((await logs("auth.login.failure", u.id)).some((l) => (l.metadata as { stage?: string }).stage === "2fa")).toBe(true)

      const good = await authHttp("/two-factor/verify-totp", { body: { code: totp(t.secret) }, headers: { cookie: challenge }, ip })
      expect(good.status).toBe(200)
      expect(cookieOf(good)).toMatch(/session_token/)
      expect((await logs("auth.login.success", u.id)).some((l) => (l.metadata as { method?: string }).method === "totp")).toBe(true)

      // backup code: works once
      const code = t.backupCodes[0]!
      const c1 = cookieOf(await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip }))
      const okBackup = await authHttp("/two-factor/verify-backup-code", { body: { code }, headers: { cookie: c1 }, ip })
      expect(okBackup.status).toBe(200)
      const c2 = cookieOf(await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip }))
      const reuse = await authHttp("/two-factor/verify-backup-code", { body: { code }, headers: { cookie: c2 }, ip })
      expect(reuse.status).toBeGreaterThanOrEqual(400)
    })

    it("sai mã 2FA quá nhiều lần thì khoá 2FA tạm thời (không bị dò mã vô hạn)", async () => {
      const u = await createTestUser(P, "2falock", { role: "staff" })
      const t = await enableTotp(await signIn(u))
      let last = 0
      for (let i = 0; i < 12; i++) {
        const ip = randomIp()
        const c = cookieOf(await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip }))
        const r = await authHttp("/two-factor/verify-totp", { body: { code: "111111" }, headers: { cookie: c }, ip })
        last = r.status
      }
      expect([401, 429]).toContain(last)
      // after the failures even a valid code is refused while the account lock lasts
      const ip = randomIp()
      const c = cookieOf(await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip }))
      const r = await authHttp("/two-factor/verify-totp", { body: { code: totp(t.secret) }, headers: { cookie: c }, ip })
      expect(r.status).toBe(429)
    })

    it("quản trị viên không bao giờ nhận cookie 'tin thiết bị này'; nhân viên thì có và bỏ qua được 2FA ở lần sau", async () => {
      const adm = await createTestUser(P, "td_admin", { role: "admin" })
      const stf = await createTestUser(P, "td_staff", { role: "staff" })
      const ta = await enableTotp(await signIn(adm))
      const ts = await enableTotp(await signIn(stf))
      for (const [u, secret, expectTrusted] of [
        [adm, ta.secret, false],
        [stf, ts.secret, true],
      ] as const) {
        const ip = randomIp()
        const c = cookieOf(await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip }))
        const v = await authHttp("/two-factor/verify-totp", { body: { code: totp(secret), trustDevice: true }, headers: { cookie: c }, ip })
        expect(v.status).toBe(200)
        const trusted = /trust_device/.test(v.headers.getSetCookie().join("\n"))
        expect(trusted, u.email).toBe(expectTrusted)
        if (expectTrusted) {
          // next password sign-in with that cookie: straight to a session (2FA skipped on this device)
          const again = await authHttp("/sign-in/email", {
            body: { email: u.email, password: u.password },
            headers: { cookie: v.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ") },
            ip,
          })
          expect(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined()
        }
      }
      expect(await db.select().from(verification).where(like(verification.identifier, "trust-device-%"))).toHaveLength(1)
    })

    it("tạo lại mã dự phòng cần mật khẩu + mã TOTP; sai thì không đổi mã", async () => {
      const { regenerateBackupCodesAction } = await account()
      const u = await createTestUser(P, "regen", { role: "staff" })
      const t = await enableTotp(await signIn(u))
      actAs(t.signed)
      const noCode = await regenerateBackupCodesAction({ password: u.password })
      expect(noCode).toMatchObject({ ok: false, error: "Nhập mã xác thực 6 số từ ứng dụng Authenticator." })
      const wrong = await regenerateBackupCodesAction({ password: "sai-sai-sai-1", code: totp(t.secret) })
      expect(wrong).toMatchObject({ ok: false })
      const ok = await regenerateBackupCodesAction({ password: u.password, code: totp(t.secret) })
      expect(ok.ok && ok.data.backupCodes).toHaveLength(10)
      expect((await logs("auth.2fa.backup_codes.regenerate", u.id)).length).toBeGreaterThanOrEqual(1)
      // the old codes no longer work
      const ip = randomIp()
      const c = cookieOf(await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip }))
      const old = await authHttp("/two-factor/verify-backup-code", { body: { code: t.backupCodes[1]! }, headers: { cookie: c }, ip })
      expect(old.status).toBeGreaterThanOrEqual(400)
    })

    it("bắt đầu bật 2FA cần mật khẩu đúng và bị từ chối khi đã bật", async () => {
      const { beginTwoFactorSetupAction } = await account()
      const u = await createTestUser(P, "begin", { role: "staff" })
      const s = await signIn(u)
      actAs(s)
      expect(await beginTwoFactorSetupAction({ password: "sai-sai-sai-1" })).toMatchObject({ ok: false })
      const begin = await beginTwoFactorSetupAction({ password: u.password })
      expect(begin.ok).toBe(true)
      // the secret is not active until the first code is verified
      expect((await row(u.id)).twoFactorEnabled).toBeFalsy()
      const t = await enableTotp(s)
      actAs(t.signed)
      expect(await beginTwoFactorSetupAction({ password: u.password })).toMatchObject({ ok: false, error: "Xác thực 2 bước đã được bật." })
    })
  })

  it("đăng nhập 2FA bằng helper hoạt động với cả mã của bước thời gian lân cận (±30s)", async () => {
    const u: TestUser = await createTestUser(P, "window", { role: "staff" })
    const t = await enableTotp(await signIn(u))
    await expect(signInWithTotp(u, t.secret, 30_000)).resolves.toBeTruthy()
    await expect(signInWithTotp(u, t.secret, -30_000)).resolves.toBeTruthy()
  })
})
