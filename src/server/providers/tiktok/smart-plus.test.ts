import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import {
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { makeRequestId } from "./client"
import {
  ALLOWLIST_MESSAGE,
  goalOfAdGroup,
  smartPlusExtension,
  smartPlusMoney,
  type SmartPlusInput,
} from "./smart-plus"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ext = smartPlusExtension
const parse = (v: unknown) => ext.input.parse(v) as SmartPlusInput
const run = (input: unknown, opts: Record<string, unknown> = {}) =>
  ext.run(makeCtx(), parse(input), opts)

/** tomorrow 00:00:00 UTC */
const FUTURE_START = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 00:00:00`
const FUTURE_END = `${new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10)} 00:00:00`
const nowTt = () => new Date().toISOString().slice(0, 19).replace("T", " ")

const CAMPAIGN_ID = "1850000000000000001"
const ADGROUP_ID = "1850000000000000002"
const AD_ID = "1850000000000000003"
const CTA_ID = "1850000000000000099"

const filtering = (c: RecordedCall) =>
  (c.query.filtering ?? {}) as Record<string, unknown>

/** Smart+ API: creates + gets (read back DISABLE) + dynamic CTA. */
function smartPlusApi(over: Record<string, unknown> = {}) {
  return mockTikTok({
    "GET /creative/cta/recommend/": ok({
      recommend_assets: [
        { asset_ids: ["201902", "201404"], asset_content: "Tìm hiểu thêm" },
        { asset_ids: ["202114"], asset_content: "Mua ngay" },
      ],
    }),
    "POST /creative/portfolio/create/": ok({ creative_portfolio_id: CTA_ID }),
    "POST /smart_plus/campaign/create/": ok({
      campaign_id: CAMPAIGN_ID,
      operation_status: "DISABLE",
    }),
    "POST /smart_plus/adgroup/create/": ok({
      adgroup_id: ADGROUP_ID,
      operation_status: "DISABLE",
    }),
    "POST /smart_plus/ad/create/": ok({
      smart_plus_ad_id: AD_ID,
      operation_status: "DISABLE",
    }),
    "GET /smart_plus/campaign/get/": ok({
      list: [
        {
          campaign_id: CAMPAIGN_ID,
          campaign_name: "Smart+ Web",
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        },
      ],
    }),
    "GET /smart_plus/adgroup/get/": ok({
      list: [
        {
          adgroup_id: ADGROUP_ID,
          adgroup_name: "VN 18+",
          operation_status: "DISABLE",
          secondary_status: "ADGROUP_STATUS_CAMPAIGN_DISABLE",
        },
      ],
    }),
    "GET /smart_plus/ad/get/": ok({
      list: [
        {
          smart_plus_ad_id: AD_ID,
          ad_name: "VN 18+",
          operation_status: "DISABLE",
          secondary_status: "AD_STATUS_CAMPAIGN_DISABLE",
        },
      ],
    }),
    ...over,
  })
}

const webInput = {
  campaign: { name: "Smart+ Web", budget_type: "daily", budget: 500_000 },
  adgroup: {
    name: "VN 18+",
    goal: "WEBSITE",
    optimization_goal: "CONVERT",
    pixel_id: "7200000000000000009",
    optimization_event: "SHOPPING",
    location_ids: ["1562822"],
    schedule_start_time: FUTURE_START,
  },
  ad: {
    creatives: [
      {
        identity_type: "TT_USER",
        identity_id: "id-abc",
        video_id: "v10033g50000abc",
        cover_image_id: "ad-site-i18n-sg/202610abc",
      },
    ],
    ad_texts: ["Ưu đãi tháng 10"],
    landing_page_url: "https://shop.example.vn/sale",
  },
}

describe("khai báo tiktok_create_smart_plus", () => {
  it("quyền create, ghi, mô tả tiếng Việt nêu allowlist + mốc 31/12/2026, ≤1500 ký tự, có moneyOf", () => {
    expect(ext.name).toBe("tiktok_create_smart_plus")
    expect(ext.permission).toBe("create")
    expect(ext.write).toBe(true)
    expect(ext.description.startsWith("Dùng khi")).toBe(true)
    expect(ext.description.length).toBeLessThanOrEqual(1500)
    expect(ext.description).toMatch(/allowlist/)
    expect(ext.description).toMatch(/31\/12\/2026/)
    expect(typeof ext.moneyOf).toBe("function")
  })

  it("moneyOf: ngân sách ngày luôn linh hoạt (dynamic), lifetime kèm lịch nhóm, giá thầu", () => {
    expect(smartPlusMoney(parse(webInput))).toEqual([
      {
        kind: "daily_budget",
        amount: 500_000,
        field: "campaign.budget",
        dynamic: true,
      },
    ])
    const items = smartPlusMoney(
      parse({
        campaign: { name: "c", cbo: false, budget_type: "unlimited" },
        adgroup: {
          ...webInput.adgroup,
          budget_type: "lifetime",
          budget: 9_000_000,
          schedule_end_time: FUTURE_END,
          bid_type: "cost_cap",
          bid_amount: 20_000,
        },
      })
    )
    expect(items).toEqual([
      {
        kind: "lifetime_budget",
        amount: 9_000_000,
        field: "adgroup.budget",
        startTime: `${FUTURE_START.replace(" ", "T")}Z`,
        endTime: `${FUTURE_END.replace(" ", "T")}Z`,
      },
      { kind: "bid", amount: 20_000, field: "adgroup.bid_amount" },
    ])
  })

  it("goalOfAdGroup suy ra đích từ nhóm có sẵn", () => {
    expect(goalOfAdGroup({ promotion_type: "WEBSITE" })).toBe("WEBSITE")
    expect(
      goalOfAdGroup({
        promotion_type: "LEAD_GENERATION",
        promotion_target_type: "INSTANT_PAGE",
      })
    ).toBe("LEAD_FORM")
    expect(
      goalOfAdGroup({
        promotion_type: "LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE",
        messaging_app_type: "ZALO",
      })
    ).toBe("ZALO")
    expect(goalOfAdGroup({ promotion_type: "APP_ANDROID" })).toBeNull()
  })
})

describe("tạo trọn chuỗi (WEBSITE)", () => {
  it("DISABLE cả 3 cấp, request_id xác định từ idempotencyKey, CTA động tạo trước, đọc lại sau khi tạo", async () => {
    const m = smartPlusApi()
    const res = (await run(webInput, { idempotencyKey: "k-sp-1" })) as {
      createdIds: string[]
      warnings: string[]
      changes: { after: unknown }[]
    }
    expect(res.createdIds).toEqual([CAMPAIGN_ID, ADGROUP_ID, AD_ID])

    const camp = m.callsTo("POST /smart_plus/campaign/create/")[0]!.body!
    expect(camp).toEqual({
      advertiser_id: "7100000000000000001",
      request_id: makeRequestId("k-sp-1", "smart_plus_campaign"),
      campaign_name: "Smart+ Web",
      objective_type: "WEB_CONVERSIONS",
      sales_destination: "WEBSITE",
      operation_status: "DISABLE",
      budget_optimize_on: true,
      budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
      budget: 500000,
      is_search_campaign: false,
      catalog_enabled: false,
      campaign_type: "REGULAR_CAMPAIGN",
    })
    const group = m.callsTo("POST /smart_plus/adgroup/create/")[0]!.body!
    expect(group).toMatchObject({
      campaign_id: CAMPAIGN_ID,
      request_id: makeRequestId("k-sp-1", "smart_plus_adgroup"),
      operation_status: "DISABLE",
      promotion_type: "WEBSITE",
      optimization_goal: "CONVERT",
      billing_event: "OCPM",
      bid_type: "BID_TYPE_NO_BID",
      pixel_id: "7200000000000000009",
      optimization_event: "SHOPPING",
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: FUTURE_START,
      targeting_optimization_mode: "AUTOMATIC",
      suggestion_audience_enabled: false,
      targeting_spec: {
        location_ids: ["1562822"],
        spc_audience_age: "OVER_EIGHTEEN",
      },
    })
    // CBO: no ad group budget; automatic placement: placement fields omitted
    expect(group).not.toHaveProperty("budget")
    expect(group).not.toHaveProperty("placement_type")

    const ad = m.callsTo("POST /smart_plus/ad/create/")[0]!.body!
    expect(ad).toEqual({
      advertiser_id: "7100000000000000001",
      adgroup_id: ADGROUP_ID,
      ad_name: "VN 18+",
      operation_status: "DISABLE",
      creative_list: [
        {
          creative_info: {
            identity_type: "TT_USER",
            identity_id: "id-abc",
            ad_format: "SINGLE_VIDEO",
            video_info: { video_id: "v10033g50000abc" },
            image_info: [{ web_uri: "ad-site-i18n-sg/202610abc" }],
          },
        },
      ],
      ad_text_list: [{ ad_text: "Ưu đãi tháng 10" }],
      landing_page_url_list: [
        { landing_page_url: "https://shop.example.vn/sale" },
      ],
      ad_configuration: {
        call_to_action_id: CTA_ID,
        creative_auto_add_toggle: false,
        creative_auto_enhancement_strategy_list: [],
      },
    })
    // dynamic CTA: new_version recommend → portfolio, only after the campaign + ad group, right before the ad
    const rec = m.callsTo("GET /creative/cta/recommend/")[0]!
    expect(rec.query).toMatchObject({
      new_version: "true",
      objective_type: "WEB_CONVERSIONS",
      promotion_type: "WEBSITE",
      language: "vi",
    })
    expect(m.callsTo("POST /creative/portfolio/create/")[0]!.body).toEqual({
      advertiser_id: "7100000000000000001",
      creative_portfolio_type: "CTA",
      portfolio_content: [
        { asset_content: "Tìm hiểu thêm", asset_ids: ["201902", "201404"] },
        { asset_content: "Mua ngay", asset_ids: ["202114"] },
      ],
    })
    const order = m.posts().map((c) => c.path)
    expect(order).toEqual([
      "/smart_plus/campaign/create/",
      "/smart_plus/adgroup/create/",
      "/creative/portfolio/create/",
      "/smart_plus/ad/create/",
    ])
    // read back of every level, no status change needed
    expect(m.callsTo("GET /smart_plus/ad/get/")).toHaveLength(1)
    expect(m.calls.some((c) => c.path.includes("status/update"))).toBe(false)
    expect(res.warnings.join(" ")).toMatch(/31\/12\/2026/)
    // the access token never appears in the result
    expect(JSON.stringify(res)).not.toContain("tok_test")
  })

  it("dryRun (xem trước) không gọi API ghi nào, payload không có request_id / advertiser_id", async () => {
    const m = smartPlusApi()
    const res = (await run(webInput, { dryRun: true })) as {
      preview: boolean
      payload: Record<string, Record<string, unknown>>
      changes: unknown[]
    }
    expect(res.preview).toBe(true)
    expect(m.posts()).toHaveLength(0)
    expect(m.calls).toHaveLength(0)
    expect(res.changes).toHaveLength(3)
    for (const k of ["campaign", "adgroup", "ad"]) {
      expect(res.payload[k]!.operation_status).toBe("DISABLE")
      expect(res.payload[k]).not.toHaveProperty("request_id")
      expect(res.payload[k]).not.toHaveProperty("advertiser_id")
    }
  })

  it("đọc lại thấy ENABLE → tắt lại ngay bằng /smart_plus/<cấp>/status/update/ + cảnh báo", async () => {
    const m = smartPlusApi({
      "GET /smart_plus/campaign/get/": ok({
        list: [
          {
            campaign_id: CAMPAIGN_ID,
            campaign_name: "x",
            operation_status: "ENABLE",
          },
        ],
      }),
      "POST /smart_plus/campaign/status/update/": ok({
        campaign_ids: [CAMPAIGN_ID],
      }),
    })
    const res = (await run(webInput, { idempotencyKey: "k" })) as {
      warnings: string[]
    }
    expect(
      m.callsTo("POST /smart_plus/campaign/status/update/")[0]!.body
    ).toEqual({
      advertiser_id: "7100000000000000001",
      campaign_ids: [CAMPAIGN_ID],
      operation_status: "DISABLE",
    })
    expect(res.warnings.join(" ")).toMatch(/đã tắt lại ngay/)
  })
})

describe("lỗi / an toàn", () => {
  it("chưa allowlist (40118) → thông báo tiếng Việt rõ ràng, không tạo nhóm / quảng cáo", async () => {
    const m = smartPlusApi({
      "POST /smart_plus/campaign/create/": fail(
        40118,
        "The advertiser is not on the allowlist"
      ),
    })
    await expect(run(webInput, { idempotencyKey: "k" })).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: ALLOWLIST_MESSAGE,
    })
    expect(m.callsTo("POST /smart_plus/adgroup/create/")).toHaveLength(0)
    expect(m.callsTo("POST /smart_plus/ad/create/")).toHaveLength(0)
    // no CTA portfolio either: nothing was written
    expect(m.posts().map((c) => c.path)).toEqual(["/smart_plus/campaign/create/"])
  })

  it("quảng cáo lỗi sau khi đã tạo CTA động → lỗi nêu cả id CTA, audit ghi chiến dịch + nhóm + CTA, gợi ý dùng lại call_to_action_id", async () => {
    smartPlusApi({ "POST /smart_plus/ad/create/": fail(40002, "invalid identity") })
    const e = (await run(webInput, { idempotencyKey: "k" }).catch((x: unknown) => x)) as {
      userMessageVi: string
      hint: string
      audit: { errorCode: string; changes: { objectId: string; field: string }[] }
    }
    expect(e.userMessageVi).toContain(CTA_ID)
    expect(e.hint).toContain(`adgroup_id="${ADGROUP_ID}"`)
    expect(e.hint).toContain(`call_to_action_id="${CTA_ID}"`)
    expect(e.audit.errorCode).toBe("smart_plus_partial_create")
    expect(e.audit.changes.map((c) => [c.objectId, c.field])).toEqual([
      [CAMPAIGN_ID, "created"],
      [ADGROUP_ID, "created"],
      [CTA_ID, "cta_portfolio"],
    ])
  })

  it("chỉ tạo quảng cáo (adgroup_id): CTA xong, quảng cáo lỗi → vẫn có audit ghi CTA đã tạo", async () => {
    smartPlusApi({
      "GET /smart_plus/adgroup/get/": ok({ list: [{ adgroup_id: ADGROUP_ID, adgroup_name: "G", promotion_type: "WEBSITE", optimization_goal: "CLICK" }] }),
      "GET /smart_plus/ad/get/": ok({ list: [], page_info: { total_number: 0 } }),
      "POST /smart_plus/ad/create/": fail(40002, "bad"),
    })
    const e = (await run({ adgroup_id: ADGROUP_ID, ad: webInput.ad }, { idempotencyKey: "k" }).catch((x: unknown) => x)) as {
      audit?: { errorCode: string; changes: { objectId: string }[] }
    }
    expect(e.audit?.errorCode).toBe("smart_plus_partial_create")
    expect(e.audit?.changes.map((c) => c.objectId)).toEqual([CTA_ID])
  })

  it("lỗi CTA động sau khi đã tạo chiến dịch + nhóm → báo id đã tạo, không tạo quảng cáo", async () => {
    const m = smartPlusApi({ "POST /creative/portfolio/create/": fail(40001, "no permission") })
    const e = (await run(webInput, { idempotencyKey: "k" }).catch((x: unknown) => x)) as {
      userMessageVi: string
      hint: string
      audit: { changes: { objectId: string }[] }
    }
    expect(e.userMessageVi).toMatch(/CTA động/)
    expect(e.hint).toMatch(/CTA Recommendation/)
    expect(e.audit.changes.map((c) => c.objectId)).toEqual([CAMPAIGN_ID, ADGROUP_ID])
    expect(m.callsTo("POST /smart_plus/ad/create/")).toHaveLength(0)
  })

  it("tra nhóm sau tạo không rõ kết quả: không gửi creation_filter_start_time (adgroup/get không có), lọc create_time phía app", async () => {
    const m = smartPlusApi({
      "POST /smart_plus/adgroup/create/": { status: 503, body: "busy" },
      "GET /smart_plus/adgroup/get/": (c: RecordedCall) =>
        filtering(c).adgroup_name
          ? ok({
              list: [
                { adgroup_id: "1850000000000000777", adgroup_name: "VN 18+", create_time: "2020-01-01 00:00:00" },
                { adgroup_id: ADGROUP_ID, adgroup_name: "VN 18+", create_time: nowTt() },
              ],
            })
          : ok({ list: [{ adgroup_id: ADGROUP_ID, adgroup_name: "VN 18+", operation_status: "DISABLE" }] }),
    })
    const res = (await run(webInput, { idempotencyKey: "k" })) as { createdIds: string[] }
    expect(res.createdIds).toEqual([CAMPAIGN_ID, ADGROUP_ID, AD_ID])
    const lookup = m.callsTo("GET /smart_plus/adgroup/get/").find((c) => filtering(c).adgroup_name)!
    expect(filtering(lookup)).toEqual({ campaign_ids: [CAMPAIGN_ID], adgroup_name: "VN 18+" })
  })

  it("emoji trong tên / nội dung bị từ chối trước khi gửi gì", () => {
    expect(() => parse({ ...webInput, campaign: { ...webInput.campaign, name: "Sale \u{1F525}" } })).toThrow(/emoji/)
    expect(() => parse({ ...webInput, adgroup: { ...webInput.adgroup, name: "VN \u{1F600}" } })).toThrow(/emoji/)
    expect(() => parse({ ...webInput, ad: { ...webInput.ad, name: "QC \u2764\uFE0F" } })).toThrow()
    expect(() => parse({ ...webInput, ad: { ...webInput.ad, ad_texts: ["Giảm giá \u{1F389}"] } })).toThrow(/emoji/)
    expect(() => parse({ ...webInput, campaign: { ...webInput.campaign, name: "Brand\u2122 \u00A9 2026" } })).not.toThrow()
  })

  it("nhóm / chiến dịch đã xoá (secondary_status *_DELETE, effective_status DELETED) bị từ chối", async () => {
    smartPlusApi({
      "GET /smart_plus/adgroup/get/": ok({ list: [{ adgroup_id: ADGROUP_ID, promotion_type: "WEBSITE", operation_status: "DISABLE", secondary_status: "ADGROUP_STATUS_DELETE" }] }),
      "GET /smart_plus/campaign/get/": ok({ list: [{ campaign_id: CAMPAIGN_ID, objective_type: "WEB_CONVERSIONS", operation_status: "DISABLE", effective_status: "DELETED" }] }),
    })
    await expect(run({ adgroup_id: ADGROUP_ID, ad: webInput.ad }, { dryRun: true })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(run({ campaign_id: CAMPAIGN_ID, adgroup: webInput.adgroup }, { dryRun: true })).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("bài đăng có sẵn (tiktok_item_id) không gửi music_info [?]", async () => {
    smartPlusApi()
    const pull = { identity_type: "TT_USER", identity_id: "a1", tiktok_item_id: "7300000000000000001", ad_format: "CAROUSEL_ADS" }
    await expect(
      run({ ...webInput, ad: { ...webInput.ad, ad_texts: undefined, creatives: [{ ...pull, music_id: "m1" }] } }, { dryRun: true })
    ).rejects.toMatchObject({ code: "invalid_request" })
    const r = (await run({ ...webInput, ad: { ...webInput.ad, ad_texts: undefined, creatives: [pull] } }, { dryRun: true })) as {
      payload: { ad: { creative_list: { creative_info: Record<string, unknown> }[] } }
    }
    expect(r.payload.ad.creative_list[0]!.creative_info).not.toHaveProperty("music_info")
  })

  it("mã lỗi khác kèm chữ allowlist cũng được hiểu là chưa allowlist [?]", async () => {
    smartPlusApi({
      "POST /smart_plus/campaign/create/": fail(
        40002,
        "Your account is not in the whitelist for this feature"
      ),
    })
    await expect(run(webInput, { idempotencyKey: "k" })).rejects.toMatchObject({
      code: "feature_not_enabled",
    })
  })

  it("tạo dở (chiến dịch xong, nhóm lỗi) → báo id chiến dịch đã tạo (TẮT), cách làm tiếp bằng campaign_id, audit ghi log", async () => {
    const m = smartPlusApi({
      "POST /smart_plus/adgroup/create/": fail(
        40002,
        "bid_type must be the same"
      ),
    })
    const err = await run(webInput, { idempotencyKey: "k" }).catch(
      (e: unknown) => e
    )
    expect(err).toMatchObject({ code: "invalid_request", retryable: false })
    const e = err as {
      userMessageVi: string
      hint: string
      audit: { errorCode: string; changes: { objectId: string }[] }
    }
    expect(e.userMessageVi).toContain(CAMPAIGN_ID)
    expect(e.userMessageVi).toMatch(/TẮT/)
    expect(e.hint).toContain(`campaign_id="${CAMPAIGN_ID}"`)
    expect(e.audit.errorCode).toBe("smart_plus_partial_create")
    expect(e.audit.changes.map((c) => c.objectId)).toEqual([CAMPAIGN_ID])
    expect(m.callsTo("POST /smart_plus/ad/create/")).toHaveLength(0)
    // a business error is never retried
    expect(m.callsTo("POST /smart_plus/adgroup/create/")).toHaveLength(1)
  })

  it("tạo quảng cáo lỗi mạng không rõ kết quả → không thử lại, tra theo tên; không thấy → lỗi không retry kèm id đã tạo", async () => {
    const m = smartPlusApi({
      "POST /smart_plus/ad/create/": { status: 500, body: "oops" },
      "GET /smart_plus/ad/get/": ok({ list: [] }),
    })
    const err = (await run(webInput, { idempotencyKey: "k" }).catch(
      (e: unknown) => e
    )) as { userMessageVi: string; hint: string }
    expect(m.callsTo("POST /smart_plus/ad/create/")).toHaveLength(1)
    expect(err.userMessageVi).toContain(ADGROUP_ID)
    expect(err.hint).toContain(`adgroup_id="${ADGROUP_ID}"`)
  })

  it("tạo chiến dịch không rõ kết quả (HTTP 5xx) nhưng tìm thấy theo tên → dùng id tìm thấy, không tạo lại", async () => {
    const m = smartPlusApi({
      "POST /smart_plus/campaign/create/": { status: 502, body: "bad gateway" },
      "GET /smart_plus/campaign/get/": (c: RecordedCall) =>
        filtering(c).campaign_name
          ? ok({
              list: [
                {
                  campaign_id: CAMPAIGN_ID,
                  campaign_name: "Smart+ Web",
                  create_time: nowTt(),
                },
              ],
            })
          : ok({
              list: [
                {
                  campaign_id: CAMPAIGN_ID,
                  campaign_name: "Smart+ Web",
                  operation_status: "DISABLE",
                },
              ],
            }),
    })
    const res = (await run(webInput, { idempotencyKey: "k" })) as {
      createdIds: string[]
      warnings: string[]
    }
    expect(m.callsTo("POST /smart_plus/campaign/create/")).toHaveLength(1)
    expect(res.createdIds[0]).toBe(CAMPAIGN_ID)
    expect(res.warnings.join(" ")).toMatch(/không tạo lại/)
  })

  it("từ chối AUTO_BUDGET_INCREASE ở chiến dịch và nhóm", async () => {
    const m = smartPlusApi()
    await expect(
      run(
        {
          ...webInput,
          campaign: {
            ...webInput.campaign,
            budget_auto_adjust_strategy: "AUTO_BUDGET_INCREASE",
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      run(
        {
          campaign: { name: "c", cbo: false, budget_type: "unlimited" },
          adgroup: {
            ...webInput.adgroup,
            budget_type: "daily",
            budget: 100_000,
            budget_auto_adjust_strategy: "AUTO_BUDGET_INCREASE",
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls).toHaveLength(0)
  })

  it("nhắm chọn sai chế độ bị từ chối (TikTok sẽ âm thầm bỏ qua)", async () => {
    smartPlusApi()
    await expect(
      run(
        {
          ...webInput,
          adgroup: { ...webInput.adgroup, gender: "GENDER_FEMALE" },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      run(
        {
          ...webInput,
          adgroup: {
            ...webInput.adgroup,
            targeting_mode: "manual",
            min_age: "OVER_TWENTY_FIVE",
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    const ok1 = (await run(
      {
        ...webInput,
        adgroup: {
          ...webInput.adgroup,
          targeting_mode: "automatic_suggestions",
          gender: "GENDER_FEMALE",
          age_groups: ["AGE_25_34"],
        },
      },
      { dryRun: true }
    )) as { payload: { adgroup: Record<string, unknown> } }
    expect(ok1.payload.adgroup).toMatchObject({
      suggestion_audience_enabled: true,
      targeting_spec: {
        gender: "GENDER_FEMALE",
        age_groups: ["AGE_25_34"],
        spc_audience_age: "OVER_EIGHTEEN",
      },
    })
  })

  it("ngân sách / lịch / giá thầu theo luật Smart+", async () => {
    smartPlusApi()
    const bad = [
      // CBO cannot be unlimited
      { ...webInput, campaign: { name: "c", budget_type: "unlimited" } },
      // CBO: no ad group budget
      {
        ...webInput,
        adgroup: { ...webInput.adgroup, budget_type: "daily", budget: 1 },
      },
      // lifetime needs an end time
      {
        ...webInput,
        campaign: { name: "c", budget_type: "lifetime", budget: 9_000_000 },
      },
      // cost cap only with a daily budget
      {
        ...webInput,
        campaign: { name: "c", budget_type: "lifetime", budget: 9_000_000 },
        adgroup: {
          ...webInput.adgroup,
          schedule_end_time: FUTURE_END,
          bid_type: "cost_cap",
          bid_amount: 10_000,
        },
      },
      // non-CBO campaign with a daily limit: ad groups are daily only
      {
        campaign: {
          name: "c",
          cbo: false,
          budget_type: "daily",
          budget: 1_000_000,
        },
        adgroup: {
          ...webInput.adgroup,
          budget_type: "lifetime",
          budget: 5_000_000,
          schedule_end_time: FUTURE_END,
        },
      },
      // CONVERT needs pixel
      { ...webInput, adgroup: { ...webInput.adgroup, pixel_id: undefined } },
      // WEBSITE needs an optimization goal
      {
        ...webInput,
        adgroup: { ...webInput.adgroup, optimization_goal: undefined },
      },
    ]
    for (const b of bad)
      await expect(run(b, { dryRun: true })).rejects.toMatchObject({
        code: "invalid_request",
      })
    const nonCbo = (await run(
      {
        campaign: {
          name: "c",
          cbo: false,
          budget_type: "daily",
          budget: 1_000_000,
        },
        adgroup: {
          ...webInput.adgroup,
          budget_type: "daily",
          budget: 300_000,
          bid_type: "cost_cap",
          bid_amount: 15_000,
        },
      },
      { dryRun: true }
    )) as {
      payload: {
        campaign: Record<string, unknown>
        adgroup: Record<string, unknown>
      }
    }
    expect(nonCbo.payload.campaign).toMatchObject({
      budget_optimize_on: false,
      budget_mode: "BUDGET_MODE_DAY",
      budget: 1000000,
    })
    expect(nonCbo.payload.adgroup).toMatchObject({
      budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
      budget: 300000,
      bid_type: "BID_TYPE_CUSTOM",
      conversion_bid_price: 15000,
    })
  })

  it("creative: không trộn Spark Pull với tải lên; tải lên cần ad_texts; Pull không nhận ad_texts; video cần ảnh bìa", async () => {
    smartPlusApi()
    const pull = {
      identity_type: "AUTH_CODE",
      identity_id: "a1",
      tiktok_item_id: "7300000000000000001",
    }
    const push = webInput.ad.creatives[0]!
    const bad = [
      { ...webInput.ad, creatives: [pull, push] },
      { ...webInput.ad, ad_texts: undefined },
      { ...webInput.ad, creatives: [pull] },
      { ...webInput.ad, creatives: [{ ...push, cover_image_id: undefined }] },
      {
        ...webInput.ad,
        creatives: [
          {
            identity_type: "AUTH_CODE",
            identity_id: "a1",
            video_id: "v1",
            cover_image_id: "c1",
          },
        ],
      },
      {
        ...webInput.ad,
        creatives: [
          {
            identity_type: "BC_AUTH_TT",
            identity_id: "a1",
            tiktok_item_id: "1",
          },
        ],
        ad_texts: undefined,
      },
    ]
    for (const ad of bad)
      await expect(
        run({ ...webInput, ad }, { dryRun: true })
      ).rejects.toMatchObject({ code: "invalid_request" })
    const r = (await run(
      {
        ...webInput,
        ad: { ...webInput.ad, creatives: [pull], ad_texts: undefined },
      },
      { dryRun: true }
    )) as {
      payload: { ad: { creative_list: unknown[]; ad_text_list?: unknown } }
    }
    expect(r.payload.ad.creative_list).toEqual([
      {
        creative_info: {
          identity_type: "AUTH_CODE",
          identity_id: "a1",
          ad_format: "SINGLE_VIDEO",
          tiktok_item_id: "7300000000000000001",
        },
      },
    ])
    expect(r.payload.ad.ad_text_list).toBeUndefined()
  })
})

describe("làm sạch đầu vào", () => {
  it("tên / nội dung có ký tự ẩn (zero-width, bidi) bị từ chối ở schema", () => {
    expect(() => parse({ ...webInput, campaign: { ...webInput.campaign, name: "Sale\u200Bx" } })).toThrow()
    expect(() => parse({ ...webInput, ad: { ...webInput.ad, ad_texts: ["abc\u202Egpj"] } })).toThrow()
    expect(() => parse({ ...webInput, ad: { ...webInput.ad, landing_page_url: "javascript:alert(1)" } })).toThrow()
  })
})

describe("khách hàng tiềm năng / nhắn tin", () => {
  const dm = {
    campaign: { name: "DM", budget_type: "daily", budget: 300_000 },
    adgroup: {
      name: "DM VN",
      goal: "TIKTOK_DM",
      location_ids: ["1562822"],
      schedule_start_time: FUTURE_START,
    },
    ad: {
      creatives: [
        {
          identity_type: "TT_USER",
          identity_id: "id-dm",
          tiktok_item_id: "7300000000000000002",
        },
      ],
      auto_message_id: "1855000000000000000001",
    },
  }

  it("Tin nhắn TikTok: SEND_MESSAGE + đúng 1 lời chào, chỉ vị trí TikTok, không tạo CTA động", async () => {
    const m = smartPlusApi()
    await run(dm, { idempotencyKey: "k" })
    const camp = m.callsTo("POST /smart_plus/campaign/create/")[0]!.body!
    expect(camp.objective_type).toBe("LEAD_GENERATION")
    expect(camp).not.toHaveProperty("sales_destination")
    const group = m.callsTo("POST /smart_plus/adgroup/create/")[0]!.body!
    expect(group).toMatchObject({
      promotion_type: "LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE",
      optimization_goal: "CLICK",
      billing_event: "CPC",
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
    })
    expect(group).not.toHaveProperty("messaging_app_type")
    const ad = m.callsTo("POST /smart_plus/ad/create/")[0]!.body!
    expect(ad.call_to_action_list).toEqual([{ call_to_action: "SEND_MESSAGE" }])
    expect(ad.auto_message_list).toEqual([
      { auto_message_id: "1855000000000000000001" },
    ])
    expect(ad.ad_configuration).toEqual({
      creative_auto_enhancement_strategy_list: [],
    })
    expect(m.callsTo("GET /creative/cta/recommend/")).toHaveLength(0)
    expect(m.callsTo("POST /creative/portfolio/create/")).toHaveLength(0)
  })

  it("Tin nhắn TikTok: thiếu lời chào / identity AUTH_CODE / landing page → từ chối", async () => {
    smartPlusApi()
    for (const ad of [
      { ...dm.ad, auto_message_id: undefined },
      {
        ...dm.ad,
        creatives: [
          { identity_type: "AUTH_CODE", identity_id: "x", tiktok_item_id: "1" },
        ],
      },
      { ...dm.ad, landing_page_url: "https://x.vn" },
      { ...dm.ad, call_to_action_id: "123" },
    ]) {
      await expect(run({ ...dm, ad }, { dryRun: true })).rejects.toMatchObject({
        code: "invalid_request",
      })
    }
    await expect(
      run(
        { ...dm, adgroup: { ...dm.adgroup, placement: "automatic" } },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("Zalo: CLICK → số điện thoại (phone_info + ZALO_PHONE_ACCOUNT); CONVERSATION → Official Account", async () => {
    smartPlusApi()
    const base = {
      campaign: dm.campaign,
      adgroup: { ...dm.adgroup, goal: "ZALO" },
    }
    const click = (await run(
      {
        ...base,
        adgroup: { ...base.adgroup, messaging: { phone_number: "901234567" } },
      },
      { dryRun: true }
    )) as {
      payload: { adgroup: Record<string, unknown> }
    }
    expect(click.payload.adgroup).toMatchObject({
      promotion_type: "LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE",
      messaging_app_type: "ZALO",
      zalo_id_type: "ZALO_PHONE_ACCOUNT",
      phone_info: {
        phone_region_code: "VN",
        phone_region_calling_code: "+84",
        phone_number: "901234567",
      },
    })
    expect(click.payload.adgroup).not.toHaveProperty("phone_number")
    const conv = (await run(
      {
        ...base,
        adgroup: {
          ...base.adgroup,
          optimization_goal: "CONVERSATION",
          messaging: { zalo_oa_id: "4400000000000000001" },
        },
      },
      { dryRun: true }
    )) as { payload: { adgroup: Record<string, unknown> }; warnings: string[] }
    expect(conv.payload.adgroup).toMatchObject({
      zalo_id_type: "ZALO_OFFICIAL_ACCOUNT",
      messaging_app_account_id: "4400000000000000001",
      billing_event: "OCPM",
    })
    expect(conv.warnings.join(" ")).toMatch(/CONVERSATION/)
    // Zalo CLICK with an OA id / CONVERSATION with a phone → refused
    await expect(
      run(
        {
          ...base,
          adgroup: { ...base.adgroup, messaging: { zalo_oa_id: "1" } },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      run(
        {
          ...base,
          adgroup: {
            ...base.adgroup,
            optimization_goal: "CONVERSATION",
            messaging: { phone_number: "901234567" },
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    // LINE / IM_URL: CLICK only
    await expect(
      run(
        {
          ...base,
          adgroup: {
            ...base.adgroup,
            goal: "LINE",
            optimization_goal: "CONVERSATION",
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("WhatsApp / Messenger: tài khoản ứng dụng ở nhóm, quảng cáo dùng CTA động, không gửi landing page", async () => {
    const m = smartPlusApi()
    await run(
      {
        campaign: dm.campaign,
        adgroup: {
          ...dm.adgroup,
          goal: "WHATSAPP",
          messaging: { phone_number: "912345678" },
        },
        ad: { creatives: dm.ad.creatives },
      },
      { idempotencyKey: "k" }
    )
    const group = m.callsTo("POST /smart_plus/adgroup/create/")[0]!.body!
    expect(group).toMatchObject({
      messaging_app_type: "WHATSAPP",
      phone_info: { phone_number: "912345678" },
    })
    const ad = m.callsTo("POST /smart_plus/ad/create/")[0]!.body!
    expect(ad.ad_configuration).toMatchObject({
      call_to_action_id: CTA_ID,
      creative_auto_add_toggle: false,
    })
    expect(ad).not.toHaveProperty("call_to_action_list")
    expect(ad).not.toHaveProperty("landing_page_url_list")
    expect(
      m.callsTo("GET /creative/cta/recommend/")[0]!.query.promotion_type
    ).toBe("LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE")
    await expect(
      run(
        {
          campaign: dm.campaign,
          adgroup: { ...dm.adgroup, goal: "MESSENGER" },
          ad: { creatives: dm.ad.creatives },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("Instant Form: page_list + promotion_target_type INSTANT_PAGE; CTA động có sẵn được dùng lại (không tạo mới)", async () => {
    const m = smartPlusApi()
    await run(
      {
        campaign: dm.campaign,
        adgroup: { ...dm.adgroup, goal: "LEAD_FORM" },
        ad: {
          creatives: dm.ad.creatives,
          instant_page_id: "7400000000000000001",
          call_to_action_id: "1860000000000000001",
        },
      },
      { idempotencyKey: "k" }
    )
    expect(
      m.callsTo("POST /smart_plus/adgroup/create/")[0]!.body
    ).toMatchObject({
      promotion_type: "LEAD_GENERATION",
      promotion_target_type: "INSTANT_PAGE",
      optimization_goal: "LEAD_GENERATION",
      billing_event: "OCPM",
    })
    const ad = m.callsTo("POST /smart_plus/ad/create/")[0]!.body!
    expect(ad.page_list).toEqual([{ page_id: "7400000000000000001" }])
    expect(
      (ad.ad_configuration as Record<string, unknown>).call_to_action_id
    ).toBe("1860000000000000001")
    expect(m.callsTo("POST /creative/portfolio/create/")).toHaveLength(0)
  })

  it("Lead website cần pixel + sự kiện và đúng 1 đích (URL hoặc Instant Page)", async () => {
    smartPlusApi()
    const lw = {
      ...dm.adgroup,
      goal: "LEAD_WEBSITE",
      optimization_goal: "WEBSITE_ENGAGEMENT",
    }
    await expect(
      run({ campaign: dm.campaign, adgroup: lw }, { dryRun: true })
    ).rejects.toMatchObject({ code: "invalid_request" })
    const withPixel = {
      ...lw,
      pixel_id: "7200000000000000009",
      optimization_event: "FORM",
    }
    await expect(
      run(
        {
          campaign: dm.campaign,
          adgroup: withPixel,
          ad: {
            creatives: dm.ad.creatives,
            landing_page_url: "https://x.vn",
            instant_page_id: "1",
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    const r = (await run(
      {
        campaign: dm.campaign,
        adgroup: withPixel,
        ad: {
          creatives: dm.ad.creatives,
          landing_page_url: "https://x.vn/form",
        },
      },
      { dryRun: true }
    )) as {
      payload: { adgroup: Record<string, unknown> }
    }
    expect(r.payload.adgroup).toMatchObject({
      promotion_target_type: "EXTERNAL_WEBSITE",
      pixel_id: "7200000000000000009",
    })
  })
})

describe("cấp dưới trong chiến dịch / nhóm có sẵn", () => {
  it("adgroup_id: đọc nhóm Smart+, đếm quảng cáo, chỉ tạo quảng cáo (đích suy ra từ nhóm)", async () => {
    const m = smartPlusApi({
      "GET /smart_plus/adgroup/get/": ok({
        list: [
          {
            adgroup_id: ADGROUP_ID,
            adgroup_name: "Nhóm DM",
            promotion_type: "LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE",
            optimization_goal: "CLICK",
            operation_status: "DISABLE",
          },
        ],
      }),
      "GET /smart_plus/ad/get/": (c: RecordedCall) =>
        filtering(c).adgroup_ids
          ? ok({ list: [], page_info: { total_number: 3 } })
          : ok({
              list: [
                {
                  smart_plus_ad_id: AD_ID,
                  ad_name: "Nhóm DM",
                  operation_status: "DISABLE",
                },
              ],
            }),
    })
    const res = (await run(
      {
        adgroup_id: ADGROUP_ID,
        ad: {
          creatives: [
            {
              identity_type: "TT_USER",
              identity_id: "id",
              tiktok_item_id: "1",
            },
          ],
          auto_message_id: "1855000000000000000001",
        },
      },
      { idempotencyKey: "k" }
    )) as { createdIds: string[] }
    expect(res.createdIds).toEqual([AD_ID])
    expect(m.callsTo("POST /smart_plus/campaign/create/")).toHaveLength(0)
    expect(m.callsTo("POST /smart_plus/adgroup/create/")).toHaveLength(0)
    expect(m.callsTo("POST /smart_plus/ad/create/")[0]!.body).toMatchObject({
      adgroup_id: ADGROUP_ID,
      ad_name: "Nhóm DM",
    })
  })

  it("adgroup_id: nhóm đã có 30 quảng cáo / không phải nhóm Smart+ / trộn với campaign → từ chối", async () => {
    smartPlusApi({
      "GET /smart_plus/adgroup/get/": ok({
        list: [
          {
            adgroup_id: ADGROUP_ID,
            promotion_type: "WEBSITE",
            optimization_goal: "CLICK",
          },
        ],
      }),
      "GET /smart_plus/ad/get/": ok({
        list: [],
        page_info: { total_number: 30 },
      }),
    })
    const ad = webInput.ad
    await expect(
      run({ adgroup_id: ADGROUP_ID, ad }, { dryRun: true })
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      run({ adgroup_id: "1", ad }, { dryRun: true })
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      run(
        { adgroup_id: ADGROUP_ID, campaign_id: CAMPAIGN_ID, ad },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("campaign_id: chiến dịch CBO có sẵn → nhóm không có ngân sách; SINGLE đã có nhóm → từ chối", async () => {
    const m = smartPlusApi({
      "GET /smart_plus/campaign/get/": ok({
        list: [
          {
            campaign_id: CAMPAIGN_ID,
            objective_type: "WEB_CONVERSIONS",
            sales_destination: "WEBSITE",
            budget_optimize_on: true,
            budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
            smart_plus_adgroup_mode: "MULTIPLE",
            operation_status: "DISABLE",
          },
        ],
      }),
      "GET /smart_plus/adgroup/get/": (c: RecordedCall) =>
        filtering(c).campaign_ids && !filtering(c).adgroup_name
          ? ok({ list: [], page_info: { total_number: 2 } })
          : ok({
              list: [
                {
                  adgroup_id: ADGROUP_ID,
                  adgroup_name: "VN 18+",
                  operation_status: "DISABLE",
                },
              ],
            }),
    })
    const res = (await run(
      { campaign_id: CAMPAIGN_ID, adgroup: webInput.adgroup },
      { idempotencyKey: "k" }
    )) as { createdIds: string[] }
    expect(res.createdIds).toEqual([ADGROUP_ID])
    expect(
      m.callsTo("POST /smart_plus/adgroup/create/")[0]!.body
    ).toMatchObject({ campaign_id: CAMPAIGN_ID })
    await expect(
      run(
        {
          campaign_id: CAMPAIGN_ID,
          adgroup: { ...webInput.adgroup, budget_type: "daily", budget: 1 },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    // a lead campaign does not take a WEBSITE ad group
    smartPlusApi({
      "GET /smart_plus/campaign/get/": ok({
        list: [
          {
            campaign_id: CAMPAIGN_ID,
            objective_type: "LEAD_GENERATION",
            budget_optimize_on: true,
            budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
            smart_plus_adgroup_mode: "SINGLE",
          },
        ],
      }),
      "GET /smart_plus/adgroup/get/": ok({
        list: [],
        page_info: { total_number: 1 },
      }),
    })
    await expect(
      run(
        {
          campaign_id: CAMPAIGN_ID,
          adgroup: {
            ...webInput.adgroup,
            goal: "TIKTOK_DM",
            optimization_goal: "CLICK",
            pixel_id: undefined,
            optimization_event: undefined,
          },
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      run(
        { campaign_id: CAMPAIGN_ID, adgroup: webInput.adgroup },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("thiếu adgroup / cả campaign lẫn campaign_id → từ chối, không gọi API", async () => {
    const m = smartPlusApi()
    await expect(
      run({ campaign: webInput.campaign }, { dryRun: true })
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      run(
        {
          campaign: webInput.campaign,
          campaign_id: CAMPAIGN_ID,
          adgroup: webInput.adgroup,
        },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.calls).toHaveLength(0)
  })
})
