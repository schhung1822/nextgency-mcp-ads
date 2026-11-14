import { describe, expect, it } from "vitest"
import { maskContactInfo } from "./pii-mask"

describe("maskContactInfo", () => {
  it("masks Vietnamese phone numbers in the usual spellings, keeping the last 3 digits", () => {
    const cases: [string, string][] = [
      ["sđt em 0912345678 nha", "sđt em [SĐT ẩn …678] nha"],
      ["0912 345 678", "[SĐT ẩn …678]"],
      ["0912.345.678.", "[SĐT ẩn …678]."],
      ["gọi 091-234-5678", "gọi [SĐT ẩn …678]"],
      ["+84 912 345 678", "[SĐT ẩn …678]"],
      ["84912345678", "[SĐT ẩn …678]"],
      // landlines are masked too (0 + area code + number)
      ["số bàn 028 3822 1234", "số bàn [SĐT ẩn …234]"],
      ["zalo:0987654321,0912345678", "zalo:[SĐT ẩn …321],[SĐT ẩn …678]"],
    ]
    for (const [raw, want] of cases) expect(maskContactInfo(raw).text, raw).toBe(want)
    expect(maskContactInfo("a 0912345678 b 0987654321").phones).toBe(2)
  })

  it("masks international numbers written with +", () => {
    expect(maskContactInfo("call +1 415 555 0101").text).toBe("call [SĐT ẩn …101]")
  })

  it("masks e-mail addresses", () => {
    const r = maskContactInfo("mail: lan.nguyen+shop@gmail.com hoặc a_b@cty.com.vn.")
    expect(r.text).toBe("mail: [email ẩn] hoặc [email ẩn].")
    expect(r.emails).toBe(2)
  })

  it("leaves prices, quantities, dates, order codes and short numbers alone", () => {
    for (const s of [
      "Giá 1.500.000đ",
      "giảm 250000 còn 1290000",
      "đơn #12345678",
      "ngày 12/11/2026 lúc 10:30",
      "size 39, 2 đôi",
      "mã 123456789012345",
    ]) {
      const r = maskContactInfo(s)
      expect(r.text, s).toBe(s)
      expect(r.phones + r.emails, s).toBe(0)
    }
  })
})
