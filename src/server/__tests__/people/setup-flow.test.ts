// First-run /setup (empty private database): SETUP_TOKEN handling, single use under concurrency (advisory lock),
// closing after the first user, per-IP attempt limit, policy-aware redirect target, flags of the first admin.
import { afterAll, describe, expect, it, vi } from "vitest"

const TOKEN = "setup-token-0123456789-abcdefXYZ"
const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  process.env.SETUP_TOKEN = "setup-token-0123456789-abcdefXYZ"
  const { createTempDb } = await import("./temp-db")
  const t = await createTempDb("setup")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())

import { count, eq } from "drizzle-orm"

import { db } from "@/server/db/client"
import { activityLogs, session as sessionTable, user } from "@/server/db/schema"

import { actAs, closeDb, PASSWORD, randomIp, setSettingRaw, uid } from "./harness"

const hasDb = !!tmp
const P = `tsetup_${uid()}`
const input = (n: string, token = TOKEN) => ({
  name: `Admin ${n}`,
  email: `${P}_${n}@example.test`,
  password: PASSWORD,
  confirmPassword: PASSWORD,
  setupToken: token,
})
const userCount = async () => Number((await db.select({ n: count() }).from(user))[0]!.n)

describe.skipIf(!hasDb)("/setup lần đầu (DB trống)", () => {
  afterAll(async () => {
    await closeDb()
    await tmp?.drop()
  })

  it("sai SETUP_TOKEN: từ chối, không tạo người dùng; thiếu hoặc quá ngắn: luôn đóng", async () => {
    const { createFirstAdmin } = await import("@/server/services/users")
    await expect(createFirstAdmin({ ...input("bad"), setupToken: "sai-ma-thiet-lap" })).rejects.toThrow("Mã thiết lập không đúng.")
    await expect(createFirstAdmin({ ...input("bad"), setupToken: "" })).rejects.toThrow("Mã thiết lập không đúng.")
    const saved = process.env.SETUP_TOKEN
    try {
      process.env.SETUP_TOKEN = "short-but-matching"
      await expect(createFirstAdmin({ ...input("bad"), setupToken: "short-but-matching" })).rejects.toThrow("Mã thiết lập không đúng.")
      delete process.env.SETUP_TOKEN
      await expect(createFirstAdmin({ ...input("bad"), setupToken: "anything" })).rejects.toThrow("Mã thiết lập không đúng.")
    } finally {
      process.env.SETUP_TOKEN = saved
    }
    expect(await userCount()).toBe(0)
  })

  it("giới hạn 10 lần thử / 15 phút / IP: lần 11 bị chặn kể cả khi đúng token; IP khác không bị ảnh hưởng", async () => {
    const { setupFirstAdminAction } = await import("@/server/actions/setup")
    const ip = randomIp()
    actAs(null, ip)
    for (let i = 0; i < 10; i++) {
      const r = await setupFirstAdminAction(input("rl", "sai-ma-thiet-lap"))
      expect(r).toMatchObject({ ok: false, error: "Mã thiết lập không đúng." })
    }
    const blocked = await setupFirstAdminAction(input("rl"))
    expect(blocked).toMatchObject({ ok: false, error: "Thử mã thiết lập quá nhiều lần. Vui lòng thử lại sau 15 phút." })
    expect(await userCount()).toBe(0)
  })

  it("dùng một lần: nhiều yêu cầu đồng thời với token đúng chỉ tạo đúng 1 admin; sau đó /setup đóng", async () => {
    const { createFirstAdmin } = await import("@/server/services/users")
    const results = await Promise.allSettled(["a", "b", "c", "d", "e", "f"].map((n) => createFirstAdmin(input(n))))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(failures).toHaveLength(5)
    for (const f of failures) expect(String(f.reason?.message)).toBe("Hệ thống đã có người dùng. Hãy đăng nhập.")
    expect(await userCount()).toBe(1)

    const [first] = await db.select().from(user)
    expect(first).toMatchObject({ role: "admin", mustChangePassword: false, createdById: null, banned: false, emailVerified: true })
    expect(first!.twoFactorEnabled).toBeFalsy() // 2FA is optional by default, admins included
    const logs = await db.select().from(activityLogs).where(eq(activityLogs.action, "setup.first_admin"))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ actorId: first!.id, actorRole: "admin", status: "success" })
    expect(JSON.stringify(logs[0]!.metadata)).not.toContain(PASSWORD)

    // closed for good - even with the right token
    const { setupFirstAdminAction } = await import("@/server/actions/setup")
    actAs(null, randomIp())
    expect(await setupFirstAdminAction(input("late"))).toMatchObject({ ok: false, error: "Hệ thống đã có người dùng. Hãy đăng nhập." })
    expect(await userCount()).toBe(1)
  })

  it("hành động /setup đăng nhập luôn người vừa tạo và chuyển tới / (2FA tuỳ chọn) hoặc /security/enable-2fa (khi chính sách bắt buộc)", async () => {
    // reset to an empty database state for this scenario
    await db.delete(sessionTable)
    await db.delete(user)
    const { setupFirstAdminAction } = await import("@/server/actions/setup")
    actAs(null, randomIp())
    const off = await setupFirstAdminAction(input("next1"))
    expect(off).toMatchObject({ ok: true, data: { next: "/" } })
    expect(await db.select().from(sessionTable)).toHaveLength(1) // signed in

    await db.delete(sessionTable)
    await db.delete(user)
    await setSettingRaw("require_2fa_admin", true)
    actAs(null, randomIp())
    const on = await setupFirstAdminAction(input("next2"))
    expect(on).toMatchObject({ ok: true, data: { next: "/security/enable-2fa" } })
    await setSettingRaw("require_2fa_admin", false)
  })

  it("mật khẩu thiết lập tối thiểu 8 ký tự", async () => {
    await db.delete(sessionTable)
    await db.delete(user)
    const { setupFirstAdminAction } = await import("@/server/actions/setup")
    actAs(null, randomIp())
    const short = await setupFirstAdminAction({ ...input("short"), password: "Abcde12", confirmPassword: "Abcde12" })
    expect(short).toMatchObject({ ok: false, fieldErrors: { password: "Mật khẩu cần ít nhất 8 ký tự." } })
    expect(await userCount()).toBe(0)
    const eight = await setupFirstAdminAction({ ...input("eight"), password: "Abcdef78", confirmPassword: "Abcdef78" })
    expect(eight.ok).toBe(true)
  })
})
