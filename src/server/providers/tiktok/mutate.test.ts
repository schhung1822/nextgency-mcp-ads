import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import adFixture from "./__fixtures__/ad_get.json"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import { makeCtx, mockTikTok, ok, type RecordedCall } from "./__fixtures__/mock-fetch"
import { tiktokExtensions } from "./extensions"
import {
  ADGROUP_UPDATE_FIELDS,
  buildAdgroupUpdatePayload,
  deleteTikTokObject,
  inBudgetLockWindow,
  nextDayMidnightIso,
  setTikTokStatus,
  updateTikTokBudget,
  updateTikTokObject,
} from "./mutate"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ADGROUP = adgroupFixture.data.list[0] as Record<string, unknown>

function objectsFor(level: "campaign" | "adgroup", ids: string[], extra: Record<string, unknown> = {}) {
  return ids.map((id) => ({
    [`${level}_id`]: id,
    [`${level}_name`]: `N${id}`,
    operation_status: "ENABLE",
    secondary_status: level === "campaign" ? "CAMPAIGN_STATUS_ENABLE" : "ADGROUP_STATUS_DELIVERY_OK",
    campaign_automation_type: "MANUAL",
    ...extra,
  }))
}

describe("setStatus", () => {
  it("chia lô ≤20 id mỗi lần gọi /campaign/status/update/", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => String(1000 + i))
    const m = mockTikTok({
      "GET /campaign/get/": (c: RecordedCall) => ok({ list: objectsFor("campaign", (c.query.filtering as { campaign_ids: string[] }).campaign_ids), page_info: { total_page: 1 } }),
      "POST /campaign/status/update/": ok({ status: "DISABLE" }),
    })
    const res = await setTikTokStatus(makeCtx(), "campaign", ids, "paused")
    const posts = m.callsTo("POST /campaign/status/update/")
    expect(posts.map((p) => (p.body!.campaign_ids as string[]).length)).toEqual([20, 20, 5])
    expect(posts.every((p) => p.body!.operation_status === "DISABLE" && p.body!.advertiser_id === "7100000000000000001")).toBe(true)
    expect(posts.flatMap((p) => p.body!.campaign_ids as string[])).toEqual(ids)
    expect(res.changes).toHaveLength(45)
    expect(res.changes[0]).toMatchObject({ field: "status", before: "active", after: "paused" })
  })

  it("định tuyến Upgraded Smart+ sang /smart_plus/adgroup/status/update/", async () => {
    const m = mockTikTok({
      "GET /adgroup/get/": ok({
        list: [...objectsFor("adgroup", ["1"]), ...objectsFor("adgroup", ["2"], { campaign_automation_type: "UPGRADED_SMART_PLUS" })],
        page_info: { total_page: 1 },
      }),
      "POST /adgroup/status/update/": ok({}),
      "POST /smart_plus/adgroup/status/update/": ok({}),
    })
    await setTikTokStatus(makeCtx(), "ad_group", ["1", "2"], "paused")
    expect(m.callsTo("POST /adgroup/status/update/")[0]!.body!.adgroup_ids).toEqual(["1"])
    expect(m.callsTo("POST /smart_plus/adgroup/status/update/")[0]!.body!.adgroup_ids).toEqual(["2"])
  })

  it("dryRun không ghi gì", async () => {
    const m = mockTikTok({ "GET /campaign/get/": ok({ list: objectsFor("campaign", ["1"]), page_info: { total_page: 1 } }) })
    const res = await setTikTokStatus(makeCtx(), "campaign", ["1"], "paused", { dryRun: true })
    expect(res.preview).toBe(true)
    expect(res.changes).toHaveLength(1)
    expect(m.posts()).toHaveLength(0)
  })

  it("id không tồn tại → not_found", async () => {
    mockTikTok({ "GET /campaign/get/": ok({ list: [], page_info: { total_page: 0 } }) })
    await expect(setTikTokStatus(makeCtx(), "campaign", ["9"], "active")).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("deleteObject", () => {
  it("gửi operation_status DELETE; dryRun không ghi", async () => {
    const m = mockTikTok({
      "GET /ad/get/": { body: adFixture },
      "POST /ad/status/update/": ok({}),
    })
    const preview = await deleteTikTokObject(makeCtx(), "ad", "1810000000000001001", { dryRun: true })
    expect(preview.preview).toBe(true)
    expect(m.posts()).toHaveLength(0)
    await deleteTikTokObject(makeCtx(), "ad", "1810000000000001001")
    expect(m.callsTo("POST /ad/status/update/")[0]!.body).toEqual({
      advertiser_id: "7100000000000000001",
      ad_ids: ["1810000000000001001"],
      operation_status: "DELETE",
    })
  })
})

describe("updateBudget", () => {
  const routes = (extra: Record<string, unknown> = {}) => ({
    "GET /adgroup/get/": ok({ list: [{ ...ADGROUP, ...extra }], page_info: { total_page: 1 } }),
    "POST /adgroup/budget/update/": ok({}),
  })

  it("ngân sách ngày của ad group → scheduled_budget, hiệu lực 00:00 hôm sau giờ tài khoản", async () => {
    const m = mockTikTok(routes())
    const now = new Date("2026-10-02T08:00:00Z") // 15:00 Asia/Ho_Chi_Minh
    const res = await updateTikTokBudget(makeCtx(), { level: "ad_group", id: "1810000000000000101", type: "daily", amount: 750000 }, { now })
    expect(res.effectiveAt).toBe("2026-10-03T00:00:00+07:00")
    expect(res.warnings.some((w) => w.includes("00:00 ngày mai"))).toBe(true)
    expect(res.changes[0]).toMatchObject({ field: "daily_budget", before: 500000, after: 750000 })
    expect(m.callsTo("POST /adgroup/budget/update/")[0]!.body).toEqual({
      advertiser_id: "7100000000000000001",
      scheduled_budget: [{ adgroup_id: "1810000000000000101", scheduled_budget: 750000 }],
    })
  })

  it("ngân sách trọn đời → budget, hiệu lực ngay", async () => {
    const m = mockTikTok(routes({ budget_mode: "BUDGET_MODE_TOTAL", schedule_type: "SCHEDULE_START_END" }))
    const res = await updateTikTokBudget(makeCtx(), { level: "ad_group", id: "1810000000000000101", type: "lifetime", amount: 10_000_000 })
    expect(res.effectiveAt).toBeNull()
    expect(m.callsTo("POST /adgroup/budget/update/")[0]!.body!.budget).toEqual([{ adgroup_id: "1810000000000000101", budget: 10000000 }])
  })

  it("dryRun tính effectiveAt nhưng không ghi", async () => {
    const m = mockTikTok(routes())
    const res = await updateTikTokBudget(
      makeCtx(),
      { level: "ad_group", id: "1810000000000000101", type: "daily", amount: 600000 },
      { dryRun: true, now: new Date("2026-10-02T18:30:00Z") } // 01:30 on Oct 3 local
    )
    expect(res.preview).toBe(true)
    expect(res.effectiveAt).toBe("2026-10-04T00:00:00+07:00")
    expect(m.posts()).toHaveLength(0)
  })

  it("không đổi được loại ngân sách; CBO phải đổi ở chiến dịch", async () => {
    mockTikTok(routes())
    await expect(
      updateTikTokBudget(makeCtx(), { level: "ad_group", id: "1810000000000000101", type: "lifetime", amount: 1 })
    ).rejects.toMatchObject({ code: "invalid_request" })
    mockTikTok(routes({ budget_mode: "BUDGET_MODE_INFINITE", budget: 0 }))
    await expect(
      updateTikTokBudget(makeCtx(), { level: "ad_group", id: "1810000000000000101", type: "daily", amount: 1 })
    ).rejects.toThrow(/CBO/)
  })

  it("khung khoá 23:55–00:00 giờ tài khoản", () => {
    expect(inBudgetLockWindow("Asia/Ho_Chi_Minh", new Date("2026-10-02T16:57:00Z"))).toBe(true)
    expect(inBudgetLockWindow("Asia/Ho_Chi_Minh", new Date("2026-10-02T16:50:00Z"))).toBe(false)
    // 2026-10-01 23:00 PDT → next local midnight is Oct 2, UTC-7
    expect(nextDayMidnightIso("America/Los_Angeles", new Date("2026-10-02T06:00:00Z"))).toBe("2026-10-02T00:00:00-07:00")
  })

  it("Upgraded Smart+ ad group → /smart_plus/adgroup/budget/update/ (hiệu lực ngay)", async () => {
    const m = mockTikTok({
      "GET /adgroup/get/": ok({ list: [{ ...ADGROUP, campaign_automation_type: "UPGRADED_SMART_PLUS" }], page_info: { total_page: 1 } }),
      "POST /smart_plus/adgroup/budget/update/": ok({}),
    })
    const res = await updateTikTokBudget(makeCtx(), { level: "ad_group", id: "1810000000000000101", type: "daily", amount: 800000 })
    expect(res.effectiveAt).toBeNull()
    expect(m.callsTo("POST /smart_plus/adgroup/budget/update/")[0]!.body!.budget).toEqual([
      { adgroup_id: "1810000000000000101", budget: 800000 },
    ])
  })

  it("khung khoá 23:55–00:00 áp dụng cả cho ngân sách chiến dịch (không ghi)", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": ok({
        list: [{ ...campaignFixture.data.list[0], budget_mode: "BUDGET_MODE_DAY", budget: 1000000 }],
        page_info: { total_page: 1 },
      }),
    })
    const now = new Date("2026-10-02T16:57:00Z") // 23:57 Asia/Ho_Chi_Minh
    await expect(
      updateTikTokBudget(makeCtx(), { level: "campaign", id: "1810000000000000001", type: "daily", amount: 1500000 }, { now })
    ).rejects.toMatchObject({ code: "conflict" })
    expect(m.posts()).toHaveLength(0)
  })

  it("ngân sách chiến dịch → /campaign/update/", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": ok({
        list: [{ ...campaignFixture.data.list[0], budget_mode: "BUDGET_MODE_DAY", budget: 1000000 }],
        page_info: { total_page: 1 },
      }),
      "POST /campaign/update/": ok({}),
    })
    const res = await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: "1810000000000000001", type: "daily", amount: 1500000.4 },
      { now: new Date("2026-10-02T08:00:00Z") }
    )
    expect(res.effectiveAt).toBeNull()
    expect(res.warnings.join(" ")).toMatch(/không công bố thời điểm hiệu lực/)
    expect(m.callsTo("POST /campaign/update/")[0]!.body).toEqual({
      advertiser_id: "7100000000000000001",
      campaign_id: "1810000000000000001",
      budget: 1500000,
    })
  })
})

describe("ad group: thay thế toàn bộ (/adgroup/update/)", () => {
  it("giữ nguyên mọi trường sửa được, chỉ đổi trường yêu cầu, bỏ trường chỉ đọc", () => {
    const body = buildAdgroupUpdatePayload("71", ADGROUP, { adgroup_name: "Tên mới" })
    for (const k of ADGROUP_UPDATE_FIELDS) {
      if (k === "adgroup_name" || k === "schedule_end_time") continue // FROM_NOW: auto end time not echoed
      if (k === "schedule_start_time" || k === "schedule_type") continue // already started → schedule block not echoed (tested below)
      if (k === "budget") continue // only sent when the caller changes it (105%-of-spend rule) - tested below
      if (ADGROUP[k] === undefined || ADGROUP[k] === null) continue
      expect(body[k], `field ${k} lost`).toEqual(ADGROUP[k])
    }
    expect(body).not.toHaveProperty("budget")
    expect(body.adgroup_name).toBe("Tên mới")
    expect(body.adgroup_id).toBe("1810000000000000101")
    for (const ro of [
      "placements",
      "placement_type",
      "optimization_goal",
      "billing_event",
      "budget_mode",
      "create_time",
      "modify_time",
      "secondary_status",
      "operation_status",
      "campaign_automation_type",
      "promotion_type",
      "auto_targeting_enabled",
      "campaign_name",
    ]) {
      expect(body, ro).not.toHaveProperty(ro)
    }
    // SCHEDULE_FROM_NOW never echoes the auto end time
    expect(body).not.toHaveProperty("schedule_end_time")
    expect(body.actions).toEqual(ADGROUP.actions)
  })

  it("schedule_start_time đã qua, không đổi lịch → bỏ cả start/type/end (start bắt buộc đi cùng schedule_type)", () => {
    const now = new Date("2026-10-02T08:00:00Z")
    const started = { ...ADGROUP, schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-09-20 17:00:00", schedule_end_time: "2026-12-31 17:00:00" }
    const body = buildAdgroupUpdatePayload("71", started, { adgroup_name: "X" }, now)
    expect(body).not.toHaveProperty("schedule_start_time")
    expect(body).not.toHaveProperty("schedule_type")
    expect(body).not.toHaveProperty("schedule_end_time")

    // changing the end of a started group: old start sent unchanged next to schedule_type + new end
    const endChange = buildAdgroupUpdatePayload(
      "71",
      started,
      { schedule_type: "SCHEDULE_START_END", schedule_end_time: "2027-01-31 17:00:00" },
      now
    )
    expect(endChange.schedule_start_time).toBe("2026-09-20 17:00:00")
    expect(endChange.schedule_type).toBe("SCHEDULE_START_END")
    expect(endChange.schedule_end_time).toBe("2027-01-31 17:00:00")

    const future = { ...started, schedule_start_time: "2026-10-10 00:00:00" }
    expect(buildAdgroupUpdatePayload("71", future, { adgroup_name: "X" }, now).schedule_start_time).toBe("2026-10-10 00:00:00")
    expect(
      buildAdgroupUpdatePayload("71", future, { schedule_start_time: "2026-10-11 00:00:00" }, now).schedule_start_time
    ).toBe("2026-10-11 00:00:00")
  })

  it("updateObject đổi endTime của nhóm đã chạy → gửi end time kèm start time cũ không đổi", async () => {
    const m = mockTikTok({ "GET /adgroup/get/": { body: adgroupFixture }, "POST /adgroup/update/": ok({}) })
    await updateTikTokObject(makeCtx(), { level: "ad_group", id: "1810000000000000101", changes: { endTime: "2027-01-31T23:59:00+07:00" } })
    const body = m.callsTo("POST /adgroup/update/")[0]!.body!
    expect(body.schedule_type).toBe("SCHEDULE_START_END")
    expect(body.schedule_end_time).toBe("2027-01-31 16:59:00")
    expect(body.schedule_start_time).toBe(ADGROUP.schedule_start_time)
  })

  it("updateObject đổi startTime của nhóm đã bắt đầu → từ chối, không ghi", async () => {
    const m = mockTikTok({ "GET /adgroup/get/": { body: adgroupFixture } })
    await expect(
      updateTikTokObject(makeCtx(), { level: "ad_group", id: "1810000000000000101", changes: { startTime: "2027-01-01T00:00:00+07:00" } })
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.posts()).toHaveLength(0)
  })

  it("nhóm CBO không gửi budget/bid_type", () => {
    const body = buildAdgroupUpdatePayload("71", { ...ADGROUP, budget_mode: "BUDGET_MODE_INFINITE", budget: 0 }, {})
    expect(body).not.toHaveProperty("budget")
    expect(body).not.toHaveProperty("bid_type")
  })

  it("updateObject đổi giá thầu OCPM → conversion_bid_price, gửi đủ cấu hình", async () => {
    const m = mockTikTok({ "GET /adgroup/get/": { body: adgroupFixture }, "POST /adgroup/update/": ok({}) })
    const res = await updateTikTokObject(makeCtx(), { level: "ad_group", id: "1810000000000000101", changes: { bidAmount: 52000 } })
    const body = m.callsTo("POST /adgroup/update/")[0]!.body!
    expect(body.conversion_bid_price).toBe(52000)
    expect(body.location_ids).toEqual(["1562822"])
    expect(body.audience_ids).toEqual(["7300000000000000001"])
    expect(body.interest_category_ids).toEqual(["15000000000", "25000000000"])
    expect(body).not.toHaveProperty("budget") // unchanged budget not re-sent (would be checked against 105% of spend)
    expect(body.pixel_id).toBeUndefined() // immutable, not part of /adgroup/update/
    expect(res.changes).toEqual([
      expect.objectContaining({ field: "conversion_bid_price", before: 45000, after: 52000 }),
    ])
  })

  it("tiktok_update_targeting: GET → merge → full update, không mất trường nào", async () => {
    const m = mockTikTok({ "GET /adgroup/get/": { body: adgroupFixture }, "POST /adgroup/update/": ok({}) })
    const ext = tiktokExtensions.find((e) => e.name === "tiktok_update_targeting")!
    const input = ext.input.parse({ adgroup_id: "1810000000000000101", location_ids: ["1562822", "1566083"], age_groups: [] })
    const res = (await ext.run(makeCtx(), input, {})) as { changes: { field: string }[] }
    const body = m.callsTo("POST /adgroup/update/")[0]!.body!
    expect(body.location_ids).toEqual(["1562822", "1566083"])
    expect(body.age_groups).toEqual([])
    expect(body.gender).toBe("GENDER_FEMALE")
    expect(body.excluded_audience_ids).toEqual(["7300000000000000002"])
    expect(body.network_types).toEqual(["WIFI", "4G", "5G"])
    expect(body.conversion_bid_price).toBe(45000)
    expect(body.dayparting).toBe(ADGROUP.dayparting)
    expect(res.changes.map((c) => c.field).sort()).toEqual(["age_groups", "location_ids"])
  })

  it("dryRun của update_targeting không ghi", async () => {
    const m = mockTikTok({ "GET /adgroup/get/": { body: adgroupFixture } })
    const ext = tiktokExtensions.find((e) => e.name === "tiktok_update_targeting")!
    const res = (await ext.run(makeCtx(), ext.input.parse({ adgroup_id: "1810000000000000101", gender: "GENDER_UNLIMITED" }), {
      dryRun: true,
    })) as { preview: boolean }
    expect(res.preview).toBe(true)
    expect(m.posts()).toHaveLength(0)
  })
})

describe("ad update", () => {
  it("đổi tên → patch_update", async () => {
    const m = mockTikTok({ "GET /ad/get/": { body: adFixture }, "POST /ad/update/": ok({}) })
    await updateTikTokObject(makeCtx(), { level: "ad", id: "1810000000000001001", changes: { name: "Video 01 v2" } })
    expect(m.callsTo("POST /ad/update/")[0]!.body).toEqual({
      advertiser_id: "7100000000000000001",
      adgroup_id: "1810000000000000101",
      patch_update: true,
      creatives: [{ ad_id: "1810000000000001001", ad_name: "Video 01 v2" }],
    })
  })

  it("đổi URL đích → gửi đủ creative (không patch)", async () => {
    const m = mockTikTok({ "GET /ad/get/": { body: adFixture }, "POST /ad/update/": ok({}) })
    await updateTikTokObject(makeCtx(), { level: "ad", id: "1810000000000001001", changes: { finalUrl: "https://shop.example.vn/new" } })
    const body = m.callsTo("POST /ad/update/")[0]!.body!
    expect(body.patch_update).toBeUndefined()
    const cr = (body.creatives as Record<string, unknown>[])[0]!
    expect(cr).toMatchObject({
      ad_id: "1810000000000001001",
      ad_name: "Video review 01",
      identity_type: "TT_USER",
      identity_id: "6f1d2c3b-aaaa-bbbb-cccc-000000000001",
      ad_format: "SINGLE_VIDEO",
      video_id: "v10033g50000aaaaaaaaaaaaaaa",
      image_ids: ["ad-site-i18n-sg/202609200000aaaa"],
      ad_text: "Giam 50% hom nay",
      call_to_action: "SHOP_NOW",
      landing_page_url: "https://shop.example.vn/new",
      display_name: "Shop ABC",
    })
    expect(cr).not.toHaveProperty("operation_status")
    expect(cr).not.toHaveProperty("ad_texts")
    expect(cr).not.toHaveProperty("create_time")
  })

  it("chiến dịch không sửa được lịch/giá thầu", async () => {
    mockTikTok({})
    await expect(
      updateTikTokObject(makeCtx(), { level: "campaign", id: "1", changes: { startTime: "2026-10-05T00:00:00+07:00" } })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})
