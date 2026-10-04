import { describe, expect, it } from "vitest"
import type { ReportQuery } from "../types"
import { getReport, normalizeInsightRow } from "./report"
import { calls, clone, freezeDate, fx, json, makeCtx, route, setupHarness } from "./__fixtures__/harness"

setupHarness()

const baseQuery: ReportQuery = {
  level: "campaign",
  dateRange: { from: "2026-09-01", to: "2026-09-07" },
  granularity: "day",
  metrics: "conversion",
  limit: 100,
}

describe("OpenAI Ads report", () => {
  it("luôn gửi fields[] tường minh + time_ranges theo múi giờ tài khoản (until bao gồm)", async () => {
    freezeDate()
    route("get", "/ad_account/insights", fx.insightsCampaignDaily)
    await getReport(makeCtx(), baseQuery)
    const q = calls[0]!.url.searchParams
    const fields = q.getAll("fields[]")
    expect(fields.length).toBeGreaterThan(5)
    expect(fields).toEqual(
      expect.arrayContaining([
        "readable_time",
        "campaign_id",
        "campaign_name",
        "campaign_status",
        "impressions",
        "clicks",
        "spend",
        "ctr",
        "conversions",
        "cpa",
        "order_created_attributed_sales",
        "order_created_roas",
      ])
    )
    expect(q.get("aggregation_level")).toBe("campaign")
    expect(q.get("time_granularity")).toBe("daily")
    expect(q.getAll("time_ranges[]")).toHaveLength(1)
    expect(JSON.parse(q.getAll("time_ranges[]")[0]!)).toEqual({
      type: "date_range",
      since: "2026-09-01",
      until: "2026-09-07",
      timezone: "America/New_York",
    })
    expect(q.get("limit")).toBe("100")
    // consistent flat style: no dotted request field names
    expect(fields.some((f) => f.includes("."))).toBe(false)
  })

  it("preset basic vẫn gửi fields[] (bỏ trống sẽ chỉ trả impressions) và không xin chỉ số chuyển đổi", async () => {
    freezeDate()
    route("get", "/ad_account/insights", fx.insightsCampaignDaily)
    await getReport(makeCtx(), { ...baseQuery, level: "account", granularity: "total", metrics: "basic" })
    const q = calls[0]!.url.searchParams
    expect(q.get("aggregation_level")).toBe("ad_account")
    expect(q.get("time_granularity")).toBe("none")
    const fields = q.getAll("fields[]")
    expect(fields).toEqual(expect.arrayContaining(["ad_account_id", "impressions", "spend"]))
    expect(fields).not.toContain("conversions")
    expect(fields).not.toContain("readable_time")
  })

  it("OPENAI_ADS_INSIGHTS_FIELD_STYLE=canonical → dotted names; parser đọc được cả hai dạng", async () => {
    freezeDate()
    process.env.OPENAI_ADS_INSIGHTS_FIELD_STYLE = "canonical"
    try {
      route("get", "/ad_account/insights", fx.insightsCampaignDaily)
      await getReport(makeCtx(), baseQuery)
      expect(calls[0]!.url.searchParams.getAll("fields[]")).toEqual(expect.arrayContaining(["campaign.id", "campaign.spend"]))
    } finally {
      delete process.env.OPENAI_ADS_INSIGHTS_FIELD_STYLE
    }
    expect(normalizeInsightRow({ campaign_spend: "1.5", clicks: 3 }, "campaign")).toMatchObject({ spend: 1.5, clicks: 3, link_clicks: 3 })
    expect(normalizeInsightRow({ "campaign.spend": 2, "campaign.clicks": 4 }, "campaign")).toMatchObject({ spend: 2, clicks: 4, link_clicks: 4 })
  })

  it("until ở tương lai → kẹp về hôm nay + cảnh báo số liệu hôm nay chưa chốt", async () => {
    freezeDate()
    route("get", "/ad_account/insights", fx.insightsCampaignDaily)
    const page = await getReport(makeCtx(), { ...baseQuery, dateRange: { from: "2026-09-28", to: "2026-10-09" } })
    const tr = JSON.parse(calls[0]!.url.searchParams.getAll("time_ranges[]")[0]!)
    expect(tr.until).toBe("2026-10-02")
    expect(page.warnings.join(" ")).toMatch(/tương lai/)
    expect(page.warnings.join(" ")).toMatch(/chưa chốt/)
  })

  it("chuẩn hoá: spend/cpc/cpm/cpa giữ đơn vị chính, ctr ×100, conversion_value & roas, null giữ null", async () => {
    freezeDate()
    route("get", "/ad_account/insights", fx.insightsCampaignDaily)
    const page = await getReport(makeCtx(), baseQuery)
    expect(page.currency).toBe("USD")
    expect(page.timezone).toBe("America/New_York")
    const [d1, d2] = page.rows
    expect(d1!.date).toBe("2026-09-01")
    expect(d1!.campaignId).toBe("cmpn_101")
    expect(d1!.campaignName).toBe("Spring launch")
    expect(d1!.status).toBe("active")
    expect(d1!.metrics.spend).toBe(18.42)
    expect(d1!.metrics.ctr).toBe(4)
    expect(d1!.metrics.cpc).toBe(0.38375)
    expect(d1!.metrics.cpm).toBe(15.35)
    expect(d1!.metrics.conversions).toBe(3)
    expect(d1!.metrics.cpa).toBe(6.14)
    expect(d1!.metrics.conversion_value).toBe(120.5)
    expect(d1!.metrics.roas).toBe(6.5418)
    expect(d1!.metrics.reach).toBeNull()
    expect(d2!.metrics.cpa).toBeNull()
    expect(d2!.metrics.conversion_value).toBeNull()
    expect(d2!.metrics.roas).toBeNull()
    expect(d2!.metrics.spend).toBe(0)
  })

  it("đọc được cả khoá phẳng, khoá có chấm và khoá theo cấp", () => {
    const m = normalizeInsightRow({ "campaign.impressions": 10, campaign_clicks: 2, spend: "1.5", ctr: 0.2 }, "campaign")
    expect(m.impressions).toBe(10)
    expect(m.clicks).toBe(2)
    expect(m.spend).toBe(1.5)
    expect(m.ctr).toBe(20)
  })

  it("phân trang: has_more + last_id → nextCursor; cursor gửi lại thành after=last_id", async () => {
    freezeDate()
    route("get", "/ad_account/insights", fx.insightsCampaignDaily)
    const page = await getReport(makeCtx(), baseQuery)
    expect(page.nextCursor).toBeTruthy()
    route("get", "/ad_account/insights", clone(fx.insightsCampaignDaily, { has_more: false }))
    const page2 = await getReport(makeCtx(), { ...baseQuery, cursor: page.nextCursor })
    expect(calls[1]!.url.searchParams.get("after")).toBe(fx.insightsCampaignDaily.last_id)
    expect(page2.nextCursor).toBeNull()
  })

  it("lọc id/trạng thái gửi filters[] JSON", async () => {
    freezeDate()
    route("get", "/ad_account/insights", clone(fx.insightsCampaignDaily, { has_more: false }))
    await getReport(makeCtx(), { ...baseQuery, level: "ad", filters: { campaignIds: ["cmpn_101"], statuses: ["active", "rejected"] } })
    const filters = calls[0]!.url.searchParams.getAll("filters[]").map((f) => JSON.parse(f))
    expect(filters).toEqual(
      expect.arrayContaining([
        { field: "campaign.id", operator: "IN", value: ["cmpn_101"] },
        { field: "ad.status", operator: "IN", value: ["active"] },
        { field: "ad.review_status", operator: "IN", value: ["rejected"] },
      ])
    )
  })

  it("quá 365 ngày lịch sử → cắt khoảng + cảnh báo; ngày tương lai → cắt về hôm nay", async () => {
    freezeDate()
    route("get", "/ad_account/insights", clone(fx.insightsCampaignDaily, { has_more: false }))
    const page = await getReport(makeCtx(), { ...baseQuery, metrics: "basic", dateRange: { from: "2025-01-01", to: "2026-10-10" } })
    const tr = JSON.parse(calls[0]!.url.searchParams.getAll("time_ranges[]")[0]!)
    expect(tr.since).toBe("2025-10-03")
    expect(tr.until).toBe("2026-10-02")
    expect(page.warnings.join(" ")).toContain("365")
    expect(page.warnings.join(" ")).toContain("tương lai")
  })

  it("OPENAI_ADS_INSIGHTS_FIELD_STYLE=flat gửi tên phẳng", async () => {
    freezeDate()
    process.env.OPENAI_ADS_INSIGHTS_FIELD_STYLE = "flat"
    route("get", "/ad_account/insights", json(clone(fx.insightsCampaignDaily, { has_more: false })))
    await getReport(makeCtx(), baseQuery)
    const fields = calls[0]!.url.searchParams.getAll("fields[]")
    expect(fields).toEqual(expect.arrayContaining(["readable_time", "campaign_id", "campaign_name", "impressions", "spend", "conversions"]))
    expect(fields.some((f) => f.includes("."))).toBe(false)
  })

  it("level keyword → unsupported", async () => {
    await expect(getReport(makeCtx(), { ...baseQuery, level: "keyword" })).rejects.toMatchObject({ code: "unsupported" })
  })
})
