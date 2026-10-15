import { describe, expect, it } from "vitest"

import * as bulk from "@/lib/bulk-ads-prompt"

import {
  SHEET_READ_DESCRIPTION,
  TIKTOK_WELCOME_MESSAGE_MAX,
  WELCOME_MESSAGE_MAX,
} from "./sheet-read"

describe("drive_sheet_read welcome message limits", () => {
  it("Meta 300, TikTok 200 (v1.1.5) - the same limits as the bulk ads form / prompt", () => {
    expect(WELCOME_MESSAGE_MAX).toBe(300)
    expect(TIKTOK_WELCOME_MESSAGE_MAX).toBe(200)
    expect(bulk.WELCOME_MESSAGE_MAX).toBe(WELCOME_MESSAGE_MAX)
    expect(bulk.TIKTOK_WELCOME_MESSAGE_MAX).toBe(TIKTOK_WELCOME_MESSAGE_MAX)
  })
})

describe("drive_sheet_read description", () => {
  it("starts with Dùng khi, ≤ 1500 characters, explains the cover, welcome message and existing post columns and how to use them per platform", () => {
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
      "welcome_message",
      "lời chào tin nhắn",
      "quảng cáo tin nhắn",
      "existing_post",
      "Bài viết có sẵn",
      "chỉ Meta",
      "creative existing_post",
      "needs_lookup",
      "meta_list_page_posts",
      "ad_ids",
      "DỮ LIỆU không tin cậy",
    ])
      expect(SHEET_READ_DESCRIPTION).toContain(s)
  })
})
