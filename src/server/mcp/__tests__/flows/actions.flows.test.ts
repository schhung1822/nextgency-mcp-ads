// The SERVER ACTIONS (what the browser can really POST) for connections and MCP servers, with a crafted client:
// anonymous / staff-vs-staff / garbage input / re-auth failures / the require_2fa_all policy. Services are real, the
// session guard and the password check are the only fakes. Results must never carry credentials or MCP keys.
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
const requireUserForAction = vi.fn()
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserForAction: (...a: unknown[]) => requireUserForAction(...a),
}))
let reauthOutcome: "ok" | "bad_password" | "bad_code" | "code_required" = "ok"
vi.mock("@/server/auth/reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/reauth")>()),
  requestReauthVerifier: async () => async () => reauthOutcome,
}))

import {
  connectionUsageAction,
  createConnectionAction,
  deleteConnectionAction,
  previewConnectionAction,
  renameConnectionAction,
  replaceCredentialsAction,
  syncConnectionAccountsAction,
  testConnectionAction,
  toggleAdAccountsAction,
} from "@/server/actions/connections"
import {
  createMcpAction,
  deleteMcpAction,
  revealMcpUrlAction,
  rotateMcpKeyAction,
  setMcpEnabledAction,
  updateMcpAction,
} from "@/server/actions/mcp-servers"
import { AuthorizationError } from "@/server/auth/session"
import { db } from "@/server/db/client"
import { quotaId } from "@/server/db/quota"
import { activityLogs, appSettings, connections, mcpServers, verification } from "@/server/db/schema"
import { demoAccounts, loadTestEnv, World, type ConnInfo, type McpInfo } from "./world"

const hasDb = loadTestEnv()

describe.skipIf(!hasDb)("server actions with a crafted client", { timeout: 180_000 }, () => {
  let w: World
  let staffConn: ConnInfo
  let staffMcp: McpInfo
  const asUser = (u: { id: string; email: string; role: "admin" | "staff" }, twoFactorEnabled = false) =>
    requireUserForAction.mockResolvedValue({
      sessionId: "s",
      user: { ...u, name: u.id, twoFactorEnabled, mustChangePassword: false, banned: false },
    })
  const anonymous = () => requireUserForAction.mockRejectedValue(new AuthorizationError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."))

  beforeAll(async () => {
    w = await World.create()
    staffConn = await w.connect(w.users.staff, "meta", demoAccounts(w.prefix, "meta"))
    staffMcp = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read", "status"], connections: [{ conn: staffConn }] } } })
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(async () => {
    reauthOutcome = "ok"
    requireUserForAction.mockReset()
    w.reset()
    // provider calls are throttled per user (10 / min): every test starts with an empty budget
    const ids = Object.values(w.users).map((u) => quotaId("connection-verify", u.id))
    await db.delete(verification).where(inArray(verification.id, ids))
  })

  const validMcpInput = (conn: ConnInfo, extra: Record<string, unknown> = {}) => ({ ...w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } }), password: "x", ...extra })
  const snapshot = async () => ({
    conn: await w.connRow(staffConn.id),
    accounts: await w.accountRows(staffConn.id),
    mcp: (await db.select().from(mcpServers).where(eq(mcpServers.id, staffMcp.id)))[0]!,
  })
  const leaks = (r: unknown) => {
    const s = JSON.stringify(r)
    return [staffMcp.key, staffConn.token, "credentialsEncrypted", "keyEncrypted", "key_hash"].filter((x) => s.includes(x))
  }

  // ---------------------------------------------------------------------------------------------
  it("anonymous callers get a Vietnamese refusal from EVERY action and nothing changes", async () => {
    anonymous()
    const before = await snapshot()
    const id = staffConn.id
    const mid = staffMcp.id
    const results = await Promise.all([
      previewConnectionAction({ platform: "meta", credentials: { token: "abc" } }),
      createConnectionAction({ platform: "meta", name: "x", credentials: { token: "abc" } }),
      renameConnectionAction({ connectionId: id, name: "hacked" }),
      replaceCredentialsAction({ connectionId: id, credentials: { token: "abc" }, password: "x" }),
      testConnectionAction({ connectionId: id }),
      syncConnectionAccountsAction({ connectionId: id }),
      toggleAdAccountsAction({ connectionId: id, changes: [{ adAccountId: staffConn.accounts[0]!.id, enabled: false }] }),
      connectionUsageAction({ connectionId: id }),
      deleteConnectionAction({ connectionId: id }),
      createMcpAction(validMcpInput(staffConn)),
      updateMcpAction({ id: mid, ...w.toInput({ platforms: { meta: { permissions: ["read", "delete"], connections: [{ conn: staffConn }] } } }) }),
      setMcpEnabledAction({ id: mid, enabled: false }),
      rotateMcpKeyAction({ id: mid, password: "x" }),
      revealMcpUrlAction({ id: mid, password: "x" }),
      deleteMcpAction({ id: mid, confirmName: "x" }),
    ])
    for (const r of results) {
      expect(r.ok).toBe(false)
      expect((r as { error: string }).error).toMatch(/Phiên đăng nhập đã hết hạn/)
      expect(leaks(r)).toEqual([])
    }
    const after = await snapshot()
    expect(after).toEqual(before)
  })

  it("another staff member cannot read, change, rotate, reveal or delete someone else's connection or MCP - not even with real ids", async () => {
    asUser(w.users.staff2)
    const before = await snapshot()
    const id = staffConn.id
    const mid = staffMcp.id
    const results = await Promise.all([
      renameConnectionAction({ connectionId: id, name: "hacked" }),
      replaceCredentialsAction({ connectionId: id, credentials: { token: "abc" }, password: "x" }),
      testConnectionAction({ connectionId: id }),
      syncConnectionAccountsAction({ connectionId: id }),
      toggleAdAccountsAction({ connectionId: id, changes: [{ adAccountId: staffConn.accounts[0]!.id, enabled: false }] }),
      connectionUsageAction({ connectionId: id }),
      deleteConnectionAction({ connectionId: id }),
      updateMcpAction({ id: mid, ...w.toInput({ platforms: { meta: { permissions: ["read", "delete"], connections: [{ conn: staffConn }] } } }) }),
      setMcpEnabledAction({ id: mid, enabled: false }),
      rotateMcpKeyAction({ id: mid, password: "x" }),
      revealMcpUrlAction({ id: mid, password: "x" }),
      deleteMcpAction({ id: mid, confirmName: (await w.connRow(staffConn.id)).name }),
      // creating an MCP of their own around somebody else's connection
      createMcpAction(validMcpInput(staffConn, { name: "steal" })),
    ])
    for (const r of results) {
      expect(r.ok).toBe(false)
      expect(leaks(r)).toEqual([])
    }
    expect((results[0] as { error: string }).error).toMatch(/Không tìm thấy kết nối/)
    expect((results[8] as { error: string }).error).toMatch(/Không tìm thấy MCP/)
    expect((results[12] as { error: string }).error).toMatch(/Kết nối không tồn tại/)
    expect(await snapshot()).toEqual(before)
    // the failed create left no MCP behind
    const stolen = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, w.users.staff2.id))
    expect(stolen).toHaveLength(0)
  })

  it("the owner and an admin can use the same actions; admin editing keeps the owner's rules", async () => {
    asUser(w.users.admin, true)
    const rename = await renameConnectionAction({ connectionId: staffConn.id, name: `${w.prefix} renamed by admin` })
    expect(rename.ok).toBe(true)
    const test = await testConnectionAction({ connectionId: staffConn.id })
    expect(test.ok).toBe(true)
    expect(leaks(test)).toEqual([])
    const usage = await connectionUsageAction({ connectionId: staffConn.id })
    expect(usage.ok && usage.data.map((u) => u.id)).toContain(staffMcp.id)

    const reveal = await revealMcpUrlAction({ id: staffMcp.id, password: "x" })
    expect(reveal.ok && reveal.data.url.endsWith(staffMcp.key)).toBe(true) // the ONLY place the key may appear
    // re-auth failures: refused, logged as failures with metadata.reauth, key not revealed
    reauthOutcome = "bad_password"
    const bad = await revealMcpUrlAction({ id: staffMcp.id, password: "wrong" })
    expect(bad.ok).toBe(false)
    expect(leaks(bad)).toEqual([])
    const rot = await rotateMcpKeyAction({ id: staffMcp.id, password: "wrong" })
    expect(rot.ok).toBe(false)
    const fails = await db.select().from(activityLogs).where(eq(activityLogs.actorId, w.users.admin.id))
    expect(fails.filter((l) => l.status === "failure" && (l.metadata as { reauth?: boolean }).reauth).length).toBeGreaterThanOrEqual(2)
    reauthOutcome = "ok"
    // the old key still works (the failed rotation changed nothing)
    expect((await w.tools(staffMcp.key)).status).toBe(200)

    // admin edits the staff MCP: another person's connection is refused for the STAFF owner's MCP
    const adminConn = await w.connect(w.users.admin, "meta", demoAccounts(w.prefix, "meta").map((a) => ({ ...a, externalId: `${a.externalId}z` })))
    const refused = await updateMcpAction({ id: staffMcp.id, ...w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn: adminConn }] } } }) })
    expect(refused.ok).toBe(false)
  })

  it("garbage input is answered with a failure result, never an exception or a stack trace", async () => {
    asUser(w.users.staff)
    const garbage: unknown[] = [null, undefined, 42, "x", [], {}, { id: "not-a-uuid" }, { id: staffMcp.id }, { connectionId: ["a"] }, "{".repeat(10_000)]
    const calls: ((i: unknown) => Promise<{ ok: boolean }>)[] = [
      previewConnectionAction,
      createConnectionAction,
      renameConnectionAction,
      replaceCredentialsAction,
      testConnectionAction,
      syncConnectionAccountsAction,
      toggleAdAccountsAction,
      connectionUsageAction,
      deleteConnectionAction,
      createMcpAction,
      updateMcpAction,
      setMcpEnabledAction,
      rotateMcpKeyAction,
      revealMcpUrlAction,
      deleteMcpAction,
    ]
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    for (const call of calls) {
      for (const g of garbage) {
        const r = (await call(g)) as { ok: boolean; error?: string }
        expect(r.ok, `${call.name} ${JSON.stringify(g)?.slice(0, 40)}`).toBe(false)
        expect(typeof r.error).toBe("string")
        expect(r.error).not.toMatch(/at \w+|node_modules|ZodError|drizzle/i)
      }
    }
    err.mockRestore()
  })

  it("settings the wizard would never send are refused by the server (expiry in the past, bad caps, bad IPs, 0 rate, unknown keys ignored)", async () => {
    asUser(w.users.staff)
    const base = validMcpInput(staffConn, { name: "bad settings" })
    const bad = (patch: (i: ReturnType<typeof validMcpInput>) => void) => {
      const i = structuredClone(base) as ReturnType<typeof validMcpInput>
      patch(i)
      return createMcpAction(i)
    }
    const cases = await Promise.all([
      bad((i) => void (i.expiresAt = new Date(Date.now() - 86_400_000).toISOString())),
      bad((i) => void (i.expiresAt = "yesterday" as unknown as string)),
      bad((i) => void (i.settings.rateLimitPerMin = 0)),
      bad((i) => void (i.settings.rateLimitPerMin = 100_000)),
      bad((i) => void (i.settings.writeRateLimitPer10Min = -1)),
      bad((i) => void (i.settings.budgetChangeMaxPct = 0)),
      bad((i) => void (i.settings.budgetChangeMaxPct = 1_000_000)),
      bad((i) => void (i.settings.maxDailyBudget = { vnd: 5 } as never)),
      bad((i) => void (i.settings.maxDailyBudget = { VND: -5 })),
      bad((i) => void (i.settings.maxDailyBudget = { VND: Number.NaN })),
      bad((i) => void (i.settings.maxBid = { USD: 0 })),
      bad((i) => void (i.settings.allowedIps = ["not an ip"])),
      bad((i) => void (i.settings.allowedIps = Array.from({ length: 51 }, (_, n) => `10.0.0.${n}`))),
      bad((i) => void (i.name = "   ")),
      bad((i) => void (i.name = "x".repeat(81))),
      bad((i) => void (i.name = "evil‮name")),
      bad((i) => void (i.platforms = [])),
      bad((i) => void (i.platforms[0]!.connections = [])),
      bad((i) => void (i.platforms[0]!.connections[0]!.accountIds = [])),
    ])
    cases.forEach((r, n) => expect(r.ok, `case ${n}`).toBe(false))
    expect((await db.select().from(mcpServers).where(eq(mcpServers.ownerId, w.users.staff.id))).every((m) => m.name !== "bad settings")).toBe(true)
  })

  it("require_2fa_all: a staff member without 2FA cannot touch MCPs by posting actions directly", async () => {
    const [prev] = await db.select().from(appSettings).where(eq(appSettings.key, "require_2fa_all"))
    await db.insert(appSettings).values({ key: "require_2fa_all", value: true }).onConflictDoUpdate({ target: appSettings.key, set: { value: true } })
    try {
      asUser(w.users.staff, false)
      const r = await setMcpEnabledAction({ id: staffMcp.id, enabled: false })
      expect(r.ok).toBe(false)
      expect((r as { error: string }).error).toMatch(/2 bước|2FA/i)
      expect((await db.select().from(mcpServers).where(eq(mcpServers.id, staffMcp.id)))[0]!.status).toBe("active")
      asUser(w.users.staff, true)
      expect((await setMcpEnabledAction({ id: staffMcp.id, enabled: true })).ok).toBe(true)
    } finally {
      if (prev) await db.update(appSettings).set({ value: prev.value }).where(eq(appSettings.key, "require_2fa_all"))
      else await db.delete(appSettings).where(inArray(appSettings.key, ["require_2fa_all"]))
    }
  })

  it("calls that reach the ad platform are throttled per user: the 11th within a minute is refused, other users are not affected", async () => {
    asUser(w.users.staff)
    for (let i = 0; i < 10; i++) {
      const r = await testConnectionAction({ connectionId: staffConn.id })
      expect(r.ok, `call ${i + 1}`).toBe(true)
    }
    const throttled = await testConnectionAction({ connectionId: staffConn.id })
    expect(throttled).toMatchObject({ ok: false, error: expect.stringMatching(/quá nhanh.*\d+ giây/) })
    // every provider-facing action shares the budget
    expect(await syncConnectionAccountsAction({ connectionId: staffConn.id })).toMatchObject({ ok: false, error: expect.stringMatching(/quá nhanh/) })
    expect(await previewConnectionAction({ platform: "meta", credentials: { token: "abc" } })).toMatchObject({ ok: false, error: expect.stringMatching(/quá nhanh/) })
    expect(await replaceCredentialsAction({ connectionId: staffConn.id, credentials: { token: "abc" }, password: "x" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/quá nhanh/),
    })
    // other actions are not throttled
    expect((await connectionUsageAction({ connectionId: staffConn.id })).ok).toBe(true)
    // another user has their own budget
    asUser(w.users.admin, true)
    expect((await testConnectionAction({ connectionId: staffConn.id })).ok).toBe(true)
  })

  it("deleting needs the exact name; the answer never contains the key; the old link is dead afterwards", async () => {
    asUser(w.users.staff)
    const tmp = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: staffConn }] } } })
    const name = (await db.select().from(mcpServers).where(eq(mcpServers.id, tmp.id)))[0]!.name
    const wrong = await deleteMcpAction({ id: tmp.id, confirmName: `${name} ` + "x" })
    expect(wrong.ok).toBe(false)
    expect((await w.tools(tmp.key)).status).toBe(200)
    const done = await deleteMcpAction({ id: tmp.id, confirmName: name })
    expect(done.ok).toBe(true)
    expect(leaks(done)).toEqual([])
    expect((await w.tools(tmp.key)).status).toBe(404)
    // the connection row still exists (only the MCP went)
    expect((await db.select().from(connections).where(eq(connections.id, staffConn.id))).length).toBe(1)
  })
})
