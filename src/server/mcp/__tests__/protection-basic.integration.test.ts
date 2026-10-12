// Protection mode "basic" at the endpoint (real Request objects against serveMcp(), Postgres, fake providers): the
// stored advanced values (IP allowlist, request / write limits, two-step confirmation, % limit, caps) are kept in the
// row but not enforced; ads_delete_object still always confirms. The same row in advanced mode enforces them.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  cleanupFixtures,
  createFixtures,
  createMcp,
  loadTestEnv,
  mcpRequest,
  modernMeta,
  readRpc,
  TEST_HOST,
} from "./helpers"
import {
  createFakeProvider,
  newFakeState,
  type FakeState,
} from "./fake-provider"

const hasDb = loadTestEnv()
process.env.APP_DOMAIN = TEST_HOST

type Fx = Awaited<ReturnType<typeof createFixtures>>

/** advanced values of the row (kept while basic, applied again when switched back) */
const STORED = {
  two_step_confirm: true,
  budget_change_max_pct: 10,
  max_daily_budget: { VND: 130_000 },
  max_lifetime_budget: { VND: 1_000_000 },
  rate_limit_per_min: 3,
  write_rate_limit_per_10min: 1,
  allowed_ips: ["10.0.0.0/8"],
  money_caps_required: true,
}

describe.skipIf(!hasDb)(
  "MCP endpoint in basic protection mode (integration)",
  { timeout: 120_000 },
  () => {
    let fx: Fx
    let state: FakeState
    let serveMcp: typeof import("../serve").serveMcp
    let invalidateGrantCache: typeof import("../grant").invalidateGrantCache
    let resetRate: typeof import("../rate-limit").__resetRateLimits
    let flushMcpLogs: typeof import("../../audit/mcp-log-writer").flushMcpLogs

    beforeAll(async () => {
      const registry = await import("../../providers/registry")
      state = newFakeState()
      registry.registerProvider(createFakeProvider("meta", state))
      registry.registerProvider(createFakeProvider("openai_ads", state))
      ;({ serveMcp } = await import("../serve"))
      ;({ invalidateGrantCache } = await import("../grant"))
      ;({ __resetRateLimits: resetRate } = await import("../rate-limit"))
      ;({ flushMcpLogs } = await import("../../audit/mcp-log-writer"))
      fx = await createFixtures()
      state.objects.set(fx.ext.vnd, [
        {
          id: "c1",
          level: "campaign",
          name: "Chiến dịch 1",
          status: "active",
          parentId: null,
          budget: null,
        },
        {
          id: "g1",
          level: "ad_group",
          name: "Nhóm A",
          status: "active",
          parentId: "c1",
          budget: { type: "daily", amount: 100_000, level: "ad_group" },
        },
        {
          id: "a1",
          level: "ad",
          name: "QC 1",
          status: "active",
          parentId: "g1",
        },
      ])
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

    const send = (req: Request) =>
      serveMcp(req, new URL(req.url).pathname.split("/").pop()!)
    const OUTSIDE = { "x-forwarded-for": "1.2.3.4" }

    async function rpc(
      key: string,
      method: string,
      params: Record<string, unknown> = {},
      headers: Record<string, string> = OUTSIDE
    ) {
      const body = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method,
        params: { ...params, _meta: modernMeta() },
      }
      const res = await send(mcpRequest(key, body, { modern: true, headers }))
      const msgs = res.status === 200 ? await readRpc(res) : []
      return { res, msg: msgs.find((m) => m.id === body.id) ?? msgs[0] }
    }

    async function tool(
      key: string,
      name: string,
      args: Record<string, unknown>
    ) {
      const { res, msg } = await rpc(key, "tools/call", {
        name,
        arguments: args,
      })
      expect(res.status).toBe(200)
      expect(msg?.error, JSON.stringify(msg?.error)).toBeUndefined()
      return {
        isError: Boolean(msg.result.isError),
        sc: msg.result.structuredContent as Record<string, any>,
      }
    }

    const mcp = (
      protection_mode: "basic" | "advanced",
      permissions = ["read"]
    ) =>
      createMcp(fx.f, {
        ownerId: fx.ids.staff,
        permissions: { meta: permissions },
        scopes: [{ connectionId: fx.ids.connMeta }],
        settings: { ...STORED, protection_mode },
      })

    it("basic: any IP, no request limit (also for a JSON-RPC batch); the same row in advanced → 403 / 429", async () => {
      const m = await mcp("basic")
      for (let i = 0; i < 12; i++)
        expect((await rpc(m.key, "tools/list")).res.status).toBe(200)
      const batch = Array.from({ length: 8 }, (_, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: { name: "ads_list_accounts", arguments: {} },
      }))
      // 2025-era batch (batches are a pre-2026 feature): 8 messages > the stored 3/min, still served
      const res = await send(mcpRequest(m.key, batch, { modern: false, headers: OUTSIDE }))
      expect(res.status).toBe(200)
      expect(await readRpc(res)).toHaveLength(8)

      const a = await mcp("advanced")
      expect((await rpc(a.key, "tools/list")).res.status).toBe(403)
      const inside = { "x-forwarded-for": "10.1.2.3" }
      for (let i = 0; i < 3; i++)
        expect((await rpc(a.key, "tools/list", {}, inside)).res.status).toBe(
          200
        )
      expect((await rpc(a.key, "tools/list", {}, inside)).res.status).toBe(429)
    })

    it("basic: writes run at once without the % limit, caps or write limit; ads_delete_object still confirms", async () => {
      const m = await mcp("basic", ["read", "status", "update", "delete"])
      const before = state.executions.length
      const base = {
        platform: "meta",
        account_id: fx.ext.vnd,
        level: "ad_group",
        id: "g1",
        budget_type: "daily",
      }
      // +900 % and above the stored 130 000 VND daily cap
      const budget = await tool(m.key, "ads_update_budget", {
        ...base,
        amount: 1_000_000,
      })
      expect(budget.isError, JSON.stringify(budget.sc)).toBe(false)
      expect(budget.sc.status).toBe("success")
      expect(JSON.stringify(budget.sc)).not.toMatch(/Infinity|chưa đặt trần/)
      // second executed write in 10 minutes (stored limit: 1)
      const paused = await tool(m.key, "ads_set_status", {
        platform: "meta",
        account_id: fx.ext.vnd,
        level: "campaign",
        ids: ["c1"],
        status: "paused",
      })
      expect(paused.sc.status).toBe("success")
      expect(state.executions.length).toBe(before + 2)
      const d = await tool(m.key, "ads_delete_object", {
        platform: "meta",
        account_id: fx.ext.vnd,
        level: "ad",
        id: "a1",
      })
      expect(d.sc.status).toBe("confirmation_required")
      expect(state.executions.length).toBe(before + 2)
    })

    it("advanced (same row): the stored limits apply again", async () => {
      const m = await mcp("advanced", ["read", "status", "update"])
      const inside = { "x-forwarded-for": "10.1.2.3" }
      const body = {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "ads_update_budget",
          arguments: {
            platform: "meta",
            account_id: fx.ext.vnd,
            level: "ad_group",
            id: "g1",
            budget_type: "daily",
            amount: 10_000_000,
          },
          _meta: modernMeta(),
        },
      }
      const res = await send(
        mcpRequest(m.key, body, { modern: true, headers: inside })
      )
      const [msg] = await readRpc(res)
      expect(msg.result.isError).toBe(true)
      expect(["budget_change_too_large", "budget_cap_exceeded"]).toContain(
        msg.result.structuredContent.code
      )
    })
  }
)
