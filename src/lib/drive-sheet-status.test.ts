import { describe, expect, it } from "vitest"

import {
  foldSheetStatus,
  SHEET_STATUS,
  SHEET_STATUS_ALIASES,
  SHEET_STATUS_KEYS,
  sheetStatusKey,
  sheetStatusLabel,
} from "./drive-sheet-status"

describe("sheet status aliases", () => {
  it("the canonical value comes first in every alias list", () => {
    for (const k of SHEET_STATUS_KEYS)
      expect(SHEET_STATUS_ALIASES[k][0]).toBe(SHEET_STATUS[k])
  })

  it("aliases → their status; accent / case / space-insensitive", () => {
    const cases: [string, string | null][] = [
      ["Chờ lên", "pending"],
      ["Chưa tạo ads", "pending"],
      ["chua tao ADS", "pending"],
      ["Chưa tạo", "pending"],
      ["  CHƯA   LÊN ", "pending"],
      ["chưalên", "pending"],
      ["Đã lên", "done"],
      ["da len", "done"],
      ["Đã tạo ads", "done"],
      ["ĐÃ TẠO", "done"],
      ["Đang xử lý", "processing"],
      ["dang xu ly", "processing"],
      ["Lỗi", "error"],
      ["LOI", "error"],
      // NFD input (macOS / some keyboards)
      ["Chờ lên".normalize("NFD"), "pending"],
    ]
    for (const [raw, want] of cases) expect(sheetStatusKey(raw), raw).toBe(want)
  })

  it("an empty cell is pending; any other value is unknown (null)", () => {
    expect(sheetStatusKey("")).toBe("pending")
    expect(sheetStatusKey("   ")).toBe("pending")
    expect(sheetStatusKey(null)).toBe("pending")
    expect(sheetStatusKey(undefined)).toBe("pending")
    for (const v of ["Tạm dừng", "Đã lên lịch", "Chưa", "Đã", "ok"])
      expect(sheetStatusKey(v), v).toBeNull()
  })

  it("sheetStatusLabel: aliases → the canonical value, empty → '', custom values kept", () => {
    expect(sheetStatusLabel("chưa tạo ads")).toBe("Chờ lên")
    expect(sheetStatusLabel("Đã tạo")).toBe("Đã lên")
    expect(sheetStatusLabel(" Lỗi ")).toBe("Lỗi")
    expect(sheetStatusLabel("  ")).toBe("")
    expect(sheetStatusLabel(" Tạm dừng ")).toBe("Tạm dừng")
  })

  it("foldSheetStatus drops diacritics (đ → d), case and every space", () => {
    expect(foldSheetStatus(" Đã  Tạo\tads ")).toBe("dataoads")
  })
})
