// Reports and writes seen by an AI client of an MCP created through the real services:
// multi-account / multi-currency fan-out, per-account time-zone dates, signed cursors, guardrails per currency,
// the two-step confirmation lifecycle and write idempotency - on all four platforms.
import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { db } from "@/server/db/client"
import { __resetRateLimits } from "@/server/mcp/rate-limit"
import { mcpCallLogs, mcpPendingActions } from "@/server/db/schema"
import { ProviderError, type ProviderErrorCode } from "@/server/providers/errors"
import { getProvider } from "@/server/providers/registry"
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

    it("write idempotency: the same client idempotency_key + same args reaches the adapter as the same key (scoped per MCP and args)", async () => {
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
      await w.call(a.key, "ads_update_object", args("N1"))
      await w.call(a.key, "ads_update_object", args("N2"))
      await w.call(b.key, "ads_update_object", args("N1"))
      const keys = w.state.executions.filter((e) => e.op === "update_object").map((e) => e.idem)
      expect(keys).toHaveLength(4)
      expect(keys[1]).toBe(keys[0]) // same MCP + tool + args + client key
      expect(keys[2]).not.toBe(keys[0]) // same client key with other args is another write
      expect(keys[3]).not.toBe(keys[0]) // another MCP never shares keys
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
      // B2: the wait is returned in seconds (+ in the text) and the refusal is retryable
      expect(refused.sc.retry_after_seconds).toBeGreaterThan(0)
      expect(refused.sc.retryable).toBe(true)
      expect(refused.text).toMatch(/Thử lại sau \d+ giây\./)
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
      expect(limited.sc.retry_after_seconds).toBeGreaterThan(0)
      // reads are never limited by it
      expect((await w.call(mcp.key, "ads_list_objects", { platform, account_id: acc().externalId, level: "campaign" })).isError).toBe(false)
    })

    const platformError = (code: ProviderErrorCode, retryAfterMs?: number) => () =>
      new ProviderError({ platform, code, message: `fake ${code}`, userMessageVi: `Nền tảng từ chối (${code}).`, retryable: true, retryAfterMs })

    it("D5: a write the platform refused before changing anything gives its write slot back; an uncertain failure does not", async () => {
      __resetRateLimits()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, writeRateLimitPer10Min: 1 },
        platforms: { [platform]: { permissions: ["read", "update"], connections: [{ conn: conns[platform] }] } },
      })
      const upd = (n: string) => w.call(mcp.key, "ads_update_object", { platform, account_id: acc().externalId, level: "campaign", id: "c1", name: n })
      // rate limited by the platform (B2: its Retry-After reaches the AI in seconds) → slot refunded
      w.failNext(platform, "updateObject", platformError("rate_limited", 30_000))
      const throttled = await upd("D5 a")
      expect(throttled.sc.code).toBe("rate_limited")
      expect(throttled.sc.retry_after_seconds).toBe(30)
      expect(throttled.text).toContain("Thử lại sau 30 giây.")
      // F2: logged as rate_limited (not error)
      const [row] = await db
        .select({ status: mcpCallLogs.status })
        .from(mcpCallLogs)
        .where(and(eq(mcpCallLogs.mcpId, mcp.id), eq(mcpCallLogs.errorCode, "rate_limited")))
      expect(row?.status).toBe("rate_limited")
      // permission refused by the platform → refunded too
      w.failNext(platform, "updateObject", platformError("permission_denied"))
      expect((await upd("D5 b")).sc.code).toBe("permission_denied")
      // the limit is 1: both refusals gave their slot back, so this write still runs …
      const ok = await upd("D5 c")
      expect(ok.isError, ok.text).toBe(false)
      // … and spends the only slot
      expect((await upd("D5 d")).sc.code).toBe("write_rate_limited")

      // an uncertain failure (5xx / timeout: the platform may have applied it) keeps the slot spent
      __resetRateLimits()
      w.failNext(platform, "updateObject", platformError("upstream_error"))
      expect((await upd("D5 e")).sc.code).toBe("upstream_error")
      expect((await upd("D5 f")).sc.code).toBe("write_rate_limited")
      // an adapter-side validation (no platform answer: the AI's input) is not refunded either
      __resetRateLimits()
      w.failNext(platform, "updateObject", platformError("invalid_request"))
      expect((await upd("D5 g")).sc.code).toBe("invalid_request")
      expect((await upd("D5 h")).sc.code).toBe("write_rate_limited")
      __resetRateLimits()
    })

    it("D5 reads what the call sent upstream: a refusal after a write that went through (2xx) keeps the slot spent", async () => {
      __resetRateLimits()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false, writeRateLimitPer10Min: 1 },
        platforms: { [platform]: { permissions: ["read", "update"], connections: [{ conn: conns[platform] }] } },
      })
      const upd = (n: string) => w.call(mcp.key, "ads_update_object", { platform, account_id: acc().externalId, level: "campaign", id: "c1", name: n })
      // the fake adapter reports one upstream write request (as http.ts does) before its queued failure is thrown
      const provider = getProvider(platform)
      const original = provider.updateObject
      const withUpstream = (status: number) => {
        provider.updateObject = (ctx, u, opts) => {
          if (!opts?.dryRun) ctx.onUpstream?.({ platform, method: "POST", url: "https://platform.test/v1/objects/c1", status, durationMs: 1 })
          return original.call(provider, ctx, u, opts)
        }
      }
      try {
        // the write itself was refused (HTTP 429) → refunded
        withUpstream(429)
        w.failNext(platform, "updateObject", () => new ProviderError({ platform, code: "rate_limited", message: "429", userMessageVi: "Bị giới hạn.", upstream: { httpStatus: 429 } }))
        expect((await upd("D5 up a")).sc.code).toBe("rate_limited")
        // a write answered 2xx, then a rate limit (e.g. on a follow-up step) → something may have changed → not refunded
        withUpstream(200)
        w.failNext(platform, "updateObject", platformError("rate_limited"))
        expect((await upd("D5 up b")).sc.code).toBe("rate_limited")
        expect((await upd("D5 up c")).sc.code).toBe("write_rate_limited")
      } finally {
        provider.updateObject = original
        __resetRateLimits()
      }
    })

    it("D5 with two-step on: the refused confirm_token stays consumed (its replay carries no stale retry_after_seconds); money caps unchanged", async () => {
      __resetRateLimits()
      const cur = acc().currency
      w.state.objects.get(acc().externalId)!.find((o) => o.id === "g1")!.budget = { type: "daily", amount: 100, level: "ad_group" }
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true, writeRateLimitPer10Min: 1, budgetChangeMaxPct: 500, maxDailyBudget: { [cur]: 120 } },
        platforms: { [platform]: { permissions: ["read", "update"], connections: [{ conn: conns[platform] }] } },
      })
      const confirmed = async (amount: number) => {
        const p = await w.call(mcp.key, "ads_update_budget", budgetArgs(amount))
        expect(p.sc.status, p.text).toBe("confirmation_required")
        return { token: p.sc.confirm_token as string, r: await w.call(mcp.key, "ads_update_budget", { ...budgetArgs(amount), confirm_token: p.sc.confirm_token }) }
      }
      w.failNext(platform, "updateBudget", platformError("rate_limited", 45_000))
      const first = await confirmed(110)
      expect(first.r.sc.code).toBe("rate_limited")
      expect(first.r.sc.retry_after_seconds).toBe(45)
      // the token is spent: its replay returns the stored failure, without the (now stale) wait
      const replay = await w.call(mcp.key, "ads_update_budget", { ...budgetArgs(110), confirm_token: first.token })
      expect(replay.isError).toBe(true)
      expect(replay.sc.code).toBe("rate_limited")
      expect(replay.sc).not.toHaveProperty("retry_after_seconds")
      // the cap still applies after a refund (it never depended on the write counter)
      expect((await w.call(mcp.key, "ads_update_budget", budgetArgs(130))).sc.code).toBe("budget_cap_exceeded")
      // a new preview + confirmation runs within the limit of 1 (the refused execution gave its slot back)
      const second = await confirmed(115)
      expect(second.r.isError, second.r.text).toBe(false)
      expect(w.state.objects.get(acc().externalId)!.find((o) => o.id === "g1")!.budget!.amount).toBe(115)
      // and the slot is now spent
      const third = await confirmed(118)
      expect(third.r.sc.code).toBe("write_rate_limited")
      __resetRateLimits()
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Mandatory daily caps (new MCPs) / legacy MCPs, and lifetime caps that follow the real flight
// (schedule changes, Meta CBO campaigns over their ad sets, ABO campaigns switched on with their ad sets).
describe.skipIf(!hasDb)("money caps: mandatory caps, legacy MCPs and lifetime flights (Meta)", { timeout: 300_000 }, () => {
  let w: World
  let conn: ConnInfo
  const DAY = 86_400_000
  const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString()
  const acc = () => demoAccounts(w.prefix, "meta")[0]! // VND
  const objs = () => w.state.objects.get(acc().externalId)!
  const obj = (id: string) => objs().find((o) => o.id === id)!
  const ALL = ["read", "status", "update", "copy", "create"] as const

  beforeAll(async () => {
    w = await World.create()
    conn = await w.connect(w.users.staff, "meta", demoAccounts(w.prefix, "meta"))
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => w.reset())

  const mk = (settings: Record<string, unknown> = {}) =>
    w.mcp(w.users.staff, {
      settings: { twoStepConfirm: false, budgetChangeMaxPct: 500, ...settings },
      platforms: { meta: { permissions: [...ALL], connections: [{ conn }] } },
    })
  const setStatus = (key: string, level: string, ids: string[], status = "active", extra: Record<string, unknown> = {}) =>
    w.call(key, "ads_set_status", { platform: "meta", account_id: acc().externalId, level, ids, status, ...extra })
  const budget = (key: string, level: string, id: string, budget_type: string, amount: number, extra: Record<string, unknown> = {}) =>
    w.call(key, "ads_update_budget", { platform: "meta", account_id: acc().externalId, level, id, budget_type, amount, ...extra })

  it("a legacy MCP (row without money_caps_required) still writes without caps, and its previews warn", async () => {
    w.seedObjects(acc().externalId, [
      { id: "c1", level: "campaign", name: "C1", status: "paused", parentId: null, budget: { type: "daily", amount: 9e9, level: "campaign" } },
    ])
    const mcp = await mk({ twoStepConfirm: true })
    await w.makeLegacy(mcp.id, { twoStepConfirm: true }) // no caps at all
    const p = await budget(mcp.key, "campaign", "c1", "daily", 1e10)
    expect(p.sc.status, p.text).toBe("confirmation_required")
    expect((p.sc.preview.warnings as string[])[0]).toMatch(/chưa đặt trần ngân sách\/ngày cho VND/)
    const on = await setStatus(mcp.key, "campaign", ["c1"])
    expect(on.sc.status, on.text).toBe("confirmation_required")
    expect((on.sc.preview.warnings as string[]).join(" ")).toMatch(/chưa đặt trần/)
    const done = await setStatus(mcp.key, "campaign", ["c1"], "active", { confirm_token: on.sc.confirm_token })
    expect(done.sc.status, done.text).toBe("success")
    const ext = await w.call(mcp.key, "meta_fake_create_adgroup", { account_id: acc().externalId, name: "G", daily_budget: 9e9 })
    expect(ext.sc.status, ext.text).toBe("confirmation_required")
    expect((ext.sc.preview.warnings as string[])[0]).toMatch(/chưa đặt trần/)
  })

  it("a new MCP without a daily cap for the account currency cannot start or raise spend (budget_cap_missing)", async () => {
    w.seedObjects(acc().externalId, [
      { id: "c1", level: "campaign", name: "C1", status: "paused", parentId: null, budget: { type: "daily", amount: 100, level: "campaign" } },
    ])
    const { mcpServers } = await import("@/server/db/schema")
    const { invalidateGrantCache } = await import("@/server/mcp/grant")
    const mcp = await mk()
    // e.g. the VND account was synced after the MCP was saved: caps required, no VND cap
    const [row] = await db.select({ settings: mcpServers.settings }).from(mcpServers).where(eq(mcpServers.id, mcp.id))
    const stored = row!.settings as { max_daily_budget: Record<string, number>; money_caps_required: boolean }
    expect(stored.money_caps_required).toBe(true)
    const { VND: _vnd, ...others } = stored.max_daily_budget
    await db.update(mcpServers).set({ settings: { ...stored, max_daily_budget: others } }).where(eq(mcpServers.id, mcp.id))
    invalidateGrantCache(mcp.id)
    const before = w.state.executions.length

    for (const r of [
      await setStatus(mcp.key, "campaign", ["c1"]),
      await budget(mcp.key, "campaign", "c1", "daily", 110),
      await w.call(mcp.key, "meta_fake_create_adgroup", { account_id: acc().externalId, name: "G", daily_budget: 10 }),
      await w.call(mcp.key, "ads_update_object", { platform: "meta", account_id: acc().externalId, level: "campaign", id: "c1", end_time: inDays(3) }),
    ]) {
      expect(r.sc.code, r.text).toBe("budget_cap_missing")
      expect(r.sc.hint).toMatch(/Cấu hình/)
    }
    expect(w.state.executions.length).toBe(before)
    // what cannot spend more stays allowed: pausing, renaming, creating without money
    expect((await setStatus(mcp.key, "campaign", ["c1"], "paused")).isError).toBe(false)
    expect((await w.call(mcp.key, "ads_update_object", { platform: "meta", account_id: acc().externalId, level: "campaign", id: "c1", name: "C1b" })).isError).toBe(false)
    expect((await w.call(mcp.key, "meta_fake_create_campaign", { account_id: acc().externalId, name: "N" })).isError).toBe(false)
  })

  it("pulling in the end of an ad set with a lifetime budget re-checks the lifetime cap on both steps", async () => {
    w.seedObjects(acc().externalId, [
      { id: "cg", level: "campaign", name: "CG", status: "active", parentId: null, budget: null },
      { id: "gl", level: "ad_group", name: "GL", status: "active", parentId: "cg", budget: { type: "lifetime", amount: 20_000, level: "ad_group" }, endTime: inDays(30) },
    ])
    const mcp = await mk({ twoStepConfirm: true, maxDailyBudget: { VND: 1000 } })
    const upd = (end: string, extra: Record<string, unknown> = {}) =>
      w.call(mcp.key, "ads_update_object", { platform: "meta", account_id: acc().externalId, level: "ad_group", id: "gl", end_time: end, ...extra })
    // 20 000 over 5 days = 4 000/day > 1 000/day cap
    const short = await upd(inDays(5))
    expect(short.sc.code, short.text).toBe("budget_cap_exceeded")
    expect(short.text).toMatch(/lịch chạy mới/)
    // 25 days: allowed at preview time …
    const end25 = inDays(25)
    const p = await upd(end25)
    expect(p.sc.status, p.text).toBe("confirmation_required")
    // … but the budget grew before the confirmation: refused at the confirm step, nothing executed
    obj("gl").budget = { type: "lifetime", amount: 28_000, level: "ad_group" }
    const before = w.state.executions.length
    const late = await upd(end25, { confirm_token: p.sc.confirm_token })
    expect(late.sc.code, late.text).toBe("budget_cap_exceeded")
    expect(w.state.executions.length).toBe(before)
  })

  it("a CBO lifetime campaign without stop_time is capped over its ad sets' flight, not 30 days", async () => {
    w.seedObjects(acc().externalId, [
      { id: "cb", level: "campaign", name: "CB", status: "paused", parentId: null, budget: { type: "lifetime", amount: 20_000, level: "campaign" } },
      // configured ACTIVE (the campaign is paused, so it does not deliver yet) - ends in 10 days
      { id: "cbA", level: "ad_group", name: "A", status: "paused", configuredStatus: "ACTIVE", parentId: "cb", budget: null, endTime: inDays(10) },
      { id: "cbB", level: "ad_group", name: "B", status: "paused", parentId: "cb", budget: null, endTime: inDays(60) },
    ])
    const mcp = await mk({ maxDailyBudget: { VND: 1000 } })
    // cap = 1 000 × 10 days (ad set A) = 10 000 < 20 000 (the old rule allowed 1 000 × 30 days)
    const on = await setStatus(mcp.key, "campaign", ["cb"])
    expect(on.sc.code, on.text).toBe("budget_cap_exceeded")
    expect(on.text).toMatch(/10 ngày/)
    expect(obj("cb").status).toBe("paused")
    // switching on ad set B too makes the flight 60 days: 60 000 ≥ 20 000
    const b = await setStatus(mcp.key, "ad_group", ["cbB"])
    expect(b.isError, b.text).toBe(false)
    // an ad set with no end and a campaign with no stop_time: the flight is unknown → refused
    obj("cbA").endTime = null
    const unknown = await setStatus(mcp.key, "campaign", ["cb"])
    expect(unknown.sc.code, unknown.text).toBe("budget_flight_unknown")
  })

  it("switching on an ABO campaign checks its ad sets that are configured on; paused ones are ignored", async () => {
    w.seedObjects(acc().externalId, [
      { id: "ab", level: "campaign", name: "AB", status: "paused", parentId: null, budget: null },
      { id: "abA", level: "ad_group", name: "A", status: "paused", configuredStatus: "ACTIVE", parentId: "ab", budget: { type: "daily", amount: 5000, level: "ad_group" } },
      { id: "abP", level: "ad_group", name: "P", status: "paused", parentId: "ab", budget: { type: "daily", amount: 9e9, level: "ad_group" } },
    ])
    const mcp = await mk({ maxDailyBudget: { VND: 1000 } })
    const on = await setStatus(mcp.key, "campaign", ["ab"])
    expect(on.sc.code, on.text).toBe("budget_cap_exceeded")
    expect(on.text).toMatch(/abA/)
    obj("abA").configuredStatus = "PAUSED"
    const ok = await setStatus(mcp.key, "campaign", ["ab"])
    expect(ok.isError, ok.text).toBe(false)
  })

  it("ads_update_budget on a CBO lifetime budget uses the ad-set flight", async () => {
    w.seedObjects(acc().externalId, [
      { id: "cu", level: "campaign", name: "CU", status: "active", parentId: null, budget: { type: "lifetime", amount: 5000, level: "campaign" } },
      { id: "cuA", level: "ad_group", name: "A", status: "active", parentId: "cu", budget: null, endTime: inDays(10) },
    ])
    const mcp = await mk({ maxDailyBudget: { VND: 1000 } })
    const over = await budget(mcp.key, "campaign", "cu", "lifetime", 12_000)
    expect(over.sc.code, over.text).toBe("budget_cap_exceeded")
    const ok = await budget(mcp.key, "campaign", "cu", "lifetime", 9000)
    expect(ok.isError, ok.text).toBe(false)
    expect(obj("cu").budget!.amount).toBe(9000)
  })
})
