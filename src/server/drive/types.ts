// Google Drive / Sheets as a creative source - shared types (.claude/docs/15-google-drive-media.md).
// Contract between src/server/drive/** (Google REST), services, MCP tools and the /dl relay route.
// No imports from "next/*".

export {
  SHEET_STATUS,
  SHEET_STATUS_ALIASES,
  SHEET_STATUS_KEYS,
  sheetStatusKey,
  sheetStatusLabel,
  type SheetStatusKey,
} from "../../lib/drive-sheet-status"

export type DriveCredentialKind = "system" | "personal"
export type DriveSourceKind = "folder" | "sheet"
export type DriveSourceScope = "company" | "personal"
export type DriveStatus = "active" | "error" | "disabled"

/** Parsed service account key (from the JSON key file). Never logged, never sent to a client / the AI. */
export interface GoogleServiceAccount {
  clientEmail: string
  privateKey: string
  privateKeyId: string | null
  projectId: string | null
}

/**
 * How a Drive/Sheets request authenticates.
 * - service_account: folders/sheets shared with that service account (cacheKey = "drive_credential:<id>").
 * - api_key: ANONYMOUS access - only files shared "Anyone with the link" are readable. Public links never use a
 *   service account token (a staff member must not reach another user's private folder through a link).
 */
export type DriveAuth =
  | { type: "service_account"; sa: GoogleServiceAccount; cacheKey: string }
  | { type: "api_key"; apiKey: string }

/** Normalised Drive file metadata (subset of the v3 File resource). */
export interface DriveFile {
  id: string
  name: string
  mimeType: string
  /** null for folders, shortcuts and Google-native files */
  sizeBytes: number | null
  md5: string | null
  headRevisionId: string | null
  version: string | null
  /** RFC 3339 */
  modifiedTime: string | null
  parents: string[]
  trashed: boolean
  /** shared drive id, null for My Drive */
  driveId: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  canDownload: boolean
  canEdit: boolean
  resourceKey: string | null
  shortcut: {
    targetId: string
    targetMimeType: string | null
    targetResourceKey: string | null
  } | null
}

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
export const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

export type DriveMediaFamily = "image" | "video"

export interface DriveListOptions {
  pageToken?: string
  /** 1-1000, default 100 */
  pageSize?: number
  /** filter by mime family; "all" = images + videos (+ folders when includeFolders) */
  family?: DriveMediaFamily | "all"
  includeFolders?: boolean
  nameContains?: string
  /** RFC 3339 */
  modifiedAfter?: string
  /** resource key of the folder (public links) */
  resourceKey?: string | null
  /** shared drive id of the folder (DriveFile.driveId): lists with corpora=drive (else corpora=user / none) */
  driveId?: string | null
  signal?: AbortSignal
}

export interface DriveListPage {
  files: DriveFile[]
  nextPageToken: string | null
}

/** Result of parsing a Google Drive / Docs URL (or a bare id). */
export interface DriveLink {
  kind: "file" | "folder" | "sheet" | "document" | "unknown"
  id: string
  resourceKey: string | null
  /** sheet tab id (#gid=) */
  gid: number | null
}

export interface DriveDownload {
  status: 200 | 206
  body: ReadableStream<Uint8Array>
  contentLength: number | null
  contentRange: string | null
  contentType: string | null
}

// ---- Sources (drive_sources.config) -------------------------------------------------------------------------

export interface FolderSourceConfig {
  /** how many levels of sub-folders drive_list_files may walk when recursive=true (0-3) */
  recursiveDepth: number
}

/** Header names (as typed in the sheet's header row) mapped to logical columns. */
export interface SheetColumnsConfig {
  link: string
  /** cover image (thumbnail) of the row's video - read only, never written (v1.1.2) */
  cover?: string | null
  name?: string | null
  platform?: string | null
  account?: string | null
  content?: string | null
  headline?: string | null
  destination?: string | null
  /** Messenger welcome message of a click-to-message Meta ad - read only, never written (v1.1.3) */
  welcomeMessage?: string | null
  /** system-written columns (write-back) */
  status?: string | null
  mediaId?: string | null
  adIds?: string | null
  /** link of the post / ad preview the AI created from the row (2026-10-10) */
  postLink?: string | null
  /** Ads Manager link of the campaign the AI created from the row (2026-10-10) */
  campaignLink?: string | null
  note?: string | null
  updatedAt?: string | null
}

export interface SheetSourceConfig {
  /** 1-based row holding the headers */
  headerRow: number
  columns: SheetColumnsConfig
  /** the MCP may write status/result columns (needs Editor access for the service account) */
  writeback: boolean
}

export const DEFAULT_SHEET_COLUMNS: Required<{
  [K in keyof SheetColumnsConfig]: string
}> = {
  link: "Link Drive",
  cover: "Ảnh bìa",
  name: "Tên creative",
  platform: "Nền tảng",
  account: "Tài khoản QC",
  content: "Nội dung",
  headline: "Tiêu đề",
  destination: "Link đích",
  welcomeMessage: "Lời chào tin nhắn",
  status: "Trạng thái",
  mediaId: "Mã media",
  adIds: "Mã quảng cáo",
  postLink: "Link bài viết",
  campaignLink: "Link chiến dịch",
  note: "Ghi chú hệ thống",
  updatedAt: "Cập nhật lúc",
}

/** Columns the system may write - write-back never touches any other column. */
export const SHEET_WRITABLE_COLUMNS = [
  "status",
  "mediaId",
  "adIds",
  "postLink",
  "campaignLink",
  "note",
  "updatedAt",
] as const
export type SheetWritableColumn = (typeof SHEET_WRITABLE_COLUMNS)[number]

export interface SheetMeta {
  spreadsheetTitle: string
  /** current tab title for the stored gid (titles can change, the gid is stable) */
  title: string
  gid: number
  rowCount: number | null
}

export interface SheetRow {
  /** 1-based sheet row number */
  rowNumber: number
  cells: string[]
}

export interface SheetRead {
  header: string[]
  /** rows with at least one non-empty cell (empty rows are skipped, row numbers stay exact) */
  rows: SheetRow[]
  /** first row after the range read when it may hold more data; null = the sheet ends inside the range */
  nextRow?: number | null
}

export interface SheetCellUpdate {
  /** A1 range, e.g. "'Creative tuần 41'!F12" */
  range: string
  values: string[][]
}

// ---- Limits (GD5 + doc §8/§9) -------------------------------------------------------------------------------

export const DRIVE_LIMITS = {
  /** parents walked when checking that a file sits inside a granted / registered folder */
  ancestorMaxDepth: 10,
  /** recursive listing depth cap */
  recursiveMaxDepth: 3,
  relayTtlMs: 60 * 60_000,
  relayMaxFetches: 30,
  /** per relay token / per client IP concurrent streams */
  relayStreamsPerToken: 8,
  relayStreamsPerIp: 16,
  /** in-process Sheets API budget (Google: 60/min/user/project) */
  sheetsReadsPerMin: 50,
  sheetsWritesPerMin: 50,
  sheetReadCacheMs: 30_000,
  sheetMaxRowsPerCall: 50,
  thumbnailMaxBytes: 1024 * 1024,
} as const
