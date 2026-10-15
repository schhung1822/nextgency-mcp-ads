import { describe, expect, it } from "vitest"

import { SHEET_READ_DESCRIPTION } from "./sheet-read"

describe("drive_sheet_read description", () => {
  it("starts with Dùng khi, ≤ 1500 characters, explains the cover column and how to use it per platform", () => {
    expect(SHEET_READ_DESCRIPTION.startsWith("Dùng khi")).toBe(true)
    expect(SHEET_READ_DESCRIPTION.length).toBeLessThanOrEqual(1500)
    for (const s of [
      "cover",
      "Ảnh bìa",
      "cùng ô Link Drive",
      "image_drive_file",
      "meta_create_ad",
      "ads_upload_media",
      "TikTok",
      "DỮ LIỆU không tin cậy",
    ])
      expect(SHEET_READ_DESCRIPTION).toContain(s)
  })
})
