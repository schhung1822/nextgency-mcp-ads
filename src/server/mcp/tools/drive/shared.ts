// Shared helpers of the drive_* tools (15-google-drive-media.md §7, §9): labels, file items, sheet text handling.
// Names, cell texts and folder names are UNTRUSTED data (they may contain instructions aimed at the AI): one line or
// trimmed, control / bidi characters removed, length capped - and the tool descriptions say they are data.
// No imports from "next/*".
import {
  AUTO_DETECT_COLUMN_KEYS,
  detectAutoHeader,
} from "../../../../lib/schemas/drive"
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
// "Bài viết có sẵn" cell (v1.1.4): an existing Facebook post a Meta ad is built from
// ---------------------------------------------------------------------------

/** The post of a "Bài viết có sẵn" cell as drive_sheet_read returns it (`existing_post`). */
export interface ExistingPost {
  /** PAGEID_POSTID - the object_story_id of meta_create_ad (creative type existing_post) */
  post_id?: string
  /** the Facebook link of the cell (https, no fragment, tracking parameters dropped) */
  url?: string
  /** true = a Facebook link without numeric Page + post ids (pfbid…, /share/…, a vanity name): find the post first */
  needs_lookup: boolean
}

export type ExistingPostParse =
  | { ok: true; post: ExistingPost }
  | { ok: false; code: "existing_post_invalid" }

const POST_ID_RE = /^(\d{5,20})_(\d{5,30})$/
const FB_NUMERIC_ID_RE = /^\d{5,30}$/
const FB_HOST_RE =
  /^(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.watch|fb\.me)$/i
const FB_BARE_LINK_RE =
  /^(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.watch|fb\.me)\//i
/** Max characters of the Facebook link returned in existing_post.url. */
export const EXISTING_POST_URL_MAX = 500

/** True when `token` is an http(s) link to Facebook (facebook.com, fb.com, fb.watch, fb.me and their sub-domains). */
export function isFacebookLink(token: string): boolean {
  try {
    const u = new URL(token)
    return /^https?:$/.test(u.protocol) && FB_HOST_RE.test(u.hostname)
  } catch {
    return false
  }
}

function isStoryPage(pathname: string): boolean {
  const p = pathname.split("/").filter(Boolean).join("/").toLowerCase()
  return p === "permalink.php" || p === "story.php"
}

/** PAGEID_POSTID of a Facebook post link with numeric ids (/{page}/posts/{id}, permalink.php / story.php), else null. */
function postIdFromUrl(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean)
  if (
    parts.length >= 3 &&
    parts[1]!.toLowerCase() === "posts" &&
    FB_NUMERIC_ID_RE.test(parts[0]!) &&
    FB_NUMERIC_ID_RE.test(parts[2]!)
  )
    return `${parts[0]}_${parts[2]}`
  const story = u.searchParams.get("story_fbid") ?? ""
  const page = u.searchParams.get("id") ?? ""
  if (
    isStoryPage(u.pathname) &&
    FB_NUMERIC_ID_RE.test(story) &&
    FB_NUMERIC_ID_RE.test(page)
  )
    return `${page}_${story}`
  return null
}

/**
 * A "Bài viết có sẵn" cell → the existing post (null = empty cell). Accepted: PAGEID_POSTID, or a Facebook link -
 * numeric /{page}/posts/{id}, permalink.php?story_fbid=…&id=… and story.php?story_fbid=…&id=… give the post id; other
 * Facebook links (pfbid…, /share/…, vanity names, fb.watch) → needs_lookup with the link. Anything else (another site,
 * free text) → existing_post_invalid. Only the first word of the cell is read; the cell is sanitised like every cell.
 */
export function parseExistingPost(
  cell: string | null | undefined
): ExistingPostParse | null {
  const text = sanitizeCell(cell)
  if (!text) return null
  const token = text.split(/\s+/)[0]!
  if (POST_ID_RE.test(token))
    return { ok: true, post: { post_id: token, needs_lookup: false } }
  const raw =
    !/^https?:\/\//i.test(token) && FB_BARE_LINK_RE.test(token)
      ? `https://${token}`
      : token
  const bad = { ok: false, code: "existing_post_invalid" } as const
  if (!isFacebookLink(raw)) return bad
  const u = new URL(raw)
  if (u.username || u.password) return bad
  const id = postIdFromUrl(u)
  // tracking parameters dropped; permalink.php / story.php keep the two parameters naming the post
  const clean = new URL(`https://${u.hostname.toLowerCase()}${u.pathname}`)
  if (isStoryPage(u.pathname))
    for (const k of ["story_fbid", "id"]) {
      const v = u.searchParams.get(k)
      if (v) clean.searchParams.set(k, v)
    }
  const url = clean.toString()
  if (url.length > EXISTING_POST_URL_MAX) return bad
  return {
    ok: true,
    post: id
      ? { post_id: id, url, needs_lookup: false }
      : { url, needs_lookup: true },
  }
}

/** Prefix of a row anchor taken from the "Bài viết có sẵn" cell (rows without a Drive link). */
const POST_ANCHOR = "post:"

/** "post:<PAGEID_POSTID | link | cell text>" of a non-empty "Bài viết có sẵn" cell, "" for an empty one. */
export function existingPostAnchor(cell: string | null | undefined): string {
  const text = sanitizeCell(cell)
  if (!text) return ""
  const p = parseExistingPost(text)
  const key = p?.ok
    ? (p.post.post_id ?? p.post.url ?? "")
    : text.replace(/\s+/g, " ").slice(0, 200)
  return `${POST_ANCHOR}${key}`
}

/** A "Tên creative" / "Tài khoản QC" cell inside a post anchor: sanitised, one line, no "|", ≤ 100 characters. */
function anchorPart(cell: string | null | undefined): string {
  return sanitizeCell(cell)
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim()
}

/**
 * What identifies a sheet row between drive_sheet_read (`link_cell`) and drive_sheet_update_rows (`expected_link`):
 * the canonical link cell (unchanged since v1.0), or - when the link cell has no link and the sheet has a "Bài viết
 * có sẵn" column - the post anchor "post:<post>|<Tên creative>|<Tài khoản QC>" (empty parts when those columns are
 * not mapped), so rows built from an existing post can be written back too and two rows of the same post still
 * differ (security review: a shifted row of the same post must be row_moved, not written).
 */
export function rowAnchor(
  linkCell: string | null | undefined,
  postCell: string | null | undefined,
  context: { name?: string | null; account?: string | null } = {}
): string {
  const link = canonicalLinkCell(String(linkCell ?? ""))
  if (link) return link
  const post =
    postCell === undefined || postCell === null
      ? ""
      : existingPostAnchor(postCell)
  if (!post) return ""
  return `${post}|${anchorPart(context.name)}|${anchorPart(context.account)}`
}

/** The expected_link given by the AI, in the form rowAnchor returns (idempotent). */
export function canonicalExpectedAnchor(expected: string): string {
  const t = String(expected ?? "").trim()
  return t.startsWith(POST_ANCHOR)
    ? t.replace(/\s+/g, " ")
    : canonicalLinkCell(expected)
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
  cover: "cover",
  name: "name",
  platform: "platform",
  account: "account",
  content: "content",
  headline: "headline",
  destination: "destination",
  welcomeMessage: "welcome_message",
  existingPost: "existing_post",
  status: "status",
  mediaId: "media_id",
  adIds: "ad_ids",
  postLink: "post_link",
  campaignLink: "campaign_link",
  note: "note",
  updatedAt: "updated_at",
}

/**
 * 0-based index of every configured column in the header row (matched on the folded header text). Columns that are
 * not configured or not found are absent - except the read-only auto-detected columns (AUTO_DETECT_COLUMN_KEYS: cover
 * v1.1.2, welcome message v1.1.3, existing post v1.1.4): when one is not mapped (or its mapped header is gone), a
 * header cell named like it ("Ảnh bìa", "Thumbnail"… / "Lời chào tin nhắn", "Câu chào"… / "Bài viết có sẵn", "Bài
 * viết gốc"… - never a generic "Post ID": AUTO_DETECT_ALIASES; detectAutoHeader) that no other column uses is taken,
 * so sheets declared before the column existed work without remapping.
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
  for (const key of AUTO_DETECT_COLUMN_KEYS) {
    if (out[key] !== undefined) continue
    const i = detectAutoHeader(key, header, new Set(Object.values(out)))
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

/** Max characters of a link (post / campaign) written into a sheet cell. */
export const SHEET_LINK_MAX = 500

// every control character (tab / newline included), bidi overrides / isolates, zero-width, BOM
const UNSAFE_LINK_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g

/** A link given by the AI for a sheet cell: unsafe characters removed, trimmed (validate with isSheetLink). */
export function cleanSheetLink(raw: string): string {
  return String(raw ?? "")
    .normalize("NFC")
    .replace(UNSAFE_LINK_CHARS, "")
    .trim()
}

/** A cleaned link may be written: https only, a host, no spaces, no user:password@, ≤ SHEET_LINK_MAX characters. */
export function isSheetLink(cleaned: string): boolean {
  if (cleaned.length > SHEET_LINK_MAX || !/^https:\/\/\S+$/i.test(cleaned))
    return false
  try {
    const u = new URL(cleaned)
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password
  } catch {
    return false
  }
}
