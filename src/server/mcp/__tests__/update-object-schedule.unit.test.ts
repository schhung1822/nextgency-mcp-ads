// ads_update_object lifetime-cap check uses the flight the platform will really apply: Google rounds a new schedule to
// whole days (start 00:00:00, end 23:59:59 account time) - other platforms keep the raw ISO value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AdObjectDetail,
  AdsProvider,
  ObjectLevel,
} from "../../providers/types"
import { assertScheduleWithinCaps } from "../tools/common/update-object"
import {
  DEFAULT_MCP_SETTINGS,
  type GrantAccount,
  type McpSettings,
} from "../types"
import type { ToolEnv } from "../tool"

const S: McpSettings = {
  ...DEFAULT_MCP_SETTINGS,
  maxDailyBudget: { VND: 1_000_000 },
}
const env = {
  grant: { settings: S },
  providerCtx: async () => ({}),
} as unknown as ToolEnv

beforeEach(() =>
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T17:00:00Z") })
) // 2026-10-02 00:00 +07
afterEach(() => vi.useRealTimers())

function provider(platform: string): AdsProvider {
  const objs: Record<string, Partial<AdObjectDetail>> = {
    "ad_group:g1": {
      campaignId: "c1",
      startTime: "2026-10-02T00:00:00+07:00",
      endTime: "2026-10-20T23:59:59+07:00",
      budget: {
        type: "lifetime",
        amount: 3_000_000,
        currency: "VND",
        level: "ad_group",
      },
    },
    "campaign:c1": {},
  }
  return {
    platform,
    getObject: async (_c: unknown, level: ObjectLevel, id: string) =>
      ({
        id,
        level,
        name: id,
        status: "paused",
        statusRaw: "PAUSED",
        ...objs[`${level}:${id}`],
      }) as AdObjectDetail,
  } as unknown as AdsProvider
}
const account = (platform: string) =>
  ({
    platform,
    externalId: "1",
    currency: "VND",
    timezone: "Asia/Ho_Chi_Minh",
  }) as unknown as GrantAccount

describe("assertScheduleWithinCaps - Google day rounding", () => {
  // end 2026-10-04T00:00+07: raw flight = 2 days (cap 2.000.000 < 3.000.000); Google applies 2026-10-04 23:59:59 → 3 days
  const changes = { endTime: "2026-10-04T00:00:00+07:00" }
  it("google_ads: checked on the rounded flight (3 days → 3.000.000 allowed)", async () => {
    await expect(
      assertScheduleWithinCaps(
        env,
        account("google_ads"),
        provider("google_ads"),
        "ad_group",
        "g1",
        changes
      )
    ).resolves.toBeUndefined()
  })
  it("other platforms keep the raw ISO flight (2 days → refused)", async () => {
    await expect(
      assertScheduleWithinCaps(
        env,
        account("openai_ads"),
        provider("openai_ads"),
        "ad_group",
        "g1",
        changes
      )
    ).rejects.toThrow(/vượt mức tối đa/)
  })
  it("google_ads: a start later in the day is rounded back to 00:00 (longer flight, not shorter)", async () => {
    await expect(
      assertScheduleWithinCaps(
        env,
        account("google_ads"),
        provider("google_ads"),
        "ad_group",
        "g1",
        {
          startTime: "2026-10-02T18:00:00+07:00",
          endTime: "2026-10-04T00:00:00+07:00",
        }
      )
    ).resolves.toBeUndefined()
  })
})
