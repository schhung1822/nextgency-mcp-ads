import { describe, expect, it } from "vitest"

import {
  addDays,
  detectDatePreset,
  formatDateRangeLabel,
  isIsoDate,
  localDateToIso,
  normalizeRange,
  resolveDatePreset,
  todayIn,
} from "./date-range"

// 2026-10-01 18:30 UTC = 2026-10-02 01:30 in Asia/Ho_Chi_Minh
const NOW = new Date("2026-10-01T18:30:00Z")
const VN = { now: NOW, timeZone: "Asia/Ho_Chi_Minh" }

describe("date-range presets", () => {
  it("decides 'today' in the given time zone", () => {
    expect(todayIn("Asia/Ho_Chi_Minh", NOW)).toBe("2026-10-02")
    expect(todayIn("America/Los_Angeles", NOW)).toBe("2026-10-01")
  })

  it("resolves today / yesterday", () => {
    expect(resolveDatePreset("today", VN)).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    })
    expect(resolveDatePreset("yesterday", VN)).toEqual({
      from: "2026-10-01",
      to: "2026-10-01",
    })
  })

  it("last 7/30 days exclude today by default (Ads Manager convention)", () => {
    expect(resolveDatePreset("last7", VN)).toEqual({
      from: "2026-09-25",
      to: "2026-10-01",
    })
    expect(resolveDatePreset("last30", VN)).toEqual({
      from: "2026-09-02",
      to: "2026-10-01",
    })
  })

  it("last 7/30 days can include today", () => {
    expect(resolveDatePreset("last7", { ...VN, includeToday: true })).toEqual({
      from: "2026-09-26",
      to: "2026-10-02",
    })
    expect(resolveDatePreset("last30", { ...VN, includeToday: true })).toEqual({
      from: "2026-09-03",
      to: "2026-10-02",
    })
  })

  it("resolves this month / last month (incl. year boundary)", () => {
    expect(resolveDatePreset("thisMonth", VN)).toEqual({
      from: "2026-10-01",
      to: "2026-10-02",
    })
    expect(resolveDatePreset("lastMonth", VN)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    })
    const jan = {
      now: new Date("2027-01-15T05:00:00Z"),
      timeZone: "Asia/Ho_Chi_Minh",
    }
    expect(resolveDatePreset("lastMonth", jan)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    })
    const mar = {
      now: new Date("2028-03-10T05:00:00Z"),
      timeZone: "Asia/Ho_Chi_Minh",
    }
    expect(resolveDatePreset("lastMonth", mar)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    })
  })

  it("detects presets back from a range", () => {
    expect(detectDatePreset({ from: "2026-09-25", to: "2026-10-01" }, VN)).toBe(
      "last7"
    )
    expect(detectDatePreset({ from: "2026-10-02", to: "2026-10-02" }, VN)).toBe(
      "today"
    )
    expect(detectDatePreset({ from: "2026-08-01", to: "2026-08-05" }, VN)).toBe(
      "custom"
    )
    expect(detectDatePreset(null, VN)).toBe("custom")
  })

  it("formats labels", () => {
    expect(
      formatDateRangeLabel({ from: "2026-10-01", to: "2026-10-01" }, VN)
    ).toBe("Hôm qua")
    expect(
      formatDateRangeLabel({ from: "2026-08-01", to: "2026-08-05" }, VN)
    ).toBe("01/08/2026 – 05/08/2026")
    expect(
      formatDateRangeLabel({ from: "2026-08-03", to: "2026-08-03" }, VN)
    ).toBe("03/08/2026")
    expect(formatDateRangeLabel(null, VN)).toBe("Chọn khoảng thời gian")
  })
})

describe("date-range helpers", () => {
  it("adds days across month/year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
  })

  it("validates and normalises ranges", () => {
    expect(isIsoDate("2026-02-30")).toBe(false)
    expect(isIsoDate("2026-02-28")).toBe(true)
    expect(normalizeRange("2026-10-05", "2026-10-01")).toEqual({
      from: "2026-10-01",
      to: "2026-10-05",
    })
    expect(normalizeRange("bad", "2026-10-01")).toBeNull()
  })

  it("converts local calendar dates without timezone drift", () => {
    expect(localDateToIso(new Date(2026, 0, 5))).toBe("2026-01-05")
  })
})
