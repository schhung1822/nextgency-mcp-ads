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
// password check of the re-auth gate: "Correct-Pass-1" is right, anything else wrong (no Better Auth session here)
const verifierCalls = vi.fn()
vi.mock("@/server/auth/reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/reauth")>()),
  requestReauthVerifier: async (_user: unknown, fields: { password: string }) => {
    verifierCalls(fields)
    return async () => (fields.password === "Correct-Pass-1" ? "ok" : "bad_password")
  },
}))

const hasDb = !!process.env.DATABASE_URL

describe("settingsFormSchema", async () => {
  const { settingsFormSchema, isRelaxingSettingsChange } = await import("@/lib/schemas/settings")
  const base = {
    log_retention_months_mcp: 3,
    log_retention_months_staff: 3,
    require_2fa_admin: false,
    require_2fa_all: false,
    session_max_hours: 12,
    legal_org_name: "",
    legal_contact_email: "",
  }

  it("nhận biết thay đổi nới lỏng bảo mật / rút ngắn lưu nhật ký", () => {
    const strict = { ...base, require_2fa_admin: true, require_2fa_all: true }
    expect(isRelaxingSettingsChange(strict, { ...strict, require_2fa_admin: false })).toBe(true)
    expect(isRelaxingSettingsChange(strict, { ...strict, require_2fa_all: false })).toBe(true)
    expect(isRelaxingSettingsChange(base, { ...base, session_max_hours: 13 })).toBe(true)
    expect(isRelaxingSettingsChange(base, { ...base, log_retention_months_mcp: 2 })).toBe(true)
    expect(isRelaxingSettingsChange(base, { ...base, log_retention_months_staff: 1 })).toBe(true)
    // tightening / neutral
    expect(isRelaxingSettingsChange(base, { ...base, require_2fa_admin: true, require_2fa_all: true })).toBe(false)
    expect(isRelaxingSettingsChange(base, { ...base, session_max_hours: 8, log_retention_months_mcp: 6 })).toBe(false)
    expect(isRelaxingSettingsChange(base, base)).toBe(false)
    // operator info for the public legal pages is never a security change (no re-auth)
    expect(isRelaxingSettingsChange(base, { ...base, legal_org_name: "Công ty ABC", legal_contact_email: "a@b.vn" })).toBe(false)
    const filled = { ...base, legal_org_name: "Công ty ABC", legal_contact_email: "a@b.vn" }
    expect(isRelaxingSettingsChange(filled, base)).toBe(false)
  })

  it("thông tin pháp lý: tuỳ chọn, trim, email hợp lệ hoặc rỗng, tên ≤ 120 ký tự", () => {
    const ok = settingsFormSchema.safeParse({ ...base, legal_org_name: "  Công ty ABC ", legal_contact_email: " privacy@abc.vn " })
    expect(ok.success && ok.data.legal_org_name).toBe("Công ty ABC")
    expect(ok.success && ok.data.legal_contact_email).toBe("privacy@abc.vn")
    expect(settingsFormSchema.safeParse({ ...base, legal_contact_email: "khong-phai-email" }).success).toBe(false)
    expect(settingsFormSchema.safeParse({ ...base, legal_org_name: "x".repeat(121) }).success).toBe(false)
    expect(settingsFormSchema.safeParse({ ...base, legal_org_name: "a\nb" }).success).toBe(false)
  })

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
  const KEYS = [
    "log_retention_months_mcp",
    "log_retention_months_staff",
    "require_2fa_admin",
    "require_2fa_all",
    "session_max_hours",
    "legal_org_name",
    "legal_contact_email",
  ]
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

  /** known starting values (3 months / 12 hours / 2FA optional), written directly */
  const setBaseline = async () => {
    const { setSetting } = await import("@/server/services/settings")
    await setSetting("log_retention_months_mcp", 3, adminId)
    await setSetting("log_retention_months_staff", 3, adminId)
    await setSetting("require_2fa_admin", false, adminId)
    await setSetting("require_2fa_all", false, adminId)
    await setSetting("session_max_hours", 12, adminId)
    await setSetting("legal_org_name", "", adminId)
    await setSetting("legal_contact_email", "", adminId)
  }

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
      legal_org_name: "",
      legal_contact_email: "",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fieldErrors?.log_retention_months_mcp).toBeTruthy()
      expect(r.fieldErrors?.log_retention_months_staff).toBeTruthy()
    }
    const logs = await db.select().from(activityLogs).where(eq(activityLogs.actorId, adminId))
    expect(logs).toHaveLength(0)
  })

  it("lưu thay đổi THẮT CHẶT (không cần mật khẩu) + ghi nhật ký settings.update cùng transaction", async () => {
    asAdmin()
    verifierCalls.mockClear()
    await setBaseline()
    const before = await getAllSettings()
    const next = {
      log_retention_months_mcp: before.log_retention_months_mcp + 1, // keep logs longer
      log_retention_months_staff: before.log_retention_months_staff,
      require_2fa_admin: before.require_2fa_admin,
      require_2fa_all: before.require_2fa_all,
      session_max_hours: before.session_max_hours - 1, // shorter sessions
      legal_org_name: before.legal_org_name,
      legal_contact_email: before.legal_contact_email,
    }
    const r = await updateSettingsAction(next)
    expect(verifierCalls).not.toHaveBeenCalled()
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

  it("lưu thông tin pháp lý KHÔNG cần mật khẩu + ghi nhật ký settings.update; email sai → lỗi theo trường", async () => {
    asAdmin()
    verifierCalls.mockClear()
    await db.delete(activityLogs).where(eq(activityLogs.actorId, adminId))
    await setBaseline()
    const before = await getAllSettings()
    expect(before.legal_org_name).toBe("")
    expect(before.legal_contact_email).toBe("")

    const bad = await updateSettingsAction({ ...before, legal_contact_email: "khong-phai-email" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.fieldErrors?.legal_contact_email).toBeTruthy()

    const r = await updateSettingsAction({ ...before, legal_org_name: " Công ty ABC ", legal_contact_email: "privacy@abc.vn" })
    expect(verifierCalls).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.changed.sort()).toEqual(["legal_contact_email", "legal_org_name"])
    const after = await getAllSettings()
    expect(after.legal_org_name).toBe("Công ty ABC")
    expect(after.legal_contact_email).toBe("privacy@abc.vn")

    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.actorId, adminId), eq(activityLogs.action, "settings.update")))
    expect(logs).toHaveLength(1)
    expect(logs[0]!.metadata).toEqual({
      before: { legal_org_name: "", legal_contact_email: "" },
      after: { legal_org_name: "Công ty ABC", legal_contact_email: "privacy@abc.vn" },
    })

    // the public pages read the saved values (no session)
    const { getPublicLegalInfo } = await import("@/server/services/legal")
    expect(await getPublicLegalInfo()).toMatchObject({ orgName: "Công ty ABC", contactEmail: "privacy@abc.vn" })
    await db.delete(activityLogs).where(eq(activityLogs.actorId, adminId))
  })

  it("thay đổi NỚI LỎNG cần xác thực lại: thiếu → _reauth, sai → nhật ký reauth, đúng → lưu + một nhật ký", async () => {
    asAdmin()
    await db.delete(activityLogs).where(eq(activityLogs.actorId, adminId))
    await setBaseline()
    const before = await getAllSettings()
    const relaxed = { ...before, session_max_hours: before.session_max_hours + 12, log_retention_months_staff: 1 }

    const missing = await updateSettingsAction(relaxed)
    expect(missing).toMatchObject({ ok: false, fieldErrors: { _reauth: "required" } })
    expect((await getAllSettings()).session_max_hours).toBe(before.session_max_hours)
    expect(await db.select().from(activityLogs).where(eq(activityLogs.actorId, adminId))).toHaveLength(0)

    const wrong = await updateSettingsAction({ ...relaxed, reauth: { password: "sai-mat-khau" } })
    expect(wrong.ok).toBe(false)
    expect((await getAllSettings()).session_max_hours).toBe(before.session_max_hours)
    const failures = await db.select().from(activityLogs).where(eq(activityLogs.actorId, adminId))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ action: "settings.update", status: "failure" })
    expect(failures[0]!.metadata).toMatchObject({ reauth: true })

    const r = await updateSettingsAction({ ...relaxed, reauth: { password: "Correct-Pass-1" } })
    expect(r.ok).toBe(true)
    const after = await getAllSettings()
    expect(after.session_max_hours).toBe(relaxed.session_max_hours)
    expect(after.log_retention_months_staff).toBe(relaxed.log_retention_months_staff)
    const success = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.actorId, adminId), eq(activityLogs.action, "settings.update"), eq(activityLogs.status, "success")))
    expect(success).toHaveLength(1)
    expect(JSON.stringify(success[0]!.metadata)).not.toContain("Correct-Pass-1")
    await db.delete(activityLogs).where(eq(activityLogs.actorId, adminId))
  })
})
