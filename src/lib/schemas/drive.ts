// Zod schemas + client-safe DTO types for Google Drive / Google Sheet sources (.claude/docs/15-google-drive-media.md).
// Shared client/server: no server-only imports. Secrets (service account JSON, API key) are accepted on input only -
// no DTO ever carries them (hints only: last 4 chars of the key id / API key). Resource keys never leave the server.
import { z } from "zod"

import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { reauthFieldsShape } from "@/lib/schemas/reauth"
import { hasForbiddenNameChars } from "@/lib/text-safety"

const m = driveUi.service

export const DRIVE_SOURCE_KINDS = ["folder", "sheet"] as const
export type DriveSourceKindDto = (typeof DRIVE_SOURCE_KINDS)[number]
export const DRIVE_SOURCE_SCOPES = ["company", "personal"] as const
export type DriveSourceScopeDto = (typeof DRIVE_SOURCE_SCOPES)[number]
export const DRIVE_STATUSES = ["active", "error", "disabled"] as const
export type DriveStatusDto = (typeof DRIVE_STATUSES)[number]
export const DRIVE_FILE_FAMILIES = ["image", "video", "all"] as const
export type DriveFileFamilyDto = (typeof DRIVE_FILE_FAMILIES)[number]

/** Google API key format (Cloud console → Credentials → API key). */
export const GOOGLE_API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/
/** Drive file / folder id (same rule as src/server/drive/links.ts). */
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/

export const DRIVE_FORM_LIMITS = {
  nameMax: 120,
  /** a downloaded service account key is ~2.3 KB */
  serviceAccountJsonMax: 20_000,
  linkMax: 2048,
  columnMax: 100,
  headerRowMax: 100,
  recursiveDepthMax: 3,
  /** sources per MCP */
  mcpSourcesMax: 50,
} as const

const uuid = z.uuid({ error: m.notFound })

export const driveNameSchema = z
  .string({ error: m.nameRequired })
  .trim()
  .min(1, { error: m.nameRequired })
  .max(DRIVE_FORM_LIMITS.nameMax, { error: m.nameTooLong })
  .refine((v) => !hasForbiddenNameChars(v), { error: m.nameBadChars })

/** Pasted service account JSON key. Parsed + checked against Google on the server. */
export const serviceAccountJsonSchema = z
  .string({ error: m.serviceAccountRequired })
  .trim()
  .min(1, { error: m.serviceAccountRequired })
  .max(DRIVE_FORM_LIMITS.serviceAccountJsonMax, {
    error: m.invalidServiceAccount,
  })

export const googleApiKeySchema = z
  .string({ error: m.invalidApiKey })
  .trim()
  .regex(GOOGLE_API_KEY_RE, { error: m.invalidApiKey })

/** "" / omitted = keep the stored value (write-only fields). */
const keepOr = <S extends z.ZodType<string>>(s: S) =>
  z
    .union([z.literal(""), s])
    .optional()
    .transform((v) => (v ? v : undefined))

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Settings → Google Drive "Lưu" (admin, re-auth). serviceAccountJson: required the first time, "" = keep; apiKey:
 * "" = keep, clearApiKey = remove the stored key.
 */
export const saveSystemDriveCredentialSchema = z
  .object({
    serviceAccountJson: z
      .string()
      .trim()
      .max(DRIVE_FORM_LIMITS.serviceAccountJsonMax, {
        error: m.invalidServiceAccount,
      })
      .optional()
      .transform((v) => (v ? v : undefined)),
    apiKey: keepOr(googleApiKeySchema),
    clearApiKey: z.boolean().default(false),
    ...reauthFieldsShape,
  })
  .refine((v) => !(v.apiKey && v.clearApiKey), {
    error: m.apiKeyConflict,
    path: ["apiKey"],
  })
export type SaveSystemDriveCredentialInput = z.input<
  typeof saveSystemDriveCredentialSchema
>

/** Settings → Google Drive "Xoá" (admin, re-auth). */
export const deleteSystemDriveCredentialSchema = z.object(reauthFieldsShape)
export type DeleteSystemDriveCredentialInput = z.input<
  typeof deleteSystemDriveCredentialSchema
>

/** "Service account riêng" (advanced): a staff member's own key, used only for their own sources. */
export const createPersonalDriveCredentialSchema = z.object({
  name: driveNameSchema,
  serviceAccountJson: serviceAccountJsonSchema,
})
export type CreatePersonalDriveCredentialInput = z.input<
  typeof createPersonalDriveCredentialSchema
>

export const driveCredentialIdSchema = z.object({ credentialId: uuid })

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const columnName = z
  .string()
  .trim()
  .max(DRIVE_FORM_LIMITS.columnMax, { error: m.columnTooLong })
  .refine((v) => !hasForbiddenNameChars(v), { error: m.nameBadChars })

const optionalColumn = z
  .union([columnName, z.null()])
  .optional()
  .transform((v) => (v ? v : null))

/** Header names (as typed in the sheet's header row) mapped to logical columns; link is required. */
export const sheetColumnsSchema = z
  .object({
    link: columnName.pipe(z.string().min(1, { error: m.linkColumnRequired })),
    name: optionalColumn,
    platform: optionalColumn,
    account: optionalColumn,
    content: optionalColumn,
    headline: optionalColumn,
    destination: optionalColumn,
    status: optionalColumn,
    mediaId: optionalColumn,
    adIds: optionalColumn,
    postLink: optionalColumn,
    campaignLink: optionalColumn,
    note: optionalColumn,
    updatedAt: optionalColumn,
  })
  .superRefine((cols, ctx) => {
    const seen = new Map<string, string>()
    for (const [k, v] of Object.entries(cols)) {
      if (!v) continue
      const key = normalizeHeader(v)
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message: m.columnDuplicate, path: [k] })
      else seen.set(key, k)
    }
  })
export type SheetColumnsInput = z.input<typeof sheetColumnsSchema>

export const recursiveDepthSchema = z
  .number({ error: m.recursiveDepthRange })
  .int({ error: m.recursiveDepthRange })
  .min(0, { error: m.recursiveDepthRange })
  .max(DRIVE_FORM_LIMITS.recursiveDepthMax, { error: m.recursiveDepthRange })

export const headerRowSchema = z
  .number({ error: m.headerRowRange })
  .int({ error: m.headerRowRange })
  .min(1, { error: m.headerRowRange })
  .max(DRIVE_FORM_LIMITS.headerRowMax, { error: m.headerRowRange })

const linkSchema = z
  .string({ error: m.linkRequired })
  .trim()
  .min(1, { error: m.linkRequired })
  .max(DRIVE_FORM_LIMITS.linkMax, { error: m.linkRequired })

/**
 * Wizard "Kiểm tra": link + kind + scope + credential (null / omitted = the system email). headerRow is used for
 * sheets (header + suggested column mapping). Saves nothing.
 */
export const previewDriveSourceSchema = z.object({
  kind: z.enum(DRIVE_SOURCE_KINDS),
  scope: z.enum(DRIVE_SOURCE_SCOPES),
  link: linkSchema,
  credentialId: uuid.nullable().optional(),
  headerRow: headerRowSchema.optional(),
})
export type PreviewDriveSourceInput = z.input<typeof previewDriveSourceSchema>

/** "Lưu" of the wizard: the preview checks run again on the server. */
export const createDriveSourceSchema = previewDriveSourceSchema.extend({
  /** omitted / "" = the name on Google Drive */
  name: z
    .union([z.literal(""), driveNameSchema])
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** folder */
  recursiveDepth: recursiveDepthSchema.optional(),
  /** sheet */
  columns: sheetColumnsSchema.optional(),
  writeback: z.boolean().optional(),
})
export type CreateDriveSourceInput = z.input<typeof createDriveSourceSchema>

export const driveSourceIdSchema = z.object({ sourceId: uuid })

/** Partial update (omitted = unchanged). Sheet changes are re-checked against the sheet header / permissions. */
export const updateDriveSourceSchema = z.object({
  sourceId: uuid,
  name: driveNameSchema.optional(),
  recursiveDepth: recursiveDepthSchema.optional(),
  headerRow: headerRowSchema.optional(),
  columns: sheetColumnsSchema.optional(),
  writeback: z.boolean().optional(),
})
export type UpdateDriveSourceInput = z.input<typeof updateDriveSourceSchema>

/** Folder grid of /connections/drive/[id]: folderId = a sub-folder of the source (omitted = the source root). */
export const listDriveSourceFilesSchema = z.object({
  sourceId: uuid,
  folderId: z
    .string()
    .regex(DRIVE_ID_RE, { error: m.subfolderOutside })
    .optional(),
  family: z.enum(DRIVE_FILE_FAMILIES).default("all"),
  pageToken: z.string().min(1).max(2048).optional(),
})
export type ListDriveSourceFilesInput = z.input<
  typeof listDriveSourceFilesSchema
>

/** Thumbnail route params. */
export const driveThumbnailParamsSchema = z.object({
  sourceId: uuid,
  fileId: z.string().regex(DRIVE_ID_RE, { error: m.notFound }),
})

/** MCP wizard / config: options for the MCP being created (mcpId omitted) or edited (mcpId). */
export const mcpDriveOptionsSchema = z.object({ mcpId: uuid.optional() })

// ---------------------------------------------------------------------------
// Pure helpers (sheet column mapping)
// ---------------------------------------------------------------------------

/** Header comparison key: trim, lower case, Vietnamese diacritics stripped (đ → d), inner whitespace collapsed. */
export function normalizeHeader(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export type SheetColumnKey =
  | "link"
  | "name"
  | "platform"
  | "account"
  | "content"
  | "headline"
  | "destination"
  | "status"
  | "mediaId"
  | "adIds"
  | "postLink"
  | "campaignLink"
  | "note"
  | "updatedAt"

export const SHEET_COLUMN_KEYS: readonly SheetColumnKey[] = [
  "link",
  "name",
  "platform",
  "account",
  "content",
  "headline",
  "destination",
  "status",
  "mediaId",
  "adIds",
  "postLink",
  "campaignLink",
  "note",
  "updatedAt",
]

/** Logical columns the system writes (write-back). */
export const SHEET_WRITABLE_COLUMN_KEYS: readonly SheetColumnKey[] = [
  "status",
  "mediaId",
  "adIds",
  "postLink",
  "campaignLink",
  "note",
  "updatedAt",
]

/** Accepted header spellings per logical column (normalised with normalizeHeader). The template name comes first. */
export const SHEET_COLUMN_ALIASES: Record<SheetColumnKey, readonly string[]> = {
  link: [
    "link drive",
    "link",
    "drive",
    "link file",
    "file",
    "link creative",
    "drive link",
  ],
  name: ["ten creative", "ten", "creative", "ten file", "name"],
  platform: ["nen tang", "platform", "kenh"],
  account: ["tai khoan qc", "tai khoan", "tkqc", "ad account", "account"],
  content: ["noi dung", "content", "caption", "mo ta"],
  headline: ["tieu de", "headline", "title"],
  destination: [
    "link dich",
    "landing page",
    "url dich",
    "destination",
    "link landing",
  ],
  status: ["trang thai", "status"],
  mediaId: ["ma media", "media id", "media"],
  adIds: ["ma quang cao", "ad id", "ad ids", "ma qc"],
  postLink: ["link bai viet", "link bai dang", "link post", "post link"],
  campaignLink: [
    "link chien dich",
    "link campaign",
    "campaign link",
    "link ads manager",
  ],
  note: ["ghi chu he thong", "ghi chu", "note"],
  updatedAt: ["cap nhat luc", "updated at", "cap nhat"],
}

/**
 * Suggested mapping of a header row: for each logical column the first header cell (original spelling) whose
 * normalised text equals one of its aliases (earlier aliases win). A header cell is used once.
 */
export function suggestSheetColumns(
  header: readonly string[]
): Record<SheetColumnKey, string | null> {
  const cells = header
    .map((h) => ({ raw: String(h ?? "").trim(), key: normalizeHeader(h) }))
    .filter((c) => c.raw !== "")
  const used = new Set<number>()
  const out = {} as Record<SheetColumnKey, string | null>
  for (const k of SHEET_COLUMN_KEYS) {
    out[k] = null
    for (const alias of SHEET_COLUMN_ALIASES[k]) {
      const i = cells.findIndex((c, idx) => !used.has(idx) && c.key === alias)
      if (i >= 0) {
        used.add(i)
        out[k] = cells[i]!.raw
        break
      }
    }
  }
  return out
}

/** 0-based index of a configured header in the header row (normalised comparison), -1 when absent. */
export function headerIndex(header: readonly string[], name: string): number {
  const want = normalizeHeader(name)
  if (!want) return -1
  return header.findIndex((h) => normalizeHeader(h) === want)
}

// ---------------------------------------------------------------------------
// DTOs (never contain a private key, an API key, a resource key or ciphertext)
// ---------------------------------------------------------------------------

export interface DriveOwnerDto {
  id: string
  email: string
  name: string
}

/** What every signed-in user may know about the system credential (to share folders with the email). */
export interface DriveSystemInfo {
  configured: boolean
  /** service account email - not a secret */
  clientEmail: string | null
  /** public "Anyone with the link" Drive links can be read (API key saved) */
  hasApiKey: boolean
  status: DriveStatusDto | null
}

/** Settings → Google Drive card (admin). */
export interface SystemDriveCredentialDto extends DriveSystemInfo {
  id: string | null
  projectId: string | null
  /** last 4 chars of the service account private_key_id */
  credentialHint: string | null
  /** last 4 chars of the API key */
  apiKeyHint: string | null
  statusMessage: string | null
  lastCheckedAt: string | null
  createdAt: string | null
  updatedAt: string | null
  /** live sources read with this credential (delete is refused while > 0) */
  sourceCount: number
}

export interface PersonalDriveCredentialDto {
  id: string
  name: string
  clientEmail: string
  credentialHint: string
  status: DriveStatusDto
  statusMessage: string | null
  lastCheckedAt: string | null
  createdAt: string
  owner: DriveOwnerDto
  isMine: boolean
  sourceCount: number
}

export interface DriveCredentialTestResult {
  ok: boolean
  status: DriveStatusDto
  statusMessage: string | null
  clientEmail: string
}

export interface DriveCredentialRefDto {
  id: string
  kind: "system" | "personal"
  /** personal credential display name; null for the system one */
  name: string | null
  clientEmail: string
}

export interface FolderConfigDto {
  recursiveDepth: number
}

export interface SheetConfigDto {
  headerRow: number
  columns: Record<SheetColumnKey, string | null>
  writeback: boolean
}

export interface DriveSourceDto {
  id: string
  kind: DriveSourceKindDto
  scope: DriveSourceScopeDto
  name: string
  /** name on Google Drive at the last check */
  googleName: string | null
  /** folder id / spreadsheet id (not a secret; open link: drive.google.com/drive/folders/<id>) */
  googleId: string
  sheetGid: number | null
  sharedDrive: boolean
  credential: DriveCredentialRefDto
  owner: DriveOwnerDto
  isMine: boolean
  /** the viewer may edit / recheck / delete it (company: admin; personal: owner or admin) */
  canManage: boolean
  status: DriveStatusDto
  statusMessage: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
  folder: FolderConfigDto | null
  sheet: SheetConfigDto | null
  /** MCPs (not deleted) with this source in scope */
  mcpCount: number
}

/** MCP using a source; id/name hidden (null) when the viewer may not see that MCP. */
export interface DriveSourceMcpUsage {
  id: string | null
  name: string | null
  ownedByViewer: boolean
}

export interface DriveSourceDetail extends DriveSourceDto {
  usedBy: DriveSourceMcpUsage[]
}

/** Wizard "Kiểm tra" result. */
export interface DriveSourcePreview {
  kind: DriveSourceKindDto
  scope: DriveSourceScopeDto
  googleId: string
  sheetGid: number | null
  /** name on Google Drive (spreadsheet: "<file> - <tab>") */
  googleName: string
  sharedDrive: boolean
  credential: DriveCredentialRefDto
  folder: {
    images: number
    videos: number
    folders: number
    /** the first page was full: there are more files than counted */
    more: boolean
  } | null
  sheet: {
    spreadsheetTitle: string
    title: string
    gid: number
    rowCount: number | null
    headerRow: number
    header: string[]
    suggestedColumns: Record<SheetColumnKey, string | null>
    /** the service account is Editor (write-back possible) */
    canEdit: boolean
  } | null
}

export interface DriveFileUseDto {
  adAccountId: string
  adAccountName: string
  externalId: string
  platform: string
  mediaType: "image" | "video"
  mediaId: string
  lastUsedAt: string
}

export interface DriveFileDto {
  id: string
  name: string
  mimeType: string
  family: "image" | "video"
  sizeBytes: number | null
  width: number | null
  height: number | null
  durationMs: number | null
  modifiedTime: string | null
  /** uploads to ad accounts the viewer may see */
  usedIn: DriveFileUseDto[]
}

export interface DriveFolderDto {
  id: string
  name: string
  modifiedTime: string | null
}

export interface DriveFilesPage {
  /** the folder listed (source root or a sub-folder) */
  folder: { id: string; name: string; isRoot: boolean }
  folders: DriveFolderDto[]
  files: DriveFileDto[]
  /** children that are neither image, video nor folder (Docs, PDFs…) */
  skipped: number
  nextPageToken: string | null
}

export interface DriveSheetPreviewRow {
  rowNumber: number
  values: Partial<Record<SheetColumnKey, string>>
}

export interface DriveSheetPreview {
  spreadsheetTitle: string
  title: string
  header: string[]
  /** configured headers missing from the header row */
  missingColumns: SheetColumnKey[]
  rows: DriveSheetPreviewRow[]
  /** status column value → rows (among the rows read); "" = empty status. {} when no status column */
  statusCounts: Record<string, number>
  /** rows read for the counts (the sheet may hold more) */
  rowsRead: number
  more: boolean
}

export interface DriveRecheckResult {
  ok: boolean
  status: DriveStatusDto
  statusMessage: string | null
}

/** MCP wizard / config block "Google Drive". group: company / mine (MCP owner) / staff (other users - admin MCP only). */
export interface McpDriveSourceOption {
  id: string
  kind: DriveSourceKindDto
  scope: DriveSourceScopeDto
  name: string
  status: DriveStatusDto
  statusMessage: string | null
  group: "company" | "mine" | "staff"
  owner: DriveOwnerDto
  /** sheet with write-back enabled */
  writeback: boolean
}

/** A source in an MCP scope (McpDetail.driveSources). */
export interface McpDriveSourceRef {
  id: string
  name: string
  kind: DriveSourceKindDto
  scope: DriveSourceScopeDto
  status: DriveStatusDto
  ownerEmail: string
  writeback: boolean
}
