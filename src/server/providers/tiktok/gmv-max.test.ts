import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extensionProblem } from "../../mcp/tools/extensions"
import { __resetBuckets } from "../rate-limit"
import type { ProviderExtension, ReportPage } from "../types"
import campaignGetFixture from "./__fixtures__/gmv-max-campaign-get.json"
import infoFixture from "./__fixtures__/gmv-max-campaign-info.json"
import {
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import reportAccountFixture from "./__fixtures__/gmv-max-report-account-day.json"
import reportCampaignFixture from "./__fixtures__/gmv-max-report-campaign.json"
import storeListFixture from "./__fixtures__/gmv-max-store-list.json"
import reportFixture from "./__fixtures__/report_campaign_day.json"
import { bucketSpecFor, mapTikTokError } from "./client"
import { tiktokExtensions } from "./extensions"
import {
  __resetGmvMaxProbeCache,
  accountHasGmvMax,
  fetchGmvMaxTypes,
  gmvMaxActivationSpend,
  gmvMaxStatus,
  gmvMaxWorstCaseDaily,
  GMV_MAX_PROBE_TTL_MS,
  gmvMaxCampaignsInput,
  gmvMaxExtensions,
  gmvMaxReportInput,
  mapGmvMaxInfo,
  parseGmvMaxMetric,
  peekGmvMaxPresence,
  planGmvMaxReport,
  runGmvMaxCampaigns,
  runGmvMaxReport,
  runGmvMaxShops,
  withGmvMaxReportWarning,
} from "./gmv-max"
import {
  GMV_MAX_CAUTION,
  GMV_MAX_ENABLE_WARNING,
  GMV_MAX_LIST_NOTE,
  GMV_MAX_NOT_FOUND_HINT,
  GMV_MAX_NOT_IN_REPORT_WARNING,
  GMV_MAX_PAUSE_WARNING,
  GMV_MAX_REPORT_NOTES,
  GMV_MAX_SCOPE_HINT,
  GMV_MAX_ACCOUNT_LEVEL_DELETED_NOTE,
  gmvMaxLockedMessage,
  gmvMaxScopeHint,
  gmvMaxUnverifiedMessage,
} from "./gmv-max-text"
import { ttFromCtx } from "./api"
import { tiktokProvider } from "./index"
import { getTikTokObject, listTikTokObjects } from "./objects"

const ADV = "7100000000000000001"
const NOW = new Date("2026-10-10T05:00:00Z")

beforeEach(() => {
  __resetBuckets()
  __resetGmvMaxProbeCache()
})
afterEach(() => vi.unstubAllGlobals())

const reportInput = (v: Record<string, unknown>) => gmvMaxReportInput.parse(v)
const NO_URL = /https?:\/\/|x-expires|x-signature/

function campaignsReply(
  rows: Record<string, unknown>[],
  totalPage = 1,
  page = 1
) {
  return ok({
    list: rows,
    page_info: {
      page,
      page_size: 100,
      total_page: totalPage,
      total_number: rows.length,
    },
  })
}

describe("gmv-max-text (chuỗi dùng chung)", () => {
  it("có đủ chuỗi, có id trong thông báo từ chối", () => {
    expect(gmvMaxLockedMessage("1840000000000000001")).toContain(
      "chưa được quản trị viên cho phép thay đổi chiến dịch GMV Max (1840000000000000001)"
    )
    expect(gmvMaxUnverifiedMessage("123")).toContain("123")
    for (const s of [
      GMV_MAX_CAUTION,
      GMV_MAX_PAUSE_WARNING,
      GMV_MAX_ENABLE_WARNING,
      GMV_MAX_NOT_IN_REPORT_WARNING,
      GMV_MAX_SCOPE_HINT,
    ]) {
      expect(s.length).toBeGreaterThan(30)
    }
    expect(GMV_MAX_CAUTION).toContain("ít nhất 3 ngày")
    expect(GMV_MAX_NOT_IN_REPORT_WARNING).toContain("tiktok_gmv_max_report")
    expect(GMV_MAX_REPORT_NOTES.length).toBeGreaterThanOrEqual(4)
  })
})

describe("đăng ký tool (chỉ đọc)", () => {
  it("3 tool GMV Max hợp lệ: permission read, write false, mô tả Dùng khi ≤1500 ký tự", () => {
    const taken = new Set<string>()
    expect(gmvMaxExtensions.map((e) => e.name)).toEqual([
      "tiktok_gmv_max_shops",
      "tiktok_gmv_max_campaigns",
      "tiktok_gmv_max_report",
    ])
    for (const e of gmvMaxExtensions) {
      expect(
        extensionProblem("tiktok", e as ProviderExtension, taken)
      ).toBeNull()
      taken.add(e.name)
      expect(e.permission).toBe("read")
      expect(e.write).toBe(false)
      expect(e.moneyOf).toBeUndefined()
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
      expect(e.description).toContain("PHÂN TÍCH")
      expect(tiktokExtensions.some((t) => t.name === e.name)).toBe(true)
    }
  })
})

describe("tiktok_gmv_max_shops", () => {
  it("ánh xạ cửa hàng, đánh dấu ready cho đúng tài khoản, bỏ URL tạm", async () => {
    const m = mockTikTok({
      "GET /gmv_max/store/list/": { body: storeListFixture },
    })
    const res = (await runGmvMaxShops(makeCtx())) as {
      shops: {
        store_id: string
        ready: boolean
        authorized_for_this_account: boolean
        issues: string[]
      }[]
      summary: { total: number; ready_for_this_account: number }
      caution: string
    }
    expect(m.calls[0]!.query.advertiser_id).toBe(ADV)
    expect(res.summary).toEqual({ total: 3, ready_for_this_account: 1 })
    expect(res.shops[0]).toMatchObject({
      store_id: "7494000000000000001",
      ready: true,
      issues: [],
    })
    expect(res.shops[1]!.authorized_for_this_account).toBe(false)
    expect(res.shops[1]!.issues.join(" ")).toContain("một tài khoản QC khác")
    // another ad account: id + status only, never its name; platform values never inside issues sentences
    expect(res.shops[1]).toMatchObject({
      gmv_max_ad_account: {
        advertiser_id: "7100000000000000999",
        advertiser_name: null,
        advertiser_status: "STATUS_ENABLE",
      },
    })
    expect(JSON.stringify(res)).not.toContain("Agency XYZ")
    expect(res.shops[0]).toMatchObject({
      gmv_max_ad_account: { advertiser_name: "Shop ABC" },
    })
    expect(res.shops[2]!.ready).toBe(false)
    expect(res.shops[2]!.issues.join(" ")).toMatch(
      /is_gmv_max_available = false/
    )
    expect(res.shops[2]).toMatchObject({ store_role: "MANAGER" })
    expect(res.shops[2]!.issues.join(" ")).toContain("(store_role)")
    for (const s of res.shops)
      expect(s.issues.join(" ")).not.toMatch(/MANAGER|STATUS_ENABLE|Shop ABC/)
    expect(res.caution).toBe(GMV_MAX_CAUTION)
    expect(JSON.stringify(res)).not.toMatch(NO_URL)
  })

  it("lỗi quyền 40001 trên đường GMV Max → gợi ý quyền GMV MAX", async () => {
    mockTikTok({
      "GET /gmv_max/store/list/": fail(40001, "No permission to operate"),
    })
    await expect(runGmvMaxShops(makeCtx())).rejects.toMatchObject({
      code: "permission_denied",
      hint: gmvMaxScopeHint("/gmv_max/store/list/"),
    })
    expect(gmvMaxScopeHint("/gmv_max/store/list/")).toContain(
      "GMV MAX > Store Management"
    )
  })
})

describe("tiktok_gmv_max_campaigns", () => {
  it("gọi cả PRODUCT_GMV_MAX và LIVE_GMV_MAX, page_size 100, chuẩn hoá trạng thái + giải thích", async () => {
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const types = (
          call.query.filtering as { gmv_max_promotion_types: string[] }
        ).gmv_max_promotion_types
        return types[0] === "PRODUCT_GMV_MAX"
          ? { body: campaignGetFixture }
          : campaignsReply([])
      },
    })
    const ctx = makeCtx()
    const res = (await runGmvMaxCampaigns(
      ctx,
      gmvMaxCampaignsInput.parse({
        store_id: "7494000000000000001",
        status: "active",
      })
    )) as {
      campaigns: Record<string, unknown>[]
      caution: string
      truncated: boolean
    }
    const calls = m.callsTo("GET /gmv_max/campaign/get/")
    expect(calls).toHaveLength(2)
    expect(calls[0]!.query.filtering).toEqual({
      store_ids: ["7494000000000000001"],
      primary_status: "STATUS_DELIVERY_OK",
      gmv_max_promotion_types: ["PRODUCT_GMV_MAX"],
    })
    expect(calls[1]!.query.filtering).toMatchObject({
      gmv_max_promotion_types: ["LIVE_GMV_MAX"],
    })
    expect(calls[0]!.query.page_size).toBe("100")
    expect(res.campaigns).toHaveLength(2)
    expect(res.campaigns[0]).toMatchObject({
      campaign_id: "1840000000000000001",
      type: "PRODUCT",
      status: "active",
      primary_status: "STATUS_DELIVERY_OK",
      created_time: "2026-09-01T02:30:00.000Z",
    })
    expect(res.campaigns[1]).toMatchObject({
      status: "paused",
      primary_status: "STATUS_DISABLE",
      status_note: expect.stringContaining("tài khoản QC khác"),
    })
    expect(res.campaigns[0]!.roi_protection_note).toMatch(/Bảo vệ ROI/)
    expect(res.caution).toBe(GMV_MAX_CAUTION)
    expect(res.truncated).toBe(false)
    expect(peekGmvMaxPresence(ttFromCtx(ctx))).toBe(true)
    // the cache key includes the developer app: another connection/app is not affected
    expect(peekGmvMaxPresence(ttFromCtx(makeCtx()))).toBeUndefined()
  })

  it("phân trang tới hết total_page, cắt theo limit + cảnh báo", async () => {
    const row = (i: number) => ({
      campaign_id: `18400000000000${String(i).padStart(5, "0")}`,
      campaign_name: `C${i}`,
      operation_status: "ENABLE",
    })
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const page = Number(call.query.page)
        if (page === 1)
          return {
            body: {
              code: 0,
              message: "OK",
              data: {
                list: Array.from({ length: 100 }, (_, i) => row(i)),
                page_info: { page: 1, total_page: 2, total_number: 130 },
              },
            },
          }
        return {
          body: {
            code: 0,
            message: "OK",
            data: {
              list: Array.from({ length: 30 }, (_, i) => row(100 + i)),
              page_info: { page: 2, total_page: 2, total_number: 130 },
            },
          },
        }
      },
    })
    const res = (await runGmvMaxCampaigns(
      makeCtx(),
      gmvMaxCampaignsInput.parse({ type: "PRODUCT", limit: 120 })
    )) as {
      campaigns: unknown[]
      truncated: boolean
      warnings: string[]
    }
    expect(
      m.callsTo("GET /gmv_max/campaign/get/").map((c) => c.query.page)
    ).toEqual(["1", "2"])
    expect(res.campaigns).toHaveLength(120)
    expect(res.truncated).toBe(true)
    expect(res.warnings.join(" ")).toContain("giới hạn 120")
  })

  it("name_contains → filtering.campaign_name + lọc lại phía app; một loại lỗi → cảnh báo (không kèm lời TikTok), cả hai lỗi → ném lỗi", async () => {
    const m1 = mockTikTok({
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const t = (
          call.query.filtering as { gmv_max_promotion_types: string[] }
        ).gmv_max_promotion_types[0]
        return t === "PRODUCT_GMV_MAX"
          ? { body: campaignGetFixture }
          : fail(40001, "no permission")
      },
    })
    const res = (await runGmvMaxCampaigns(
      makeCtx(),
      gmvMaxCampaignsInput.parse({ name_contains: "áo THUN" })
    )) as {
      campaigns: { campaign_id: string }[]
      warnings: string[]
    }
    expect(res.campaigns.map((c) => c.campaign_id)).toEqual([
      "1840000000000000002",
    ])
    expect(
      m1.callsTo("GET /gmv_max/campaign/get/")[0]!.query.filtering
    ).toMatchObject({ campaign_name: "áo THUN" })
    expect(res.warnings.join(" ")).toContain("loại LIVE")
    expect(res.warnings.join(" ")).toContain("(mã 40001)")
    expect(res.warnings.join(" ")).not.toContain("no permission")

    mockTikTok({ "GET /gmv_max/campaign/get/": fail(40001, "no permission") })
    await expect(
      runGmvMaxCampaigns(makeCtx(), gmvMaxCampaignsInput.parse({}))
    ).rejects.toMatchObject({ code: "permission_denied" })
  })

  it("include_details: ngân sách/ROI/chi tiêu tối đa (đơn vị chính VND), lịch theo giờ tài khoản, không trả URL tạm", async () => {
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const t = (
          call.query.filtering as { gmv_max_promotion_types: string[] }
        ).gmv_max_promotion_types[0]
        return t === "PRODUCT_GMV_MAX"
          ? { body: campaignGetFixture }
          : campaignsReply([])
      },
      "GET /campaign/gmv_max/info/": (call: RecordedCall) =>
        call.query.campaign_id === "1840000000000000001"
          ? { body: infoFixture }
          : fail(40002, "campaign not exist"),
    })
    const res = (await runGmvMaxCampaigns(
      makeCtx(),
      gmvMaxCampaignsInput.parse({ include_details: true })
    )) as {
      campaigns: Record<string, unknown>[]
    }
    expect(m.callsTo("GET /campaign/gmv_max/info/")).toHaveLength(2)
    const d = res.campaigns[0]!.details as Record<string, unknown>
    expect(d).toMatchObject({
      store_id: "7494000000000000001",
      shopping_ads_type: "PRODUCT",
      target_roi: 2,
      currency: "VND",
      daily_budget: 300000,
      max_possible_daily_spend: 1800000,
      item_group_count: 2,
      post_count: 1,
    })
    expect(d.auto_budget).toMatchObject({
      enabled: true,
      maximum_budget: 1800000,
      budget_increase_percentage: 50,
    })
    expect(d.schedule).toMatchObject({
      start_time_utc: "2026-09-01T17:00:00.000Z",
      start_time_account_tz: "2026-09-02 00:00:00",
      end_time_account_tz: "2026-12-31 23:59:59",
    })
    expect(res.campaigns[1]!.details_error).toBeTruthy()
    expect(res.campaigns[1]!.details_error).not.toContain("campaign not exist")
    // identities: allow-listed scalar fields only
    expect(d.identities).toEqual([
      expect.objectContaining({
        identity_id: "7200000000000000001",
        identity_type: "TT_USER",
      }),
      expect.objectContaining({
        identity_id: "7200000000000000002",
        identity_authorized_bc_id: "7300000000000000001",
      }),
    ])
    expect(JSON.stringify(res)).not.toMatch(NO_URL)
    expect(JSON.stringify(res)).not.toContain("tok_test")
  })

  it("mapGmvMaxInfo: tiền USD làm tròn 2 số, cờ tăng ngân sách kiểu cũ = ngân sách × 10 (trường hợp xấu nhất)", () => {
    const d = mapGmvMaxInfo(
      {
        budget: "120.456",
        auto_budget_enabled: true,
        schedule_type: "SCHEDULE_FROM_NOW",
        schedule_start_time: "2026-10-01 00:00:00",
      },
      "USD",
      "America/Los_Angeles"
    )
    expect(d.daily_budget).toBe(120.46)
    expect(d.max_possible_daily_spend).toBe(1204.6)
    expect((d.max_possible_daily_spend_notes as string[]).join(" ")).toContain(
      "10 lần"
    )
    expect(d.schedule).toMatchObject({
      end_time_utc: null,
      start_time_account_tz: "2026-09-30 17:00:00",
    })
  })
})

describe("fetchGmvMaxTypes", () => {
  it("lọc campaign_ids theo từng loại, trả loại PRODUCT/LIVE; id không phải số bị bỏ", async () => {
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const f = call.query.filtering as {
          gmv_max_promotion_types: string[]
          campaign_ids: string[]
        }
        if (f.gmv_max_promotion_types[0] === "PRODUCT_GMV_MAX")
          return campaignsReply([{ campaign_id: "1" }])
        return campaignsReply(
          f.campaign_ids.includes("2") ? [{ campaign_id: "2" }] : []
        )
      },
    })
    const map = await fetchGmvMaxTypes(
      { creds: makeCtx().credentials, advertiserId: ADV },
      ["1", "2", "3", "abc"]
    )
    expect([...map.entries()]).toEqual([
      ["1", "PRODUCT"],
      ["2", "LIVE"],
    ])
    const calls = m.callsTo("GET /gmv_max/campaign/get/")
    expect(
      (calls[0]!.query.filtering as { campaign_ids: string[] }).campaign_ids
    ).toEqual(["1", "2", "3"])
    // LIVE check only for ids not already PRODUCT
    expect(
      (calls[1]!.query.filtering as { campaign_ids: string[] }).campaign_ids
    ).toEqual(["2", "3"])
  })
})

describe("planGmvMaxReport - kiểm tra trước khi gọi API", () => {
  const tz = "Asia/Ho_Chi_Minh"
  const base = { date_from: "2026-09-01", date_to: "2026-09-30" }

  it.each([
    [{ level: "campaign" }, /cần type/],
    [{ level: "product", type: "LIVE", campaign_ids: ["1"] }, /type=PRODUCT/],
    [
      {
        level: "creative",
        type: "LIVE",
        campaign_ids: ["1"],
        item_group_ids: ["2"],
      },
      /type=PRODUCT/,
    ],
    [{ level: "live_room", type: "PRODUCT", campaign_ids: ["1"] }, /type=LIVE/],
    [{ level: "product", type: "PRODUCT" }, /campaign_ids/],
    [{ level: "live_room", type: "LIVE" }, /campaign_ids/],
    [
      { level: "creative", type: "PRODUCT", campaign_ids: ["1"] },
      /item_group_ids/,
    ],
  ])("từ chối %j", (extra, msg) => {
    expect(() =>
      planGmvMaxReport(reportInput({ ...base, ...extra }), tz, NOW)
    ).toThrow(msg)
  })

  it("khoảng ngày: >365 ngày bị từ chối; thiếu date_to bị từ chối; from > to bị từ chối", () => {
    expect(() =>
      planGmvMaxReport(
        reportInput({ date_from: "2025-01-01", date_to: "2026-01-01" }),
        tz,
        NOW
      )
    ).toThrow(/365/)
    expect(() =>
      planGmvMaxReport(reportInput({ date_from: "2025-01-01" }), tz, NOW)
    ).toThrow(/date_to/)
    expect(() =>
      planGmvMaxReport(
        reportInput({ date_from: "2026-02-01", date_to: "2026-01-01" }),
        tz,
        NOW
      )
    ).toThrow()
    const ok365 = planGmvMaxReport(
      reportInput({ date_from: "2025-01-02", date_to: "2026-01-01" }),
      tz,
      NOW
    )
    expect(ok365.windows).toHaveLength(1)
  })

  it("theo ngày: chia đoạn ≤30 ngày; không truyền ngày → 7 ngày gần nhất theo múi giờ tài khoản", () => {
    const p = planGmvMaxReport(
      reportInput({
        date_from: "2026-08-01",
        date_to: "2026-09-30",
        breakdown: "day",
      }),
      tz,
      NOW
    )
    expect(p.windows).toEqual([
      { from: "2026-08-01", to: "2026-08-30" },
      { from: "2026-08-31", to: "2026-09-29" },
      { from: "2026-09-30", to: "2026-09-30" },
    ])
    expect(p.dimensions).toEqual(["advertiser_id", "stat_time_day"])
    expect(p.sortField).toBeNull()
    const d = planGmvMaxReport(reportInput({}), tz, NOW)
    expect(d.range).toEqual({ from: "2026-10-03", to: "2026-10-09" })
    expect(d.warnings.join(" ")).toContain("7 ngày gần nhất")
  })

  it("account: không type → không filtering (cả hai loại); có type → gmv_max_promotion_types; bỏ qua campaign_ids", () => {
    const a = planGmvMaxReport(
      reportInput({ ...base, campaign_ids: ["1"] }),
      tz,
      NOW
    )
    expect(a.filtering).toBeNull()
    expect(a.dimensions).toEqual(["advertiser_id"])
    expect(a.metrics).toEqual([
      "cost",
      "net_cost",
      "orders",
      "cost_per_order",
      "gross_revenue",
      "roi",
    ])
    expect(a.warnings.join(" ")).toContain("bỏ qua campaign_ids")
    // account level: undeleted campaigns only, no status filter → note
    expect(a.warnings).toContain(GMV_MAX_ACCOUNT_LEVEL_DELETED_NOTE)
    expect(
      planGmvMaxReport(reportInput({ ...base, type: "LIVE" }), tz, NOW)
        .filtering
    ).toEqual({ gmv_max_promotion_types: ["LIVE"] })
  })

  it("campaign: STATUS_ALL mặc định, LIVE có all_shops_* + tài khoản TikTok, sắp xếp theo cost", () => {
    const p = planGmvMaxReport(
      reportInput({
        ...base,
        level: "campaign",
        type: "LIVE",
        campaign_ids: ["11", "12"],
      }),
      tz,
      NOW
    )
    expect(p.dimensions).toEqual(["campaign_id"])
    expect(p.filtering).toEqual({
      gmv_max_promotion_types: ["LIVE"],
      campaign_ids: ["11", "12"],
      campaign_statuses: ["STATUS_ALL"],
    })
    expect(p.metrics).toEqual(
      expect.arrayContaining([
        "campaign_name",
        "roas_bid",
        "tt_account_name",
        "all_shops_roi",
        "live_views",
        "net_cost",
      ])
    )
    expect(p.metrics.some((m) => /url/.test(m))).toBe(false)
    expect(p.sortField).toBe("cost")
    const noDel = planGmvMaxReport(
      reportInput({
        ...base,
        level: "campaign",
        type: "PRODUCT",
        include_deleted: false,
      }),
      tz,
      NOW
    )
    expect(noDel.filtering).toEqual({ gmv_max_promotion_types: ["PRODUCT"] })
    expect(noDel.metrics).not.toContain("all_shops_roi")
    expect(noDel.warnings.join(" ")).toContain("Không gồm chiến dịch đã xoá")
    expect(noDel.warnings.join(" ")).toContain("include_deleted=true")
    expect(noDel.warnings.join(" ")).not.toContain("thấp hơn cấp account")
    expect(p.warnings).not.toContain(GMV_MAX_ACCOUNT_LEVEL_DELETED_NOTE)
  })

  it("product: 1 chiến dịch → [item_group_id] + thuộc tính; nhiều → [campaign_id,item_group_id] không thuộc tính", () => {
    const one = planGmvMaxReport(
      reportInput({
        ...base,
        level: "product",
        type: "PRODUCT",
        campaign_ids: ["1"],
        breakdown: "day",
      }),
      tz,
      NOW
    )
    expect(one.dimensions).toEqual(["item_group_id", "stat_time_day"])
    expect(one.metrics).toEqual(
      expect.arrayContaining(["product_name", "product_status", "cost", "roi"])
    )
    expect(one.filtering).toEqual({ campaign_ids: ["1"] })
    const many = planGmvMaxReport(
      reportInput({
        ...base,
        level: "product",
        type: "PRODUCT",
        campaign_ids: ["1", "2"],
      }),
      tz,
      NOW
    )
    expect(many.dimensions).toEqual(["campaign_id", "item_group_id"])
    expect(many.metrics).not.toContain("product_name")
  })

  it("creative / live_room: nhóm chiều và bộ lọc bắt buộc theo tài liệu", () => {
    const c = planGmvMaxReport(
      reportInput({
        ...base,
        level: "creative",
        type: "PRODUCT",
        campaign_ids: ["1"],
        item_group_ids: ["2", "3"],
        breakdown: "day",
      }),
      tz,
      NOW
    )
    expect(c.dimensions).toEqual([
      "campaign_id",
      "item_group_id",
      "item_id",
      "stat_time_day",
    ])
    expect(c.filtering).toEqual({
      campaign_ids: ["1"],
      item_group_ids: ["2", "3"],
    })
    expect(c.metrics).toContain("creative_delivery_status")
    expect(c.metrics).not.toContain("title")
    const r1 = planGmvMaxReport(
      reportInput({
        ...base,
        level: "live_room",
        type: "LIVE",
        campaign_ids: ["1"],
      }),
      tz,
      NOW
    )
    expect(r1.dimensions).toEqual(["room_id"])
    expect(r1.metrics).toEqual(
      expect.arrayContaining(["live_name", "live_status", "all_shops_orders"])
    )
    const r2 = planGmvMaxReport(
      reportInput({
        ...base,
        level: "live_room",
        type: "LIVE",
        campaign_ids: ["1", "2"],
      }),
      tz,
      NOW
    )
    expect(r2.dimensions).toEqual(["campaign_id", "room_id"])
    expect(r2.metrics).not.toContain("live_name")
  })

  it("trước 2024-09-27 → cảnh báo không có dữ liệu", () => {
    const p = planGmvMaxReport(
      reportInput({ date_from: "2024-09-01", date_to: "2024-10-31" }),
      tz,
      NOW
    )
    expect(p.warnings.join(" ")).toContain("2024-09-27")
  })
})

describe("parseGmvMaxMetric", () => {
  it("chuỗi → số an toàn; tiền làm tròn theo tiền tệ; chữ giữ nguyên", () => {
    expect(parseGmvMaxMetric("cost", "1234.6", "VND")).toBe(1235)
    expect(parseGmvMaxMetric("cost", "9387.584", "USD")).toBe(9387.58)
    expect(parseGmvMaxMetric("gross_revenue", "1,234.50", "USD")).toBe(1234.5)
    expect(parseGmvMaxMetric("orders", "6674", "VND")).toBe(6674)
    expect(parseGmvMaxMetric("all_shops_roi", 3.456, "VND")).toBe(3.456)
    expect(parseGmvMaxMetric("roi", "-", "VND")).toBeNull()
    expect(parseGmvMaxMetric("cost", "", "VND")).toBeNull()
    expect(parseGmvMaxMetric("campaign_name", "Sale 10.10", "VND")).toBe(
      "Sale 10.10"
    )
    expect(
      parseGmvMaxMetric("schedule_start_time", "2026-09-01 17:00:00", "VND")
    ).toBe("2026-09-01T17:00:00.000Z")
  })
})

describe("tiktok_gmv_max_report", () => {
  it("account theo ngày (USD): số liệu từ fixture chính thức, tổng cộng, tiền tệ từ tài khoản, ghi chú + caution", async () => {
    const m = mockTikTok({
      "GET /gmv_max/report/get/": { body: reportAccountFixture },
    })
    const res = (await runGmvMaxReport(
      makeCtx({ currency: "USD", timezone: "America/New_York" }),
      reportInput({
        store_id: "7494000000000000001",
        date_from: "2026-10-01",
        date_to: "2026-10-02",
        breakdown: "day",
      }),
      NOW
    )) as Record<string, unknown>
    const q = m.calls[0]!.query
    expect(q).toMatchObject({
      advertiser_id: ADV,
      store_ids: ["7494000000000000001"],
      start_date: "2026-10-01",
      end_date: "2026-10-02",
      dimensions: ["advertiser_id", "stat_time_day"],
      metrics: [
        "cost",
        "net_cost",
        "orders",
        "cost_per_order",
        "gross_revenue",
        "roi",
      ],
      page: "1",
      page_size: "1000",
    })
    expect(q.filtering).toBeUndefined()
    expect(q.sort_field).toBeUndefined()
    expect(res.currency).toBe("USD")
    expect(res.rows).toEqual([
      {
        store_id: "7494000000000000001",
        date: "2026-10-01",
        advertiser_id: ADV,
        cost: 9387.58,
        net_cost: 6550.08,
        orders: 6674,
        cost_per_order: 1.41,
        gross_revenue: 43117.68,
        roi: 4.59,
      },
      {
        store_id: "7494000000000000001",
        date: "2026-10-02",
        advertiser_id: ADV,
        cost: 7230.56,
        net_cost: 7230.56,
        orders: 5036,
        cost_per_order: 1.44,
        gross_revenue: 31547.59,
        roi: 4.36,
      },
    ])
    expect(res.totals).toEqual({
      cost: 16618.14,
      net_cost: 13780.64,
      gross_revenue: 74665.27,
      orders: 11710,
      roi: 4.49,
      cost_per_order: 1.42,
    })
    expect(res.notes).toEqual([...GMV_MAX_REPORT_NOTES])
    expect(res.caution).toBe(GMV_MAX_CAUTION)
  })

  it("campaign (VND): bỏ qua currency trong dòng, filtering object + STATUS_ALL + sort cost, chuỗi rỗng → null", async () => {
    const m = mockTikTok({
      "GET /gmv_max/report/get/": { body: reportCampaignFixture },
    })
    const res = (await runGmvMaxReport(
      makeCtx(),
      reportInput({
        store_id: "7494000000000000001",
        level: "campaign",
        type: "PRODUCT",
        date_from: "2026-09-01",
        date_to: "2026-09-30",
      }),
      NOW
    )) as {
      rows: Record<string, unknown>[]
      currency: string
      totals: Record<string, unknown>
    }
    const q = m.calls[0]!.query
    expect(q.filtering).toEqual({
      gmv_max_promotion_types: ["PRODUCT"],
      campaign_statuses: ["STATUS_ALL"],
    })
    expect(q).toMatchObject({
      sort_field: "cost",
      sort_type: "DESC",
      dimensions: ["campaign_id"],
    })
    expect(res.currency).toBe("VND")
    expect(res.rows[0]).toMatchObject({
      campaign_id: "1840000000000000001",
      campaign_name: "GMV Max - Tất cả sản phẩm",
      cost: 1250000,
      gross_revenue: 6875000,
      roas_bid: 5.5,
      target_roi_budget: 300000,
      schedule_start_time: "2026-09-01T17:00:00.000Z",
    })
    expect(res.rows[0]).not.toHaveProperty("currency")
    expect(res.rows[1]!.schedule_end_time).toBeNull()
    expect(res.totals).toMatchObject({
      cost: 1250000,
      orders: 50,
      roi: 5.5,
      cost_per_order: 25000,
    })
  })

  it("chia đoạn 30 ngày + phân trang trong mỗi đoạn", async () => {
    const m = mockTikTok({
      "GET /gmv_max/report/get/": (call: RecordedCall) => {
        const page = Number(call.query.page)
        const day = String(call.query.start_date)
        return ok({
          list: [
            {
              dimensions: {
                advertiser_id: ADV,
                stat_time_day: `${day} 00:00:00`,
              },
              metrics: { cost: "1.00", orders: "1" },
            },
          ],
          page_info: {
            page,
            page_size: 1000,
            total_page: day === "2026-08-01" ? 2 : 1,
            total_number: 2,
          },
        })
      },
    })
    const res = (await runGmvMaxReport(
      makeCtx({ currency: "USD" }),
      reportInput({
        store_id: "1",
        date_from: "2026-08-01",
        date_to: "2026-09-14",
        breakdown: "day",
      }),
      NOW
    )) as { rows: unknown[]; warnings: string[] }
    expect(
      m.calls.map((c) => [c.query.start_date, c.query.end_date, c.query.page])
    ).toEqual([
      ["2026-08-01", "2026-08-30", "1"],
      ["2026-08-01", "2026-08-30", "2"],
      ["2026-08-31", "2026-09-14", "1"],
    ])
    expect(res.rows).toHaveLength(3)
    expect(res.warnings.join(" ")).toContain("2 đoạn ≤30 ngày")
  })

  it("không truyền store_id: mọi cửa hàng (đã cấp quyền cho tài khoản này trước), 1 cửa hàng/lần gọi; lỗi 1 cửa hàng → cảnh báo không kèm lời TikTok", async () => {
    const m = mockTikTok({
      "GET /gmv_max/store/list/": { body: storeListFixture },
      "GET /gmv_max/report/get/": (call: RecordedCall) =>
        (call.query.store_ids as string[])[0] === "7494000000000000003"
          ? fail(40002, "store not available")
          : { body: reportAccountFixture },
    })
    const res = (await runGmvMaxReport(
      makeCtx(),
      reportInput({ date_from: "2026-10-01", date_to: "2026-10-02" }),
      NOW
    )) as {
      shops: { store_id: string; rows: number }[]
      warnings: string[]
      totals: unknown
    }
    expect(
      m.callsTo("GET /gmv_max/report/get/").map((c) => c.query.store_ids)
    ).toEqual([
      ["7494000000000000001"],
      ["7494000000000000003"],
      ["7494000000000000002"],
    ])
    expect(res.shops).toEqual([
      {
        store_id: "7494000000000000001",
        store_name: "Shop ABC Official",
        rows: 2,
      },
      { store_id: "7494000000000000003", store_name: "Shop ABC Mới", rows: 0 },
      {
        store_id: "7494000000000000002",
        store_name: "Shop ABC Outlet",
        rows: 2,
      },
    ])
    expect(res.warnings.join(" ")).toContain("Cửa hàng 7494000000000000003")
    expect(res.warnings.join(" ")).toContain("(mã 40002)")
    expect(res.warnings.join(" ")).not.toContain("store not available")
    expect(res.totals).toBeNull() // partial data → no totals
  })

  it("store_id truyền vào bị lỗi → ném lỗi (kèm gợi ý quyền GMV Max với 40001)", async () => {
    mockTikTok({ "GET /gmv_max/report/get/": fail(40001, "No permission") })
    await expect(
      runGmvMaxReport(
        makeCtx(),
        reportInput({ store_id: "1", date_preset: "yesterday" }),
        NOW
      )
    ).rejects.toMatchObject({
      code: "permission_denied",
      hint: gmvMaxScopeHint("/gmv_max/report/get/"),
    })
    expect(gmvMaxScopeHint("/gmv_max/report/get/")).toContain(
      "Reporting > GMV MAX Report"
    )
  })

  it("giới hạn số dòng → truncated + không tính tổng", async () => {
    mockTikTok({
      "GET /gmv_max/report/get/": ok({
        list: Array.from({ length: 5 }, (_, i) => ({
          dimensions: { campaign_id: String(i + 1) },
          metrics: { cost: "1", campaign_name: `c${i}` },
        })),
        page_info: { page: 1, total_page: 1, total_number: 5 },
      }),
    })
    const res = (await runGmvMaxReport(
      makeCtx(),
      reportInput({
        store_id: "1",
        level: "campaign",
        type: "PRODUCT",
        date_preset: "last_7d",
        limit: 3,
      }),
      NOW
    )) as { rows: unknown[]; truncated: boolean; totals: unknown }
    expect(res.rows).toHaveLength(3)
    expect(res.truncated).toBe(true)
    expect(res.totals).toBeNull()
  })

  it("không có cửa hàng nào → kết quả rỗng có hướng dẫn, không gọi report", async () => {
    const m = mockTikTok({ "GET /gmv_max/store/list/": ok({ store_list: [] }) })
    const res = (await runGmvMaxReport(
      makeCtx(),
      reportInput({ date_preset: "yesterday" }),
      NOW
    )) as { rows: unknown[]; warnings: string[] }
    expect(res.rows).toEqual([])
    expect(res.warnings.join(" ")).toContain("tiktok_gmv_max_shops")
    expect(m.callsTo("GET /gmv_max/report/get/")).toHaveLength(0)
  })
})

describe("probe 'tài khoản có GMV Max' (cache 10 phút, không bao giờ ném lỗi)", () => {
  // one connection (same developer app) per test: the cache key is app + advertiser
  let creds = makeCtx().credentials
  beforeEach(() => {
    creds = makeCtx().credentials
  })
  const tt = () => ({ creds, advertiserId: ADV })

  it("PRODUCT có chiến dịch → true sau 1 lần gọi; cache; hết hạn thì gọi lại", async () => {
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": campaignsReply([{ campaign_id: "1" }]),
    })
    const t0 = Date.now()
    expect(await accountHasGmvMax(tt(), t0)).toBe(true)
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0]!.query).toMatchObject({
      page_size: "1",
      filtering: { gmv_max_promotion_types: ["PRODUCT_GMV_MAX"] },
    })
    // same advertiser through another developer app → separate cache entry
    expect(
      await accountHasGmvMax(
        { creds: makeCtx().credentials, advertiserId: ADV },
        t0
      )
    ).toBe(true)
    expect(m.calls).toHaveLength(2)
    expect(await accountHasGmvMax(tt(), t0 + 60_000)).toBe(true)
    expect(m.calls).toHaveLength(2)
    expect(await accountHasGmvMax(tt(), t0 + GMV_MAX_PROBE_TTL_MS + 1)).toBe(
      true
    )
    expect(m.calls).toHaveLength(3)
  })

  it("không có chiến dịch nào → false (2 lần gọi); lỗi → null, không ném, cũng được cache", async () => {
    let m = mockTikTok({ "GET /gmv_max/campaign/get/": campaignsReply([]) })
    expect(await accountHasGmvMax(tt())).toBe(false)
    expect(m.calls).toHaveLength(2)
    __resetGmvMaxProbeCache()
    m = mockTikTok({
      "GET /gmv_max/campaign/get/": fail(40001, "no permission"),
    })
    await expect(accountHasGmvMax(tt())).resolves.toBeNull()
    const n = m.calls.length
    await expect(accountHasGmvMax(tt())).resolves.toBeNull()
    expect(m.calls.length).toBe(n)
  })

  it("không thử lại khi lỗi tạm thời (1 lần gọi duy nhất), lỗi → null", async () => {
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": fail(50000, "system error"),
    })
    await expect(accountHasGmvMax(tt())).resolves.toBeNull()
    expect(m.calls).toHaveLength(1)
  })

  it("withGmvMaxReportWarning chỉ thêm cảnh báo khi chắc chắn có GMV Max; lỗi probe không làm hỏng báo cáo", async () => {
    const page: ReportPage = {
      rows: [],
      nextCursor: null,
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
      warnings: ["a"],
    }
    mockTikTok({ "GET /gmv_max/campaign/get/": fail(50000, "system error") })
    expect((await withGmvMaxReportWarning(makeCtx(), page)).warnings).toEqual([
      "a",
    ])
    __resetGmvMaxProbeCache()
    mockTikTok({
      "GET /gmv_max/campaign/get/": campaignsReply([{ campaign_id: "1" }]),
    })
    const out = await withGmvMaxReportWarning(makeCtx(), page)
    expect(out.warnings).toEqual(["a", GMV_MAX_NOT_IN_REPORT_WARNING])
    expect(page.warnings).toEqual(["a"])
  })

  it("ads_get_report TikTok (provider.getReport) kèm cảnh báo D5 khi tài khoản có GMV Max", async () => {
    mockTikTok({
      "GET /report/integrated/get/": { body: reportFixture },
      "GET /gmv_max/campaign/get/": campaignsReply([{ campaign_id: "1" }]),
    })
    const page = await tiktokProvider.getReport(makeCtx(), {
      level: "campaign",
      dateRange: { from: "2026-09-01", to: "2026-09-02" },
      granularity: "day",
      metrics: "basic",
      limit: 50,
    })
    expect(page.warnings).toContain(GMV_MAX_NOT_IN_REPORT_WARNING)
  })
})

describe("client: rate limit + gợi ý quyền GMV Max", () => {
  it("bucket gmv_max/report/get < 240 QPM kể cả burst đầu (3.5/s, burst 4); endpoint khác giữ mặc định", () => {
    const spec = bucketSpecFor("gmv_max/report/get")
    expect(spec).toEqual({ ratePerSec: 3.5, burst: 4 })
    expect((spec.burst ?? 0) + spec.ratePerSec * 60).toBeLessThan(240)
    expect(spec.burst ?? spec.ratePerSec).toBeLessThanOrEqual(8)
    expect(bucketSpecFor("gmv_max/campaign/get")).toEqual({ ratePerSec: 10 })
  })

  it("40001/40125 trên đường GMV Max → gợi ý riêng; đường khác giữ gợi ý cũ", () => {
    expect(
      mapTikTokError(40001, "x", null, 200, "/gmv_max/store/list/").hint
    ).toContain("GMV MAX > Store Management")
    expect(
      mapTikTokError(40125, "x", null, 200, "campaign/gmv_max/info").hint
    ).toContain("Campaign > Read Campaigns")
    expect(
      mapTikTokError(40001, "x", null, 200, "/gmv_max/campaign/get/").hint
    ).toContain("Campaign > Read Campaigns")
    expect(
      mapTikTokError(40001, "x", null, 200, "/gmv_max/report/get/").hint
    ).toContain("Reporting > GMV MAX Report")
    expect(
      mapTikTokError(40001, "x", null, 200, "/gmv_max/identity/get/").hint
    ).toContain("GMV MAX > Identity And Video")
    expect(
      mapTikTokError(40001, "x", null, 200, "/gmv_max/session/list/").hint
    ).toBe(GMV_MAX_SCOPE_HINT)
    expect(
      mapTikTokError(40001, "x", null, 200, "/campaign/get/").hint
    ).not.toBe(GMV_MAX_SCOPE_HINT)
    expect(mapTikTokError(40001, "x").hint).not.toBe(GMV_MAX_SCOPE_HINT)
    expect(
      mapTikTokError(40002, "x", null, 200, "/gmv_max/report/get/").hint
    ).toBeUndefined()
  })
})

describe("ads_list_objects (TikTok campaign): gắn extra.gmv_max", () => {
  const camp = (id: string, objective: string) => ({
    campaign_id: id,
    campaign_name: `C${id}`,
    objective_type: objective,
    operation_status: "ENABLE",
    secondary_status: "CAMPAIGN_STATUS_ENABLE",
    budget_mode: "BUDGET_MODE_INFINITE",
  })

  it("chỉ chiến dịch PRODUCT_SALES được kiểm tra; chiến dịch GMV Max được gắn loại + ghi chú", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": ok({
        list: [
          camp("11", "PRODUCT_SALES"),
          camp("12", "TRAFFIC"),
          camp("13", "PRODUCT_SALES"),
        ],
        page_info: { total_page: 1 },
      }),
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const f = call.query.filtering as {
          gmv_max_promotion_types: string[]
          campaign_ids: string[]
        }
        return campaignsReply(
          f.gmv_max_promotion_types[0] === "LIVE_GMV_MAX"
            ? [{ campaign_id: "13" }]
            : []
        )
      },
    })
    const page = await listTikTokObjects(makeCtx(), {
      level: "campaign",
      limit: 50,
    })
    const gmv = m.callsTo("GET /gmv_max/campaign/get/")
    expect(
      (gmv[0]!.query.filtering as { campaign_ids: string[] }).campaign_ids
    ).toEqual(["11", "13"])
    expect(page.items.find((i) => i.id === "13")!.extra).toMatchObject({
      gmv_max: "LIVE",
    })
    expect(page.items.find((i) => i.id === "11")!.extra).not.toHaveProperty(
      "gmv_max"
    )
    expect(page.warnings).toContain(GMV_MAX_LIST_NOTE)
  })

  it("không có ứng viên → không gọi thêm; kiểm tra GMV lỗi → danh sách vẫn trả bình thường", async () => {
    let m = mockTikTok({
      "GET /campaign/get/": ok({
        list: [camp("12", "TRAFFIC")],
        page_info: { total_page: 1 },
      }),
    })
    let page = await listTikTokObjects(makeCtx(), {
      level: "campaign",
      limit: 50,
    })
    expect(m.callsTo("GET /gmv_max/campaign/get/")).toHaveLength(0)
    expect(page.warnings).toEqual([])

    m = mockTikTok({
      "GET /campaign/get/": ok({
        list: [camp("11", "PRODUCT_SALES")],
        page_info: { total_page: 1 },
      }),
      "GET /gmv_max/campaign/get/": fail(40001, "no permission"),
    })
    page = await listTikTokObjects(makeCtx(), { level: "campaign", limit: 50 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.extra).not.toHaveProperty("gmv_max")
    expect(page.warnings).toEqual([])
  })
})

describe("không tìm thấy chiến dịch → gợi ý tool GMV Max", () => {
  it("cấp campaign có gợi ý; cấp ad group không", async () => {
    mockTikTok({
      "GET /campaign/get/": ok({ list: [], page_info: { total_page: 1 } }),
      "GET /adgroup/get/": ok({ list: [], page_info: { total_page: 1 } }),
    })
    await expect(
      getTikTokObject(makeCtx(), "campaign", "1840000000000000001")
    ).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining(GMV_MAX_NOT_FOUND_HINT),
    })
    const e = await getTikTokObject(makeCtx(), "ad_group", "1").catch(
      (x: { hint?: string }) => x
    )
    expect((e as { hint?: string }).hint).not.toContain(
      "tiktok_gmv_max_campaigns"
    )
  })
})

describe("gmvMaxStatus - nhóm trạng thái theo tài liệu GMV Max (1757239620352002)", () => {
  it("nhóm không phân phối không bao giờ là active dù operation_status ENABLE", () => {
    for (const sec of [
      "CAMPAIGN_STATUS_BUDGET_EXCEED",
      "CAMPAIGN_STATUS_IDENTITY_USED_BY_GMV_MAX_AD",
      "CAMPAIGN_STATUS_TTS_ACCOUNT_BALANCE_INSUFFICIENT",
      "CAMPAIGN_STATUS_TIKTOK_SHOP_UNAVAILABLE",
      "CAMPAIGN_STATUS_TTS_TT_ASSET_UNAVAILABLE",
      "CAMPAIGN_STATUS_PRODUCT_UNAVAILABLE",
      "ADVERTISER_CONTRACT_PENDING",
      "ADVERTISER_ACCOUNT_PUNISH",
    ]) {
      expect(gmvMaxStatus("ENABLE", sec)).toEqual({
        status: "disabled",
        primary_status: "STATUS_NOT_DELIVERY",
      })
    }
    expect(gmvMaxStatus("ENABLE", "CAMPAIGN_STATUS_ADVERTISER_AUDIT")).toEqual(
      { status: "pending_review", primary_status: "STATUS_NOT_DELIVERY" }
    )
    expect(
      gmvMaxStatus("ENABLE", "CAMPAIGN_STATUS_REVIEW_DISAPPROVED").status
    ).toBe("rejected")
  })

  it("nhóm Inactive (kể cả AUTHORIZATION_CANCEL, AWAITING_RELEASE) → paused; ENABLE → active; DELETE → deleted", () => {
    for (const sec of [
      "CAMPAIGN_STATUS_DISABLE",
      "CAMPAIGN_STATUS_PRODUCT_GMV_MAX_AUTHORIZATION_CANCEL",
      "CAMPAIGN_STATUS_LIVE_GMV_MAX_AUTHORIZATION_CANCEL",
      "CAMPAIGN_STATUS_IDENTITY_USED_BY_LIVE_GMV_MAX",
      "CAMPAIGN_STATUS_PRODUCT_USED_BY_PRODUCT_GMV_MAX",
      "CAMPAIGN_STATUS_AWAITING_RELEASE",
    ]) {
      expect(gmvMaxStatus("ENABLE", sec)).toEqual({
        status: "paused",
        primary_status: "STATUS_DISABLE",
      })
    }
    expect(gmvMaxStatus("ENABLE", "CAMPAIGN_STATUS_ENABLE").status).toBe(
      "active"
    )
    expect(gmvMaxStatus("DISABLE", "CAMPAIGN_STATUS_DELETE").status).toBe(
      "deleted"
    )
    // undocumented secondary status next to ENABLE → not claimed as delivering
    expect(gmvMaxStatus("ENABLE", "CAMPAIGN_STATUS_SOMETHING_NEW").status).toBe(
      "unknown"
    )
    expect(gmvMaxStatus("ENABLE", undefined).status).toBe("active")
  })
})

describe("gmvMaxWorstCaseDaily - chi tiêu tối đa có thể mỗi ngày", () => {
  it("lấy mức lớn nhất: ngân sách, maximum_budget, ngân sách × (1 + % × số lần); bỏ qua tăng ngân sách đang tắt", () => {
    const w = gmvMaxWorstCaseDaily(
      {
        budget: 300000,
        auto_budget: {
          auto_budget_enabled: true,
          budget_increase_percentage: 50,
          increase_limit: 10,
          maximum_budget: 1200000, // remained_times already used up partly
        },
        promotion_days: {
          is_enabled: false,
          budget_increase_percentage: 300,
          increase_limit: 10,
          maximum_budget: 9300000,
        },
      },
      "VND"
    )
    expect(w.daily_budget).toBe(300000)
    expect(w.max_possible_daily_spend).toBe(1800000) // 300k × (1 + 50% × 10)
    expect(w.notes.join(" ")).toContain("Max delivery")
  })

  it("ngày khuyến mãi đang bật → tính theo mức của ngày khuyến mãi", () => {
    const w = gmvMaxWorstCaseDaily(
      {
        budget: "100.5",
        promotion_days: {
          is_enabled: true,
          budget_increase_percentage: 300,
          increase_limit: 10,
        },
      },
      "USD"
    )
    expect(w.max_possible_daily_spend).toBe(3115.5) // 100.5 × 31
  })

  it("tăng ngân sách bật nhưng TikTok không trả mức tối đa → 31 × ngân sách + ghi chú; không có ngân sách → null", () => {
    const w = gmvMaxWorstCaseDaily(
      { budget: 200000, auto_budget: { auto_budget_enabled: true } },
      "VND"
    )
    expect(w.max_possible_daily_spend).toBe(6200000)
    expect(w.notes.join(" ")).toContain("31 lần")
    expect(gmvMaxWorstCaseDaily({}, "VND").max_possible_daily_spend).toBeNull()
  })
})

describe("gmvMaxActivationSpend - bật chiến dịch GMV Max", () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    campaign_id: id,
    campaign_name: `C${id}`,
    objective_type: "PRODUCT_SALES",
    operation_status: "DISABLE",
    secondary_status: "CAMPAIGN_STATUS_DISABLE",
    ...extra,
  })

  it("chỉ chiến dịch GMV Max: đọc info, trả ngân sách ngày + mức tối đa; không có ứng viên → không gọi", async () => {
    const m = mockTikTok({
      "GET /gmv_max/campaign/get/": (call: RecordedCall) => {
        const f = call.query.filtering as {
          gmv_max_promotion_types: string[]
          campaign_ids: string[]
        }
        return campaignsReply(
          f.gmv_max_promotion_types[0] === "PRODUCT_GMV_MAX" &&
            f.campaign_ids.includes("1840000000000000001")
            ? [{ campaign_id: "1840000000000000001" }]
            : []
        )
      },
      "GET /campaign/gmv_max/info/": { body: infoFixture },
    })
    const tt = ttFromCtx(makeCtx())
    const out = await gmvMaxActivationSpend(tt, [
      row("1840000000000000001"),
      row("2", { objective_type: "TRAFFIC" }),
    ])
    expect(out).toEqual([
      expect.objectContaining({
        id: "1840000000000000001",
        type: "PRODUCT",
        daily_budget: 300000,
        max_possible_daily_spend: 1800000,
      }),
    ])
    expect(m.callsTo("GET /campaign/gmv_max/info/")).toHaveLength(1)
    const n = m.calls.length
    expect(
      await gmvMaxActivationSpend(tt, [row("3", { objective_type: "REACH" })])
    ).toEqual([])
    expect(m.calls).toHaveLength(n)
  })

  it("không đọc được info → ném lỗi (fail closed); 40001 → thông điệp + gợi ý quyền Read Campaigns", async () => {
    mockTikTok({
      "GET /gmv_max/campaign/get/": campaignsReply([{ campaign_id: "9" }]),
      "GET /campaign/gmv_max/info/": fail(40001, "No permission"),
    })
    await expect(
      gmvMaxActivationSpend(ttFromCtx(makeCtx()), [row("9")])
    ).rejects.toMatchObject({
      code: "permission_denied",
      hint: expect.stringContaining("Campaign > Read Campaigns"),
    })
  })

  it("không xác minh được GMV Max (lỗi kiểm tra) → ném lỗi", async () => {
    mockTikTok({ "GET /gmv_max/campaign/get/": fail(50000, "system") })
    await expect(
      gmvMaxActivationSpend(ttFromCtx(makeCtx()), [row("9")])
    ).rejects.toMatchObject({ code: "upstream_error" })
  })
})

describe("tiktok_gmv_max_report - cửa hàng, placeholder, ghi chú", () => {
  it("bỏ trống store_id với >5 cửa hàng → lấy 5 (đã cấp quyền trước) + cảnh báo liệt kê cửa hàng bị bỏ qua", async () => {
    const shop = (i: number, mine: boolean) => ({
      store_id: `75000000000000000${String(i).padStart(2, "0")}`,
      store_name: `S${i}`,
      is_gmv_max_available: mine,
      store_role: "AD_PROMOTION",
      store_status: "ACTIVE",
      exclusive_authorized_advertiser_info: mine
        ? { advertiser_id: ADV, advertiser_name: "Mine" }
        : null,
    })
    const list = [1, 2, 3, 4, 5, 6, 7].map((i) => shop(i, i >= 6))
    const m = mockTikTok({
      "GET /gmv_max/store/list/": ok({ store_list: list }),
      "GET /gmv_max/report/get/": ok({
        list: [],
        page_info: { page: 1, total_page: 0 },
      }),
    })
    const res = (await runGmvMaxReport(
      makeCtx(),
      reportInput({ date_preset: "yesterday" }),
      NOW
    )) as { warnings: string[] }
    const called = m
      .callsTo("GET /gmv_max/report/get/")
      .map((c) => (c.query.store_ids as string[])[0])
    expect(called).toEqual([
      "7500000000000000006",
      "7500000000000000007",
      "7500000000000000001",
      "7500000000000000002",
      "7500000000000000003",
    ])
    const w = res.warnings.join(" ")
    expect(w).toContain("bỏ qua 2 cửa hàng")
    expect(w).toContain("7500000000000000004, 7500000000000000005")
  })

  it("LIVE: tt_account_name / identity_id '0' hoặc '-1' → null; live_room 1 chiến dịch có ghi chú múi giờ live_launched_time", () => {
    expect(parseGmvMaxMetric("tt_account_name", "0", "VND")).toBeNull()
    expect(parseGmvMaxMetric("identity_id", "-1", "VND")).toBeNull()
    expect(parseGmvMaxMetric("identity_id", "7200000000000000001", "VND")).toBe(
      "7200000000000000001"
    )
    expect(parseGmvMaxMetric("campaign_name", "0", "VND")).toBe("0")
    const p = planGmvMaxReport(
      reportInput({
        level: "live_room",
        type: "LIVE",
        campaign_ids: ["1"],
        date_preset: "yesterday",
      }),
      "Asia/Ho_Chi_Minh",
      NOW
    )
    expect(p.warnings.join(" ")).toContain("live_launched_time")
  })

  it("name_contains không ra kết quả → gợi ý TikTok có thể so tên chính xác", async () => {
    mockTikTok({ "GET /gmv_max/campaign/get/": campaignsReply([]) })
    const res = (await runGmvMaxCampaigns(
      makeCtx(),
      gmvMaxCampaignsInput.parse({ name_contains: "abc" })
    )) as { warnings: string[] }
    expect(res.warnings.join(" ")).toContain("tên đầy đủ")
  })

  it("identity_list / item_list: chỉ trường cho phép, object lồng nhau không lọt qua", () => {
    const d = mapGmvMaxInfo(
      {
        budget: 1,
        identity_list: [
          {
            identity_id: "1",
            identity_type: "TT_USER",
            profile_image: "https://p16.tiktokcdn.com/x?x-expires=1",
            nested: { a: { token: "secret" } },
            user_name: { evil: true },
          },
          "not-an-object",
        ],
        item_list: [
          {
            item_id: "11",
            text: "caption",
            identity_info: {
              identity_id: "1",
              profile_image: "https://x/y",
              user_name: "shop.vn",
            },
            video_info: {
              video_id: "v1",
              preview_url: "https://x/z",
              video_cover_url: "https://x/c",
            },
            extra_object: { a: 1 },
          },
          null,
        ],
      },
      "VND",
      "Asia/Ho_Chi_Minh"
    )
    expect(d.identities).toEqual([
      {
        identity_id: "1",
        identity_type: "TT_USER",
        identity_authorized_bc_id: null,
        identity_authorized_shop_id: null,
        store_id: null,
        user_name: null,
        display_name: null,
      },
    ])
    expect(d.posts).toEqual([
      {
        item_id: "11",
        text: "caption",
        spu_ids: [],
        identity_id: "1",
        identity_type: null,
        user_name: "shop.vn",
        video_id: "v1",
      },
    ])
    expect(JSON.stringify(d)).not.toMatch(/https?:|secret|evil|extra_object/)
  })
})
