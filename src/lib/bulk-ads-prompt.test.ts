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
  BULK_TASKS,
  BULK_TEMPLATE_ROWS,
  BULK_WELCOME_SKILL_DESCRIPTION,
  BULK_WELCOME_SKILL_NAME,
  buildBulkAdsPrompt,
  buildBulkAdsRule,
  buildBulkAdsSkillMd,
  buildBulkAdsSkillPrompt,
  buildSheetHeaderTsv,
  buildSheetTemplateCsv,
  bulkSkillName,
  bulkTask,
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
    // v1.1.3: the optional "Lời chào tin nhắn" column right after Link đích (A-H keep their letters)
    // v1.1.4: the optional "Bài viết có sẵn" column closes the user-filled columns (A-I keep their letters)
    expect(BULK_SHEET_COLUMNS.slice(0, 9)).toEqual([
      "Link Drive",
      "Ảnh bìa",
      "Tên creative",
      "Nền tảng",
      "Tài khoản QC",
      "Nội dung",
      "Tiêu đề",
      "Link đích",
      "Lời chào tin nhắn",
    ])
    expect(BULK_SHEET_COLUMNS.slice(8, 11)).toEqual([
      "Lời chào tin nhắn",
      "Bài viết có sẵn",
      "Trạng thái",
    ])
    expect(BULK_SYSTEM_COLUMNS).not.toContain("Lời chào tin nhắn" as never)
    expect(BULK_SYSTEM_COLUMNS).not.toContain("Bài viết có sẵn" as never)
    expect(BULK_SHEET_COLUMNS).toHaveLength(17)
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
    expect(BULK_TEMPLATE_ROWS).toHaveLength(6)
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
    // v1.1.4: the existing-post example row - Meta, no Link Drive, a Facebook post link + a welcome message; the
    // other rows leave "Bài viết có sẵn" empty
    const postAt = BULK_SHEET_COLUMNS.indexOf("Bài viết có sẵn")
    const postRow = BULK_TEMPLATE_ROWS[5]!
    expect(postRow[0]).toBe("")
    expect(postRow[BULK_SHEET_COLUMNS.indexOf("Nền tảng")]).toBe("Meta")
    expect(postRow[postAt]).toMatch(
      /^https:\/\/www\.facebook\.com\/\d+\/posts\/\d+$/
    )
    expect(postRow[welcomeAt]!.length).toBeGreaterThan(0)
    expect(postRow[welcomeAt]!.length).toBeLessThanOrEqual(WELCOME_MESSAGE_MAX)
    for (const row of BULK_TEMPLATE_ROWS.slice(0, 5))
      expect(row[postAt] ?? "").toBe("")
    // header + 6 example rows (newlines inside a quoted cell are LF, rows end with CRLF)
    expect(csv.trimEnd().split("\r\n")).toHaveLength(7)
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

  it("TikTok / OpenAI Ads forms ignore the Meta ad type, the welcome message and the task", () => {
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
      // update_welcome is Meta only: a TikTok / OpenAI Ads form still builds the create prompt
      const upd = { ...base, task: "update_welcome" as const }
      expect(bulkTask(upd)).toBe("create")
      expect(buildBulkAdsPrompt(upd)).toBe(buildBulkAdsPrompt(base))
      expect(bulkSkillName(upd)).toBe(BULK_SKILL_NAME)
      // no existing-post instructions (a Meta-only feature)
      for (const s of ["existing_post", "Bài viết có sẵn", "meta_list_page_posts"])
        expect(buildBulkAdsRule(base)).not.toContain(s)
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

describe("bulk ads prompt - existing posts (v1.1.4, task create)", () => {
  it("Meta rows with existing_post skip the upload and build the ad from the post (website: no welcome message)", () => {
    expect(DEFAULT_BULK_ADS.task).toBe("create")
    for (const platform of ["sheet", "meta"] as const) {
      const rule = buildBulkAdsRule({ ...DEFAULT_BULK_ADS, platform })
      for (const s of [
        "Dòng có existing_post (cột Bài viết có sẵn) thì bỏ qua bước này - không tải file.",
        'meta_create_ad với creative {type: "existing_post", object_story_id = existing_post.post_id}',
        "existing_post.needs_lookup = true",
        "meta_list_page_posts",
        "permalink_url",
        '"Cần mã bài viết dạng PAGEID_POSTID ở cột Bài viết có sẵn"',
        "bỏ qua Nội dung, Tiêu đề, Link đích",
      ])
        expect(rule, `${platform}: ${s}`).toContain(s)
      expect(rule).not.toContain("welcome_message")
      expect(rule).not.toContain("meta_update_ad_creative")
      // the skipped-upload sentence sits in step b, the post sentence in step d
      const b = rule.split("\n").find((l) => l.startsWith("   b. "))!
      const d = rule.split("\n").find((l) => l.startsWith("   d. "))!
      expect(b).toContain("bỏ qua bước này")
      expect(d).toContain("existing_post.post_id")
    }
  })

  it("messaging types add the welcome message to existing-post ads and require the post of the messaging Page", () => {
    for (const metaAdType of [
      "messaging_purchase",
      "messaging_conversations",
    ] as const)
      for (const structure of ["existing", "new"] as const) {
        const rule = buildBulkAdsRule({
          ...DEFAULT_BULK_ADS,
          platform: "meta",
          metaAdType,
          structure,
        })
        expect(rule).toContain(
          'object_story_id = existing_post.post_id}, welcome_message = lời chào của dòng (hoặc của form) như trên'
        )
        expect(rule).toContain(
          "bài viết phải thuộc Trang nhận tin nhắn (promoted_object.page_id)"
        )
        expect(rule).toContain("call_to_action.type = MESSAGE_PAGE")
      }
  })
})

describe("bulk ads prompt - update welcome messages (v1.1.4, task update_welcome)", () => {
  const upd = {
    ...DEFAULT_BULK_ADS,
    task: "update_welcome" as const,
    platform: "meta" as const,
  }

  it("is a Meta-only task of the form", () => {
    expect(BULK_TASKS).toEqual(["create", "update_welcome"])
    expect(bulkTask(upd)).toBe("update_welcome")
    expect(bulkTask({ ...upd, platform: "sheet" })).toBe("update_welcome")
    expect(bulkTask({ ...upd, platform: "tiktok" })).toBe("create")
    expect(bulkTask({ ...upd, platform: "openai_ads" })).toBe("create")
  })

  it("reads rows with ad ids and calls meta_update_ad_creative per ad - never creates or uploads anything", () => {
    const rule = buildBulkAdsRule(upd)
    for (const s of [
      "thêm hoặc đổi lời chào tin nhắn Messenger cho các quảng cáo Meta đã tạo",
      "Không tạo quảng cáo, chiến dịch hay nhóm quảng cáo mới.",
      "all_statuses = true",
      "resolve_files = false",
      "next_cursor",
      "values.ad_ids",
      "nhiều mã cách nhau bằng dấu phẩy",
      "mọi dòng là Meta",
      "meta_update_ad_creative với account_id, ad_id và welcome_message",
      `tối đa ${WELCOME_MESSAGE_MAX} ký tự`,
      "không truyền creative hay creative_id",
      "Meta sẽ duyệt lại quảng cáo",
      "confirm_token",
      "status = status_key hiện tại của dòng",
      'note = "Đã cập nhật lời chào',
      'note = "Chưa cập nhật được lời chào',
      'chưa bắt đầu bằng "Đã cập nhật lời chào"',
      "row_moved",
      "missing_link",
      "welcome_message_too_long",
      "dòng trống thì bỏ qua",
    ])
      expect(rule, s).toContain(s)
    for (const s of [
      "meta_create_ad",
      "meta_create_campaign",
      "ads_upload_media",
      "TẠM DỪNG",
      'status = "processing"',
      "Ngân sách",
    ])
      expect(rule, s).not.toContain(s)
    expect(buildBulkAdsRule({ ...upd, platform: "sheet" })).toContain(
      "chỉ các dòng có platform = meta"
    )
  })

  it("uses the form's welcome message (cleaned) for rows without their own", () => {
    const rule = buildBulkAdsRule({
      ...upd,
      welcomeMessage: '  Chào "bạn"!\nShop gửi \u202ebảng giá nhé ',
    })
    expect(rule).toContain(
      'dòng trống thì dùng lời chào "Chào bạn ! Shop gửi bảng giá nhé"'
    )
    expect(rule).not.toContain("dòng trống thì bỏ qua")
  })

  it("ignores the structure, campaign, budget and Meta ad type; a fixed account is used", () => {
    const base = buildBulkAdsRule(upd)
    for (const metaAdType of [
      "website",
      "messaging_purchase",
      "messaging_conversations",
    ] as const)
      for (const structure of ["existing", "new"] as const)
        expect(
          buildBulkAdsRule({
            ...upd,
            metaAdType,
            structure,
            campaignName: "Ra mắt",
            adGroupName: "Nữ",
            dailyBudget: 1,
          })
        ).toBe(base)
    expect(buildBulkAdsRule({ ...upd, account: "act_123" })).toContain(
      'tài khoản "act_123"'
    )
  })

  it("write-back off never calls drive_sheet_update_rows", () => {
    const rule = buildBulkAdsRule({ ...upd, writeback: false })
    expect(rule).not.toContain("drive_sheet_update_rows")
    expect(rule).not.toContain("Đã cập nhật lời chào")
  })

  it("has its own prompt intro, skill name, description and skill call", () => {
    expect(buildBulkAdsPrompt(upd)).toMatch(
      /^Dùng connector "Ads MCP" \(Ads MCP\) để thêm \/ đổi lời chào tin nhắn/
    )
    expect(buildBulkAdsPrompt(upd)).toContain(buildBulkAdsRule(upd))
    expect(bulkSkillName(upd)).toBe(BULK_WELCOME_SKILL_NAME)
    expect(BULK_WELCOME_SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(BULK_WELCOME_SKILL_NAME).not.toBe(BULK_SKILL_NAME)
    expect(BULK_WELCOME_SKILL_DESCRIPTION.length).toBeLessThanOrEqual(200)
    const md = buildBulkAdsSkillMd(upd)
    expect(
      md.startsWith(
        `---\nname: ${BULK_WELCOME_SKILL_NAME}\ndescription: ${BULK_WELCOME_SKILL_DESCRIPTION}\n---`
      )
    ).toBe(true)
    expect(md).toContain(buildBulkAdsRule(upd))
    expect(buildBulkAdsSkillPrompt({ ...upd, batchSize: 7 })).toBe(
      `Dùng skill ${BULK_WELCOME_SKILL_NAME} để thêm / đổi lời chào cho 7 dòng tiếp theo trong Google Sheet creative.`
    )
    // the create task keeps its skill
    expect(bulkSkillName(DEFAULT_BULK_ADS)).toBe(BULK_SKILL_NAME)
  })
})
