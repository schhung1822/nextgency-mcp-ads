// Protection mode "basic" / "advanced" (v1.0.10): parsing (rows saved before the mode existed stay advanced), the
// effective settings the endpoint enforces, and every runtime consumer of a limit that becomes UNLIMITED in basic
// mode (never fed into limiter arithmetic, never printed as "Infinity").
import { describe, expect, it } from "vitest"
import { McpToolError } from "../errors"
import { legacyCapWarning, requireMoneyCaps } from "../guardrails"
import {
  __resetRateLimits,
  consumeMcpRate,
  consumeWriteRate,
} from "../rate-limit"
import { effectiveMcpSettings, parseMcpSettings } from "../settings"
import { admitWrite } from "../tool"
import {
  checkBudgetGuardrails,
  checkCumulativeBudget,
} from "../tools/common/update-budget"
import {
  DEFAULT_MCP_SETTINGS,
  isUnlimited,
  UNLIMITED,
  type McpGrant,
  type McpSettings,
} from "../types"
import { strictDailySpendGuard, writeOptions } from "../write-options"

/** stored advanced values of a basic MCP: kept in the row, not enforced */
const STORED = {
  protection_mode: "basic",
  two_step_confirm: true,
  budget_change_max_pct: 10,
  max_daily_budget: { VND: 100_000 },
  max_lifetime_budget: { VND: 1_000_000 },
  max_bid: { VND: 5_000 },
  rate_limit_per_min: 2,
  write_rate_limit_per_10min: 1,
  allowed_ips: ["10.0.0.0/8"],
  money_caps_required: true,
  telegram_tool: true,
  telegram_notify_writes: true,
  telegram_messages_per_hour: 1,
  drive_public_links: false,
  drive_sheet_writeback: false,
  tiktok_gmv_max_write: true,
}

const basic = (): McpSettings => effectiveMcpSettings(parseMcpSettings(STORED))
const advanced = (): McpSettings =>
  effectiveMcpSettings(
    parseMcpSettings({ ...STORED, protection_mode: "advanced" })
  )

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe("parseMcpSettings - protection mode", () => {
  it("rows saved before the mode existed (no key) and corrupt values are advanced; new values parse both cases", () => {
    expect(DEFAULT_MCP_SETTINGS.protectionMode).toBe("advanced")
    expect(parseMcpSettings(null).protectionMode).toBe("advanced")
    expect(
      parseMcpSettings({ two_step_confirm: false, rate_limit_per_min: 5 })
        .protectionMode
    ).toBe("advanced")
    expect(parseMcpSettings({ protection_mode: "basic" }).protectionMode).toBe(
      "basic"
    )
    expect(parseMcpSettings({ protectionMode: "basic" }).protectionMode).toBe(
      "basic"
    )
    expect(
      parseMcpSettings({ protection_mode: "advanced" }).protectionMode
    ).toBe("advanced")
    for (const garbage of ["BASIC", "none", "", 1, true, null, {}, []]) {
      expect(
        parseMcpSettings({ protection_mode: garbage }).protectionMode
      ).toBe("advanced")
    }
  })

  it("the stored advanced values of a basic MCP are parsed unchanged (the editor shows them)", () => {
    const raw = parseMcpSettings(STORED)
    expect(raw).toMatchObject({
      protectionMode: "basic",
      twoStepConfirm: true,
      budgetChangeMaxPct: 10,
      maxDailyBudget: { VND: 100_000 },
      rateLimitPerMin: 2,
      writeRateLimitPer10Min: 1,
      allowedIps: ["10.0.0.0/8"],
      moneyCapsRequired: true,
      telegramMessagesPerHour: 1,
    })
  })
})

describe("effectiveMcpSettings", () => {
  it("basic: every limit off except the expiry; the non-limit switches are kept", () => {
    const s = basic()
    expect(s).toMatchObject({
      protectionMode: "basic",
      twoStepConfirm: false,
      maxDailyBudget: {},
      maxLifetimeBudget: {},
      maxBid: {},
      allowedIps: [],
      moneyCapsRequired: false,
      // not limits: unchanged
      telegramTool: true,
      telegramNotifyWrites: true,
      drivePublicLinks: false,
      driveSheetWriteback: false,
      tiktokGmvMaxWrite: true,
    })
    for (const n of [
      s.budgetChangeMaxPct,
      s.rateLimitPerMin,
      s.writeRateLimitPer10Min,
      s.telegramMessagesPerHour,
    ]) {
      expect(isUnlimited(n)).toBe(true)
    }
  })

  it("advanced (and legacy rows) are returned as stored; the input object is never mutated", () => {
    const raw = parseMcpSettings({ ...STORED, protection_mode: "advanced" })
    expect(effectiveMcpSettings(raw)).toBe(raw)
    const legacy = parseMcpSettings({
      rate_limit_per_min: 7,
      allowed_ips: ["1.2.3.4"],
    })
    expect(effectiveMcpSettings(legacy)).toMatchObject({
      rateLimitPerMin: 7,
      allowedIps: ["1.2.3.4"],
      twoStepConfirm: true,
    })
    const b = parseMcpSettings(STORED)
    effectiveMcpSettings(b)
    expect(b.rateLimitPerMin).toBe(2)
    expect(b.maxDailyBudget).toEqual({ VND: 100_000 })
  })

  it("isUnlimited: only UNLIMITED itself (a NaN never opens a limit)", () => {
    expect(isUnlimited(UNLIMITED)).toBe(true)
    expect(isUnlimited(Number.NaN)).toBe(false)
    expect(isUnlimited(0)).toBe(false)
    expect(isUnlimited(10_000)).toBe(false)
  })
})

describe("basic mode: limiters never see Infinity", () => {
  const mcpId = "00000000-0000-4000-8000-0000000000b1"
  const grant = (settings: McpSettings) =>
    ({ mcpId, settings }) as unknown as McpGrant

  it("consumeMcpRate / consumeWriteRate accept everything with an unlimited limit (no NaN bucket)", () => {
    __resetRateLimits()
    for (let i = 0; i < 500; i++) {
      expect(consumeMcpRate(mcpId, UNLIMITED, Date.now(), 50).ok).toBe(true)
      expect(consumeWriteRate(mcpId, UNLIMITED).ok).toBe(true)
    }
    // a later finite limit on the same MCP starts from a clean, working bucket
    expect(consumeMcpRate(mcpId, 1).ok).toBe(true)
    expect(consumeMcpRate(mcpId, 1).ok).toBe(false)
    __resetRateLimits()
  })

  it("a NaN limit (bug) falls back to the default limit, never unlimited", () => {
    __resetRateLimits()
    let ok = 0
    for (let i = 0; i < 1000; i++) if (consumeMcpRate(mcpId, Number.NaN).ok) ok++
    expect(ok).toBe(DEFAULT_MCP_SETTINGS.rateLimitPerMin)
    ok = 0
    for (let i = 0; i < 1000; i++) if (consumeWriteRate(mcpId, Number.NaN).ok) ok++
    expect(ok).toBe(DEFAULT_MCP_SETTINGS.writeRateLimitPer10Min)
    __resetRateLimits()
  })

  it("admitWrite: no write limit in basic; advanced keeps write_rate_limited", () => {
    __resetRateLimits()
    for (let i = 0; i < 100; i++)
      expect(() => admitWrite(grant(basic()))).not.toThrow()
    __resetRateLimits()
    admitWrite(grant(advanced()))
    const e = thrown(() => admitWrite(grant(advanced())))
    expect(e).toBeInstanceOf(McpToolError)
    expect(e).toMatchObject({ code: "write_rate_limited" })
    __resetRateLimits()
  })
})

describe("basic mode: money guardrails", () => {
  it("legacyCapWarning: none in basic (no caps on purpose); a legacy advanced MCP without a cap still warns", () => {
    expect(legacyCapWarning(basic(), "VND")).toEqual([])
    expect(legacyCapWarning(basic(), "USD")).toEqual([])
    expect(legacyCapWarning(DEFAULT_MCP_SETTINGS, "VND")).toHaveLength(1)
  })

  it("requireMoneyCaps passes in basic although the stored row is 'caps required'", () => {
    expect(() =>
      requireMoneyCaps(basic(), "USD", "đổi ngân sách")
    ).not.toThrow()
    expect(
      thrown(() => requireMoneyCaps(advanced(), "USD", "đổi ngân sách"))
    ).toMatchObject({ code: "budget_cap_missing" })
  })

  it("checkBudgetGuardrails: no % limit and no caps in basic, no 'Infinity' in any text; advanced still refuses", () => {
    const current = { type: "daily" as const, amount: 100_000, currency: "VND", level: "ad_group" as const }
    const next = { type: "daily" as const, amount: 1_000_000, currency: "VND" }
    const r = checkBudgetGuardrails(basic(), current, next)
    expect(r.changePct).toBeCloseTo(900)
    expect(r.warnings.join(" ")).toMatch(/tăng 900/)
    expect(JSON.stringify(r)).not.toMatch(/Infinity|NaN/)
    // lifetime: no lifetime cap either
    expect(() =>
      checkBudgetGuardrails(
        basic(),
        { ...current, type: "lifetime" },
        { ...next, type: "lifetime", amount: 1e12 }
      )
    ).not.toThrow()
    // the budget type rule is not a limit of the mode: still refused
    expect(
      thrown(() =>
        checkBudgetGuardrails(basic(), current, { ...next, type: "lifetime" })
      )
    ).toMatchObject({ code: "budget_type_change" })
    expect(
      thrown(() => checkBudgetGuardrails(advanced(), current, next))
    ).toMatchObject({ code: "budget_change_too_large" })
  })

  it("checkCumulativeBudget: no 24 h rule in basic; advanced still refuses", () => {
    const baseline = { amount: 100_000, type: "daily" as const }
    const next = { type: "daily" as const, amount: 5_000_000, currency: "VND" }
    expect(() => checkCumulativeBudget(basic(), baseline, next)).not.toThrow()
    expect(
      thrown(() => checkCumulativeBudget(advanced(), baseline, next))
    ).toMatchObject({ code: "budget_cumulative_change_too_large" })
  })

  it("strictDailySpendGuard: a no-op in basic; advanced keeps the mandatory daily cap", () => {
    expect(() =>
      strictDailySpendGuard(basic())([
        { label: "x", amount: 1e12, currency: "USD" },
      ])
    ).not.toThrow()
    expect(
      thrown(() =>
        strictDailySpendGuard(advanced())([
          { label: "x", amount: 1, currency: "USD" },
        ])
      )
    ).toMatchObject({
      code: "budget_cap_missing",
    })
    expect(
      thrown(() =>
        strictDailySpendGuard(advanced())([
          { label: "x", amount: 100_001, currency: "VND" },
        ])
      )
    ).toMatchObject({
      code: "budget_cap_exceeded",
    })
  })

  it("writeOptions hands the mode to the adapters: only an explicit advanced is 'advanced', unknown → undefined", () => {
    const acc = { platform: "tiktok" as const, externalId: "7100" }
    const mcpId = "00000000-0000-4000-8000-0000000000b2"
    expect(writeOptions({ mcpId, settings: basic() }, acc).protectionMode).toBe(
      "basic"
    )
    expect(
      writeOptions({ mcpId, settings: advanced() }, acc).protectionMode
    ).toBe("advanced")
    expect(
      writeOptions({ mcpId, settings: DEFAULT_MCP_SETTINGS }, acc)
        .protectionMode
    ).toBe("advanced")
    expect(
      writeOptions(
        {
          mcpId,
          settings: {
            ...DEFAULT_MCP_SETTINGS,
            protectionMode: "garbage" as never,
          },
        },
        acc
      ).protectionMode
    ).toBeUndefined()
  })
})
