// C2 (v1.1.6): ads_get_object TikTok attaches extra.review from /ad/review_info/, /adgroup/review_info/ and
// /smart_plus/ad/review_info/ (docs 1740559669226498, 1740554277061634, 1843317465695233).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { fail, makeCtx, mockTikTok } from "./__fixtures__/mock-fetch"
import { getTikTokObject } from "./objects"
import { rejectInfoOut, reviewCore } from "./review"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const AD = {
  campaign_id: "1810000000000000001",
  adgroup_id: "1810000000000000101",
  ad_id: "1810000000000001001",
  ad_id_v2: "1810000000000001001",
  ad_name: "Video review 01",
  campaign_automation_type: "MANUAL",
  operation_status: "ENABLE",
  secondary_status: "AD_STATUS_REVIEW_PARTIALLY_APPROVED",
}
const GROUP = {
  campaign_id: "1810000000000000001",
  adgroup_id: "1810000000000000101",
  adgroup_name: "HCM",
  campaign_automation_type: "MANUAL",
  operation_status: "ENABLE",
  secondary_status: "ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED",
}
const list = (rows: unknown[]) => ({
  list: rows,
  page_info: { page: 1, total_page: 1 },
})

// shape of the doc example: is_approved true + PART_AVAILABLE + reject_info, last_audit_time as a number (ignored)
const AD_REVIEW = {
  ad_id: AD.ad_id,
  is_approved: true,
  review_status: "PART_AVAILABLE",
  appeal_status: null,
  last_audit_time: 1596023135,
  forbidden_placements: ["PLACEMENT_PANGLE"],
  forbidden_locations: ["RU"],
  forbidden_operation_systems: ["IOS"],
  forbidden_ages: [],
  reject_info: [
    {
      content_info: {
        text_content: null,
        content_type: "MODE_VIDEO",
        video_content: { video_id: "v100" },
        image_content: { image_id: "img-1" },
      },
      suggestion: "Please add background audio.\u202E exe",
      reasons: ["The ad has no background audio.\n", "x".repeat(400)],
    },
  ],
}

describe("review helpers", () => {
  it("reviewCore: duyệt một phần, làm sạch chữ, cắt độ dài, bỏ mảng rỗng, không có URL", () => {
    const r = reviewCore(AD_REVIEW)
    expect(r).toMatchObject({
      review_status: "PART_AVAILABLE",
      is_approved: true,
      partially_approved: true,
      forbidden_locations: ["RU"],
      forbidden_placements: ["PLACEMENT_PANGLE"],
      forbidden_operation_systems: ["IOS"],
    })
    expect(r).not.toHaveProperty("forbidden_ages")
    expect(r).not.toHaveProperty("last_audit_time")
    const info = (r.reject_info as Record<string, unknown>[])[0]!
    expect(info.suggestion).toBe("Please add background audio. exe")
    expect((info.reasons as string[])[0]).toBe(
      "The ad has no background audio."
    )
    expect((info.reasons as string[])[1]!.length).toBeLessThanOrEqual(300)
    expect(info).toMatchObject({
      content_type: "MODE_VIDEO",
      video_id: "v100",
      image_id: "img-1",
    })
    expect(JSON.stringify(r)).not.toMatch(/https?:/)
  })

  it("rejectInfoOut chịu được dữ liệu thiếu / sai kiểu và giới hạn 10 mục, 5 lý do", () => {
    expect(rejectInfoOut(null)).toEqual([])
    expect(rejectInfoOut([null, 1, "x", {}])).toEqual([])
    const many = rejectInfoOut(
      Array.from({ length: 15 }, () => ({
        reasons: ["a", "b", "c", "d", "e", "f", "g"],
      }))
    )
    expect(many).toHaveLength(10)
    expect(many[0]!.reasons).toHaveLength(5)
  })

  it("UNAVAILABLE / is_approved false → không gắn partially_approved", () => {
    expect(
      reviewCore({
        is_approved: false,
        review_status: "UNAVAILABLE",
        reject_info: [{ reasons: ["x"] }],
      })
    ).not.toHaveProperty("partially_approved")
    expect(
      reviewCore({ is_approved: true, review_status: "ALL_AVAILABLE" })
    ).not.toHaveProperty("partially_approved")
  })
})

describe("getTikTokObject + review", () => {
  it("quảng cáo thủ công: gọi /ad/review_info/ với ad_ids, gắn extra.review; statusDetail partially_approved", async () => {
    const m = mockTikTok({
      "GET /ad/get/": list([AD]),
      "GET /ad/review_info/": { ad_review_map: { [AD.ad_id]: AD_REVIEW } },
    })
    const d = await getTikTokObject(makeCtx(), "ad", AD.ad_id, { review: true })
    expect(m.callsTo("GET /ad/review_info/")[0]!.query.ad_ids).toEqual([
      AD.ad_id,
    ])
    expect(d.statusDetail).toBe("partially_approved")
    expect(d.extra?.review).toMatchObject({
      source: "ad/review_info",
      review_status: "PART_AVAILABLE",
      partially_approved: true,
    })
    expect(d.extra).not.toHaveProperty("review_error")
  })

  it("không truyền review (luồng ghi / xem trước) → không gọi review_info", async () => {
    const m = mockTikTok({ "GET /ad/get/": list([AD]) })
    const d = await getTikTokObject(makeCtx(), "ad", AD.ad_id)
    expect(m.callsTo("GET /ad/review_info/")).toHaveLength(0)
    expect(d.extra).not.toHaveProperty("review")
    await getTikTokObject(makeCtx(), "ad", AD.ad_id, {
      review: true,
      forWrite: true,
    })
    expect(m.callsTo("GET /ad/review_info/")).toHaveLength(0)
  })

  it("lỗi review_info chỉ thành extra.review_error, chi tiết vẫn trả về", async () => {
    mockTikTok({
      "GET /ad/get/": list([AD]),
      "GET /ad/review_info/": fail(40001, "no permission"),
    })
    const d = await getTikTokObject(makeCtx(), "ad", AD.ad_id, { review: true })
    expect(d.id).toBe(AD.ad_id)
    expect(d.extra).not.toHaveProperty("review")
    expect(d.extra?.review_error).toMatch(/Không lấy được thông tin duyệt/)
    expect(String(d.extra?.review_error)).not.toContain("tok_test")
  })

  it("chưa có kết quả duyệt → review_error giải thích, không ném", async () => {
    mockTikTok({
      "GET /ad/get/": list([AD]),
      "GET /ad/review_info/": { ad_review_map: {} },
    })
    const d = await getTikTokObject(makeCtx(), "ad", AD.ad_id, { review: true })
    expect(d.extra?.review_error).toMatch(/chưa trả kết quả duyệt/)
  })

  it("quảng cáo đã xoá → không gọi review_info", async () => {
    const m = mockTikTok({
      "GET /ad/get/": list([
        {
          ...AD,
          operation_status: "DELETE",
          secondary_status: "AD_STATUS_DELETE",
        },
      ]),
    })
    const d = await getTikTokObject(makeCtx(), "ad", AD.ad_id, { review: true })
    expect(m.callsTo("GET /ad/review_info/")).toHaveLength(0)
    expect(d.extra).not.toHaveProperty("review_error")
  })

  it("nhóm quảng cáo: /adgroup/review_info/, đọc contain_rejected_ads và contains_rejected_ads, liệt kê quảng cáo bị từ chối", async () => {
    const m = mockTikTok({
      "GET /adgroup/get/": list([GROUP]),
      "GET /adgroup/review_info/": {
        ad_group_review_map: {
          [GROUP.adgroup_id]: {
            adgroup_id: GROUP.adgroup_id,
            is_approved: true,
            review_status: "PART_AVAILABLE",
            appeal_status: "NOT_APPEALED",
            last_audit_time: "2026-10-15 03:00:00",
            contains_rejected_ads: true,
            reject_info: [],
          },
        },
        ad_review_map: {
          [GROUP.adgroup_id]: {
            "1810000000000001001": {
              ad_id: "1810000000000001001",
              is_approved: true,
              review_status: "ALL_AVAILABLE",
            },
            "1810000000000001002": {
              ad_id: "1810000000000001002",
              is_approved: false,
              review_status: "UNAVAILABLE",
              reject_info: [
                {
                  reasons: ["Misleading claim"],
                  suggestion: "Remove the claim",
                },
              ],
            },
          },
        },
      },
    })
    const d = await getTikTokObject(makeCtx(), "ad_group", GROUP.adgroup_id, {
      review: true,
    })
    expect(
      m.callsTo("GET /adgroup/review_info/")[0]!.query.adgroup_ids
    ).toEqual([GROUP.adgroup_id])
    expect(d.extra?.review).toMatchObject({
      source: "adgroup/review_info",
      review_status: "PART_AVAILABLE",
      appeal_status: "NOT_APPEALED",
      last_audit_time: "2026-10-15T03:00:00.000Z",
      contains_rejected_ads: true,
      rejected_ads_total: 1,
      rejected_ads: [
        {
          ad_id: "1810000000000001002",
          is_approved: false,
          review_status: "UNAVAILABLE",
        },
      ],
    })
    // the field-table spelling is read as well
    mockTikTok({
      "GET /adgroup/get/": list([GROUP]),
      "GET /adgroup/review_info/": {
        ad_group_review_map: {
          [GROUP.adgroup_id]: {
            adgroup_id: GROUP.adgroup_id,
            contain_rejected_ads: false,
          },
        },
      },
    })
    const d2 = await getTikTokObject(makeCtx(), "ad_group", GROUP.adgroup_id, {
      review: true,
    })
    expect(d2.extra?.review).toMatchObject({ contains_rejected_ads: false })
  })

  it("Smart+ đời cũ: không liệt kê ad_review_map (id là material, không phải quảng cáo thật)", async () => {
    mockTikTok({
      "GET /adgroup/get/": list([
        { ...GROUP, campaign_automation_type: "SMART_PLUS" },
      ]),
      "GET /adgroup/review_info/": {
        ad_group_review_map: {
          [GROUP.adgroup_id]: {
            adgroup_id: GROUP.adgroup_id,
            is_approved: false,
            review_status: "UNAVAILABLE",
          },
        },
        ad_review_map: {
          [GROUP.adgroup_id]: {
            m1: {
              ad_id: "m1",
              is_approved: false,
              review_status: "UNAVAILABLE",
            },
          },
        },
      },
    })
    const d = await getTikTokObject(makeCtx(), "ad_group", GROUP.adgroup_id, {
      review: true,
    })
    expect(d.extra?.review).not.toHaveProperty("rejected_ads")
  })

  it("Upgraded Smart+ ad: /smart_plus/ad/review_info/ lang=vi, include_reject_info, không xin violation frame", async () => {
    const sp = {
      ...AD,
      campaign_automation_type: "UPGRADED_SMART_PLUS_CREATIVE",
      smart_plus_ad_id: "1900000000000000001",
      ad_id: "1810000000000009999",
    }
    const m = mockTikTok({
      "GET /ad/get/": list([sp]),
      "GET /smart_plus/ad/review_info/": {
        smart_plus_ad_review_infos: [
          {
            smart_plus_ad_id: "1900000000000000001",
            review_status: "PART_AVAILABLE",
            passed_locations: ["VN"],
            appeal_status: "NOT_APPEALED",
            reject_info: [
              {
                reasons: ["Lý do"],
                specification: "Tóm tắt",
                violation_frames: [
                  { web_url_list: ["https://x.example/frame.jpg"] },
                ],
              },
            ],
          },
        ],
        material_review_infos: [
          {
            ad_material_id: "am1",
            smart_plus_ad_id: "1900000000000000001",
            review_status: "UNAVAILABLE",
            reject_info: [{ reasons: ["x"] }],
          },
          {
            ad_material_id: "am2",
            smart_plus_ad_id: "1900000000000000001",
            review_status: "ALL_AVAILABLE",
          },
          // still in review (no review_status): not counted as rejected
          { ad_material_id: "am3", smart_plus_ad_id: "1900000000000000001" },
        ],
      },
    })
    const d = await getTikTokObject(makeCtx(), "ad", "1900000000000000001", {
      review: true,
    })
    const q = m.callsTo("GET /smart_plus/ad/review_info/")[0]!.query
    expect(q).toMatchObject({
      smart_plus_ad_ids: ["1900000000000000001"],
      lang: "vi",
      extra_info_setting: {
        include_reject_info: true,
        include_violation_frame: false,
      },
    })
    expect(m.callsTo("GET /ad/review_info/")).toHaveLength(0)
    expect(d.extra?.review).toMatchObject({
      source: "smart_plus/ad/review_info",
      passed_locations: ["VN"],
      partially_approved: true,
      rejected_materials_total: 1,
      rejected_materials: [
        { ad_material_id: "am1", review_status: "UNAVAILABLE" },
      ],
    })
    expect(JSON.stringify(d.extra?.review)).not.toContain("https://")
  })
})

describe("nhóm Upgraded Smart+ / GMV Max", () => {
  it("không gọi /adgroup/review_info/ (không hỗ trợ), extra.review có ghi chú xem theo từng quảng cáo, không review_error", async () => {
    for (const g of [
      { ...GROUP, campaign_automation_type: "UPGRADED_SMART_PLUS" },
      { ...GROUP, promotion_type: "PRODUCT_GMV_MAX" },
    ]) {
      const m = mockTikTok({ "GET /adgroup/get/": list([g]) })
      const d = await getTikTokObject(makeCtx(), "ad_group", GROUP.adgroup_id, { review: true })
      expect(m.callsTo("GET /adgroup/review_info/")).toHaveLength(0)
      expect(d.extra?.review).toMatchObject({ note: expect.stringMatching(/từng quảng cáo/) })
      expect(d.extra).not.toHaveProperty("review_error")
    }
  })
})
