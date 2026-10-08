import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import type { ReportQuery } from "../types"
import { __clearTokenCache } from "./auth"
import { decodeCursor, encodeCursor, slicePage } from "./cursor"
import { buildReportQuery, freshnessWarnings, getReport, normalizeMetrics } from "./report"
import { isSearch, mockFetch, providerCtx, saCredentials, viMessage } from "./__fixtures__/mock-fetch"

const base: ReportQuery = {
  level: "campaign",
  dateRange: { from: "2026-09-01", to: "2026-09-30" },
  granularity: "day",
  metrics: "basic",
  limit: 50,
}

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => vi.unstubAllGlobals())

describe("buildReportQuery", () => {
  it("warns that REMOVED objects are excluded by default (not with includeDeleted / at account level)", () => {
    expect(buildReportQuery(base).warnings.join(" ")).toMatch(/REMOVED/)
    const inc = buildReportQuery({ ...base, filters: { includeDeleted: true } })
    expect(inc.warnings.join(" ")).not.toMatch(/REMOVED/)
    expect(inc.query).not.toContain("!= 'REMOVED'")
    expect(buildReportQuery({ ...base, level: "account" }).warnings.join(" ")).not.toMatch(/REMOVED/)
  })

  it("campaign by day uses segments.date BETWEEN and orders by date", () => {
    const { query } = buildReportQuery(base)
    expect(query).toContain("FROM campaign")
    expect(query).toContain("segments.date,")
    expect(query).toContain("WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-30' AND campaign.status != 'REMOVED'")
    expect(query).toMatch(/ORDER BY segments\.date$/)
    expect(query).toContain("metrics.cost_micros")
    expect(query).not.toContain("metrics.conversions")
  })

  it("total granularity filters by date without selecting it", () => {
    const { query } = buildReportQuery({ ...base, granularity: "total" })
    expect(query).not.toMatch(/SELECT .*segments\.date.* FROM/)
    expect(query).toContain("segments.date BETWEEN")
    expect(query).not.toContain("ORDER BY")
  })

  it("maps levels to resources", () => {
    expect(buildReportQuery({ ...base, level: "account" }).query).toContain("FROM customer")
    expect(buildReportQuery({ ...base, level: "ad_group" }).query).toContain("FROM ad_group ")
    expect(buildReportQuery({ ...base, level: "ad" }).query).toContain("FROM ad_group_ad")
    const kw = buildReportQuery({ ...base, level: "keyword", metrics: "all" }).query
    expect(kw).toContain("FROM keyword_view")
    expect(kw).not.toContain("video_trueview_views")
  })

  it("adds conversion/video metrics by preset (v22+ video_trueview_views)", () => {
    expect(buildReportQuery({ ...base, metrics: "conversion" }).query).toContain("metrics.conversions_value, metrics.cost_per_conversion")
    const v = buildReportQuery({ ...base, metrics: "video" }).query
    expect(v).toContain("metrics.video_trueview_views")
    expect(v).not.toContain("metrics.video_views")
  })

  it("applies id/status/name filters safely", () => {
    const { query } = buildReportQuery({
      ...base,
      level: "ad",
      filters: { campaignIds: ["111"], adGroupIds: ["222"], adIds: ["222~333"], statuses: ["paused"], nameContains: "Sale' OR '1'='1" },
    })
    expect(query).toContain("campaign.id IN (111)")
    expect(query).toContain("ad_group.id IN (222)")
    expect(query).toContain("ad_group_ad.ad.id IN (333)")
    expect(query).toContain("ad_group_ad.status IN ('PAUSED')")
    expect(query).toContain("ad_group_ad.ad.name LIKE '%Sale\\' OR \\'1\\'=\\'1%'")
  })

  it("rejects non-digit ids and bad dates", () => {
    expect(() => buildReportQuery({ ...base, filters: { campaignIds: ["1) OR (1=1"] } })).toThrow()
    expect(() => buildReportQuery({ ...base, dateRange: { from: "2026-09-31", to: "2026-10-01" } })).toThrow()
    expect(() => buildReportQuery({ ...base, dateRange: { from: "2026-10-02", to: "2026-10-01" } })).toThrow()
  })
})

describe("normalizeMetrics", () => {
  it("converts micros to major units, ctr to %, computes roas", () => {
    const row = {
      metrics: {
        impressions: "10000",
        clicks: "250",
        ctr: 0.025,
        averageCpc: 4938240,
        averageCpm: 123456000,
        costMicros: "1234560000",
        conversions: 12.5,
        conversionsValue: 2469.12,
        costPerConversion: 98764800,
      },
    }
    const m = normalizeMetrics(row, "campaign", "conversion")
    expect(m.spend).toBeCloseTo(1234.56, 6)
    expect(m.cpc).toBeCloseTo(4.93824, 6)
    expect(m.cpm).toBeCloseTo(123.456, 6)
    expect(m.ctr).toBeCloseTo(2.5, 6)
    expect(m.cpa).toBeCloseTo(98.7648, 6)
    expect(m.roas).toBeCloseTo(2, 6)
    expect(m.link_clicks).toBe(250)
    expect(m.reach).toBeNull()
    expect(m.video_views).toBeNull()
  })

  it("defaults absent selected metrics to 0 and leaves non-applicable ones null", () => {
    const m = normalizeMetrics({ metrics: {} }, "keyword", "all")
    expect(m.spend).toBe(0)
    expect(m.impressions).toBe(0)
    expect(m.conversions).toBe(0)
    expect(m.roas).toBeNull() // no spend → undefined ratio
    expect(m.video_views).toBeNull() // not queried for keyword_view
    expect(m.frequency).toBeNull()
  })
})

describe("cursor", () => {
  const q = "SELECT campaign.id FROM campaign"
  it("slices a Google page and points to the next token at the end", () => {
    const rows = Array.from({ length: 5 }, (_, i) => i)
    const p1 = slicePage(rows, { pt: null, off: 0 }, "NEXT", 2, q)
    expect(p1.items).toEqual([0, 1])
    expect(decodeCursor(p1.nextCursor, q)).toEqual({ pt: null, off: 2 })
    const p3 = slicePage(rows, { pt: null, off: 4 }, "NEXT", 2, q)
    expect(p3.items).toEqual([4])
    expect(decodeCursor(p3.nextCursor, q)).toEqual({ pt: "NEXT", off: 0 })
    expect(slicePage(rows, { pt: null, off: 4 }, null, 2, q).nextCursor).toBeNull()
  })

  it("rejects tampered cursors and cursors from another query", () => {
    expect(() => decodeCursor("garbage!!", q)).toThrow()
    expect(viMessage(() => decodeCursor(encodeCursor("T", 0, q), `${q} WHERE campaign.id = 1`))).toMatch(/không khớp/)
  })
})

describe("getReport", () => {
  it("pages through results with an opaque cursor wrapping pageToken", async () => {
    const m = mockFetch()
    const row = (id: number) => ({ campaign: { id: String(id), name: `C${id}`, status: "ENABLED" }, segments: { date: "2026-09-01" }, metrics: { costMicros: "1000000" } })
    m.on((c) => isSearch(c) && !(c.body as { pageToken?: string }).pageToken, { body: { results: [row(1), row(2), row(3)], nextPageToken: "PAGE2" } })
    m.on((c) => isSearch(c) && (c.body as { pageToken?: string }).pageToken === "PAGE2", { body: { results: [row(4)] } })
    const ctx = providerCtx(saCredentials())
    const p1 = await getReport(ctx, { ...base, limit: 2 })
    expect(p1.rows.map((r) => r.campaignId)).toEqual(["1", "2"])
    expect(p1.rows[0]!.metrics.spend).toBe(1)
    expect(p1.rows[0]!.date).toBe("2026-09-01")
    expect(p1.rows[0]!.status).toBe("active")
    expect(p1.currency).toBe("VND")
    const p2 = await getReport(ctx, { ...base, limit: 2, cursor: p1.nextCursor })
    expect(p2.rows.map((r) => r.campaignId)).toEqual(["3"])
    const p3 = await getReport(ctx, { ...base, limit: 2, cursor: p2.nextCursor })
    expect(p3.rows.map((r) => r.campaignId)).toEqual(["4"])
    expect(p3.nextCursor).toBeNull()
    expect(m.api().every((c) => !("pageSize" in (c.body as object)))).toBe(true)
  })

  it("ad rows use composite AG~AD ids", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [{ campaign: { id: "1" }, adGroup: { id: "22", name: "AG" }, adGroupAd: { status: "PAUSED", ad: { id: "333", type: "RESPONSIVE_SEARCH_AD" } }, metrics: {} }] } })
    const page = await getReport(providerCtx(saCredentials()), { ...base, level: "ad", granularity: "total" })
    expect(page.rows[0]!.adId).toBe("22~333")
    expect(page.rows[0]!.status).toBe("paused")
  })
})

describe("freshness warnings", () => {
  it("warns that recent conversions are still changing", () => {
    const now = new Date("2026-10-02T05:00:00Z")
    const w = freshnessWarnings({ ...base, metrics: "conversion", dateRange: { from: "2026-09-25", to: "2026-10-01" } }, "Asia/Ho_Chi_Minh", now)
    expect(w.join(" ")).toMatch(/chuyển đổi/)
    expect(freshnessWarnings({ ...base, metrics: "basic", dateRange: { from: "2026-09-01", to: "2026-09-10" } }, "Asia/Ho_Chi_Minh", now)).toEqual([])
  })
})
