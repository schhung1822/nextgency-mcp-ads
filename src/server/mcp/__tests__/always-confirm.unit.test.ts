// ads_set_status: optional provider hook mustAlwaysConfirm (TikTok GMV Max) → two-step confirmation even when the
// MCP disabled it. The hook is asked only when confirmation is off; a failing hook requires confirmation (fail closed).
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../../providers/errors"
import type {
  ActivationSpend,
  AdObjectDetail,
  AdsProvider,
} from "../../providers/types"
import { __resetRateLimits, consumeWriteRate } from "../rate-limit"
import {
  ACTIVATION_SPEND_PREVIEW_FAILED,
  ALWAYS_CONFIRM_CHECK_FAILED,
  activationPreviewWarnings,
  activationSpendWarnings,
  alwaysConfirmReasons,
  assertActivationWithinCaps,
} from "../tools/common/set-status"
import type { ToolEnv } from "../tool"
import { DEFAULT_MCP_SETTINGS, type GrantAccount } from "../types"

const account = {
  platform: "tiktok",
  externalId: "7100",
  currency: "VND",
  timezone: "Asia/Ho_Chi_Minh",
} as unknown as GrantAccount

function envWith(twoStepConfirm: boolean) {
  const providerCtx = vi.fn(async () => ({ account: { externalId: "7100" } }))
  const env = {
    grant: { settings: { ...DEFAULT_MCP_SETTINGS, twoStepConfirm } },
    providerCtx,
  } as unknown as ToolEnv
  return { env, providerCtx }
}

afterEach(() => {
  vi.restoreAllMocks()
  __resetRateLimits()
})

describe("alwaysConfirmReasons (ads_set_status)", () => {
  it("provider without the hook → [] and no provider context is built (behaviour unchanged)", async () => {
    const { env, providerCtx } = envWith(false)
    const provider = { platform: "meta" } as unknown as AdsProvider
    expect(
      await alwaysConfirmReasons(
        env,
        account,
        provider,
        "campaign",
        ["1"],
        "paused"
      )
    ).toEqual([])
    expect(providerCtx).not.toHaveBeenCalled()
  })

  it("two-step confirmation already on → the hook is not called (no extra platform reads)", async () => {
    const { env } = envWith(true)
    const hook = vi.fn(async () => ["x"])
    const provider = {
      platform: "tiktok",
      mustAlwaysConfirm: hook,
    } as unknown as AdsProvider
    expect(
      await alwaysConfirmReasons(
        env,
        account,
        provider,
        "campaign",
        ["1"],
        "paused"
      )
    ).toEqual([])
    expect(hook).not.toHaveBeenCalled()
  })

  it("confirmation off → the hook's reasons are returned (args passed through)", async () => {
    const { env } = envWith(false)
    const hook = vi.fn(async () => ["1: Chiến dịch GMV Max: …"])
    const provider = {
      platform: "tiktok",
      mustAlwaysConfirm: hook,
    } as unknown as AdsProvider
    expect(
      await alwaysConfirmReasons(
        env,
        account,
        provider,
        "campaign",
        ["1", "2"],
        "active"
      )
    ).toEqual(["1: Chiến dịch GMV Max: …"])
    expect(hook).toHaveBeenCalledWith(
      { account: { externalId: "7100" } },
      "campaign",
      ["1", "2"],
      "active"
    )
    hook.mockResolvedValueOnce([])
    expect(
      await alwaysConfirmReasons(
        env,
        account,
        provider,
        "campaign",
        ["3"],
        "paused"
      )
    ).toEqual([])
  })

  it("failing hook → confirmation required (fail closed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { env } = envWith(false)
    const provider = {
      platform: "tiktok",
      mustAlwaysConfirm: async () => {
        throw new Error("boom")
      },
    } as unknown as AdsProvider
    expect(
      await alwaysConfirmReasons(
        env,
        account,
        provider,
        "campaign",
        ["1"],
        "paused"
      )
    ).toEqual([ALWAYS_CONFIRM_CHECK_FAILED])
  })
})

describe("alwaysConfirmReasons: write quota already spent", () => {
  it("S2: the hook is STILL asked (no fail-open shortcut when the write quota is spent)", async () => {
    const providerCtx = vi.fn(async () => ({}))
    const env = {
      grant: {
        mcpId: "mcp-rate-1",
        settings: {
          ...DEFAULT_MCP_SETTINGS,
          twoStepConfirm: false,
          writeRateLimitPer10Min: 2,
        },
      },
      providerCtx,
    } as unknown as ToolEnv
    const hook = vi.fn(async () => ["x"])
    const provider = {
      platform: "tiktok",
      mustAlwaysConfirm: hook,
    } as unknown as AdsProvider
    expect(
      await alwaysConfirmReasons(env, account, provider, "campaign", ["1"], "paused")
    ).toEqual(["x"])
    consumeWriteRate("mcp-rate-1", 2)
    consumeWriteRate("mcp-rate-1", 2)
    hook.mockClear()
    expect(
      await alwaysConfirmReasons(env, account, provider, "campaign", ["1"], "paused")
    ).toEqual(["x"])
    expect(hook).toHaveBeenCalledTimes(1)
  })
})

describe("ads_set_status → active: provider.activationSpend (TikTok GMV Max worst-case daily spend)", () => {
  const capEnv = (maxDailyBudget: Record<string, number>, maxLifetimeBudget: Record<string, number> = {}) =>
    ({
      grant: {
        mcpId: "mcp-cap-1",
        settings: { ...DEFAULT_MCP_SETTINGS, maxDailyBudget, maxLifetimeBudget },
      },
      providerCtx: async () => ({ account: { externalId: "7100" } }),
    }) as unknown as ToolEnv
  const entry = (maxDailySpend: number): ActivationSpend => ({
    id: "1",
    label: 'Chiến dịch GMV Max "C1" (1)',
    currency: "VND",
    dailyBudget: 300_000,
    maxDailySpend,
    notes: ["Chưa gồm ngân sách riêng của phiên Max delivery / Creative boost (nếu có)."],
  })
  const providerWith = (spend: () => Promise<ActivationSpend[]>) => {
    const hook = vi.fn(spend)
    const provider = {
      platform: "tiktok",
      getObject: async (_c: unknown, level: string, id: string) =>
        ({ id, level, name: id, status: "paused", statusRaw: "DISABLE", budget: { type: "daily", amount: 300_000, currency: "VND", level: "campaign" } }) as unknown as AdObjectDetail,
      activationSpend: hook,
    } as unknown as AdsProvider
    return { provider, hook }
  }

  it("worst case within the daily cap → allowed, entries returned for the preview", async () => {
    const { provider, hook } = providerWith(async () => [entry(1_000_000)])
    const out = await assertActivationWithinCaps(capEnv({ VND: 1_000_000 }), account, provider, "campaign", ["1"])
    expect(out).toEqual([entry(1_000_000)])
    expect(hook).toHaveBeenCalledWith({ account: { externalId: "7100" } }, "campaign", ["1"])
  })

  it("worst case above the daily cap → budget_cap_exceeded (even if the daily budget alone fits)", async () => {
    const { provider } = providerWith(async () => [entry(1_800_000)])
    await expect(
      assertActivationWithinCaps(capEnv({ VND: 1_000_000 }), account, provider, "campaign", ["1"])
    ).rejects.toMatchObject({ code: "budget_cap_exceeded", messageVi: expect.stringContaining("Mức chi tối đa có thể mỗi ngày") })
  })

  it("unverifiable → budget_unverifiable (fail closed); invalid token keeps its own error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const failing = providerWith(async () => {
      throw new ProviderError({ platform: "tiktok", code: "upstream_error", message: "x", userMessageVi: "Không đọc được ngân sách." })
    })
    await expect(
      assertActivationWithinCaps(capEnv({ VND: 1_000_000 }), account, failing.provider, "campaign", ["1"])
    ).rejects.toMatchObject({ code: "budget_unverifiable" })
    const auth = providerWith(async () => {
      throw new ProviderError({ platform: "tiktok", code: "auth_invalid", message: "x", userMessageVi: "Token hỏng." })
    })
    await expect(
      assertActivationWithinCaps(capEnv({ VND: 1_000_000 }), account, auth.provider, "campaign", ["1"])
    ).rejects.toMatchObject({ code: "auth_invalid" })
  })

  it("no daily cap for the currency (lifetime only / other currency) → the hook is not asked here", async () => {
    const { provider, hook } = providerWith(async () => [entry(9e9)])
    expect(
      await assertActivationWithinCaps(capEnv({ USD: 100 }, { VND: 5_000_000 }), account, provider, "campaign", ["1"])
    ).toBeUndefined()
    expect(await assertActivationWithinCaps(capEnv({}), account, provider, "campaign", ["1"])).toBeUndefined()
    expect(hook).not.toHaveBeenCalled()
  })

  it("preview: reuses the checked entries; without a cap asks the hook (never blocking)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { provider, hook } = providerWith(async () => [entry(1_800_000)])
    const env = capEnv({})
    const reused = await activationPreviewWarnings(env, account, provider, "campaign", ["1"], [entry(900_000)])
    expect(reused).toEqual(activationSpendWarnings([entry(900_000)]))
    expect(hook).not.toHaveBeenCalled()
    const asked = await activationPreviewWarnings(env, account, provider, "campaign", ["1"], undefined)
    expect(asked[0]).toContain('Chiến dịch GMV Max "C1" (1): ngân sách ngày 300.000 VND; chi tiêu tối đa có thể mỗi ngày 1.800.000 VND.')
    expect(asked[0]).toContain("Max delivery")
    const broken = providerWith(async () => {
      throw new Error("down")
    })
    expect(await activationPreviewWarnings(env, account, broken.provider, "campaign", ["1"], undefined)).toEqual([
      ACTIVATION_SPEND_PREVIEW_FAILED,
    ])
    const none = { platform: "meta" } as unknown as AdsProvider
    expect(await activationPreviewWarnings(env, account, none, "campaign", ["1"], undefined)).toEqual([])
  })
})
