import { describe, expect, it } from "vitest"
import { normalizeSheetConfig } from "../../../drive/store"
import { driveRefForLog } from "../../log-args"
import type { GrantAccount, McpGrant } from "../../types"
import { jobErrorText, uploadLogArgs } from "../common/upload-media"
import { statusFilter } from "./sheet-read"
import { rowInput, updatedAtStamp } from "./sheet-update-rows"
import {
  canonicalExpectedAnchor,
  canonicalLinkCell,
  cleanSheetLink,
  COLUMN_FIELDS,
  existingPostAnchor,
  foldText,
  isFacebookLink,
  isSheetLink,
  linkTokens,
  mapColumns,
  matchAccount,
  neutralizeFormula,
  normalizePlatform,
  parseExistingPost,
  rowAnchor,
  sanitizeCell,
  SHEET_ID_RE,
  SHEET_LINK_MAX,
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

describe("sheet link columns + status aliases (2026-10-10)", () => {
  it("cleanSheetLink / isSheetLink: https only, a host, no spaces / credentials, ≤ 500 characters", () => {
    expect(cleanSheetLink("  https://fb.com/123\u200b\n ")).toBe(
      "https://fb.com/123"
    )
    expect(cleanSheetLink("https://x.test/a\u202e\u0007b")).toBe(
      "https://x.test/ab"
    )
    for (const ok of [
      "https://www.facebook.com/123/posts/456",
      "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1&selected_campaign_ids=2",
      "https://ads.tiktok.com/i18n/perf/campaign?aadvid=1",
      `https://x.test/${"a".repeat(SHEET_LINK_MAX - 15)}`,
    ])
      expect(isSheetLink(ok), ok).toBe(true)
    for (const bad of [
      "http://fb.com/1",
      "javascript:alert(1)",
      '=HYPERLINK("https://evil")',
      "https://",
      "https://a b.com/x",
      "https://user:pass@x.test/",
      "ftp://x.test/a",
      "fb.com/123",
      "",
      `https://x.test/${"a".repeat(SHEET_LINK_MAX)}`,
    ])
      expect(isSheetLink(bad), bad).toBe(false)
  })

  it("drive_sheet_update_rows row input: post_link / campaign_link optional, validated after cleaning", () => {
    const base = { row_number: 2, expected_link: "x", status: "done" }
    expect(rowInput.safeParse(base).success).toBe(true)
    const ok = rowInput.safeParse({
      ...base,
      post_link: " https://fb.com/1/posts/2\u200b ",
      campaign_link: "https://adsmanager.facebook.com/x?act=1",
    })
    expect(ok.success).toBe(true)
    for (const bad of [
      { post_link: "http://fb.com/1" },
      { post_link: '=IMPORTXML("https://x")' },
      { campaign_link: "https://a b" },
      { campaign_link: `https://x.test/${"a".repeat(600)}` },
      { post_link: "" },
    ])
      expect(
        rowInput.safeParse({ ...base, ...bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
  })

  it("COLUMN_FIELDS exposes the link columns to drive_sheet_read", () => {
    expect(COLUMN_FIELDS.postLink).toBe("post_link")
    expect(COLUMN_FIELDS.campaignLink).toBe("campaign_link")
    expect(COLUMN_FIELDS.cover).toBe("cover")
    expect(COLUMN_FIELDS.welcomeMessage).toBe("welcome_message")
    expect(COLUMN_FIELDS.existingPost).toBe("existing_post")
  })

  it("parseExistingPost: PAGEID_POSTID and numeric Facebook post links give the post id, other Facebook links need a lookup, anything else is invalid", () => {
    const ok = (cell: string) => {
      const r = parseExistingPost(cell)
      if (!r || !r.ok) throw new Error(`not ok: ${cell}`)
      return r.post
    }
    expect(parseExistingPost("")).toBeNull()
    expect(parseExistingPost("  \n ")).toBeNull()
    expect(parseExistingPost(undefined)).toBeNull()
    // PAGEID_POSTID (first word of the cell; invisible characters stripped like every cell)
    expect(ok(" 123456789012345_987654321098765 ")).toEqual({
      post_id: "123456789012345_987654321098765",
      needs_lookup: false,
    })
    expect(ok("123456789012345_987654321098765\u200b bài khuyến mãi")).toEqual(
      { post_id: "123456789012345_987654321098765", needs_lookup: false }
    )
    // /{page}/posts/{id} (any facebook host, http upgraded, query / fragment dropped)
    expect(
      ok(
        "https://www.facebook.com/123456789012345/posts/987654321098765/?__cft__[0]=AZX&__tn__=%2CO#c"
      )
    ).toEqual({
      post_id: "123456789012345_987654321098765",
      url: "https://www.facebook.com/123456789012345/posts/987654321098765/",
      needs_lookup: false,
    })
    expect(ok("http://m.facebook.com/123456789012345/posts/987654321098765")).toMatchObject({
      post_id: "123456789012345_987654321098765",
      url: "https://m.facebook.com/123456789012345/posts/987654321098765",
    })
    expect(ok("facebook.com/123456789012345/posts/987654321098765").post_id).toBe(
      "123456789012345_987654321098765"
    )
    // permalink.php / story.php keep only story_fbid + id
    expect(
      ok(
        "https://www.facebook.com/permalink.php?story_fbid=987654321098765&id=123456789012345&mibextid=abc"
      )
    ).toEqual({
      post_id: "123456789012345_987654321098765",
      url: "https://www.facebook.com/permalink.php?story_fbid=987654321098765&id=123456789012345",
      needs_lookup: false,
    })
    expect(
      ok(
        "https://m.facebook.com/story.php?story_fbid=987654321098765&id=123456789012345"
      ).post_id
    ).toBe("123456789012345_987654321098765")
    // other Facebook links: the link is kept, the post must be looked up
    for (const [cell, url] of [
      [
        "https://www.facebook.com/shopmypham/posts/pfbid02abcDEF?mibextid=x",
        "https://www.facebook.com/shopmypham/posts/pfbid02abcDEF",
      ],
      [
        "https://www.facebook.com/share/p/1AbCdEf/",
        "https://www.facebook.com/share/p/1AbCdEf/",
      ],
      [
        "https://www.facebook.com/permalink.php?story_fbid=pfbid0xyz&id=123456789012345",
        "https://www.facebook.com/permalink.php?story_fbid=pfbid0xyz&id=123456789012345",
      ],
      ["https://fb.watch/abcDEF/", "https://fb.watch/abcDEF/"],
      [
        "https://web.facebook.com/123456789012345/videos/987654321098765",
        "https://web.facebook.com/123456789012345/videos/987654321098765",
      ],
    ] as const)
      expect(ok(cell), cell).toEqual({ url, needs_lookup: true })
    // not a Facebook post
    for (const bad of [
      "bài viết hôm qua",
      "123_456",
      "123456789012345-987654321098765",
      "https://www.instagram.com/p/abc/",
      "https://facebook.com.evil.test/123456789012345/posts/987654321098765",
      "https://evilfacebook.com/1/posts/2",
      "https://user:pw@www.facebook.com/123456789012345/posts/987654321098765",
      "javascript:alert(1)",
      `https://www.facebook.com/${"a".repeat(600)}`,
      `https://drive.google.com/file/d/${FILE}/view`,
    ])
      expect(parseExistingPost(bad), bad).toEqual({
        ok: false,
        code: "existing_post_invalid",
      })
    expect(isFacebookLink("https://business.facebook.com/x")).toBe(true)
    expect(isFacebookLink("https://example.com/facebook.com")).toBe(false)
    expect(isFacebookLink("facebook.com/x")).toBe(false)
  })

  it("rowAnchor: the link cell first (unchanged), else the existing post; the AI's expected_link compares in the same form", () => {
    const post =
      "https://www.facebook.com/123456789012345/posts/987654321098765?x=1"
    // a Drive link anchors the row even when a post is there too (rows written before v1.1.4 keep their anchor)
    expect(rowAnchor(`https://drive.google.com/file/d/${FILE}/view`, post)).toBe(
      FILE
    )
    expect(rowAnchor(`https://drive.google.com/file/d/${FILE}/view`, undefined)).toBe(FILE)
    // no link: the post (parsed id, needs-lookup link or the raw text of an invalid cell)
    // + the creative name and account cells (empty when not mapped)
    expect(rowAnchor("", post)).toBe("post:123456789012345_987654321098765||")
    expect(rowAnchor("chưa có", "https://www.facebook.com/share/p/1AbC/")).toBe(
      "post:https://www.facebook.com/share/p/1AbC/||"
    )
    expect(rowAnchor("", "bài  viết\nhôm qua")).toBe("post:bài viết hôm qua||")
    expect(existingPostAnchor("")).toBe("")
    expect(existingPostAnchor(post)).toBe("post:123456789012345_987654321098765")
    expect(rowAnchor("", "")).toBe("")
    expect(rowAnchor("", undefined)).toBe("")
    expect(rowAnchor("", "", { name: "A", account: "act_1" })).toBe("")
    // two rows of the same post differ by their creative name / account (normalised: one line, no "|", ≤ 100)
    const a1 = rowAnchor("", post, { name: " Bài A‮ ", account: "act_1" })
    const a2 = rowAnchor("", post, { name: "Bài B", account: "act_1" })
    expect(a1).toBe("post:123456789012345_987654321098765|Bài A|act_1")
    expect(a2).not.toBe(a1)
    expect(
      rowAnchor("", post, { name: "x|y\n z", account: "a".repeat(150) })
    ).toBe(`post:123456789012345_987654321098765|x y z|${"a".repeat(100)}`)
    // a Drive link anchor never carries them
    expect(
      rowAnchor(`https://drive.google.com/file/d/${FILE}/view`, post, {
        name: "Bài A",
        account: "act_1",
      })
    ).toBe(FILE)
    // the anchor round-trips through canonicalExpectedAnchor (idempotent), link cells as before
    for (const a of [
      rowAnchor("", post),
      rowAnchor("", "bài viết hôm qua"),
      a1,
      rowAnchor("", post, { name: "x|y\n z", account: "a  b" }),
      FILE,
    ])
      expect(canonicalExpectedAnchor(a)).toBe(a)
    expect(
      canonicalExpectedAnchor(
        `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-x`
      )
    ).toBe(FILE)
    expect(canonicalExpectedAnchor(" post:1_2 ")).toBe("post:1_2")
  })

  it("mapColumns: the welcome message column is mapped, or detected by name next to the cover without reusing a cell", () => {
    const header = [
      "Link Drive",
      "Nội dung",
      "Ảnh bìa",
      "Câu chào",
      "Lời chào tin nhắn",
    ]
    const mapped = normalizeSheetConfig({
      columns: { link: "Link Drive", welcomeMessage: "câu chào" },
    })
    expect(mapColumns(mapped, header)).toMatchObject({
      link: 0,
      welcomeMessage: 3,
      cover: 2,
    })
    // a config saved before v1.1.3 → detected ("Lời chào tin nhắn" is the first alias, it wins over "Câu chào")
    const legacy = normalizeSheetConfig({
      columns: { link: "Link Drive", content: "Nội dung" },
    })
    expect(legacy.columns.welcomeMessage).toBeNull()
    expect(mapColumns(legacy, header)).toEqual({
      link: 0,
      content: 1,
      cover: 2,
      welcomeMessage: 4,
    })
    // a cell mapped to another column is never taken; no welcome-like header → absent
    const taken = normalizeSheetConfig({
      columns: { link: "Link Drive", content: "Lời chào" },
    })
    expect(mapColumns(taken, ["Link Drive", "Lời chào"])).toEqual({
      link: 0,
      content: 1,
    })
    expect(
      mapColumns(legacy, ["Link Drive", "Tin nhắn"]).welcomeMessage
    ).toBeUndefined()
  })

  it("mapColumns: the existing post column is mapped, or detected by name - never the system column Link bài viết", () => {
    const header = [
      "Link Drive",
      "Link bài viết",
      "Lời chào tin nhắn",
      "Post ID",
      "Bài viết có sẵn",
    ]
    const mapped = normalizeSheetConfig({
      columns: {
        link: "Link Drive",
        postLink: "Link bài viết",
        existingPost: "post id",
      },
    })
    expect(mapColumns(mapped, header)).toMatchObject({
      link: 0,
      postLink: 1,
      existingPost: 3,
      welcomeMessage: 2,
    })
    // a config saved before v1.1.4 → detected ("Bài viết có sẵn" is the first alias, it wins over "Post ID")
    const legacy = normalizeSheetConfig({
      columns: { link: "Link Drive", postLink: "Link bài viết" },
    })
    expect(legacy.columns.existingPost).toBeNull()
    expect(mapColumns(legacy, header)).toEqual({
      link: 0,
      postLink: 1,
      welcomeMessage: 2,
      existingPost: 4,
    })
    // "Link bài viết" / plain "Bài viết" are never taken as the existing post
    expect(
      mapColumns(legacy, ["Link Drive", "Link bài viết", "Bài viết"])
        .existingPost
    ).toBeUndefined()
    expect(
      mapColumns(normalizeSheetConfig({ columns: { link: "Link Drive" } }), [
        "Link Drive",
        "Link bài viết",
      ]).existingPost
    ).toBeUndefined()
    // a generic "Post ID" / "ID bài viết" / "Mã bài viết" column is never auto-detected (only a confirmed mapping)
    for (const generic of ["Post ID", "ID bài viết", "Mã bài viết"])
      expect(
        mapColumns(legacy, ["Link Drive", generic]).existingPost,
        generic
      ).toBeUndefined()
  })

  it("mapColumns: a mapped cover column is used; without a mapping a header named like a cover column is detected", () => {
    const header = [
      "Link Drive",
      "Tên creative",
      "ẢNH BÌA",
      "Thumbnail",
      "Trạng thái",
    ]
    // mapped (any spelling of the configured name)
    const mapped = normalizeSheetConfig({
      columns: { link: "Link Drive", cover: "thumbnail" },
    })
    expect(mapColumns(mapped, header)).toMatchObject({ link: 0, cover: 3 })
    // a config saved before v1.1.2 (no cover key) → detected by name ("Ảnh bìa" wins over "Thumbnail")
    const legacy = normalizeSheetConfig({
      columns: {
        link: "Link Drive",
        name: "Tên creative",
        status: "Trạng thái",
      },
    })
    expect(legacy.columns.cover).toBeNull()
    expect(mapColumns(legacy, header)).toEqual({
      link: 0,
      name: 1,
      cover: 2,
      status: 4,
    })
    // a mapped cover header that is gone from the sheet → detection too
    const gone = normalizeSheetConfig({
      columns: { link: "Link Drive", cover: "Ảnh cũ" },
    })
    expect(mapColumns(gone, ["Link Drive", "anh bia video"]).cover).toBe(1)
    // a header cell already used by another column is never taken; no cover-like header → no cover
    const taken = normalizeSheetConfig({
      columns: { link: "Thumbnail" },
    })
    expect(mapColumns(taken, ["Thumbnail", "Tên"])).toEqual({ link: 0 })
    expect(mapColumns(legacy, ["Link Drive", "Ảnh", "File"]).cover).toBe(
      undefined
    )
  })

  it("statusFilter: default pending = its aliases + empty; a status matches every spelling; custom values by text", () => {
    const pending = statusFilter("Chờ lên")
    for (const v of [
      "",
      " ",
      "Chờ lên",
      "chua tao ads",
      "Chưa tạo",
      "CHƯA LÊN",
    ])
      expect(pending(v), v).toBe(true)
    for (const v of ["Đã lên", "Đã tạo ads", "Lỗi", "Tạm dừng"])
      expect(pending(v), v).toBe(false)
    const done = statusFilter("đã tạo")
    expect(["Đã lên", "Đã tạo ads", "da tao", "", "Chờ lên"].map(done)).toEqual(
      [true, true, true, false, false]
    )
    expect(statusFilter("Lỗi")("loi")).toBe(true)
    expect(statusFilter("Đang xử lý")("dang  xu ly")).toBe(true)
    const custom = statusFilter("Tạm dừng")
    expect(["tam dung", "Tạm  dừng", "Đã lên", ""].map(custom)).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(["", "Chờ lên"].map(statusFilter(""))).toEqual([true, false])
    expect(statusFilter(null)("anything")).toBe(true)
  })
})
