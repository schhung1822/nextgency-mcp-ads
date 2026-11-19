import { createHash } from "node:crypto"
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
  BULK_TIKTOK_AD_TYPES,
  BULK_TIKTOK_MESSAGING_APPS,
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
  checkTiktokMessagingAccount,
  clampBatch,
  cleanName,
  cleanWelcome,
  connectorLabel,
  DEFAULT_BULK_ADS,
  metaMessagingType,
  TIKTOK_WELCOME_MESSAGE_MAX,
  tiktokMessagingType,
  vnPhoneNumber,
  WELCOME_MESSAGE_MAX,
  type BulkAdsInput,
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
    expect(BULK_SKILL_DESCRIPTION).not.toContain("Nextgency")
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

describe("bulk ads prompt - TikTok website prompts unchanged (v1.1.5)", () => {
  // sha256 of every prompt / skill / skill call / skill name of the combinations below, computed with the v1.1.4
  // builder (git HEAD e68870d, before the TikTok ad type existed): the TikTok type `website` (default) must keep every
  // prompt byte-identical - for TikTok, OpenAI Ads, Meta and "Theo cột Nền tảng", both tasks
  const V114: Record<string, string> = {
    "create/sheet":
      "35898c7b7e18d2959f82fbbfed20e925cce009739cf4d4cc2bb4914251835382",
    "create/meta":
      "905bb4f4169aa556497a733cf214bfe37b53d473cc7752d604a509fc222e1fc0",
    "create/tiktok":
      "1185f1337f3732f56534c6853bf61ee364a7ef15492c0f83fd18de10db3c3c16",
    "create/openai_ads":
      "365f7745fb2ce5cbfa6f5f13a91cd4c35f6d9393261a6ac90125aa16bcb5eed8",
    "update_welcome/sheet":
      "1a1d8104746c0b86d6c1fbea4d1c4dbe037194975657af1cf1b033fbc1e3c936",
    "update_welcome/meta":
      "2e12cef59eba23767ab25e86f3ef3436b26995edb1f0e804b2f62fc884d39891",
    "update_welcome/tiktok":
      "1185f1337f3732f56534c6853bf61ee364a7ef15492c0f83fd18de10db3c3c16",
    "update_welcome/openai_ads":
      "365f7745fb2ce5cbfa6f5f13a91cd4c35f6d9393261a6ac90125aa16bcb5eed8",
  }

  function combos(
    task: BulkAdsInput["task"],
    platform: BulkAdsInput["platform"],
    extra: Partial<BulkAdsInput>
  ): BulkAdsInput[] {
    const out: BulkAdsInput[] = []
    for (const structure of ["existing", "new"] as const)
      for (const writeback of [true, false])
        for (const metaAdType of [
          "website",
          "messaging_purchase",
          "messaging_conversations",
        ] as const)
          for (const welcomeMessage of ["", "Chào bạn! Shop gửi bảng giá nhé"])
            for (const named of [false, true])
              out.push({
                ...DEFAULT_BULK_ADS,
                task,
                platform,
                structure,
                writeback,
                metaAdType,
                welcomeMessage,
                ...(named
                  ? {
                      connectorName: "Lên QC",
                      sheetName: "Kế hoạch T10",
                      account: "act_123",
                      campaignName: "Ra mắt serum",
                      adGroupName: "Nữ 25-34",
                      batchSize: 8,
                      dailyBudget: 350000.5,
                      currency: "USD",
                    }
                  : {}),
                ...extra,
              })
    return out
  }

  function digest(
    task: BulkAdsInput["task"],
    platform: BulkAdsInput["platform"],
    extra: Partial<BulkAdsInput> = {}
  ): string {
    const h = createHash("sha256")
    for (const input of combos(task, platform, extra))
      h.update(
        [
          buildBulkAdsPrompt(input),
          buildBulkAdsSkillMd(input),
          buildBulkAdsSkillPrompt(input),
          bulkSkillName(input),
        ].join("\n\u0000\n") + "\n\u0001\n"
      )
    return h.digest("hex")
  }

  it("TikTok type website (default): every prompt equals the v1.1.4 output, whatever the app / account typed", () => {
    expect(DEFAULT_BULK_ADS.tiktokAdType).toBe("website")
    for (const task of BULK_TASKS)
      for (const platform of ["sheet", "meta", "tiktok", "openai_ads"] as const) {
        const want = V114[`${task}/${platform}`]
        expect(digest(task, platform), `${task}/${platform}`).toBe(want)
        expect(
          digest(task, platform, {
            tiktokAdType: "website",
            tiktokMessagingApp: "MESSENGER",
            tiktokMessagingAccount: "123456789012345",
          }),
          `${task}/${platform} website + account`
        ).toBe(want)
      }
  })

  it("Meta / OpenAI Ads forms and the update_welcome task ignore the TikTok ad type", () => {
    for (const tiktokAdType of BULK_TIKTOK_AD_TYPES) {
      const extra = {
        tiktokAdType,
        tiktokMessagingApp: "ZALO" as const,
        tiktokMessagingAccount: "0901234567",
        welcomeMessage: "Chào bạn",
      }
      for (const platform of ["meta", "openai_ads"] as const) {
        for (const input of combos("create", platform, extra))
          expect(tiktokMessagingType(input)).toBeNull()
        expect(
          digest("create", platform, { tiktokAdType }),
          `${platform} ${tiktokAdType}`
        ).toBe(V114[`create/${platform}`])
      }
      // update_welcome (Meta / "Theo cột Nền tảng") never mentions TikTok; a TikTok form builds the create task
      for (const platform of ["sheet", "meta", "openai_ads"] as const)
        expect(
          digest("update_welcome", platform, { tiktokAdType }),
          `update_welcome/${platform} ${tiktokAdType}`
        ).toBe(V114[`update_welcome/${platform}`])
    }
  })
})

describe("bulk ads prompt - TikTok messaging ads (v1.1.5)", () => {
  const tiktok = { ...DEFAULT_BULK_ADS, platform: "tiktok" as const }
  const line = (rule: string, step: string) =>
    rule.split("\n").find((l) => l.startsWith(`   ${step}. `)) ?? ""
  const STRUCTURES = [
    { name: "new", input: { structure: "new" as const } },
    {
      name: "existing named",
      input: { structure: "existing" as const, campaignName: "Ra mắt serum" },
    },
    { name: "existing asked", input: { structure: "existing" as const } },
  ]

  it("applies to TikTok / sheet-chosen forms only, never to the website type", () => {
    expect(BULK_TIKTOK_AD_TYPES).toEqual([
      "website",
      "messaging_dm",
      "messaging_app",
    ])
    expect(BULK_TIKTOK_MESSAGING_APPS).toEqual([
      "ZALO",
      "MESSENGER",
      "WHATSAPP",
      "LINE",
    ])
    expect(TIKTOK_WELCOME_MESSAGE_MAX).toBe(200)
    for (const platform of ["tiktok", "sheet"] as const) {
      expect(tiktokMessagingType({ ...tiktok, platform })).toBeNull()
      for (const tiktokAdType of ["messaging_dm", "messaging_app"] as const)
        expect(tiktokMessagingType({ ...tiktok, platform, tiktokAdType })).toBe(
          tiktokAdType
        )
    }
  })

  it("every TikTok type × structure × platform mode: video only, SEND_MESSAGE, no Link đích, paused", () => {
    for (const platform of ["tiktok", "sheet"] as const)
      for (const tiktokAdType of ["messaging_dm", "messaging_app"] as const)
        for (const st of STRUCTURES) {
          const label = `${platform} ${tiktokAdType} ${st.name}`
          const rule = buildBulkAdsRule({
            ...tiktok,
            platform,
            tiktokAdType,
            ...st.input,
          })
          const b = line(rule, "b")
          const c = line(rule, "c")
          const d = line(rule, "d")
          expect(b, label).toContain(
            'dòng TikTok không có video thì không tải file, ghi lỗi "Quảng cáo tin nhắn TikTok cần video - dòng này chỉ có ảnh"'
          )
          expect(d, label).toContain("call_to_action SEND_MESSAGE")
          expect(d, label).toContain("không truyền Link đích, page_id hay deeplink")
          expect(d, label).toContain(
            "Mọi dòng TikTok của lượt đều là quảng cáo tin nhắn - không trộn với quảng cáo dẫn tới website."
          )
          expect(d, label).toContain("TẠM DỪNG")
          if (st.input.structure === "new") {
            expect(c, label).toContain(
              "tiktok_create_campaign objective LEAD_GENERATION (chiến dịch thường, không Smart+)"
            )
            expect(c, label).toContain("optimization_goal CLICK")
            expect(c, label).toContain(
              "không truyền placement, optimization_event, pixel_id hay độ tuổi 13-17 - tool tự đặt vị trí chỉ TikTok"
            )
            expect(c, label).toContain("Sau 31/12/2026 TikTok không cho tạo chiến dịch thường qua API")
            expect(c, label).not.toContain("ads_get_object")
          } else {
            expect(c, label).toContain(
              "trước khi tạo quảng cáo, xem nhóm quảng cáo bằng ads_get_object - promotion_type phải là"
            )
            expect(c, label).not.toContain("objective LEAD_GENERATION")
            expect(c, label).not.toContain("tiktok_create_adgroup")
          }
          // Meta-only sentences stay out of a TikTok form; the sheet-chosen form keeps them for Meta rows
          if (platform === "tiktok") {
            expect(rule).not.toContain("existing_post")
            expect(rule).not.toContain("MESSAGE_PAGE")
          } else expect(rule).toContain("existing_post")
        }
  })

  it("TikTok DM: one welcome message per distinct text, created or reused, Spark identity that can manage messages", () => {
    for (const st of STRUCTURES) {
      const rule = buildBulkAdsRule({
        ...tiktok,
        tiktokAdType: "messaging_dm",
        welcomeMessage: "Chào bạn! Shop gửi bảng giá nhé",
        ...st.input,
      })
      const d = line(rule, "d")
      for (const s of [
        "quảng cáo tin nhắn TikTok (Direct Message), bắt buộc có lời chào",
        "welcome_message của dòng (cột Lời chào tin nhắn, tối đa 200 ký tự)",
        'dòng trống thì dùng lời chào "Chào bạn! Shop gửi bảng giá nhé"',
        "Với mỗi tài khoản và mỗi lời chào khác nhau trong lượt",
        "tiktok_messaging_assets kind=welcome_messages",
        "tạo MỘT lần bằng tiktok_create_welcome_message {content = lời chào}",
        "auto_message_id",
        "danh tính Spark (identity_type TT_USER hoặc BC_AUTH_TT)",
        "can_manage_message = true",
        "tiktok_messaging_assets kind=dm_identities",
        '"Mọi người" nhắn tin',
        "Lời chào không đổi được sau khi tạo quảng cáo.",
      ])
        expect(d, `${st.name}: ${s}`).toContain(s)
      if (st.input.structure === "new")
        expect(line(rule, "c")).toContain(
          'tiktok_create_adgroup với messaging = {destination: "TIKTOK_DM"}'
        )
      else
        expect(line(rule, "c")).toContain(
          'promotion_type phải là LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE (khác → ghi lỗi "Nhóm quảng cáo TikTok không phải nhóm tin nhắn TikTok", không tạo quảng cáo)'
        )
    }
  })

  it("TikTok DM default welcome message: cleaned; none → ask once from the account's list; over 200 → error note", () => {
    const dm = { ...tiktok, tiktokAdType: "messaging_dm" as const }
    expect(
      buildBulkAdsRule({
        ...dm,
        welcomeMessage: '  Chào "bạn"!\nShop gửi \u202ebảng giá nhé ',
      })
    ).toContain('dòng trống thì dùng lời chào "Chào bạn ! Shop gửi bảng giá nhé"')
    const none = buildBulkAdsRule(dm)
    expect(none).toContain(
      "dòng trống thì liệt kê lời chào có sẵn bằng tiktok_messaging_assets kind=welcome_messages và hỏi tôi MỘT lần cho cả lượt"
    )
    const at200 = buildBulkAdsRule({ ...dm, welcomeMessage: "a".repeat(200) })
    expect(at200).toContain(`dòng trống thì dùng lời chào "${"a".repeat(200)}"`)
    // "Theo cột Nền tảng" + Meta messaging: the form allows 300 - TikTok rows without their own text get an error note
    const long = buildBulkAdsRule({
      ...dm,
      platform: "sheet",
      metaAdType: "messaging_conversations",
      welcomeMessage: "b".repeat(250),
    })
    expect(long).toContain(
      'dòng trống thì ghi lỗi "Lời chào mặc định dài hơn 200 ký tự - ghi lời chào riêng (tối đa 200 ký tự) ở cột Lời chào tin nhắn"'
    )
    // the Meta rows still use the 300-character text
    expect(long).toContain(`dòng trống thì dùng lời chào "${"b".repeat(250)}"`)
  })

  it("messaging apps: the ad group messaging object per app, with the typed account or asked once", () => {
    const app = { ...tiktok, tiktokAdType: "messaging_app" as const, structure: "new" as const }
    const c = (extra: Partial<BulkAdsInput>) => line(buildBulkAdsRule({ ...app, ...extra }), "c")
    expect(c({ tiktokMessagingAccount: "0901 234 567" })).toContain(
      'messaging = {destination: "ZALO", phone_region_code: "VN", phone_region_calling_code: "+84", phone_number: "901234567"}'
    )
    expect(c({})).toContain("TikTok - quảng cáo tin nhắn qua Zalo")
    expect(c({})).toContain("optimization_goal CLICK (Zalo chỉ nhận CLICK)")
    expect(c({})).toContain(
      'phone_number: số Zalo bỏ số 0 đầu, vd "901234567"} (số điện thoại Zalo của tôi; chưa rõ thì hỏi tôi MỘT lần cho cả lượt)'
    )
    const wa = c({ tiktokMessagingApp: "WHATSAPP", tiktokMessagingAccount: "+84 912 345 678" })
    expect(wa).toContain(
      'messaging = {destination: "WHATSAPP", phone_region_code: "VN", phone_region_calling_code: "+84", phone_number: "912345678"}'
    )
    expect(wa).toContain("số WhatsApp Business API đã nối với công cụ quản lý tin nhắn")
    expect(wa).toContain("kind=message_event_sets")
    const fb = c({ tiktokMessagingApp: "MESSENGER", tiktokMessagingAccount: "1234 5678 9012 345" })
    expect(fb).toContain('messaging = {destination: "MESSENGER", facebook_page_id: "123456789012345"}')
    expect(fb).toContain("CONVERSATION chỉ khi tôi yêu cầu")
    expect(fb).not.toContain("ads_lookup kind=pages")
    const ln = c({ tiktokMessagingApp: "LINE", tiktokMessagingAccount: "@shopcuaban" })
    expect(ln).toContain('messaging = {destination: "LINE", line_business_id: "@shopcuaban"}')
    expect(ln).toContain("optimization_goal CLICK (LINE chỉ nhận CLICK)")
    expect(ln).not.toContain("message_event_sets")
    // an invalid account never reaches the prompt (the form blocks copying; the builder asks instead)
    for (const [tiktokMessagingApp, bad] of [
      ["ZALO", "abc"],
      ["WHATSAPP", "12-34"],
      ["MESSENGER", "trang-cua-toi"],
      ["LINE", '@a"b c'],
    ] as const) {
      const text = c({ tiktokMessagingApp, tiktokMessagingAccount: bad })
      expect(text).not.toContain(bad)
      expect(text).toContain("chưa rõ thì hỏi tôi MỘT lần cho cả lượt")
    }
    // the ad: TikTok opens the app itself - no wa.me / m.me / zalo.me link
    const d = line(buildBulkAdsRule({ ...app, tiktokMessagingApp: "MESSENGER" }), "d")
    expect(d).toContain("Quảng cáo TikTok là quảng cáo tin nhắn qua Messenger")
    expect(d).toContain("không tự ghi link zalo.me, m.me hay wa.me")
    expect(d).not.toContain("auto_message_id")
    expect(d).not.toContain("tiktok_create_welcome_message")
  })

  it("existing ad group: promotion_type + messaging_app_type checked with ads_get_object, the typed account compared", () => {
    const c = line(
      buildBulkAdsRule({
        ...tiktok,
        tiktokAdType: "messaging_app",
        tiktokMessagingApp: "ZALO",
        tiktokMessagingAccount: "0901234567",
        campaignName: "Ra mắt serum",
      }),
      "c"
    )
    expect(c).toContain(
      'promotion_type phải là LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE và messaging_app_type phải là ZALO (khác → ghi lỗi "Nhóm quảng cáo TikTok không gửi khách tới Zalo", không tạo quảng cáo)'
    )
    expect(c).toContain('khác "901234567" thì báo tôi và hỏi trước khi làm tiếp')
    const noAccount = line(
      buildBulkAdsRule({ ...tiktok, tiktokAdType: "messaging_app", tiktokMessagingApp: "LINE" }),
      "c"
    )
    expect(noAccount).toContain("messaging_app_type phải là LINE")
    expect(noAccount).not.toContain("thì báo tôi và hỏi trước khi làm tiếp")
  })

  it("sheet-chosen platform: Meta messaging and TikTok messaging sentences side by side, other steps unchanged", () => {
    const website = buildBulkAdsRule({
      ...DEFAULT_BULK_ADS,
      platform: "sheet",
      metaAdType: "messaging_purchase",
      structure: "new",
    })
    const both = buildBulkAdsRule({
      ...DEFAULT_BULK_ADS,
      platform: "sheet",
      metaAdType: "messaging_purchase",
      structure: "new",
      tiktokAdType: "messaging_dm",
    })
    expect(both).toContain("Quảng cáo Meta là quảng cáo tin nhắn Messenger")
    expect(both).toContain("Quảng cáo TikTok là quảng cáo tin nhắn TikTok (Direct Message)")
    expect(both).toContain("Meta: meta_create_campaign → meta_create_adset; TikTok:")
    const wl = website.split("\n")
    const bl = both.split("\n")
    expect(bl).toHaveLength(wl.length)
    for (let i = 0; i < wl.length; i++) {
      if (/^ {3}[bcd]\. /.test(wl[i]!)) {
        // the TikTok sentences are only appended inside steps b, c and d: the Meta text is kept as is
        expect(bl[i]!.length).toBeGreaterThan(wl[i]!.length)
        const [head] = wl[i]!.split(" Ảnh bìa của video:")
        expect(bl[i]!.startsWith(head!)).toBe(true)
      } else expect(bl[i]).toBe(wl[i])
    }
  })

  it("checks and normalises the receiving account per app", () => {
    for (const [raw, want] of [
      ["0901234567", "901234567"],
      ["0901 234 567", "901234567"],
      ["090.123.4567", "901234567"],
      ["+84 901 234 567", "901234567"],
      ["84901234567", "901234567"],
      ["0084901234567", "901234567"],
      ["901234567", "901234567"],
      ["0281234567 8", "2812345678"],
    ] as const)
      expect(vnPhoneNumber(raw), raw).toBe(want)
    for (const bad of ["", "abc", "12345", "0101234567", "+1 415 555 0100", "09012345678"])
      expect(vnPhoneNumber(bad), bad).toBeNull()
    expect(checkTiktokMessagingAccount("ZALO", "  ")).toEqual({ ok: true, value: "" })
    expect(checkTiktokMessagingAccount("WHATSAPP", "0912 345 678")).toEqual({
      ok: true,
      value: "912345678",
    })
    expect(checkTiktokMessagingAccount("ZALO", "zalo.me/abc")).toEqual({
      ok: false,
      error: "phone",
    })
    expect(checkTiktokMessagingAccount("MESSENGER", "123 456 789 012 345")).toEqual({
      ok: true,
      value: "123456789012345",
    })
    expect(checkTiktokMessagingAccount("MESSENGER", "fb.com/shop")).toEqual({
      ok: false,
      error: "page_id",
    })
    expect(checkTiktokMessagingAccount("LINE", " @shop.cua_ban ")).toEqual({
      ok: true,
      value: "@shop.cua_ban",
    })
    expect(checkTiktokMessagingAccount("LINE", "shop của bạn")).toEqual({
      ok: false,
      error: "line_id",
    })
  })
})
