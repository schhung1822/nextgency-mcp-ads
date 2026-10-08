import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import { buildUpdate, deleteObject, setStatus, toSnake, updateBudget, updateObject } from "./mutate"
import { isSearch, mockFetch, providerCtx, saCredentials, searchMatching, type RecordedCall } from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-02T03:00:00Z") })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const mutateCalls = (m: { api: () => RecordedCall[] }, service: string) => m.api().filter((c) => c.url.endsWith(`/${service}:mutate`))
type Body = { operations: { update?: Record<string, unknown>; updateMask?: string; remove?: string }[]; partialFailure?: boolean; validateOnly?: boolean }

describe("buildUpdate", () => {
  it("updateMask lists exactly the fields present in the body (+ explicit clears)", () => {
    const op = buildUpdate("customers/1/campaigns/2", { name: "A", startDateTime: "2026-10-05 00:00:00", skip: undefined }, ["endDateTime"])
    expect(op.updateMask).toBe("name,start_date_time,end_date_time")
    expect(op.update).toEqual({ resourceName: "customers/1/campaigns/2", name: "A", startDateTime: "2026-10-05 00:00:00" })
    expect(op.update).not.toHaveProperty("endDateTime")
    expect(toSnake("maximizeConversions.targetCpaMicros")).toBe("maximize_conversions.target_cpa_micros")
    expect(() => buildUpdate("x", { a: 1 }, ["a"])).toThrow()
  })
})

describe("setStatus", () => {
  it("updates status with updateMask=status and partialFailure, using AG~AD resource names", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_ad/), {
      body: {
        results: [
          { campaign: { id: "1" }, adGroup: { id: "22" }, adGroupAd: { status: "ENABLED", ad: { id: "333", responsiveSearchAd: { headlines: [{ text: "Giày chạy bộ" }] } } } },
          { campaign: { id: "1" }, adGroup: { id: "22" }, adGroupAd: { status: "ENABLED", ad: { id: "444" } } },
        ],
      },
    })
    m.on((c) => c.url.endsWith("adGroupAds:mutate"), { body: { results: [{ resourceName: "customers/1234567890/adGroupAds/22~333" }, {}] } })
    const res = await setStatus(providerCtx(saCredentials()), "ad", ["22~333", "22~444"], "paused")
    const body = mutateCalls(m, "adGroupAds")[0]!.body as Body
    expect(body.partialFailure).toBe(true)
    expect(body.validateOnly).toBeUndefined()
    expect(body.operations).toEqual([
      { update: { resourceName: "customers/1234567890/adGroupAds/22~333", status: "PAUSED" }, updateMask: "status" },
      { update: { resourceName: "customers/1234567890/adGroupAds/22~444", status: "PAUSED" }, updateMask: "status" },
    ])
    expect(res.changes[0]).toMatchObject({ objectId: "22~333", objectName: "Giày chạy bộ", before: "ENABLED", after: "PAUSED" })
  })

  it("dryRun uses validateOnly", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), { body: { results: [{ campaign: { id: "5", name: "C", status: "PAUSED" } }] } })
    m.on((c) => c.url.endsWith("campaigns:mutate"), { body: {} })
    const res = await setStatus(providerCtx(saCredentials()), "campaign", ["5"], "active", { dryRun: true })
    expect((mutateCalls(m, "campaigns")[0]!.body as Body).validateOnly).toBe(true)
    expect(res.preview).toBe(true)
    expect(res.changes[0]).toMatchObject({ before: "PAUSED", after: "ENABLED" })
  })

  it("reports partial failures per object", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), { body: { results: [{ campaign: { id: "5", status: "PAUSED" } }, { campaign: { id: "6", status: "PAUSED" } }] } })
    m.on((c) => c.url.endsWith("campaigns:mutate"), {
      body: {
        results: [{ resourceName: "customers/1234567890/campaigns/5" }, {}],
        partialFailureError: {
          code: 3,
          message: "x",
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
              errors: [{ errorCode: { mutateError: "EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED" }, message: "declare", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }],
            },
          ],
        },
      },
    })
    const res = await setStatus(providerCtx(saCredentials()), "campaign", ["5", "6"], "active")
    expect(res.changes.map((c) => c.objectId)).toEqual(["5"])
    expect(res.warnings.join(" ")).toContain("EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED")
  })

  it("rejects more than 50 ids and non-digit ids", async () => {
    mockFetch()
    const ctx = providerCtx(saCredentials())
    await expect(setStatus(ctx, "campaign", Array.from({ length: 51 }, (_, i) => String(i + 1)), "paused")).rejects.toMatchObject({ code: "invalid_request" })
    await expect(setStatus(ctx, "campaign", ["1 OR 1=1"], "paused")).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("updateBudget", () => {
  const budgetRow = (over: Record<string, unknown> = {}) => ({
    campaign: { id: "10", name: "Search VN", status: "ENABLED" },
    campaignBudget: { id: "77", name: "Shared Q4", amountMicros: "500000000000", period: "DAILY", explicitlyShared: true, referenceCount: "3", ...over },
  })

  it("warns when the budget is shared by several campaigns and lists them", async () => {
    const m = mockFetch()
    m.on(searchMatching(/WHERE campaign\.id = 10/), { body: { results: [budgetRow()] } })
    m.on(searchMatching(/campaign_budget\.id = 77/), {
      body: { results: [{ campaign: { id: "10", name: "Search VN" } }, { campaign: { id: "11", name: "Search HN" } }, { campaign: { id: "12", name: "Brand" } }] },
    })
    m.on((c) => c.url.endsWith("campaignBudgets:mutate"), { body: { results: [{ resourceName: "customers/1234567890/campaignBudgets/77" }] } })
    const res = await updateBudget(providerCtx(saCredentials()), { level: "campaign", id: "10", type: "daily", amount: 750_000 })
    const body = mutateCalls(m, "campaignBudgets")[0]!.body as Body
    expect(body.operations).toEqual([{ update: { resourceName: "customers/1234567890/campaignBudgets/77", amountMicros: "750000000000" }, updateMask: "amount_micros" }])
    expect(res.warnings[0]).toContain("dùng chung cho 3 chiến dịch")
    expect(res.warnings[0]).toContain("Search HN (11)")
    expect(res.warnings[0]).toContain("Brand (12)")
    expect(res.warnings[0]).not.toContain("Search VN (10)")
    expect(res.changes[0]).toMatchObject({ field: "daily_budget", before: 500_000, after: 750_000 })
  })

  it("uses total_amount_micros for CUSTOM_PERIOD budgets and refuses a period change", async () => {
    const m = mockFetch()
    m.on(searchMatching(/WHERE campaign\.id = 10/), {
      body: { results: [budgetRow({ period: "CUSTOM_PERIOD", explicitlyShared: false, referenceCount: "1", amountMicros: undefined, totalAmountMicros: "9000000" })] },
    })
    m.on((c) => c.url.endsWith("campaignBudgets:mutate"), { body: { results: [{}] } })
    const ctx = providerCtx(saCredentials(), { account: { id: "a", externalId: "1234567890", name: "x", currency: "USD", timezone: "America/New_York" } })
    await expect(updateBudget(ctx, { level: "campaign", id: "10", type: "daily", amount: 10 })).rejects.toMatchObject({ code: "invalid_request" })
    const res = await updateBudget(ctx, { level: "campaign", id: "10", type: "lifetime", amount: 12.346 }, { dryRun: true })
    const body = mutateCalls(m, "campaignBudgets")[0]!.body as Body
    expect(body.validateOnly).toBe(true)
    expect(body.operations[0]).toEqual({ update: { resourceName: "customers/1234567890/campaignBudgets/77", totalAmountMicros: "12350000" }, updateMask: "total_amount_micros" })
    expect(res.warnings.join(" ")).toContain("làm tròn")
  })

  it("ad_group budgets are unsupported on Google", async () => {
    mockFetch()
    await expect(updateBudget(providerCtx(saCredentials()), { level: "ad_group", id: "1", type: "daily", amount: 1 })).rejects.toMatchObject({ code: "unsupported" })
  })
})

describe("updateObject", () => {
  it("sets start_date_time in account time zone and clears end_date_time via mask only", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), {
      body: { results: [{ campaign: { id: "10", name: "C", status: "PAUSED", startDateTime: "2026-10-10 00:00:00", endDateTime: "2026-12-31 23:59:59" } }] },
    })
    m.on((c) => c.url.endsWith("campaigns:mutate"), { body: { results: [{}] } })
    const res = await updateObject(providerCtx(saCredentials()), { level: "campaign", id: "10", changes: { name: "Mới", startTime: "2026-10-04T17:30:00Z", endTime: null } })
    const op = (mutateCalls(m, "campaigns")[0]!.body as Body).operations[0]!
    // 2026-10-04T17:30Z = 2026-10-05 00:30 in Asia/Ho_Chi_Minh → daily granularity
    expect(op.update).toEqual({ resourceName: "customers/1234567890/campaigns/10", name: "Mới", startDateTime: "2026-10-05 00:00:00" })
    expect(op.updateMask).toBe("name,start_date_time,end_date_time")
    expect(res.changes.map((c) => c.field)).toEqual(["name", "start_time", "end_time"])
  })

  it("rejects a start date in the past", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), { body: { results: [{ campaign: { id: "10", name: "C", status: "PAUSED" } }] } })
    await expect(updateObject(providerCtx(saCredentials()), { level: "campaign", id: "10", changes: { startTime: "2026-09-01T00:00:00+07:00" } })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("updates ad group cpc bid in micros", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group/), { body: { results: [{ campaign: { id: "1" }, adGroup: { id: "22", name: "AG", status: "ENABLED", cpcBidMicros: "5000000000" } }] } })
    m.on((c) => c.url.endsWith("adGroups:mutate"), { body: { results: [{}] } })
    const res = await updateObject(providerCtx(saCredentials()), { level: "ad_group", id: "22", changes: { bidAmount: 7500 } })
    const op = (mutateCalls(m, "adGroups")[0]!.body as Body).operations[0]!
    expect(op).toEqual({ update: { resourceName: "customers/1234567890/adGroups/22", cpcBidMicros: "7500000000" }, updateMask: "cpc_bid_micros" })
    expect(res.changes[0]).toMatchObject({ before: 5000, after: 7500 })
  })

  it("ad final URL goes to ads:mutate with final_urls mask", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_ad/), { body: { results: [{ adGroup: { id: "22" }, adGroupAd: { status: "PAUSED", ad: { id: "333", finalUrls: ["https://a.vn"] } } }] } })
    m.on((c) => c.url.endsWith("/ads:mutate"), { body: { results: [{}] } })
    await updateObject(providerCtx(saCredentials()), { level: "ad", id: "22~333", changes: { finalUrl: "https://b.vn/x" } })
    const op = (mutateCalls(m, "ads")[0]!.body as Body).operations[0]!
    expect(op).toEqual({ update: { resourceName: "customers/1234567890/ads/333", finalUrls: ["https://b.vn/x"] }, updateMask: "final_urls" })
  })

  it("rejects fields that do not exist at the level", async () => {
    mockFetch()
    await expect(updateObject(providerCtx(saCredentials()), { level: "campaign", id: "1", changes: { bidAmount: 1 } })).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("deleteObject", () => {
  it("sends a remove op (validateOnly on dryRun) and warns it is irreversible", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_criterion/), {
      body: { results: [{ adGroup: { id: "22" }, adGroupCriterion: { criterionId: "999", status: "ENABLED", keyword: { text: "giày" } } }] },
    })
    m.on((c) => c.url.endsWith("adGroupCriteria:mutate"), { body: {} })
    const res = await deleteObject(providerCtx(saCredentials()), "keyword", "22~999", { dryRun: true })
    const body = mutateCalls(m, "adGroupCriteria")[0]!.body as Body
    expect(body).toEqual({ operations: [{ remove: "customers/1234567890/adGroupCriteria/22~999" }], validateOnly: true })
    expect(res.warnings[0]).toContain("KHÔNG THỂ HOÀN TÁC")
    expect(res.changes[0]).toMatchObject({ before: "ENABLED", after: "REMOVED" })
  })

  it("asks for a composite id when a keyword criterion id is ambiguous", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [{ adGroup: { id: "1" }, adGroupCriterion: { criterionId: "9" } }, { adGroup: { id: "2" }, adGroupCriterion: { criterionId: "9" } }] } })
    await expect(deleteObject(providerCtx(saCredentials()), "keyword", "9")).rejects.toMatchObject({ code: "invalid_request" })
  })
})
