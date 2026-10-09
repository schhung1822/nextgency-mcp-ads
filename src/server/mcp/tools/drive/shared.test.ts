import { describe, expect, it } from "vitest"
import { driveRefForLog } from "../../log-args"
import type { GrantAccount, McpGrant } from "../../types"
import { jobErrorText, uploadLogArgs } from "../common/upload-media"
import { updatedAtStamp } from "./sheet-update-rows"
import {
  canonicalLinkCell,
  foldText,
  linkTokens,
  matchAccount,
  neutralizeFormula,
  normalizePlatform,
  sanitizeCell,
  SHEET_ID_RE,
} from "./shared"

const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"

describe("drive tool helpers", () => {
  it("canonicalLinkCell: Drive links → file ids (no resource key / query), other URLs → host + path, idempotent", () => {
    const cell = `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-abc\n https://example.com/a/b?sig=1 , khác`
    const c = canonicalLinkCell(cell)
    expect(c).toBe(`${FILE}\nhttps://example.com/a/b`)
    expect(canonicalLinkCell(c)).toBe(c)
    expect(canonicalLinkCell(`https://drive.google.com/open?id=${FILE}`)).toBe(
      FILE
    )
    expect(canonicalLinkCell("")).toBe("")
  })

  it("linkTokens keeps URLs and long Drive ids only (ordinary words are not links)", () => {
    expect(
      linkTokens(`xem file creative_tuan41 ${FILE}; https://x.test/y`)
    ).toEqual([FILE, "https://x.test/y"])
  })

  it("sanitizeCell strips control / bidi characters and caps the length", () => {
    expect(sanitizeCell("a‮b\u0007c\r\nd")).toBe("abc\nd")
    expect(sanitizeCell("x".repeat(3000))).toHaveLength(2000)
  })

  it("normalizePlatform maps the names people type", () => {
    expect(
      ["Facebook", "FB", "meta", "Instagram"].map(normalizePlatform)
    ).toEqual(["meta", "meta", "meta", "meta"])
    expect(["TikTok", "Tik Tok"].map(normalizePlatform)).toEqual([
      "tiktok",
      "tiktok",
    ])
    expect(
      ["Google", "YouTube", "Google Ads", "google_ads"].map(normalizePlatform)
    ).toEqual(Array(4).fill("google_ads"))
    expect(["OpenAI", "ChatGPT"].map(normalizePlatform)).toEqual([
      "openai_ads",
      "openai_ads",
    ])
    expect(normalizePlatform("MySpace")).toBeNull()
    expect(normalizePlatform("")).toBeNull()
  })

  it("matchAccount: by external id (Meta act_ optional) then by folded name; ambiguous names are refused", () => {
    const acc = (
      platform: GrantAccount["platform"],
      externalId: string,
      name: string
    ): GrantAccount => ({
      id: externalId,
      connectionId: "c",
      platform,
      externalId,
      name,
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
    })
    const grant = {
      accounts: [
        acc("meta", "act_123", "Shop Hà Nội"),
        acc("tiktok", "700", "Shop Hà Nội"),
        acc("meta", "act_9", "Khác"),
      ],
    } as McpGrant
    expect(matchAccount(grant, "meta", "123")).toMatchObject({
      ok: true,
      account: { externalId: "act_123" },
    })
    expect(matchAccount(grant, "tiktok", "shop ha noi")).toMatchObject({
      ok: true,
      account: { externalId: "700" },
    })
    expect(matchAccount(grant, null, "Shop Hà Nội")).toEqual({
      ok: false,
      code: "account_ambiguous",
    })
    expect(matchAccount(grant, "meta", "act_404")).toEqual({
      ok: false,
      code: "account_not_in_scope",
    })
  })

  it("foldText removes diacritics (đ → d) and case", () => {
    expect(foldText("  Đã   Lên ")).toBe("da len")
  })

  it("logged upload args keep only the Drive file id and never the ChatGPT link", () => {
    expect(
      driveRefForLog(
        `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-secret`
      )
    ).toBe(FILE)
    expect(driveRefForLog("not a ref")).toBe("[invalid drive ref]")
    expect(driveRefForLog("drf_abcdefghijklmnopqrstuvwxyz0123")).toBe(
      "drf_[redacted]"
    )
    const out = uploadLogArgs({
      drive_file: `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-secret`,
      url: `https://drive.google.com/uc?id=${FILE}&resourcekey=0-secret`,
      file: {
        download_url: "https://files.oaiusercontent.com/x?sig=s",
        file_id: "file-1",
      },
    })
    expect(out).toEqual({
      drive_file: FILE,
      url: FILE,
      file: { download_url: "[redacted]", file_id: "file-1" },
    })
    expect(JSON.stringify(out)).not.toContain("secret")
  })

  it("updatedAtStamp: dd/MM/yyyy HH:mm in Vietnam time + MCP name", () => {
    expect(updatedAtStamp("MCP‮ A", new Date("2026-10-09T01:05:00Z"))).toBe(
      "09/10/2026 08:05 · MCP MCP A"
    )
  })

  it("L7: a note starting like a formula is neutralised; ids written to a sheet must look like ids", () => {
    for (const t of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"])
      expect(neutralizeFormula(t)).toBe(` ${t}`)
    expect(neutralizeFormula("Lỗi: thiếu ảnh")).toBe("Lỗi: thiếu ảnh")
    for (const id of [
      "a1b2c3d4e5",
      "120210000000001",
      "ad-site-i18n-sg/202310115d0d2b",
      "customers/123/adGroupAds/4~5",
      "file_abc-1.x:y",
    ])
      expect(SHEET_ID_RE.test(id), id).toBe(true)
    for (const bad of ["=1+1", "-1", "@x", "a b", "a\nb", "", "x".repeat(201)])
      expect(SHEET_ID_RE.test(bad), bad).toBe(false)
  })

  it("background upload error codes → short Vietnamese text (fallbacks for drive_* / provider_* / unknown)", () => {
    expect(jobErrorText("file_changed")).toContain("thay đổi")
    expect(jobErrorText("interrupted")).toContain("gián đoạn")
    expect(jobErrorText("drive_rate_limited")).toContain("Google Drive")
    expect(jobErrorText("provider_timeout")).toContain("Nền tảng")
    expect(jobErrorText(null)).toBe("Tải lên thất bại.")
  })
})
