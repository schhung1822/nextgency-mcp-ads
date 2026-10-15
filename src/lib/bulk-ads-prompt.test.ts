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
  cleanWelcome,
  connectorLabel,
  DEFAULT_BULK_ADS,
  metaMessagingType,
  WELCOME_MESSAGE_MAX,
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
    // v1.1.2: the optional "Ảnh bìa" column sits right after Link Drive and is filled by the user
    expect(BULK_SHEET_COLUMNS.slice(0, 2)).toEqual(["Link Drive", "Ảnh bìa"])
    expect(BULK_SYSTEM_COLUMNS).not.toContain("Ảnh bìa" as never)
    // v1.1.3: the optional "Lời chào tin nhắn" column closes the user-filled columns (A-H keep their letters)
    expect(BULK_SHEET_COLUMNS.slice(7, 10)).toEqual([
      "Link đích",
      "Lời chào tin nhắn",
      "Trạng thái",
    ])
    expect(BULK_SYSTEM_COLUMNS).not.toContain("Lời chào tin nhắn" as never)
    expect(BULK_SHEET_COLUMNS).toHaveLength(16)
  })

  it("copies the header as tab-separated cells", () => {
    const tsv = buildSheetHeaderTsv()
    expect(tsv.split("\t")).toEqual([...BULK_SHEET_COLUMNS])
    expect(tsv).not.toContain("\n")
  })

  it("builds a UTF-8 BOM CSV with quoted multi-link cells and one cell per header column", () => {
    const csv = buildSheetTemplateCsv()
    expect(csv.startsWith("﻿Link Drive,Ảnh bìa,Tên creative,")).toBe(true)
    expect(csv.endsWith("\r\n")).toBe(true)
    // a cell holding several links (newline inside) is quoted
    expect(csv).toContain(
      '"https://drive.google.com/file/d/1DeFgHiJkLmNoPqRsTuVwXyZ345678/view\nhttps://'
    )
    expect(BULK_TEMPLATE_ROWS).toHaveLength(5)
    for (const row of BULK_TEMPLATE_ROWS)
      expect(row.length).toBeLessThanOrEqual(BULK_SHEET_COLUMNS.length)
    // the TikTok video row has its cover in the "Ảnh bìa" column
    const cover = BULK_SHEET_COLUMNS.indexOf("Ảnh bìa")
    expect(BULK_TEMPLATE_ROWS[1]![cover]).toMatch(
      /^https:\/\/drive\.google\.com\//
    )
    // the messaging example row: a welcome message ≤ 300 characters, no Link đích
    const welcomeAt = BULK_SHEET_COLUMNS.indexOf("Lời chào tin nhắn")
    const messagingRow = BULK_TEMPLATE_ROWS[4]!
    expect(messagingRow[welcomeAt]!.length).toBeGreaterThan(0)
    expect(messagingRow[welcomeAt]!.length).toBeLessThanOrEqual(
      WELCOME_MESSAGE_MAX
    )
    expect(messagingRow[BULK_SHEET_COLUMNS.indexOf("Link đích")]).toBe("")
    for (const row of BULK_TEMPLATE_ROWS.slice(0, 4))
      expect(row[welcomeAt] ?? "").toBe("")
    // header + 5 example rows (newlines inside a quoted cell are LF, rows end with CRLF)
    expect(csv.trimEnd().split("\r\n")).toHaveLength(6)
    // example statuses are values the sheet reader accepts as "pending"
    const statusAt = BULK_SHEET_COLUMNS.indexOf("Trạng thái")
    for (const row of BULK_TEMPLATE_ROWS) {
      const status = row[statusAt] ?? ""
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
    // video covers: the "Ảnh bìa" column, else the old "same Link Drive cell" convention; per platform
    expect(rule).toContain("cover của dòng (cột Ảnh bìa)")
    expect(rule).toContain("cùng ô Link Drive với video")
    expect(rule).toContain("image_drive_file")
    expect(rule).toContain("video_processing")
    expect(rule).toContain("TikTok: tải ảnh bìa bằng ads_upload_media")
  })

  it("cover sentence follows the platform: Meta only, TikTok only, none for OpenAI Ads", () => {
    const meta = buildBulkAdsRule({ ...DEFAULT_BULK_ADS, platform: "meta" })
    expect(meta).toContain("image_drive_file")
    expect(meta).not.toContain("TikTok: tải ảnh bìa")
    const tiktok = buildBulkAdsRule({ ...DEFAULT_BULK_ADS, platform: "tiktok" })
    expect(tiktok).toContain("TikTok: tải ảnh bìa")
    expect(tiktok).not.toContain("image_drive_file")
    const openai = buildBulkAdsRule({
      ...DEFAULT_BULK_ADS,
      platform: "openai_ads",
    })
    expect(openai).not.toContain("Ảnh bìa")
    expect(openai).toContain("Nhiều ảnh trong một ô")
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

describe("bulk ads prompt - Meta messaging ads (v1.1.3)", () => {
  const purchase = {
    ...DEFAULT_BULK_ADS,
    platform: "meta" as const,
    metaAdType: "messaging_purchase" as const,
  }

  it("website (default) keeps the prompt free of messaging instructions", () => {
    expect(DEFAULT_BULK_ADS.metaAdType).toBe("website")
    expect(DEFAULT_BULK_ADS.welcomeMessage).toBe("")
    for (const platform of ["sheet", "meta"] as const) {
      const rule = buildBulkAdsRule({ ...DEFAULT_BULK_ADS, platform })
      for (const s of [
        "MESSAGE_PAGE",
        "MESSAGING_PURCHASE_CONVERSION",
        "welcome_message",
        "Messenger",
      ])
        expect(rule).not.toContain(s)
    }
  })

  it("TikTok / OpenAI Ads forms ignore the Meta ad type and welcome message", () => {
    for (const platform of ["tiktok", "openai_ads"] as const) {
      const base = { ...DEFAULT_BULK_ADS, platform, structure: "new" as const }
      for (const metaAdType of [
        "messaging_purchase",
        "messaging_conversations",
      ] as const) {
        const input = { ...base, metaAdType, welcomeMessage: "Chào bạn" }
        expect(metaMessagingType(input)).toBeNull()
        expect(buildBulkAdsRule(input)).toBe(buildBulkAdsRule(base))
      }
    }
  })

  it("purchase, new structure: Sales campaign, MESSAGING_PURCHASE_CONVERSION ad set to Messenger, prerequisite + agreed fallback", () => {
    const rule = buildBulkAdsRule({ ...purchase, structure: "new" })
    expect(metaMessagingType({ ...purchase, structure: "new" })).toBe(
      "messaging_purchase"
    )
    for (const s of [
      "objective OUTCOME_SALES",
      "optimization_goal MESSAGING_PURCHASE_CONVERSION",
      "destination_type MESSENGER",
      "billing_event IMPRESSIONS",
      "promoted_object.page_id",
      "ads_lookup kind=pages",
      "ít nhất 5 sự kiện mua hàng",
      "Conversions API",
      '"Tạo đơn" trong Meta Business Suite',
      "optimization_goal CONVERSATIONS (tối ưu lượt bắt đầu trò chuyện) khi tôi đồng ý",
      "call_to_action.type = MESSAGE_PAGE",
      "welcome_message = welcome_message của dòng (cột Lời chào tin nhắn",
      "Meta dùng lời chào mặc định",
      "Link đích không phải đích đến",
      "không trộn với quảng cáo dẫn tới website",
    ])
      expect(rule).toContain(s)
    expect(rule).not.toContain("ads_get_object")
  })

  it("conversations, new structure: CONVERSATIONS to Messenger, no purchase prerequisite", () => {
    const rule = buildBulkAdsRule({
      ...purchase,
      metaAdType: "messaging_conversations",
      structure: "new",
    })
    expect(rule).toContain("objective OUTCOME_ENGAGEMENT")
    expect(rule).toContain("optimization_goal CONVERSATIONS")
    expect(rule).toContain("destination_type MESSENGER")
    expect(rule).toContain("call_to_action.type = MESSAGE_PAGE")
    expect(rule).not.toContain("MESSAGING_PURCHASE_CONVERSION")
    expect(rule).not.toContain("5 sự kiện mua hàng")
  })

  it("existing ad set: checked with ads_get_object (Messenger destination, goal mismatch asked)", () => {
    const named = buildBulkAdsRule({
      ...purchase,
      campaignName: "Ra mắt serum",
    })
    const asked = buildBulkAdsRule(purchase)
    for (const rule of [named, asked]) {
      expect(rule).toContain("ads_get_object")
      expect(rule).toContain("destination_type phải là MESSENGER")
      expect(rule).toContain(
        "optimization_goal khác MESSAGING_PURCHASE_CONVERSION thì báo tôi"
      )
      expect(rule).not.toContain("objective OUTCOME_SALES")
    }
    const conv = buildBulkAdsRule({
      ...purchase,
      metaAdType: "messaging_conversations",
    })
    expect(conv).toContain("optimization_goal khác CONVERSATIONS thì báo tôi")
  })

  it("sheet-chosen platform: messaging applies to the Meta rows, cover sentences stay per platform", () => {
    const rule = buildBulkAdsRule({
      ...purchase,
      platform: "sheet",
      structure: "new",
    })
    expect(rule).toContain("Quảng cáo Meta là quảng cáo tin nhắn Messenger")
    expect(rule).toContain("TikTok: tải ảnh bìa bằng ads_upload_media")
    expect(rule).toContain(
      "Meta: meta_create_campaign → meta_create_adset; TikTok:"
    )
  })

  it("the form's welcome message is the default of empty rows, cleaned and capped", () => {
    const rule = buildBulkAdsRule({
      ...purchase,
      welcomeMessage: '  Chào "bạn"!\nShop gửi \u202ebảng giá\u200b nhé  ',
    })
    expect(rule).toContain(
      'dòng trống thì dùng lời chào "Chào bạn ! Shop gửi bảng giá nhé"'
    )
    expect(rule).not.toContain("Meta dùng lời chào mặc định")
    expect(cleanWelcome("a".repeat(400))).toHaveLength(WELCOME_MESSAGE_MAX)
    // never ends on half of an emoji
    const cut = cleanWelcome(`${"a".repeat(WELCOME_MESSAGE_MAX - 1)}😀`)
    expect(cut).toHaveLength(WELCOME_MESSAGE_MAX - 1)
    expect(cleanWelcome(" \n ")).toBe("")
  })
})
