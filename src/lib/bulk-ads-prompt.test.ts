import { describe, expect, it } from "vitest"

import {
  DEFAULT_SHEET_COLUMNS,
  SHEET_STATUS_ALIASES,
  SHEET_WRITABLE_COLUMNS,
} from "@/server/drive/types"

import {
  BULK_SHEET_COLUMNS,
  BULK_SKILL_DESCRIPTION,
  BULK_SKILL_NAME,
  BULK_SYSTEM_COLUMNS,
  BULK_TEMPLATE_ROWS,
  buildBulkAdsPrompt,
  buildBulkAdsRule,
  buildBulkAdsSkillMd,
  buildBulkAdsSkillPrompt,
  buildSheetHeaderTsv,
  buildSheetTemplateCsv,
  clampBatch,
  cleanName,
  connectorLabel,
  DEFAULT_BULK_ADS,
} from "./bulk-ads-prompt"

describe("bulk ads sheet template", () => {
  it("uses exactly the column names the system recognises, in the recommended order", () => {
    expect([...BULK_SHEET_COLUMNS]).toEqual(
      Object.values(DEFAULT_SHEET_COLUMNS)
    )
    expect([...BULK_SYSTEM_COLUMNS]).toEqual(
      SHEET_WRITABLE_COLUMNS.filter((k) => k !== "status").map(
        (k) => DEFAULT_SHEET_COLUMNS[k]
      )
    )
  })

  it("copies the header as tab-separated cells", () => {
    const tsv = buildSheetHeaderTsv()
    expect(tsv.split("\t")).toEqual([...BULK_SHEET_COLUMNS])
    expect(tsv).not.toContain("\n")
  })

  it("builds a UTF-8 BOM CSV with quoted multi-link cells and 14 cells per row", () => {
    const csv = buildSheetTemplateCsv()
    expect(csv.startsWith("﻿Link Drive,Tên creative,")).toBe(true)
    expect(csv.endsWith("\r\n")).toBe(true)
    // a cell holding several links (newline inside) is quoted
    expect(csv).toContain(
      '"https://drive.google.com/file/d/1BcDeFgHiJkLmNoPqRsTuVwXyZ123456/view\nhttps://'
    )
    expect(BULK_TEMPLATE_ROWS).toHaveLength(3)
    for (const row of BULK_TEMPLATE_ROWS)
      expect(row.length).toBeLessThanOrEqual(14)
    // example statuses are values the sheet reader accepts as "pending"
    for (const row of BULK_TEMPLATE_ROWS) {
      const status = row[7] ?? ""
      expect(
        status === "" || SHEET_STATUS_ALIASES.pending.includes(status)
      ).toBe(true)
    }
  })
})

describe("bulk ads prompt builder", () => {
  it("default: sheet-driven platform / account, write-back on, existing campaign asked in chat", () => {
    const rule = buildBulkAdsRule(DEFAULT_BULK_ADS)
    expect(rule).toContain("limit = 5")
    expect(rule).toContain("drive_list_sources")
    expect(rule).toContain('status = "processing"')
    expect(rule).toContain('status = "done"')
    expect(rule).toContain("campaign_link")
    expect(rule).toContain("post_link")
    expect(rule).toContain("row_moved")
    expect(rule).toContain("ads_upload_media với drive_file")
    expect(rule).toContain("ads_get_media_upload")
    expect(rule).toContain("TẠM DỪNG")
    expect(rule).toContain("confirm_token")
    expect(rule).toContain("Không tự tạo chiến dịch")
    expect(rule).toContain("Meta: meta_create_ad")
    expect(rule).toContain("TikTok: tiktok_create_ads")
  })

  it("new structure: one campaign + group per account with the typed budget", () => {
    const rule = buildBulkAdsRule({
      ...DEFAULT_BULK_ADS,
      platform: "tiktok",
      structure: "new",
      campaignName: 'Serum "T10"\nmới',
      dailyBudget: 350000.456,
      currency: "vnd",
    })
    expect(rule).toContain('chiến dịch mới tên "Serum T10 mới"')
    expect(rule).toContain("350000.46 VND")
    expect(rule).toContain(
      "TikTok: tiktok_create_campaign → tiktok_create_adgroup"
    )
    expect(rule).toContain("(tiktok_create_ads)")
    expect(rule).not.toContain("meta_create")
  })

  it("existing structure with names and a fixed account", () => {
    const rule = buildBulkAdsRule({
      ...DEFAULT_BULK_ADS,
      platform: "meta",
      account: "act_123",
      campaignName: "Ra mắt serum",
      adGroupName: "Nữ 25-34",
      sheetName: "Kế hoạch T10",
    })
    expect(rule).toContain('Google Sheet tên "Kế hoạch T10"')
    expect(rule).toContain('tài khoản "act_123"')
    expect(rule).toContain(
      'chiến dịch "Ra mắt serum", nhóm quảng cáo "Nữ 25-34"'
    )
    expect(rule).toContain("luôn là Meta")
  })

  it("write-back off never calls drive_sheet_update_rows", () => {
    const rule = buildBulkAdsRule({ ...DEFAULT_BULK_ADS, writeback: false })
    expect(rule).not.toContain("drive_sheet_update_rows")
    expect(rule).not.toContain("writeback = true")
  })

  it("clamps the batch and cleans names", () => {
    expect(clampBatch(0)).toBe(1)
    expect(clampBatch(99)).toBe(20)
    expect(clampBatch(Number.NaN)).toBe(5)
    expect(cleanName('  a\t"b"\n c ')).toBe("a b c")
    expect(cleanName("x".repeat(300))).toHaveLength(100)
  })

  it("names the connector the user chose (default Ads MCP)", () => {
    expect(buildBulkAdsPrompt(DEFAULT_BULK_ADS)).toMatch(
      /^Dùng connector "Ads MCP" \(Ads MCP\)/
    )
    const custom = { ...DEFAULT_BULK_ADS, connectorName: "Lên QC theo sheet" }
    expect(buildBulkAdsPrompt(custom)).toContain(
      'connector "Lên QC theo sheet"'
    )
    expect(buildBulkAdsSkillMd(custom)).toContain(
      'connector "Lên QC theo sheet"'
    )
    expect(connectorLabel("  ")).toBe("Ads MCP")
    expect(connectorLabel(undefined)).toBe("Ads MCP")
    expect(BULK_SKILL_DESCRIPTION).not.toContain("noti.vn")
  })

  it("wraps the steps as a prompt, a skill and a skill call", () => {
    expect(buildBulkAdsPrompt(DEFAULT_BULK_ADS)).toContain(
      buildBulkAdsRule(DEFAULT_BULK_ADS)
    )
    const md = buildBulkAdsSkillMd(DEFAULT_BULK_ADS)
    expect(md.startsWith(`---\nname: ${BULK_SKILL_NAME}\ndescription: `)).toBe(
      true
    )
    expect(md).toContain(buildBulkAdsRule(DEFAULT_BULK_ADS))
    expect(
      buildBulkAdsSkillPrompt({ ...DEFAULT_BULK_ADS, batchSize: 8 })
    ).toContain(`${BULK_SKILL_NAME} để lên quảng cáo cho 8 dòng`)
    expect(BULK_SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(BULK_SKILL_DESCRIPTION.length).toBeLessThanOrEqual(200)
  })
})
