import { describe, expect, it } from "vitest"
import {
  LOG_MAX_RANGE_DAYS,
  logQueryToSearchParams,
  parseLogDateRange,
  parseLogQuery,
  resolveLogTimeRange,
  zonedDayStart,
} from "./logs"

const MCP_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

describe("parseLogQuery", () => {
  it("mặc định tab MCP, không khoảng ngày (24 giờ qua)", () => {
    const q = parseLogQuery({})
    expect(q.tab).toBe("mcp")
    expect(q.range).toBeNull()
    expect(q.mcp).toEqual([])
  })

  it("bỏ giá trị không hợp lệ và trùng lặp", () => {
    const q = parseLogQuery(
      new URLSearchParams({
        tab: "staff",
        mcp: `${MCP_ID},not-a-uuid,${MCP_ID}`,
        platform: "meta,myspace",
        status: "error,boom",
        group: "auth,nope",
        result: "failure",
        writes: "1",
        q: "  hết hạn  ",
      })
    )
    expect(q.tab).toBe("staff")
    expect(q.mcp).toEqual([MCP_ID])
    expect(q.platform).toEqual(["meta"])
    expect(q.status).toEqual(["error"])
    expect(q.group).toEqual(["auth"])
    expect(q.result).toEqual(["failure"])
    expect(q.writes).toBe(true)
    expect(q.q).toBe("hết hạn")
  })

  it("tab lạ quay về mcp; mảng giá trị được nối", () => {
    const q = parseLogQuery({ tab: "admin", tool: ["meta_list_campaigns", "ads_get_report"] })
    expect(q.tab).toBe("mcp")
    expect(q.tool).toEqual(["meta_list_campaigns", "ads_get_report"])
  })

  it("round-trip qua search params chỉ giữ bộ lọc của tab hiện tại", () => {
    const q = parseLogQuery({ mcp: MCP_ID, actor: "u1", from: "2026-10-01", to: "2026-10-02", writes: "1" })
    const sp = logQueryToSearchParams(q)
    expect(sp.get("mcp")).toBe(MCP_ID)
    expect(sp.get("actor")).toBeNull()
    expect(sp.get("from")).toBe("2026-10-01")
    expect(parseLogQuery(sp)).toEqual({ ...q, actor: [] })
  })
})

describe("parseLogDateRange", () => {
  it("sắp lại thứ tự và từ chối ngày sai", () => {
    expect(parseLogDateRange("2026-10-02", "2026-09-01")).toEqual({ from: "2026-09-01", to: "2026-10-02" })
    expect(parseLogDateRange("2026-02-30", "2026-03-01")).toBeNull()
    expect(parseLogDateRange("2026-10-01", undefined)).toBeNull()
  })

  it("từ chối khoảng dài hơn giới hạn", () => {
    expect(parseLogDateRange("2024-01-01", "2026-01-01")).toBeNull()
    const to = new Date(Date.UTC(2026, 0, 1) + (LOG_MAX_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
    expect(parseLogDateRange("2026-01-01", to)).not.toBeNull()
  })
})

describe("resolveLogTimeRange", () => {
  it("mặc định là 24 giờ gần nhất", () => {
    const now = new Date("2026-10-02T05:00:00Z")
    const r = resolveLogTimeRange(null, now)
    expect(r.until.toISOString()).toBe("2026-10-02T05:00:00.000Z")
    expect(r.since.toISOString()).toBe("2026-10-01T05:00:00.000Z")
  })

  it("ngày theo giờ Việt Nam: [00:00 from, 00:00 ngày sau to)", () => {
    const r = resolveLogTimeRange({ from: "2026-10-01", to: "2026-10-02" })
    expect(r.since.toISOString()).toBe("2026-09-30T17:00:00.000Z")
    expect(r.until.toISOString()).toBe("2026-10-02T17:00:00.000Z")
  })

  it("zonedDayStart xử lý múi giờ có DST", () => {
    expect(zonedDayStart("2026-07-01", "Europe/Berlin").toISOString()).toBe("2026-06-30T22:00:00.000Z")
    expect(zonedDayStart("2026-01-15", "Europe/Berlin").toISOString()).toBe("2026-01-14T23:00:00.000Z")
  })
})
