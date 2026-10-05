// Integration tests: real Request objects against serveMcp(), dev Postgres, fake providers.
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createMcp, createFixtures, cleanupFixtures, loadTestEnv, mcpRequest, modernMeta, readRpc, TEST_HOST } from "./helpers"
import { createFakeProvider, newFakeState, type FakeState } from "./fake-provider"

const hasDb = loadTestEnv()
process.env.APP_DOMAIN = TEST_HOST

type Fx = Awaited<ReturnType<typeof createFixtures>>

describe.skipIf(!hasDb)("MCP endpoint /mcp/<key> (integration)", { timeout: 120_000 }, () => {
  let fx: Fx
  let state: FakeState
  let serveMcp: typeof import("../serve").serveMcp
  let invalidateGrantCache: typeof import("../grant").invalidateGrantCache
  let resetRate: typeof import("../rate-limit").__resetRateLimits
  let flushMcpLogs: typeof import("../../audit/mcp-log-writer").flushMcpLogs
  let db: typeof import("../../db/client").db
  let schema: typeof import("../../db/schema")

  beforeAll(async () => {
    const registry = await import("../../providers/registry")
    state = newFakeState()
    registry.registerProvider(createFakeProvider("meta", state))
    registry.registerProvider(createFakeProvider("openai_ads", state))
    ;({ serveMcp } = await import("../serve"))
    ;({ invalidateGrantCache } = await import("../grant"))
    ;({ __resetRateLimits: resetRate } = await import("../rate-limit"))
    ;({ flushMcpLogs } = await import("../../audit/mcp-log-writer"))
    ;({ db } = await import("../../db/client"))
    schema = await import("../../db/schema")
    fx = await createFixtures()
    const { ext } = fx
    state.objects.set(ext.vnd, [
      { id: "c1", level: "campaign", name: "Chiến dịch 1", status: "active", parentId: null, budget: null },
      { id: "c2", level: "campaign", name: "Chiến dịch 2", status: "active", parentId: null, budget: null },
      { id: "c3", level: "campaign", name: "Chiến dịch 3", status: "paused", parentId: null, budget: null },
      { id: "g1", level: "ad_group", name: "Nhóm A", status: "active", parentId: "c1", budget: { type: "daily", amount: 100_000, level: "ad_group" } },
      { id: "g2", level: "ad_group", name: "Nhóm B", status: "active", parentId: "c1", budget: { type: "daily", amount: 100_000, level: "ad_group" } },
      { id: "a1", level: "ad", name: "QC 1", status: "active", parentId: "g1" },
    ])
    state.objects.set(ext.usd, [
      { id: "u1", level: "campaign", name: "US 1", status: "active", parentId: null },
      { id: "u2", level: "campaign", name: "US 2", status: "active", parentId: null },
    ])
    state.objects.set(ext.openai, [
      { id: "t1", level: "campaign", name: "TT 1", status: "active", parentId: null },
      { id: "t2", level: "campaign", name: "TT 2", status: "active", parentId: null },
      { id: "t3", level: "campaign", name: "TT 3", status: "active", parentId: null },
      { id: "t4", level: "campaign", name: "TT 4", status: "active", parentId: null },
    ])
    state.spend.set(ext.vnd, 500_000)
    state.spend.set(ext.usd, 12.5)
    state.spend.set(ext.openai, 250_000)
  }, 600_000)

  afterAll(async () => {
    if (!fx) return
    await flushMcpLogs()
    await cleanupFixtures(fx.f)
  }, 60_000)

  beforeEach(() => {
    resetRate()
    invalidateGrantCache()
  })

  // ---------------------------------------------------------------------------
  const send = (req: Request) => serveMcp(req, new URL(req.url).pathname.split("/").pop()!)

  async function rpc(key: string, method: string, params: Record<string, unknown> = {}, o: { modern?: boolean; headers?: Record<string, string> } = {}) {
    const modern = o.modern ?? true
    const body = { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params: modern ? { ...params, _meta: modernMeta() } : params }
    const res = await send(mcpRequest(key, body, { modern, headers: o.headers }))
    const msgs = res.status === 200 ? await readRpc(res) : []
    return { res, msg: msgs.find((m) => m.id === body.id) ?? msgs[0] }
  }

  async function tool(key: string, name: string, args: Record<string, unknown>, o: { modern?: boolean; headers?: Record<string, string> } = {}) {
    const { res, msg } = await rpc(key, "tools/call", { name, arguments: args }, o)
    expect(res.status).toBe(200)
    expect(msg?.error, JSON.stringify(msg?.error)).toBeUndefined()
    return { isError: Boolean(msg.result.isError), sc: msg.result.structuredContent as Record<string, any>, text: msg.result.content?.[0]?.text as string }
  }

  async function toolNames(key: string, modern = true) {
    const { msg } = await rpc(key, "tools/list", {}, { modern })
    return (msg.result.tools as { name: string }[]).map((t) => t.name)
  }

  const readOnlyMcp = () =>
    createMcp(fx.f, { ownerId: fx.ids.staff, permissions: { meta: ["read"], openai_ads: ["read"] }, scopes: [{ connectionId: fx.ids.connMeta }, { connectionId: fx.ids.connOpenai }] })

  const fullMcp = (settings: Record<string, unknown> = {}) =>
    createMcp(fx.f, {
      ownerId: fx.ids.staff,
      permissions: { meta: ["read", "status", "update", "copy", "create", "delete"], openai_ads: ["read", "status"] },
      scopes: [{ connectionId: fx.ids.connMeta }, { connectionId: fx.ids.connOpenai }],
      settings,
    })

  // ---------------------------------------------------------------------------
  describe("HTTP layer", () => {
    it("returns 404 (never 401) for unknown, malformed, disabled, expired, deleted and rotated keys", async () => {
      const unknown = "amcp_" + "A".repeat(43)
      for (const key of [unknown, "not-a-key", "amcp_short"]) {
        const res = await send(mcpRequest(key, { jsonrpc: "2.0", id: 1, method: "tools/list" }))
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: "not_found" })
        expect(res.headers.get("www-authenticate")).toBeNull()
      }
      const disabled = await createMcp(fx.f, { ownerId: fx.ids.staff, permissions: { meta: ["read"] }, scopes: [{ connectionId: fx.ids.connMeta }], status: "disabled" })
      const expired = await createMcp(fx.f, { ownerId: fx.ids.staff, permissions: { meta: ["read"] }, scopes: [{ connectionId: fx.ids.connMeta }], expiresAt: new Date(Date.now() - 60_000) })
      const deleted = await createMcp(fx.f, { ownerId: fx.ids.staff, permissions: { meta: ["read"] }, scopes: [{ connectionId: fx.ids.connMeta }], deletedAt: new Date() })
      const bannedOwner = await createMcp(fx.f, { ownerId: fx.ids.banned, permissions: { meta: ["read"] }, scopes: [{ connectionId: fx.ids.connBanned }] })
      for (const m of [disabled, expired, deleted, bannedOwner]) {
        const res = await send(mcpRequest(m.key, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } }, { modern: true }))
        expect(res.status).toBe(404)
      }

      // rotation: old key dies immediately once the hash changes
      const live = await readOnlyMcp()
      expect((await rpc(live.key, "tools/list")).res.status).toBe(200)
      const { generateMcpKey, hashMcpKey } = await import("../../crypto/mcp-key")
      const newKey = generateMcpKey()
      await db.update(schema.mcpServers).set({ keyHash: hashMcpKey(newKey) }).where(eq(schema.mcpServers.id, live.id))
      invalidateGrantCache(live.id)
      expect((await rpc(live.key, "tools/list")).res.status).toBe(404)
      expect((await rpc(newKey, "tools/list")).res.status).toBe(200)
    })

    it("rejects foreign Host and browser Origin with 403", async () => {
      const m = await readOnlyMcp()
      const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } }
      expect((await send(mcpRequest(m.key, body, { modern: true, host: "evil.example.com" }))).status).toBe(403)
      expect((await send(mcpRequest(m.key, body, { modern: true, headers: { origin: "https://evil.example.com" } }))).status).toBe(403)
      expect((await send(mcpRequest(m.key, body, { modern: true, headers: { origin: `https://${TEST_HOST}` } }))).status).toBe(200)
    })

    it("serves a small Vietnamese HTML page to browsers", async () => {
      const m = await readOnlyMcp()
      const res = await send(mcpRequest(m.key, null, { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } }))
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("Đây là endpoint MCP")
      expect(html).not.toContain(m.key)
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    })

    it("applies the per-MCP rate limit (429 + Retry-After)", async () => {
      const m = await createMcp(fx.f, {
        ownerId: fx.ids.staff,
        permissions: { meta: ["read"] },
        scopes: [{ connectionId: fx.ids.connMeta }],
        settings: { rate_limit_per_min: 3 },
      })
      for (let i = 0; i < 3; i++) expect((await rpc(m.key, "tools/list")).res.status).toBe(200)
      const r = await rpc(m.key, "tools/list")
      expect(r.res.status).toBe(429)
      expect(Number(r.res.headers.get("retry-after"))).toBeGreaterThan(0)
    })

    it("limits key guessing per IP", async () => {
      const ip = "203.0.113.77"
      for (let i = 0; i < 20; i++) {
        const res = await send(mcpRequest("amcp_" + "B".repeat(43), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": ip } }))
        expect(res.status).toBe(404)
      }
      const res = await send(mcpRequest("amcp_" + "B".repeat(43), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": ip } }))
      expect(res.status).toBe(429)
    })

    it("never blocks a valid key from an IP (or IPv6 /64) that hit the 404 limit", async () => {
      const m = await readOnlyMcp()
      for (const ip of ["203.0.113.78", "2001:db8:77:1::5"]) {
        for (let i = 0; i < 25; i++) {
          await send(mcpRequest("amcp_" + "C".repeat(43), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": ip } }))
        }
        const guess = await send(mcpRequest("amcp_" + "C".repeat(43), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": ip } }))
        expect(guess.status).toBe(429)
        // same client, valid key: served - also when its grant is not cached (restart / idle) and guessing goes on
        invalidateGrantCache(m.id)
        for (let i = 0; i < 10; i++) {
          await send(mcpRequest(`amcp_${"G".repeat(41)}${String(i).padStart(2, "0")}`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": ip } }))
        }
        expect((await rpc(m.key, "tools/list", {}, { headers: { "x-forwarded-for": ip } })).res.status).toBe(200)
      }
      // another address of the same IPv6 /64 is limited for unknown keys too
      const sibling = await send(mcpRequest("amcp_" + "C".repeat(43), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": "2001:db8:77:1::ffff" } }))
      expect(sibling.status).toBe(429)
    })

    it("L5: a repeated unknown key is answered from the miss cache (one database lookup)", async () => {
      const { __grantDbLookups } = await import("../grant")
      const before = __grantDbLookups()
      const key = "amcp_" + "D".repeat(43)
      for (let i = 0; i < 4; i++) {
        const res = await send(mcpRequest(key, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": "203.0.113.90" } }))
        expect(res.status).toBe(404)
      }
      expect(__grantDbLookups() - before).toBe(1)
      // invalidating the grant cache (MCP re-enabled / edited) forgets the misses too
      invalidateGrantCache("any-mcp-id")
      expect((await send(mcpRequest(key, { jsonrpc: "2.0", id: 1, method: "tools/list" }))).status).toBe(404)
      expect(__grantDbLookups() - before).toBe(2)
    })

    it("L5: a blocked client is answered from the in-memory active-key set: unknown keys cost no query, valid keys are always served", async () => {
      const ip = "203.0.113.91"
      const m = await readOnlyMcp()
      const disabled = await createMcp(fx.f, { ownerId: fx.ids.staff, permissions: { meta: ["read"] }, scopes: [{ connectionId: fx.ids.connMeta }], status: "disabled" })
      const call = (key: string) => send(mcpRequest(key, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "x-forwarded-for": ip } }))
      for (let i = 0; i < 20; i++) expect((await call("amcp_" + "E".repeat(43))).status).toBe(404)
      const { __grantDbLookups } = await import("../grant")
      const before = __grantDbLookups()
      // a guesser far above 1 request/s: distinct unknown keys → 429, one active-key set load in total
      for (let i = 0; i < 30; i++) expect((await call(`amcp_${"F".repeat(41)}${String(i).padStart(2, "0")}`)).status).toBe(429)
      expect(__grantDbLookups() - before).toBe(1)
      // a disabled MCP's key is refused like an unknown key (no lookup)
      expect((await call(disabled.key)).status).toBe(429)
      expect(__grantDbLookups() - before).toBe(1)
      // a never-used valid key (in no grant cache) from the same blocked client, right after the burst: served
      expect((await rpc(m.key, "tools/list", {}, { headers: { "x-forwarded-for": ip } })).res.status).toBe(200)
      // a key created after the set was loaded works at once (create / enable / rotate call invalidateGrantCache)
      const fresh = await readOnlyMcp()
      invalidateGrantCache(fresh.id)
      expect((await rpc(fresh.key, "tools/list", {}, { headers: { "x-forwarded-for": ip } })).res.status).toBe(200)
    })

    it("L9: arguments of a tools/call rejected by the SDK are logged without URL query strings", async () => {
      const m = await fullMcp()
      const signed = "https://bucket.s3.amazonaws.com/ads/banner.jpg?X-Amz-Signature=deadbeef42&X-Amz-Credential=AKIAEXAMPLE"
      const { res } = await rpc(m.key, "tools/call", {
        name: "ads_upload_media",
        arguments: { platform: "meta", account_id: fx.ext.vnd, type: "gif", url: signed, extra: { link: "https://shop.vn/?utm_source=fb" } },
      })
      expect(res.status).toBe(200)
      let row: typeof schema.mcpCallLogs.$inferSelect | undefined
      for (let i = 0; i < 60 && !row; i++) {
        await flushMcpLogs()
        row = (await db.select().from(schema.mcpCallLogs).where(eq(schema.mcpCallLogs.mcpId, m.id))).find(
          (r) => r.toolName === "ads_upload_media"
        )
        if (!row) await new Promise((r) => setTimeout(r, 50))
      }
      expect(row?.status).toBe("invalid_request")
      expect((row!.request as any).url).toBe("https://bucket.s3.amazonaws.com/ads/banner.jpg?[redacted]")
      expect((row!.request as any).extra.link).toBe("https://shop.vn/?[redacted]")
      expect(JSON.stringify(row!.request)).not.toContain("deadbeef42")
    })

    it("charges a JSON-RPC batch per message", async () => {
      const m = await createMcp(fx.f, {
        ownerId: fx.ids.staff,
        permissions: { meta: ["read"] },
        scopes: [{ connectionId: fx.ids.connMeta }],
        settings: { rate_limit_per_min: 5 },
      })
      const batch = Array.from({ length: 6 }, (_, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: { name: "ads_list_accounts", arguments: {}, _meta: modernMeta() },
      }))
      const res = await send(mcpRequest(m.key, batch, { modern: true, headers: { "mcp-method": "tools/call" } }))
      expect(res.status).toBe(429)
      // the bucket is not drained by the refused batch beyond its first message
      expect((await rpc(m.key, "tools/list")).res.status).toBe(200)
    })

    it("enforces the IP allowlist (CIDR)", async () => {
      const m = await createMcp(fx.f, {
        ownerId: fx.ids.staff,
        permissions: { meta: ["read"] },
        scopes: [{ connectionId: fx.ids.connMeta }],
        settings: { allowed_ips: ["10.0.0.0/8", "2001:db8::/32"] },
      })
      expect((await rpc(m.key, "tools/list", {}, { headers: { "x-forwarded-for": "1.2.3.4" } })).res.status).toBe(403)
      expect((await rpc(m.key, "tools/list", {}, { headers: { "x-forwarded-for": "10.9.8.7, 172.16.0.1" } })).res.status).toBe(200)
      expect((await rpc(m.key, "tools/list", {}, { headers: { "x-forwarded-for": "2001:db8::42" } })).res.status).toBe(200)
    })
  })

  // ---------------------------------------------------------------------------
  describe("protocol eras", () => {
    it("serves a 2025-era initialize handshake statelessly and a 2026-07-28 tools/list", async () => {
      const m = await readOnlyMcp()
      const init = await send(
        mcpRequest(m.key, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest-legacy", version: "0.9" } },
        })
      )
      expect(init.status).toBe(200)
      const [initMsg] = await readRpc(init)
      expect(initMsg.result.serverInfo.name).toBe("ads-mcp-noti")
      expect(initMsg.result.instructions).toContain("ads_list_accounts")
      const legacyList = await toolNames(m.key, false)
      expect(legacyList).toContain("ads_list_accounts")
      const modernList = await toolNames(m.key, true)
      expect(modernList).toEqual(legacyList)
    })
  })

  // ---------------------------------------------------------------------------
  describe("tool catalogue per grant", () => {
    it("read-only MCP exposes no write tools", async () => {
      const m = await readOnlyMcp()
      const names = await toolNames(m.key)
      expect(names).toEqual(expect.arrayContaining(["ads_list_accounts", "ads_get_report", "ads_list_objects", "ads_get_object", "ads_lookup", "meta_fake_insight", "openai_ads_fake_insight"]))
      for (const w of ["ads_set_status", "ads_update_budget", "ads_update_object", "ads_copy_object", "ads_upload_media", "ads_delete_object", "meta_fake_create_campaign"]) {
        expect(names).not.toContain(w)
      }
    })

    it("full MCP exposes write tools in deterministic order with correct annotations", async () => {
      const m = await fullMcp()
      const { msg } = await rpc(m.key, "tools/list")
      const tools = msg.result.tools as { name: string; annotations: Record<string, boolean>; inputSchema: any; outputSchema: any; title: string; description: string }[]
      const names = tools.map((t) => t.name)
      expect(names.slice(0, 11)).toEqual([
        "ads_list_accounts",
        "ads_get_report",
        "ads_list_objects",
        "ads_get_object",
        "ads_lookup",
        "ads_set_status",
        "ads_update_budget",
        "ads_update_object",
        "ads_copy_object",
        "ads_upload_media",
        "ads_delete_object",
      ])
      expect(names).toContain("meta_fake_create_campaign")
      expect(names).not.toContain("openai_ads_fake_create_campaign") // openai_ads has no create permission
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
      expect(byName.ads_get_report.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(byName.ads_set_status.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true })
      expect(byName.ads_copy_object.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false })
      // platform enum limited per permission
      expect(byName.ads_update_budget.inputSchema.properties.platform.enum).toEqual(["meta"])
      expect(byName.ads_set_status.inputSchema.properties.platform.enum).toEqual(["meta", "openai_ads"])
      for (const t of tools) {
        expect(t.name).toMatch(/^[a-z0-9_]{1,40}$/)
        expect(t.description.startsWith("Dùng khi")).toBe(true)
        expect(t.outputSchema.type).toBe("object")
        expect(t.title.length).toBeGreaterThan(0)
      }
    })

    it("staff MCP never reaches another user's connection even with a scope row", async () => {
      const m = await createMcp(fx.f, {
        ownerId: fx.ids.staff,
        permissions: { meta: ["read"] },
        scopes: [{ connectionId: fx.ids.connMeta }, { connectionId: fx.ids.connOther }, { connectionId: fx.ids.connDisabled }],
      })
      const r = await tool(m.key, "ads_list_accounts", {})
      const ids = r.sc.accounts.map((a: any) => a.account_id)
      expect(ids).toEqual(expect.arrayContaining([fx.ext.vnd, fx.ext.usd]))
      expect(ids).not.toContain(fx.ext.other)
      expect(ids).not.toContain(fx.ext.off) // disabled account
      expect(ids).not.toContain(fx.ext.disabledConn) // disabled connection
      const denied = await tool(m.key, "ads_get_report", { account_ids: [fx.ext.other], preset: "yesterday" })
      expect(denied.isError).toBe(true)
      expect(denied.sc.code).toBe("account_not_in_scope")
      // admin-owned MCP may include other users' connections
      const adminMcp = await createMcp(fx.f, { ownerId: fx.ids.admin, permissions: { meta: ["read"] }, scopes: [{ connectionId: fx.ids.connOther }] })
      const r2 = await tool(adminMcp.key, "ads_list_accounts", {})
      expect(r2.sc.accounts.map((a: any) => a.account_id)).toEqual([fx.ext.other])
    })

    it("assertGrant rejects a foreign account_id inside every tool", async () => {
      const m = await fullMcp()
      for (const [name, args] of [
        ["ads_list_objects", { platform: "meta", account_id: fx.ext.other, level: "campaign" }],
        ["ads_get_object", { platform: "meta", account_id: fx.ext.other, level: "campaign", id: "c1" }],
        ["ads_set_status", { platform: "meta", account_id: fx.ext.other, level: "campaign", ids: ["c1"], status: "paused" }],
        ["meta_fake_insight", { account_id: fx.ext.other, topic: "x" }],
        ["ads_list_objects", { platform: "openai_ads", account_id: fx.ext.vnd, level: "campaign" }], // wrong platform
      ] as const) {
        const r = await tool(m.key, name, args)
        expect(r.isError, name).toBe(true)
        expect(r.sc.code).toBe("account_not_in_scope")
      }
      expect(state.executions.filter((e) => e.account === fx.ext.other)).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  describe("ads_get_report", () => {
    it("fans out across platforms/accounts and totals per currency (no cross-currency sum)", async () => {
      const m = await readOnlyMcp()
      const r = await tool(m.key, "ads_get_report", { level: "account", preset: "yesterday" })
      expect(r.isError).toBe(false)
      expect(r.sc.rows).toHaveLength(3)
      const totals = Object.fromEntries(r.sc.totals_by_currency.map((t: any) => [t.currency, t.metrics.spend]))
      expect(totals).toEqual({ USD: 12.5, VND: 750_000 })
      expect(r.sc.totals_scope).toBe("all")
      // dates resolved per account time zone
      const { resolvePreset } = await import("../../providers/dates")
      for (const a of r.sc.accounts) {
        const tz = a.timezone as string
        expect({ from: a.date_from, to: a.date_to }).toEqual(resolvePreset("yesterday", tz))
      }
      expect(r.text).toMatch(/^Báo cáo 3 dòng/)
    })

    it("paginates with an opaque cursor across the fan-out without duplicates", async () => {
      const m = await readOnlyMcp()
      const seen: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 10; i++) {
        const r = await tool(m.key, "ads_get_report", { level: "campaign", preset: "last_7d", limit: 4, ...(cursor ? { cursor } : {}) })
        expect(r.isError).toBe(false)
        seen.push(...r.sc.rows.map((x: any) => `${x.account_id}:${x.campaign_id}`))
        cursor = r.sc.next_cursor ?? undefined
        if (!cursor) break
      }
      expect(seen).toHaveLength(3 + 2 + 4)
      expect(new Set(seen).size).toBe(9)
      // cursor bound to the query
      const first = await tool(m.key, "ads_get_report", { level: "campaign", preset: "last_7d", limit: 2 })
      const bad = await tool(m.key, "ads_get_report", { level: "campaign", preset: "yesterday", limit: 2, cursor: first.sc.next_cursor })
      expect(bad.isError).toBe(true)
      expect(bad.sc.code).toBe("invalid_cursor")
    })

    it("H2: tampered cursors and cursors of another MCP are rejected as tool errors", async () => {
      const m = await readOnlyMcp()
      const first = await tool(m.key, "ads_get_report", { level: "campaign", preset: "last_7d", limit: 2 })
      const cursor = first.sc.next_cursor as string
      expect(cursor).toContain(".")
      const [, sig] = cursor.split(".")
      // forge a payload pointing at another fan-out position / adapter cursor, keep the old signature
      const forged = `${Buffer.from(JSON.stringify({ m: "q", i: 0, c: "999", s: 0, p: 2 })).toString("base64url")}.${sig}`
      const tampered = await tool(m.key, "ads_get_report", { level: "campaign", preset: "last_7d", limit: 2, cursor: forged })
      expect(tampered.isError).toBe(true)
      expect(tampered.sc.code).toBe("invalid_cursor")
      // same query on another MCP (same accounts): not accepted
      const m2 = await readOnlyMcp()
      const foreign = await tool(m2.key, "ads_get_report", { level: "campaign", preset: "last_7d", limit: 2, cursor })
      expect(foreign.sc.code).toBe("invalid_cursor")
      // ads_list_objects cursors are signed too
      const lo = await tool(m.key, "ads_list_objects", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", limit: 1 })
      const loForged = `${Buffer.from(JSON.stringify({ c: "0", s: 0, p: 1 })).toString("base64url")}.${String(lo.sc.next_cursor).split(".")[1]}`
      expect((await tool(m.key, "ads_list_objects", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", limit: 1, cursor: loForged })).sc.code).toBe(
        "invalid_cursor"
      )
      expect((await tool(m.key, "ads_list_objects", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", limit: 1, cursor: lo.sc.next_cursor })).isError).toBe(false)
    })

    it("sorts globally and filters by min_spend", async () => {
      const m = await readOnlyMcp()
      const r = await tool(m.key, "ads_get_report", { level: "campaign", preset: "yesterday", sort_by: "spend", filters: { min_spend: 300 }, limit: 50 })
      const spends = r.sc.rows.map((x: any) => x.metrics.spend)
      expect(spends).toEqual([...spends].sort((a: number, b: number) => b - a))
      expect(Math.min(...spends)).toBeGreaterThanOrEqual(300)
    })

    it("reports per-account upstream errors without failing the whole call", async () => {
      const m = await readOnlyMcp()
      state.failingAccounts.add(fx.ext.usd)
      try {
        const r = await tool(m.key, "ads_get_report", { level: "account", preset: "yesterday" })
        expect(r.isError).toBe(false)
        expect(r.sc.rows).toHaveLength(2)
        expect(r.sc.errors[0]).toMatchObject({ account_id: fx.ext.usd, code: "permission_denied" })
        expect(r.sc.errors[0].platform_error.request_id).toBe("up-err-1")
      } finally {
        state.failingAccounts.delete(fx.ext.usd)
      }
    })
  })

  // ---------------------------------------------------------------------------
  describe("writes", () => {
    it("two-step confirmation: preview → confirm executes once → replay returns the stored result", async () => {
      const m = await fullMcp()
      const args = { platform: "meta", account_id: fx.ext.vnd, level: "campaign", ids: ["c2"], status: "paused" }
      const before = state.executions.length
      const p = await tool(m.key, "ads_set_status", args)
      expect(p.isError).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect(p.sc.preview.changes[0]).toMatchObject({ object_id: "c2", field: "status", before: "active", after: "paused" })
      expect(p.sc.confirm_token).toMatch(/^ct_/)
      expect(state.executions.length).toBe(before)

      // wrong args with this token
      const wrong = await tool(m.key, "ads_set_status", { ...args, status: "active", confirm_token: p.sc.confirm_token })
      expect(wrong.sc.code).toBe("confirm_args_mismatch")
      // token is bound to the tool
      const otherTool = await tool(m.key, "ads_delete_object", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "c2", confirm_token: p.sc.confirm_token })
      expect(otherTool.sc.code).toBe("confirm_token_invalid")

      const ok = await tool(m.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token, reason: "test" })
      expect(ok.isError).toBe(false)
      expect(ok.sc).toMatchObject({ status: "success", replayed: false })
      expect(state.executions.length).toBe(before + 1)

      const replay = await tool(m.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      expect(replay.sc).toMatchObject({ status: "success", replayed: true })
      expect(state.executions.length).toBe(before + 1)

      // token of another MCP is invalid here
      const m2 = await fullMcp()
      const foreign = await tool(m2.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      expect(foreign.sc.code).toBe("confirm_token_invalid")
    })

    it("rejects expired tokens", async () => {
      const m = await fullMcp()
      const args = { platform: "meta", account_id: fx.ext.vnd, level: "campaign", ids: ["c3"], status: "active" }
      const p = await tool(m.key, "ads_set_status", args)
      await db
        .update(schema.mcpPendingActions)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(schema.mcpPendingActions.mcpId, m.id))
      const r = await tool(m.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("confirm_token_expired")
      const rows = await db.select().from(schema.mcpPendingActions).where(eq(schema.mcpPendingActions.mcpId, m.id))
      expect(rows[0]!.status).toBe("expired")
      expect(JSON.stringify(rows[0]!.args)).not.toContain(p.sc.confirm_token)
      expect(rows[0]!.tokenHash).not.toBe(p.sc.confirm_token)
    })

    it("executes directly when two-step is off, but delete always confirms", async () => {
      const m = await fullMcp({ two_step_confirm: false })
      const before = state.executions.length
      const r = await tool(m.key, "ads_update_object", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "c3", name: "Đổi tên" })
      expect(r.sc.status).toBe("success")
      expect(state.executions.length).toBe(before + 1)
      const d = await tool(m.key, "ads_delete_object", { platform: "meta", account_id: fx.ext.vnd, level: "ad", id: "a1" })
      expect(d.sc.status).toBe("confirmation_required")
      expect(state.executions.length).toBe(before + 1)
      const d2 = await tool(m.key, "ads_delete_object", { platform: "meta", account_id: fx.ext.vnd, level: "ad", id: "a1", confirm_token: d.sc.confirm_token })
      expect(d2.sc.status).toBe("success")
      expect(state.executions.at(-1)!.op).toBe("delete")
    })

    it("budget guardrails: max % change and daily cap per currency", async () => {
      const m = await fullMcp({ budget_change_max_pct: 50, max_daily_budget: { VND: 130_000 } })
      const base = { platform: "meta", account_id: fx.ext.vnd, level: "ad_group", id: "g2", budget_type: "daily" }
      const tooMuch = await tool(m.key, "ads_update_budget", { ...base, amount: 200_000 })
      expect(tooMuch.isError).toBe(true)
      expect(tooMuch.sc.code).toBe("budget_change_too_large")
      const overCap = await tool(m.key, "ads_update_budget", { ...base, amount: 140_000 })
      expect(overCap.sc.code).toBe("budget_cap_exceeded")
      const ok = await tool(m.key, "ads_update_budget", { ...base, amount: 120_000 })
      expect(ok.sc.status).toBe("confirmation_required")
      expect(ok.sc.preview.warnings[0]).toMatch(/tăng 20/)
      const done = await tool(m.key, "ads_update_budget", { ...base, amount: 120_000, confirm_token: ok.sc.confirm_token })
      expect(done.sc.status).toBe("success")
      expect(done.sc.result).toMatchObject({ before: 100_000, after: 120_000, currency: "VND" })
    })

    it("write extensions go through dry-run preview then execute", async () => {
      const m = await fullMcp()
      const p = await tool(m.key, "meta_fake_create_campaign", { account_id: fx.ext.vnd, name: "Mới" })
      expect(p.sc.status).toBe("confirmation_required")
      const ok = await tool(m.key, "meta_fake_create_campaign", { account_id: fx.ext.vnd, name: "Mới", confirm_token: p.sc.confirm_token })
      expect(ok.sc.status).toBe("success")
      expect(ok.sc.result).toEqual({ created_ids: ["cmp_new_1"] })
    })

    it("ads_upload_media refuses internal URLs (SSRF)", async () => {
      const m = await fullMcp()
      for (const url of ["http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1/x.png", "http://[::1]/x.png"]) {
        const r = await tool(m.key, "ads_upload_media", { platform: "meta", account_id: fx.ext.vnd, type: "image", url })
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("url_not_allowed")
      }
    })
  })

  // ---------------------------------------------------------------------------
  describe("call logs", () => {
    it("writes redacted rows for protocol and tool calls (no raw key, no secrets)", async () => {
      const m = await fullMcp()
      await send(
        mcpRequest(m.key, {
          jsonrpc: "2.0",
          id: 7,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1.0" } },
        })
      )
      await rpc(m.key, "tools/list")
      const p = await tool(m.key, "ads_set_status", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", ids: ["c1"], status: "paused" })
      await tool(m.key, "ads_set_status", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", ids: ["c1"], status: "paused", confirm_token: p.sc.confirm_token })
      await tool(m.key, "ads_list_objects", { platform: "meta", account_id: fx.ext.other, level: "campaign" })
      // SDK-level input validation failure (handler never runs) is still logged
      await rpc(m.key, "tools/call", { name: "ads_set_status", arguments: { platform: "meta" } })
      // the protocol-level row of the rejected tools/call is written after the response left: poll instead of a fixed sleep
      let rows: (typeof schema.mcpCallLogs.$inferSelect)[] = []
      for (let i = 0; i < 60; i++) {
        await flushMcpLogs()
        rows = await db.select().from(schema.mcpCallLogs).where(and(eq(schema.mcpCallLogs.mcpId, m.id)))
        if (rows.some((r) => r.toolName === "ads_set_status" && r.status === "invalid_request")) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const dump = JSON.stringify(rows)
      expect(dump).not.toContain(m.key)
      expect(dump).not.toContain(p.sc.confirm_token)
      expect(dump).not.toContain("secret-")

      const init = rows.find((r) => r.method === "initialize")!
      expect(init).toMatchObject({ status: "success", clientName: "claude-ai", clientVersion: "1.0", actionKind: "protocol", protocolVersion: "2025-06-18" })
      const list = rows.find((r) => r.method === "tools/list")!
      expect(list.clientName).toBe("vitest-modern")
      expect((list.response as any).tools).toContain("ads_set_status")

      const statusRows = rows.filter((r) => r.toolName === "ads_set_status")
      const pending = statusRows.find((r) => r.status === "pending_confirmation")!
      expect(pending.pendingActionId).toBeTruthy()
      expect(pending).toMatchObject({ platform: "meta", adAccountId: fx.ext.vnd, actionKind: "write", objectIds: ["c1"] })
      const success = statusRows.find((r) => r.status === "success")!
      expect(success.changes).toEqual([{ object_id: "c1", object_name: "Chiến dịch 1", level: "campaign", field: "status", before: "active", after: "paused" }])
      expect(success.upstreamRequestIds?.[0]).toMatch(/^req-set_status/)
      expect((success.request as any).confirm_token).toBe("[redacted]")
      expect(statusRows.find((r) => r.status === "invalid_request")).toBeTruthy()

      const deniedRow = rows.find((r) => r.toolName === "ads_list_objects")!
      expect(deniedRow).toMatchObject({ status: "denied", errorCode: "account_not_in_scope" })
    })
  })

  // ---------------------------------------------------------------------------
  describe("security-review fixes", () => {
    const addObjects = (account: string, objs: FakeState["objects"] extends Map<string, infer V> ? V : never) => {
      const list = state.objects.get(account) ?? []
      state.objects.set(account, [...list.filter((o) => !objs.some((x) => x.id === o.id)), ...objs])
    }

    it("H1: create extensions are held to the daily / lifetime / bid caps before any preview", async () => {
      const m = await fullMcp({ max_daily_budget: { VND: 1_000_000 }, max_bid: { VND: 50_000 } })
      const before = state.executions.length
      const call = (args: Record<string, unknown>) => tool(m.key, "meta_fake_create_adgroup", { account_id: fx.ext.vnd, name: "N", ...args })

      expect((await call({ daily_budget: 2_000_000 })).sc.code).toBe("budget_cap_exceeded")
      // lifetime without end: 30 × daily cap
      expect((await call({ lifetime_budget: 40_000_000 })).sc.code).toBe("budget_cap_exceeded")
      // lifetime with a ~3-day flight: 3 × daily cap
      const end = new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString()
      const tooLong = await call({ lifetime_budget: 5_000_000, end_time: end })
      expect(tooLong.sc.code).toBe("budget_cap_exceeded")
      expect(tooLong.sc.message).toMatch(/3 ngày/)
      expect((await call({ bid: 60_000 })).sc.code).toBe("bid_cap_exceeded")
      // undeclared money fields fail closed
      const undeclared = await tool(m.key, "meta_fake_undeclared_money", { account_id: fx.ext.vnd, name: "x", budget: 1 })
      expect(undeclared.sc.code).toBe("money_fields_undeclared")
      expect(state.executions.length).toBe(before)
      const rows = await db.select().from(schema.mcpPendingActions).where(eq(schema.mcpPendingActions.mcpId, m.id))
      expect(rows).toHaveLength(0)

      const ok = await call({ daily_budget: 900_000, bid: 40_000 })
      expect(ok.sc.status).toBe("confirmation_required")
      const ok2 = await call({ lifetime_budget: 2_500_000, end_time: end })
      expect(ok2.sc.status).toBe("confirmation_required")
    })

    it("H1: activation checks the governing (campaign/CBO) budget against the cap; pausing does not", async () => {
      addObjects(fx.ext.vnd, [
        { id: "c9", level: "campaign", name: "CBO lớn", status: "paused", parentId: null, budget: { type: "daily", amount: 5_000_000, level: "campaign" } },
        { id: "g9", level: "ad_group", name: "Nhóm CBO", status: "paused", parentId: "c9", budget: null },
        { id: "a9", level: "ad", name: "QC CBO", status: "paused", parentId: "g9" },
        { id: "c10", level: "campaign", name: "Nhỏ", status: "paused", parentId: null, budget: { type: "lifetime", amount: 50_000_000, level: "campaign" } },
      ])
      const m = await fullMcp({ max_daily_budget: { VND: 1_000_000 } })
      const act = (level: string, ids: string[], status = "active") =>
        tool(m.key, "ads_set_status", { platform: "meta", account_id: fx.ext.vnd, level, ids, status })
      for (const [level, id] of [["ad", "a9"], ["ad_group", "g9"], ["campaign", "c9"]] as const) {
        const r = await act(level, [id])
        expect(r.isError, `${level} ${id}`).toBe(true)
        expect(r.sc.code).toBe("budget_cap_exceeded")
        expect(r.sc.message).toMatch(/c9/)
      }
      // lifetime 50M with unknown end > 30 × 1M
      expect((await act("campaign", ["c10"])).sc.code).toBe("budget_cap_exceeded")
      // within the cap / pausing: allowed
      expect((await act("ad_group", ["g2"])).sc.status).toBe("confirmation_required")
      expect((await act("campaign", ["c9"], "paused")).sc.status).toBe("confirmation_required")
      // no cap configured → no reads, no refusal
      const free = await fullMcp()
      expect((await tool(free.key, "ads_set_status", { platform: "meta", account_id: fx.ext.vnd, level: "ad", ids: ["a9"], status: "active" })).sc.status).toBe(
        "confirmation_required"
      )
    })

    it("H1: ads_update_object respects max_bid", async () => {
      const m = await fullMcp({ max_bid: { VND: 10_000 } })
      const r = await tool(m.key, "ads_update_object", { platform: "meta", account_id: fx.ext.vnd, level: "ad_group", id: "g1", bid_amount: 20_000 })
      expect(r.sc.code).toBe("bid_cap_exceeded")
      expect((await tool(m.key, "ads_update_object", { platform: "meta", account_id: fx.ext.vnd, level: "ad_group", id: "g1", bid_amount: 9_000 })).sc.status).toBe(
        "confirmation_required"
      )
    })

    it("M5: cumulative ±% within 24 h from the earliest value (no salami stepping)", async () => {
      addObjects(fx.ext.vnd, [{ id: "g20", level: "ad_group", name: "Bậc thang", status: "active", parentId: "c1", budget: { type: "daily", amount: 100_000, level: "ad_group" } }])
      const m = await fullMcp({ two_step_confirm: false, budget_change_max_pct: 50 })
      const set = (amount: number) =>
        tool(m.key, "ads_update_budget", { platform: "meta", account_id: fx.ext.vnd, level: "ad_group", id: "g20", budget_type: "daily", amount })
      expect((await set(150_000)).sc.status).toBe("success") // +50 % vs 100k
      const step = await set(200_000) // +33 % per call, +100 % vs the 24 h baseline
      expect(step.isError).toBe(true)
      expect(step.sc.code).toBe("budget_cumulative_change_too_large")
      expect(step.sc.message).toMatch(/100\.000 VND/)
      // a second MCP on the same object sees the same baseline
      const m2 = await fullMcp({ two_step_confirm: false, budget_change_max_pct: 50 })
      const other = await tool(m2.key, "ads_update_budget", { platform: "meta", account_id: fx.ext.vnd, level: "ad_group", id: "g20", budget_type: "daily", amount: 160_000 })
      expect(other.sc.code).toBe("budget_cumulative_change_too_large")
      expect((await set(140_000)).sc.status).toBe("success")
    })

    it("M5: executed writes are rate limited per MCP (previews are free); confirmation text asks for human approval", async () => {
      const m = await fullMcp({ write_rate_limit_per_10min: 2 })
      const args = (id: string) => ({ platform: "meta", account_id: fx.ext.vnd, level: "campaign", ids: [id], status: "paused" })
      const previews = []
      for (const id of ["c1", "c2", "c3"]) previews.push(await tool(m.key, "ads_set_status", args(id)))
      expect(previews.every((p) => p.sc.status === "confirmation_required")).toBe(true)
      expect(previews[0]!.sc.message).toMatch(/con người/)
      expect(previews[0]!.text).toMatch(/CHỜ họ đồng ý/)
      expect((await tool(m.key, "ads_set_status", { ...args("c1"), confirm_token: previews[0]!.sc.confirm_token })).sc.status).toBe("success")
      expect((await tool(m.key, "ads_set_status", { ...args("c2"), confirm_token: previews[1]!.sc.confirm_token })).sc.status).toBe("success")
      const third = await tool(m.key, "ads_set_status", { ...args("c3"), confirm_token: previews[2]!.sc.confirm_token })
      expect(third.isError).toBe(true)
      expect(third.sc.code).toBe("write_rate_limited")
    })

    it("M7: write rows are committed before the answer (no flush needed); reads stay batched", async () => {
      const m = await fullMcp({ two_step_confirm: false })
      await tool(m.key, "ads_update_object", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "c3", name: "Tên đồng bộ" })
      const rows = await db
        .select()
        .from(schema.mcpCallLogs)
        .where(and(eq(schema.mcpCallLogs.mcpId, m.id), eq(schema.mcpCallLogs.toolName, "ads_update_object")))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "success", actionKind: "write" })
      expect(rows[0]!.changes).toEqual([{ object_id: "c3", object_name: null, level: null, field: "name", before: null, after: "Tên đồng bộ" }])
    })

    it("deterministic idempotency keys: pending action id when confirmed, args+minute when two-step is off, scoped caller key", async () => {
      const { writeIdempotencyKey } = await import("../tool")
      const m = await fullMcp()
      const args = { platform: "meta", account_id: fx.ext.vnd, level: "campaign", ids: ["c2"], status: "paused" }
      const p = await tool(m.key, "ads_set_status", args)
      await tool(m.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      const pending = await db.select().from(schema.mcpPendingActions).where(eq(schema.mcpPendingActions.mcpId, m.id))
      const idem = state.executions.at(-1)!.idem
      expect(idem).toBe(writeIdempotencyKey({ mcpId: m.id, toolName: "ads_set_status", args, pendingActionId: pending[0]!.id }))

      const off = await fullMcp({ two_step_confirm: false })
      const a2 = { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "c3", name: "Lặp lại" }
      await tool(off.key, "ads_update_object", a2)
      const k1 = state.executions.at(-1)!.idem
      await tool(off.key, "ads_update_object", a2)
      const k2 = state.executions.at(-1)!.idem
      expect(k1).toMatch(/^mcpw-[0-9a-f]{40}$/)
      // same args within the same minute → same key (adapter retries and client resends dedupe)
      if (Math.floor(Date.now() / 60_000) === Math.floor((Date.now() - 1_000) / 60_000)) expect(k2).toBe(k1)
      await tool(off.key, "ads_update_object", { ...a2, idempotency_key: "client-1" })
      expect(state.executions.at(-1)!.idem).toBe(
        writeIdempotencyKey({ mcpId: off.id, toolName: "ads_update_object", args: { ...a2, idempotency_key: "client-1" }, pendingActionId: null })
      )
    })

    it("auth_invalid from the platform marks the connection invalid with the Vietnamese reason", async () => {
      const { __resetAuthInvalidThrottle } = await import("../connection-health")
      __resetAuthInvalidThrottle()
      const m = await fullMcp()
      try {
        const r = await tool(m.key, "ads_get_object", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "auth_fail" })
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("auth_invalid")
        const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, fx.ids.connMeta))
        expect(c!.status).toBe("invalid")
        expect(c!.statusMessage).toBe("Token Meta đã hết hạn hoặc bị thu hồi.")
        // next call fails fast without reaching the platform
        const again = await tool(m.key, "ads_get_object", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "c1" })
        expect(again.sc.code).toBe("auth_invalid")
      } finally {
        await db.update(schema.connections).set({ status: "active", statusMessage: null }).where(eq(schema.connections.id, fx.ids.connMeta))
      }
    })

    it("every executed write fills the changes column (extensions with created ids, copy, upload-free delete)", async () => {
      addObjects(fx.ext.vnd, [{ id: "a30", level: "ad", name: "Xoá tôi", status: "paused", parentId: "g1" }])
      const m = await fullMcp({ two_step_confirm: false })
      await tool(m.key, "meta_fake_create_adgroup", { account_id: fx.ext.vnd, name: "Nhóm mới", daily_budget: 1000 })
      await tool(m.key, "ads_copy_object", { platform: "meta", account_id: fx.ext.vnd, level: "campaign", id: "c1" })
      const d = await tool(m.key, "ads_delete_object", { platform: "meta", account_id: fx.ext.vnd, level: "ad", id: "a30" })
      await tool(m.key, "ads_delete_object", { platform: "meta", account_id: fx.ext.vnd, level: "ad", id: "a30", confirm_token: d.sc.confirm_token })
      const rows = await db
        .select()
        .from(schema.mcpCallLogs)
        .where(and(eq(schema.mcpCallLogs.mcpId, m.id), eq(schema.mcpCallLogs.status, "success")))
      const byTool = Object.fromEntries(rows.map((r) => [r.toolName, r.changes as any[]]))
      expect(byTool.meta_fake_create_adgroup).toEqual(
        expect.arrayContaining([expect.objectContaining({ object_id: "ag_new_1", field: "created", before: null })])
      )
      expect(byTool.ads_copy_object?.length).toBeGreaterThan(0)
      expect(byTool.ads_delete_object).toEqual([expect.objectContaining({ object_id: "a30", before: "paused", after: "deleted" })])
    })
  })
})
