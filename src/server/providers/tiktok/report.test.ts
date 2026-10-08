import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import type { ReportQuery } from "../types"
import reportFixture from "./__fixtures__/report_campaign_day.json"
import { ProviderError } from "../errors"
import { fail, makeCtx, mockTikTok, ok, type RecordedCall } from "./__fixtures__/mock-fetch"
import { buildReportFilters, getTikTokReport, latencyWarning, metricsForPreset, normalizeTikTokMetrics, reportWindows } from "./report"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const base: ReportQuery = {
  level: "campaign",
  dateRange: { from: "2026-06-01", to: "2026-08-09" },
  granularity: "day",
  metrics: "conversion",
  limit: 1000,
}

function row(id: string, day: string, spend = "100") {
  return { dimensions: { campaign_id: id, stat_time_day: `${day} 00:00:00` }, metrics: { campaign_name: `C${id}`, spend, impressions: "10" } }
}

describe("chia cửa sổ ngày", () => {
  it("70 ngày theo ngày → 3 cửa sổ ≤30 ngày liên tiếp", () => {
    expect(reportWindows(base)).toEqual([
      { from: "2026-06-01", to: "2026-06-30" },
      { from: "2026-07-01", to: "2026-07-30" },
      { from: "2026-07-31", to: "2026-08-09" },
    ])
  })

  it("granularity=total: 1 cửa sổ, từ chối >365 ngày", () => {
    expect(reportWindows({ ...base, granularity: "total" })).toHaveLength(1)
    expect(() => reportWindows({ ...base, granularity: "total", dateRange: { from: "2025-01-01", to: "2026-06-01" } })).toThrow(/365/)
  })

  it("ngày sai → ProviderError invalid_request (không phải RangeError thô)", () => {
    for (const dateRange of [
      { from: "2026-13-01", to: "2026-13-02" },
      { from: "2026-08-10", to: "2026-08-01" },
    ]) {
      let err: unknown
      try {
        reportWindows({ ...base, dateRange })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ProviderError)
      expect(err).toMatchObject({ platform: "tiktok", code: "invalid_request" })
    }
  })
})

describe("chỉ số chưa xác nhận", () => {
  it("40002 nêu tên chỉ số chưa xác nhận → bỏ chỉ số, thử lại đúng 1 lần, kèm cảnh báo", async () => {
    const m = mockTikTok({
      "GET /report/integrated/get/": (c: RecordedCall) => {
        const metrics = c.query.metrics as string[]
        if (metrics.includes("onsite_form")) return fail(40002, "Invalid metric: onsite_form")
        return ok({ list: [row("1", "2026-06-01")], page_info: { page: 1, total_page: 1 } })
      },
    })
    const res = await getTikTokReport(makeCtx(), { ...base, dateRange: { from: "2026-06-01", to: "2026-06-01" } })
    const calls = m.callsTo("GET /report/integrated/get/")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.query.metrics).not.toContain("onsite_form")
    expect(calls[1]!.query.metrics).toContain("form")
    expect(res.rows).toHaveLength(1)
    expect(res.warnings.join(" ")).toMatch(/onsite_form/)
  })

  it("40002 về tham số khác (không phải chỉ số chưa xác nhận) → ném lỗi, không thử lại", async () => {
    const m = mockTikTok({ "GET /report/integrated/get/": fail(40002, "Invalid start_date") })
    await expect(getTikTokReport(makeCtx(), { ...base, dateRange: { from: "2026-06-01", to: "2026-06-01" } })).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.callsTo("GET /report/integrated/get/")).toHaveLength(1)
  })

  it("lỗi lặp lại sau khi đã bỏ chỉ số → không thử lại lần nữa", async () => {
    const m = mockTikTok({
      "GET /report/integrated/get/": fail(40002, "Invalid metric: onsite_form, messaging_total_conversation_tiktok_direct_message"),
    })
    await expect(getTikTokReport(makeCtx(), { ...base, dateRange: { from: "2026-06-01", to: "2026-06-01" } })).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.callsTo("GET /report/integrated/get/")).toHaveLength(2)
  })
})

describe("getTikTokReport", () => {
  it("gọi từng cửa sổ, ghép các trang và chuẩn hoá chỉ số", async () => {
    const m = mockTikTok({
      "GET /report/integrated/get/": (c: RecordedCall) => {
        const start = c.query.start_date as string
        const page = Number(c.query.page)
        if (start === "2026-06-01") {
          return ok({ list: page === 1 ? [row("1", "2026-06-01"), row("2", "2026-06-01")] : [row("1", "2026-06-02")], page_info: { page, total_page: 2 } })
        }
        if (start === "2026-07-01") return ok({ list: [row("1", "2026-07-05")], page_info: { page: 1, total_page: 1 } })
        return ok({ list: [row("3", "2026-08-09", "7.5")], page_info: { page: 1, total_page: 1 } })
      },
    })
    const res = await getTikTokReport(makeCtx(), base)
    expect(res.rows.map((r) => [r.date, r.campaignId])).toEqual([
      ["2026-06-01", "1"],
      ["2026-06-01", "2"],
      ["2026-06-02", "1"],
      ["2026-07-05", "1"],
      ["2026-08-09", "3"],
    ])
    expect(res.nextCursor).toBeNull()
    expect(res.currency).toBe("VND")
    expect(res.rows[4]!.metrics.spend).toBe(7.5)
    const calls = m.callsTo("GET /report/integrated/get/")
    expect(calls.map((c) => [c.query.start_date, c.query.end_date, Number(c.query.page)])).toEqual([
      ["2026-06-01", "2026-06-30", 1],
      ["2026-06-01", "2026-06-30", 2],
      ["2026-07-01", "2026-07-30", 1],
      ["2026-07-31", "2026-08-09", 1],
    ])
    for (const c of calls) {
      expect(c.query.report_type).toBe("BASIC")
      expect(c.query.data_level).toBe("AUCTION_CAMPAIGN")
      expect(c.query.dimensions).toEqual(["campaign_id", "stat_time_day"])
      expect(Number(c.query.page_size)).toBe(1000)
      expect(c.query.metrics).toContain("campaign_name")
      expect(c.query.filtering).toBeUndefined()
    }
    expect(res.warnings.some((w) => w.includes("3 đoạn"))).toBe(true)
  })

  it("cursor mờ nối tiếp qua trang và cửa sổ khi limit nhỏ", async () => {
    mockTikTok({
      "GET /report/integrated/get/": (c: RecordedCall) => {
        const start = c.query.start_date as string
        const page = Number(c.query.page)
        if (start === "2026-06-01") {
          return ok({ list: page === 1 ? [row("1", "2026-06-01"), row("2", "2026-06-01")] : [row("3", "2026-06-02")], page_info: { total_page: 2 } })
        }
        if (start === "2026-07-01") return ok({ list: [row("4", "2026-07-01"), row("5", "2026-07-02")], page_info: { total_page: 1 } })
        return ok({ list: [], page_info: { total_page: 0 } })
      },
    })
    const q = { ...base, limit: 2 }
    const ids: string[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const res = await getTikTokReport(makeCtx(), { ...q, cursor })
      ids.push(...res.rows.map((r) => r.campaignId!))
      expect(res.rows.length).toBeLessThanOrEqual(2)
      cursor = res.nextCursor
    } while (cursor && ++guard < 10)
    expect(ids).toEqual(["1", "2", "3", "4", "5"])
  })

  it("chuẩn hoá chỉ số từ fixture thật (chuỗi → số, giá trị mua = total_complete_payment_rate)", async () => {
    mockTikTok({ "GET /report/integrated/get/": { body: reportFixture } })
    const res = await getTikTokReport(makeCtx(), { ...base, dateRange: { from: "2026-09-01", to: "2026-09-01" } })
    const r = res.rows[0]!
    expect(r).toMatchObject({ level: "campaign", date: "2026-09-01", campaignId: "1810000000000000001", campaignName: "Sale thang 10" })
    expect(r.metrics).toEqual({
      spend: 1250000,
      impressions: 84321,
      reach: 60210,
      frequency: 1.4,
      clicks: 1532,
      link_clicks: 1532,
      ctr: 1.82,
      cpc: 815.93,
      cpm: 14824.3,
      conversions: 42,
      conversion_value: 9120000,
      cpa: 29761.9,
      roas: 7.3,
      purchases: 38,
      leads: 8,
      messages: 11,
      video_views: null,
    })
  })

  it("preset basic không yêu cầu chỉ số chuyển đổi → null (không phải 0)", () => {
    const m = normalizeTikTokMetrics({ spend: "10", conversion: "5" }, new Set(metricsForPreset("basic")))
    expect(m.spend).toBe(10)
    expect(m.conversions).toBeNull()
    expect(m.leads).toBeNull()
  })

  it("cảnh báo header X-Tt-Ads-Throttle (chỉ 20k ad gần nhất)", async () => {
    mockTikTok({
      "GET /report/integrated/get/": {
        headers: { "X-Tt-Ads-Throttle": "Number of ad ids is equal or more than 20k" },
        body: { code: 0, message: "OK", request_id: "r", data: { list: [], page_info: { total_page: 0 } } },
      },
    })
    const res = await getTikTokReport(makeCtx(), { ...base, level: "ad", dateRange: { from: "2026-09-01", to: "2026-09-02" } })
    expect(res.warnings.some((w) => w.includes("20.000"))).toBe(true)
  })
})

describe("bộ lọc báo cáo", () => {
  it("filtering là mảng, filter_value là chuỗi JSON; includeDeleted → STATUS_ALL", () => {
    const warnings: string[] = []
    const f = buildReportFilters(
      { ...base, level: "ad_group", filters: { campaignIds: ["11", "12"], adGroupIds: ["21"], includeDeleted: true } },
      warnings
    )
    expect(f).toEqual([
      { field_name: "campaign_ids", filter_type: "IN", filter_value: '["11","12"]' },
      { field_name: "adgroup_ids", filter_type: "IN", filter_value: '["21"]' },
      { field_name: "adgroup_status", filter_type: "IN", filter_value: '["STATUS_ALL"]' },
    ])
  })

  it("mặc định không gửi bộ lọc trạng thái (TikTok tự loại đối tượng đã xoá)", () => {
    expect(buildReportFilters({ ...base, filters: {} }, [])).toEqual([])
  })

  it("bộ lọc sai cấp bị bỏ qua kèm cảnh báo", () => {
    const warnings: string[] = []
    expect(buildReportFilters({ ...base, level: "campaign", filters: { adIds: ["1"] } }, warnings)).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it("gửi filtering dạng JSON trên query", async () => {
    const m = mockTikTok({ "GET /report/integrated/get/": ok({ list: [], page_info: { total_page: 0 } }) })
    await getTikTokReport(makeCtx(), { ...base, dateRange: { from: "2026-09-01", to: "2026-09-01" }, filters: { campaignIds: ["5"] } })
    const raw = new URL(m.calls[0]!.url).searchParams.get("filtering")
    expect(JSON.parse(raw!)).toEqual([{ field_name: "campaign_ids", filter_type: "IN", filter_value: '["5"]' }])
  })
})

describe("cảnh báo độ trễ dữ liệu", () => {
  it("hôm qua trước 12:00 UTC chưa chốt", () => {
    const w: string[] = []
    latencyWarning({ from: "2026-10-01", to: "2026-10-01" }, "Asia/Ho_Chi_Minh", w, new Date("2026-10-02T05:00:00Z"))
    expect(w[0]).toContain("12:00 UTC")
  })
  it("hôm nay chưa chốt", () => {
    const w: string[] = []
    latencyWarning({ from: "2026-10-02", to: "2026-10-02" }, "Asia/Ho_Chi_Minh", w, new Date("2026-10-02T05:00:00Z"))
    expect(w[0]).toContain("hôm nay")
  })
})
