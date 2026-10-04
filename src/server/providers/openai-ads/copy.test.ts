import { describe, expect, it } from "vitest"
import { copyObject } from "./copy"
import { apiError, calls, clone, freezeDate, fx, json, list, makeCtx, route, setupHarness, writes } from "./__fixtures__/harness"

setupHarness()

function mockSourceTree() {
  route("get", "/campaigns/cmpn_101", fx.campaign)
  route("get", "/ad_groups", list([fx.adGroup]))
  route("get", "/ads", list([fx.ad, clone(fx.ad, { id: "ad_302", status: "archived" })]))
}

describe("OpenAI Ads copy (giả lập)", () => {
  it("sao chép sâu campaign: giữ cấu hình, mọi object tạm dừng, Idempotency-Key riêng, dùng lại file_id", async () => {
    freezeDate()
    mockSourceTree()
    route("post", "/campaigns", clone(fx.campaign, { id: "cmpn_new", status: "paused" }))
    route("post", "/ad_groups", clone(fx.adGroup, { id: "adgrp_new", status: "paused" }))
    route("post", "/ads", clone(fx.ad, { id: "ad_new", status: "paused" }))

    const r = await copyObject(makeCtx(), { level: "campaign", id: "cmpn_101", deep: true, nameSuffix: " (copy)" }, { idempotencyKey: "op-1" })

    expect(r.mode).toBe("emulated")
    expect(r.rootNewId).toBe("cmpn_new")
    expect(r.mappings).toEqual([
      { level: "campaign", sourceId: "cmpn_101", newId: "cmpn_new" },
      { level: "ad_group", sourceId: "adgrp_201", newId: "adgrp_new" },
      { level: "ad", sourceId: "ad_301", newId: "ad_new" },
    ])
    const [cBody, gBody, aBody] = writes().map((w) => w.body as Record<string, unknown>)
    expect(cBody).toEqual({
      name: "Spring launch (copy)",
      status: "paused",
      budget: { daily_spend_limit_micros: 50_000_000 },
      bidding_type: "clicks",
      description: "Promote the new productivity bundle.",
      targeting: {
        locations: { countries: ["US"], include: [{ id: "geo_2840_ny" }] },
        custom_audiences: { ids: ["ca_1"] },
        platforms: { included: ["ios_app", "desktop_web"] },
      },
      landing_page_configuration: { query_string_template: "utm_source=chatgpt&utm_campaign={campaign_id}" },
      end_time: fx.campaign.end_time,
    })
    expect(gBody).toEqual({
      campaign_id: "cmpn_new",
      name: "Trail running",
      status: "paused",
      bidding_config: {
        billing_event_type: "click",
        strategy: "fixed_bid",
        max_bid_micros: 2_000_000,
        custom_audience_bid_multipliers: [{ custom_audience_id: "ca_1", bid_multiplier_micros: 1_500_000 }],
      },
      context_hints: fx.adGroup.context_hints,
    })
    expect(aBody).toEqual({
      ad_group_id: "adgrp_new",
      name: "Trail shoe launch",
      status: "paused",
      creative: {
        type: "chat_card",
        title: "Find your next trail shoe",
        body: "Explore shoes made for your next outdoor run.",
        target_url: "https://example.com/trail-shoes",
        file_id: "file_123",
      },
    })
    const keys = writes().map((w) => w.headers.get("idempotency-key"))
    expect(new Set(keys).size).toBe(3)
    expect(keys.every((k) => k && k.length <= 255)).toBe(true)
    expect(r.warnings.join(" ")).toContain("DUYỆT LẠI")
    expect(r.warnings.join(" ")).toContain("TẠM DỪNG")
  })

  it("cùng idempotencyKey → cùng Idempotency-Key cho từng object (retry không tạo trùng)", async () => {
    mockSourceTree()
    route("post", "/campaigns", clone(fx.campaign, { id: "cmpn_new" }))
    route("post", "/ad_groups", clone(fx.adGroup, { id: "adgrp_new" }))
    route("post", "/ads", clone(fx.ad, { id: "ad_new" }))
    await copyObject(makeCtx(), { level: "campaign", id: "cmpn_101", deep: true }, { idempotencyKey: "op-7" })
    const first = writes().map((w) => w.headers.get("idempotency-key"))
    calls.length = 0
    await copyObject(makeCtx(), { level: "campaign", id: "cmpn_101", deep: true }, { idempotencyKey: "op-7" })
    expect(writes().map((w) => w.headers.get("idempotency-key"))).toEqual(first)
  })

  it("dryRun: đọc cây nguồn, không tạo gì", async () => {
    mockSourceTree()
    const r = await copyObject(makeCtx(), { level: "campaign", id: "cmpn_101", deep: true }, { dryRun: true })
    expect(r.preview).toBe(true)
    expect(writes()).toHaveLength(0)
    expect(r.mappings.map((m) => m.sourceId)).toEqual(["cmpn_101", "adgrp_201", "ad_301"])
  })

  it("lỗi tạo ad group → ghi lỗi vào mapping, bỏ qua ad con, không dừng toàn bộ", async () => {
    mockSourceTree()
    route("post", "/campaigns", clone(fx.campaign, { id: "cmpn_new" }))
    route("post", "/ad_groups", () => apiError(400, "Invalid bidding_config"))
    const r = await copyObject(makeCtx(), { level: "campaign", id: "cmpn_101", deep: true })
    expect(r.rootNewId).toBe("cmpn_new")
    expect(r.mappings[1]).toMatchObject({ level: "ad_group", newId: null, error: expect.stringContaining("Invalid bidding_config") })
    expect(r.mappings[2]).toMatchObject({ level: "ad", newId: null })
    expect(writes().map((w) => w.path)).toEqual(["/campaigns", "/ad_groups"])
  })

  it("sao chép ad group không có targetParentId: tra campaign cha qua insights", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("get", "/ad_groups/adgrp_201/insights", {
      object: "list",
      data: [{ id: "x", start_time: 1, end_time: 2, campaign_id: "cmpn_101", ad_group_id: "adgrp_201" }],
      count: 1,
      first_id: "x",
      last_id: "x",
      has_more: false,
    })
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("post", "/ad_groups", (c) => json(clone(fx.adGroup, { id: "adgrp_copy", name: (c.body as { name: string }).name })))
    const r = await copyObject(makeCtx(), { level: "ad_group", id: "adgrp_201", deep: false })
    expect(r.rootNewId).toBe("adgrp_copy")
    const body = writes()[0]!.body as Record<string, unknown>
    expect(body.campaign_id).toBe("cmpn_101")
    expect(body.status).toBe("paused")
    expect(body.name).toBe("Trail running - bản sao")
  })
})
