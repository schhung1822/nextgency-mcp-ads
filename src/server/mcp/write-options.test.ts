// Write options handed to the adapters (GMV Max phase 2): the admin switch is fail-closed, the strict daily-spend
// guard requires a daily cap for the currency even on a legacy MCP and compares the worst case with it.
import { describe, expect, it } from "vitest"
import { McpToolError } from "./errors"
import { DEFAULT_MCP_SETTINGS } from "./types"
import { strictDailySpendGuard, writeOptions } from "./write-options"

const settings = { ...DEFAULT_MCP_SETTINGS, maxDailyBudget: { VND: 2_000_000 } }

describe("strictDailySpendGuard", () => {
  it("within the cap → ok; above → budget_cap_exceeded; no cap for the currency → budget_cap_missing", () => {
    const guard = strictDailySpendGuard(settings)
    expect(() =>
      guard([{ label: "x", amount: 2_000_000, currency: "vnd" }])
    ).not.toThrow()
    const over = (() => {
      try {
        guard([{ label: "Mức chi tối đa", amount: 2_000_001, currency: "VND" }])
      } catch (e) {
        return e
      }
    })()
    expect(over).toBeInstanceOf(McpToolError)
    expect(over).toMatchObject({ code: "budget_cap_exceeded" })
    expect(() => guard([{ label: "x", amount: 1, currency: "USD" }])).toThrow(
      McpToolError
    )
    try {
      guard([{ label: "chiến dịch GMV Max mới", amount: 1, currency: "USD" }])
    } catch (e) {
      expect(e).toMatchObject({ code: "budget_cap_missing" })
      expect((e as McpToolError).messageVi).toContain("USD")
    }
  })

  it("a legacy MCP (moneyCapsRequired false) without caps is refused too; invalid amounts are refused", () => {
    const legacy = strictDailySpendGuard({
      ...DEFAULT_MCP_SETTINGS,
      moneyCapsRequired: false,
      maxDailyBudget: {},
    })
    expect(() => legacy([{ label: "x", amount: 1, currency: "VND" }])).toThrow(
      /trần ngân sách\/ngày/
    )
    const guard = strictDailySpendGuard(settings)
    expect(() =>
      guard([{ label: "x", amount: Number.NaN, currency: "VND" }])
    ).toThrow()
  })
})

describe("writeOptions", () => {
  it("gmvMaxWrite only for an explicit true; guard and history always provided", () => {
    const acc = { platform: "tiktok" as const, externalId: "7100" }
    const mcpId = "00000000-0000-4000-8000-000000000001"
    expect(
      writeOptions({ mcpId, settings: DEFAULT_MCP_SETTINGS }, acc).gmvMaxWrite
    ).toBe(false)
    expect(
      writeOptions(
        {
          mcpId,
          settings: { ...DEFAULT_MCP_SETTINGS, tiktokGmvMaxWrite: true },
        },
        acc
      ).gmvMaxWrite
    ).toBe(true)
    const o = writeOptions({ mcpId, settings: DEFAULT_MCP_SETTINGS }, acc)
    expect(typeof o.dailySpendGuard).toBe("function")
    expect(typeof o.fieldHistory).toBe("function")
    expect(typeof o.startedSpend24h).toBe("function")
    // M1: the per MCP + ad account lock / reservations of this process
    expect(typeof o.startedSpendLedger?.exclusive).toBe("function")
    expect(typeof o.startedSpendLedger?.reserve).toBe("function")
    // never "confirmed" here: only runWrite sets it, on an execution through a consumed confirmation
    expect("confirmed" in o).toBe(false)
  })
})
