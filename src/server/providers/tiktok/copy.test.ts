import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import adFixture from "./__fixtures__/ad_get.json"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import { fail, makeCtx, mockTikTok, ok, type RecordedCall } from "./__fixtures__/mock-fetch"
import { adgroupCreateBody, CAMPAIGN_CREATE_FIELDS, copyTikTokObject, COPY_POLL, freshSchedule } from "./copy"

const NOW = new Date("2026-10-02T08:00:00Z")
const savedPoll = { ...COPY_POLL }

beforeEach(() => {
  __resetBuckets()
  Object.assign(COPY_POLL, { initialDelayMs: 0, intervalMs: 0, timeoutMs: 1_000 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(COPY_POLL, savedPoll)
})

function treeRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /campaign/get/": { body: campaignFixture },
    "GET /adgroup/get/": { body: adgroupFixture },
    "GET /ad/get/": { body: adFixture },
    ...extra,
  }
}

describe("copy campaign", () => {
  it("copy task trả 40118 → tự chuyển sang DIY: mọi object tạo mới đều DISABLE + request_id riêng", async () => {
    let n = 0
    const m = mockTikTok(
      treeRoutes({
        "POST /campaign/copy/task/create/": fail(40118, "The advertiser is not in the allowlist"),
        "POST /campaign/create/": ok({ campaign_id: "1900000000000000001" }),
        "POST /adgroup/create/": ok({ adgroup_id: "1900000000000000101" }),
        "POST /ad/create/": () => ok({ ad_ids: [`19000000000000010${++n}0`, `19000000000000010${++n}0`] }),
      })
    )
    const res = await copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true }, { now: NOW, idempotencyKey: "idem-1" })
    expect(res.mode).toBe("emulated")
    expect(res.preview).toBe(false)
    expect(res.rootNewId).toBe("1900000000000000001")
    expect(res.mappings).toEqual([
      { level: "campaign", sourceId: "1810000000000000001", newId: "1900000000000000001" },
      { level: "ad_group", sourceId: "1810000000000000101", newId: "1900000000000000101" },
      { level: "ad", sourceId: "1810000000000001001", newId: "1900000000000001010" },
      { level: "ad", sourceId: "1810000000000001002", newId: "1900000000000001020" },
    ])

    const camp = m.callsTo("POST /campaign/create/")[0]!.body!
    expect(camp.operation_status).toBe("DISABLE")
    expect(camp.campaign_name).toBe("Sale thang 10 - Bản sao")
    expect(camp.request_id).toMatch(/^\d+$/)
    for (const k of Object.keys(camp)) {
      expect(["advertiser_id", "campaign_name", "operation_status", "request_id", ...CAMPAIGN_CREATE_FIELDS]).toContain(k)
    }
    expect(camp).not.toHaveProperty("campaign_id")
    expect(camp).not.toHaveProperty("campaign_automation_type")

    const ag = m.callsTo("POST /adgroup/create/")[0]!.body!
    expect(ag.operation_status).toBe("DISABLE")
    expect(ag.campaign_id).toBe("1900000000000000001")
    expect(ag.request_id).toMatch(/^\d+$/)
    expect(ag.request_id).not.toBe(camp.request_id)
    expect(ag.schedule_type).toBe("SCHEDULE_FROM_NOW")
    expect(ag.schedule_start_time).toBe("2026-10-02 08:10:00") // old start was in the past
    expect(ag).not.toHaveProperty("schedule_end_time")
    expect(ag.placements).toEqual(["PLACEMENT_TIKTOK"])
    for (const ro of ["adgroup_id", "create_time", "secondary_status", "campaign_automation_type", "is_new_structure", "auto_targeting_enabled", "scheduled_budget"]) {
      expect(ag, ro).not.toHaveProperty(ro)
    }
    expect(ag.location_ids).toEqual(["1562822"])
    expect(ag.pixel_id).toBe("7200000000000000009")

    const ads = m.callsTo("POST /ad/create/")
    expect(ads).toHaveLength(1)
    const creatives = ads[0]!.body!.creatives as Record<string, unknown>[]
    expect(creatives).toHaveLength(2)
    expect(creatives.every((c) => c.operation_status === "DISABLE")).toBe(true)
    expect(creatives[0]).not.toHaveProperty("ad_id")
    expect(creatives[0]).not.toHaveProperty("ad_id_v2")
    expect(creatives[0]).not.toHaveProperty("is_aco")
    expect(ads[0]!.body!.adgroup_id).toBe("1900000000000000101")

    expect(res.warnings.some((w) => w.includes("allowlist"))).toBe(true)
    expect(res.warnings.some((w) => w.includes("31/12/2026"))).toBe(true)
    expect(res.warnings.some((w) => w.includes("Custom Identity"))).toBe(true)
    // same idempotency key → same campaign request_id (TikTok de-duplicates retries)
    expect(camp.request_id).toBe(
      (await import("./client")).makeRequestId("idem-1", "campaign")
    )
  })

  it("copy task chính thức thành công: map id + tắt các nhóm quảng cáo bản sao", async () => {
    const m = mockTikTok(
      treeRoutes({
        "POST /campaign/copy/task/create/": ok({ task_id: "task-1", adgroup_error_list: [] }),
        "GET /campaign/copy/task/check/": (_c: RecordedCall, nth: number) =>
          nth === 0
            ? ok({ task_status: "RUNNING" })
            : ok({
                task_status: "SUCCESS",
                task_result: {
                  campaign_id: "1950000000000000001",
                  campaign_name: "Sale thang 10 - Bản sao",
                  campaign_error_infos: [],
                  adgroup_result_list: [
                    {
                      adgroup_id: "1950000000000000101",
                      adgroup_name: "HCM - Nu 18-34",
                      adgroup_error_list: [],
                      ad_result_list: [
                        { ad_id: "1950000000000001001", ad_name: "Video review 01", is_success: true, ad_error_list: [] },
                        { ad_id: null, ad_name: "Anh san pham 02", is_success: false, ad_error_list: ["Custom identity not supported"] },
                      ],
                    },
                  ],
                },
              }),
        "POST /adgroup/status/update/": ok({}),
      })
    )
    // start time of the source ad group is far in the past → FROM_NOW schedule override
    const res = await copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true }, { now: NOW })
    expect(res.mode).toBe("native")
    expect(res.rootNewId).toBe("1950000000000000001")
    expect(res.mappings).toEqual([
      { level: "campaign", sourceId: "1810000000000000001", newId: "1950000000000000001" },
      { level: "ad_group", sourceId: "1810000000000000101", newId: "1950000000000000101" },
      { level: "ad", sourceId: "1810000000000001001", newId: "1950000000000001001" },
      { level: "ad", sourceId: "1810000000000001002", newId: null, error: "Custom identity not supported" },
    ])
    const task = m.callsTo("POST /campaign/copy/task/create/")[0]!.body!
    expect(task).toMatchObject({ operation_status: "DISABLE", deep_copy_mode: "CUSTOM", schedule_type: "SCHEDULE_FROM_NOW" })
    // copied ad groups/ads default to ENABLE on TikTok → every one is listed with DISABLE
    expect(task.adgroup_list).toEqual([
      {
        adgroup_id: "1810000000000000101",
        adgroup_name: "HCM - Nu 18-34", // names sent explicitly → results mapped back by name
        operation_status: "DISABLE",
        ad_list: [
          { ad_id: "1810000000000001001", ad_name: "Video review 01", operation_status: "DISABLE" },
          { ad_id: "1810000000000001002", ad_name: "Anh san pham 02", operation_status: "DISABLE" },
        ],
      },
    ])
    expect(task.request_id).toMatch(/^\d+$/)
    expect(m.callsTo("POST /adgroup/status/update/")[0]!.body).toMatchObject({
      adgroup_ids: ["1950000000000000101"],
      operation_status: "DISABLE",
    })
    expect(m.callsTo("POST /campaign/create/")).toHaveLength(0)
  })

  it("lỗi mạng khi poll → vẫn trả task_id (cảnh báo + mapping), không ném lỗi, không tạo DIY", async () => {
    const m = mockTikTok(
      treeRoutes({
        "POST /campaign/copy/task/create/": ok({ task_id: "task-77", adgroup_error_list: [] }),
        "GET /campaign/copy/task/check/": { status: 503, body: "Service Unavailable" },
      })
    )
    const res = await copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true }, { now: NOW })
    expect(res.preview).toBe(false)
    expect(res.mode).toBe("native")
    expect(res.rootNewId).toBeNull()
    expect(res.mappings[0]).toMatchObject({ level: "campaign", newId: null, error: expect.stringContaining("task-77") })
    expect(res.warnings.join(" ")).toMatch(/task_id task-77/)
    expect(res.warnings.join(" ")).toMatch(/KHÔNG chạy sao chép lại/)
    expect(m.callsTo("POST /campaign/create/")).toHaveLength(0)
  })

  it("poll quá hạn → trả task_id", async () => {
    Object.assign(COPY_POLL, { timeoutMs: 0 })
    mockTikTok(
      treeRoutes({
        "POST /campaign/copy/task/create/": ok({ task_id: "task-88" }),
        "GET /campaign/copy/task/check/": ok({ task_status: "RUNNING" }),
      })
    )
    const res = await copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true }, { now: NOW })
    expect(res.mappings[0]!.error).toContain("task-88")
    expect(res.warnings.join(" ")).toMatch(/vẫn đang xử lý/)
  })

  it("task FAILURE với campaign_error_infos dạng object → thông báo không có [object Object]", async () => {
    mockTikTok(
      treeRoutes({
        "POST /campaign/copy/task/create/": ok({ task_id: "task-9" }),
        "GET /campaign/copy/task/check/": ok({
          task_status: "FAILURE",
          task_result: { campaign_error_infos: [{ error_code: 40002, error_message: "budget too low" }] },
        }),
      })
    )
    const err = await copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true }, { now: NOW }).catch((e) => e)
    expect(err.userMessageVi).toContain("budget too low")
    expect(err.userMessageVi).toContain("task-9")
    expect(err.userMessageVi).not.toContain("[object Object]")
  })

  it("dryRun: đọc cây, không gọi bất kỳ POST nào", async () => {
    const m = mockTikTok(treeRoutes())
    const res = await copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true }, { dryRun: true, now: NOW })
    expect(res.preview).toBe(true)
    expect(res.mappings.map((x) => x.level)).toEqual(["campaign", "ad_group", "ad", "ad"])
    expect(res.mappings.every((x) => x.newId === null)).toBe(true)
    expect(m.posts()).toHaveLength(0)
  })

  it("từ chối Smart+ đời cũ", async () => {
    mockTikTok({
      "GET /campaign/get/": ok({ list: [{ ...campaignFixture.data.list[0], campaign_automation_type: "SMART_PLUS" }], page_info: { total_page: 1 } }),
    })
    await expect(copyTikTokObject(makeCtx(), { level: "campaign", id: "1810000000000000001", deep: true })).rejects.toMatchObject({
      code: "unsupported",
    })
  })
})

describe("copy ad / ad group", () => {
  it("copy ad: tạo qua /ad/create/ với DISABLE, không retry", async () => {
    const m = mockTikTok({ "GET /ad/get/": { body: adFixture }, "POST /ad/create/": ok({ ad_ids: ["1990000000000000001"] }) })
    const res = await copyTikTokObject(makeCtx(), { level: "ad", id: "1810000000000001001", deep: false, nameSuffix: " v2" })
    expect(res.rootNewId).toBe("1990000000000000001")
    const cr = (m.callsTo("POST /ad/create/")[0]!.body!.creatives as Record<string, unknown>[])[0]!
    expect(cr.ad_name).toBe("Video review 01 v2")
    expect(cr.operation_status).toBe("DISABLE")
  })

  it("copy ad group lỗi giữa chừng → mapping có lỗi + gợi ý dọn bản nháp", async () => {
    const m = mockTikTok({
      "GET /adgroup/get/": { body: adgroupFixture },
      "GET /ad/get/": { body: adFixture },
      "POST /adgroup/create/": ok({ adgroup_id: "1980000000000000101" }),
      "POST /ad/create/": fail(40002, "Identity not available"),
    })
    const res = await copyTikTokObject(makeCtx(), { level: "ad_group", id: "1810000000000000101", deep: true }, { now: NOW })
    expect(res.rootNewId).toBe("1980000000000000101")
    expect(res.mappings.filter((x) => x.level === "ad").every((x) => x.newId === null && x.error)).toBe(true)
    expect(res.warnings.some((w) => w.includes("xoá bằng ads_delete_object"))).toBe(true)
    expect(m.callsTo("POST /ad/create/")).toHaveLength(1) // never retried (no request_id on /ad/create/)
    expect(m.callsTo("POST /adgroup/create/")[0]!.body!.campaign_id).toBe("1810000000000000001")
  })
})

describe("/ad/create/ không có request_id", () => {
  it("timeout/5xx → tra lại theo tên trong nhóm; tìm thấy thì dùng id, không tạo lại", async () => {
    const created = { ...adFixture.data.list[0], ad_id: "1990000000000000777", ad_name: "Video review 01 v2", create_time: "2099-01-01 00:00:00" }
    const m = mockTikTok({
      "GET /ad/get/": (c: RecordedCall) => {
        const f = c.query.filtering as Record<string, unknown>
        return f.adgroup_ids ? ok({ list: [created], page_info: { total_page: 1 } }) : { body: adFixture }
      },
      "POST /ad/create/": { status: 502, body: "Bad gateway" },
    })
    const res = await copyTikTokObject(makeCtx(), { level: "ad", id: "1810000000000001001", deep: false, nameSuffix: " v2" })
    expect(res.rootNewId).toBe("1990000000000000777")
    expect(res.warnings.join(" ")).toMatch(/đã được tạo/)
    expect(m.callsTo("POST /ad/create/")).toHaveLength(1)
  })

  it("timeout/5xx và không tìm thấy → lỗi không retryable, gợi ý kiểm tra trước khi thử lại", async () => {
    const { createAdsChecked } = await import("./ad-create")
    const m = mockTikTok({
      "GET /ad/get/": ok({ list: [], page_info: { total_page: 1 } }),
      "POST /ad/create/": { status: 500, body: "boom" },
    })
    const { ttFromCtx } = await import("./api")
    const err = await createAdsChecked(ttFromCtx(makeCtx()), "1810000000000000101", [{ ad_name: "A" }], []).catch((e) => e)
    expect(err).toMatchObject({ retryable: false })
    expect(err.hint).toMatch(/kiểm tra trước khi thử lại/)
    expect(m.callsTo("POST /ad/create/")).toHaveLength(1)
  })

  it("lỗi tham số (40002) → ném nguyên lỗi, không tra cứu", async () => {
    const { createAdsChecked } = await import("./ad-create")
    const m = mockTikTok({ "POST /ad/create/": fail(40002, "bad ad_text") })
    const { ttFromCtx } = await import("./api")
    await expect(createAdsChecked(ttFromCtx(makeCtx()), "1", [{ ad_name: "A" }], [])).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.callsTo("GET /ad/get/")).toHaveLength(0)
  })
})

describe("freshSchedule", () => {
  it("lịch START_END đã qua → giữ thời lượng, bắt đầu sau hiện tại", () => {
    const { schedule, changed } = freshSchedule(
      { schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-09-01 00:00:00", schedule_end_time: "2026-09-08 00:00:00" },
      NOW
    )
    expect(changed).toBe(true)
    expect(schedule).toEqual({
      schedule_type: "SCHEDULE_START_END",
      schedule_start_time: "2026-10-02 08:10:00",
      schedule_end_time: "2026-10-09 08:10:00",
    })
  })

  it("lịch tương lai giữ nguyên", () => {
    const { schedule, changed } = freshSchedule(
      { schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-11-01 00:00:00", schedule_end_time: "2026-11-30 00:00:00" },
      NOW
    )
    expect(changed).toBe(false)
    expect(schedule.schedule_start_time).toBe("2026-11-01 00:00:00")
  })

  it("bỏ placements khi tự động, bỏ TIKTOK_LITE", () => {
    const w: string[] = []
    const body = adgroupCreateBody(
      { placement_type: "PLACEMENT_TYPE_AUTOMATIC", placements: ["PLACEMENT_TIKTOK"], tiktok_subplacements: ["IN_FEED", "TIKTOK_LITE"], schedule_start_time: "2026-12-01 00:00:00" },
      "71",
      "c1",
      "G",
      "1",
      NOW,
      w
    )
    expect(body).not.toHaveProperty("placements")
    expect(body.tiktok_subplacements).toEqual(["IN_FEED"])
    expect(body.operation_status).toBe("DISABLE")
  })
})
