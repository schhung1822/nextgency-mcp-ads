// Write pacing at the endpoint (real Request objects against serveMcp(), Postgres, fake providers):
// settings.write_delay_seconds spaces the EXECUTED ad-platform writes of an advanced MCP (the server waits on its own,
// the AI sees "đã chờ N giây"); previews (two-step confirmation) never wait; basic mode ignores the stored delay.
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

const DELAY_S = 2

describe.skipIf(!hasDb)(
  "MCP write pacing (integration)",
  { timeout: 120_000 },
  () => {
    let fx: Fx
    let state: FakeState
    let serveMcp: typeof import("../serve").serveMcp
    let invalidateGrantCache: typeof import("../grant").invalidateGrantCache
    let resetRate: typeof import("../rate-limit").__resetRateLimits
    let resetPacing: typeof import("../write-pacing").__resetWritePacing
    let flushMcpLogs: typeof import("../../audit/mcp-log-writer").flushMcpLogs

    beforeAll(async () => {
      const registry = await import("../../providers/registry")
      state = newFakeState()
      registry.registerProvider(createFakeProvider("meta", state))
      registry.registerProvider(createFakeProvider("openai_ads", state))
      ;({ serveMcp } = await import("../serve"))
      ;({ invalidateGrantCache } = await import("../grant"))
      ;({ __resetRateLimits: resetRate } = await import("../rate-limit"))
      ;({ __resetWritePacing: resetPacing } = await import("../write-pacing"))
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
          id: "c2",
          level: "campaign",
          name: "Chiến dịch 2",
          status: "active",
          parentId: null,
          budget: null,
        },
        {
          id: "c3",
          level: "campaign",
          name: "Chiến dịch 3",
          status: "active",
          parentId: null,
          budget: null,
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
      resetPacing()
      invalidateGrantCache()
    })

    const send = (req: Request) =>
      serveMcp(req, new URL(req.url).pathname.split("/").pop()!)

    async function tool(
      key: string,
      name: string,
      args: Record<string, unknown>
    ) {
      const body = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name, arguments: args, _meta: modernMeta() },
      }
      const res = await send(mcpRequest(key, body, { modern: true }))
      expect(res.status).toBe(200)
      const msgs = await readRpc(res)
      const msg = msgs.find((m) => m.id === body.id) ?? msgs[0]
      expect(msg?.error, JSON.stringify(msg?.error)).toBeUndefined()
      const text = (msg.result.content ?? [])
        .map((c: { text?: string }) => c.text ?? "")
        .join("\n")
      return {
        isError: Boolean(msg.result.isError),
        sc: msg.result.structuredContent as Record<string, any>,
        text,
      }
    }

    const mcp = (settings: Record<string, unknown>) =>
      createMcp(fx.f, {
        ownerId: fx.ids.staff,
        permissions: { meta: ["read", "status"] },
        scopes: [{ connectionId: fx.ids.connMeta }],
        settings: {
          protection_mode: "advanced",
          two_step_confirm: false,
          rate_limit_per_min: 600,
          write_rate_limit_per_10min: 1000,
          max_daily_budget: { VND: 1e12, USD: 1e12 },
          money_caps_required: true,
          write_delay_seconds: DELAY_S,
          ...settings,
        },
      })

    const pause = (key: string, id: string) =>
      tool(key, "ads_set_status", {
        platform: "meta",
        account_id: fx.ext.vnd,
        level: "campaign",
        ids: [id],
        status: "paused",
      })

    it("advanced: the second write waits the delay after the first finished and says so; both execute", async () => {
      const m = await mcp({})
      const before = state.executions.length
      const t0 = Date.now()
      const first = await pause(m.key, "c1")
      expect(first.sc.status).toBe("success")
      expect(first.text).not.toMatch(/đã chờ/)
      const second = await pause(m.key, "c2")
      const elapsed = Date.now() - t0
      expect(second.sc.status).toBe("success")
      expect(second.text).toMatch(/đã chờ [12] giây theo giãn cách lệnh ghi/)
      expect(elapsed).toBeGreaterThanOrEqual(DELAY_S * 1000 - 50)
      expect(state.executions.length).toBe(before + 2)
    })

    it("advanced: concurrent writes are serialised with the delay between them", async () => {
      const m = await mcp({})
      const t0 = Date.now()
      const results = await Promise.all([
        pause(m.key, "c1"),
        pause(m.key, "c2"),
        pause(m.key, "c3"),
      ])
      const elapsed = Date.now() - t0
      for (const r of results) expect(r.sc.status).toBe("success")
      // 3 writes → 2 gaps
      expect(elapsed).toBeGreaterThanOrEqual(2 * DELAY_S * 1000 - 100)
    })

    it("two-step confirmation: previews never wait, the token waits for its turn, a replay answers at once", async () => {
      const m = await mcp({ two_step_confirm: true })
      const args = (id: string) => ({
        platform: "meta",
        account_id: fx.ext.vnd,
        level: "campaign",
        ids: [id],
        status: "paused",
      })
      // preview + confirm of c1 → executed (starts the cooldown)
      const p1 = await tool(m.key, "ads_set_status", args("c1"))
      expect(p1.sc.status).toBe("confirmation_required")
      const token1 = p1.sc.confirm_token as string
      const done1 = await tool(m.key, "ads_set_status", { ...args("c1"), confirm_token: token1 })
      expect(done1.sc.status).toBe("success")

      // a preview right after an executed write does not wait
      let t0 = Date.now()
      const p2 = await tool(m.key, "ads_set_status", args("c2"))
      expect(p2.sc.status).toBe("confirmation_required")
      // a replay of the consumed token answers at once (stored result, nothing executed again)
      const replay = await tool(m.key, "ads_set_status", { ...args("c1"), confirm_token: token1 })
      expect(replay.sc.replayed).toBe(true)
      expect(Date.now() - t0).toBeLessThan(DELAY_S * 1000 - 200)

      // the confirmation of c2 waits the rest of the delay, then executes
      const executionsBefore = state.executions.length
      const done2 = await tool(m.key, "ads_set_status", { ...args("c2"), confirm_token: p2.sc.confirm_token })
      expect(done2.sc.status).toBe("success")
      expect(state.executions.length).toBe(executionsBefore + 1)
      t0 = Date.now()
      // an invalid token never waits either
      const bad = await tool(m.key, "ads_set_status", { ...args("c3"), confirm_token: "not-a-real-token" })
      expect(bad.isError).toBe(true)
      expect(Date.now() - t0).toBeLessThan(DELAY_S * 1000 - 200)
    })

    it("basic mode ignores the stored delay; delay 0 = off", async () => {
      for (const settings of [
        { protection_mode: "basic" },
        { write_delay_seconds: 0 },
      ]) {
        resetPacing()
        const m = await mcp(settings)
        const t0 = Date.now()
        expect((await pause(m.key, "c1")).sc.status).toBe("success")
        const second = await pause(m.key, "c2")
        expect(second.sc.status).toBe("success")
        expect(second.text).not.toMatch(/đã chờ/)
        expect(Date.now() - t0).toBeLessThan(DELAY_S * 1000)
      }
    })
  }
)
