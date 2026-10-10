// Values of the Google Sheet "Trạng thái" column (.claude/docs/15-google-drive-media.md §9). Shared client/server,
// no imports. The system always WRITES the canonical values (SHEET_STATUS); when READING the column it also accepts
// the aliases below - accent / case / space-insensitive - so a sheet typed by hand ("Chưa tạo ads", "đã tạo"…) works
// as is. An empty cell reads as pending.

/** Canonical values written by drive_sheet_update_rows (what the media team sees). */
export const SHEET_STATUS = {
  pending: "Chờ lên",
  processing: "Đang xử lý",
  done: "Đã lên",
  error: "Lỗi",
} as const
export type SheetStatusKey = keyof typeof SHEET_STATUS

export const SHEET_STATUS_KEYS = Object.keys(SHEET_STATUS) as [
  SheetStatusKey,
  ...SheetStatusKey[],
]

/** Accepted spellings per status when reading (canonical value first). An empty cell is pending too. */
export const SHEET_STATUS_ALIASES: Readonly<
  Record<SheetStatusKey, readonly string[]>
> = {
  pending: ["Chờ lên", "Chưa tạo ads", "Chưa tạo", "Chưa lên"],
  processing: ["Đang xử lý"],
  done: ["Đã lên", "Đã tạo ads", "Đã tạo"],
  error: ["Lỗi"],
}

/** Comparison key of a status cell: no diacritics (đ → d), lower case, no whitespace at all. */
export function foldSheetStatus(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, "")
}

const BY_FOLD: ReadonlyMap<string, SheetStatusKey> = new Map(
  SHEET_STATUS_KEYS.flatMap((k) =>
    SHEET_STATUS_ALIASES[k].map((a) => [foldSheetStatus(a), k] as const)
  )
)

/** Status of a cell: an alias → its key, empty → "pending", anything else → null (a custom value). */
export function sheetStatusKey(
  raw: string | null | undefined
): SheetStatusKey | null {
  const f = foldSheetStatus(raw)
  if (f === "") return "pending"
  return BY_FOLD.get(f) ?? null
}

/**
 * Label a status cell is counted / shown under: an alias → the canonical value ("Chưa tạo ads" → "Chờ lên"), an
 * empty cell → "" (shown as "Trống"), a custom value → itself (trimmed).
 */
export function sheetStatusLabel(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim()
  if (!v) return ""
  const k = sheetStatusKey(v)
  return k ? SHEET_STATUS[k] : v
}
