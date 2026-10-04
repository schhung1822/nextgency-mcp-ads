import { describe, expect, it } from "vitest"
import {
  assertRange,
  daysBetweenInclusive,
  resolvePreset,
  splitRange,
  todayInTz,
} from "./dates"

// 2026-10-01 18:30 UTC = 2026-10-02 01:30 in Asia/Ho_Chi_Minh
const NOW = new Date("2026-10-01T18:30:00Z")

describe("dates", () => {
  it("uses the account time zone for 'today'", () => {
    expect(todayInTz("Asia/Ho_Chi_Minh", NOW)).toBe("2026-10-02")
    expect(todayInTz("America/Los_Angeles", NOW)).toBe("2026-10-01")
  })
  it("resolves presets", () => {
    expect(resolvePreset("yesterday", "Asia/Ho_Chi_Minh", NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-01",
    })
    expect(resolvePreset("last_7d", "Asia/Ho_Chi_Minh", NOW)).toEqual({
      from: "2026-09-25",
      to: "2026-10-01",
    })
    expect(resolvePreset("this_month", "Asia/Ho_Chi_Minh", NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-02",
    })
    expect(resolvePreset("last_month", "Asia/Ho_Chi_Minh", NOW)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    })
  })
  it("splits long ranges into windows", () => {
    const parts = splitRange({ from: "2026-01-01", to: "2026-03-15" }, 30)
    expect(parts[0]).toEqual({ from: "2026-01-01", to: "2026-01-30" })
    expect(parts.at(-1)!.to).toBe("2026-03-15")
    expect(parts.reduce((n, p) => n + daysBetweenInclusive(p), 0)).toBe(74)
  })
  it("validates ranges", () => {
    expect(() =>
      assertRange({ from: "2026-02-30", to: "2026-03-01" })
    ).toThrow()
    expect(() =>
      assertRange({ from: "2026-03-02", to: "2026-03-01" })
    ).toThrow()
    expect(assertRange({ from: "2026-03-01", to: "2026-03-01" })).toBeTruthy()
  })
})
