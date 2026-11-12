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
    // a non-shop objective: these campaigns are never GMV Max candidates (no /gmv_max/campaign/get/ check)
    ...(level === "campaign" ? { objective_type: "TRAFFIC" } : {}),
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
  // TikTok refuses budget changes 23:55-00:00 account time (inBudgetLockWindow): pin the clock to midday so the
  // suite never depends on when it runs (it failed when run at 23:56 Asia/Ho_Chi_Minh)
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-02T05:00:00Z"))
  })
  afterEach(() => vi.useRealTimers())
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
    const m = mockTikTok({ "GET /ad/get/": { body: adFixture }, "GET /adgroup/get/": { body: adgroupFixture }, "POST /ad/update/": ok({}) })
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

describe("ad update: nội dung (changes.creative - D1)", () => {
  const AD_ID = "1810000000000001001"
  const BASE_AD = adFixture.data.list[0] as Record<string, unknown>
  /** /ad/get/ answering one ad = the fixture's first ad (Spark Push video, TT_USER) merged with `extra` */
  const adBody = (extra: Record<string, unknown> = {}) => ({
    ...adFixture,
    data: { ...adFixture.data, list: [{ ...BASE_AD, ...extra }] },
  })
  const groupBody = (extra: Record<string, unknown> = {}) => ({
    ...adgroupFixture,
    data: { ...adgroupFixture.data, list: [{ ...ADGROUP, ...extra }] },
  })
  const DM_GROUP = { promotion_type: "LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE", optimization_goal: "CONVERSATION" }
  const IM_GROUP = { promotion_type: "LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE", messaging_app_type: "ZALO", optimization_goal: "CLICK" }
  const run = (creative: Record<string, unknown>, ad: Record<string, unknown> = {}, group: Record<string, unknown> = {}, dryRun = false) => {
    const m = mockTikTok({ "GET /ad/get/": { body: adBody(ad) }, "GET /adgroup/get/": { body: groupBody(group) }, "POST /ad/update/": ok({}) })
    const p = updateTikTokObject(makeCtx(), { level: "ad", id: AD_ID, changes: { creative } }, { dryRun })
    return { m, p }
  }

  it("ad_text → patch_update chỉ gửi ad_text (làm sạch ký tự ẩn), cảnh báo duyệt lại", async () => {
    const { m, p } = run({ adText: "  Giảm 30%\u200b hôm nay\nthôi  " })
    const r = await p
    expect(m.callsTo("POST /ad/update/")[0]!.body).toEqual({
      advertiser_id: "7100000000000000001",
      adgroup_id: "1810000000000000101",
      patch_update: true,
      creatives: [{ ad_id: AD_ID, ad_text: "Giảm 30% hôm nay thôi" }],
    })
    expect(m.callsTo("GET /adgroup/get/")).toHaveLength(0)
    expect(r.changes).toEqual([expect.objectContaining({ field: "ad_text", before: "Giam 50% hom nay", after: "Giảm 30% hôm nay thôi" })])
    expect(r.warnings.join(" ")).toContain("duyệt lại")
  })

  it("ad_text có emoji / quá 100 ký tự → invalid, không POST", async () => {
    for (const adText of ["Sale 🔥 hôm nay", "x".repeat(101)]) {
      const { m, p } = run({ adText })
      await expect(p).rejects.toMatchObject({ code: "invalid_request" })
      expect(m.posts()).toHaveLength(0)
    }
  })

  it("ad_text khi quảng cáo có ad_texts (Search) → từ chối", async () => {
    const { p } = run({ adText: "Mới" }, { ad_texts: ["a", "b"] })
    await expect(p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("ad_texts") })
  })

  it("call_to_action → full update, bỏ call_to_action_id (CTA động), giữ các trường khác", async () => {
    const { m, p } = run({ callToAction: "LEARN_MORE" }, { call_to_action_id: "7300000000000000001" })
    const r = await p
    const body = m.callsTo("POST /ad/update/")[0]!.body!
    expect(body.patch_update).toBeUndefined()
    const cr = (body.creatives as Record<string, unknown>[])[0]!
    expect(cr).toMatchObject({ ad_id: AD_ID, call_to_action: "LEARN_MORE", video_id: BASE_AD.video_id, ad_text: BASE_AD.ad_text, landing_page_url: BASE_AD.landing_page_url })
    expect(cr).not.toHaveProperty("call_to_action_id")
    expect(r.warnings.join(" ")).toContain("CTA động")
    expect(r.warnings.join(" ")).toContain("gửi lại toàn bộ creative")
  })

  it("CTA trùng giá trị hiện tại → không POST", async () => {
    const { m, p } = run({ callToAction: "SHOP_NOW" })
    const r = await p
    expect(r.changes).toEqual([])
    expect(m.posts()).toHaveLength(0)
  })

  it("CTA sai định dạng → invalid", async () => {
    const { p } = run({ callToAction: "learn more" })
    await expect(p).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("full update khi quảng cáo có auto_message_id / số điện thoại → từ chối (có thể mất trường không gửi lại được)", async () => {
    for (const extra of [{ auto_message_id: "7400000000000000001" }, { phone_number: "0900000000" }]) {
      const { m, p } = run({ callToAction: "LEARN_MORE" }, extra)
      await expect(p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("gửi lại toàn bộ creative") })
      expect(m.posts()).toHaveLength(0)
    }
  })

  it("quảng cáo nhắn tin: patch (ad_text) vẫn được, giữ nguyên auto_message_id", async () => {
    const { m, p } = run({ adText: "Nhắn tin ngay" }, { auto_message_id: "7400000000000000001", call_to_action: "SEND_MESSAGE" }, DM_GROUP)
    await p
    const cr = (m.callsTo("POST /ad/update/")[0]!.body!.creatives as Record<string, unknown>[])[0]!
    expect(cr).toEqual({ ad_id: AD_ID, ad_text: "Nhắn tin ngay" })
  })

  it("nhóm tin nhắn TikTok: đổi CTA → từ chối (lời chào không gửi lại được)", async () => {
    const { m, p } = run({ callToAction: "LEARN_MORE" }, { call_to_action: "SEND_MESSAGE", landing_page_url: null }, DM_GROUP)
    await expect(p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("tin nhắn TikTok") })
    expect(m.posts()).toHaveLength(0)
  })

  it("nhóm nhắn tin qua ứng dụng: CALL_NOW bị từ chối; CTA khác SEND_MESSAGE được nhưng có cảnh báo", async () => {
    const bad = run({ callToAction: "CALL_NOW" }, { call_to_action: "SEND_MESSAGE" }, IM_GROUP)
    await expect(bad.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("CALL_NOW") })
    const ok2 = run({ callToAction: "CONTACT_US" }, { call_to_action: "SEND_MESSAGE" }, IM_GROUP)
    const r = await ok2.p
    expect(r.warnings.join(" ")).toContain("SEND_MESSAGE")
    expect(ok2.m.callsTo("POST /ad/update/")).toHaveLength(1)
  })

  it("nhóm Zalo: đổi URL đích → từ chối (TikTok tự tạo link)", async () => {
    const m = mockTikTok({ "GET /ad/get/": { body: adBody() }, "GET /adgroup/get/": { body: groupBody(IM_GROUP) }, "POST /ad/update/": ok({}) })
    await expect(
      updateTikTokObject(makeCtx(), { level: "ad", id: AD_ID, changes: { finalUrl: "https://zalo.me/123" } })
    ).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("ZALO") })
    expect(m.posts()).toHaveLength(0)
  })

  it("video_id + 1 ảnh bìa → patch; thiếu ảnh bìa → invalid", async () => {
    const { m, p } = run({ videoId: "v10033g50000bbbbbbbbbbbbbbb", imageIds: ["ad-site-i18n-sg/cover2"] })
    await p
    expect((m.callsTo("POST /ad/update/")[0]!.body!.creatives as unknown[])[0]).toEqual({
      ad_id: AD_ID,
      video_id: "v10033g50000bbbbbbbbbbbbbbb",
      image_ids: ["ad-site-i18n-sg/cover2"],
    })
    const missing = run({ videoId: "v10033g50000bbbbbbbbbbbbbbb" })
    await expect(missing.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("ảnh bìa") })
  })

  it("đổi video giữ nguyên ảnh bìa cũ → body vẫn gửi image_ids cùng video_id", async () => {
    const { m, p } = run({ videoId: "v10033g50000bbbbbbbbbbbbbbb", imageIds: [String((BASE_AD.image_ids as string[])[0])] })
    const r = await p
    expect((m.callsTo("POST /ad/update/")[0]!.body!.creatives as unknown[])[0]).toEqual({
      ad_id: AD_ID,
      video_id: "v10033g50000bbbbbbbbbbbbbbb",
      image_ids: BASE_AD.image_ids,
    })
    expect(m.callsTo("POST /ad/update/")[0]!.body!.patch_update).toBe(true)
    expect(r.changes.map((c) => c.field)).toEqual(["video_id"])
  })

  it("không đổi loại: video ↔ bài đăng TikTok", async () => {
    const toPost = run({ tiktokItemId: "7350000000000000001" })
    await expect(toPost.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("không đổi loại") })
    const spark = { tiktok_item_id: "7350000000000000001", video_id: null, image_ids: null }
    const toVideo = run({ videoId: "v10033g50000bbbbbbbbbbbbbbb", imageIds: ["c"] }, spark)
    await expect(toVideo.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("không đổi loại") })
    const images = run({ imageIds: ["c"] }, spark)
    await expect(images.p).rejects.toMatchObject({ code: "invalid_request" })
    const text = run({ adText: "Mới" }, spark)
    await expect(text.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("chú thích") })
  })

  it("Spark Ads từ bài đăng: đổi tiktok_item_id → patch", async () => {
    const { m, p } = run({ tiktokItemId: "7350000000000000002" }, { tiktok_item_id: "7350000000000000001", video_id: null, image_ids: null })
    const r = await p
    expect((m.callsTo("POST /ad/update/")[0]!.body!.creatives as unknown[])[0]).toEqual({ ad_id: AD_ID, tiktok_item_id: "7350000000000000002" })
    expect(m.callsTo("POST /ad/update/")[0]!.body!.patch_update).toBe(true)
    expect(r.changes[0]).toMatchObject({ field: "tiktok_item_id", before: "7350000000000000001", after: "7350000000000000002" })
  })

  it("ảnh: ảnh đơn đúng 1 ảnh; carousel 1–35 ảnh (cảnh báo thay toàn bộ)", async () => {
    const single = run({ imageIds: ["a", "b"] }, { ad_format: "SINGLE_IMAGE", video_id: null })
    await expect(single.p).rejects.toMatchObject({ code: "invalid_request" })
    const carousel = run({ imageIds: ["a", "b", "c"] }, { ad_format: "CAROUSEL_ADS", video_id: null })
    const r = await carousel.p
    expect(r.warnings.join(" ")).toContain("THAY TOÀN BỘ")
  })

  it("dryRun: preview, không POST", async () => {
    const { m, p } = run({ adText: "Xem trước" }, {}, {}, true)
    const r = await p
    expect(r.preview).toBe(true)
    expect(r.changes).toHaveLength(1)
    expect(m.posts()).toHaveLength(0)
  })

  it("Upgraded Smart+ / ACO → từ chối", async () => {
    const sp = run({ adText: "x" }, { campaign_automation_type: "UPGRADED_SMART_PLUS", smart_plus_ad_id: "1" })
    await expect(sp.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("Smart+") })
    const aco = run({ adText: "x" }, { is_aco: true })
    await expect(aco.p).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("ACO") })
    expect(sp.m.posts()).toHaveLength(0)
  })

  it("creative ở cấp chiến dịch / nhóm → từ chối", async () => {
    mockTikTok({})
    for (const level of ["campaign", "ad_group"] as const) {
      await expect(updateTikTokObject(makeCtx(), { level, id: "1", changes: { creative: { adText: "x" } } })).rejects.toMatchObject({
        code: "invalid_request",
      })
    }
  })
})
