// Update system against a throw-away Postgres database (migrated with the real migrations, so 0002 is exercised):
// startUpdate refusals + happy path + races, status aggregation, version badge, manual check, the update.check
// job and the guarantee that the internal app_settings keys never leak into the Settings form.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) -> DB tests are skipped */
  }
  const { createTempDb } = await import("@/server/__tests__/people/temp-db")
  const t = await createTempDb("updates")
  if (t) process.env.DATABASE_URL = t.url
  return t
})

// create/drop of the private database + pool shutdown can exceed the 10 s default hook timeout while the whole suite runs
vi.setConfig({ hookTimeout: 60_000 })
const flags = vi.hoisted(() => ({ failLog: false }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
// lets a test make the activity_logs insert fail, to prove the business change rolls back with it
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...actual,
    logActivity: async (...args: Parameters<typeof actual.logActivity>) => {
      if (flags.failLog) throw new Error("log down")
      return actual.logActivity(...args)
    },
  }
})

import { and, eq, inArray, like } from "drizzle-orm"

import { getAppVersion } from "@/server/app-version"
import { db, pool } from "@/server/db/client"
import { activityLogs, appSettings, systemUpdateRequests, user } from "@/server/db/schema"
import { updateCheckJob } from "@/server/jobs/update-check"
import { UPDATE_CHECK_ERROR_KEY, UPDATE_LATEST_KEY, UPDATER_HEARTBEAT_KEY } from "@/server/jobs/lib/update-check"
import { getAllSettings } from "@/server/services/settings"

import {
  checkForUpdatesNow,
  deriveBlockReason,
  getUpdateStatus,
  getVersionBadge,
  isBlockingRequest,
  isUpdaterOnline,
  startUpdate,
  STALE_PENDING_MS,
  UpdateServiceError,
  type UpdateActor,
} from "./updates"

const hasDb = !!tmp
const P = `tupd_${randomUUID().slice(0, 8)}`
const admin: UpdateActor = { id: `${P}_admin`, email: `${P}_admin@example.test`, role: "admin" }
const admin2: UpdateActor = { id: `${P}_admin2`, email: `${P}_admin2@example.test`, role: "admin" }
const staff: UpdateActor = { id: `${P}_staff`, email: `${P}_staff@example.test`, role: "staff" }

const okVerify = async () => "ok" as const
const NOW = new Date("2026-10-03T10:00:00Z")

async function setKey(key: string, value: unknown) {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
}

function setLatest(version: string, extra: Record<string, unknown> = {}) {
  return setKey(UPDATE_LATEST_KEY, {
    version,
    tag: `v${version}`,
    publishedAt: "2026-10-01T00:00:00.000Z",
    notes: "ghi chú",
    url: `https://github.com/schhung1822/nextgency-mcp-ads/releases/tag/v${version}`,
    checkedAt: NOW.toISOString(),
    ...extra,
  })
}

function setHeartbeat(secondsAgo: number, now = new Date()) {
  return setKey(UPDATER_HEARTBEAT_KEY, {
    at: new Date(now.getTime() - secondsAgo * 1000).toISOString(),
    version: "1.2.0",
    composeProject: "ads-mcp",
  })
}

const rows = () => db.select().from(systemUpdateRequests)
const logsOf = (action: string, actorId = admin.id) =>
  db.select().from(activityLogs).where(and(eq(activityLogs.actorId, actorId), eq(activityLogs.action, action)))

describe("thuần: heartbeat và lý do khoá nút", () => {
  it("updater online khi heartbeat < 90 giây", () => {
    const at = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString()
    expect(isUpdaterOnline(at(0), NOW)).toBe(true)
    expect(isUpdaterOnline(at(89), NOW)).toBe(true)
    expect(isUpdaterOnline(at(90), NOW)).toBe(false)
    expect(isUpdaterOnline(at(600), NOW)).toBe(false)
    expect(isUpdaterOnline(null, NOW)).toBe(false)
    expect(isUpdaterOnline("không phải ngày", NOW)).toBe(false)
    // heartbeat far in the future (clock skew / tampering) does not count as online
    expect(isUpdaterOnline(at(-3600), NOW)).toBe(false)
  })

  it("pending chỉ chặn khi còn trẻ; running luôn chặn", () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
    expect(isBlockingRequest({ status: "running", createdAt: ago(60 * 60_000) }, NOW)).toBe(true)
    expect(isBlockingRequest({ status: "pending", createdAt: ago(1000) }, NOW)).toBe(true)
    expect(isBlockingRequest({ status: "pending", createdAt: ago(STALE_PENDING_MS + 1) }, NOW)).toBe(false)
    expect(isBlockingRequest({ status: "failed", createdAt: ago(1) }, NOW)).toBe(false)
  })

  it("deriveBlockReason theo thứ tự ưu tiên", () => {
    const base = { currentIsRelease: true, hasUpdate: true, active: null, updaterOnline: true, now: NOW }
    expect(deriveBlockReason(base)).toBeNull()
    expect(deriveBlockReason({ ...base, currentIsRelease: false })).toBe("dev_build")
    expect(deriveBlockReason({ ...base, active: { status: "running", createdAt: NOW.toISOString() } })).toBe("busy")
    expect(deriveBlockReason({ ...base, hasUpdate: false })).toBe("no_update")
    expect(deriveBlockReason({ ...base, updaterOnline: false })).toBe("updater_offline")
  })
})

describe.skipIf(!hasDb)("hệ thống cập nhật (DB)", () => {
  const prevVersion = process.env.APP_BUILD_VERSION

  beforeAll(async () => {
    await db.insert(user).values(
      [admin, admin2, staff].map((u) => ({
        id: u.id,
        name: P,
        email: u.email,
        emailVerified: true,
        role: u.role,
        twoFactorEnabled: true,
        banned: false,
      }))
    )
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
    await db.delete(systemUpdateRequests)
    await db.delete(appSettings).where(inArray(appSettings.key, [UPDATE_LATEST_KEY, UPDATE_CHECK_ERROR_KEY, UPDATER_HEARTBEAT_KEY]))
    await db.delete(activityLogs).where(like(activityLogs.actorId, `${P}%`))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** latest 1.3.0 known, updater online */
  async function ready() {
    await setLatest("1.3.0")
    await setHeartbeat(10)
  }

  describe("startUpdate - điều kiện từ chối", () => {
    it("nhân viên bị chặn ở service, không gọi xác minh mật khẩu, không ghi gì", async () => {
      await ready()
      const verify = vi.fn(okVerify)
      await expect(startUpdate(staff, { targetVersion: "1.3.0" }, verify)).rejects.toMatchObject({ code: "forbidden" })
      expect(verify).not.toHaveBeenCalled()
      expect(await rows()).toHaveLength(0)
      expect(await logsOf("system.update_requested", staff.id)).toHaveLength(0)
    })

    it.each(["", "1.3", "v1.3.0", "1.3.0-rc1", "1.3.0; rm -rf /", "../1.3.0", 130])("từ chối phiên bản đích không hợp lệ %j", async (target) => {
      await ready()
      const verify = vi.fn(okVerify)
      await expect(startUpdate(admin, { targetVersion: target }, verify)).rejects.toMatchObject({ code: "invalid_target" })
      expect(verify).not.toHaveBeenCalled()
      expect(await rows()).toHaveLength(0)
    })

    it("từ chối khi chưa biết bản mới nào hoặc bản mới nhất không mới hơn bản đang chạy", async () => {
      await setHeartbeat(5)
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "no_update" })
      await setLatest("1.2.0")
      await expect(startUpdate(admin, { targetVersion: "1.2.0" }, okVerify)).rejects.toMatchObject({ code: "no_update" })
      await setLatest("1.1.0")
      await expect(startUpdate(admin, { targetVersion: "1.1.0" }, okVerify)).rejects.toMatchObject({ code: "no_update" })
      expect(await rows()).toHaveLength(0)
    })

    it("target phải đúng bản mới nhất do SERVER lưu (không tin chuỗi client), kể cả khi lớn hơn", async () => {
      await ready()
      for (const target of ["1.9.9", "1.2.9", "9.0.0"]) {
        const verify = vi.fn(okVerify)
        await expect(startUpdate(admin, { targetVersion: target }, verify)).rejects.toMatchObject({ code: "target_mismatch" })
        expect(verify).not.toHaveBeenCalled()
      }
      expect(await rows()).toHaveLength(0)
    })

    it("từ chối khi updater offline (không có heartbeat hoặc heartbeat cũ)", async () => {
      await setLatest("1.3.0")
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "updater_offline" })
      await setHeartbeat(91)
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "updater_offline" })
      expect(await rows()).toHaveLength(0)
    })

    it("từ chối khi chạy bản dev (không phải bản phát hành)", async () => {
      await ready()
      process.env.APP_BUILD_VERSION = "dev"
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "dev_build" })
    })

    it("từ chối khi đã có yêu cầu pending/running (trùng)", async () => {
      await ready()
      const first = await startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "busy" })
      await expect(startUpdate(admin2, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "busy" })
      expect(await rows()).toHaveLength(1)

      // still blocked once the updater has claimed it, however long it has been running
      await db.update(systemUpdateRequests).set({ status: "running", startedAt: new Date(Date.now() - 3 * 3_600_000), createdAt: new Date(Date.now() - 4 * 3_600_000) }).where(eq(systemUpdateRequests.id, first.id))
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toMatchObject({ code: "busy" })
    })

    it("hai quản trị viên bấm cùng lúc: đúng một yêu cầu được tạo (partial unique index)", async () => {
      await ready()
      const results = await Promise.allSettled([
        startUpdate(admin, { targetVersion: "1.3.0" }, okVerify),
        startUpdate(admin2, { targetVersion: "1.3.0" }, okVerify),
      ])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult
      expect(rejected.reason).toBeInstanceOf(UpdateServiceError)
      expect((rejected.reason as UpdateServiceError).code).toBe("busy")
      expect(await rows()).toHaveLength(1)
      // the loser leaves no activity log behind (it rolled back with the insert)
      const logs = await db.select().from(activityLogs).where(and(like(activityLogs.actorId, `${P}%`), eq(activityLogs.action, "system.update_requested")))
      expect(logs).toHaveLength(1)
    })

    it("mật khẩu sai: không tạo yêu cầu, ghi log thất bại (reauth) và ném ReauthError", async () => {
      await ready()
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, async () => "bad_password")).rejects.toMatchObject({ code: "reauth_failed" })
      await expect(startUpdate(admin, { targetVersion: "1.3.0" }, async () => "code_required")).rejects.toMatchObject({ code: "reauth_code_required" })
      expect(await rows()).toHaveLength(0)
      const failures = await db
        .select()
        .from(activityLogs)
        .where(and(eq(activityLogs.actorId, admin.id), eq(activityLogs.action, "system.update_requested"), eq(activityLogs.status, "failure")))
      expect(failures).toHaveLength(1)
      expect(failures[0]!.metadata).toMatchObject({ reauth: true, reason: "bad_password" })
    })

    it("yêu cầu pending bị bỏ quên quá 10 phút không chặn mãi: được đóng lại và nhận yêu cầu mới", async () => {
      await ready()
      await db.insert(systemUpdateRequests).values({
        fromVersion: "1.2.0",
        targetVersion: "1.3.0",
        status: "pending",
        requestedBy: admin.id,
        createdAt: new Date(Date.now() - 11 * 60_000),
      })
      const r = await startUpdate(admin2, { targetVersion: "1.3.0" }, okVerify)
      const all = await rows()
      expect(all).toHaveLength(2)
      expect(all.find((x) => x.id === r.id)?.status).toBe("pending")
      const stale = all.find((x) => x.id !== r.id)!
      expect(stale.status).toBe("failed")
      expect(stale.finishedAt).not.toBeNull()
      expect(stale.message).toBeTruthy()
    })
  })

  describe("startUpdate - thành công", () => {
    it("tạo dòng pending đúng hợp đồng + ghi system.update_requested cùng transaction", async () => {
      await ready()
      const verify = vi.fn(okVerify)
      const r = await startUpdate(admin, { targetVersion: "1.3.0" }, verify, { sessionId: `${P}_session` })
      expect(verify).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ fromVersion: "1.2.0", targetVersion: "1.3.0" })

      const [row] = await rows()
      expect(row).toMatchObject({
        id: r.id,
        fromVersion: "1.2.0",
        targetVersion: "1.3.0",
        status: "pending",
        step: null,
        message: null,
        log: null,
        requestedBy: admin.id,
        startedAt: null,
        finishedAt: null,
      })
      expect(row!.createdAt).toBeInstanceOf(Date)

      const logs = await logsOf("system.update_requested")
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({ actorEmail: admin.email, actorRole: "admin", status: "success", targetType: "system", targetId: r.id })
      expect(logs[0]!.metadata).toEqual({ from: "1.2.0", target: "1.3.0" })
    })

    it("nếu ghi nhật ký lỗi thì yêu cầu cũng bị huỷ (cùng transaction)", async () => {
      await ready()
      flags.failLog = true
      try {
        await expect(startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)).rejects.toThrow("log down")
      } finally {
        flags.failLog = false
      }
      expect(await rows()).toHaveLength(0)
    })

    it("sau khi yêu cầu cũ xong (succeeded/failed/rolled_back) có thể tạo yêu cầu mới", async () => {
      await ready()
      const a = await startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)
      await db.update(systemUpdateRequests).set({ status: "rolled_back", step: "rollback", finishedAt: new Date() }).where(eq(systemUpdateRequests.id, a.id))
      const b = await startUpdate(admin, { targetVersion: "1.3.0" }, okVerify)
      expect(b.id).not.toBe(a.id)
      expect(await rows()).toHaveLength(2)
    })
  })

  describe("ràng buộc bảng system_update_requests (migration 0002)", () => {
    const base = { fromVersion: "1.2.0", targetVersion: "1.3.0" }
    it("từ chối status / step ngoài danh sách và target_version sai hình dạng", async () => {
      await expect(db.insert(systemUpdateRequests).values({ ...base, status: "bogus" })).rejects.toThrow()
      await expect(db.insert(systemUpdateRequests).values({ ...base, status: "failed", step: "format-disk" })).rejects.toThrow()
      await expect(db.insert(systemUpdateRequests).values({ ...base, targetVersion: "latest", status: "failed" })).rejects.toThrow()
      // strict MAJOR.MINOR.PATCH: "." is not a wildcard, no leading zeros, no suffix (the value ends up in an image tag)
      for (const bad of ["1a2b3", "01.2.3", "1.02.3", "1.2", "1.2.3.4", "1.2.3-rc1", "1.2.3\n", " 1.2.3", "1.2.3; rm -rf /"])
        await expect(db.insert(systemUpdateRequests).values({ ...base, targetVersion: bad, status: "failed" }), bad).rejects.toThrow()
      await expect(db.insert(systemUpdateRequests).values({ ...base, targetVersion: "10.0.25", status: "failed" })).resolves.toBeDefined()
      await db.delete(systemUpdateRequests)
      expect(await rows()).toHaveLength(0)
    })

    it("chỉ một dòng pending/running tại một thời điểm, nhiều dòng đã kết thúc thì được", async () => {
      await db.insert(systemUpdateRequests).values([
        { ...base, status: "succeeded" },
        { ...base, status: "failed" },
        { ...base, status: "rolled_back" },
      ])
      await db.insert(systemUpdateRequests).values({ ...base, status: "pending" })
      await expect(db.insert(systemUpdateRequests).values({ ...base, status: "running" })).rejects.toThrow()
      await expect(db.insert(systemUpdateRequests).values({ ...base, status: "pending" })).rejects.toThrow()
      expect(await rows()).toHaveLength(4)
    })

    it("xoá người yêu cầu thì requested_by về null (không mất lịch sử)", async () => {
      const tmpUser = { id: `${P}_gone`, name: P, email: `${P}_gone@example.test`, emailVerified: true, role: "admin" as const }
      await db.insert(user).values(tmpUser)
      const [r] = await db.insert(systemUpdateRequests).values({ ...base, status: "succeeded", requestedBy: tmpUser.id }).returning()
      await db.delete(user).where(eq(user.id, tmpUser.id))
      const [after] = await db.select().from(systemUpdateRequests).where(eq(systemUpdateRequests.id, r!.id))
      expect(after!.requestedBy).toBeNull()
    })
  })

  describe("getUpdateStatus / getVersionBadge", () => {
    it("trạng thái trống: chưa có bản mới, updater offline", async () => {
      const s = await getUpdateStatus(admin, NOW)
      expect(s).toMatchObject({
        current: "1.2.0",
        currentIsRelease: true,
        latest: null,
        hasUpdate: false,
        checkError: null,
        active: null,
        history: [],
        blockReason: "no_update",
        updater: { online: false, lastSeenAt: null, version: null },
      })
    })

    it("tổng hợp bản mới + heartbeat + yêu cầu đang chạy + lịch sử mới nhất trước (tối đa 10)", async () => {
      await setLatest("1.3.0")
      await setHeartbeat(30, NOW)
      await setKey(UPDATE_CHECK_ERROR_KEY, { at: NOW.toISOString(), message: "GitHub tạm thời không phản hồi." })
      for (let i = 0; i < 11; i++) {
        await db.insert(systemUpdateRequests).values({
          fromVersion: "1.1.0",
          targetVersion: "1.2.0",
          status: "failed",
          requestedBy: admin.id,
          createdAt: new Date(NOW.getTime() - (20 - i) * 3_600_000),
          message: `lần ${i}`,
        })
      }
      await db.insert(systemUpdateRequests).values({
        fromVersion: "1.2.0",
        targetVersion: "1.3.0",
        status: "running",
        step: "migrate",
        message: "Đang cập nhật cơ sở dữ liệu",
        requestedBy: admin.id,
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      const s = await getUpdateStatus(admin, NOW)
      expect(s.latest?.version).toBe("1.3.0")
      expect(s.hasUpdate).toBe(true)
      expect(s.updater).toMatchObject({ online: true, version: "1.2.0" })
      expect(s.checkError?.message).toContain("GitHub")
      expect(s.history).toHaveLength(10)
      expect(s.history[0]).toMatchObject({ status: "running", step: "migrate", requestedBy: admin.email, targetVersion: "1.3.0" })
      expect(s.active?.id).toBe(s.history[0]!.id)
      expect(s.blockReason).toBe("busy")
      // never leaks the technical log
      expect(JSON.stringify(s)).not.toContain('"log"')
    })

    it("heartbeat đúng ranh giới 90 giây", async () => {
      await setLatest("1.3.0")
      await setHeartbeat(89, NOW)
      expect((await getUpdateStatus(admin, NOW)).updater.online).toBe(true)
      await setHeartbeat(91, NOW)
      const s = await getUpdateStatus(admin, NOW)
      expect(s.updater.online).toBe(false)
      expect(s.blockReason).toBe("updater_offline")
    })

    it("giá trị nội bộ hỏng bị bỏ qua thay vì làm trang lỗi", async () => {
      await setKey(UPDATE_LATEST_KEY, { version: 5 })
      await setKey(UPDATER_HEARTBEAT_KEY, "rác")
      await setKey(UPDATE_CHECK_ERROR_KEY, [])
      const s = await getUpdateStatus(admin, NOW)
      expect(s.latest).toBeNull()
      expect(s.updater.online).toBe(false)
      expect(s.checkError).toBeNull()
    })

    it("bản chạy là dev: không có bản mới để cập nhật", async () => {
      process.env.APP_BUILD_VERSION = "dev"
      await ready()
      const s = await getUpdateStatus(admin)
      expect(s).toMatchObject({ current: "dev", currentIsRelease: false, hasUpdate: false, blockReason: "dev_build" })
    })

    it("getVersionBadge: nhân viên chỉ thấy số phiên bản, admin thấy bản mới khi có", async () => {
      await setLatest("1.3.0")
      expect(await getVersionBadge("staff")).toEqual({ current: "1.2.0", latestVersion: null, latestKnown: null })
      expect(await getVersionBadge("admin")).toEqual({ current: "1.2.0", latestVersion: "1.3.0", latestKnown: "1.3.0" })
      await setLatest("1.2.0")
      expect(await getVersionBadge("admin")).toEqual({ current: "1.2.0", latestVersion: null, latestKnown: "1.2.0" })
      await setLatest("1.1.0")
      expect(await getVersionBadge("admin")).toEqual({ current: "1.2.0", latestVersion: null, latestKnown: "1.1.0" })
    })

    it("getVersionBadge không bao giờ ném lỗi và không gọi GitHub", async () => {
      const f = vi.fn()
      vi.stubGlobal("fetch", f)
      await db.delete(appSettings).where(eq(appSettings.key, UPDATE_LATEST_KEY))
      expect(await getVersionBadge("admin")).toEqual({ current: getAppVersion(), latestVersion: null, latestKnown: null })
      expect(f).not.toHaveBeenCalled()
    })
  })

  describe("khoá cài đặt nội bộ không lọt vào form Cài đặt", () => {
    it("getAllSettings chỉ trả 7 khoá của form dù app_settings có update_latest / heartbeat", async () => {
      await ready()
      await setKey(UPDATE_CHECK_ERROR_KEY, { at: NOW.toISOString(), message: "x" })
      const all = await getAllSettings()
      expect(Object.keys(all).sort()).toEqual([
        "legal_contact_email",
        "legal_org_name",
        "log_retention_months_mcp",
        "log_retention_months_staff",
        "require_2fa_admin",
        "require_2fa_all",
        "session_max_hours",
      ])
    })
  })

  describe("checkForUpdatesNow (Kiểm tra ngay)", () => {
    const githubOk = () =>
      vi.fn(async () =>
        Response.json({
          tag_name: "v1.3.0",
          body: "Ghi chú",
          html_url: "https://github.com/schhung1822/nextgency-mcp-ads/releases/tag/v1.3.0",
          published_at: "2026-10-01T00:00:00Z",
        })
      )

    it("nhân viên bị chặn, không gọi GitHub", async () => {
      const f = githubOk()
      vi.stubGlobal("fetch", f)
      await expect(checkForUpdatesNow(staff)).rejects.toMatchObject({ code: "forbidden" })
      await expect(getUpdateStatus(staff)).rejects.toMatchObject({ code: "forbidden" })
      expect(f).not.toHaveBeenCalled()
    })

    it("admin: lưu update_latest, xoá lỗi cũ, ghi đúng 1 nhật ký system.update_check", async () => {
      await setKey(UPDATE_CHECK_ERROR_KEY, { at: NOW.toISOString(), message: "lỗi cũ" })
      vi.stubGlobal("fetch", githubOk())
      const r = await checkForUpdatesNow(admin)
      expect(r.error).toBeNull()
      expect(r.status).toMatchObject({ hasUpdate: true, checkError: null })
      expect(r.status.latest).toMatchObject({ version: "1.3.0", tag: "v1.3.0", notes: "Ghi chú" })
      const logs = await logsOf("system.update_check")
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({ status: "success", targetType: "system", targetLabel: "v1.3.0" })
      expect(logs[0]!.metadata).toEqual({ version: "1.3.0", current: "1.2.0", trigger: "manual" })
    })

    it("GitHub lỗi: trả thông báo thân thiện, lưu update_check_error, giữ update_latest cũ, log status failure", async () => {
      await setLatest("1.3.0")
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })))
      const r = await checkForUpdatesNow(admin2)
      expect(r.error).toContain("giới hạn")
      expect(r.status.checkError?.message).toBe(r.error)
      expect(r.status.latest?.version).toBe("1.3.0")
      const logs = await logsOf("system.update_check", admin2.id)
      expect(logs).toHaveLength(1)
      expect(logs[0]!.status).toBe("failure")
      expect(logs[0]!.metadata).toMatchObject({ code: "rate_limited" })
    })

    it("trang Cập nhật tự kiểm tra khi mở: nhật ký ghi trigger auto", async () => {
      vi.stubGlobal("fetch", githubOk())
      await checkForUpdatesNow(admin2, new Date(), "auto")
      const logs = await logsOf("system.update_check", admin2.id)
      expect(logs.at(-1)!.metadata).toMatchObject({ trigger: "auto" })
    })

    it("giới hạn tần suất theo người dùng (6 lần / phút)", async () => {
      vi.stubGlobal("fetch", githubOk())
      const gen = { id: `${P}_burst`, email: `${P}_burst@example.test`, role: "admin" }
      for (let i = 0; i < 6; i++) await checkForUpdatesNow(gen, new Date())
      await expect(checkForUpdatesNow(gen, new Date())).rejects.toMatchObject({ code: "throttled" })
    })
  })

  describe("job update.check", () => {
    const ctx = { jobId: "j1", signal: new AbortController().signal, log: vi.fn() }

    it("là job 6 giờ/lần, đã đăng ký", async () => {
      const { JOBS } = await import("@/server/jobs")
      expect(JOBS).toContain(updateCheckJob)
      expect(updateCheckJob.name).toBe("update.check")
      expect(updateCheckJob.cron).toBe("20 */6 * * *")
    })

    it("lưu bản mới nhất vào app_settings và KHÔNG ghi activity_logs", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tag_name: "v1.5.0", body: "n", html_url: "https://github.com/schhung1822/nextgency-mcp-ads/releases/tag/v1.5.0" })))
      const before = await db.select().from(activityLogs)
      const r = (await updateCheckJob.handler({}, ctx)) as { ok: boolean; version?: string }
      expect(r).toEqual({ ok: true, version: "1.5.0" })
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, UPDATE_LATEST_KEY))
      expect(row!.value).toMatchObject({ version: "1.5.0", tag: "v1.5.0" })
      expect(await db.select().from(activityLogs)).toHaveLength(before.length)
    })

    it("GitHub lỗi: không ném (tránh retry dồn dập), lưu update_check_error và giữ bản đã biết", async () => {
      await setLatest("1.4.0")
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })))
      const r = (await updateCheckJob.handler({}, ctx)) as { ok: boolean; code?: string }
      expect(r).toEqual({ ok: false, code: "unauthorized" })
      const [err] = await db.select().from(appSettings).where(eq(appSettings.key, UPDATE_CHECK_ERROR_KEY))
      expect(err!.value).toMatchObject({ message: expect.stringContaining("token") })
      const [latest] = await db.select().from(appSettings).where(eq(appSettings.key, UPDATE_LATEST_KEY))
      expect(latest!.value).toMatchObject({ version: "1.4.0" })
    })

    it("lần kiểm tra thành công sau đó xoá lỗi cũ", async () => {
      await setKey(UPDATE_CHECK_ERROR_KEY, { at: NOW.toISOString(), message: "lỗi cũ" })
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tag_name: "v1.5.0" })))
      await updateCheckJob.handler({}, ctx)
      expect(await db.select().from(appSettings).where(eq(appSettings.key, UPDATE_CHECK_ERROR_KEY))).toHaveLength(0)
    })
  })
})
