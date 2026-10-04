import { describe, expect, it } from "vitest"
import { emptyMetrics } from "../../providers/types"
import { argsHash } from "../confirm"
import { decodeCursor, encodeCursor, queryHash } from "../cursor"
import { McpToolError } from "../errors"
import { collectFanout, positionAfter } from "../fanout"
import { assertGrant, assertPageGrant, dedupePages } from "../grant"
import { buildIpMatcher, clientIpFromHeaders, ipAllowed, normalizeIp } from "../net"
import { __resetRateLimits, consumeMcpRate, NOT_FOUND_LIMIT, notFoundBlocked, recordNotFound } from "../rate-limit"
import { clientFromUserAgent, peekMessages } from "../request-state"
import { parseMcpSettings } from "../settings"
import { assertSafeUrl, isBlockedAddress } from "../ssrf"
import { resolveMetrics, totalsByCurrency } from "../tools/common/report-math"
import { checkBudgetGuardrails } from "../tools/common/update-budget"
import { DEFAULT_MCP_SETTINGS, type McpGrant } from "../types"

describe("net", () => {
  it("normalizes IPs", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1")
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1")
    expect(normalizeIp("1.2.3.4:5678")).toBe("1.2.3.4")
    expect(normalizeIp("nope")).toBeNull()
  })
  it("takes the first X-Forwarded-For hop", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })
    expect(clientIpFromHeaders(h)).toBe("203.0.113.5")
    expect(clientIpFromHeaders(new Headers())).toBeNull()
  })
  it("matches single IPs and CIDR (v4 + v6)", () => {
    const m = buildIpMatcher(["1.2.3.4", "10.0.0.0/8", "2001:db8::/32", "garbage", "1.1.1.1/40"])
    expect(m.invalid).toEqual(["garbage", "1.1.1.1/40"])
    expect(m.matches("1.2.3.4")).toBe(true)
    expect(m.matches("10.200.3.4")).toBe(true)
    expect(m.matches("::ffff:10.1.1.1")).toBe(true)
    expect(m.matches("2001:db8:1::5")).toBe(true)
    expect(m.matches("11.0.0.1")).toBe(false)
    expect(m.matches(null)).toBe(false)
    expect(ipAllowed([], null)).toBe(true)
    expect(ipAllowed(["10.0.0.0/8"], null)).toBe(false)
  })
})

describe("ssrf", () => {
  it.each(["127.0.0.1", "169.254.169.254", "10.1.2.3", "192.168.1.1", "172.16.0.5", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1"])(
    "blocks %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(true)
  )
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false))

  it.each([
    "http://127.0.0.1/a.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.8/x.jpg",
    "http://[::1]/x.jpg",
    "http://localhost/x.jpg",
    "http://metadata.google.internal/x",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "https://user:pass@example.com/x.png",
    "https://example.com:22/x.png",
  ])("rejects %s", async (url) => {
    await expect(assertSafeUrl(url, (async () => [{ address: "93.184.216.34", family: 4 }]) as never)).rejects.toBeInstanceOf(McpToolError)
  })

  it("rejects hostnames resolving to private addresses (any record)", async () => {
    const resolver = (async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]) as never
    await expect(assertSafeUrl("https://evil.example/x.png", resolver)).rejects.toMatchObject({ code: "url_not_allowed" })
  })

  it("accepts public hosts", async () => {
    const resolver = (async () => [{ address: "93.184.216.34", family: 4 }]) as never
    await expect(assertSafeUrl("https://cdn.example.com/a.png", resolver)).resolves.toBeInstanceOf(URL)
  })
})

describe("settings", () => {
  it("parses snake_case with defaults and keeps valid caps", () => {
    const s = parseMcpSettings({ two_step_confirm: false, max_daily_budget: { vnd: 5_000_000, usd: -1, XX: 3 }, allowed_ips: ["1.2.3.4"] })
    expect(s).toEqual({ ...DEFAULT_MCP_SETTINGS, twoStepConfirm: false, maxDailyBudget: { VND: 5_000_000 }, allowedIps: ["1.2.3.4"] })
  })
  it("falls back to safe defaults for garbage, field by field", () => {
    expect(parseMcpSettings({ twoStepConfirm: "no", rateLimitPerMin: -5 })).toEqual(DEFAULT_MCP_SETTINGS)
    expect(parseMcpSettings(null)).toEqual(DEFAULT_MCP_SETTINGS)
    expect(parseMcpSettings({ rate_limit_per_min: 3, two_step_confirm: "x" })).toMatchObject({ rateLimitPerMin: 3, twoStepConfirm: true })
  })
  it("fails closed on a corrupt allowlist", () => {
    const s = parseMcpSettings({ allowed_ips: "10.0.0.0/8" })
    expect(s.allowedIps.length).toBe(1)
    expect(ipAllowed(s.allowedIps, "10.0.0.1")).toBe(false)
  })
})

describe("grant checks", () => {
  const grant: McpGrant = {
    mcpId: "m",
    mcpName: "m",
    ownerId: "u",
    ownerEmail: "u@x",
    ownerRole: "staff",
    settings: DEFAULT_MCP_SETTINGS,
    permissions: { meta: ["read", "status"] },
    accounts: [{ id: "a1", connectionId: "c1", platform: "meta", externalId: "act_1", name: "A", currency: "VND", timezone: "Asia/Ho_Chi_Minh" }],
    pages: [
      {
        id: "p1",
        connectionId: "c1",
        externalId: "111",
        name: "Trang A",
        category: null,
        followersCount: 10,
        verificationStatus: null,
        tasks: ["ANALYZE"],
        businessName: null,
      },
    ],
  }
  it("accepts a granted Page and refuses others / an MCP without Meta read", () => {
    expect(assertPageGrant(grant, "111").id).toBe("p1")
    expect(assertPageGrant(grant, " 111 ").id).toBe("p1")
    expect(() => assertPageGrant(grant, "222")).toThrow(/không thuộc phạm vi/)
    expect(() => assertPageGrant({ ...grant, permissions: { openai_ads: ["read"] } }, "111")).toThrow(/không có quyền/)
  })
  it("dedupes a Page reachable through several connections (ANALYZE first, then healthiest, then oldest)", () => {
    const base = { externalId: "111", connectionCreatedAt: new Date("2026-01-01") }
    const rows = [
      { ...base, id: "x", tasks: ["MODERATE"], connectionStatus: "active" },
      { ...base, id: "y", tasks: ["ANALYZE"], connectionStatus: "expiring" },
      { ...base, id: "z", tasks: ["ANALYZE"], connectionStatus: "active", connectionCreatedAt: new Date("2026-02-01") },
    ]
    expect(dedupePages(rows).map((r) => r.id)).toEqual(["z"])
    expect(dedupePages(rows.slice(0, 2)).map((r) => r.id)).toEqual(["y"])
  })
  it("accepts granted account (with or without act_)", () => {
    expect(assertGrant(grant, { platform: "meta", accountId: "act_1", permission: "status" }).id).toBe("a1")
    expect(assertGrant(grant, { platform: "meta", accountId: "1", permission: "read" }).id).toBe("a1")
  })
  it("rejects foreign accounts, missing permissions and other platforms", () => {
    expect(() => assertGrant(grant, { platform: "meta", accountId: "act_2", permission: "read" })).toThrow(/không thuộc phạm vi/)
    expect(() => assertGrant(grant, { platform: "meta", accountId: "act_1", permission: "update" })).toThrow(McpToolError)
    expect(() => assertGrant(grant, { platform: "openai_ads", accountId: "act_1", permission: "read" })).toThrow(McpToolError)
  })
})

describe("confirm args hash", () => {
  it("ignores key order, confirm_token, idempotency_key and reason", () => {
    const a = argsHash("t", { b: 1, a: { y: 2, x: 1 }, confirm_token: "x", reason: "r" })
    const b = argsHash("t", { a: { x: 1, y: 2 }, b: 1, idempotency_key: "k" })
    expect(a).toBe(b)
    expect(argsHash("t", { b: 2, a: { x: 1, y: 2 } })).not.toBe(b)
    expect(argsHash("other", { a: { x: 1, y: 2 }, b: 1 })).not.toBe(b)
  })
})

describe("cursor", () => {
  const bind = { mcpId: "m1", tool: "ads_get_report", accountIds: ["a1", "a2"], query: { q: 1 } }
  it("round-trips and binds to MCP, tool, accounts and query", () => {
    const c = encodeCursor({ i: 2 }, bind)
    expect(decodeCursor<{ i: number }>(c, bind).i).toBe(2)
    // account order does not matter
    expect(decodeCursor<{ i: number }>(c, { ...bind, accountIds: ["a2", "a1"] }).i).toBe(2)
    for (const other of [
      { ...bind, query: { q: 2 } },
      { ...bind, mcpId: "m2" },
      { ...bind, tool: "ads_list_objects" },
      { ...bind, accountIds: ["a1"] },
    ]) {
      expect(() => decodeCursor(c, other)).toThrow(McpToolError)
    }
    expect(() => decodeCursor("!!!", bind)).toThrow(McpToolError)
    expect(queryHash({ q: 1 })).toHaveLength(12)
  })
  it("rejects tampered and forged cursors (H2)", () => {
    const c = encodeCursor({ m: "q", i: 0, c: "adapter-cursor" }, bind)
    const [body, sig] = c.split(".") as [string, string]
    const forgedBody = Buffer.from(JSON.stringify({ m: "q", i: 0, c: "attacker-run-id" })).toString("base64url")
    for (const bad of [`${forgedBody}.${sig}`, forgedBody, `${body}.`, `${body}.${"A".repeat(43)}`, `${body}`]) {
      expect(() => decodeCursor(bad, bind), bad.slice(0, 20)).toThrow(/cursor không hợp lệ/)
    }
  })
})

describe("fan-out", () => {
  const sources = [10, 0, 7, 3]
  const fetch = async (i: number, cursor: string | null, size: number) => {
    const total = sources[i]!
    const off = cursor ? Number(cursor) : 0
    const items = Array.from({ length: Math.min(size, Math.max(0, total - off)) }, (_, k) => `${i}:${off + k}`)
    return { items, nextCursor: off + size < total ? String(off + size) : null }
  }
  it("pages through every item exactly once, also when pages are cut short", async () => {
    const seen: string[] = []
    let start = { i: 0, c: null as string | null, s: 0, p: 4 }
    for (let guard = 0; guard < 50; guard++) {
      const r = await collectFanout({ sourceCount: sources.length, start, maxItems: 4, pageSize: 4, concurrency: 3, fetch })
      // simulate a size cut: keep only 3 of 4
      const kept = Math.min(3, r.items.length)
      seen.push(...r.items.slice(0, kept).map((x) => x.item))
      const next = positionAfter(r, kept)
      if (!next) break
      start = { ...next, c: next.c }
    }
    expect(seen.length).toBe(20)
    expect(new Set(seen).size).toBe(20)
  })
  it("reports per-source errors and continues", async () => {
    const r = await collectFanout({
      sourceCount: 3,
      start: { i: 0, c: null, s: 0, p: 10 },
      maxItems: 100,
      pageSize: 10,
      concurrency: 2,
      fetch: async (i) => {
        if (i === 1) throw new Error("boom")
        return { items: [i], nextCursor: null }
      },
    })
    expect(r.items.map((x) => x.item)).toEqual([0, 2])
    expect(r.errors.map((e) => e.index)).toEqual([1])
    expect(r.end).toBeNull()
  })
})

describe("report math", () => {
  it("never sums across currencies and recomputes ratios", () => {
    const m = (spend: number, clicks: number, impressions: number) => ({ ...emptyMetrics(), spend, clicks, impressions })
    const totals = totalsByCurrency(
      [
        { currency: "VND", accountKey: "a", metrics: m(100_000, 10, 1000) },
        { currency: "VND", accountKey: "b", metrics: m(50_000, 5, 500) },
        { currency: "USD", accountKey: "c", metrics: m(12.345, 3, 300) },
      ],
      resolveMetrics("basic").keys
    )
    expect(totals.map((t) => t.currency)).toEqual(["USD", "VND"])
    const vnd = totals.find((t) => t.currency === "VND")!
    expect(vnd.metrics.spend).toBe(150_000)
    expect(vnd.metrics.ctr).toBe(1)
    expect(vnd.metrics.cpc).toBe(10_000)
    expect(vnd.metrics.reach).toBeNull()
    expect(vnd.accounts).toBe(2)
    expect(totals.find((t) => t.currency === "USD")!.metrics.spend).toBe(12.35)
  })
  it("picks the smallest adapter preset", () => {
    expect(resolveMetrics(["spend", "ctr"]).preset).toBe("basic")
    expect(resolveMetrics(["spend", "cpa"]).preset).toBe("conversion")
    expect(resolveMetrics(["video_views", "cpa"]).preset).toBe("all")
  })
})

describe("budget guardrails", () => {
  const settings = { ...DEFAULT_MCP_SETTINGS, budgetChangeMaxPct: 50, maxDailyBudget: { VND: 1_000_000 } }
  const current = { type: "daily" as const, amount: 500_000, currency: "VND", level: "ad_group" as const }
  it("rejects changes above the max %", () => {
    expect(() => checkBudgetGuardrails(settings, current, { type: "daily", amount: 800_000, currency: "VND" })).toThrow(/vượt giới hạn ±50%/)
    expect(() => checkBudgetGuardrails(settings, current, { type: "daily", amount: 200_000, currency: "VND" })).toThrow(McpToolError)
  })
  it("rejects above the per-currency daily cap", () => {
    const big = { ...current, amount: 900_000 }
    expect(() => checkBudgetGuardrails(settings, big, { type: "daily", amount: 1_200_000, currency: "VND" })).toThrow(/vượt trần/)
  })
  it("rejects budget type switches and accepts in-range changes", () => {
    expect(() => checkBudgetGuardrails(settings, current, { type: "lifetime", amount: 500_000, currency: "VND" })).toThrow(McpToolError)
    expect(checkBudgetGuardrails(settings, current, { type: "daily", amount: 750_000, currency: "VND" }).changePct).toBe(50)
  })
})

describe("rate limits", () => {
  it("token bucket per MCP", () => {
    __resetRateLimits()
    const t = 1_000_000
    expect(consumeMcpRate("m1", 2, t).ok).toBe(true)
    expect(consumeMcpRate("m1", 2, t).ok).toBe(true)
    const d = consumeMcpRate("m1", 2, t)
    expect(d.ok).toBe(false)
    expect(d.retryAfterSec).toBeGreaterThan(0)
    expect(consumeMcpRate("m1", 2, t + 31_000).ok).toBe(true)
  })
  it("blocks IPs guessing keys", () => {
    __resetRateLimits()
    for (let i = 0; i < NOT_FOUND_LIMIT; i++) recordNotFound("198.51.100.1")
    expect(notFoundBlocked("198.51.100.1").ok).toBe(false)
    expect(notFoundBlocked("198.51.100.2").ok).toBe(true)
  })
})

describe("request state", () => {
  it("parses user agents and JSON-RPC bodies", () => {
    expect(clientFromUserAgent("claude-code/2.1.0 (cli)")).toEqual({ name: "claude-code", version: "2.1.0" })
    expect(peekMessages([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }]).map((m) => m.kind)).toEqual([
      "request",
      "notification",
    ])
  })
})
