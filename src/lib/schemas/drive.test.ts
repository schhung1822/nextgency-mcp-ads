import { describe, expect, it } from "vitest"

import {
  createDriveSourceSchema,
  googleApiKeySchema,
  headerIndex,
  listDriveSourceFilesSchema,
  normalizeHeader,
  previewDriveSourceSchema,
  saveSystemDriveCredentialSchema,
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
})
