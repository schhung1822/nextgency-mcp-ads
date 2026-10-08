// TikTok "Đổi auth_code": the exchange happens on the SERVER and the access token is stored encrypted - it must
// never travel back to the browser, appear in logs, or be reused when the exchange fails. Platform side is faked.
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
const requireUserForAction = vi.fn()
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserForAction: (...a: unknown[]) => requireUserForAction(...a),
}))
vi.mock("@/server/auth/reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/reauth")>()),
  requestReauthVerifier: async () => async () => "ok" as const,
}))
const exchange = vi.hoisted(() => vi.fn())
vi.mock("@/server/providers/tiktok", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/providers/tiktok")>()),
  exchangeAuthCode: (...a: unknown[]) => exchange(...a),
}))

import { createTikTokFromAuthCodeAction, replaceTikTokFromAuthCodeAction } from "@/server/actions/connections"
import { db } from "@/server/db/client"
import { createConnection } from "@/server/services/connections"
import { activityLogs, connections } from "@/server/db/schema"
import { ProviderError } from "@/server/providers/errors"
import { registerProvider } from "@/server/providers/registry"
import { createFlowsProvider } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World } from "./world"

const hasDb = loadTestEnv()
const SECRET_TOKEN = "tt_long_term_access_token_0123456789"
const APP_SECRET = "tt_app_secret_abcdef0123456789"
const AUTH_CODE = "tt_auth_code_zzz"

describe.skipIf(!hasDb)("TikTok auth_code exchange", { timeout: 120_000 }, () => {
  let w: World
  beforeAll(async () => {
    w = await World.create()
    // the real TikTok credential shape: { accessToken, appId, secret } (the flows fake normally uses { token })
    const base = createFlowsProvider("tiktok", w.state)
    registerProvider({
      ...base,
      parseCredentials: (raw) => {
        const r = raw as { accessToken?: string; appId?: string; secret?: string }
        if (!r.accessToken || !r.appId || !r.secret) throw new ProviderError({ platform: "tiktok", code: "invalid_credentials_input", message: "bad", userMessageVi: "Thiếu thông tin." })
        return { token: r.accessToken, appId: r.appId, secret: r.secret }
      },
    })
    w.setToken("tiktok", SECRET_TOKEN, { accounts: demoAccounts(w.prefix, "tiktok") })
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => {
    exchange.mockReset()
    requireUserForAction.mockReset()
    requireUserForAction.mockResolvedValue({
      sessionId: "s",
      user: { ...w.users.staff, name: "s", twoFactorEnabled: false, mustChangePassword: false, banned: false },
    })
  })

  const input = (extra: Record<string, unknown> = {}) => ({ name: `${w.prefix} tt auth`, appId: "7312345678901234567", secret: APP_SECRET, authCode: AUTH_CODE, ...extra })

  it("creates the connection server-side: the browser only gets the id, the token is encrypted and absent from every log", async () => {
    exchange.mockResolvedValue({ accessToken: SECRET_TOKEN, scope: ["1", "2", "4", "6", "8"], advertiserIds: [] })
    const r = await createTikTokFromAuthCodeAction(input())
    expect(r.ok).toBe(true)
    const blob = JSON.stringify(r)
    for (const secret of [SECRET_TOKEN, APP_SECRET, AUTH_CODE]) expect(blob).not.toContain(secret)
    expect(Object.keys((r as { data: object }).data)).toEqual(["id"])
    // the exchange got exactly what the user typed
    expect(exchange).toHaveBeenCalledWith({ appId: "7312345678901234567", secret: APP_SECRET, authCode: AUTH_CODE }) // nothing else (no name…)

    const id = (r as { data: { id: string } }).data.id
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    for (const secret of [SECRET_TOKEN, APP_SECRET, AUTH_CODE]) expect(row!.credentialsEncrypted).not.toContain(secret)
    expect(JSON.stringify(row!.meta)).not.toContain(SECRET_TOKEN)
    expect(row!.meta).toMatchObject({ scope: ["1", "2", "4", "6", "8"] }) // non-secret, kept for the scope warnings
    expect(row!.credentialHint).toBe(`…${SECRET_TOKEN.slice(-4)}`)
    const logs = JSON.stringify(await db.select().from(activityLogs).where(eq(activityLogs.targetId, id)))
    for (const secret of [SECRET_TOKEN, APP_SECRET, AUTH_CODE]) expect(logs).not.toContain(secret)
    expect(logs).toContain("auth_code") // metadata.via
    // the accounts the token can see were synced; closed/pending ones would default OFF (all active here)
    expect((await w.accountRows(id)).length).toBe(demoAccounts(w.prefix, "tiktok").length)
  })

  it("a failed exchange creates nothing and leaks nothing (Vietnamese message)", async () => {
    exchange.mockRejectedValue(
      new ProviderError({ platform: "tiktok", code: "auth_invalid", message: `auth_code ${AUTH_CODE} expired secret ${APP_SECRET}`, userMessageVi: "auth_code đã hết hạn hoặc đã dùng.", hint: "Tạo auth_code mới." })
    )
    const before = (await db.select().from(connections).where(eq(connections.ownerId, w.users.staff.id))).length
    const r = await createTikTokFromAuthCodeAction(input({ name: `${w.prefix} tt fail` }))
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/auth_code đã hết hạn/)
    for (const secret of [SECRET_TOKEN, APP_SECRET, AUTH_CODE]) expect(JSON.stringify(r)).not.toContain(secret)
    expect((await db.select().from(connections).where(eq(connections.ownerId, w.users.staff.id))).length).toBe(before)
    // malformed input never reaches TikTok
    exchange.mockClear()
    for (const bad of [{ appId: "abc" }, { secret: "" }, { authCode: "" }, { appId: "1".repeat(65) }]) {
      expect((await createTikTokFromAuthCodeAction(input(bad))).ok).toBe(false)
    }
    expect(exchange).not.toHaveBeenCalled()
  })

  it("replacing the token by auth_code re-authenticates, only works on TikTok connections of the caller, and swaps the stored secret", async () => {
    const accounts = demoAccounts(w.prefix, "tiktok").map((a) => ({ ...a, externalId: `${a.externalId}r` }))
    const firstToken = w.token("tiktok", accounts)
    const created = await createConnection(w.users.staff, { platform: "tiktok", name: `${w.prefix} tt replace`, credentials: { accessToken: firstToken, appId: "7312345678901234567", secret: APP_SECRET } })
    const own = { id: created.id }
    const oldCipher = (await w.connRow(own.id)).credentialsEncrypted
    const newToken = `${SECRET_TOKEN}_new`
    w.setToken("tiktok", newToken, { accounts })
    exchange.mockResolvedValue({ accessToken: newToken, scope: ["1", "2"], advertiserIds: [] })
    const r = await replaceTikTokFromAuthCodeAction({ connectionId: own.id, password: "pw", appId: "7312345678901234567", secret: APP_SECRET, authCode: AUTH_CODE })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify(r)).not.toContain(newToken)
    const after = await w.connRow(own.id)
    expect(after.credentialsEncrypted).not.toBe(oldCipher)
    expect(after.credentialsEncrypted).not.toContain(newToken)
    expect(after.credentialHint).toBe(`…${newToken.slice(-4)}`)

    // somebody else's connection: not found, the exchange never runs
    exchange.mockClear()
    requireUserForAction.mockResolvedValue({ sessionId: "s", user: { ...w.users.staff2, name: "s", twoFactorEnabled: false, mustChangePassword: false, banned: false } })
    const foreign = await replaceTikTokFromAuthCodeAction({ connectionId: own.id, password: "pw", appId: "7312345678901234567", secret: APP_SECRET, authCode: AUTH_CODE })
    expect(foreign.ok).toBe(false)
    // a non-TikTok connection of the caller: refused
    requireUserForAction.mockResolvedValue({ sessionId: "s", user: { ...w.users.staff, name: "s", twoFactorEnabled: false, mustChangePassword: false, banned: false } })
    const meta = await w.connect(w.users.staff, "meta", demoAccounts(w.prefix, "meta").map((a) => ({ ...a, externalId: `${a.externalId}m` })))
    const wrong = await replaceTikTokFromAuthCodeAction({ connectionId: meta.id, password: "pw", appId: "7312345678901234567", secret: APP_SECRET, authCode: AUTH_CODE })
    expect(wrong.ok).toBe(false)
    expect((wrong as { error: string }).error).toMatch(/Chỉ kết nối TikTok/)
    expect(exchange).not.toHaveBeenCalled()
  })
})
