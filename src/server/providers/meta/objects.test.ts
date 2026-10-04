import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { getMetaObject, listMetaObjects } from "./objects"
import { json, mockGraph, providerCtx } from "./test-utils"

beforeEach(() => __resetBuckets())

describe("listMetaObjects", () => {
  it("maps effective_status, CBO budget (USD minor → major) and wraps the cursor", async () => {
    const m = mockGraph([
      [
        "GET",
        "act_1001/campaigns",
        () =>
          json({
            data: [
              { id: "3001", name: "CBO", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "2550", start_time: "2026-09-01T00:00:00-0700" },
              { id: "3002", name: "ABO", status: "ACTIVE", effective_status: "WITH_ISSUES", objective: "OUTCOME_TRAFFIC" },
            ],
            paging: { cursors: { after: "QVFIUk" }, next: "https://graph.facebook.com/v26.0/act_1001/campaigns?after=QVFIUk" },
          }),
      ],
    ])
    const ctx = providerCtx({ currency: "USD" })
    const page = await listMetaObjects(ctx, { level: "campaign", statuses: ["active", "paused"], nameContains: "C", limit: 20 })
    // campaign effective_status enum has no CAMPAIGN_PAUSED/ADSET_PAUSED
    expect(JSON.parse(m.calls[0].params.effective_status)).toEqual(["ACTIVE", "PAUSED"])
    expect(JSON.parse(m.calls[0].params.filtering)).toEqual([{ field: "name", operator: "CONTAIN", value: "C" }])
    expect(page.items[0]).toMatchObject({
      id: "3001",
      level: "campaign",
      status: "active",
      objective: "OUTCOME_SALES",
      budget: { type: "daily", amount: 25.5, currency: "USD", level: "campaign" },
    })
    expect(page.items[1]).toMatchObject({ status: "disabled", statusRaw: "WITH_ISSUES", budget: null })
    expect(page.nextCursor).toBeTruthy()

    await listMetaObjects(ctx, { level: "campaign", statuses: ["active", "paused"], nameContains: "C", limit: 20, cursor: page.nextCursor })
    expect(m.calls[1].params.after).toBe("QVFIUk")
    await expect(listMetaObjects(ctx, { level: "ad", limit: 20, cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("lists ad sets under a parent after checking the parent's ad account", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json({ id: "3001", account_id: "1001" })],
      ["GET", "3001/adsets", () => json({ data: [{ id: "2001", name: "A", campaign_id: "3001", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", daily_budget: "500000" }] })],
    ])
    const page = await listMetaObjects(providerCtx(), { level: "ad_group", parentId: "3001", limit: 50 })
    expect(m.calls.map((c) => c.path)).toEqual(["3001", "3001/adsets"])
    expect(page.items[0]).toMatchObject({ level: "ad_group", parentId: "3001", status: "paused", budget: { amount: 500000, currency: "VND" } })
  })
})

describe("getMetaObject", () => {
  it("returns config with money in major units and the campaign → ad set → ad tree", async () => {
    mockGraph([
      ["GET", "3001", () => json({ id: "3001", name: "Camp", account_id: "1001", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_SALES", lifetime_budget: "9000000", spend_cap: "0" })],
      ["GET", "3001/adsets", () => json({ data: [{ id: "2001", name: "A", campaign_id: "3001", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", targeting: { geo_locations: { countries: ["VN"] } } }] })],
      ["GET", "3001/ads", () => json({ data: [{ id: "11", name: "Ad", campaign_id: "3001", adset_id: "2001", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED" }] })],
    ])
    const d = await getMetaObject(providerCtx(), "campaign", "3001", { includeChildren: true })
    expect(d.budget).toEqual({ type: "lifetime", amount: 9000000, currency: "VND", level: "campaign" })
    expect(d.config.lifetime_budget).toBe(9000000)
    expect(d.children).toHaveLength(1)
    expect(d.children![0].config.targeting).toEqual({ geo_locations: { countries: ["VN"] } })
    expect(d.children![0].children!.map((a) => [a.id, a.status])).toEqual([["11", "paused"]])
  })

  it("rejects objects of another ad account and non-numeric ids", async () => {
    mockGraph([["GET", "3001", () => json({ id: "3001", account_id: "999", objective: "OUTCOME_SALES" })]])
    await expect(getMetaObject(providerCtx(), "campaign", "3001")).rejects.toMatchObject({ code: "not_found" })
    await expect(getMetaObject(providerCtx(), "campaign", "act_1/../x")).rejects.toMatchObject({ code: "invalid_request" })
  })
})
