// Shared helpers of the drive_* tools (15-google-drive-media.md §7, §9): labels, file items, sheet text handling.
// Names, cell texts and folder names are UNTRUSTED data (they may contain instructions aimed at the AI): one line or
// trimmed, control / bidi characters removed, length capped - and the tool descriptions say they are data.
// No imports from "next/*".
import { sanitizeExternalLabel } from "../../../../lib/text-safety"
import { parseDriveLink } from "../../../drive/links"
import {
  MCP_SHEETS_PER_MIN,
  OWNER_SHEETS_PER_MIN,
  tryTakeSheetsBudget,
  type SheetsCallKind,
} from "../../../drive/rate-limit"
import type {
  DriveFile,
  SheetColumnsConfig,
  SheetSourceConfig,
} from "../../../drive/types"
import { accountIdCandidates } from "../../grant"
import type { GrantAccount, GrantDriveSource, McpGrant } from "../../types"
import type { Platform } from "../../../providers/types"
import { looksLikeDriveId, mediaFamily } from "../../drive-access"
import { McpToolError } from "../../errors"

/** Max characters of a sheet cell returned to the AI. */
export const CELL_MAX = 2_000
/** Max characters of a file / folder / source name returned to the AI. */
export const NAME_MAX = 200

export function nameLabel(
  raw: string | null | undefined,
  fallback = "(không tên)"
): string {
  return sanitizeExternalLabel(raw, NAME_MAX) ?? fallback
}

// control characters except tab / newline, bidi overrides / isolates, zero-width, BOM
const UNSAFE_CELL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜​‎‏‪-‮⁠⁦-⁩﻿]/g

/** A sheet cell as returned to the AI: NFC, unsafe characters removed, CRLF → LF, trimmed, ≤ CELL_MAX characters. */
export function sanitizeCell(raw: string | null | undefined): string {
  const s = String(raw ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CELL_CHARS, "")
    .trim()
  if (s.length <= CELL_MAX) return s
  let cut = s.slice(0, CELL_MAX - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

/** Comparison key: no diacritics (đ → d), lower case, single spaces. */
export function foldText(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

// ---------------------------------------------------------------------------
// Links in a sheet cell
// ---------------------------------------------------------------------------

/** Tokens of a link cell that look like links / Drive ids (split on whitespace, comma, semicolon). */
export function linkTokens(cell: string): string[] {
  return sanitizeCell(cell)
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => /^https?:\/\//i.test(t) || looksLikeDriveId(t))
}

/**
 * Canonical form of a link cell, used both in drive_sheet_read (`link_cell`) and to compare with `expected_link`
 * in drive_sheet_update_rows: Drive links → their file id (no resource key, no query), other URLs → scheme + host +
 * path, joined by newlines. Idempotent (canonical(canonical(x)) = canonical(x)).
 */
export function canonicalLinkCell(cell: string): string {
  return linkTokens(cell)
    .map((t) => {
      const link = parseDriveLink(t)
      if (link) return link.id
      try {
        const u = new URL(t)
        return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`
      } catch {
        return t
      }
    })
    .join("\n")
}

// ---------------------------------------------------------------------------
// Platform / account cells
// ---------------------------------------------------------------------------

const PLATFORM_ALIASES: Record<string, Platform> = {
  meta: "meta",
  facebook: "meta",
  fb: "meta",
  "facebook ads": "meta",
  "meta ads": "meta",
  instagram: "meta",
  ig: "meta",
  tiktok: "tiktok",
  "tik tok": "tiktok",
  "tiktok ads": "tiktok",
  google: "google_ads",
  "google ads": "google_ads",
  google_ads: "google_ads",
  googleads: "google_ads",
  youtube: "google_ads",
  yt: "google_ads",
  adwords: "google_ads",
  openai: "openai_ads",
  "openai ads": "openai_ads",
  openai_ads: "openai_ads",
  chatgpt: "openai_ads",
  "chatgpt ads": "openai_ads",
}

/** "Facebook" / "FB" / "Meta" → meta, "TikTok" → tiktok, "Google" / "YouTube" → google_ads, "OpenAI" / "ChatGPT" → openai_ads. */
export function normalizePlatform(
  raw: string | null | undefined
): Platform | null {
  const k = foldText(raw).replace(/[-.]/g, " ").replace(/\s+/g, " ")
  if (!k) return null
  return PLATFORM_ALIASES[k] ?? PLATFORM_ALIASES[k.replace(/ /g, "")] ?? null
}

export type AccountMatch =
  | { ok: true; account: GrantAccount }
  | { ok: false; code: "account_not_in_scope" | "account_ambiguous" }

/** A sheet "Tài khoản QC" cell → a granted account (by external id first, then by name). */
export function matchAccount(
  grant: McpGrant,
  platform: Platform | null,
  raw: string
): AccountMatch {
  const value = raw.trim()
  const pool = grant.accounts.filter(
    (a) => !platform || a.platform === platform
  )
  const byId = pool.filter((a) =>
    accountIdCandidates(a.platform, value).includes(a.externalId)
  )
  const hits = byId.length
    ? byId
    : pool.filter((a) => foldText(a.name) === foldText(value))
  if (hits.length === 1) return { ok: true, account: hits[0]! }
  return {
    ok: false,
    code: hits.length ? "account_ambiguous" : "account_not_in_scope",
  }
}

// ---------------------------------------------------------------------------
// Sheet columns
// ---------------------------------------------------------------------------

export type SheetColumnKey = keyof SheetColumnsConfig

/** Logical column → output field name of drive_sheet_read. */
export const COLUMN_FIELDS: Record<SheetColumnKey, string> = {
  link: "link",
  name: "name",
  platform: "platform",
  account: "account",
  content: "content",
  headline: "headline",
  destination: "destination",
  status: "status",
  mediaId: "media_id",
  adIds: "ad_ids",
  note: "note",
  updatedAt: "updated_at",
}

/**
 * 0-based index of every configured column in the header row (matched on the folded header text). Columns that are
 * not configured or not found are absent.
 */
export function mapColumns(
  config: SheetSourceConfig,
  header: string[]
): Partial<Record<SheetColumnKey, number>> {
  const folded = header.map((h) => foldText(h))
  const out: Partial<Record<SheetColumnKey, number>> = {}
  for (const key of Object.keys(COLUMN_FIELDS) as SheetColumnKey[]) {
    const name = config.columns[key]
    if (!name) continue
    const i = folded.indexOf(foldText(name))
    if (i >= 0) out[key] = i
  }
  return out
}

// ---------------------------------------------------------------------------
// File items
// ---------------------------------------------------------------------------

export function sizeMb(bytes: number | null): number | null {
  return bytes === null ? null : Math.round((bytes / 1024 / 1024) * 100) / 100
}

/** Metadata of a Drive media file as the AI sees it (never links, thumbnails or resource keys). */
export function fileFacts(f: DriveFile) {
  return {
    name: nameLabel(f.name),
    type: mediaFamily(f.mimeType),
    mime: f.mimeType.slice(0, 100),
    size_mb: sizeMb(f.sizeBytes),
    width: f.width,
    height: f.height,
    duration_s:
      f.durationMs === null ? null : Math.round(f.durationMs / 100) / 10,
    modified_at: f.modifiedTime,
  }
}

/** "thư mục <name>" / "link Drive công khai" - where a file came from (previews, summaries). */
export function sourceLabel(source: GrantDriveSource | null): string {
  return source ? `thư mục "${nameLabel(source.name)}"` : "link Drive công khai"
}

// ---------------------------------------------------------------------------
// Per-MCP Sheets budget (security review L2)
// ---------------------------------------------------------------------------

/**
 * Count one Google Sheets API call of this MCP (≤ MCP_SHEETS_PER_MIN reads + the same writes per minute) and of its
 * owner over all their MCPs (≤ OWNER_SHEETS_PER_MIN per kind, T-5), inside the install-wide budget - call right
 * before each Sheets request. Over budget → rate_limited tool error.
 */
export function takeMcpSheetsBudget(
  grant: Pick<McpGrant, "mcpId" | "ownerId">,
  kind: SheetsCallKind
): void {
  const refused = tryTakeSheetsBudget(grant.mcpId, grant.ownerId, kind)
  if (!refused) return
  const what = kind === "read" ? "đọc" : "ghi"
  throw new McpToolError({
    code: "drive_sheet_busy",
    messageVi:
      refused.scope === "mcp"
        ? `MCP này đã dùng hết ${MCP_SHEETS_PER_MIN} lượt ${what} Google Sheet trong một phút.`
        : `Các MCP của chủ sở hữu MCP này đã dùng hết ${OWNER_SHEETS_PER_MIN} lượt ${what} Google Sheet trong một phút.`,
    hint: `Thử lại sau khoảng ${refused.waitSec} giây, hoặc xử lý nhiều dòng hơn trong mỗi lần gọi.`,
    logStatus: "rate_limited",
  })
}

// ---------------------------------------------------------------------------
// Values written into a sheet (security review L7)
// ---------------------------------------------------------------------------

/** Media / ad ids written back to a sheet: letters, digits and _ - . / : ~ only, starting with a letter or digit. */
export const SHEET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./:~]{0,199}$/

/**
 * Free text written into a sheet cell: a leading = + - @ (or tab / CR) would be read as a formula when the sheet is
 * exported / opened in a spreadsheet app (CSV injection) - prefix a space so it stays plain text.
 */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? ` ${text}` : text
}
