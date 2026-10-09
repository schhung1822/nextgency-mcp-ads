// drive_sheet_update_rows (15-google-drive-media.md §9.3, GD2): write status / result columns of a granted sheet.
// No two-step confirmation (no ad / money is touched), but: the sheet must enable write-back, the MCP setting
// drive_sheet_writeback must be on and the MCP must be allowed to "create" on ≥ 1 platform; ONLY the mapped
// system columns (Trạng thái, Mã media, Mã quảng cáo, Ghi chú hệ thống, Cập nhật lúc) present in the header are written,
// valueInputOption=RAW (formulas are stored as text); every row is re-read fresh first and skipped (row_moved) when its
// link cell no longer matches expected_link. Every cell change is logged before → after in mcp_call_logs.
// Limits (security review L2): one executed write counts against the MCP write limit (write_rate_limit_per_10min) and
// every Sheets call against the per-MCP Sheets budget. Values (L7): ids must look like ids, a note starting with
// = + - @ is neutralised (CSV / formula injection when the sheet is exported).
import { z } from "zod"
import { sanitizeExternalLabel } from "../../../../lib/text-safety"
import { DriveError } from "../../../drive/errors"
import {
  a1Cell,
  getSheetMeta,
  readSheetRows,
  writeSheetCells,
} from "../../../drive/sheets"
import {
  SHEET_STATUS,
  SHEET_WRITABLE_COLUMNS,
  type SheetCellUpdate,
  type SheetRow,
  type SheetSourceConfig,
  type SheetStatusKey,
} from "../../../drive/types"
import type { FieldChange } from "../../../providers/types"
import { assertDriveSource, driveCall, sourceAccess } from "../../drive-access"
import { denied, invalid } from "../../errors"
import { admitWrite, registerToolSpec, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"
import {
  canonicalLinkCell,
  mapColumns,
  nameLabel,
  neutralizeFormula,
  sanitizeCell,
  SHEET_ID_RE,
  takeMcpSheetsBudget,
  type SheetColumnKey,
} from "./shared"

export const NAME = "drive_sheet_update_rows"

/** rows re-read in one Sheets call at most (the requested rows are grouped into windows of this span) */
const READ_WINDOW = 1_000
const MAX_WINDOWS = 5
const NOTE_MAX = 500

/** sends a write to Google (not read-only), only status cells (not destructive), same values again = same result */
export const UPDATE_ROWS_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

const STATUS_KEYS = Object.keys(SHEET_STATUS) as [
  SheetStatusKey,
  ...SheetStatusKey[],
]

const rowInput = z.object({
  row_number: z
    .number()
    .int()
    .min(2)
    .max(10_000_000)
    .describe("row_number từ drive_sheet_read"),
  expected_link: z
    .string()
    .max(4_000)
    .describe(
      "link_cell của dòng đó từ drive_sheet_read (chống ghi nhầm dòng)"
    ),
  status: z
    .enum(STATUS_KEYS)
    .describe(
      'pending = "Chờ lên", processing = "Đang xử lý", done = "Đã lên", error = "Lỗi"'
    ),
  media_id: z
    .string()
    .trim()
    .max(200)
    .regex(SHEET_ID_RE, "media_id không hợp lệ")
    .optional()
    .describe("Mã media (từ ads_upload_media)"),
  ad_ids: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(SHEET_ID_RE, "Mã quảng cáo không hợp lệ")
    )
    .max(20)
    .optional()
    .describe("Mã quảng cáo đã tạo"),
  note: z
    .string()
    .max(NOTE_MAX)
    .optional()
    .describe("Ghi chú ngắn (vd lý do lỗi)"),
})

const output = z.object({
  sheet: z.object({ source_id: z.string(), name: z.string(), tab: z.string() }),
  updated: z.array(z.object({ row_number: z.number(), cells: z.number() })),
  skipped: z.array(
    z.object({ row_number: z.number(), code: z.string(), message: z.string() })
  ),
  written_at: z.string(),
})

/** "09/10/2026 14:05 · MCP <name>" (Asia/Ho_Chi_Minh) - the "Cập nhật lúc" value. */
export function updatedAtStamp(mcpName: string, now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  )
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} · MCP ${sanitizeExternalLabel(mcpName, 64) ?? ""}`.trim()
}

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Ghi trạng thái vào Google Sheet",
    description:
      "Dùng khi đã xử lý xong các dòng đọc bằng drive_sheet_read (tải media, tạo quảng cáo) để ghi kết quả ngược vào sheet: mỗi dòng {row_number, expected_link = link_cell từ drive_sheet_read, status pending|processing|done|error, media_id?, ad_ids?, note?}, tối đa 50 dòng mỗi lần. Chỉ ghi các cột hệ thống (Trạng thái, Mã media, Mã quảng cáo, Ghi chú hệ thống, Cập nhật lúc); không bao giờ sửa cột khác. Dòng đã bị chèn / xoá / sắp xếp lại (link không còn khớp expected_link) bị bỏ qua với code row_moved - đọc lại sheet rồi ghi lại. Cần sheet bật ghi trạng thái (drive_list_sources: writeback = true). Mỗi lần ghi tính vào giới hạn thao tác ghi của MCP - gộp nhiều dòng vào một lần gọi. Chỉ ghi kết quả thật của việc đã làm.",
    kind: "write",
    annotations: UPDATE_ROWS_ANNOTATIONS,
    input: z.object({
      source_id: z
        .string()
        .trim()
        .max(64)
        .describe("source_id của sheet lấy từ drive_list_sources"),
      rows: z.array(rowInput).min(1).max(50),
    }),
    output,
    // expected_link may carry Drive resource keys / signed URLs: only the canonical form is logged
    logArgs: (args) => ({
      ...args,
      rows: args.rows.map((r) => ({
        ...r,
        expected_link: canonicalLinkCell(r.expected_link),
      })),
    }),
    async handler(args, env) {
      const { grant } = env
      const source = assertDriveSource(grant, args.source_id, "sheet")
      env.log.setTarget({ objectIds: [source.id] })
      const cfg = source.config as SheetSourceConfig
      // re-check every gate on every call
      if (!cfg.writeback)
        throw driveDenied(new DriveError("writeback_disabled"))
      if (!grant.settings.driveSheetWriteback) {
        throw denied(
          "drive_writeback_disabled",
          "MCP này không được phép ghi trạng thái vào Google Sheet.",
          'Chủ MCP bật "Cho phép ghi trạng thái vào Google Sheet" trong cấu hình MCP.'
        )
      }
      if (grantPlatformsWith(grant, "create").length === 0) {
        throw denied(
          "permission_denied",
          'Ghi trạng thái sheet cần quyền "Tạo mới" trên ít nhất một nền tảng quảng cáo.',
          "Quyền được cấu hình trong trang MCP của Ads MCP."
        )
      }
      const seen = new Set<number>()
      for (const r of args.rows) {
        if (seen.has(r.row_number))
          throw invalid(
            "invalid_request",
            `Dòng ${r.row_number} xuất hiện hai lần.`
          )
        if (r.row_number <= cfg.headerRow)
          throw invalid(
            "invalid_request",
            `Dòng ${r.row_number} là dòng tiêu đề hoặc nằm trên dòng tiêu đề.`
          )
        seen.add(r.row_number)
      }

      const { auth } = await driveCall(() => sourceAccess(source))
      takeMcpSheetsBudget(grant, "read")
      const meta = await driveCall(() =>
        getSheetMeta(auth, source.googleId, source.sheetGid!, env.signal)
      )

      // 1. fresh read of the requested rows (+ header), grouped into windows
      const numbers = [...seen].sort((a, b) => a - b)
      const windows: { from: number; to: number }[] = []
      for (const n of numbers) {
        const last = windows[windows.length - 1]
        if (last && n - last.from < READ_WINDOW) last.to = n
        else windows.push({ from: n, to: n })
      }
      if (windows.length > MAX_WINDOWS)
        throw invalid(
          "invalid_request",
          "Các dòng cách nhau quá xa - ghi thành nhiều lần, mỗi lần các dòng gần nhau."
        )
      const rowsByNumber = new Map<number, SheetRow>()
      let header: string[] = []
      for (const win of windows) {
        takeMcpSheetsBudget(grant, "read")
        const read = await driveCall(() =>
          readSheetRows(auth, source.googleId, meta.title, {
            headerRow: cfg.headerRow,
            startRow: win.from,
            maxRows: win.to - win.from + 1,
            fresh: true,
            signal: env.signal,
          })
        )
        header = read.header
        for (const row of read.rows) rowsByNumber.set(row.rowNumber, row)
      }
      const cols = mapColumns(cfg, header)
      if (cols.link === undefined || cols.status === undefined) {
        throw invalid(
          "drive_invalid_sheet",
          `Sheet thiếu cột "${nameLabel(cols.link === undefined ? cfg.columns.link : (cfg.columns.status ?? "Trạng thái"))}" ở dòng tiêu đề ${cfg.headerRow}.`,
          "Kiểm tra dòng tiêu đề và ánh xạ cột ở Kết nối → Google Drive."
        )
      }

      // 2. cells to write (only mapped writable columns that exist in the header)
      const stamp = updatedAtStamp(grant.mcpName)
      const updates: SheetCellUpdate[] = []
      const changes: FieldChange[] = []
      const updated: { row_number: number; cells: number }[] = []
      const skipped: { row_number: number; code: string; message: string }[] =
        []
      const sheetLabel = nameLabel(source.name)
      for (const r of args.rows) {
        const cells = rowsByNumber.get(r.row_number)?.cells ?? []
        const fresh = canonicalLinkCell(cells[cols.link] ?? "")
        if (!fresh || fresh !== canonicalLinkCell(r.expected_link)) {
          const d = new DriveError("row_moved")
          skipped.push({
            row_number: r.row_number,
            code: "row_moved",
            message: d.userMessageVi,
          })
          continue
        }
        const values: Partial<Record<SheetColumnKey, string>> = {
          status: SHEET_STATUS[r.status],
          ...(r.media_id !== undefined
            ? { mediaId: sanitizeExternalLabel(r.media_id, 200) ?? "" }
            : {}),
          ...(r.ad_ids !== undefined
            ? {
                adIds: r.ad_ids
                  .map((id) => sanitizeExternalLabel(id, 100) ?? "")
                  .filter(Boolean)
                  .join(", "),
              }
            : {}),
          ...(r.note !== undefined
            ? { note: neutralizeFormula(sanitizeCell(r.note).slice(0, NOTE_MAX)) }
            : {}),
          updatedAt: stamp,
        }
        let n = 0
        for (const key of SHEET_WRITABLE_COLUMNS) {
          const col = cols[key]
          const after = values[key]
          if (col === undefined || after === undefined) continue
          updates.push({
            range: a1Cell(meta.title, col + 1, r.row_number),
            values: [[after]],
          })
          changes.push({
            objectId: `${source.id}:${r.row_number}`,
            objectName: `${sheetLabel} · dòng ${r.row_number}`,
            field: nameLabel(header[col]),
            before: cells[col] ?? "",
            after,
          })
          n++
        }
        updated.push({ row_number: r.row_number, cells: n })
      }

      // 3. one RAW batchUpdate
      if (updates.length) {
        admitWrite(grant)
        takeMcpSheetsBudget(grant, "write")
        await driveCall(() =>
          writeSheetCells(auth, source.googleId, updates, env.signal)
        )
        env.log.setChanges(changes)
      }
      return {
        structured: {
          sheet: {
            source_id: source.id,
            name: sheetLabel,
            tab: nameLabel(meta.title),
          },
          updated,
          skipped,
          written_at: stamp,
        },
        summary:
          `Đã ghi trạng thái ${updated.length} dòng vào sheet "${sheetLabel}"` +
          (skipped.length
            ? `; bỏ qua ${skipped.length} dòng đã thay đổi (row_moved) - đọc lại sheet rồi ghi lại.`
            : "."),
      }
    },
  })
}

function driveDenied(e: DriveError) {
  return denied(`drive_${e.code}`, e.userMessageVi, e.hintVi ?? undefined)
}
