import { describe, expect, it } from "vitest"

import { checkViNumber, parseViAmount } from "./vi-amount"

const value = (raw: string) => {
  const r = parseViAmount(raw)
  return r.ok ? r.value : r.error
}

describe("parseViAmount", () => {
  it("reads plain digits", () => {
    expect(value("200000")).toBe(200000)
    expect(value("0")).toBe(0)
    expect(value("5")).toBe(5)
  })

  it("reads thousands separators (dot or comma, one kind only)", () => {
    expect(value("200.000")).toBe(200000)
    expect(value("1.000.000")).toBe(1000000)
    expect(value("200,000")).toBe(200000)
    expect(value("1,000,000")).toBe(1000000)
    expect(value("80.000")).toBe(80000)
  })

  it("reads decimals with one separator and 1-2 digits", () => {
    expect(value("12,5")).toBe(12.5)
    expect(value("12.5")).toBe(12.5)
    expect(value("2,75")).toBe(2.75)
    expect(value("0.75")).toBe(0.75)
  })

  it("ignores spaces (also non-breaking)", () => {
    expect(value(" 200 000 ")).toBe(200000)
    expect(value("1 000 000")).toBe(1000000)
    expect(value("200 . 000")).toBe(200000)
  })

  it("rejects empty and malformed input", () => {
    expect(value("")).toBe("empty")
    expect(value("   ")).toBe("empty")
    for (const bad of [
      "-5",
      "abc",
      "200k",
      "1.000,50",
      "1,000.5",
      "1.000.00",
      "2.5.0",
      "1000.000",
      "12,345,67",
      "12.",
      ".5",
      "1,2345",
      "1e5",
      "1.000,000",
    ])
      expect(value(bad), bad).toBe("format")
  })
})

describe("checkViNumber", () => {
  it("accepts values in range", () => {
    expect(checkViNumber("5", { min: 1, max: 20, integer: true })).toEqual({
      ok: true,
      value: 5,
    })
    expect(checkViNumber("200.000", { min: 0, minExclusive: true })).toEqual({
      ok: true,
      value: 200000,
    })
  })

  it("reports out-of-range values instead of clamping", () => {
    expect(checkViNumber("0", { min: 1, max: 20 })).toMatchObject({
      ok: false,
      error: "min",
    })
    expect(checkViNumber("25", { min: 1, max: 20 })).toMatchObject({
      ok: false,
      error: "max",
      value: 25,
    })
    expect(checkViNumber("0", { min: 0, minExclusive: true })).toMatchObject({
      ok: false,
      error: "min",
    })
    expect(checkViNumber("2,5", { integer: true })).toMatchObject({
      ok: false,
      error: "integer",
    })
  })

  it("passes parse errors through", () => {
    expect(checkViNumber("", { min: 1 })).toEqual({ ok: false, error: "empty" })
    expect(checkViNumber("x", { min: 1 })).toEqual({
      ok: false,
      error: "format",
    })
  })
})
