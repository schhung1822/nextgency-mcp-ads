import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import { makeCtx, mockTikTok, ok } from "./__fixtures__/mock-fetch"
import { makeRequestId } from "./client"
import { GOAL_BILLING, tiktokExtensions } from "./extensions"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ext = (name: string) => tiktokExtensions.find((e) => e.name === name)!


/** tomorrow 00:00:00 UTC in TikTok's "YYYY-MM-DD HH:MM:SS" format (a fixed date turns into the past) */
const FUTURE_START = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 00:00:00`
describe("khai báo extension", () => {
  it("tên đúng quy ước, mô tả tiếng Việt bắt đầu bằng \"Dùng khi\", ≤1500 ký tự", () => {
    expect(tiktokExtensions.map((e) => e.name)).toEqual([
      "tiktok_create_campaign",
      "tiktok_create_adgroup",
      "tiktok_create_ads",
      "tiktok_update_targeting",
      "tiktok_create_smart_plus",
      "tiktok_messaging_assets",
      "tiktok_create_welcome_message",
      "tiktok_gmv_max_shops",
      "tiktok_gmv_max_campaigns",
      "tiktok_gmv_max_report",
      "tiktok_gmv_max_products",
      "tiktok_gmv_max_identities",
      "tiktok_gmv_max_bid_recommend",
      "tiktok_gmv_max_update",
      "tiktok_gmv_max_creatives",
      "tiktok_gmv_max_create",
    ])
    for (const e of tiktokExtensions) {
      expect(e.name).toMatch(/^tiktok_[a-z0-9_]{1,33}$/)
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
      expect(e.write).toBe(e.permission !== "read")
    }
    expect(tiktokExtensions.some((e) => e.name.includes("exchange"))).toBe(false)
  })
})

describe("tiktok_create_campaign", () => {
  const input = { name: "Sale 11.11", objective: "WEB_CONVERSIONS", budget_type: "daily", budget: 2_000_000 }

  it("luôn gửi operation_status DISABLE + request_id từ idempotencyKey; cảnh báo mốc 31/12/2026", async () => {
    const m = mockTikTok({ "POST /campaign/create/": ok({ campaign_id: "1830000000000000001" }) })
    const e = ext("tiktok_create_campaign")
    const res = (await e.run(makeCtx(), e.input.parse(input), { idempotencyKey: "k-123" })) as {
      createdIds: string[]
      warnings: string[]
    }
    expect(res.createdIds).toEqual(["1830000000000000001"])
    const body = m.callsTo("POST /campaign/create/")[0]!.body!
    expect(body).toEqual({
      advertiser_id: "7100000000000000001",
      campaign_name: "Sale 11.11",
      objective_type: "WEB_CONVERSIONS",
      budget_mode: "BUDGET_MODE_DAY",
      budget: 2000000,
      operation_status: "DISABLE",
      request_id: makeRequestId("k-123", "campaign"),
    })
    expect(res.warnings.some((w) => w.includes("31/12/2026"))).toBe(true)
  })

  it("dryRun trả tóm tắt payload, không gọi create", async () => {
    const m = mockTikTok({})
    const e = ext("tiktok_create_campaign")
    const res = (await e.run(makeCtx(), e.input.parse(input), { dryRun: true })) as { preview: boolean; payload: Record<string, unknown> }
    expect(res.preview).toBe(true)
    expect(res.payload.operation_status).toBe("DISABLE")
    expect(m.calls).toHaveLength(0)
  })

  it("CBO không cho unlimited; không CBO không cho dynamic_daily", async () => {
    mockTikTok({})
    const e = ext("tiktok_create_campaign")
    await expect(e.run(makeCtx(), e.input.parse({ name: "x", objective: "TRAFFIC", cbo: true }), { dryRun: true })).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      e.run(makeCtx(), e.input.parse({ name: "x", objective: "TRAFFIC", budget_type: "dynamic_daily", budget: 1 }), { dryRun: true })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("tiktok_create_adgroup", () => {
  const routes = { "GET /campaign/get/": { body: campaignFixture }, "POST /adgroup/create/": ok({ adgroup_id: "1840000000000000001" }) }
  const base = {
    campaign_id: "1810000000000000001",
    name: "HN - 25-44",
    promotion_type: "WEBSITE",
    location_ids: ["1562822"],
    budget_type: "daily",
    budget: 300000,
    optimization_goal: "CONVERT",
    pixel_id: "7200000000000000009",
    optimization_event: "SHOPPING",
    schedule_start_time: FUTURE_START,
  }

  it("tạo DISABLE + request_id, billing_event suy ra từ optimization_goal, lịch UTC", async () => {
    const m = mockTikTok(routes)
    const e = ext("tiktok_create_adgroup")
    await e.run(makeCtx(), e.input.parse(base), { idempotencyKey: "ag-1" })
    const body = m.callsTo("POST /adgroup/create/")[0]!.body!
    expect(body).toMatchObject({
      campaign_id: "1810000000000000001",
      adgroup_name: "HN - 25-44",
      operation_status: "DISABLE",
      request_id: makeRequestId("ag-1", "adgroup"),
      billing_event: "OCPM",
      optimization_goal: "CONVERT",
      placement_type: "PLACEMENT_TYPE_AUTOMATIC",
      location_ids: ["1562822"],
      budget_mode: "BUDGET_MODE_DAY",
      budget: 300000,
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: FUTURE_START,
      pixel_id: "7200000000000000009",
      optimization_event: "SHOPPING",
      bid_type: "BID_TYPE_NO_BID",
    })
    expect(body).not.toHaveProperty("placements")
  })

  it("bảng optimization_goal ↔ billing_event", async () => {
    expect(GOAL_BILLING.CLICK).toBe("CPC")
    expect(GOAL_BILLING.REACH).toBe("CPM")
    expect(GOAL_BILLING.ENGAGED_VIEW).toBe("CPV")
    expect(GOAL_BILLING.LEAD_GENERATION).toBe("OCPM")
    mockTikTok(routes)
    const e = ext("tiktok_create_adgroup")
    await expect(
      e.run(makeCtx(), e.input.parse({ ...base, optimization_goal: "CLICK", billing_event: "CPM", pixel_id: undefined, optimization_event: undefined }), {
        dryRun: true,
      })
    ).rejects.toThrow(/CPC/)
  })

  it("CONVERT thiếu pixel → lỗi; location id phải là số; lịch phải dạng UTC YYYY-MM-DD HH:MM:SS", async () => {
    mockTikTok(routes)
    const e = ext("tiktok_create_adgroup")
    await expect(e.run(makeCtx(), e.input.parse({ ...base, pixel_id: undefined }), { dryRun: true })).rejects.toThrow(/pixel_id/)
    expect(e.input.safeParse({ ...base, location_ids: ["VN"] }).success).toBe(false)
    expect(e.input.safeParse({ ...base, schedule_start_time: "2026-10-03T00:00:00Z" }).success).toBe(false)
  })

  it("dryRun đọc chiến dịch nhưng không tạo", async () => {
    const m = mockTikTok(routes)
    const e = ext("tiktok_create_adgroup")
    const res = (await e.run(makeCtx(), e.input.parse(base), { dryRun: true })) as { preview: boolean }
    expect(res.preview).toBe(true)
    expect(m.posts()).toHaveLength(0)
  })
})

describe("tiktok_create_ads", () => {
  const routes = {
    "GET /adgroup/get/": { body: adgroupFixture },
    "GET /ad/get/": ok({ list: [], page_info: { total_number: 2, total_page: 1 } }),
    "POST /ad/create/": ok({ ad_ids: ["1850000000000000001", "1850000000000000002"] }),
  }
  const video = {
    ad_name: "Spark 01",
    ad_format: "SINGLE_VIDEO",
    identity_type: "TT_USER",
    identity_id: "6f1d2c3b-aaaa-bbbb-cccc-000000000001",
    video_id: "v10033g50000bbbb",
    image_ids: ["cover-1"],
    ad_text: "Freeship toàn quốc",
    call_to_action: "SHOP_NOW",
    landing_page_url: "https://shop.example.vn/a",
  }

  it("mỗi creative có operation_status DISABLE; /ad/create/ không retry", async () => {
    const m = mockTikTok(routes)
    const e = ext("tiktok_create_ads")
    const res = (await e.run(
      makeCtx(),
      e.input.parse({ adgroup_id: "1810000000000000101", creatives: [video, { ...video, ad_name: "Spark 02", video_id: undefined, image_ids: undefined, tiktok_item_id: "7400000000000000123", identity_type: "AUTH_CODE" }] }),
      {}
    )) as { createdIds: string[] }
    expect(res.createdIds).toEqual(["1850000000000000001", "1850000000000000002"])
    const body = m.callsTo("POST /ad/create/")[0]!.body!
    const creatives = body.creatives as Record<string, unknown>[]
    expect(creatives.every((c) => c.operation_status === "DISABLE")).toBe(true)
    expect(creatives[1]).not.toHaveProperty("video_id")
  })

  it("video tải lên thiếu ảnh bìa → lỗi; tối đa 20 creative", async () => {
    mockTikTok(routes)
    const e = ext("tiktok_create_ads")
    await expect(
      e.run(makeCtx(), e.input.parse({ adgroup_id: "1810000000000000101", creatives: [{ ...video, image_ids: undefined }] }), { dryRun: true })
    ).rejects.toThrow(/ảnh bìa/)
    expect(e.input.safeParse({ adgroup_id: "1", creatives: Array.from({ length: 21 }, () => video) }).success).toBe(false)
  })

  it("dryRun không tạo", async () => {
    const m = mockTikTok(routes)
    const e = ext("tiktok_create_ads")
    await e.run(makeCtx(), e.input.parse({ adgroup_id: "1810000000000000101", creatives: [video] }), { dryRun: true })
    expect(m.posts()).toHaveLength(0)
  })
})
