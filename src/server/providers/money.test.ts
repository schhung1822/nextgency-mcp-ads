import { describe, expect, it } from "vitest"
import {
  fromMetaMinor,
  fromMicros,
  metaCurrencyOffset,
  roundMoney,
  toMetaMinor,
  toMicros,
} from "./money"

describe("Meta currency offset", () => {
  it("VND has offset 1 (50.000đ stays 50000)", () => {
    expect(metaCurrencyOffset("VND")).toBe(1)
    expect(toMetaMinor(50_000, "VND")).toBe(50_000)
    expect(fromMetaMinor("50000", "VND")).toBe(50_000)
  })
  it("USD has offset 100", () => {
    expect(toMetaMinor(12.5, "USD")).toBe(1250)
    expect(fromMetaMinor(1250, "usd")).toBe(12.5)
  })
  it("rejects negative / NaN", () => {
    expect(() => toMetaMinor(-1, "USD")).toThrow()
    expect(() => toMetaMinor(Number.NaN, "USD")).toThrow()
  })
  it("returns null for empty values", () => {
    expect(fromMetaMinor(null, "USD")).toBeNull()
    expect(fromMetaMinor("", "USD")).toBeNull()
  })
})

describe("micros", () => {
  it("converts without float drift", () => {
    expect(toMicros(0.1)).toBe("100000")
    expect(toMicros(12.34)).toBe("12340000")
    expect(toMicros(1_000_000)).toBe("1000000000000")
  })
  it("parses strings and bigint", () => {
    expect(fromMicros("12340000")).toBe(12.34)
    expect(fromMicros(BigInt(500_000))).toBe(0.5)
    expect(fromMicros(null)).toBeNull()
  })
})

describe("roundMoney", () => {
  it("rounds zero-decimal currencies to integers", () => {
    expect(roundMoney(1234.56, "VND")).toBe(1235)
    expect(roundMoney(1234.567, "USD")).toBe(1234.57)
  })
})
