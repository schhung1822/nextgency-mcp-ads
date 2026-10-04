// END-TO-END flows through the REAL services and the REAL /mcp/<key> endpoint (fake platforms, dev DB):
// connection wizard → MCP wizard → AI client (both protocol eras) → key lifecycle → connection health →
// sync / token replacement → deletion while referenced → grant-cache invalidation → activity-log atomicity.
import { and, eq, inArray, like, or } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({ failLog: false }))
vi.mock("server-only", () => ({}))
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...actual,
    logActivity: async (...args: Parameters<typeof actual.logActivity>) => {
      if (hoisted.failLog) throw new Error("simulated activity log failure")
      return actual.logActivity(...args)
    },
  }
})

import { flushMcpLogs } from "@/server/audit/mcp-log-writer"
import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections, mcpCallLogs, mcpServers } from "@/server/db/schema"
import { getMcpServer } from "@/server/services/mcp-servers"
import { PLATFORMS } from "@/server/providers/types"
import { accountInfo } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const DAY = 86_400_000

describe.skipIf(!hasDb)("flows: connection → MCP → AI client", { timeout: 120_000 }, () => {
  let w: World
  beforeAll(async () => {
    w = await World.create()
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => {
    hoisted.failLog = false
    w.reset()
  })

  // ---------------------------------------------------------------------------------------------
  describe.each(PLATFORMS)("wizard → MCP → AI on %s", (platform) => {
    it("previews, saves (wizard switches an account off), builds an MCP and serves exactly the enabled accounts", async () => {
      const accounts = demoAccounts(w.prefix, platform)
      const token = w.token(platform, accounts)
      const actor = w.users.staff

      // step 3 of the wizard: validate + list (nothing saved)
      const before = await db.select().from(connections).where(eq(connections.ownerId, actor.id))
      const pv = await w.preview(actor, { platform, credentials: { token } })
      expect(pv.status).toBe("active")
      expect(pv.accounts.map((a) => a.externalId).sort()).toEqual(accounts.map((a) => a.externalId).sort())
      expect(pv.accounts.map((a) => a.currency).sort()).toEqual(accounts.map((a) => a.currency).sort())
      expect(JSON.stringify(pv)).not.toContain(token)
      expect((await db.select().from(connections).where(eq(connections.ownerId, actor.id))).length).toBe(before.length)

      // save with the last account switched off
      const off = accounts[accounts.length - 1]!.externalId
      const { id } = await (await import("@/server/services/connections")).createConnection(actor, {
        platform,
        name: `${w.prefix} ${platform} wizard`,
        credentials: { token },
        disabledExternalIds: accounts.length > 1 ? [off] : [],
      })
      const conn: ConnInfo = { id, platform, token, ownerId: actor.id, accounts: await w.accountRows(id) }
      const expectedOn = accounts.filter((a) => accounts.length === 1 || a.externalId !== off).map((a) => `${platform}:${a.externalId}`).sort()
      expect(conn.accounts.filter((a) => a.isEnabled).map((a) => `${platform}:${a.externalId}`).sort()).toEqual(expectedOn)

      // stored credential is encrypted, never the raw token
      const row = await w.connRow(id)
      expect(row.credentialsEncrypted).not.toContain(token)
      expect(row.credentialHint).toBe(`…${token.slice(-4)}`)

      // MCP over every enabled account of the connection with every permission
      const mcp = await w.mcp(actor, {
        platforms: { [platform]: { permissions: ["read", "status", "update", "copy", "create", "delete"], connections: [{ conn }] } },
      })
      for (const modern of [true, false]) {
        const t = await w.tools(mcp.key, { modern })
        expect(t.status).toBe(200)
        expect(t.names).toContain("ads_list_accounts")
        expect(t.names).toContain(`${platform}_fake_create_campaign`)
      }
      expect(await w.visibleAccounts(mcp.key)).toEqual(expectedOn)
      // the 2025-era client (no per-request envelope) gets the same answers as the 2026-07-28 one
      for (const modern of [true, false]) {
        const l = await w.call(mcp.key, "ads_list_accounts", {}, { modern })
        expect(l.isError, l.text).toBe(false)
        expect((l.sc.accounts as { account_id: string }[]).map((x) => `${platform}:${x.account_id}`).sort()).toEqual(expectedOn)
        const r = await w.call(mcp.key, "ads_get_report", { platforms: [platform], level: "account", preset: "yesterday" }, { modern })
        expect(r.isError, r.text).toBe(false)
        expect(r.sc.row_count).toBe(expectedOn.length)
      }
      // the enabled-only rule also holds for a direct call to the switched-off account
      if (accounts.length > 1) {
        const r = await w.call(mcp.key, "ads_get_report", { platforms: [platform], account_ids: [off], level: "account", preset: "yesterday" })
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("account_not_in_scope")
      }

      // activity log: one connection.create + one mcp.create, no secrets
      const logs = await db.select().from(activityLogs).where(and(eq(activityLogs.actorId, actor.id), inArray(activityLogs.targetId, [id, mcp.id])))
      expect(logs.map((l) => l.action).sort()).toEqual(["connection.create", "mcp.create"])
      const blob = JSON.stringify(logs)
      expect(blob).not.toContain(token)
      expect(blob).not.toContain(mcp.key)
    })
  })

  // ---------------------------------------------------------------------------------------------
  it("key lifecycle: rotate kills the old link, disable/expire/delete answer 404 (never 401), enable revives", async () => {
    const actor = w.users.staff
    const conn = await w.connect(actor, "meta", demoAccounts(w.prefix, "meta"))
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    const status = async (key: string, modern = true) => {
      const { res } = await w.rpc(key, "tools/list", {}, { modern })
      expect(res.headers.get("www-authenticate")).toBeNull()
      return res.status
    }
    expect(await status(mcp.key)).toBe(200)
    expect(await status(mcp.key, false)).toBe(200)

    const rotated = await w.rotate(actor, mcp.id, async () => "ok")
    const newKey = rotated.url.slice(rotated.url.lastIndexOf("/mcp/") + 5)
    expect(newKey).not.toBe(mcp.key)
    expect(await status(mcp.key)).toBe(404) // immediately, no waiting for the grant cache
    expect(await status(newKey)).toBe(200)

    await w.setEnabled(actor, mcp.id, false)
    expect(await status(newKey)).toBe(404)
    expect(await status(newKey, false)).toBe(404)
    await w.setEnabled(actor, mcp.id, true)
    expect(await status(newKey)).toBe(200)

    await db.update(mcpServers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mcpServers.id, mcp.id))
    w.reset()
    expect(await status(newKey)).toBe(404)
    await db.update(mcpServers).set({ expiresAt: null }).where(eq(mcpServers.id, mcp.id))
    w.reset()
    expect(await status(newKey)).toBe(200)

    await w.removeMcp(actor, mcp.id, (await getMcpServer(actor, mcp.id))!.name)
    expect(await status(newKey)).toBe(404)
  })

  // ---------------------------------------------------------------------------------------------
  it("accounts found AFTER creation are disabled and invisible to an 'all accounts' MCP until enabled; missing accounts become closed", async () => {
    const actor = w.users.staff
    const base = demoAccounts(w.prefix, "meta")
    const conn = await w.connect(actor, "meta", base.slice(0, 2))
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    expect(await w.visibleAccounts(mcp.key)).toEqual(base.slice(0, 2).map((a) => `meta:${a.externalId}`).sort())

    // platform now also returns a third account and drops the first one
    w.setToken("meta", conn.token, { accounts: [base[1]!, base[2]!] })
    await w.sync(actor, conn.id)
    const rows = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, conn.id))
    const byExt = new Map(rows.map((r) => [r.externalId, r]))
    expect(byExt.get(base[2]!.externalId)!.isEnabled).toBe(false) // new → disabled
    expect(byExt.get(base[0]!.externalId)!.status).toBe("closed") // not returned → closed (never deleted)
    expect(byExt.get(base[0]!.externalId)!.statusRaw).toBe("not_returned")
    expect(byExt.get(base[1]!.externalId)!.isEnabled).toBe(true) // existing keeps its flag
    // no waiting for the 3 s grant cache: the new account must NOT be visible
    expect(await w.visibleAccounts(mcp.key)).not.toContain(`meta:${base[2]!.externalId}`)

    // user enables it on the connection page → visible immediately
    await w.toggle(actor, conn, [base[2]!.externalId], true)
    expect(await w.visibleAccounts(mcp.key)).toContain(`meta:${base[2]!.externalId}`)
    // and disabling takes effect immediately too
    await w.toggle(actor, conn, [base[2]!.externalId], false)
    expect(await w.visibleAccounts(mcp.key)).not.toContain(`meta:${base[2]!.externalId}`)
  })

  // ---------------------------------------------------------------------------------------------
  it("connection health: expiring / invalid / revoked / transient errors, and recovery by replacing the token", async () => {
    const actor = w.users.staff
    const accounts = demoAccounts(w.prefix, "openai_ads")
    const conn = await w.connect(actor, "openai_ads", accounts, { spec: { expiresAt: new Date(Date.now() + 3 * DAY) } })
    expect((await w.connRow(conn.id)).status).toBe("expiring")
    expect((await w.connRow(conn.id)).statusMessage).toMatch(/hết hạn/)
    const mcp = await w.mcp(actor, { platforms: { openai_ads: { permissions: ["read", "status"], connections: [{ conn }] } } })
    w.seedObjects(accounts[0]!.externalId, [{ id: "c1", level: "campaign", name: "C1", status: "active", parentId: null }])

    // expiring connections still work
    const ok = await w.call(mcp.key, "ads_list_objects", { platform: "openai_ads", account_id: accounts[0]!.externalId, level: "campaign" })
    expect(ok.isError, ok.text).toBe(false)

    // transient upstream error: status unchanged, message recorded
    w.setToken("openai_ads", conn.token, { transientError: true })
    const t = await w.test(actor, conn.id)
    expect(t.status).toBe("expiring")
    expect(t.statusMessage).toMatch(/Không kiểm tra được/) // what the button answers …
    expect((await w.connRow(conn.id)).statusMessage).toMatch(/hết hạn sau 3 ngày/) // … while the stored reason is kept

    // revoked token → invalid, and MCP calls fail fast with a Vietnamese auth message (accounts still listed)
    w.setToken("openai_ads", conn.token, { transientError: false, authError: true })
    const bad = await w.test(actor, conn.id)
    expect(bad.status).toBe("invalid")
    w.reset()
    const failed = await w.call(mcp.key, "ads_list_objects", { platform: "openai_ads", account_id: accounts[0]!.externalId, level: "campaign" })
    expect(failed.isError).toBe(true)
    expect(failed.sc.code).toBe("auth_invalid")
    expect(await w.visibleAccounts(mcp.key)).toHaveLength(accounts.length)

    // replace the token (re-auth done by the action): new valid token with an extra account → active again;
    // the new account stays disabled until enabled
    const extra = accountInfo(`${accounts[0]!.externalId}9`, { currency: "USD", timezone: "UTC" })
    const fresh = w.token("openai_ads", [...accounts, extra])
    const res = await w.replace(actor, { connectionId: conn.id, credentials: { token: fresh } })
    expect(res.status).toBe("active")
    const rows = await w.accountRows(conn.id)
    expect(rows.find((r) => r.externalId === extra.externalId)!.isEnabled).toBe(false)
    w.reset()
    const again = await w.call(mcp.key, "ads_list_objects", { platform: "openai_ads", account_id: accounts[0]!.externalId, level: "campaign" })
    expect(again.isError, again.text).toBe(false)
    // the connection never leaks the old or new token
    const row = await w.connRow(conn.id)
    expect(row.credentialsEncrypted).not.toContain(fresh)
    expect(row.credentialHint).toBe(`…${fresh.slice(-4)}`)
  })

  // ---------------------------------------------------------------------------------------------
  it("deleting a connection that an MCP uses: MCP survives but loses those accounts at once; saving a stale config is refused until pruned", async () => {
    const actor = w.users.staff
    const m = await w.connect(actor, "meta", demoAccounts(w.prefix, "meta"))
    const t = await w.connect(actor, "openai_ads", demoAccounts(w.prefix, "openai_ads"))
    const mcp = await w.mcp(actor, {
      platforms: {
        meta: { permissions: ["read", "status"], connections: [{ conn: m }] },
        openai_ads: { permissions: ["read"], connections: [{ conn: t }] },
      },
    })
    expect((await w.visibleAccounts(mcp.key)).length).toBe(4)
    const del = await w.removeConnection(actor, t.id)
    expect(del.affectedMcpIds).toContain(mcp.id)
    // credentials wiped, row soft-deleted
    const row = await w.connRow(t.id)
    expect(row.deletedAt).not.toBeNull()
    expect(row.credentialsEncrypted).not.toContain(t.token)
    // immediate effect on the endpoint
    expect((await w.visibleAccounts(mcp.key)).every((a) => a.startsWith("meta:"))).toBe(true)
    const detail = (await getMcpServer(actor, mcp.id))!
    expect(detail.config.find((p) => p.platform === "openai_ads")!.connections[0]!.connectionDeleted).toBe(true)

    // an editor that still sends the deleted connection is refused with a Vietnamese message …
    const stale = w.toInput({
      name: detail.name,
      platforms: {
        meta: { permissions: ["read", "status"], connections: [{ conn: m }] },
        openai_ads: { permissions: ["read"], connections: [{ conn: t }] },
      },
    })
    await expect(w.update(actor, { id: mcp.id, ...stale })).rejects.toThrow(/Kết nối không tồn tại/)
    // … and a pruned config saves
    const pruned = w.toInput({ name: detail.name, platforms: { meta: { permissions: ["read", "status"], connections: [{ conn: m }] } } })
    const r = await w.update(actor, { id: mcp.id, ...pruned })
    expect(r.changed).toBe(true)
    expect(Object.keys((await getMcpServer(actor, mcp.id))!.permissions)).toEqual(["meta"])
  })

  // ---------------------------------------------------------------------------------------------
  it("every mutation of the admin UI is effective on the very next request (grant cache invalidated)", async () => {
    const actor = w.users.staff
    const conn = await w.connect(actor, "meta", demoAccounts(w.prefix, "meta"))
    const [a1] = conn.accounts
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    // warm the cache
    expect((await w.tools(mcp.key)).names).not.toContain("ads_set_status")
    // 1) update config (permissions + scope)
    await w.update(actor, { id: mcp.id, ...w.toInput({ name: "renamed", platforms: { meta: { permissions: ["read", "status"], connections: [{ conn, accounts: [a1!.externalId] }] } } }) })
    expect((await w.tools(mcp.key)).names).toContain("ads_set_status")
    expect(await w.visibleAccounts(mcp.key)).toEqual([`meta:${a1!.externalId}`])
    // 2) disable an account that the MCP picks explicitly → vanishes at once; re-enable → back
    await w.toggle(actor, conn, [a1!.externalId], false)
    expect(await w.visibleAccounts(mcp.key)).toEqual([])
    await w.toggle(actor, conn, [a1!.externalId], true)
    expect(await w.visibleAccounts(mcp.key)).toEqual([`meta:${a1!.externalId}`])
    // 3) connection deleted → no accounts at once
    await w.removeConnection(actor, conn.id)
    expect(await w.visibleAccounts(mcp.key)).toEqual([])
  })

  // ---------------------------------------------------------------------------------------------
  it("activity log is written in the SAME transaction: a failing log rolls every mutation back", async () => {
    const actor = w.users.staff
    const accounts = demoAccounts(w.prefix, "meta")
    const conn = await w.connect(actor, "meta", accounts)
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    const target = accounts[0]!.externalId

    hoisted.failLog = true
    // toggle an account
    await expect(w.toggle(actor, conn, [target], false)).rejects.toThrow(/simulated/)
    expect((await w.accountRows(conn.id)).find((r) => r.externalId === target)!.isEnabled).toBe(true)
    // sync (add an account + drop one)
    w.setToken("meta", conn.token, { accounts: [accounts[1]!, accountInfo(`${target}_new`)] })
    await expect(w.sync(actor, conn.id)).rejects.toThrow(/simulated/)
    expect((await w.accountRows(conn.id)).map((r) => r.externalId).sort()).toEqual(accounts.map((a) => a.externalId).sort())
    const row = await w.connRow(conn.id)
    expect(row.status).toBe("active")
    // delete the connection
    await expect(w.removeConnection(actor, conn.id)).rejects.toThrow(/simulated/)
    expect((await w.connRow(conn.id)).deletedAt).toBeNull()
    expect((await w.connRow(conn.id)).credentialsEncrypted).toBe(row.credentialsEncrypted)
    // MCP mutations
    await expect(w.setEnabled(actor, mcp.id, false)).rejects.toThrow(/simulated/)
    await expect(w.rotate(actor, mcp.id, async () => "ok")).rejects.toThrow(/simulated/)
    // rename + token replacement of the connection
    const nameBefore = (await w.connRow(conn.id)).name
    await expect(w.rename(actor, { connectionId: conn.id, name: "renamed" })).rejects.toThrow(/simulated/)
    expect((await w.connRow(conn.id)).name).toBe(nameBefore)
    const fresh = w.token("meta", accounts)
    await expect(w.replace(actor, { connectionId: conn.id, credentials: { token: fresh } })).rejects.toThrow(/simulated/)
    expect((await w.connRow(conn.id)).credentialsEncrypted).toBe(row.credentialsEncrypted)
    // MCP update and delete
    const cfg = w.toInput({ name: "other name", platforms: { meta: { permissions: ["read", "delete"], connections: [{ conn }] } } })
    await expect(w.update(actor, { id: mcp.id, ...cfg })).rejects.toThrow(/simulated/)
    expect(Object.values((await getMcpServer(actor, mcp.id))!.permissions)[0]).toEqual(["read"])
    await expect(w.removeMcp(actor, mcp.id, (await getMcpServer(actor, mcp.id))!.name)).rejects.toThrow(/simulated/)
    expect(await getMcpServer(actor, mcp.id)).not.toBeNull()
    hoisted.failLog = false
    // still fully working with the original key
    expect((await w.tools(mcp.key)).status).toBe(200)
    expect(await w.visibleAccounts(mcp.key)).toHaveLength(accounts.length)
  })

  // ---------------------------------------------------------------------------------------------
  it("the same ad account reachable through two connections is listed once, counted once and uses the healthiest connection", async () => {
    const actor = w.users.staff
    const accs = demoAccounts(w.prefix, "meta")
    const c1 = await w.connect(actor, "meta", accs.slice(0, 2), { name: "token A" })
    const c2 = await w.connect(actor, "meta", accs.slice(1, 3), { name: "token B" })
    const shared = accs[1]!
    for (const a of accs) w.state.spend.set(a.externalId, 100)
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn: c1 }, { conn: c2 }] } } })

    const ids = await w.visibleAccounts(mcp.key)
    expect(ids).toEqual(accs.map((a) => `meta:${a.externalId}`).sort()) // three accounts, the shared one once
    const report = await w.call(mcp.key, "ads_get_report", { platforms: ["meta"], level: "account", preset: "yesterday" })
    expect(report.isError, report.text).toBe(false)
    expect(report.sc.row_count).toBe(3)
    const usd = (report.sc.totals_by_currency as { currency: string; metrics: { spend: number } }[]).find((t) => t.currency === "USD")!
    expect(usd.metrics.spend).toBe(100) // not 200

    // the oldest healthy connection serves the shared account …
    const tokenUsedFor = async () => {
      w.state.credentialsSeen.length = 0
      await w.call(mcp.key, "ads_get_report", { platforms: ["meta"], account_ids: [shared.externalId], level: "account", preset: "yesterday" })
      return (w.state.credentialsSeen.at(-1) as { token: string }).token
    }
    expect(await tokenUsedFor()).toBe(c1.token)
    // … until it breaks: then the other connection takes over
    await db.update(connections).set({ status: "invalid" }).where(eq(connections.id, c1.id))
    w.reset()
    expect(await tokenUsedFor()).toBe(c2.token)
    expect(await w.visibleAccounts(mcp.key)).toEqual(ids)
  })

  // ---------------------------------------------------------------------------------------------
  it("a connection with hundreds of accounts: ads_list_accounts pages (signed cursor, size budget) and nothing is lost or repeated", async () => {
    const actor = w.users.staff
    const many = Array.from({ length: 130 }, (_, i) => accountInfo(`${w.prefix}-mcc-${String(i).padStart(3, "0")}`, { name: `Khách hàng ${i} - một cái tên khá dài để kiểm tra giới hạn kích thước`, currency: i % 2 ? "USD" : "EUR", timezone: "Europe/Berlin" }))
    const conn = await w.connect(actor, "meta", many)
    const mcp = await w.mcp(actor, { platforms: { meta: { permissions: ["read", "status", "update", "copy", "create", "delete"], connections: [{ conn }] } } })
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = await w.call(mcp.key, "ads_list_accounts", cursor ? { cursor } : {})
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.total_accounts).toBe(130)
      expect((r.sc.platforms as { accounts: number }[])[0]!.accounts).toBe(130)
      expect(JSON.stringify(r.sc).length).toBeLessThan(24_000) // stays inside the result budget
      for (const a of r.sc.accounts as { account_id: string }[]) seen.push(a.account_id)
      expect(r.sc.has_more).toBe(r.sc.next_cursor !== null)
      cursor = (r.sc.next_cursor as string | null) ?? undefined
      pages++
    } while (cursor && pages < 20)
    expect(pages).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(130)
    expect(seen.length).toBe(130)
    // an explicit small limit, tampered / foreign cursors
    const first = await w.call(mcp.key, "ads_list_accounts", { limit: 10 })
    expect((first.sc.accounts as unknown[]).length).toBe(10)
    const cur = first.sc.next_cursor as string
    for (const bad of [cur.slice(0, -2) + "xx", "garbage"]) expect((await w.call(mcp.key, "ads_list_accounts", { limit: 10, cursor: bad })).sc.code).toBe("invalid_cursor")
    const other = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    expect((await w.call(other.key, "ads_list_accounts", { limit: 10, cursor: cur })).sc.code).toBe("invalid_cursor")
    // the cursor is bound to the filter: a different platform filter refuses it
    expect((await w.call(mcp.key, "ads_list_accounts", { limit: 10, cursor: cur, platform: "meta" })).sc.code).toBe("invalid_cursor")
  })

  // ---------------------------------------------------------------------------------------------
  it("no raw MCP key, token or secret ever reaches activity_logs or mcp_call_logs during a whole flow", async () => {
    const actor = w.users.staff
    const accounts = demoAccounts(w.prefix, "openai_ads")
    const conn = await w.connect(actor, "openai_ads", accounts)
    const mcp = await w.mcp(actor, { platforms: { openai_ads: { permissions: ["read", "update"], connections: [{ conn }] } } })
    const rotated = await w.rotate(actor, mcp.id, async () => "ok")
    const newKey = rotated.url.slice(rotated.url.lastIndexOf("/mcp/") + 5)
    for (const k of [newKey]) {
      await w.tools(k)
      await w.call(k, "ads_list_accounts", {})
      await w.call(k, "ads_get_report", { platforms: ["openai_ads"], level: "account", preset: "yesterday" })
    }
    await flushMcpLogs()
    const callLogs = JSON.stringify(await db.select().from(mcpCallLogs).where(eq(mcpCallLogs.mcpId, mcp.id)))
    const acts = JSON.stringify(await db.select().from(activityLogs).where(or(eq(activityLogs.actorId, actor.id), like(activityLogs.targetLabel, `${w.prefix}%`))))
    for (const secret of [mcp.key, newKey, conn.token]) {
      expect(callLogs).not.toContain(secret)
      expect(acts).not.toContain(secret)
    }
    // credentials reached the (fake) adapter, but only inside the request
    expect(w.state.credentialsSeen.length).toBeGreaterThan(0)
  })
})
