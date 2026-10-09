// Sheets v4 REST (https://sheets.googleapis.com/v4) - read rows, write status cells (RAW only).
// In-process budget DRIVE_LIMITS.sheetsReadsPerMin / sheetsWritesPerMin (Google: 60/min/user/project, and the whole
// install is ONE service account) → DriveError sheet_busy; read cache DRIVE_LIMITS.sheetReadCacheMs.
// No imports from "next/*".
import {
  DRIVE_TIMEOUTS,
  driveJson,
  SHEETS_API_BASE,
  type DriveRequest,
} from "./client"
import { DriveError, isDriveError } from "./errors"
import { isDriveId } from "./links"
import { takeSheetsQuota, type SheetsCallKind } from "./rate-limit"
import {
  DRIVE_LIMITS,
  type DriveAuth,
  type SheetCellUpdate,
  type SheetMeta,
  type SheetRead,
  type SheetRow,
} from "./types"

/** rows one readSheetRows call may ask for */
const MAX_ROWS_PER_READ = 1000
const MAX_RANGES_PER_CALL = 200
const MAX_UPDATES_PER_CALL = 500
const CACHE_MAX_ENTRIES = 500
const WRITE_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// A1 notation
// ---------------------------------------------------------------------------

/** 1 → "A", 27 → "AA". */
export function columnLetter(index1: number): string {
  if (!Number.isInteger(index1) || index1 < 1 || index1 > 18_278)
    throw new RangeError("column index out of range")
  let n = index1
  let out = ""
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** "'Tab name'" - single quotes inside the title doubled (always quoted: safe for any title). */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`
}

function assertRow(row1: number): void {
  if (!Number.isInteger(row1) || row1 < 1 || row1 > 10_000_000)
    throw new RangeError("row out of range")
}

/** "'Tab name'!F12" (single quotes inside the title doubled). */
export function a1Cell(title: string, column1: number, row1: number): string {
  assertRow(row1)
  return `${quoteSheetTitle(title)}!${columnLetter(column1)}${row1}`
}

/** "'Tab name'!3:52" (whole rows) */
export function a1Rows(
  title: string,
  fromRow1: number,
  toRow1: number
): string {
  assertRow(fromRow1)
  assertRow(toRow1)
  return `${quoteSheetTitle(title)}!${fromRow1}:${Math.max(fromRow1, toRow1)}`
}

// ---------------------------------------------------------------------------
// Cache + budget
// ---------------------------------------------------------------------------

const cache = new Map<string, { expiresAt: number; value: unknown }>()

/** reads are cached per credential: another credential may not have access to the same spreadsheet */
function authKey(auth: DriveAuth): string {
  return auth.type === "service_account" ? `sa:${auth.cacheKey}` : "api_key"
}

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return hit.value as T
}

function cacheSet(key: string, value: unknown): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, {
    expiresAt: Date.now() + DRIVE_LIMITS.sheetReadCacheMs,
    value,
  })
}

function invalidateSpreadsheet(spreadsheetId: string): void {
  const marker = `|${spreadsheetId}|`
  for (const k of [...cache.keys()]) if (k.includes(marker)) cache.delete(k)
}

/** tests */
export function __clearSheetsCache(): void {
  cache.clear()
}

/** budget, then the call; a Google 429 / rate-limit answer → sheet_busy too */
async function sheetsJson<T>(
  auth: DriveAuth,
  kind: SheetsCallKind,
  req: DriveRequest
): Promise<T> {
  takeSheetsQuota(kind)
  try {
    return await driveJson<T>(auth, req)
  } catch (e) {
    if (isDriveError(e) && e.code === "rate_limited")
      throw new DriveError("sheet_busy", { httpStatus: e.httpStatus })
    throw e
  }
}

function assertSpreadsheetId(id: string): void {
  if (!isDriveId(id)) throw new DriveError("invalid_link")
}

const spreadsheetUrl = (id: string) =>
  `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}`

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ""
  return typeof v === "string" ? v : String(v)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface RawSpreadsheet {
  properties?: { title?: unknown }
  sheets?: Array<{
    properties?: {
      sheetId?: unknown
      title?: unknown
      gridProperties?: { rowCount?: unknown }
    }
  }>
}

/** spreadsheets.get?fields=properties.title,sheets.properties(sheetId,title,gridProperties.rowCount) → tab by gid. */
export async function getSheetMeta(
  auth: DriveAuth,
  spreadsheetId: string,
  gid: number,
  signal?: AbortSignal
): Promise<SheetMeta> {
  assertSpreadsheetId(spreadsheetId)
  if (!Number.isInteger(gid) || gid < 0)
    throw new DriveError("sheet_tab_not_found")
  const key = `${authKey(auth)}|meta|${spreadsheetId}|`
  let raw = cacheGet<RawSpreadsheet>(key)
  if (!raw) {
    raw = await sheetsJson<RawSpreadsheet>(auth, "read", {
      url: spreadsheetUrl(spreadsheetId),
      query: {
        fields:
          "properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)",
      },
      signal,
      timeoutMs: DRIVE_TIMEOUTS.metadataMs,
    })
    cacheSet(key, raw)
  }
  const tab = (raw?.sheets ?? []).find((s) => s?.properties?.sheetId === gid)
  if (!tab?.properties) throw new DriveError("sheet_tab_not_found")
  const rowCount = tab.properties.gridProperties?.rowCount
  return {
    spreadsheetTitle: cellText(raw?.properties?.title),
    title: cellText(tab.properties.title),
    gid,
    rowCount:
      typeof rowCount === "number" && Number.isInteger(rowCount)
        ? rowCount
        : null,
  }
}

interface RawBatchGet {
  valueRanges?: Array<{ range?: unknown; values?: unknown }>
}

function rowsOf(vr: { values?: unknown } | undefined): unknown[][] {
  return Array.isArray(vr?.values)
    ? vr.values.map((r) => (Array.isArray(r) ? (r as unknown[]) : []))
    : []
}

function batchGetUrl(spreadsheetId: string, ranges: string[]): string {
  const qs = new URLSearchParams()
  for (const r of ranges) qs.append("ranges", r)
  return `${spreadsheetUrl(spreadsheetId)}/values:batchGet?${qs.toString()}`
}

/**
 * values:batchGet of the header row + up to `maxRows` data rows from `startRow` (FORMATTED_VALUE). Cells are
 * strings (missing → ""). `fresh` bypasses the read cache (write-back verification).
 */
export async function readSheetRows(
  auth: DriveAuth,
  spreadsheetId: string,
  title: string,
  opts: {
    headerRow: number
    startRow?: number
    maxRows: number
    fresh?: boolean
    signal?: AbortSignal
  }
): Promise<SheetRead> {
  assertSpreadsheetId(spreadsheetId)
  assertRow(opts.headerRow)
  const startRow = Math.max(
    opts.startRow ?? opts.headerRow + 1,
    opts.headerRow + 1
  )
  const maxRows = Math.min(
    MAX_ROWS_PER_READ,
    Math.max(1, Math.trunc(opts.maxRows))
  )
  const headerRange = a1Rows(title, opts.headerRow, opts.headerRow)
  const dataRange = a1Rows(title, startRow, startRow + maxRows - 1)
  const key = `${authKey(auth)}|rows|${spreadsheetId}|${headerRange}|${dataRange}`
  if (!opts.fresh) {
    const hit = cacheGet<SheetRead>(key)
    if (hit) return structuredClone(hit)
  }
  const raw = await sheetsJson<RawBatchGet>(auth, "read", {
    url: batchGetUrl(spreadsheetId, [headerRange, dataRange]),
    query: { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" },
    signal: opts.signal,
    timeoutMs: DRIVE_TIMEOUTS.metadataMs,
  })
  const header = (rowsOf(raw?.valueRanges?.[0])[0] ?? []).map(cellText)
  const data = rowsOf(raw?.valueRanges?.[1])
  const rows: SheetRow[] = []
  data.forEach((r, i) => {
    const cells = r.map(cellText)
    if (cells.some((c) => c.trim() !== ""))
      rows.push({ rowNumber: startRow + i, cells })
  })
  // Sheets omits trailing empty rows: a short answer means the data ends inside the range
  const out: SheetRead = {
    header,
    rows,
    nextRow: data.length < maxRows ? null : startRow + maxRows,
  }
  cacheSet(key, structuredClone(out))
  return out
}

/** Read specific single cells (A1 ranges, no cache) - used to verify a row did not move before writing. */
export async function readSheetCells(
  auth: DriveAuth,
  spreadsheetId: string,
  ranges: string[],
  signal?: AbortSignal
): Promise<string[]> {
  assertSpreadsheetId(spreadsheetId)
  if (ranges.length === 0) return []
  if (ranges.length > MAX_RANGES_PER_CALL)
    throw new RangeError("too many ranges")
  const raw = await sheetsJson<RawBatchGet>(auth, "read", {
    url: batchGetUrl(spreadsheetId, ranges),
    query: { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" },
    signal,
    timeoutMs: DRIVE_TIMEOUTS.metadataMs,
  })
  return ranges.map((_, i) => cellText(rowsOf(raw?.valueRanges?.[i])[0]?.[0]))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** values:batchUpdate with valueInputOption=RAW (formulas are stored as text, never evaluated). */
export async function writeSheetCells(
  auth: DriveAuth,
  spreadsheetId: string,
  updates: SheetCellUpdate[],
  signal?: AbortSignal
): Promise<void> {
  assertSpreadsheetId(spreadsheetId)
  if (updates.length === 0) return
  if (updates.length > MAX_UPDATES_PER_CALL)
    throw new RangeError("too many updates")
  try {
    await sheetsJson<unknown>(auth, "write", {
      url: `${spreadsheetUrl(spreadsheetId)}/values:batchUpdate`,
      method: "POST",
      json: {
        valueInputOption: "RAW",
        includeValuesInResponse: false,
        data: updates.map((u) => ({
          range: u.range,
          majorDimension: "ROWS",
          values: u.values.map((row) => row.map((v) => cellText(v))),
        })),
      },
      signal,
      timeoutMs: WRITE_TIMEOUT_MS,
    })
  } finally {
    // even a failed / timed-out write may have landed: never serve stale rows afterwards
    invalidateSpreadsheet(spreadsheetId)
  }
}
