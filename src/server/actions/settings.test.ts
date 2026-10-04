// updateSettingsAction against the dev/test Postgres. Original app_settings rows are restored afterwards.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
const requireUserForAction = vi.fn()
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserForAction: (...a: unknown[]) => requireUserForAction(...a),
}))

const hasDb = !!process.env.DATABASE_URL

describe("settingsFormSchema", async () => {
  const { settingsFormSchema } = await import("@/lib/schemas/settings")
  const base = { log_retention_months_mcp: 3, log_retention_months_staff: 3, require_2fa_admin: false, require_2fa_all: false, session_max_hours: 12 }

  it("chấp nhận giá trị biên 1–24 tháng, 1–168 giờ", () => {
    expect(settingsFormSchema.safeParse({ ...base, log_retention_months_mcp: 1, log_retention_months_staff: 24 }).success).toBe(true)
    expect(settingsFormSchema.safeParse({ ...base, session_max_hours: 168 }).success).toBe(true)
    expect(settingsFormSchema.safeParse({ ...base, session_max_hours: "8" }).data?.session_max_hours).toBe(8)
  })

  it("từ chối ngoài khoảng, số lẻ, rỗng", () => {
    expect(settingsFormSchema.safeParse({ ...base, log_retention_months_mcp: 0 }).success).toBe(false)
    expect(settingsFormSchema.safeParse({ ...base, log_retention_months_staff: 25 }).success).toBe(false)
    expect(settingsFormSchema.safeParse({ ...base, log_retention_months_mcp: 2.5 }).success).toBe(false)
    expect(settingsFormSchema.safeParse({ ...base, session_max_hours: 169 }).success).toBe(false)
    expect(settingsFormSchema.safeParse({ ...base, require_2fa_all: "yes" }).success).toBe(false)
  })
})

describe.skipIf(!hasDb)("updateSettingsAction (DB)", async () => {
  const { and, eq, inArray, like } = await import("drizzle-orm")
  const { db, pool } = await import("@/server/db/client")
  const { activityLogs, appSettings, user } = await import("@/server/db/schema")
  const { AuthorizationError } = await import("@/server/auth/session")
  const { updateSettingsAction } = await import("./settings")
  const { getAllSettings } = await import("@/server/services/settings")

  const P = `tls${randomUUID().slice(0, 8)}`
  const adminId = `${P}_admin`
  const KEYS = ["log_retention_months_mcp", "log_retention_months_staff", "require_2fa_admin", "require_2fa_all", "session_max_hours"]
  let original: (typeof appSettings.$inferSelect)[] = []

  beforeAll(async () => {
    original = await db.select().from(appSettings).where(inArray(appSettings.key, KEYS))
    await db.insert(user).values({ id: adminId, name: "Admin", email: `${adminId}@example.test`, role: "admin", twoFactorEnabled: true })
  })

  afterAll(async () => {
    await db.delete(appSettings).where(inArray(appSettings.key, KEYS))
    if (original.length) await db.insert(appSettings).values(original)
    await db.delete(activityLogs).where(like(activityLogs.actorId, `${P}%`))
    await db.delete(user).where(eq(user.id, adminId))
    await pool().end()
    ;(globalThis as Record<string, unknown>).__adsMcpPool = undefined
    ;(globalThis as Record<string, unknown>).__adsMcpDb = undefined
  })

  const asAdmin = () =>
    requireUserForAction.mockResolvedValue({
      sessionId: "s",
      user: { id: adminId, email: `${adminId}@example.test`, name: "Admin", role: "admin", twoFactorEnabled: true, mustChangePassword: false, banned: false },
    })

  it("nhân viên không được lưu cài đặt", async () => {
    requireUserForAction.mockRejectedValue(new AuthorizationError())
    const r = await updateSettingsAction({ log_retention_months_mcp: 5 })
    expect(r.ok).toBe(false)
  })

  it("trả lỗi theo trường khi vượt giới hạn và không ghi gì", async () => {
    asAdmin()
    const r = await updateSettingsAction({
      log_retention_months_mcp: 30,
      log_retention_months_staff: 0,
      require_2fa_admin: false,
      require_2fa_all: false,
      session_max_hours: 12,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fieldErrors?.log_retention_months_mcp).toBeTruthy()
      expect(r.fieldErrors?.log_retention_months_staff).toBeTruthy()
    }
    const logs = await db.select().from(activityLogs).where(eq(activityLogs.actorId, adminId))
    expect(logs).toHaveLength(0)
  })

  it("lưu giá trị đổi + ghi nhật ký settings.update cùng transaction", async () => {
    asAdmin()
    const before = await getAllSettings()
    const next = {
      log_retention_months_mcp: before.log_retention_months_mcp === 7 ? 8 : 7,
      log_retention_months_staff: before.log_retention_months_staff,
      require_2fa_admin: before.require_2fa_admin,
      require_2fa_all: before.require_2fa_all,
      session_max_hours: before.session_max_hours === 24 ? 25 : 24,
    }
    const r = await updateSettingsAction(next)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.changed.sort()).toEqual(["log_retention_months_mcp", "session_max_hours"])

    const after = await getAllSettings()
    expect(after.log_retention_months_mcp).toBe(next.log_retention_months_mcp)
    expect(after.session_max_hours).toBe(next.session_max_hours)

    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.actorId, adminId), eq(activityLogs.action, "settings.update")))
    expect(logs).toHaveLength(1)
    expect(logs[0].metadata).toEqual({
      before: { log_retention_months_mcp: before.log_retention_months_mcp, session_max_hours: before.session_max_hours },
      after: { log_retention_months_mcp: next.log_retention_months_mcp, session_max_hours: next.session_max_hours },
    })

    // saving the same values again is a no-op (no extra log row)
    const again = await updateSettingsAction(next)
    expect(again.ok && again.data.changed).toEqual([])
    const logs2 = await db.select().from(activityLogs).where(eq(activityLogs.actorId, adminId))
    expect(logs2).toHaveLength(1)
  })
})
