// Unit tests for the security-review fixes that need no database.
import { describe, expect, it } from "vitest"
import { fetchMediaBytes, safeFetch, sniffImageMime } from "../../net/ssrf"
import { McpToolError } from "../errors"
import { isAdminRole } from "../grant"
import { enforceMoneyItems, flightDays, lifetimeLimit, moneyLikePaths } from "../guardrails"
import { parseMcpSettings } from "../settings"
import { writeIdempotencyKey } from "../tool"
import { checkCumulativeBudget } from "../tools/common/update-budget"
import { DEFAULT_MCP_SETTINGS } from "../types"
import { clientIpFromHeaders, ipBucketKey } from "../net"
import {
  __resetRateLimits,
  consumeMcpRate,
  consumeWriteRate,
  NOT_FOUND_LIMIT,
  notFoundBlocked,
  recordNotFound,
  WRITE_WINDOW_MS,
} from "../rate-limit"
import { rateCost } from "../serve"

describe("L4 client IP", () => {
  it("never trusts X-Real-IP", () => {
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.1" }))).toBeNull()
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.2" }))).toBe("203.0.113.2")
  })
})

describe("L5 admin role", () => {
  it("only the exact role 'admin' is admin", () => {
    expect(isAdminRole("admin")).toBe(true)
    for (const r of ["staff,admin", "admin,staff", " admin", "Admin", "ADMIN", "", null, undefined, "superadmin"]) {
      expect(isAdminRole(r), String(r)).toBe(false)
    }
  })
})

describe("M2 key-guessing limiter", () => {
  it("groups IPv6 clients by /64 and keeps IPv4 per address", () => {
    expect(ipBucketKey("2001:db8:1:2:aaaa::1")).toBe(ipBucketKey("2001:db8:1:2:ffff:ffff:ffff:ffff"))
    expect(ipBucketKey("2001:db8:1:2::1")).not.toBe(ipBucketKey("2001:db8:1:3::1"))
    expect(ipBucketKey("::ffff:203.0.113.4")).toBe("203.0.113.4")
    expect(ipBucketKey("203.0.113.4")).not.toBe(ipBucketKey("203.0.113.5"))
    expect(ipBucketKey(null)).toBe("unknown")
  })
  it("rotating addresses inside one /64 does not escape the limit", () => {
    __resetRateLimits()
    for (let i = 0; i < NOT_FOUND_LIMIT; i++) recordNotFound(`2001:db8:9:9::${(i + 1).toString(16)}`)
    expect(notFoundBlocked("2001:db8:9:9::ffff").ok).toBe(false)
    expect(notFoundBlocked("2001:db8:9:a::1").ok).toBe(true)
  })
})

describe("M3 per-message charging", () => {
  it("charges a JSON-RPC batch per message (responses are free)", () => {
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ads_list_accounts", arguments: {} } })
    expect(rateCost(call(1))).toBe(1)
    expect(rateCost(null)).toBe(1)
    expect(rateCost(Array.from({ length: 80 }, (_, i) => call(i)))).toBe(80)
    expect(rateCost([call(1), { jsonrpc: "2.0", id: 9, result: {} }])).toBe(1)
  })
  it("a cost larger than the remaining tokens is refused; larger than the capacity never passes", () => {
    __resetRateLimits()
    const t = 5_000_000
    expect(consumeMcpRate("b1", 10, t, 8).ok).toBe(true)
    expect(consumeMcpRate("b1", 10, t, 3).ok).toBe(false)
    expect(consumeMcpRate("b1", 10, t, 2).ok).toBe(true)
    __resetRateLimits()
    const big = consumeMcpRate("b2", 10, t, 11)
    expect(big.ok).toBe(false)
    expect(big.retryAfterSec).toBe(60)
  })
})

describe("H1 money guardrails", () => {
  const s = { ...DEFAULT_MCP_SETTINGS, maxDailyBudget: { VND: 1_000_000 }, maxBid: { VND: 50_000 } }
  const now = Date.parse("2026-10-02T00:00:00Z")
  it("lifetime cap = daily cap × flight days, 30 days without an end, explicit cap on top", () => {
    expect(flightDays({ endTime: "2026-10-05T00:00:00Z" }, now)).toBe(3)
    expect(flightDays({ startTime: "2026-10-03", endTime: "2026-10-04" }, now)).toBe(2)
    expect(flightDays({ endTime: "2026-10-04 12:00:00" }, now)).toBe(3)
    expect(flightDays({}, now)).toBeNull()
    expect(lifetimeLimit(s, "VND", { endTime: "2026-10-05T00:00:00Z" }, now)?.limit).toBe(3_000_000)
    expect(lifetimeLimit(s, "VND", {}, now)?.limit).toBe(30_000_000)
    expect(lifetimeLimit({ ...s, maxLifetimeBudget: { VND: 2_000_000 } }, "VND", {}, now)?.limit).toBe(2_000_000)
    expect(lifetimeLimit(DEFAULT_MCP_SETTINGS, "VND", {}, now)).toBeNull()
  })
  it("enforces daily, lifetime and bid items (other currencies untouched)", () => {
    expect(() => enforceMoneyItems(s, "VND", [{ kind: "daily_budget", amount: 1_000_001, field: "b" }], now)).toThrow(/vượt trần/)
    expect(() => enforceMoneyItems(s, "VND", [{ kind: "lifetime_budget", amount: 3_000_001, field: "b", endTime: "2026-10-05T00:00:00Z" }], now)).toThrow(McpToolError)
    expect(() => enforceMoneyItems(s, "VND", [{ kind: "bid", amount: 50_001, field: "bid" }], now)).toThrow(/giá thầu/)
    expect(() => enforceMoneyItems(s, "USD", [{ kind: "daily_budget", amount: 9e9, field: "b" }], now)).not.toThrow()
    expect(() => enforceMoneyItems(s, "VND", [{ kind: "daily_budget", amount: 1_000_000, field: "b" }, { kind: "bid", amount: 50_000, field: "x" }], now)).not.toThrow()
  })
  it("finds money-like values in undeclared inputs", () => {
    expect(moneyLikePaths({ name: "x", budget: 5, nested: { bid_amount: "12" }, budget_mode: "DAY", items: [{ cpc_bid: 1 }] })).toEqual([
      "budget",
      "nested.bid_amount",
      "items.0.cpc_bid",
    ])
    expect(moneyLikePaths({ name: "x", age_min: 18 })).toEqual([])
  })
  it("settings parse the new optional fields (snake_case) with safe defaults", () => {
    const p = parseMcpSettings({ max_bid: { vnd: 10_000 }, max_lifetime_budget: { USD: 500 }, write_rate_limit_per_10min: 5 })
    expect(p).toMatchObject({ maxBid: { VND: 10_000 }, maxLifetimeBudget: { USD: 500 }, writeRateLimitPer10Min: 5 })
    expect(parseMcpSettings({ write_rate_limit_per_10min: 0 }).writeRateLimitPer10Min).toBe(20)
  })
})

describe("M5 cumulative budget guard", () => {
  const s = { ...DEFAULT_MCP_SETTINGS, budgetChangeMaxPct: 50 }
  it("measures against the earliest value of the 24 h window", () => {
    expect(() => checkCumulativeBudget(s, { amount: 100_000, type: "daily" }, { type: "daily", amount: 200_000, currency: "VND" })).toThrow(/24 giờ/)
    expect(() => checkCumulativeBudget(s, { amount: 100_000, type: "daily" }, { type: "daily", amount: 40_000, currency: "VND" })).toThrow(McpToolError)
    expect(() => checkCumulativeBudget(s, { amount: 100_000, type: "daily" }, { type: "daily", amount: 150_000, currency: "VND" })).not.toThrow()
    expect(() => checkCumulativeBudget(s, null, { type: "daily", amount: 9e9, currency: "VND" })).not.toThrow()
    expect(() => checkCumulativeBudget(s, { amount: 100_000, type: "lifetime" }, { type: "daily", amount: 9e9, currency: "VND" })).not.toThrow()
  })
})

describe("deterministic write idempotency keys", () => {
  const base = { mcpId: "m1", toolName: "ads_set_status", args: { ids: ["1"], status: "paused" } as Record<string, unknown> }
  it("is stable, never random, and scoped", () => {
    const t = Date.parse("2026-10-02T10:00:10Z")
    const a = writeIdempotencyKey({ ...base, pendingActionId: null }, t)
    expect(a).toMatch(/^mcpw-[0-9a-f]{40}$/)
    expect(writeIdempotencyKey({ ...base, pendingActionId: null }, t + 20_000)).toBe(a)
    expect(writeIdempotencyKey({ ...base, pendingActionId: null }, t + 60_000)).not.toBe(a)
    expect(writeIdempotencyKey({ ...base, args: { ...base.args, confirm_token: "x", reason: "r" }, pendingActionId: null }, t)).toBe(a)
    expect(writeIdempotencyKey({ ...base, pendingActionId: "pa-1" }, t)).toBe(writeIdempotencyKey({ ...base, pendingActionId: "pa-1" }, t + 9e9))
    expect(writeIdempotencyKey({ ...base, pendingActionId: "pa-1" })).not.toBe(writeIdempotencyKey({ ...base, pendingActionId: "pa-2" }))
  })

  it("a client idempotency_key is bound to the args; a confirmed action always uses its pending-action id", () => {
    const user = { ...base, args: { ...base.args, idempotency_key: "k" } }
    const k = writeIdempotencyKey({ ...user, pendingActionId: null })
    // same args + same key → same adapter key, whatever the time
    expect(writeIdempotencyKey({ ...user, pendingActionId: null }, Date.now() + 9e9)).toBe(k)
    // same key with other args → another write
    expect(writeIdempotencyKey({ ...user, args: { ...user.args, status: "active" }, pendingActionId: null })).not.toBe(k)
    // other MCP / other key → different
    expect(writeIdempotencyKey({ ...user, mcpId: "m2", pendingActionId: null })).not.toBe(k)
    expect(writeIdempotencyKey({ ...user, args: { ...user.args, idempotency_key: "k2" }, pendingActionId: null })).not.toBe(k)
    // with a pending action the client key is ignored
    expect(writeIdempotencyKey({ ...user, pendingActionId: "pa-1" })).toBe(writeIdempotencyKey({ ...base, pendingActionId: "pa-1" }))
    expect(writeIdempotencyKey({ ...user, pendingActionId: "pa-1" })).not.toBe(writeIdempotencyKey({ ...user, pendingActionId: "pa-9" }))
  })
})

describe("M1 media download", () => {
  it("sniffs image types from magic bytes", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png")
    expect(sniffImageMime(new TextEncoder().encode("GIF89a..."))).toBe("image/gif")
    expect(sniffImageMime(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBP"))).toBe("image/webp")
    expect(sniffImageMime(new TextEncoder().encode("<html>"))).toBeNull()
    expect(sniffImageMime(new Uint8Array())).toBeNull()
  })
  it("fetchMediaBytes refuses internal targets before any connection", async () => {
    for (const url of ["http://127.0.0.1/a.png", "http://[::1]/a.png", "http://169.254.169.254/x", "http://localhost/a.png"]) {
      await expect(fetchMediaBytes(url)).rejects.toMatchObject({ code: "url_not_allowed" })
    }
  })
  it("old import path still re-exports the guard", async () => {
    const legacy = await import("../ssrf")
    expect(legacy.safeFetch).toBe(safeFetch)
  })
})

describe("M5 write rate limit", () => {
  it("allows N executed writes per 10 minutes per MCP", () => {
    __resetRateLimits()
    const t = 9_000_000
    for (let i = 0; i < 3; i++) expect(consumeWriteRate("w1", 3, t + i).ok).toBe(true)
    const d = consumeWriteRate("w1", 3, t + 10)
    expect(d.ok).toBe(false)
    expect(d.retryAfterSec).toBeGreaterThan(0)
    expect(consumeWriteRate("w2", 3, t + 10).ok).toBe(true)
    expect(consumeWriteRate("w1", 3, t + WRITE_WINDOW_MS + 1).ok).toBe(true)
  })
})
