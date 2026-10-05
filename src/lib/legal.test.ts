// Public legal pages: operator info fallbacks + the two optional admin settings' validation.
import { describe, expect, it } from "vitest"

import { legal as tl } from "@/lib/i18n/vi/legal"

import {
  LEGAL_PAGES,
  legalContactEmailSchema,
  legalOrgNameSchema,
  legalPageUrl,
  resolveLegalInfo,
} from "./legal"

describe("resolveLegalInfo", () => {
  it("dùng tên đơn vị + email đã cài đặt (đã trim)", () => {
    const info = resolveLegalInfo({
      orgName: "  Công ty TNHH ABC  ",
      contactEmail: " privacy@abc.vn ",
      appDomain: "ads.abc.vn",
      appUrl: "https://ads.abc.vn/",
      retentionMcpMonths: 6,
      retentionStaffMonths: 12,
    })
    expect(info).toEqual({
      orgName: "Công ty TNHH ABC",
      domain: "ads.abc.vn",
      baseUrl: "https://ads.abc.vn",
      contactEmail: "privacy@abc.vn",
      retentionMcpMonths: 6,
      retentionStaffMonths: 12,
    })
  })

  it("chưa cài đặt: tên đơn vị = APP_DOMAIN, không có email", () => {
    const info = resolveLegalInfo({
      orgName: "",
      contactEmail: "",
      appDomain: "ads.abc.vn",
      appUrl: "https://ads.abc.vn",
    })
    expect(info.orgName).toBe("ads.abc.vn")
    expect(info.contactEmail).toBeNull()
  })

  it("APP_DOMAIN trống/localhost: lấy hostname của BETTER_AUTH_URL", () => {
    expect(
      resolveLegalInfo({ appDomain: "", appUrl: "https://mcp.abc.vn" }).orgName
    ).toBe("mcp.abc.vn")
    expect(
      resolveLegalInfo({ appDomain: "localhost", appUrl: "https://mcp.abc.vn" })
        .domain
    ).toBe("mcp.abc.vn")
    expect(
      resolveLegalInfo({ appDomain: null, appUrl: "không phải url" }).domain
    ).toBe("localhost")
  })

  it("không có URL hợp lệ: baseUrl = https://<domain>", () => {
    expect(
      resolveLegalInfo({
        appDomain: "ads.abc.vn",
        appUrl: "javascript:alert(1)",
      }).baseUrl
    ).toBe("https://ads.abc.vn")
    expect(resolveLegalInfo({ appDomain: "ads.abc.vn" }).baseUrl).toBe(
      "https://ads.abc.vn"
    )
  })

  it("bỏ qua giá trị lưu sai (email không hợp lệ, tên có xuống dòng, kiểu lạ)", () => {
    const info = resolveLegalInfo({
      orgName: "ABC\nEvil",
      contactEmail: "not-an-email",
      appDomain: "ads.abc.vn",
    })
    expect(info.orgName).toBe("ads.abc.vn")
    expect(info.contactEmail).toBeNull()
    expect(
      resolveLegalInfo({
        orgName: 42,
        contactEmail: { a: 1 },
        appDomain: "x.vn",
      })
    ).toMatchObject({
      orgName: "x.vn",
      contactEmail: null,
    })
  })

  it("số tháng lưu nhật ký: ngoài 1–24 → mặc định", () => {
    const info = resolveLegalInfo({
      appDomain: "x.vn",
      retentionMcpMonths: 0,
      retentionStaffMonths: "abc",
      defaultRetentionMonths: 4,
    })
    expect(info.retentionMcpMonths).toBe(4)
    expect(info.retentionStaffMonths).toBe(4)
    expect(
      resolveLegalInfo({ appDomain: "x.vn", defaultRetentionMonths: 99 })
        .retentionMcpMonths
    ).toBe(3)
  })
})

describe("legalPageUrl", () => {
  it("ghép origin của URL cấu hình, bỏ path/dấu / thừa", () => {
    expect(legalPageUrl("/privacy", "https://ads.abc.vn/")).toBe(
      "https://ads.abc.vn/privacy"
    )
    expect(legalPageUrl("/terms", "https://ads.abc.vn/some/path")).toBe(
      "https://ads.abc.vn/terms"
    )
  })
  it("URL cấu hình không dùng được → origin của trình duyệt", () => {
    expect(
      legalPageUrl("/data-deletion", undefined, "http://localhost:3000")
    ).toBe("http://localhost:3000/data-deletion")
    expect(legalPageUrl("/data-deletion", "javascript:x", "https://b.vn")).toBe(
      "https://b.vn/data-deletion"
    )
  })
  it("đủ 3 trang công khai", () => {
    expect(LEGAL_PAGES.map((p) => p.path)).toEqual([
      "/privacy",
      "/terms",
      "/data-deletion",
    ])
  })
})

describe("legal settings schemas", () => {
  it("tên đơn vị: rỗng được, tối đa 120 ký tự, không xuống dòng", () => {
    expect(legalOrgNameSchema.safeParse("").success).toBe(true)
    expect(legalOrgNameSchema.safeParse("a".repeat(120)).success).toBe(true)
    expect(legalOrgNameSchema.safeParse("a".repeat(121)).success).toBe(false)
    expect(legalOrgNameSchema.safeParse("ABC\r\nDEF").success).toBe(false)
    expect(legalOrgNameSchema.parse("  ABC  ")).toBe("ABC")
  })
  it("email: rỗng hoặc hợp lệ", () => {
    expect(legalContactEmailSchema.safeParse("").success).toBe(true)
    expect(legalContactEmailSchema.parse(" a@b.vn ")).toBe("a@b.vn")
    expect(legalContactEmailSchema.safeParse("a@b").success).toBe(false)
    expect(legalContactEmailSchema.safeParse("a b@c.vn").success).toBe(false)
    expect(
      legalContactEmailSchema.safeParse("javascript:alert(1)").success
    ).toBe(false)
  })
})

describe("legal texts", () => {
  const info = resolveLegalInfo({
    orgName: "ABC",
    appDomain: "ads.abc.vn",
    retentionMcpMonths: 5,
    retentionStaffMonths: 7,
  })
  it.each(["privacy", "terms", "dataDeletion"] as const)(
    "%s: có bản tiếng Việt + tiếng Anh, có mục liên hệ",
    (key) => {
      for (const lang of ["vi", "en"] as const) {
        const doc = tl.docs[key][lang](info)
        expect(doc.title).toBeTruthy()
        expect(doc.sections.length).toBeGreaterThan(3)
        expect(
          doc.sections.some((s) => s.blocks.some((b) => b.kind === "contact"))
        ).toBe(true)
        expect(JSON.stringify(doc)).toContain("ABC")
      }
    }
  )
  it("số tháng lưu nhật ký thật được đưa vào chính sách", () => {
    const text = JSON.stringify(tl.docs.privacy.vi(info))
    expect(text).toContain("giữ 5 tháng")
    expect(text).toContain("giữ 7 tháng")
    expect(JSON.stringify(tl.docs.dataDeletion.en(info))).toContain(
      "5 and 7 months respectively"
    )
  })
})
