// Background jobs (tokens.health / accounts.sync / pending_actions.cleanup) against fake platforms and the dev DB:
// health transitions, new accounts disabled, missing accounts closed, disabled/deleted connections left alone,
// one broken connection never stops the others, no activity log, MCP grants follow.
import { and, eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
// A run without a connection id looks at EVERY active connection of the database, including other test files' (whose
// tokens this file's fake platforms do not know and would flag invalid): scope it to the ids this test created.
const scope = vi.hoisted(() => ({ ids: null as string[] | null }))
vi.mock("@/server/jobs/lib/connection-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/jobs/lib/connection-ops")>()
  return { ...actual, listActiveConnectionIds: async () => scope.ids ?? actual.listActiveConnectionIds() }
})

import { statusHintFor } from "@/lib/schemas/connections"
import { db } from "@/server/db/client"
import { activityLogs, connections, mcpPendingActions } from "@/server/db/schema"
import { JOBS } from "@/server/jobs"
import { runConnectionRefresh } from "@/server/jobs/connection-refresh"
import { runPendingActionsCleanup } from "@/server/jobs/pending-cleanup"
import { accountInfo } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World } from "./world"

const hasDb = loadTestEnv()
const DAY = 86_400_000
const ctx = (logs: string[] = []) => ({ signal: new AbortController().signal, log: (m: string) => void logs.push(m) })

describe.skipIf(!hasDb)("background jobs (fake platforms)", { timeout: 180_000 }, () => {
  let w: World
  beforeAll(async () => {
    w = await World.create()
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => w.reset())

  const status = async (id: string) => {
    const r = await w.connRow(id)
    return { status: r.status, message: r.statusMessage, checked: r.lastCheckedAt, expires: r.tokenExpiresAt }
  }

  it("tokens.health: expiring / revoked / transient / disabled / deleted / unreadable credentials - each handled, none stops the others", async () => {
    const actor = w.users.staff
    const mk = (n: string) => w.connect(actor, "meta", demoAccounts(w.prefix, "meta").slice(0, 1).map((a) => ({ ...a, externalId: `${a.externalId}${n}` })), { name: `${w.prefix} ${n}` })
    const [healthy, expiring, revoked, transient, disabled, deleted, broken] = [await mk("h"), await mk("e"), await mk("r"), await mk("t"), await mk("d"), await mk("x"), await mk("b")]
    expect((await status(healthy.id)).status).toBe("active")

    w.setToken("meta", expiring.token, { expiresAt: new Date(Date.now() + 2 * DAY) })
    w.setToken("meta", revoked.token, { authError: true })
    w.setToken("meta", transient.token, { transientError: true })
    await db.update(connections).set({ status: "disabled" }).where(eq(connections.id, disabled.id))
    await w.removeConnection(actor, deleted.id)
    await db.update(connections).set({ credentialsEncrypted: "v1.garbage.garbage.garbage" }).where(eq(connections.id, broken.id))
    w.state.validations.length = 0

    const logs: string[] = []
    const mine = [healthy, expiring, revoked, transient, disabled, deleted, broken]
    // run for exactly these connections (the DB may hold other tests' connections)
    for (const c of mine) await runConnectionRefresh({ connectionId: c.id }, ctx(logs), { syncAccounts: false })

    expect((await status(healthy.id)).status).toBe("active")
    const e = await status(expiring.id)
    expect(e.status).toBe("expiring")
    expect(e.message).toMatch(/hết hạn sau/)
    const r = await status(revoked.id)
    expect(r.status).toBe("invalid")
    expect(r.message).toBe("Token đã bị thu hồi.")
    const t = await status(transient.id)
    expect(t.status).toBe("active") // unchanged
    expect(t.message).toMatch(/^Không kiểm tra được/)
    expect((await status(disabled.id)).status).toBe("disabled") // never revived
    expect((await w.connRow(deleted.id)).deletedAt).not.toBeNull()
    expect(w.state.validations.map((v) => v.token)).not.toContain(disabled.token) // not even contacted
    expect(w.state.validations.map((v) => v.token)).not.toContain(deleted.token)
    // a connection whose stored credentials cannot be decrypted is reported, never "valid", and no secret reaches the log
    const b = await status(broken.id)
    expect(b.status).not.toBe("invalid") // not the token's fault
    expect(b.message).toBe("Không giải mã được token đã lưu.")
    expect(statusHintFor({ platform: "meta", status: b.status as "active", statusMessage: b.message })).toMatch(/ENCRYPTION_KEYS/) // says what is wrong, not "cannot reach the platform"
    expect(logs.join("\n")).not.toContain(broken.token)

    // the jobs write NO activity log (system actions), unlike the user buttons
    const acts = await db.select().from(activityLogs).where(and(eq(activityLogs.action, "connection.test"), inArray(activityLogs.targetId, mine.map((c) => c.id))))
    expect(acts).toHaveLength(0)

    // a transient failure on an already invalid / expiring connection keeps the original reason
    w.setToken("meta", revoked.token, { authError: false, transientError: true })
    await runConnectionRefresh({ connectionId: revoked.id }, ctx(), { syncAccounts: false })
    expect(await status(revoked.id)).toMatchObject({ status: "invalid", message: "Token đã bị thu hồi." })
    w.setToken("meta", revoked.token, { transientError: false })
    await runConnectionRefresh({ connectionId: expiring.id }, ctx(), { syncAccounts: false })
    expect((await status(expiring.id)).message).toMatch(/hết hạn sau/)
    w.setToken("meta", expiring.token, { transientError: true })
    await runConnectionRefresh({ connectionId: expiring.id }, ctx(), { syncAccounts: false })
    expect((await status(expiring.id)).message).toMatch(/hết hạn sau/) // not "Không kiểm tra được"

    // recovery: the token works again → active, message cleared
    w.setToken("meta", revoked.token, { authError: false })
    await runConnectionRefresh({ connectionId: revoked.id }, ctx(), { syncAccounts: false })
    expect(await status(revoked.id)).toMatchObject({ status: "active", message: null })
  })

  it("a full run (no connection id) survives a broken connection and reports a summary", async () => {
    const actor = w.users.staff
    const good = await w.connect(actor, "meta", demoAccounts(w.prefix, "meta").slice(0, 1).map((a) => ({ ...a, externalId: `${a.externalId}run` })))
    const bad = await w.connect(actor, "meta", demoAccounts(w.prefix, "meta").slice(1, 2).map((a) => ({ ...a, externalId: `${a.externalId}run` })))
    await db.update(connections).set({ credentialsEncrypted: "not-a-ciphertext" }).where(eq(connections.id, bad.id))
    w.setToken("meta", good.token, { expiresAt: new Date(Date.now() + 1 * DAY) })
    scope.ids = [bad.id, good.id] // the broken one first: it must not stop the run
    const summary = await runConnectionRefresh(undefined, ctx(), { syncAccounts: false }).finally(() => (scope.ids = null))
    expect(summary.checked).toBe(2)
    expect((await status(good.id)).status).toBe("expiring")
    expect((await status(bad.id)).checked).not.toBeNull() // looked at, did not abort the run
  })

  it("accounts.sync: new accounts arrive DISABLED, missing ones are closed (never deleted), an MCP over 'all accounts' does not grow", async () => {
    const actor = w.users.staff
    const accs = demoAccounts(w.prefix, "meta").map((a) => ({ ...a, externalId: `${a.externalId}j` }))
    const conn = await w.connect(actor, "meta", accs)
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    const before = await w.visibleAccounts(mcp.key)
    const mcc = accountInfo(`${accs[0]!.externalId}9`, { isManager: true, name: "MCC" })
    const fresh = accountInfo(`${accs[0]!.externalId}8`, { currency: "EUR", timezone: "Europe/Berlin" })
    w.setToken("meta", conn.token, { accounts: [accs[1]!, mcc, fresh] })
    const s = await runConnectionRefresh({ connectionId: conn.id }, ctx(), { syncAccounts: true })
    expect(s.accountsSynced).toBe(3)
    const rows = new Map((await w.accountRows(conn.id)).map((r) => [r.externalId, r]))
    expect(rows.get(fresh.externalId)!.isEnabled).toBe(false)
    expect(rows.get(mcc.externalId)!.isEnabled).toBe(false)
    expect(rows.get(accs[1]!.externalId)!.isEnabled).toBe(true)
    expect(rows.has(accs[0]!.externalId)).toBe(true) // kept, only closed
    expect(await w.visibleAccounts(mcp.key)).toEqual(before) // grant unchanged (still lists the closed account, none of the new ones)
    // health-only runs never touch accounts
    w.setToken("meta", conn.token, { accounts: [] })
    await runConnectionRefresh({ connectionId: conn.id }, ctx(), { syncAccounts: false })
    expect((await w.accountRows(conn.id)).length).toBe(rows.size)
  })

  it("pending_actions.cleanup expires old tokens and deletes finished ones after 7 days", async () => {
    const actor = w.users.staff
    const conn = await w.connect(actor, "meta", demoAccounts(w.prefix, "meta").slice(0, 1).map((a) => ({ ...a, externalId: `${a.externalId}p` })))
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read", "update"], connections: [{ conn }] } } })
    const mk = async (status: string, o: { expires?: number; consumed?: number }) => {
      const [row] = await db
        .insert(mcpPendingActions)
        .values({
          tokenHash: `${w.prefix}-${Math.random()}`,
          mcpId: mcp.id,
          toolName: "ads_set_status",
          argsHash: "h",
          args: {},
          preview: {},
          status,
          expiresAt: new Date(Date.now() + (o.expires ?? 0) * DAY),
          consumedAt: o.consumed === undefined ? null : new Date(Date.now() + o.consumed * DAY),
        })
        .returning({ id: mcpPendingActions.id })
      return row!.id
    }
    const fresh = await mk("pending", { expires: 0.5 })
    const stale = await mk("pending", { expires: -0.1 })
    const oldConsumed = await mk("consumed", { expires: -9, consumed: -8 })
    const recentConsumed = await mk("consumed", { expires: -2, consumed: -1 })
    const r = await runPendingActionsCleanup()
    expect(r.deleted).toBeGreaterThanOrEqual(1)
    const left = new Map((await db.select().from(mcpPendingActions).where(eq(mcpPendingActions.mcpId, mcp.id))).map((x) => [x.id, x.status]))
    expect(left.get(fresh)).toBe("pending")
    expect(left.get(stale)).toBe("expired")
    expect(left.has(oldConsumed)).toBe(false)
    expect(left.get(recentConsumed)).toBe("consumed")
  })

  it("registers every job once with a valid queue name and cron", () => {
    const names = JOBS.map((j) => j.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(["tokens.health", "accounts.sync", "logs.maintain", "logs.rollup", "pending_actions.cleanup"]))
    for (const j of JOBS) {
      expect(j.name).toMatch(/^[A-Za-z0-9_.-]+$/)
      if (j.cron) expect(j.cron.trim().split(/\s+/)).toHaveLength(5)
      expect(typeof j.handler).toBe("function")
    }
  })
})
