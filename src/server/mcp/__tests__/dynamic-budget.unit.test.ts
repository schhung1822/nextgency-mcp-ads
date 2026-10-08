// TikTok flexible daily budget (BUDGET_MODE_DYNAMIC_DAILY_BUDGET) may spend 125%/day (doc 1739381246298114):
// every daily-cap check (create moneyOf, ads_update_budget, ads_set_status → active) compares amount × 1.25.
import { describe, expect, it } from "vitest"
import type {
  AdObjectDetail,
  AdsProvider,
  Budget,
  ObjectLevel,
} from "../../providers/types"
import { toBudget } from "../../providers/tiktok/api"
import { tiktokExtensions } from "../../providers/tiktok/extensions"
import { McpToolError } from "../errors"
import {
  checkDailyCap,
  DYNAMIC_DAILY_NOTE,
  enforceMoneyItems,
  maxDynamicDailyBudget,
} from "../guardrails"
import { assertActivationWithinCaps } from "../tools/common/set-status"
import { checkBudgetGuardrails } from "../tools/common/update-budget"
import {
  DEFAULT_MCP_SETTINGS,
  type GrantAccount,
  type McpSettings,
} from "../types"
import type { ToolEnv } from "../tool"

const S: McpSettings = {
  ...DEFAULT_MCP_SETTINGS,
  budgetChangeMaxPct: 50,
  maxDailyBudget: { VND: 1_000_000, USD: 10.01 },
}

function denialOf(fn: () => unknown): McpToolError {
  try {
    fn()
  } catch (e) {
    if (e instanceof McpToolError) return e
    throw e
  }
  throw new Error("expected a denial")
}

describe("checkDailyCap - flexible daily budget (125%/day)", () => {
  it("VND: cap 1.000.000 → at most 800.000 (exact boundary, integer math)", () => {
    expect(() =>
      checkDailyCap(S, 800_000, "VND", "Ngân sách ngày", { dynamic: true })
    ).not.toThrow()
    const e = denialOf(() =>
      checkDailyCap(S, 800_001, "VND", "Ngân sách ngày linh hoạt", {
        dynamic: true,
      })
    )
    expect(e.code).toBe("budget_cap_exceeded")
    expect(e.message).toMatch(/125%\/ngày/)
    expect(e.message).toMatch(/1\.000\.001,25 VND|1\.000\.001 VND/)
    expect(e.hint).toMatch(/800\.000 VND/)
    // a plain daily budget keeps the old rule (amount ≤ cap)
    expect(() => checkDailyCap(S, 1_000_000, "VND")).not.toThrow()
    expect(() =>
      checkDailyCap(S, 1_000_000, "VND", "x", { dynamic: false })
    ).not.toThrow()
    expect(() => checkDailyCap(S, 1_000_001, "VND")).toThrow(/vượt trần/)
  })

  it("USD: decimal boundary without float noise (10.01 / 1.25 = 8.008)", () => {
    expect(() =>
      checkDailyCap(S, 8.008, "USD", "x", { dynamic: true })
    ).not.toThrow()
    expect(() =>
      checkDailyCap(S, 8.009, "USD", "x", { dynamic: true })
    ).toThrow(McpToolError)
    expect(maxDynamicDailyBudget(10.01, "USD")).toBe(8) // rounded DOWN to 2 decimals: 8.008 → 8.00
    expect(maxDynamicDailyBudget(1_000_000, "VND")).toBe(800_000)
    expect(maxDynamicDailyBudget(999_999, "VND")).toBe(799_999) // floor(799 999.2)
    expect(maxDynamicDailyBudget(10, "USD")).toBe(8)
  })

  it("no cap for the currency → nothing checked", () => {
    expect(() =>
      checkDailyCap(S, 9e9, "JPY", "x", { dynamic: true })
    ).not.toThrow()
  })
})

describe("create tools (moneyOf → enforceMoneyItems)", () => {
  const campaign = tiktokExtensions.find(
    (e) => e.name === "tiktok_create_campaign"
  )!
  const adgroup = tiktokExtensions.find(
    (e) => e.name === "tiktok_create_adgroup"
  )!

  it("tiktok_create_campaign CBO dynamic_daily is declared dynamic and capped at 80% of the daily cap", () => {
    const items = campaign.moneyOf!(
      campaign.input.parse({
        name: "x",
        objective: "TRAFFIC",
        cbo: true,
        budget_type: "dynamic_daily",
        budget: 900_000,
      })
    )
    expect(items).toEqual([
      { kind: "daily_budget", amount: 900_000, field: "budget", dynamic: true },
    ])
    expect(() => enforceMoneyItems(S, "VND", items)).toThrow(/125%\/ngày/)
    const okItems = campaign.moneyOf!(
      campaign.input.parse({
        name: "x",
        objective: "TRAFFIC",
        cbo: true,
        budget_type: "dynamic_daily",
        budget: 800_000,
      })
    )
    expect(() => enforceMoneyItems(S, "VND", okItems)).not.toThrow()
    // plain daily: unchanged behaviour (≤ cap)
    const daily = campaign.moneyOf!(
      campaign.input.parse({
        name: "x",
        objective: "TRAFFIC",
        cbo: true,
        budget_type: "daily",
        budget: 1_000_000,
      })
    )
    expect(daily[0]).not.toHaveProperty("dynamic")
    expect(() => enforceMoneyItems(S, "VND", daily)).not.toThrow()
  })

  it("tiktok_create_adgroup dynamic_daily is declared dynamic", () => {
    const input = adgroup.input.parse({
      campaign_id: "1",
      name: "g",
      promotion_type: "WEBSITE",
      location_ids: ["1562822"],
      optimization_goal: "CLICK",
      budget_type: "dynamic_daily",
      budget: 850_000,
    })
    const items = adgroup.moneyOf!(input)
    expect(items[0]).toMatchObject({
      kind: "daily_budget",
      amount: 850_000,
      dynamic: true,
    })
    expect(() => enforceMoneyItems(S, "VND", items)).toThrow(/linh hoạt/)
  })

  it("the preview note explains the 125% rule in Vietnamese", () => {
    expect(DYNAMIC_DAILY_NOTE).toMatch(
      /linh hoạt của TikTok có thể chi tới 125%\/ngày/
    )
  })
})

describe("ads_update_budget (checkBudgetGuardrails)", () => {
  const dyn: Budget = {
    type: "daily",
    amount: 600_000,
    currency: "VND",
    level: "ad_group",
    dynamic: true,
  }
  it("a flexible daily budget is capped at cap / 1.25 and warns", () => {
    const e = denialOf(() =>
      checkBudgetGuardrails(S, dyn, {
        type: "daily",
        amount: 850_000,
        currency: "VND",
      })
    )
    expect(e.code).toBe("budget_cap_exceeded")
    expect(e.message).toMatch(/Ngân sách ngày linh hoạt 850\.000 VND/)
    const r = checkBudgetGuardrails(S, dyn, {
      type: "daily",
      amount: 800_000,
      currency: "VND",
    })
    expect(
      r.warnings.some((w) => w.includes("125%") && w.includes("1.000.000 VND"))
    ).toBe(true)
  })
  it("a plain daily budget keeps the old cap (Meta/OpenAI/Google unchanged)", () => {
    const plain: Budget = { ...dyn, dynamic: undefined }
    const r = checkBudgetGuardrails(
      S,
      { ...plain, amount: 700_000 },
      { type: "daily", amount: 1_000_000, currency: "VND" }
    )
    expect(r.warnings.some((w) => w.includes("125%"))).toBe(false)
  })
})

describe("TikTok toBudget", () => {
  it("flags BUDGET_MODE_DYNAMIC_DAILY_BUDGET only", () => {
    expect(
      toBudget(
        { budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", budget: 500 },
        "campaign",
        "VND"
      )
    ).toEqual({
      type: "daily",
      amount: 500,
      currency: "VND",
      level: "campaign",
      dynamic: true,
    })
    expect(
      toBudget(
        { budget_mode: "BUDGET_MODE_DAY", budget: 500 },
        "ad_group",
        "VND"
      )
    ).not.toHaveProperty("dynamic")
    expect(
      toBudget(
        { budget_mode: "BUDGET_MODE_TOTAL", budget: 500 },
        "ad_group",
        "VND"
      )
    ).not.toHaveProperty("dynamic")
  })
})

describe("ads_set_status → active (assertActivationWithinCaps)", () => {
  const account = {
    platform: "tiktok",
    externalId: "7100",
    currency: "VND",
    timezone: "Asia/Ho_Chi_Minh",
  } as unknown as GrantAccount
  const env = {
    grant: { settings: S },
    providerCtx: async () => ({}),
  } as unknown as ToolEnv
  function providerWith(
    objs: Record<string, Partial<AdObjectDetail>>
  ): AdsProvider {
    return {
      platform: "tiktok",
      getObject: async (_c: unknown, level: ObjectLevel, id: string) => {
        const o = objs[`${level}:${id}`]
        if (!o) throw new Error(`no ${level}:${id}`)
        return {
          id,
          level,
          name: id,
          status: "paused",
          statusRaw: "DISABLE",
          ...o,
        } as AdObjectDetail
      },
    } as unknown as AdsProvider
  }

  it("campaign CBO flexible daily budget above cap/1.25 cannot be switched on", async () => {
    const p = providerWith({
      "campaign:c1": {
        budget: {
          type: "daily",
          amount: 900_000,
          currency: "VND",
          level: "campaign",
          dynamic: true,
        },
      },
    })
    await expect(
      assertActivationWithinCaps(env, account, p, "campaign", ["c1"])
    ).rejects.toThrow(/linh hoạt.*125%\/ngày/)
    const ok = providerWith({
      "campaign:c1": {
        budget: {
          type: "daily",
          amount: 800_000,
          currency: "VND",
          level: "campaign",
          dynamic: true,
        },
      },
    })
    await expect(
      assertActivationWithinCaps(env, account, ok, "campaign", ["c1"])
    ).resolves.toBeUndefined()
  })

  it("ad group flexible daily budget (and the CBO campaign above an ad) are checked", async () => {
    const p = providerWith({
      "ad_group:g1": {
        campaignId: "c1",
        budget: {
          type: "daily",
          amount: 820_000,
          currency: "VND",
          level: "ad_group",
          dynamic: true,
        },
      },
      "campaign:c1": {},
    })
    await expect(
      assertActivationWithinCaps(env, account, p, "ad_group", ["g1"])
    ).rejects.toThrow(McpToolError)
    const viaAd = providerWith({
      "ad:a1": { parentId: "g1", campaignId: "c1" },
      "ad_group:g1": { campaignId: "c1" },
      "campaign:c1": {
        budget: {
          type: "daily",
          amount: 950_000,
          currency: "VND",
          level: "campaign",
          dynamic: true,
        },
      },
    })
    await expect(
      assertActivationWithinCaps(env, account, viaAd, "ad", ["a1"])
    ).rejects.toThrow(/linh hoạt/)
    // same amount as a plain daily budget is within the cap
    const plain = providerWith({
      "ad_group:g1": {
        campaignId: "c1",
        budget: {
          type: "daily",
          amount: 950_000,
          currency: "VND",
          level: "ad_group",
        },
      },
      "campaign:c1": {},
    })
    await expect(
      assertActivationWithinCaps(env, account, plain, "ad_group", ["g1"])
    ).resolves.toBeUndefined()
  })
})
