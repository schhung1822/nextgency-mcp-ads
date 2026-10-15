import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { isProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import type { ReportQuery } from "../types"
import insights from "./__fixtures__/insights_campaign_daily.json"
import { META_TIMINGS } from "./client"
import { buildInsightParams, getMetaReport, insightFields, normalizeInsight } from "./report"
import { graphError, json, mockGraph, providerCtx } from "./test-utils"

const saved = { ...META_TIMINGS }
beforeEach(() => {
  __resetBuckets()
  META_TIMINGS.pollIntervalMs = 1
  META_TIMINGS.asyncReportMaxWaitMs = 200
})
afterEach(() => Object.assign(META_TIMINGS, saved))

const baseQuery: ReportQuery = {
  level: "campaign",
  dateRange: { from: "2026-09-28", to: "2026-09-28" },
  granularity: "day",
  metrics: "conversion",
  limit: 50,
}

describe("normalizeInsight", () => {
  const fields = insightFields("campaign", "conversion")

  it("normalizes a sales row (results, omni_purchase, purchase_roas, messages)", () => {
    const m = normalizeInsight(insights.data[0], fields)
    expect(m).toMatchObject({
      spend: 1523400,
      impressions: 84512,
      reach: 51230,
      clicks: 2310,
      link_clicks: 1874,
      ctr: 2.733338, // already a percentage
      cpc: 659.480519,
      cpm: 18025.369179,
      conversions: 41, // `results` (the ad set's optimization result) wins
      purchases: 43, // omni_purchase preferred over pixel/purchase duplicates
      conversion_value: 19230000,
      cpa: 37156.097561, // cost_per_result
      roas: 12.62308,
      messages: 12,
      leads: 0,
      video_views: 930,
    })
    expect(m.frequency).toBeCloseTo(1.649658)
  })

  it("normalizes a lead row without results/roas (fallbacks, roas computed, no NaN)", () => {
    const m = normalizeInsight(insights.data[1], fields)
    expect(m.leads).toBe(27)
    expect(m.purchases).toBe(0)
    expect(m.conversions).toBe(27) // no results → purchases(none) → leads
    expect(m.cpa).toBeCloseTo(402000 / 27)
    expect(m.conversion_value).toBe(0)
    expect(m.roas).toBe(0)
  })

  it("leaves conversion metrics null when the preset did not request them", () => {
    const m = normalizeInsight(insights.data[0], insightFields("campaign", "basic"))
    expect(m.spend).toBe(1523400)
    expect(m.conversions).toBeNull()
    expect(m.purchases).toBeNull()
    expect(m.roas).toBeNull()
    expect(m.video_views).toBeNull()
  })

  it("onsite_conversion.purchase (purchases through messaging) is only a fallback - never added to another purchase type", () => {
    const base = { spend: "100000", impressions: "1000", clicks: "10", inline_link_clicks: "5" }
    const onlyOnsite = normalizeInsight(
      {
        ...base,
        actions: [
          { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "20" },
          { action_type: "onsite_conversion.purchase", value: "4" },
        ],
        action_values: [{ action_type: "onsite_conversion.purchase", value: "1200000" }],
      },
      fields
    )
    expect(onlyOnsite).toMatchObject({ purchases: 4, conversions: 4, conversion_value: 1200000, messages: 20, roas: 12 })
    const both = normalizeInsight(
      {
        ...base,
        actions: [
          { action_type: "onsite_conversion.purchase", value: "4" },
          { action_type: "omni_purchase", value: "6" },
        ],
        action_values: [
          { action_type: "onsite_conversion.purchase", value: "1200000" },
          { action_type: "omni_purchase", value: "1800000" },
        ],
      },
      fields
    )
    expect(both).toMatchObject({ purchases: 6, conversion_value: 1800000 }) // omni_purchase wins, no 4 + 6
  })

  it("never requests 7d_view/28d_view attribution or action_report_time", () => {
    const all = insightFields("ad", "all").join(",")
    expect(all).not.toMatch(/7d_view|28d_view|action_attribution_windows/)
  })
})

describe("getMetaReport", () => {
  it("queries account insights with level + time_increment=1 and wraps the Graph cursor", async () => {
    const m = mockGraph([["GET", "act_1001/insights", () => json(insights)]])
    const ctx = providerCtx()
    const page = await getMetaReport(ctx, {
      ...baseQuery,
      filters: { campaignIds: ["120210000000000001"], statuses: ["active"], nameContains: "Tết" },
    })
    const p = m.calls[0].params
    expect(p.level).toBe("campaign")
    expect(p.time_increment).toBe("1")
    expect(JSON.parse(p.time_range)).toEqual({ since: "2026-09-28", until: "2026-09-28" })
    expect(p.action_attribution_windows).toBeUndefined()
    expect(JSON.parse(p.filtering)).toEqual([
      { field: "campaign.id", operator: "IN", value: ["120210000000000001"] },
      { field: "campaign.effective_status", operator: "IN", value: ["ACTIVE"] },
      { field: "campaign.name", operator: "CONTAIN", value: "Tết" },
    ])
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]).toMatchObject({ date: "2026-09-28", level: "campaign", campaignId: "120210000000000001", campaignName: "Sales - Tết 2026" })
    expect(page.currency).toBe("VND")
    expect(page.nextCursor).toBeTruthy()
    expect(page.nextCursor).not.toBe("MQZDZD") // opaque

    // next page passes Graph's `after`
    const page2 = await getMetaReport(ctx, {
      ...baseQuery,
      filters: { campaignIds: ["120210000000000001"], statuses: ["active"], nameContains: "Tết" },
      cursor: page.nextCursor,
    })
    expect(m.calls[1].params.after).toBe("MQZDZD")
    expect(page2.rows).toHaveLength(2)
  })

  it("uses time_increment=all_days for total granularity", async () => {
    const m = mockGraph([["GET", "act_1001/insights", () => json({ data: [] })]])
    const page = await getMetaReport(providerCtx(), { ...baseQuery, granularity: "total" })
    expect(m.calls[0].params.time_increment).toBe("all_days")
    expect(page.nextCursor).toBeNull()
  })

  it("rejects a cursor from a different query", async () => {
    mockGraph([["GET", "act_1001/insights", () => json(insights)]])
    const page = await getMetaReport(providerCtx(), baseQuery)
    await expect(getMetaReport(providerCtx(), { ...baseQuery, level: "ad", cursor: page.nextCursor })).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(getMetaReport(providerCtx(), { ...baseQuery, cursor: "garbage" })).rejects.toMatchObject({ code: "invalid_request" })
  })

  it.each([
    ["error 1 (reduce the amount of data)", () => graphError(1, undefined, { message: "Please reduce the amount of data you're asking for, then retry your request" }, 500)],
    ["error 100/1487534", () => graphError(100, 1487534)],
  ])("switches to an async report run on %s", async (_label, err) => {
    let polls = 0
    const m = mockGraph([
      ["GET", "act_1001/insights", err],
      ["POST", "act_1001/insights", () => json({ report_run_id: "6000001" })],
      [
        "GET",
        "6000001",
        () => {
          polls++
          return json(
            polls < 2
              ? { id: "6000001", async_status: "Job Running", async_percent_completion: 40 }
              : { id: "6000001", async_status: "Job Completed", async_percent_completion: 100 }
          )
        },
      ],
      ["GET", "6000001/insights", () => json({ data: insights.data })],
    ])
    const page = await getMetaReport(providerCtx(), baseQuery)
    expect(page.rows).toHaveLength(2)
    expect(polls).toBe(2)
    const post = m.calls.find((c) => c.method === "POST")!
    expect(post.params.level).toBe("campaign")
    expect(post.params.time_increment).toBe("1")
    // the sync "too much data" error is not retried
    expect(m.calls.filter((c) => c.method === "GET" && c.path === "act_1001/insights")).toHaveLength(1)
  })

  it("goes async directly for heavy requests and returns a resumable cursor when the job is still running", async () => {
    let completed = false
    const m = mockGraph([
      ["POST", "act_1001/insights", () => json({ report_run_id: "6000002" })],
      [
        "GET",
        "6000002",
        (c) =>
          json(
            c.params.fields === "account_id"
              ? { id: "6000002", account_id: owner }
              : completed
                ? { async_status: "Job Completed", async_percent_completion: 100 }
                : { async_status: "Job Running", async_percent_completion: 10 }
          ),
      ],
      ["GET", "6000002/insights", () => json({ data: [insights.data[0]] })],
    ])
    let owner = "1001"
    const q: ReportQuery = { ...baseQuery, level: "ad", dateRange: { from: "2026-06-01", to: "2026-09-28" } }
    const first = await getMetaReport(providerCtx(), q)
    expect(m.calls.some((c) => c.method === "GET" && c.path === "act_1001/insights")).toBe(false)
    expect(first.rows).toEqual([])
    expect(first.nextCursor).toBeTruthy()
    expect(first.warnings.join(" ")).toMatch(/bất đồng bộ/)

    completed = true
    // a run that belongs to another ad account is refused before any insights are read
    owner = "2002"
    await expect(getMetaReport(providerCtx(), { ...q, cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls.some((c) => c.path === "6000002/insights")).toBe(false)

    owner = "1001"
    const second = await getMetaReport(providerCtx(), { ...q, cursor: first.nextCursor })
    expect(second.rows).toHaveLength(1)
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(1) // job not restarted
  })

  it("surfaces a failed async job as a ProviderError", async () => {
    mockGraph([
      ["POST", "act_1001/insights", () => json({ report_run_id: "6000003" })],
      ["GET", "6000003", () => json({ async_status: "Job Failed", async_percent_completion: 0, error_code: 1, error_message: "boom" })],
    ])
    const err = await getMetaReport(providerCtx(), { ...baseQuery, level: "ad", dateRange: { from: "2026-01-01", to: "2026-09-28" } }).catch((e) => e)
    expect(isProviderError(err) && err.code).toBe("upstream_error")
  })

  it("rejects the keyword level", async () => {
    mockGraph([])
    await expect(getMetaReport(providerCtx(), { ...baseQuery, level: "keyword" })).rejects.toMatchObject({ code: "unsupported" })
  })
})

describe("buildInsightParams - deleted/archived objects & effective_status per level", () => {
  it("warns that DELETED/ARCHIVED objects are excluded by default (not at account level)", () => {
    const w: string[] = []
    const { params } = buildInsightParams(baseQuery, w)
    expect(params.filtering).toBeUndefined()
    expect(w.join(" ")).toMatch(/DELETED\/ARCHIVED/)
    const w2: string[] = []
    buildInsightParams({ ...baseQuery, level: "account" }, w2)
    expect(w2).toEqual([])
  })

  it.each([
    ["campaign", ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"]],
    ["ad_group", ["ACTIVE", "PAUSED", "DELETED", "CAMPAIGN_PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"]],
  ] as const)("includeDeleted at %s level only sends values valid for that level", (level, expected) => {
    const w: string[] = []
    const { params } = buildInsightParams({ ...baseQuery, level, filters: { includeDeleted: true } }, w)
    const [flt] = params.filtering as { field: string; value: string[] }[]
    expect(flt.value).toEqual(expected)
    expect(w).toEqual([])
  })

  it("includeDeleted at ad level includes ad-only statuses", () => {
    const { params } = buildInsightParams({ ...baseQuery, level: "ad", filters: { includeDeleted: true } }, [])
    const [flt] = params.filtering as { field: string; value: string[] }[]
    expect(flt.field).toBe("ad.effective_status")
    expect(flt.value).toEqual(expect.arrayContaining(["ADSET_PAUSED", "DISAPPROVED", "PENDING_REVIEW", "DELETED", "ARCHIVED"]))
  })

  it("status filter drops values not valid for the level; impossible status → invalid_request", () => {
    const { params } = buildInsightParams({ ...baseQuery, filters: { statuses: ["paused"] } }, [])
    expect((params.filtering as { value: string[] }[])[0].value).toEqual(["PAUSED"])
    expect(() => buildInsightParams({ ...baseQuery, filters: { statuses: ["rejected"] } }, [])).toThrow(/không áp dụng/)
  })
})
