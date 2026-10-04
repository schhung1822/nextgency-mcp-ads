// Reports and writes seen by an AI client of an MCP created through the real services:
// multi-account / multi-currency fan-out, per-account time-zone dates, signed cursors, guardrails per currency,
// the two-step confirmation lifecycle and write idempotency - on all four platforms.
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { db } from "@/server/db/client"
import { __resetRateLimits } from "@/server/mcp/rate-limit"
import { mcpPendingActions } from "@/server/db/schema"
import { PLATFORMS, type Platform } from "@/server/providers/types"
import { demoAccounts, loadTestEnv, World, type ConnInfo, type McpInfo } from "./world"

const hasDb = loadTestEnv()

describe.skipIf(!hasDb)("reports and writes on all platforms (services → endpoint)", { timeout: 300_000 }, () => {
  let w: World
  const conns = {} as Record<Platform, ConnInfo>
  const infoOf = {} as Record<string, { platform: Platform; currency: string; timezone: string }>
  const spendOf: Record<string, number> = {}
  let all: McpInfo

  beforeAll(async () => {
    w = await World.create()
    let n = 0
    for (const p of PLATFORMS) {
      const accs = demoAccounts(w.prefix, p)
      conns[p] = await w.connect(w.users.staff, p, accs)
      for (const a of accs) {
        infoOf[a.externalId] = { platform: p, currency: a.currency, timezone: a.timezone }
        spendOf[a.externalId] = 1000 * ++n
        w.state.spend.set(a.externalId, spendOf[a.externalId]!)
        w.seedObjects(a.externalId, [
          { id: "c1", level: "campaign", name: "C1", status: "active", parentId: null, budget: null },
          { id: "c2", level: "campaign", name: "C2", status: "active", parentId: null, budget: null },
          { id: "c3", level: "campaign", name: "C3", status: "paused", parentId: null, budget: null },
          { id: "g1", level: "ad_group", name: "G1", status: "active", parentId: "c1", budget: { type: "daily", amount: 100, level: "ad_group" } },
          { id: "g2", level: "ad_group", name: "G2", status: "active", parentId: "c1", budget: { type: "lifetime", amount: 2000, level: "ad_group" } },
          { id: "c4", level: "campaign", name: "C4 big", status: "paused", parentId: null, budget: { type: "daily", amount: 5000, level: "campaign" } },
        ])
      }
    }
    all = await w.mcp(w.users.staff, {
      settings: { twoStepConfirm: false },
      platforms: Object.fromEntries(PLATFORMS.map((p) => [p, { permissions: ["read", "status", "update", "copy", "create", "delete"], connections: [{ conn: conns[p] }] }])),
    })
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => w.reset())
  afterEach(() => vi.useRealTimers())

  const report = (key: string, args: Record<string, unknown> = {}) =>
    w.call(key, "ads_get_report", { level: "account", preset: "yesterday", ...args })

  // ---------------------------------------------------------------------------------------------
  describe("ads_get_report", () => {
    it("resolves 'yesterday' in the time zone of EACH account (HCM/Tokyo are already on the next day, New York/LA/Berlin/UTC are not)", async () => {
      // 2026-10-03 20:00 UTC → 10-04 03:00 Ho Chi Minh, 10-04 05:00 Tokyo, 10-03 22:00 Berlin, 10-03 16:00 New York, 10-03 13:00 Los Angeles
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-10-03T20:00:00Z"))
      const r = await report(all.key, { limit: 200 })
      expect(r.isError, r.text).toBe(false)
      const expected: Record<string, string> = {
        "Asia/Ho_Chi_Minh": "2026-10-03",
        "Asia/Tokyo": "2026-10-03",
        "Europe/Berlin": "2026-10-02",
        "America/New_York": "2026-10-02",
        "America/Los_Angeles": "2026-10-02",
        UTC: "2026-10-02",
      }
      expect(w.state.reportCalls.length).toBeGreaterThanOrEqual(Object.keys(infoOf).length)
      for (const call of w.state.reportCalls) {
        expect(call.range, `${call.platform} ${call.account} (${call.timezone})`).toEqual({ from: expected[call.timezone], to: expected[call.timezone] })
      }
      // the answer states which dates each account was asked for
      for (const a of r.sc.accounts as { account_id: string; timezone: string; date_from: string; date_to: string }[]) {
        expect(a.date_from).toBe(expected[a.timezone])
        expect(a.date_to).toBe(expected[a.timezone])
      }
      // explicit dates are NOT shifted: the same calendar day for every account
      w.state.reportCalls.length = 0
      await report(all.key, { preset: undefined, date_from: "2026-09-01", date_to: "2026-09-30" })
      for (const call of w.state.reportCalls) expect(call.range).toEqual({ from: "2026-09-01", to: "2026-09-30" })
    })

    it("totals per currency across platforms never mix currencies", async () => {
      const r = await report(all.key, { limit: 200 })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.row_count).toBe(Object.keys(infoOf).length)
      const expectedTotals = new Map<string, number>()
      for (const [ext, info] of Object.entries(infoOf)) expectedTotals.set(info.currency, (expectedTotals.get(info.currency) ?? 0) + spendOf[ext]!)
      const totals = new Map((r.sc.totals_by_currency as { currency: string; metrics: { spend: number } }[]).map((t) => [t.currency, t.metrics.spend]))
      expect([...totals.keys()].sort()).toEqual([...expectedTotals.keys()].sort())
      for (const [cur, sum] of expectedTotals) expect(totals.get(cur), cur).toBe(sum)
      // every row carries its own currency
      for (const row of r.sc.rows as { account_id: string; currency: string }[]) expect(row.currency).toBe(infoOf[row.account_id]!.currency)
      // sorting by spend across currencies is allowed but flagged (no FX conversion)
      const sorted = await report(all.key, { sort_by: "spend", limit: 200 })
      expect((sorted.sc.warnings as string[]).join(" ")).toMatch(/không quy đổi tỷ giá/)
    })

    it("pages through every account once with signed cursors; tampered / foreign / re-targeted cursors are refused", async () => {
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const r = await w.call(all.key, "ads_get_report", { level: "campaign", preset: "yesterday", limit: 5, ...(cursor ? { cursor } : {}) })
        expect(r.isError, r.text).toBe(false)
        for (const row of r.sc.rows as { account_id: string; campaign_id: string }[]) seen.push(`${row.account_id}/${row.campaign_id}`)
        cursor = (r.sc.next_cursor as string | null) ?? undefined
        pages++
      } while (cursor && pages < 50)
      expect(new Set(seen).size).toBe(seen.length) // no duplicates
      expect(seen.length).toBe(Object.keys(infoOf).length * 4) // 4 campaigns per account, none missing
      expect(pages).toBeGreaterThan(1)

      const first = await w.call(all.key, "ads_get_report", { level: "campaign", preset: "yesterday", limit: 5 })
      const cur = first.sc.next_cursor as string
      expect(cur).toBeTruthy()
      // tampered payload / garbage
      for (const bad of [cur.slice(0, -2) + "xx", "garbage", cur.split(".")[0]!]) {
        const r = await w.call(all.key, "ads_get_report", { level: "campaign", preset: "yesterday", limit: 5, cursor: bad })
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("invalid_cursor")
      }
      // same cursor, different query (another level / another metrics list)
      const other = await w.call(all.key, "ads_get_report", { level: "ad_group", preset: "yesterday", limit: 5, cursor: cur })
      expect(other.sc.code).toBe("invalid_cursor")
      // cursor of another MCP
      const mcp2 = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: conns.meta }] } } })
      const foreign = await w.call(mcp2.key, "ads_get_report", { level: "campaign", preset: "yesterday", limit: 5, cursor: cur })
      expect(foreign.sc.code).toBe("invalid_cursor")
    })

    it("one failing account does not hide the others; a call naming a foreign account is refused as a whole", async () => {
      const failing = demoAccounts(w.prefix, "meta")[1]!.externalId
      w.state.failingAccounts.add(failing)
      const r = await report(all.key, { platforms: ["meta"], limit: 200 })
      expect(r.isError, r.text).toBe(false)
      expect((r.sc.errors as { account_id: string; code: string }[]).map((e) => `${e.account_id}:${e.code}`)).toEqual([`${failing}:permission_denied`])
      expect(r.sc.row_count).toBe(2)
      w.state.failingAccounts.clear()
      w.state.reportCalls.length = 0

      const mixed = await report(all.key, { account_ids: [demoAccounts(w.prefix, "meta")[0]!.externalId, "act_999999999999"] })
      expect(mixed.isError).toBe(true)
      expect(mixed.sc.code).toBe("account_not_in_scope")
      expect(w.state.reportCalls.length).toBe(0) // nothing was fetched for the allowed account either
    })

    it("a read-only MCP on one platform cannot report on another", async () => {
      const only = await w.mcp(w.users.staff, { platforms: { openai_ads: { permissions: ["read"], connections: [{ conn: conns.openai_ads }] } } })
      const r = await report(only.key, { platforms: ["meta"] })
      expect(r.isError).toBe(true) // platform enum of the schema only allows openai_ads
      const own = await report(only.key)
      expect(own.isError, own.text).toBe(false)
      expect(own.sc.row_count).toBe(conns.openai_ads.accounts.length)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe.each(PLATFORMS)("writes on %s", (platform) => {
    const acc = () => demoAccounts(w.prefix, platform)[0]!
    const budgetArgs = (amount: number, extra: Record<string, unknown> = {}) => ({
      platform,
      account_id: acc().externalId,
      level: "ad_group",
      id: "g1",
      budget_type: "daily",
      amount,
      ...extra,
    })

    it("two-step confirmation lifecycle: preview → confirm → replay; wrong args, other MCP, expired and consumed tokens", async () => {
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true },
        platforms: { [platform]: { permissions: ["read", "status", "update"], connections: [{ conn: conns[platform] }] } },
      })
      const other = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true },
        platforms: { [platform]: { permissions: ["read", "status", "update"], connections: [{ conn: conns[platform] }] } },
      })
      const run0 = w.state.executions.length
      const p = await w.call(mcp.key, "ads_set_status", { platform, account_id: acc().externalId, level: "campaign", ids: ["c2"], status: "paused" })
      expect(p.sc.status).toBe("confirmation_required")
      expect(p.sc.confirm_token).toBeTruthy()
      expect(p.sc.message).toMatch(/CHƯA thực hiện/)
      expect(w.state.executions.length).toBe(run0) // preview executes nothing
      const args = { platform, account_id: acc().externalId, level: "campaign", ids: ["c2"], status: "paused" }

      // wrong args / other MCP / garbage token: refused, still nothing executed
      const wrongArgs = await w.call(mcp.key, "ads_set_status", { ...args, ids: ["c3"], confirm_token: p.sc.confirm_token })
      expect(wrongArgs.sc.code).toBe("confirm_args_mismatch")
      const foreignMcp = await w.call(other.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      expect(foreignMcp.sc.code).toBe("confirm_token_invalid")
      const otherTool = await w.call(mcp.key, "ads_update_object", { platform, account_id: acc().externalId, level: "campaign", id: "c2", name: "x", confirm_token: p.sc.confirm_token })
      expect(otherTool.sc.code).toBe("confirm_token_invalid")
      const garbage = await w.call(mcp.key, "ads_set_status", { ...args, confirm_token: "ct_nope" })
      expect(garbage.sc.code).toBe("confirm_token_invalid")
      expect(w.state.executions.length).toBe(run0)

      // the right call executes once …
      const done = await w.call(mcp.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect(done.sc.replayed).toBe(false)
      expect(w.state.executions.length).toBe(run0 + 1)
      // … and a retry (lost response) returns the stored result without executing again
      const again = await w.call(mcp.key, "ads_set_status", { ...args, confirm_token: p.sc.confirm_token })
      expect(again.sc.replayed).toBe(true)
      expect(again.sc.changes).toEqual(done.sc.changes)
      expect(w.state.executions.length).toBe(run0 + 1)

      // expired token
      const p2 = await w.call(mcp.key, "ads_set_status", { ...args, status: "active" })
      await db.update(mcpPendingActions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mcpPendingActions.mcpId, mcp.id))
      const late = await w.call(mcp.key, "ads_set_status", { ...args, status: "active", confirm_token: p2.sc.confirm_token })
      expect(late.sc.code).toBe("confirm_token_expired")
      expect(w.state.executions.length).toBe(run0 + 1)
    })

    it("guardrails are per currency and checked on both steps: cap, ±% per change, bid cap", async () => {
      const currency = acc().currency
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, budgetChangeMaxPct: 50, maxDailyBudget: { [currency]: 120 }, maxBid: { [currency]: 5 } },
        platforms: { [platform]: { permissions: ["read", "update"], connections: [{ conn: conns[platform] }] } },
      })
      // the shared fake keeps budgets between tests: start from 100
      w.state.objects.get(acc().externalId)!.find((o) => o.id === "g1")!.budget = { type: "daily", amount: 100, level: "ad_group" }
      const before = w.state.executions.length
      const over = await w.call(mcp.key, "ads_update_budget", budgetArgs(130))
      expect(over.sc.code).toBe("budget_cap_exceeded")
      const tooBig = await w.call(mcp.key, "ads_update_budget", budgetArgs(180))
      expect(["budget_change_too_large", "budget_cap_exceeded"]).toContain(tooBig.sc.code)
      const bid = await w.call(mcp.key, "ads_update_object", { platform, account_id: acc().externalId, level: "ad_group", id: "g1", bid_amount: 6 })
      expect(bid.sc.code).toBe("bid_cap_exceeded")
      expect(w.state.executions.length).toBe(before) // nothing reached the platform
      const ok = await w.call(mcp.key, "ads_update_budget", budgetArgs(110))
      expect(ok.isError, ok.text).toBe(false)
      expect(w.state.executions.length).toBe(before + 1)
      // a cap in another currency does not apply here
      const otherCurrency = currency === "VND" ? "USD" : "VND"
      const mcpOther = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, maxDailyBudget: { [otherCurrency]: 1 } },
        platforms: { [platform]: { permissions: ["read", "update"], connections: [{ conn: conns[platform] }] } },
      })
      const free = await w.call(mcpOther.key, "ads_update_budget", budgetArgs(115))
      expect(free.isError, free.text).toBe(false)
    })

    it("cumulative 24 h ±%, lifetime cap and activation cap hold on every platform", async () => {
      const cur = acc().currency
      const objs = w.state.objects.get(acc().externalId)!
      objs.find((o) => o.id === "g1")!.budget = { type: "daily", amount: 100, level: "ad_group" }
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, budgetChangeMaxPct: 50, maxDailyBudget: { [cur]: 1000 }, maxLifetimeBudget: { [cur]: 5000 } },
        platforms: { [platform]: { permissions: ["read", "status", "update"], connections: [{ conn: conns[platform] }] } },
      })
      // ---- cumulative: each step is within 50% of the CURRENT value, the sum of steps is not
      expect((await w.call(mcp.key, "ads_update_budget", budgetArgs(140))).isError).toBe(false) // +40 %
      const salami = await w.call(mcp.key, "ads_update_budget", budgetArgs(190)) // +35.7 % of 140, but +90 % of the 24 h baseline (100)
      expect(salami.sc.code).toBe("budget_cumulative_change_too_large")
      expect(objs.find((o) => o.id === "g1")!.budget!.amount).toBe(140)
      // ---- lifetime: explicit cap 5000 (daily cap 1000 × 30 days would allow 30000: the LOWER one applies)
      const lifetime = (amount: number) => ({ ...budgetArgs(amount), id: "g2", budget_type: "lifetime" })
      const wide = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, budgetChangeMaxPct: 500, maxDailyBudget: { [cur]: 1000 }, maxLifetimeBudget: { [cur]: 5000 } },
        platforms: { [platform]: { permissions: ["read", "status", "update"], connections: [{ conn: conns[platform] }] } },
      })
      expect((await w.call(wide.key, "ads_update_budget", lifetime(6000))).sc.code).toBe("budget_cap_exceeded")
      expect((await w.call(wide.key, "ads_update_budget", lifetime(4500))).isError).toBe(false)
      // ---- activation: C4 (paused) carries a 5000 daily budget over the 1000 cap: pausing is fine, switching ON is refused
      const set = (status: string) => ({ platform, account_id: acc().externalId, level: "campaign", ids: ["c4"], status })
      expect((await w.call(mcp.key, "ads_set_status", set("paused"))).isError).toBe(false)
      const on = await w.call(mcp.key, "ads_set_status", set("active"))
      expect(on.sc.code).toBe("budget_cap_exceeded")
      expect(objs.find((o) => o.id === "c4")!.status).toBe("paused")
    })

    it("write idempotency: the same client idempotency_key reaches the adapter as the same key (scoped per MCP)", async () => {
      const mk = () =>
        w.mcp(w.users.staff, {
          settings: { twoStepConfirm: false },
          platforms: { [platform]: { permissions: ["read", "update"], connections: [{ conn: conns[platform] }] } },
        })
      const a = await mk()
      const b = await mk()
      const args = (n: string) => ({ platform, account_id: acc().externalId, level: "campaign", id: "c1", name: n, idempotency_key: "same-key-1" })
      w.state.executions.length = 0
      await w.call(a.key, "ads_update_object", args("N1"))
      await w.call(a.key, "ads_update_object", args("N2"))
      await w.call(b.key, "ads_update_object", args("N1"))
      const keys = w.state.executions.filter((e) => e.op === "update_object").map((e) => e.idem)
      expect(keys).toHaveLength(3)
      expect(keys[0]).toBe(keys[1]) // same MCP + tool + client key
      expect(keys[2]).not.toBe(keys[0]) // another MCP never shares keys
      expect(keys.every((k) => typeof k === "string" && k.startsWith("mcpw-"))).toBe(true)
    })

    it("the write quota is spent by EXECUTED writes only: replays of a consumed token and invalid tokens cost nothing", async () => {
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true, writeRateLimitPer10Min: 2 },
        platforms: { [platform]: { permissions: ["read", "status"], connections: [{ conn: conns[platform] }] } },
      })
      const args = (id: string) => ({ platform, account_id: acc().externalId, level: "campaign", ids: [id], status: "paused" })
      const confirmed = async (id: string) => {
        const p = await w.call(mcp.key, "ads_set_status", args(id))
        return w.call(mcp.key, "ads_set_status", { ...args(id), confirm_token: p.sc.confirm_token })
      }
      const first = await confirmed("c1")
      expect(first.sc.replayed).toBe(false)
      // 5 lost-response retries and 5 garbage tokens: nothing executes, nothing is counted
      const p = await w.call(mcp.key, "ads_set_status", args("c2"))
      const second = await w.call(mcp.key, "ads_set_status", { ...args("c2"), confirm_token: p.sc.confirm_token })
      expect(second.isError, second.text).toBe(false)
      for (let i = 0; i < 5; i++) {
        const again = await w.call(mcp.key, "ads_set_status", { ...args("c2"), confirm_token: p.sc.confirm_token })
        expect(again.sc.replayed).toBe(true)
        const bad = await w.call(mcp.key, "ads_set_status", { ...args("c2"), confirm_token: `ct_bad${i}` })
        expect(bad.sc.code).toBe("confirm_token_invalid")
      }
      // 2 executions were made: the quota (2) is spent, the third distinct write is refused …
      const third = await w.call(mcp.key, "ads_set_status", args("c3"))
      expect(third.sc.status).toBe("confirmation_required") // previews stay free
      const refused = await w.call(mcp.key, "ads_set_status", { ...args("c3"), confirm_token: third.sc.confirm_token })
      expect(refused.sc.code).toBe("write_rate_limited")
      // … and the refused token was NOT consumed: it works once the window has room again
      __resetRateLimits()
      const later = await w.call(mcp.key, "ads_set_status", { ...args("c3"), confirm_token: third.sc.confirm_token })
      expect(later.isError, later.text).toBe(false)
      expect(later.sc.replayed).toBe(false)
    })

    it("delete always needs confirmation, even when two-step is off; the write rate limit counts executions only", async () => {
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, writeRateLimitPer10Min: 2 },
        platforms: { [platform]: { permissions: ["read", "update", "delete"], connections: [{ conn: conns[platform] }] } },
      })
      const del = { platform, account_id: acc().externalId, level: "campaign", id: "c3" }
      const preview = await w.call(mcp.key, "ads_delete_object", del)
      expect(preview.sc.status).toBe("confirmation_required")
      expect(w.state.objects.get(acc().externalId)!.some((o) => o.id === "c3")).toBe(true)
      // previews are free: many of them, then two executions, then the limit bites
      for (let i = 0; i < 3; i++) await w.call(mcp.key, "ads_delete_object", del)
      const upd = (n: string) => w.call(mcp.key, "ads_update_object", { platform, account_id: acc().externalId, level: "campaign", id: "c1", name: n })
      expect((await upd("a")).isError).toBe(false)
      expect((await upd("b")).isError).toBe(false)
      const limited = await upd("c")
      expect(limited.isError).toBe(true)
      expect(limited.sc.code).toBe("write_rate_limited")
      // reads are never limited by it
      expect((await w.call(mcp.key, "ads_list_objects", { platform, account_id: acc().externalId, level: "campaign" })).isError).toBe(false)
    })
  })
})
