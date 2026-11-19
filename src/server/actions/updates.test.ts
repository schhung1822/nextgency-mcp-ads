// checkUpdatesAction / startUpdateAction and GET /api/updates/status: admin only (staff and anonymous refused),
// re-auth enforced, strict zod input, nothing written on refusal. Private throw-away Postgres database.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) -> DB tests are skipped */
  }
  const { createTempDb } = await import("@/server/__tests__/people/temp-db")
  const t = await createTempDb("updact")
  if (t) process.env.DATABASE_URL = t.url
  return t
})

// create/drop of the private database + pool shutdown can exceed the 10 s default hook timeout while the whole suite runs
vi.setConfig({ hookTimeout: 60_000 })
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
const requireUserForAction = vi.fn()
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserForAction: (...a: unknown[]) => requireUserForAction(...a),
}))
// the real Better Auth verification needs a request; the gate itself (budget, logging, transaction) stays real
const verifierOutcome = vi.hoisted(() => ({ value: "ok" as "ok" | "bad_password" | "bad_code" | "code_required" }))
vi.mock("@/server/auth/reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/reauth")>()),
  requestReauthVerifier: async () => async () => verifierOutcome.value,
}))

import { and, eq, inArray, like } from "drizzle-orm"

import { db, pool } from "@/server/db/client"
import { activityLogs, appSettings, systemUpdateRequests, user } from "@/server/db/schema"
import { UPDATE_LATEST_KEY, UPDATER_HEARTBEAT_KEY } from "@/server/jobs/lib/update-check"

import { GET as statusRoute } from "@/app/api/updates/status/route"
import { AuthorizationError } from "@/server/auth/session"
import { checkUpdatesAction, startUpdateAction } from "./updates"

const hasDb = !!tmp
const P = `tua_${randomUUID().slice(0, 8)}`
const adminId = `${P}_admin`
const staffId = `${P}_staff`
const PASSWORD = "Correct-Horse-Battery-9"

function session(id: string, role: "admin" | "staff") {
  return {
    sessionId: `${P}_s_${id}`,
    user: { id, email: `${id}@example.test`, name: id, role, twoFactorEnabled: false, mustChangePassword: false, banned: false },
  }
}
const asAdmin = () => requireUserForAction.mockResolvedValue(session(adminId, "admin"))
const asStaff = () => requireUserForAction.mockResolvedValue(session(staffId, "staff"))
const asNobody = () => requireUserForAction.mockRejectedValue(new AuthorizationError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."))

async function setKey(key: string, value: unknown) {
  await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } })
}
const rows = () => db.select().from(systemUpdateRequests)

describe.skipIf(!hasDb)("server actions cập nhật hệ thống (DB)", () => {
  const prevVersion = process.env.APP_BUILD_VERSION

  beforeAll(async () => {
    await db.insert(user).values([
      { id: adminId, name: "Admin", email: `${adminId}@example.test`, emailVerified: true, role: "admin" },
      { id: staffId, name: "Staff", email: `${staffId}@example.test`, emailVerified: true, role: "staff" },
    ])
  })

  afterAll(async () => {
    if (prevVersion === undefined) delete process.env.APP_BUILD_VERSION
    else process.env.APP_BUILD_VERSION = prevVersion
    await pool().end()
    ;(globalThis as Record<string, unknown>).__adsMcpPool = undefined
    ;(globalThis as Record<string, unknown>).__adsMcpDb = undefined
    await tmp?.drop()
  })

  beforeEach(async () => {
    process.env.APP_BUILD_VERSION = "1.2.0"
    verifierOutcome.value = "ok"
    requireUserForAction.mockReset()
    await db.delete(systemUpdateRequests)
    await db.delete(appSettings).where(inArray(appSettings.key, [UPDATE_LATEST_KEY, UPDATER_HEARTBEAT_KEY]))
    await db.delete(activityLogs).where(like(activityLogs.actorId, `${P}%`))
    await setKey(UPDATE_LATEST_KEY, {
      version: "1.3.0",
      tag: "v1.3.0",
      publishedAt: null,
      notes: "",
      url: "https://github.com/schhung1822/nextgency-mcp-ads/releases/tag/v1.3.0",
      checkedAt: new Date().toISOString(),
    })
    await setKey(UPDATER_HEARTBEAT_KEY, { at: new Date().toISOString(), version: "1.2.0", composeProject: "ads-mcp" })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("startUpdateAction", () => {
    it("quản trị viên + mật khẩu đúng: tạo yêu cầu pending và ghi nhật ký", async () => {
      asAdmin()
      const r = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toMatchObject({ fromVersion: "1.2.0", targetVersion: "1.3.0" })
      expect(requireUserForAction).toHaveBeenCalledWith({ role: "admin" })
      const [row] = await rows()
      expect(row).toMatchObject({ status: "pending", requestedBy: adminId })
      const logs = await db.select().from(activityLogs).where(and(eq(activityLogs.actorId, adminId), eq(activityLogs.action, "system.update_requested")))
      expect(logs).toHaveLength(1)
    })

    it("nhân viên bị chặn, không ghi gì", async () => {
      requireUserForAction.mockRejectedValue(new AuthorizationError())
      const r = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })
      expect(r.ok).toBe(false)
      expect(await rows()).toHaveLength(0)
    })

    it("kể cả khi tầng phiên bỏ sót, service vẫn từ chối vai trò staff", async () => {
      asStaff() // simulates a guard regression: a staff session reaches the action
      const r = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("quản trị viên")
      expect(await rows()).toHaveLength(0)
      expect(await db.select().from(activityLogs).where(eq(activityLogs.actorId, staffId))).toHaveLength(0)
    })

    it("chưa đăng nhập bị chặn", async () => {
      asNobody()
      expect((await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })).ok).toBe(false)
      expect(await rows()).toHaveLength(0)
    })

    it("mật khẩu sai: từ chối, không tạo yêu cầu, ghi log thất bại", async () => {
      asAdmin()
      verifierOutcome.value = "bad_password"
      const r = await startUpdateAction({ targetVersion: "1.3.0", password: "sai" })
      expect(r.ok).toBe(false)
      expect(await rows()).toHaveLength(0)
      const failures = await db
        .select()
        .from(activityLogs)
        .where(and(eq(activityLogs.actorId, adminId), eq(activityLogs.action, "system.update_requested"), eq(activityLogs.status, "failure")))
      expect(failures).toHaveLength(1)
    })

    it("thiếu mật khẩu hoặc mã 2FA sai định dạng: lỗi theo trường, không chạm DB", async () => {
      asAdmin()
      const noPass = await startUpdateAction({ targetVersion: "1.3.0" })
      expect(noPass.ok).toBe(false)
      if (!noPass.ok) expect(noPass.fieldErrors?.password).toBeTruthy()
      const badCode = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD, code: "12ab" })
      expect(badCode.ok).toBe(false)
      if (!badCode.ok) expect(badCode.fieldErrors?.code).toBeTruthy()
      expect(await rows()).toHaveLength(0)
    })

    it.each([undefined, null, 130, "latest", "1.3", "v1.3.0", "1.3.0 ", "1.3.0; reboot"])("phiên bản đích không hợp lệ %j bị từ chối", async (target) => {
      asAdmin()
      const r = await startUpdateAction({ targetVersion: target, password: PASSWORD })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.fieldErrors?.targetVersion).toBeTruthy()
      expect(await rows()).toHaveLength(0)
    })

    it("phiên bản đích khác bản mới nhất server biết bị từ chối", async () => {
      asAdmin()
      const r = await startUpdateAction({ targetVersion: "9.9.9", password: PASSWORD })
      expect(r.ok).toBe(false)
      expect(await rows()).toHaveLength(0)
    })

    it("gửi trùng: lần thứ hai bị từ chối, vẫn chỉ 1 yêu cầu", async () => {
      asAdmin()
      expect((await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })).ok).toBe(true)
      const again = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })
      expect(again.ok).toBe(false)
      expect(await rows()).toHaveLength(1)
    })

    it("updater offline: từ chối với thông báo tiếng Việt", async () => {
      asAdmin()
      await db.delete(appSettings).where(eq(appSettings.key, UPDATER_HEARTBEAT_KEY))
      const r = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("cập nhật")
    })

    it("lỗi bất ngờ không lộ chi tiết kỹ thuật", async () => {
      asAdmin()
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
      await pool().query("alter table system_update_requests rename to system_update_requests_x")
      try {
        const r = await startUpdateAction({ targetVersion: "1.3.0", password: PASSWORD })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).not.toMatch(/relation|sql|select|insert|system_update/i)
      } finally {
        await pool().query("alter table system_update_requests_x rename to system_update_requests")
        err.mockRestore()
      }
    })
  })

  describe("checkUpdatesAction", () => {
    it("nhân viên và người chưa đăng nhập bị chặn, không gọi GitHub", async () => {
      const f = vi.fn()
      vi.stubGlobal("fetch", f)
      requireUserForAction.mockRejectedValue(new AuthorizationError())
      expect((await checkUpdatesAction()).ok).toBe(false)
      asNobody()
      expect((await checkUpdatesAction()).ok).toBe(false)
      asStaff()
      expect((await checkUpdatesAction()).ok).toBe(false)
      expect(f).not.toHaveBeenCalled()
    })

    it("quản trị viên kiểm tra được và nhận trạng thái mới", async () => {
      asAdmin()
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tag_name: "v1.4.0", body: "mới" })))
      const r = await checkUpdatesAction()
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.error).toBeNull()
        expect(r.data.status.latest?.version).toBe("1.4.0")
      }
    })

    it("GitHub lỗi vẫn là kết quả ok (kèm thông báo) để giao diện hiện lý do", async () => {
      asAdmin()
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })))
      const r = await checkUpdatesAction()
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.error).toContain("token")
    })
  })

  describe("GET /api/updates/status", () => {
    it("quản trị viên: 200, JSON, no-store", async () => {
      asAdmin()
      const res = await statusRoute()
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("no-store")
      const body = await res.json()
      expect(body).toMatchObject({ current: "1.2.0", hasUpdate: true, updater: { online: true }, blockReason: null })
    })

    it("nhân viên: 404 (không lộ trang tồn tại)", async () => {
      asStaff()
      const res = await statusRoute()
      expect(res.status).toBe(404)
      expect(res.headers.get("cache-control")).toBe("no-store")
    })

    it("chưa đăng nhập: 401", async () => {
      asNobody()
      expect((await statusRoute()).status).toBe(401)
    })

    it("database lỗi: 503 chịu lỗi, không ném và không lộ chi tiết", async () => {
      asAdmin()
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
      await pool().query("alter table system_update_requests rename to system_update_requests_x")
      try {
        const res = await statusRoute()
        expect(res.status).toBe(503)
        expect(await res.text()).not.toMatch(/relation|sql|system_update/i)
      } finally {
        await pool().query("alter table system_update_requests_x rename to system_update_requests")
        err.mockRestore()
      }
    })
  })
})
