// ads-api-reviewer findings 2026-10-08 (Google Ads): EU declaration skips VIDEO, ad copy target checks, video
// metrics null outside video channels, day-rounded schedule helper, billable unit rounding, no auto-retry of removes,
// copied flight length.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isProviderError, type ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import type { ReportQuery } from "../types"
import { __clearTokenCache } from "./auth"
import { buildCampaignCopy, copyObject, type CampaignSource } from "./copy"
import { googleAdsExtensions } from "./extensions"
import { deleteObject, updateBudget } from "./mutate"
import { rowToReport, videoMetricsApply } from "./report"
import { googleScheduleIso } from "./time"
import { __resetBillableUnits, moneyToMicros, primeBillableUnit } from "./units"
import {
  mockFetch,
  providerCtx,
  saCredentials,
  searchMatching,
} from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
  __resetBillableUnits()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const ext = (name: string) => googleAdsExtensions.find((e) => e.name === name)!

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (e) {
    if (isProviderError(e)) return e
    throw e
  }
  throw new Error("expected a ProviderError")
}

describe("#6 google_ads_declare_eu_political skips VIDEO campaigns", () => {
  it("selects the channel, declares only non-video campaigns and warns about the rest", async () => {
    const m = mockFetch()
    m.on(
      searchMatching(/missing_eu_political_advertising_declaration = TRUE/),
      {
        body: {
          results: [
            {
              campaign: {
                id: "1",
                name: "Search",
                advertisingChannelType: "SEARCH",
              },
            },
            {
              campaign: {
                id: "2",
                name: "YouTube",
                advertisingChannelType: "VIDEO",
              },
            },
          ],
        },
      }
    )
    m.on((c) => c.url.endsWith("campaigns:mutate"), { body: { results: [{}] } })
    const tool = ext("google_ads_declare_eu_political")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ contains_eu_political_advertising: false }),
      {}
    )) as {
      changes: { objectId: string }[]
      warnings: string[]
    }
    const search = m.api().find((c) => c.url.endsWith("/googleAds:search"))!
    expect(String((search.body as { query: string }).query)).toContain(
      "campaign.advertising_channel_type"
    )
    const body = m.api().find((c) => c.url.endsWith("campaigns:mutate"))!
      .body as { operations: { update: { resourceName: string } }[] }
    expect(body.operations.map((o) => o.update.resourceName)).toEqual([
      "customers/1234567890/campaigns/1",
    ])
    expect(res.changes.map((c) => c.objectId)).toEqual(["1"])
    expect(res.warnings.join(" ")).toMatch(
      /Video \(YouTube\).*2.*giao diện Google Ads/
    )
  })

  it("only VIDEO campaigns missing → no mutate, explanation only", async () => {
    const m = mockFetch()
    m.on(
      searchMatching(/missing_eu_political_advertising_declaration = TRUE/),
      {
        body: {
          results: [
            {
              campaign: {
                id: "2",
                name: "YouTube",
                advertisingChannelType: "VIDEO",
              },
            },
          ],
        },
      }
    )
    const tool = ext("google_ads_declare_eu_political")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ contains_eu_political_advertising: true }),
      {}
    )) as {
      changes: unknown[]
      warnings: string[]
    }
    expect(m.api().some((c) => c.url.endsWith("campaigns:mutate"))).toBe(false)
    expect(res.changes).toEqual([])
    expect(res.warnings[0]).toMatch(/giao diện Google Ads/)
  })
})

describe("#7 copying an RSA into another ad group checks the target", () => {
  const AD = {
    campaign: { id: "10", advertisingChannelType: "SEARCH" },
    adGroup: { id: "20" },
    adGroupAd: {
      status: "ENABLED",
      ad: {
        id: "500",
        type: "RESPONSIVE_SEARCH_AD",
        finalUrls: ["https://shop.vn"],
        responsiveSearchAd: {
          headlines: [{ text: "A" }, { text: "B" }, { text: "C" }],
          descriptions: [{ text: "D1" }, { text: "D2" }],
        },
      },
    },
  }
  function setup(target: Record<string, unknown>) {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_ad WHERE/), { body: { results: [AD] } })
    m.on(searchMatching(/FROM ad_group WHERE ad_group.id IN/), {
      body: { results: [target] },
    })
    m.on((c) => c.url.endsWith("googleAds:mutate"), {
      body: {
        mutateOperationResponses: [
          {
            adGroupAdResult: {
              resourceName: "customers/1234567890/adGroupAds/30~900",
            },
          },
        ],
      },
    })
    return m
  }
  it("VIDEO target → read-only refusal", async () => {
    const m = setup({
      adGroup: {
        id: "30",
        status: "ENABLED",
        type: "VIDEO_TRUE_VIEW_IN_STREAM",
      },
      campaign: { advertisingChannelType: "VIDEO" },
    })
    const e = await rejection(
      copyObject(
        providerCtx(saCredentials()),
        { level: "ad", id: "20~500", deep: false, targetParentId: "30" },
        { dryRun: true }
      )
    )
    expect(e.code).toBe("unsupported")
    const q = (
      m
        .api()
        .find((c) =>
          /FROM ad_group WHERE/.test(
            String((c.body as { query?: string })?.query)
          )
        )!.body as { query: string }
    ).query
    expect(q).toContain("campaign.advertising_channel_type")
    expect(q).toContain("ad_group.type")
  })
  it("non-SEARCH_STANDARD target (e.g. Display) → refused with a Vietnamese explanation", async () => {
    setup({
      adGroup: { id: "30", status: "ENABLED", type: "DISPLAY_STANDARD" },
      campaign: { advertisingChannelType: "DISPLAY" },
    })
    const e = await rejection(
      copyObject(
        providerCtx(saCredentials()),
        { level: "ad", id: "20~500", deep: false, targetParentId: "30" },
        { dryRun: true }
      )
    )
    expect(e.userMessageVi).toMatch(/SEARCH_STANDARD/)
  })
  it("SEARCH_STANDARD target → allowed", async () => {
    setup({
      adGroup: { id: "30", status: "ENABLED", type: "SEARCH_STANDARD" },
      campaign: { advertisingChannelType: "SEARCH" },
    })
    const res = await copyObject(
      providerCtx(saCredentials()),
      { level: "ad", id: "20~500", deep: false, targetParentId: "30" },
      { dryRun: true }
    )
    expect(res.preview).toBe(true)
  })
})

describe("#8 video metrics are null outside video-capable channels", () => {
  const q: ReportQuery = {
    level: "campaign",
    dateRange: { from: "2026-10-01", to: "2026-10-01" },
    granularity: "total",
    metrics: "video",
    limit: 100,
  }
  const metrics = {
    costMicros: "1000000",
    impressions: "10",
    clicks: "1",
    videoTrueviewViews: "0",
    videoTrueviewViewRate: 0,
    videoQuartileP25Rate: 0,
    youtubeLikes: "0",
  }
  it("SEARCH → null; VIDEO / DEMAND_GEN / PERFORMANCE_MAX → numbers", () => {
    const search = rowToReport(
      { campaign: { id: "1", advertisingChannelType: "SEARCH" }, metrics },
      q
    )
    expect(search.metrics.video_views).toBeNull()
    expect(search.extra?.video_view_rate_pct).toBeNull()
    expect(search.extra?.youtube_likes).toBeNull()
    for (const ch of ["VIDEO", "DEMAND_GEN", "PERFORMANCE_MAX"]) {
      const r = rowToReport(
        { campaign: { id: "1", advertisingChannelType: ch }, metrics },
        q
      )
      expect(r.metrics.video_views, ch).toBe(0)
      expect(r.extra?.video_view_rate_pct, ch).toBe(0)
    }
    expect(videoMetricsApply(null)).toBe(true)
    expect(videoMetricsApply("SHOPPING")).toBe(false)
  })
})

describe("#9 googleScheduleIso (same day rounding as the mutate path)", () => {
  it("start → 00:00:00, end → 23:59:59 in the account time zone", () => {
    expect(
      googleScheduleIso(
        "2026-10-05T15:30:00+07:00",
        "start",
        "Asia/Ho_Chi_Minh"
      )
    ).toBe("2026-10-05T00:00:00+07:00")
    expect(
      googleScheduleIso("2026-10-05T00:00:00+07:00", "end", "Asia/Ho_Chi_Minh")
    ).toBe("2026-10-05T23:59:59+07:00")
    // 2026-10-04T20:00Z is already Oct 5 in Ho Chi Minh
    expect(
      googleScheduleIso("2026-10-04T20:00:00Z", "end", "Asia/Ho_Chi_Minh")
    ).toBe("2026-10-05T23:59:59+07:00")
    expect(googleScheduleIso(null, "end", "Asia/Ho_Chi_Minh")).toBeNull()
  })
})

describe("#10 billable unit rounding", () => {
  it("rounds DOWN to currency_constant.billable_unit_micros once loaded; falls back to precision rounding", async () => {
    expect(moneyToMicros(12_345.6, "KRW")).toBe("12346000000") // fallback: zero-decimal precision (nearest)
    const searchAll = vi.fn(async () => ({
      rows: [
        { currencyConstant: { code: "KRW", billableUnitMicros: "10000000" } },
      ],
    }))
    await primeBillableUnit({ searchAll } as never, "1", "KRW")
    await primeBillableUnit({ searchAll } as never, "1", "KRW") // cached per process
    expect(searchAll).toHaveBeenCalledTimes(1)
    const w: string[] = []
    expect(moneyToMicros(12_345.6, "KRW", w)).toBe("12340000000")
    expect(w[0]).toMatch(/12340 KRW/)
    expect(moneyToMicros(12_340, "KRW")).toBe("12340000000")
    expect(() => moneyToMicros(5, "KRW")).toThrow()
  })
  it("a failed lookup is not fatal and is not retried for an hour", async () => {
    const searchAll = vi.fn(async () => {
      throw new Error("boom")
    })
    await primeBillableUnit({ searchAll } as never, "1", "USD", 1_000)
    await primeBillableUnit({ searchAll } as never, "1", "USD", 2_000)
    expect(searchAll).toHaveBeenCalledTimes(1)
    expect(moneyToMicros(1.234, "USD")).toBe("1230000")
  })
  it("updateBudget primes the unit before converting", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM currency_constant/), {
      body: {
        results: [
          { currencyConstant: { code: "VND", billableUnitMicros: "1000000" } },
        ],
      },
    })
    m.on(searchMatching(/FROM campaign WHERE/), {
      body: {
        results: [
          {
            campaign: {
              id: "5",
              name: "C",
              status: "PAUSED",
              advertisingChannelType: "SEARCH",
            },
            campaignBudget: {
              id: "9",
              amountMicros: "100000000000",
              period: "DAILY",
              explicitlyShared: false,
              referenceCount: "1",
            },
          },
        ],
      },
    })
    m.on((c) => c.url.endsWith("campaignBudgets:mutate"), {
      body: { results: [{}] },
    })
    await updateBudget(
      providerCtx(saCredentials()),
      { level: "campaign", id: "5", type: "daily", amount: 120_000.7 },
      { dryRun: true }
    )
    const body = m.api().find((c) => c.url.endsWith("campaignBudgets:mutate"))!
      .body as { operations: { update: { amountMicros: string } }[] }
    expect(body.operations[0]!.update.amountMicros).toBe("120000000000")
  })
})

describe("#11 removes are not auto-retried; status re-read after an error", () => {
  const KW = {
    adGroup: { id: "22" },
    adGroupCriterion: {
      criterionId: "999",
      status: "ENABLED",
      keyword: { text: "giày" },
    },
  }
  it("5xx on remove → one attempt; already REMOVED on re-read → success with a warning", async () => {
    const m = mockFetch()
    let reads = 0
    m.on(searchMatching(/FROM ad_group_criterion/), () => {
      reads++
      return {
        body: {
          results: [
            reads === 1
              ? KW
              : {
                  ...KW,
                  adGroupCriterion: {
                    ...KW.adGroupCriterion,
                    status: "REMOVED",
                  },
                },
          ],
        },
      }
    })
    m.on((c) => c.url.endsWith("adGroupCriteria:mutate"), {
      status: 503,
      body: { error: { code: 503, status: "UNAVAILABLE", message: "x" } },
    })
    const res = await deleteObject(
      providerCtx(saCredentials()),
      "keyword",
      "22~999"
    )
    expect(
      m.api().filter((c) => c.url.endsWith("adGroupCriteria:mutate"))
    ).toHaveLength(1)
    expect(res.changes[0]).toMatchObject({ after: "REMOVED" })
    expect(res.warnings[0]).toMatch(/đã ở trạng thái REMOVED/)
  })
  it("5xx on remove and still ENABLED → non-retryable error that says the delete may have happened", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_criterion/), { body: { results: [KW] } })
    m.on((c) => c.url.endsWith("adGroupCriteria:mutate"), {
      status: 503,
      body: { error: { code: 503, status: "UNAVAILABLE", message: "x" } },
    })
    const e = await rejection(
      deleteObject(providerCtx(saCredentials()), "keyword", "22~999")
    )
    expect(
      m.api().filter((c) => c.url.endsWith("adGroupCriteria:mutate"))
    ).toHaveLength(1)
    expect(e.retryable).toBe(false)
    expect(e.userMessageVi).toMatch(/Thao tác xoá có thể đã được thực hiện/)
  })
})

describe("#13 copied campaign keeps its flight length", () => {
  const src = (
    start: string,
    end: string,
    period = "CUSTOM_PERIOD"
  ): CampaignSource => ({
    campaign: {
      campaign: {
        id: "10",
        name: "S",
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
        biddingStrategyType: "MANUAL_CPC",
        manualCpc: {},
        startDateTime: start,
        endDateTime: end,
        containsEuPoliticalAdvertising:
          "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      },
      campaignBudget: {
        id: "77",
        period,
        totalAmountMicros: "3000000000000",
        amountMicros: "100000000000",
        explicitlyShared: false,
      },
    },
    criteria: [],
    adGroups: [],
    keywords: [],
    ads: [],
  })
  const campaignCreate = (plan: ReturnType<typeof buildCampaignCopy>) =>
    (
      plan.ops.find((o) => "campaignOperation" in o) as {
        campaignOperation: { create: Record<string, unknown> }
      }
    ).campaignOperation.create
  it("past start → end shifted by the same number of days", () => {
    const plan = buildCampaignCopy(
      "1",
      src("2026-09-20 00:00:00", "2026-10-05 23:59:59"),
      { name: "c", today: "2026-10-02", deep: false, budgetSuffix: "t" }
    )
    expect(campaignCreate(plan)).toMatchObject({
      startDateTime: "2026-10-02 00:00:00",
      endDateTime: "2026-10-17 23:59:59",
    })
    expect(plan.warnings.join(" ")).toMatch(/giữ nguyên số ngày chạy/)
  })
  it("ended lifetime campaign can now be copied (flight moved, same length)", () => {
    const plan = buildCampaignCopy(
      "1",
      src("2026-09-01 00:00:00", "2026-09-10 23:59:59"),
      { name: "c", today: "2026-10-02", deep: false, budgetSuffix: "t" }
    )
    expect(campaignCreate(plan)).toMatchObject({
      startDateTime: "2026-10-02 00:00:00",
      endDateTime: "2026-10-11 23:59:59",
    })
  })
  it("future flight unchanged", () => {
    const plan = buildCampaignCopy(
      "1",
      src("2026-11-01 00:00:00", "2026-11-10 23:59:59"),
      { name: "c", today: "2026-10-02", deep: false, budgetSuffix: "t" }
    )
    expect(campaignCreate(plan)).toMatchObject({
      startDateTime: "2026-11-01 00:00:00",
      endDateTime: "2026-11-10 23:59:59",
    })
  })
})

describe("#14 create_search_campaign description", () => {
  it("no longer mentions language targeting in the step list", () => {
    expect(ext("google_ads_create_search_campaign").description).not.toMatch(
      /vị trí\/ngôn ngữ/
    )
  })
})
