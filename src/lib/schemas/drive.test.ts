import { describe, expect, it } from "vitest"

import {
  AUTO_DETECT_ALIASES,
  AUTO_DETECT_COLUMN_KEYS,
  createDriveSourceSchema,
  detectAutoHeader,
  detectCoverHeader,
  googleApiKeySchema,
  headerIndex,
  listDriveSourceFilesSchema,
  normalizeHeader,
  previewDriveSourceSchema,
  saveSystemDriveCredentialSchema,
  SHEET_COLUMN_ALIASES,
  SHEET_COLUMN_KEYS,
  SHEET_WRITABLE_COLUMN_KEYS,
  sheetColumnsSchema,
  suggestSheetColumns,
  updateDriveSourceSchema,
} from "./drive"

const KEY = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K_L-M3n4O5p6Q"
const UUID = "0199a5c8-0000-7000-8000-000000000001"

describe("Google Drive schemas", () => {
  it("API key: AIza + 35 chars only", () => {
    expect(googleApiKeySchema.safeParse(KEY).success).toBe(true)
    expect(googleApiKeySchema.safeParse(KEY.slice(0, -1)).success).toBe(false)
    expect(googleApiKeySchema.safeParse("sk-" + KEY.slice(3)).success).toBe(
      false
    )
  })

  it("system credential save: write-only fields ('' = keep), conflict refused, re-auth fields required", () => {
    const r = saveSystemDriveCredentialSchema.parse({
      serviceAccountJson: "",
      apiKey: "",
      password: "pw",
    })
    expect(r).toMatchObject({
      serviceAccountJson: undefined,
      apiKey: undefined,
      clearApiKey: false,
    })
    expect(
      saveSystemDriveCredentialSchema.safeParse({ apiKey: KEY }).success
    ).toBe(false) // no password
    const bad = saveSystemDriveCredentialSchema.safeParse({
      apiKey: KEY,
      clearApiKey: true,
      password: "pw",
    })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(["apiKey"])
    expect(
      saveSystemDriveCredentialSchema.safeParse({
        apiKey: "nope",
        password: "pw",
      }).success
    ).toBe(false)
  })

  it("sources: kind / scope / link required, names without control or bidi characters, bounded config", () => {
    expect(
      previewDriveSourceSchema.safeParse({
        kind: "folder",
        scope: "personal",
        link: "",
      }).success
    ).toBe(false)
    expect(
      previewDriveSourceSchema.safeParse({
        kind: "doc",
        scope: "personal",
        link: "x",
      }).success
    ).toBe(false)
    const ok = createDriveSourceSchema.parse({
      kind: "folder",
      scope: "company",
      link: " https://x ",
      name: "",
    })
    expect(ok).toMatchObject({ link: "https://x", name: undefined })
    expect(
      createDriveSourceSchema.safeParse({
        kind: "folder",
        scope: "company",
        link: "x",
        name: "a‮b",
      }).success
    ).toBe(false)
    expect(
      createDriveSourceSchema.safeParse({
        kind: "folder",
        scope: "company",
        link: "x",
        recursiveDepth: 4,
      }).success
    ).toBe(false)
    expect(
      updateDriveSourceSchema.safeParse({ sourceId: UUID, headerRow: 0 })
        .success
    ).toBe(false)
    expect(updateDriveSourceSchema.safeParse({ sourceId: "x" }).success).toBe(
      false
    )
    expect(listDriveSourceFilesSchema.parse({ sourceId: UUID }).family).toBe(
      "all"
    )
    expect(
      listDriveSourceFilesSchema.safeParse({ sourceId: UUID, folderId: "../x" })
        .success
    ).toBe(false)
  })

  it("sheet columns: link required, empty → null, one header per logical column", () => {
    expect(sheetColumnsSchema.safeParse({ link: "" }).success).toBe(false)
    expect(
      sheetColumnsSchema.parse({ link: "Link Drive", status: "" })
    ).toMatchObject({ link: "Link Drive", status: null, note: null })
    const dup = sheetColumnsSchema.safeParse({
      link: "Link Drive",
      note: "link  drive",
    })
    expect(dup.success).toBe(false)
    expect(dup.error?.issues[0]?.path).toEqual(["note"])
  })

  it("sheet columns: optional Link bài viết / Link chiến dịch (system-written), duplicates refused", () => {
    expect(sheetColumnsSchema.parse({ link: "Link Drive" })).toMatchObject({
      postLink: null,
      campaignLink: null,
    })
    expect(
      sheetColumnsSchema.parse({
        link: "Link Drive",
        postLink: " Link bài viết ",
        campaignLink: "Link chiến dịch",
      })
    ).toMatchObject({
      postLink: "Link bài viết",
      campaignLink: "Link chiến dịch",
    })
    const dup = sheetColumnsSchema.safeParse({
      link: "Link Drive",
      postLink: "Link",
      campaignLink: "LINK",
    })
    expect(dup.success).toBe(false)
    expect(dup.error?.issues[0]?.path).toEqual(["campaignLink"])
    expect(SHEET_WRITABLE_COLUMN_KEYS).toEqual(
      expect.arrayContaining(["postLink", "campaignLink"])
    )
  })
})

describe("sheet column mapping helpers", () => {
  it("normalizeHeader: trim, lower case, Vietnamese diacritics and đ stripped, spaces collapsed", () => {
    expect(normalizeHeader("  Tài khoản   QC ")).toBe("tai khoan qc")
    expect(normalizeHeader("ĐƯỜNG dẫn")).toBe("duong dan")
  })

  it("suggestSheetColumns maps the template headers (any spelling) and uses each cell once", () => {
    const s = suggestSheetColumns([
      "Link drive",
      "TÊN CREATIVE",
      "Nền tảng",
      "tkqc",
      "Trạng thái",
      "Ghi chú",
      "Cập nhật lúc",
      "",
    ])
    expect(s).toMatchObject({
      link: "Link drive",
      name: "TÊN CREATIVE",
      platform: "Nền tảng",
      account: "tkqc",
      status: "Trạng thái",
      note: "Ghi chú",
      updatedAt: "Cập nhật lúc",
      mediaId: null,
      adIds: null,
    })
    expect(suggestSheetColumns([]).link).toBeNull()
    // the link columns: by name (any spelling); a plain "Chiến dịch" / "Bài viết" column is never taken for them
    expect(
      suggestSheetColumns([
        "Link Drive",
        "Chiến dịch",
        "Bài viết",
        "LINK BÀI VIẾT",
        "link  chiến dịch",
      ])
    ).toMatchObject({
      link: "Link Drive",
      postLink: "LINK BÀI VIẾT",
      campaignLink: "link  chiến dịch",
    })
    expect(suggestSheetColumns(["Link Drive", "Chiến dịch"])).toMatchObject({
      campaignLink: null,
      postLink: null,
    })
    expect(headerIndex(["A", "Trạng Thái"], "trang thai")).toBe(1)
    expect(headerIndex(["A"], "")).toBe(-1)
  })

  it("cover column (v1.1.2): optional, read only, suggested and detected by name, no alias shared with another column", () => {
    expect(SHEET_COLUMN_KEYS).toContain("cover")
    expect(SHEET_WRITABLE_COLUMN_KEYS).not.toContain("cover")
    expect(
      sheetColumnsSchema.parse({ link: "Link Drive", cover: " Ảnh bìa " })
    ).toMatchObject({ cover: "Ảnh bìa" })
    expect(sheetColumnsSchema.parse({ link: "Link Drive" }).cover).toBeNull()
    const dup = sheetColumnsSchema.safeParse({
      link: "Link Drive",
      cover: "link drive",
    })
    expect(dup.success).toBe(false)
    expect(dup.error?.issues[0]?.path).toEqual(["cover"])
    // every alias is already normalised and belongs to exactly one column
    const owner = new Map<string, string>()
    for (const k of SHEET_COLUMN_KEYS)
      for (const a of SHEET_COLUMN_ALIASES[k]) {
        expect(normalizeHeader(a), a).toBe(a)
        expect(owner.get(a), `${a}: ${k} / ${owner.get(a)}`).toBeUndefined()
        owner.set(a, k)
      }
    for (const spelling of [
      "Ảnh bìa",
      "anh bia",
      "THUMBNAIL",
      "Cover",
      "Ảnh thumbnail",
      "Ảnh đại diện video",
    ])
      expect(
        suggestSheetColumns(["Link Drive", "File", spelling, "Tên creative"]),
        spelling
      ).toMatchObject({
        link: "Link Drive",
        cover: spelling,
        name: "Tên creative",
      })
    // "File" / "Link file" stay link aliases, never the cover
    expect(suggestSheetColumns(["Link file", "Tên"])).toMatchObject({
      link: "Link file",
      cover: null,
    })
    expect(detectCoverHeader(["Link Drive", "Thumbnail", "Ảnh bìa"])).toBe(2)
    expect(detectCoverHeader(["Ảnh bìa", "Thumbnail"], new Set([0]))).toBe(1)
    expect(detectCoverHeader(["Link Drive", "Ảnh", "Ảnh đại diện"])).toBe(-1)
  })

  it("welcome message column (v1.1.3): optional, read only, right after Link đích, suggested and detected by name", () => {
    const at = SHEET_COLUMN_KEYS.indexOf("welcomeMessage")
    expect(SHEET_COLUMN_KEYS[at - 1]).toBe("destination")
    // v1.1.4: the existing post column follows it, then the system columns
    expect(SHEET_COLUMN_KEYS[at + 1]).toBe("existingPost")
    expect(SHEET_WRITABLE_COLUMN_KEYS).not.toContain("welcomeMessage")
    expect(
      sheetColumnsSchema.parse({
        link: "Link Drive",
        welcomeMessage: " Lời chào tin nhắn ",
      })
    ).toMatchObject({ welcomeMessage: "Lời chào tin nhắn" })
    expect(
      sheetColumnsSchema.parse({ link: "Link Drive" }).welcomeMessage
    ).toBeNull()
    const dup = sheetColumnsSchema.safeParse({
      link: "Link Drive",
      content: "Câu chào",
      welcomeMessage: "cau chao",
    })
    expect(dup.success).toBe(false)
    expect(dup.error?.issues[0]?.path).toEqual(["welcomeMessage"])
    for (const spelling of [
      "Lời chào tin nhắn",
      "LỜI CHÀO",
      "Câu chào",
      "Tin nhắn chào",
      "Welcome message",
      "Greeting",
    ])
      expect(
        suggestSheetColumns(["Link Drive", "Nội dung", spelling, "Tiêu đề"]),
        spelling
      ).toMatchObject({
        content: "Nội dung",
        headline: "Tiêu đề",
        welcomeMessage: spelling,
      })
    // "Tin nhắn" / "Message" alone are never the welcome message (Meta calls the primary text "message")
    expect(
      suggestSheetColumns(["Link Drive", "Tin nhắn", "Message"]).welcomeMessage
    ).toBeNull()
    expect(
      detectAutoHeader("welcomeMessage", ["Link Drive", "Câu chào", "Lời chào"])
    ).toBe(2)
    expect(
      detectAutoHeader("welcomeMessage", ["Lời chào", "Câu chào"], new Set([0]))
    ).toBe(1)
    expect(detectAutoHeader("welcomeMessage", ["Link Drive", "Tin nhắn"])).toBe(
      -1
    )
    // the cover wrapper still answers for the cover column only
    expect(detectAutoHeader("cover", ["Lời chào", "Ảnh bìa"])).toBe(
      detectCoverHeader(["Lời chào", "Ảnh bìa"])
    )
  })

  it("existing post column (v1.1.4): optional, read only, before Trạng thái, suggested and detected by name, never the Link bài viết column", () => {
    expect(AUTO_DETECT_COLUMN_KEYS).toEqual([
      "cover",
      "welcomeMessage",
      "existingPost",
    ])
    const at = SHEET_COLUMN_KEYS.indexOf("existingPost")
    expect(SHEET_COLUMN_KEYS[at - 1]).toBe("welcomeMessage")
    expect(SHEET_COLUMN_KEYS[at + 1]).toBe("status")
    expect(SHEET_WRITABLE_COLUMN_KEYS).not.toContain("existingPost")
    expect(
      sheetColumnsSchema.parse({
        link: "Link Drive",
        existingPost: " Bài viết có sẵn ",
      })
    ).toMatchObject({ existingPost: "Bài viết có sẵn" })
    expect(
      sheetColumnsSchema.parse({ link: "Link Drive" }).existingPost
    ).toBeNull()
    const dup = sheetColumnsSchema.safeParse({
      link: "Link Drive",
      postLink: "Post ID",
      existingPost: "post id",
    })
    expect(dup.success).toBe(false)
    // the later key of the schema (the system column) carries the error
    expect(dup.error?.issues[0]?.path).toEqual(["postLink"])
    for (const spelling of [
      "Bài viết có sẵn",
      "BÀI CÓ SẴN",
      "ID bài viết",
      "Mã bài viết",
      "Post ID",
      "Existing post",
      "Bài viết gốc",
      "Link bài viết gốc",
    ])
      expect(
        suggestSheetColumns([
          "Link Drive",
          spelling,
          "Link bài viết",
          "Link chiến dịch",
        ]),
        spelling
      ).toMatchObject({
        link: "Link Drive",
        existingPost: spelling,
        postLink: "Link bài viết",
        campaignLink: "Link chiến dịch",
      })
    // "Link bài viết" stays the system-written post link; plain "Bài viết" is neither
    expect(
      suggestSheetColumns(["Link Drive", "Link bài viết", "Bài viết"])
    ).toMatchObject({ postLink: "Link bài viết", existingPost: null })
    expect(
      detectAutoHeader("existingPost", ["Link Drive", "Post ID", "Bài viết có sẵn"])
    ).toBe(2)
    // silent auto-detect only knows the unambiguous names - "Post ID" / "ID bài viết" / "Mã bài viết" are only
    // suggested (the user confirms the mapping), never auto-detected
    for (const generic of ["Post ID", "ID bài viết", "Mã bài viết"])
      expect(
        detectAutoHeader("existingPost", ["Link Drive", generic]),
        generic
      ).toBe(-1)
    expect(
      detectAutoHeader("existingPost", ["Bài viết có sẵn", "Post ID"], new Set([0]))
    ).toBe(-1)
    for (const strong of [
      "Bài viết có sẵn",
      "bai viet co san",
      "Bài có sẵn",
      "Bài viết gốc",
      "Link bài viết gốc",
      "Existing post",
    ])
      expect(
        detectAutoHeader("existingPost", ["Link Drive", strong]),
        strong
      ).toBe(1)
    // the auto-detect list is a subset of the suggestion aliases; other columns keep their full alias list
    for (const a of AUTO_DETECT_ALIASES.existingPost!)
      expect(SHEET_COLUMN_ALIASES.existingPost).toContain(a)
    expect(AUTO_DETECT_ALIASES.cover).toBeUndefined()
    expect(AUTO_DETECT_ALIASES.welcomeMessage).toBeUndefined()
    expect(
      detectAutoHeader("existingPost", ["Link Drive", "Link bài viết", "Bài viết"])
    ).toBe(-1)
  })
})
