import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { getMetaObject, listMetaObjects } from "./objects"
import { graphError, json, mockGraph, providerCtx } from "./test-utils"

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

describe("getMetaObject - ad creative fields (v1.1.4 E4)", () => {
  it("reads creative{…call_to_action,page_welcome_message…} so the current greeting / CTA is visible", async () => {
    const m = mockGraph([
      [
        "GET",
        "11",
        () =>
          json({
            id: "11",
            name: "Ad",
            account_id: "1001",
            campaign_id: "3001",
            adset_id: "2001",
            status: "ACTIVE",
            effective_status: "ACTIVE",
            creative: {
              id: "100",
              object_story_id: "888_42",
              call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } },
              page_welcome_message: "Chào bạn",
            },
          }),
      ],
    ])
    const d = await getMetaObject(providerCtx(), "ad", "11")
    const fields = m.calls[0].params.fields
    const creative = /creative\{([^}]*)\}/.exec(fields)![1].split(",")
    expect(creative).toEqual(expect.arrayContaining(["page_welcome_message", "call_to_action", "call_to_action_type", "object_story_id", "effective_object_story_id"]))
    expect(d.config.creative).toMatchObject({ page_welcome_message: "Chào bạn", call_to_action: { type: "MESSAGE_PAGE" } })
  })
})

describe("getMetaObject - #100 field fallback (v1.1.4 E4 guard)", () => {
  const FIELD_ERR = () =>
    graphError(100, undefined, { message: "(#100) Tried accessing nonexisting field (page_welcome_message) on node type (AdCreative)" })
  const ad = {
    id: "11",
    name: "Ad",
    account_id: "1001",
    campaign_id: "3001",
    adset_id: "2001",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    creative: { id: "100", object_story_id: "888_42", call_to_action_type: "MESSAGE_PAGE" },
  }

  it("a creative field rejected with #100 → one silent retry with the v1.1.3 field list", async () => {
    const m = mockGraph([["GET", "11", (c) => ((c.params.fields ?? "").includes("page_welcome_message") ? FIELD_ERR() : json(ad))]])
    const d = await getMetaObject(providerCtx(), "ad", "11")
    expect(m.calls).toHaveLength(2)
    const second = /creative\{([^}]*)\}/.exec(m.calls[1]!.params.fields)![1]!.split(",")
    expect(second).not.toContain("page_welcome_message")
    expect(second).not.toContain("call_to_action")
    expect(second).toContain("call_to_action_type")
    expect(m.calls[1]!.params.fields).toContain("ad_review_feedback")
    expect(d).toMatchObject({ id: "11", config: { creative: { id: "100", call_to_action_type: "MESSAGE_PAGE" } } })
  })

  it("no retry for permission / not-found errors or other levels; a second #100 is surfaced", async () => {
    for (const [resp, code] of [
      [graphError(200), "permission_denied"],
      [graphError(100, 33), "not_found"],
    ] as const) {
      const m = mockGraph([["GET", "11", () => resp]])
      await expect(getMetaObject(providerCtx(), "ad", "11")).rejects.toMatchObject({ code })
      expect(m.calls).toHaveLength(1)
    }
    let m = mockGraph([["GET", "3001", () => FIELD_ERR()]])
    await expect(getMetaObject(providerCtx(), "campaign", "3001")).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls).toHaveLength(1)
    m = mockGraph([["GET", "11", () => FIELD_ERR()]])
    await expect(getMetaObject(providerCtx(), "ad", "11")).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls).toHaveLength(2)
  })
})
