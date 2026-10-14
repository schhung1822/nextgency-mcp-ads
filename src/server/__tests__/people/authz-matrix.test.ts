// Authorization matrix: EVERY exported server action and the page guards (requireUser / requireAdmin) against
// every kind of caller - anonymous, staff, admin, forced-password-change, 2FA required by policy, banned,
// expired session, session older than `session_max_hours`. Real Better Auth sessions + real DB (private database).
//
// Server actions must be gated BEFORE they parse input or touch a service, so each action is invoked with an
// empty `{}` input and the outcome is read from the error message:
//   gate said no  → one of the four AuthorizationError sentences below
//   gate said yes → anything else (zod validation error, "ok"…)
// A new exported action that is not classified in ACTIONS fails the "every action is classified" test.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("./temp-db")
  const t = await createTempDb("authz")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())

import { eq } from "drizzle-orm"

import { db } from "@/server/db/client"
import { session as sessionTable, user } from "@/server/db/schema"

import { actAs, closeDb, createTestUser, setSettingRaw, signIn, uid, type Signed } from "./harness"

const hasDb = !!tmp
const P = `tmx_${uid()}`

const MSG = {
  login: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  changePassword: "Bạn cần đổi mật khẩu trước khi tiếp tục.",
  needs2fa: "Hệ thống yêu cầu bật xác thực 2 bước trước khi tiếp tục.",
  forbidden: "Bạn không có quyền thực hiện thao tác này.",
} as const
type Gate = "pass" | keyof typeof MSG

/** public: no gate · any: signed-in · admin: admins only · pending: callable during a forced step. */
type Access = "public" | "any" | "admin" | "pending"

const ACTIONS: Record<string, Record<string, Access>> = {
  "@/server/actions/account": {
    updateProfileAction: "any",
    changePasswordAction: "pending",
    beginTwoFactorSetupAction: "pending",
    regenerateBackupCodesAction: "any",
    disableTwoFactorAction: "any",
    revokeMySessionAction: "any",
    revokeOtherSessionsAction: "any",
  },
  "@/server/actions/auth": { signOutAction: "public" },
  "@/server/actions/legal": { acceptDisclaimerAction: "any" },
  "@/server/actions/setup": { setupFirstAdminAction: "public" },
  "@/server/actions/users": {
    createUserAction: "admin",
    changeUserRoleAction: "admin",
    resetUserPasswordAction: "admin",
    resetUserTwoFactorAction: "admin",
    setUserBannedAction: "admin",
    listUserSessionsAction: "admin",
    revokeUserSessionsAction: "admin",
    deleteUserAction: "admin",
  },
  "@/server/actions/settings": { updateSettingsAction: "admin" },
  "@/server/actions/updates": { checkUpdatesAction: "admin", startUpdateAction: "admin" },
  "@/server/actions/logs": {
    loadMoreMcpLogsAction: "any",
    loadMoreActivityLogsAction: "admin",
    getMcpLogDetailAction: "any",
    getActivityLogDetailAction: "any",
  },
  "@/server/actions/connections": {
    previewConnectionAction: "any",
    createConnectionAction: "any",
    renameConnectionAction: "any",
    replaceCredentialsAction: "any",
    createTikTokFromAuthCodeAction: "any",
    replaceTikTokFromAuthCodeAction: "any",
    testConnectionAction: "any",
    syncConnectionAccountsAction: "any",
    toggleAdAccountsAction: "any",
    toggleMetaPagesAction: "any",
    connectionUsageAction: "any",
    deleteConnectionAction: "any",
  },
  "@/server/actions/mcp-servers": {
    createMcpAction: "any",
    updateMcpAction: "any",
    setMcpEnabledAction: "any",
    rotateMcpKeyAction: "any",
    revealMcpUrlAction: "any",
    deleteMcpAction: "any",
  },
  "@/server/actions/notification-channels": {
    previewTelegramChannelAction: "any",
    createTelegramChannelAction: "any",
    updateTelegramChannelAction: "any",
    replaceTelegramTokenAction: "any",
    recheckTelegramChannelAction: "any",
    sendTelegramTestAction: "any",
    setTelegramChannelEnabledAction: "any",
    telegramChannelUsageAction: "any",
    deleteTelegramChannelAction: "any",
    listTelegramDeliveriesAction: "any",
    listMcpChannelOptionsAction: "any",
  },
  "@/server/actions/drive": {
    saveSystemDriveCredentialAction: "admin",
    testSystemDriveCredentialAction: "admin",
    deleteSystemDriveCredentialAction: "admin",
    createPersonalDriveCredentialAction: "any",
    testPersonalDriveCredentialAction: "any",
    deletePersonalDriveCredentialAction: "any",
    previewDriveSourceAction: "any",
    createDriveSourceAction: "any",
    updateDriveSourceAction: "any",
    recheckDriveSourceAction: "any",
    driveSourceUsageAction: "any",
    deleteDriveSourceAction: "any",
    listDriveSourceFilesAction: "any",
    previewDriveSheetRowsAction: "any",
    listMcpDriveSourceOptionsAction: "any",
  },
  // company tokens are admin-only inside the service (staff may still manage their personal tokens)
  "@/server/actions/apify": {
    previewApifyTokenAction: "any",
    createApifyTokenAction: "any",
    renameApifyTokenAction: "any",
    setApifyTokenEnabledAction: "any",
    recheckApifyTokenAction: "any",
    replaceApifyTokenAction: "any",
    deleteApifyTokenAction: "any",
  },
}

// Pure expectation model (the documented rules of requireUserForAction):
//   no session → login · mustChangePassword → changePassword (unless pending-ok) ·
//   2FA required by policy and not enrolled → needs2fa (unless pending-ok) · admin-only and not admin → forbidden
interface Scenario {
  name: string
  who: "anonymous" | "staff" | "admin"
  mustChange?: boolean
  twoFactor?: boolean
  /** session state */
  session?: "ok" | "banned" | "expired"
  policy?: { admin: boolean; all: boolean }
}

function expectedGate(s: Scenario, access: Access, name: string): Gate {
  if (access === "public") return "pass"
  if (s.who === "anonymous" || s.session === "banned" || s.session === "expired") return "login"
  // Own refusal (same sentence as the "forbidden" gate): enrolling 2FA while the temp password is still active.
  if (name === "beginTwoFactorSetupAction" && s.mustChange) return "forbidden"
  const policy = s.policy ?? { admin: false, all: false }
  const required = s.who === "admin" ? policy.admin || policy.all : policy.all
  if (access !== "pending") {
    if (s.mustChange) return "changePassword"
    if (!s.twoFactor && required) return "needs2fa"
  }
  if (access === "admin" && s.who !== "admin") return "forbidden"
  return "pass"
}

const SCENARIOS: Scenario[] = [
  { name: "ẩn danh", who: "anonymous" },
  { name: "nhân viên", who: "staff" },
  { name: "admin (không 2FA, chính sách tắt)", who: "admin" },
  { name: "admin có 2FA", who: "admin", twoFactor: true },
  { name: "nhân viên phải đổi mật khẩu", who: "staff", mustChange: true },
  { name: "admin phải đổi mật khẩu", who: "admin", mustChange: true },
  { name: "nhân viên bị khoá", who: "staff", session: "banned" },
  { name: "admin bị khoá", who: "admin", session: "banned" },
  { name: "phiên hết hạn (nhân viên)", who: "staff", session: "expired" },
  { name: "phiên hết hạn (admin)", who: "admin", session: "expired" },
  { name: "admin không 2FA, bắt buộc 2FA cho admin", who: "admin", policy: { admin: true, all: false } },
  { name: "admin có 2FA, bắt buộc 2FA cho admin", who: "admin", twoFactor: true, policy: { admin: true, all: false } },
  { name: "nhân viên không 2FA, chỉ bắt buộc admin", who: "staff", policy: { admin: true, all: false } },
  { name: "nhân viên không 2FA, bắt buộc mọi người", who: "staff", policy: { admin: true, all: true } },
  { name: "nhân viên có 2FA, bắt buộc mọi người", who: "staff", twoFactor: true, policy: { admin: true, all: true } },
  { name: "admin không 2FA, bắt buộc mọi người", who: "admin", policy: { admin: true, all: true } },
]

function gateOf(message: string | undefined): Gate {
  for (const [k, v] of Object.entries(MSG)) if (message === v) return k as Gate
  return "pass"
}

async function runAction(fn: (...a: unknown[]) => Promise<unknown>): Promise<Gate> {
  try {
    const r = (await fn({})) as { ok?: boolean; error?: string } | undefined
    return r && r.ok === false ? gateOf(r.error) : "pass"
  } catch (e) {
    // redirect() from signOut etc. would land here; for gated actions an exception means the gate threw
    return gateOf((e as Error).message)
  }
}

const sessions = new Map<string, Signed>()

async function actorFor(s: Scenario): Promise<Signed | null> {
  if (s.who === "anonymous") return null
  const key = JSON.stringify([s.who, s.mustChange, s.twoFactor, s.session])
  const hit = sessions.get(key)
  if (hit) return hit
  const u = await createTestUser(P, `a${sessions.size}`, { role: s.who, mustChangePassword: !!s.mustChange })
  const signed = await signIn(u)
  // flags that would break password sign-in are applied AFTER the session exists
  if (s.twoFactor) await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, u.id))
  if (s.session === "banned") await db.update(user).set({ banned: true }).where(eq(user.id, u.id))
  if (s.session === "expired") await db.update(sessionTable).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessionTable.userId, u.id))
  sessions.set(key, signed)
  return signed
}

async function setPolicy(p: { admin: boolean; all: boolean } | undefined) {
  await setSettingRaw("require_2fa_admin", !!p?.admin)
  await setSettingRaw("require_2fa_all", !!p?.all)
}

describe.skipIf(!hasDb)("ma trận phân quyền (DB + Better Auth)", () => {
  beforeAll(async () => {
    // an extra admin so that "the only user" special cases never apply
    await createTestUser(P, "anchor", { role: "admin" })
  })

  afterAll(async () => {
    await closeDb()
    await tmp?.drop()
  })

  it("mọi server action export từ src/server/actions đều đã được phân loại (action mới phải khai báo quyền)", async () => {
    for (const [mod, declared] of Object.entries(ACTIONS)) {
      const exported = Object.entries(await import(/* @vite-ignore */ mod))
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
        .sort()
      expect(exported, mod).toEqual(Object.keys(declared).sort())
    }
    const { readdirSync } = await import("node:fs")
    const files = readdirSync("src/server/actions")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `@/server/actions/${f.replace(/\.ts$/, "")}`)
      .sort()
    expect(files).toEqual(Object.keys(ACTIONS).sort())
  })

  for (const scenario of SCENARIOS) {
    it(`server action - ${scenario.name}`, async () => {
      await setPolicy(scenario.policy)
      actAs(await actorFor(scenario))
      const mismatches: string[] = []
      for (const [mod, declared] of Object.entries(ACTIONS)) {
        const m = (await import(/* @vite-ignore */ mod)) as Record<string, (...a: unknown[]) => Promise<unknown>>
        for (const [name, access] of Object.entries(declared)) {
          if (access === "public") continue
          const got = await runAction(m[name]!)
          const want = expectedGate(scenario, access, name)
          if (got !== want) mismatches.push(`${name}: expected ${want}, got ${got}`)
        }
      }
      expect(mismatches).toEqual([])
    })
  }

  it("signOutAction / setupFirstAdminAction không cần phiên (công khai) nhưng setup đã đóng khi đã có người dùng", async () => {
    await setPolicy(undefined)
    actAs(null)
    const { setupFirstAdminAction } = await import("@/server/actions/setup")
    const r = await setupFirstAdminAction({
      name: "Hacker",
      email: `${P}_hacker@example.test`,
      password: "Hacker-Password-1",
      confirmPassword: "Hacker-Password-1",
      setupToken: "x".repeat(32),
    })
    expect(r).toMatchObject({ ok: false, error: "Hệ thống đã có người dùng. Hãy đăng nhập." })
    expect(await db.select().from(user).where(eq(user.email, `${P}_hacker@example.test`))).toHaveLength(0)
  })

  // -------------------------------------------------------------------------------------------------------
  // Page guards: requireUser() / requireAdmin() (redirect or 404 instead of throwing a message)
  // -------------------------------------------------------------------------------------------------------
  type PageOutcome = "ok" | "/login" | "/security/change-password" | "/security/enable-2fa" | "404"

  async function page(fn: () => Promise<unknown>): Promise<PageOutcome> {
    try {
      await fn()
      return "ok"
    } catch (e) {
      const digest = String((e as { digest?: string }).digest ?? "")
      const m = /^NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(digest)
      if (m) return m[1] as PageOutcome
      if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return "404"
      throw e
    }
  }

  function expectedPage(s: Scenario, opts: { admin?: boolean; pending?: boolean }): PageOutcome {
    if (s.who === "anonymous" || s.session === "banned" || s.session === "expired") return "/login"
    const policy = s.policy ?? { admin: false, all: false }
    const required = s.who === "admin" ? policy.admin || policy.all : policy.all
    if (!opts.pending) {
      if (s.mustChange) return "/security/change-password"
      if (!s.twoFactor && required) return "/security/enable-2fa"
    }
    if (opts.admin && s.who !== "admin") return "404"
    return "ok"
  }

  for (const scenario of SCENARIOS) {
    it(`trang - ${scenario.name}`, async () => {
      await setPolicy(scenario.policy)
      actAs(await actorFor(scenario))
      const { requireUser, requireAdmin } = await import("@/server/auth/session")
      expect(await page(() => requireUser())).toBe(expectedPage(scenario, {}))
      expect(await page(() => requireAdmin())).toBe(expectedPage(scenario, { admin: true }))
      expect(await page(() => requireUser({ allowPendingSetup: true }))).toBe(expectedPage(scenario, { pending: true }))
    })
  }

  it("phiên cũ hơn session_max_hours bị coi là đã đăng xuất và dòng phiên bị xoá", async () => {
    await setPolicy(undefined)
    const u = await createTestUser(P, "cap", { role: "staff" })
    const s = await signIn(u)
    const { getSession } = await import("@/server/auth/session")
    actAs(s)
    expect(await getSession()).not.toBeNull()
    await setSettingRaw("session_max_hours", 1)
    try {
      expect(await getSession()).not.toBeNull() // 0 h old
      await db.update(sessionTable).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(sessionTable.userId, u.id))
      expect(await getSession()).toBeNull()
      expect(await db.select().from(sessionTable).where(eq(sessionTable.userId, u.id))).toHaveLength(0)
      // raising the cap does not resurrect a deleted session
      await setSettingRaw("session_max_hours", 168)
      expect(await getSession()).toBeNull()
    } finally {
      await setSettingRaw("session_max_hours", 12)
    }
  })
})
