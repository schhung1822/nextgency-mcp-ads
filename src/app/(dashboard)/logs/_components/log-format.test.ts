import { describe, expect, it } from "vitest"

import { formatLogTime, formatLogTimeParts } from "./log-format"

describe("formatLogTimeParts", () => {
  it("splits the Asia/Ho_Chi_Minh timestamp into time (with seconds) and date", () => {
    // 11:27:53 UTC = 18:27:53 in UTC+7
    expect(formatLogTimeParts("2026-10-02T11:27:53.000Z")).toEqual({
      time: "18:27:53",
      date: "02/10/2026",
    })
  })

  it("rolls over midnight in the display time zone", () => {
    expect(formatLogTimeParts("2026-09-30T17:05:09.000Z")).toEqual({
      time: "00:05:09",
      date: "01/10/2026",
    })
  })

  it("stays consistent with formatLogTime", () => {
    const iso = "2026-01-15T03:04:05.000Z"
    const { time, date } = formatLogTimeParts(iso)
    expect(`${time} ${date}`).toBe(formatLogTime(iso))
  })
})
