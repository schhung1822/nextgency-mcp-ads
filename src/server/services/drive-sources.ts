// Google Drive sources service (15-google-drive-media.md §5, §9.1, §11): registered folders / sheet tabs.
// Permissions (§5.3): company sources - everybody sees them, only admins write; personal sources - owner or admin
// (G4); a staff member never sees another staff member's personal source (404, not 403).
// Anti "claiming" (§5.2): first registration of a Google id wins (checked before the insert, under an advisory lock
// and by the partial unique index; a spreadsheet is claimed as a whole - more tabs only by the same owner + scope),
// a folder / sheet inside ANOTHER user's personal folder is refused, and so is a folder that CONTAINS one (H1, via
// drive_sources.ancestor_ids). Staff get one generic message for every "not yours / not there" outcome (no oracle).
// Google calls run outside DB transactions; every change writes activity_logs in the same transaction. Resource keys
// stay encrypted (AAD drive_source:<id>:resource_key) and never leave the server.
import "server-only"
import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"

import { driveJobs } from "@/lib/i18n/vi/drive-jobs"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  headerIndex,
  SHEET_COLUMN_KEYS,
  suggestSheetColumns,
  type DriveCredentialRefDto,
  type DriveFileDto,
  type DriveFilesPage,
  type DriveFileUseDto,
  type DriveRecheckResult,
  type DriveSheetPreview,
  type DriveSourceDetail,
  type DriveSourceDto,
  type DriveSourceMcpUsage,
  type DriveSourcePreview,
  type DriveStatusDto,
  type McpDriveSourceOption,
  type McpDriveSourceRef,
  type SheetColumnKey,
  type SheetConfigDto,
} from "@/lib/schemas/drive"
import { sanitizeExternalLabel } from "@/lib/text-safety"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { canAccessOwned } from "@/server/auth/session"
import { db, type Tx } from "@/server/db/client"
import {
  adAccounts,
  connections,
  driveCredentials,
  driveMediaUploads,
  driveSources,
  mcpDriveScopes,
  mcpServers,
  user as userTable,
} from "@/server/db/schema"
import { loadBlockedFolderIds, sourceIsBlocked } from "@/server/drive/blocked"
import { DriveError, isDriveError } from "@/server/drive/errors"
import {
  fetchDriveThumbnail,
  findAncestorIn,
  getDriveFile,
  listDriveFolder,
  resolveShortcut,
} from "@/server/drive/files"
import {
  insideOtherPersonalFolder,
  listAncestorIdsUnion,
  systemAuthBesides,
} from "@/server/drive/health"
import { parseDriveLink } from "@/server/drive/links"
import { getSheetMeta, readSheetRows } from "@/server/drive/sheets"
import {
  decryptSourceResourceKey,
  driveAuthForCredential,
  encryptSourceResourceKey,
  isDriveCredentialUsable,
  isUuid,
  loadDriveCredential,
  loadDriveSource,
  loadSystemDriveCredential,
  normalizeFolderConfig,
  normalizeSheetConfig,
  type DriveCredentialRow,
  type DriveSourceRow,
} from "@/server/drive/store"
import {
  DRIVE_FOLDER_MIME,
  type DriveAuth,
  type DriveFile,
  type FolderSourceConfig,
  sheetStatusLabel,
  type SheetColumnsConfig,
  type SheetSourceConfig,
} from "@/server/drive/types"
import { invalidateGrantCache } from "@/server/mcp/grant"

import {
  driveErrorMessage,
  DriveServiceError,
  isConfigProblem,
  toDriveServiceError,
  type DriveActor,
} from "./drive-credentials"
import { disclaimerAuditMeta, type CreateAudit } from "./disclaimers"

export { DriveServiceError, type DriveActor }

const m = driveUi.service
const TARGET = "drive_source"
export const DRIVE_SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet"
/** rows read by the sheet preview (status counts); the first SHEET_PREVIEW_ROWS are shown */
const SHEET_PREVIEW_READ_ROWS = 200
const SHEET_PREVIEW_ROWS = 20
const FILES_PAGE_SIZE = 100
const NAME_MAX = 120
/** advisory lock key serialising source registrations */
const REGISTRY_LOCK = "drive_source:registry"

type SourceKind = "folder" | "sheet"
type SourceScope = "company" | "personal"

/** MCP owner as the scope rules need it (an admin-owned MCP may use any live source - G4). */
export interface DriveMcpOwner {
  id: string
  role: "admin" | "staff"
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function statusOf(v: string): DriveStatusDto {
  return v === "error" || v === "disabled" ? v : "active"
}

function notFound(): DriveServiceError {
  return new DriveServiceError(m.notFound)
}

/** Text from Google (file / tab names) - one line, no control / bidi characters, bounded. */
function label(raw: string | null | undefined, max = NAME_MAX): string | null {
  return sanitizeExternalLabel(raw, max)
}

function canSee(
  actor: DriveActor,
  row: Pick<DriveSourceRow, "scope" | "ownerId">
): boolean {
  return (
    actor.role === "admin" ||
    row.scope === "company" ||
    row.ownerId === actor.id
  )
}

function canManage(
  actor: DriveActor,
  row: Pick<DriveSourceRow, "scope" | "ownerId">
): boolean {
  return row.scope === "company"
    ? actor.role === "admin"
    : canAccessOwned(actor, row.ownerId)
}

async function getVisibleRow(
  actor: DriveActor,
  sourceId: string
): Promise<DriveSourceRow> {
  const row = isUuid(sourceId) ? await loadDriveSource(sourceId) : null
  if (!row || !canSee(actor, row)) throw notFound()
  return row
}

async function getManageableRow(
  actor: DriveActor,
  sourceId: string
): Promise<DriveSourceRow> {
  const row = await getVisibleRow(actor, sourceId)
  if (!canManage(actor, row)) throw new DriveServiceError(m.companyAdminOnly)
  return row
}

function sheetConfigDto(cfg: SheetSourceConfig): SheetConfigDto {
  const columns = {} as Record<SheetColumnKey, string | null>
  for (const k of SHEET_COLUMN_KEYS)
    columns[k] =
      (cfg.columns as unknown as Record<string, string | null>)[k] ?? null
  return { headerRow: cfg.headerRow, columns, writeback: cfg.writeback }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface JoinedRow {
  s: DriveSourceRow
  ownerEmail: string
  ownerName: string
  credKind: string
  credName: string
  credEmail: string
}

async function selectRows(where: ReturnType<typeof and>): Promise<JoinedRow[]> {
  return db
    .select({
      s: driveSources,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
      credKind: driveCredentials.kind,
      credName: driveCredentials.name,
      credEmail: driveCredentials.clientEmail,
    })
    .from(driveSources)
    .innerJoin(userTable, eq(userTable.id, driveSources.ownerId))
    .innerJoin(
      driveCredentials,
      eq(driveCredentials.id, driveSources.credentialId)
    )
    .where(where)
    .orderBy(asc(driveSources.scope), desc(driveSources.createdAt))
}

async function mcpCounts(sourceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (sourceIds.length === 0) return out
  const rows = await db
    .select({
      sourceId: mcpDriveScopes.sourceId,
      n: sql<number>`count(distinct ${mcpDriveScopes.mcpId})::int`,
    })
    .from(mcpDriveScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpDriveScopes.mcpId))
    .where(
      and(
        inArray(mcpDriveScopes.sourceId, sourceIds),
        isNull(mcpServers.deletedAt)
      )
    )
    .groupBy(mcpDriveScopes.sourceId)
  for (const r of rows) out.set(r.sourceId, Number(r.n))
  return out
}

function credentialRef(
  r: Pick<JoinedRow, "s" | "credKind" | "credName" | "credEmail">
): DriveCredentialRefDto {
  return {
    id: r.s.credentialId,
    kind: r.credKind === "personal" ? "personal" : "system",
    name: r.credKind === "personal" ? r.credName : null,
    clientEmail: r.credEmail,
  }
}

function toDto(
  actor: DriveActor,
  r: JoinedRow,
  mcpCount: number
): DriveSourceDto {
  const s = r.s
  const kind: SourceKind = s.kind === "sheet" ? "sheet" : "folder"
  return {
    id: s.id,
    kind,
    scope: s.scope === "company" ? "company" : "personal",
    name: s.name,
    googleName: s.googleName,
    googleId: s.googleId,
    sheetGid: s.sheetGid,
    sharedDrive: !!s.sharedDriveId,
    credential: credentialRef(r),
    owner: { id: s.ownerId, email: r.ownerEmail, name: r.ownerName },
    isMine: s.ownerId === actor.id,
    canManage: canManage(actor, s),
    status: statusOf(s.status),
    statusMessage: s.statusMessage,
    lastCheckedAt: iso(s.lastCheckedAt),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    folder: kind === "folder" ? normalizeFolderConfig(s.config) : null,
    sheet:
      kind === "sheet" ? sheetConfigDto(normalizeSheetConfig(s.config)) : null,
    mcpCount,
  }
}

/** Admin: every live source (with owner). Staff: company sources + their own personal ones. */
export async function listDriveSources(
  actor: DriveActor
): Promise<DriveSourceDto[]> {
  const rows = await selectRows(
    and(
      isNull(driveSources.deletedAt),
      actor.role === "admin"
        ? undefined
        : or(
            eq(driveSources.scope, "company"),
            eq(driveSources.ownerId, actor.id)
          )
    )
  )
  const counts = await mcpCounts(rows.map((r) => r.s.id))
  return rows.map((r) => toDto(actor, r, counts.get(r.s.id) ?? 0))
}

async function usageOf(
  actor: DriveActor,
  sourceId: string
): Promise<DriveSourceMcpUsage[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      ownerId: mcpServers.ownerId,
    })
    .from(mcpDriveScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpDriveScopes.mcpId))
    .where(
      and(eq(mcpDriveScopes.sourceId, sourceId), isNull(mcpServers.deletedAt))
    )
  return rows.map((r) => {
    const visible = canAccessOwned(actor, r.ownerId)
    return {
      id: visible ? r.id : null,
      name: visible ? r.name : null,
      ownedByViewer: r.ownerId === actor.id,
    }
  })
}

/** Detail of /connections/drive/[id]; DriveServiceError(notFound) when not visible. */
export async function getDriveSource(
  actor: DriveActor,
  sourceId: string
): Promise<DriveSourceDetail> {
  const row = await getVisibleRow(actor, sourceId)
  const [joined] = await selectRows(and(eq(driveSources.id, row.id)))
  if (!joined) throw notFound()
  const usedBy = await usageOf(actor, row.id)
  return { ...toDto(actor, joined, usedBy.length), usedBy }
}

/** MCPs that lose the source if it is deleted (delete dialog). */
export async function getDriveSourceUsage(
  actor: DriveActor,
  sourceId: string
): Promise<DriveSourceMcpUsage[]> {
  const row = await getVisibleRow(actor, sourceId)
  return usageOf(actor, row.id)
}

// ---------------------------------------------------------------------------
// Registration checks (preview / create)
// ---------------------------------------------------------------------------

/**
 * Credential of a new source: company ⇒ the system one, admin only; personal ⇒ the system one (default) or the
 * actor's OWN personal credential. Deleted / disabled credentials are refused.
 */
async function resolveCredential(
  actor: DriveActor,
  scope: SourceScope,
  credentialId: string | null | undefined
): Promise<DriveCredentialRow> {
  if (scope === "company" && actor.role !== "admin")
    throw new DriveServiceError(m.companyAdminOnly, {
      scope: m.companyAdminOnly,
    })
  const system = await loadSystemDriveCredential()
  let row: DriveCredentialRow | null
  if (!credentialId || credentialId === system?.id) {
    if (!system) throw new DriveServiceError(m.notConfigured)
    row = system
  } else {
    if (scope === "company")
      throw new DriveServiceError(m.companyAdminOnly, {
        credentialId: m.companyAdminOnly,
      })
    row = await loadDriveCredential(credentialId)
    if (!row || row.kind !== "personal" || row.ownerId !== actor.id)
      throw new DriveServiceError(m.ownCredentialOnly, {
        credentialId: m.ownCredentialOnly,
      })
  }
  if (!isDriveCredentialUsable(row))
    throw new DriveServiceError(m.credentialDisabled, {
      credentialId: m.credentialDisabled,
    })
  return row
}

function authOf(cred: DriveCredentialRow): DriveAuth {
  try {
    return driveAuthForCredential(cred)
  } catch (e) {
    throw toDriveServiceError(e, "credentialId", "drive-sources")
  }
}

interface Claim {
  id: string
  ownerId: string
  ownerEmail: string
  scope: string
  sheetGid: number | null
}

/** Every live source of `googleId` (folder, or ANY tab of a spreadsheet) whoever registered it. */
async function findClaims(
  tx: Tx | typeof db,
  googleId: string
): Promise<Claim[]> {
  return tx
    .select({
      id: driveSources.id,
      ownerId: driveSources.ownerId,
      ownerEmail: userTable.email,
      scope: driveSources.scope,
      sheetGid: driveSources.sheetGid,
    })
    .from(driveSources)
    .innerJoin(userTable, eq(userTable.id, driveSources.ownerId))
    .where(
      and(eq(driveSources.googleId, googleId), isNull(driveSources.deletedAt))
    )
}

/** The one message staff get for "not found / not yours / not allowed here" (security review L6). */
function staffRefusal(): DriveServiceError {
  return new DriveServiceError(m.registrationRefused, {
    link: m.registrationRefused,
  })
}

/** Admins get the detailed reason; staff the generic one. */
function refusal(actor: DriveActor, detailed: () => DriveServiceError) {
  return actor.role === "admin" ? detailed() : staffRefusal()
}

function linkError(msg: string): DriveServiceError {
  return new DriveServiceError(msg, { link: msg })
}

/**
 * Claim rules (§5.2-1 + security review M1): a folder is claimed by any live source of the same id; a spreadsheet
 * is claimed as a whole - another tab may only be added by the same owner in the same scope. null = free.
 * Staff never learn who registered it (their own registrations are not an oracle); admins see the owner.
 */
function claimProblem(
  actor: DriveActor,
  claims: Claim[],
  scope: SourceScope,
  gid: number | null
): DriveServiceError | null {
  for (const c of claims) {
    const mine = c.ownerId === actor.id
    if (mine && c.scope === scope && gid !== null && c.sheetGid !== gid)
      continue // another tab of my own spreadsheet
    // a folder of mine (any scope) / the same tab of mine
    if (mine && (c.scope === scope || gid === null))
      return linkError(m.alreadyRegisteredByYou)
    // my spreadsheet registered in the other scope (not an oracle: it is mine)
    if (mine) return linkError(m.sheetOtherScope)
    return refusal(actor, () => {
      const d = new DriveError("claimed")
      return linkError(`${d.userMessageVi} ${m.claimedBy(c.ownerEmail)}`)
    })
  }
  return null
}

function driveFailure(
  code: "invalid_link" | "inside_other_source"
): DriveServiceError {
  const d = new DriveError(code)
  const msg = d.hintVi ? `${d.userMessageVi} ${d.hintVi}` : d.userMessageVi
  return linkError(msg)
}

/** Live personal FOLDER sources of somebody other than `ownerId` (the folders H1 protects). */
function otherPersonalFolders(ownerId: string) {
  return and(
    isNull(driveSources.deletedAt),
    eq(driveSources.kind, "folder"),
    eq(driveSources.scope, "personal"),
    ne(driveSources.ownerId, ownerId)
  )
}

/** Is one of `ancestorIds` a live PERSONAL folder source of somebody other than `ownerId`? */
async function insideOtherPersonal(
  ancestorIds: string[],
  ownerId: string,
  tx: Tx | typeof db = db
): Promise<boolean> {
  if (ancestorIds.length === 0) return false
  const [r] = await tx
    .select({ id: driveSources.id })
    .from(driveSources)
    .where(
      and(
        inArray(driveSources.googleId, ancestorIds),
        otherPersonalFolders(ownerId)
      )
    )
    .limit(1)
  return !!r
}

/**
 * How many live PERSONAL folder sources of somebody other than `ownerId` lie BELOW `folderId` (their stored
 * ancestor_ids contain it - security review H1). Registering `folderId` would share them.
 */
async function containedOtherPersonal(
  folderId: string,
  ownerId: string,
  tx: Tx | typeof db = db
): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(driveSources)
    .where(
      and(
        // GIN index drive_sources_ancestor_ids_gin
        sql`${driveSources.ancestorIds} @> array[${folderId}]::text[]`,
        otherPersonalFolders(ownerId)
      )
    )
  return Number(r?.n ?? 0)
}

/** Every DB-side registration rule (claims, inside / containing another person's folder); null = allowed. */
async function registrationProblem(
  tx: Tx | typeof db,
  actor: DriveActor,
  input: {
    kind: SourceKind
    scope: SourceScope
    googleId: string
    gid: number | null
    ancestorIds: string[]
  }
): Promise<DriveServiceError | null> {
  const claim = claimProblem(
    actor,
    await findClaims(tx, input.googleId),
    input.scope,
    input.gid
  )
  if (claim) return claim
  if (await insideOtherPersonal(input.ancestorIds, actor.id, tx))
    return refusal(actor, () => driveFailure("inside_other_source"))
  if (input.kind === "folder") {
    const n = await containedOtherPersonal(input.googleId, actor.id, tx)
    if (n > 0)
      return refusal(actor, () => linkError(m.containsOtherPersonal(n)))
  }
  return null
}

/** Google "not there / not shared" for staff: same generic message as every other refusal (L6). */
function isExistenceError(e: unknown): boolean {
  return (
    isDriveError(e) &&
    (e.code === "not_found" || e.code === "permission_denied")
  )
}

interface Inspection {
  cred: DriveCredentialRow
  auth: DriveAuth
  file: DriveFile
  googleId: string
  gid: number | null
  resourceKey: string | null
  /** visible ancestors of the folder / spreadsheet (stored as drive_sources.ancestor_ids) */
  ancestorIds: string[]
  preview: DriveSourcePreview
}

/**
 * Every registration check: link ↔ kind, credential rules, Google metadata (mime, trashed, shortcut), claim and
 * ancestor rules; folder: child counts of the first page; sheet: tab meta, header row, suggested mapping, canEdit.
 */
async function inspect(
  actor: DriveActor,
  input: {
    kind: SourceKind
    scope: SourceScope
    link: string
    credentialId?: string | null
    headerRow?: number
  }
): Promise<Inspection> {
  const link = parseDriveLink(input.link)
  if (!link) throw driveFailure("invalid_link")
  if (
    input.kind === "folder" &&
    link.kind !== "folder" &&
    link.kind !== "unknown"
  )
    throw new DriveServiceError(m.kindMismatchFolder, {
      link: m.kindMismatchFolder,
    })
  if (input.kind === "sheet") {
    if (link.kind !== "sheet")
      throw new DriveServiceError(m.kindMismatchSheet, {
        link: m.kindMismatchSheet,
      })
    if (link.gid === null)
      throw new DriveServiceError(m.sheetGidRequired, {
        link: m.sheetGidRequired,
      })
  }
  const cred = await resolveCredential(actor, input.scope, input.credentialId)
  const auth = authOf(cred)
  const gid = input.kind === "sheet" ? link.gid : null
  const headerRow = input.headerRow ?? 1

  try {
    const raw = await getDriveFile(auth, link.id, {
      resourceKey: link.resourceKey,
    })
    const file = await resolveShortcut(auth, raw)
    const wantMime =
      input.kind === "folder" ? DRIVE_FOLDER_MIME : DRIVE_SPREADSHEET_MIME
    if (file.mimeType !== wantMime)
      throw refusal(actor, () =>
        linkError(
          input.kind === "folder" ? m.kindMismatchFolder : m.kindMismatchSheet
        )
      )
    if (file.trashed) throw refusal(actor, () => linkError(m.trashed))
    const resourceKey =
      file.resourceKey ??
      (file.id === link.id
        ? link.resourceKey
        : (raw.shortcut?.targetResourceKey ?? null))

    // own credential + the system credential (union, T-2): a personal service account may not see every parent
    const ancestorIds = await listAncestorIdsUnion(
      auth,
      file,
      await systemAuthBesides(cred.id),
      { resourceKey }
    )
    const problem = await registrationProblem(db, actor, {
      kind: input.kind,
      scope: input.scope,
      googleId: file.id,
      gid,
      ancestorIds,
    })
    if (problem) throw problem

    const credential: DriveCredentialRefDto = {
      id: cred.id,
      kind: cred.kind === "personal" ? "personal" : "system",
      name: cred.kind === "personal" ? cred.name : null,
      clientEmail: cred.clientEmail,
    }
    const base = {
      kind: input.kind,
      scope: input.scope,
      googleId: file.id,
      sheetGid: gid,
      sharedDrive: !!file.driveId,
      credential,
    }
    if (input.kind === "folder") {
      const page = await listDriveFolder(auth, file.id, {
        pageSize: 1000,
        resourceKey,
        driveId: file.driveId,
      })
      let images = 0
      let videos = 0
      let folders = 0
      for (const f of page.files) {
        if (f.mimeType === DRIVE_FOLDER_MIME) folders++
        else if (f.mimeType.startsWith("image/")) images++
        else if (f.mimeType.startsWith("video/")) videos++
      }
      return {
        cred,
        auth,
        file,
        googleId: file.id,
        gid,
        resourceKey,
        ancestorIds,
        preview: {
          ...base,
          googleName: label(file.name) ?? file.id,
          folder: { images, videos, folders, more: !!page.nextPageToken },
          sheet: null,
        },
      }
    }
    const meta = await getSheetMeta(auth, file.id, gid!)
    const read = await readSheetRows(auth, file.id, meta.title, {
      headerRow,
      maxRows: 1,
      fresh: true,
    })
    const header = read.header.map((h) => label(h, 200) ?? "")
    return {
      cred,
      auth,
      file,
      googleId: file.id,
      gid,
      resourceKey,
      ancestorIds,
      preview: {
        ...base,
        googleName: label(`${file.name} - ${meta.title}`) ?? file.id,
        folder: null,
        sheet: {
          spreadsheetTitle:
            label(meta.spreadsheetTitle || file.name, 200) ?? "",
          title: label(meta.title, 200) ?? "",
          gid: meta.gid,
          rowCount: meta.rowCount,
          headerRow,
          header,
          suggestedColumns: suggestSheetColumns(header),
          canEdit: file.canEdit,
        },
      },
    }
  } catch (e) {
    if (actor.role !== "admin" && isExistenceError(e)) throw staffRefusal()
    throw toDriveServiceError(e, "link", "drive-sources")
  }
}

/** Wizard "Kiểm tra": every check, nothing saved. */
export async function previewDriveSource(
  actor: DriveActor,
  input: {
    kind: SourceKind
    scope: SourceScope
    link: string
    credentialId?: string | null
    headerRow?: number
  }
): Promise<DriveSourcePreview> {
  return (await inspect(actor, input)).preview
}

/**
 * Sheet config validation: link column required, every mapped header present in the header row, write-back needs
 * Editor access (canEdit) and a status column. fieldErrors keyed "columns.<key>" / "headerRow" / "writeback".
 */
function validateSheetConfig(
  header: string[],
  cfg: SheetSourceConfig,
  canEdit: boolean
): void {
  if (header.every((h) => h.trim() === ""))
    throw new DriveServiceError(m.headerEmpty, { headerRow: m.headerEmpty })
  if (!cfg.columns.link)
    throw new DriveServiceError(m.linkColumnRequired, {
      "columns.link": m.linkColumnRequired,
    })
  const fieldErrors: Record<string, string> = {}
  for (const k of SHEET_COLUMN_KEYS) {
    const name = (
      cfg.columns as unknown as Record<string, string | null | undefined>
    )[k]
    if (name && headerIndex(header, name) < 0)
      fieldErrors[`columns.${k}`] = m.columnNotInHeader
  }
  if (Object.keys(fieldErrors).length)
    throw new DriveServiceError(m.columnNotInHeader, fieldErrors)
  if (cfg.writeback && !cfg.columns.status)
    throw new DriveServiceError(m.writebackNeedsStatusColumn, {
      writeback: m.writebackNeedsStatusColumn,
    })
  if (cfg.writeback && !canEdit)
    throw new DriveServiceError(m.writebackNeedsEdit, {
      writeback: m.writebackNeedsEdit,
    })
}

function columnsConfig(
  cols: Partial<Record<SheetColumnKey, string | null>>
): SheetColumnsConfig {
  const out: SheetColumnsConfig = { link: cols.link ?? "" }
  for (const k of SHEET_COLUMN_KEYS) {
    if (k === "link") continue
    ;(out as unknown as Record<string, string | null>)[k] = cols[k] ?? null
  }
  return out
}

/** "Lưu" of the wizard: all checks again, then insert + activity in ONE transaction. */
export async function createDriveSource(
  actor: DriveActor,
  input: {
    kind: SourceKind
    scope: SourceScope
    link: string
    credentialId?: string | null
    headerRow?: number
    name?: string
    recursiveDepth?: number
    columns?: Partial<Record<SheetColumnKey, string | null>>
    writeback?: boolean
  },
  audit?: CreateAudit
): Promise<{ id: string; source: DriveSourceDto }> {
  const ins = await inspect(actor, input)
  const p = ins.preview
  let config: FolderSourceConfig | SheetSourceConfig
  if (input.kind === "folder") {
    config = normalizeFolderConfig({
      recursiveDepth: input.recursiveDepth ?? 0,
    })
  } else {
    const sheet = p.sheet!
    const cfg: SheetSourceConfig = {
      headerRow: sheet.headerRow,
      columns: columnsConfig(input.columns ?? sheet.suggestedColumns),
      writeback: input.writeback ?? false,
    }
    validateSheetConfig(sheet.header, cfg, sheet.canEdit)
    config = cfg
  }
  const id = randomUUID()
  const name = input.name ?? label(p.googleName) ?? ins.googleId
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      // serialise ALL registrations (rare): claims across credentials / tabs, and a parent and its sub-folder
      // registered at the same time by two people (ancestor + descendant rules, H1) cannot both pass
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${REGISTRY_LOCK}))`
      )
      const problem = await registrationProblem(tx, actor, {
        kind: input.kind,
        scope: input.scope,
        googleId: ins.googleId,
        gid: ins.gid,
        ancestorIds: ins.ancestorIds,
      })
      if (problem) throw problem
      await tx.insert(driveSources).values({
        id,
        kind: input.kind,
        scope: input.scope,
        ownerId: actor.id,
        credentialId: ins.cred.id,
        googleId: ins.googleId,
        sheetGid: ins.gid,
        resourceKeyEncrypted: encryptSourceResourceKey(id, ins.resourceKey),
        name,
        googleName: p.googleName,
        sharedDriveId: ins.file.driveId,
        ancestorIds: ins.ancestorIds,
        config,
        status: "active",
        lastCheckedAt: now,
      })
      await logActivity(
        {
          actor: actorOf(actor),
          action: "drive_source.create",
          target: { type: TARGET, id, label: name },
          metadata: {
            kind: input.kind,
            scope: input.scope,
            name,
            googleId: ins.googleId,
            sheetGid: ins.gid,
            googleName: p.googleName,
            credential: {
              kind: ins.cred.kind,
              clientEmail: ins.cred.clientEmail,
            },
            config,
            ...disclaimerAuditMeta(audit),
          },
        },
        tx
      )
    })
  } catch (e) {
    if ((e as { code?: unknown })?.code === "23505")
      throw refusal(actor, () =>
        linkError(new DriveError("claimed").userMessageVi)
      )
    throw e
  }
  const [joined] = await selectRows(and(eq(driveSources.id, id)))
  return { id, source: toDto(actor, joined!, 0) }
}

// ---------------------------------------------------------------------------
// Update / recheck / delete
// ---------------------------------------------------------------------------

async function usableAuthOf(row: DriveSourceRow): Promise<DriveAuth> {
  const cred = await loadDriveCredential(row.credentialId)
  if (!cred || !isDriveCredentialUsable(cred))
    throw new DriveServiceError(m.sourceUnavailable)
  return authOf(cred)
}

/**
 * Name; folder recursiveDepth; sheet headerRow / columns / writeback. Sheet changes are validated against the
 * current header row (and Editor access when write-back is on).
 */
export async function updateDriveSource(
  actor: DriveActor,
  input: {
    sourceId: string
    name?: string
    recursiveDepth?: number
    headerRow?: number
    columns?: Partial<Record<SheetColumnKey, string | null>>
    writeback?: boolean
  }
): Promise<DriveSourceDto> {
  const row = await getManageableRow(actor, input.sourceId)
  const isSheet = row.kind === "sheet"
  if (
    (!isSheet &&
      (input.headerRow !== undefined ||
        input.columns !== undefined ||
        input.writeback !== undefined)) ||
    (isSheet && input.recursiveDepth !== undefined)
  )
    throw new DriveServiceError(m.invalidInput)

  const patch: Partial<typeof driveSources.$inferInsert> = {}
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  if (input.name !== undefined && input.name !== row.name) {
    patch.name = input.name
    before.name = row.name
    after.name = input.name
  }
  if (!isSheet && input.recursiveDepth !== undefined) {
    const cur = normalizeFolderConfig(row.config)
    if (cur.recursiveDepth !== input.recursiveDepth) {
      patch.config = normalizeFolderConfig({
        recursiveDepth: input.recursiveDepth,
      })
      before.config = cur
      after.config = patch.config
    }
  }
  if (isSheet) {
    const cur = normalizeSheetConfig(row.config)
    const next: SheetSourceConfig = {
      headerRow: input.headerRow ?? cur.headerRow,
      columns: input.columns ? columnsConfig(input.columns) : cur.columns,
      writeback: input.writeback ?? cur.writeback,
    }
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      const needsHeader =
        next.headerRow !== cur.headerRow ||
        JSON.stringify(next.columns) !== JSON.stringify(cur.columns)
      const needsEdit = next.writeback && (!cur.writeback || needsHeader)
      if (needsHeader || needsEdit) {
        const auth = await usableAuthOf(row)
        try {
          const meta = await getSheetMeta(auth, row.googleId, row.sheetGid!)
          const read = await readSheetRows(auth, row.googleId, meta.title, {
            headerRow: next.headerRow,
            maxRows: 1,
            fresh: true,
          })
          const canEdit = needsEdit
            ? (
                await getDriveFile(auth, row.googleId, {
                  resourceKey: decryptSourceResourceKey(row),
                })
              ).canEdit
            : true
          validateSheetConfig(read.header, next, canEdit)
        } catch (e) {
          throw toDriveServiceError(e, undefined, "drive-sources")
        }
      } else if (next.writeback && !next.columns.status) {
        throw new DriveServiceError(m.writebackNeedsStatusColumn, {
          writeback: m.writebackNeedsStatusColumn,
        })
      }
      patch.config = next
      before.config = cur
      after.config = next
    }
  }

  if (Object.keys(after).length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(driveSources)
        .set(patch)
        .where(and(eq(driveSources.id, row.id), isNull(driveSources.deletedAt)))
      await logActivity(
        {
          actor: actorOf(actor),
          action: "drive_source.update",
          target: { type: TARGET, id: row.id, label: patch.name ?? row.name },
          metadata: {
            before,
            after,
            ...(row.ownerId !== actor.id ? { ownerId: row.ownerId } : {}),
          },
        },
        tx
      )
    })
    // MCP grants embed source names / configs
    invalidateGrantCache()
  }
  const [joined] = await selectRows(and(eq(driveSources.id, row.id)))
  return toDto(actor, joined!, (await mcpCounts([row.id])).get(row.id) ?? 0)
}

/**
 * "Kiểm tra lại": Google metadata (mime, trashed, name, shared drive), sheet tab + Editor access when write-back is
 * on. Pass → active; a configuration problem → error with the Vietnamese reason; Google unreachable → status
 * unchanged. Logged as drive_source.update {kind: "check"}.
 */
export async function recheckDriveSource(
  actor: DriveActor,
  sourceId: string
): Promise<DriveRecheckResult> {
  const row = await getManageableRow(actor, sourceId)
  let problem: string | null = null
  let broken = false
  let googleName: string | null = row.googleName
  let sharedDriveId: string | null = row.sharedDriveId
  let checked: { auth: DriveAuth; file: DriveFile } | null = null
  try {
    const cred = await loadDriveCredential(row.credentialId)
    if (!cred || !isDriveCredentialUsable(cred)) {
      problem = m.credentialDisabled
      broken = true
    } else {
      const auth = driveAuthForCredential(cred)
      const file = await getDriveFile(auth, row.googleId, {
        resourceKey: decryptSourceResourceKey(row),
      })
      const wantMime =
        row.kind === "sheet" ? DRIVE_SPREADSHEET_MIME : DRIVE_FOLDER_MIME
      sharedDriveId = file.driveId
      if (file.mimeType !== wantMime) {
        problem =
          row.kind === "sheet" ? m.kindMismatchSheet : m.kindMismatchFolder
        broken = true
      } else if (file.trashed) {
        problem = m.trashed
        broken = true
      } else if (row.kind === "sheet") {
        const meta = await getSheetMeta(auth, row.googleId, row.sheetGid!)
        googleName = label(`${file.name} - ${meta.title}`) ?? googleName
        if (normalizeSheetConfig(row.config).writeback && !file.canEdit) {
          problem = m.writebackNeedsEdit
          broken = true
        }
      } else {
        googleName = label(file.name) ?? googleName
      }
      checked = { auth, file }
    }
  } catch (e) {
    problem = driveErrorMessage(e)
    broken = isConfigProblem(e)
    if (!problem) {
      console.error("[drive-sources] recheck failed:", safeErrorForLog(e))
      problem = m.googleUnavailable
    }
  }
  // refresh ancestor_ids (H1: "does a new registration contain this source?"), own + system credential (T-2);
  // a failure keeps the old value
  let ancestorIds: string[] | undefined
  if (problem === null && checked) {
    try {
      ancestorIds = await listAncestorIdsUnion(
        checked.auth,
        checked.file,
        await systemAuthBesides(row.credentialId),
        { resourceKey: decryptSourceResourceKey(row) }
      )
    } catch (e) {
      console.error(
        "[drive-sources] ancestor refresh failed:",
        safeErrorForLog(e)
      )
    }
    // moved inside another user's personal folder: it would share that folder (H1) → error, like drive.health
    if (
      ancestorIds &&
      (await insideOtherPersonalFolder(row.ownerId, row.googleId, ancestorIds))
    ) {
      problem = driveJobs.sources.insideOtherPersonal
      broken = true
    }
  }
  const ok = problem === null
  const keep = row.status === "disabled"
  const status: DriveStatusDto = keep
    ? "disabled"
    : ok
      ? "active"
      : broken
        ? "error"
        : statusOf(row.status)
  const statusMessage = keep
    ? row.statusMessage
    : ok
      ? null
      : broken
        ? problem
        : row.statusMessage
  await db.transaction(async (tx) => {
    await tx
      .update(driveSources)
      .set({
        lastCheckedAt: new Date(),
        googleName,
        sharedDriveId,
        ...(ancestorIds ? { ancestorIds } : {}),
        ...(keep ? {} : { status, statusMessage }),
      })
      .where(eq(driveSources.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "drive_source.update",
        target: { type: TARGET, id: row.id, label: row.name },
        status: ok ? "success" : "failure",
        metadata: {
          kind: "check",
          before: { status: row.status },
          after: { status },
          message: problem,
        },
      },
      tx
    )
  })
  if (status !== row.status) invalidateGrantCache()
  return { ok, status, statusMessage }
}

/** Soft delete (resource key wiped), removed from every MCP scope in the same transaction. */
export async function deleteDriveSource(
  actor: DriveActor,
  sourceId: string
): Promise<{ affectedMcpIds: string[]; affectedMcpCount: number }> {
  const row = await getManageableRow(actor, sourceId)
  const usage = await usageOf(actor, row.id)
  const visibleIds = usage.flatMap((u) => (u.id ? [u.id] : []))
  await db.transaction(async (tx) => {
    await tx
      .update(driveSources)
      .set({
        deletedAt: new Date(),
        resourceKeyEncrypted: null,
        statusMessage: null,
      })
      .where(and(eq(driveSources.id, row.id), isNull(driveSources.deletedAt)))
    await tx.delete(mcpDriveScopes).where(eq(mcpDriveScopes.sourceId, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "drive_source.delete",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: {
          kind: row.kind,
          scope: row.scope,
          name: row.name,
          googleId: row.googleId,
          affectedMcpIds: visibleIds,
          affectedMcpCount: usage.length,
          ...(row.ownerId !== actor.id ? { ownerId: row.ownerId } : {}),
        },
      },
      tx
    )
  })
  invalidateGrantCache()
  return { affectedMcpIds: visibleIds, affectedMcpCount: usage.length }
}

// ---------------------------------------------------------------------------
// Browsing (folder grid, thumbnails, sheet preview)
// ---------------------------------------------------------------------------

/** Uploads of these files to ad accounts the viewer may see (admin: all; staff: accounts of own connections). */
async function usesOf(
  actor: DriveActor,
  fileIds: string[]
): Promise<Map<string, DriveFileUseDto[]>> {
  const out = new Map<string, DriveFileUseDto[]>()
  if (fileIds.length === 0) return out
  const rows = await db
    .select({
      driveFileId: driveMediaUploads.driveFileId,
      adAccountId: driveMediaUploads.adAccountId,
      mediaId: driveMediaUploads.mediaId,
      mediaType: driveMediaUploads.mediaType,
      lastUsedAt: driveMediaUploads.lastUsedAt,
      accountName: adAccounts.name,
      externalId: adAccounts.externalId,
      platform: adAccounts.platform,
    })
    .from(driveMediaUploads)
    .innerJoin(adAccounts, eq(adAccounts.id, driveMediaUploads.adAccountId))
    .innerJoin(connections, eq(connections.id, adAccounts.connectionId))
    .where(
      and(
        inArray(driveMediaUploads.driveFileId, fileIds),
        isNull(connections.deletedAt),
        actor.role === "admin" ? undefined : eq(connections.ownerId, actor.id)
      )
    )
    .orderBy(desc(driveMediaUploads.lastUsedAt))
  for (const r of rows) {
    const list = out.get(r.driveFileId) ?? []
    list.push({
      adAccountId: r.adAccountId,
      adAccountName: r.accountName,
      externalId: r.externalId,
      platform: r.platform,
      mediaType: r.mediaType === "video" ? "video" : "image",
      mediaId: r.mediaId,
      lastUsedAt: r.lastUsedAt.toISOString(),
    })
    out.set(r.driveFileId, list)
  }
  return out
}

async function visibleFolderSource(
  actor: DriveActor,
  sourceId: string
): Promise<{ row: DriveSourceRow; auth: DriveAuth }> {
  const row = await getVisibleRow(actor, sourceId)
  if (row.kind !== "folder") throw new DriveServiceError(m.notFolderSource)
  return { row, auth: await usableAuthOf(row) }
}

/**
 * One page of a folder source (or one of its sub-folders - must be a descendant of the source) for the UI grid:
 * sub-folders + images / videos with "used in" ad accounts. Never a link, thumbnailLink or resource key.
 */
export async function listDriveSourceFiles(
  actor: DriveActor,
  input: {
    sourceId: string
    folderId?: string
    family?: "image" | "video" | "all"
    pageToken?: string
  }
): Promise<DriveFilesPage> {
  const { row, auth } = await visibleFolderSource(actor, input.sourceId)
  // H1 defence in depth: other people's personal folders below this source are never browsed
  const blocked = await loadBlockedFolderIds(actor)
  // ... nor a source that now sits inside one (stored ancestors, T-2)
  if (sourceIsBlocked(row, blocked)) throw notFound()
  try {
    const isRoot = !input.folderId || input.folderId === row.googleId
    let folder = {
      id: row.googleId,
      name: row.googleName ?? row.name,
      isRoot: true,
    }
    let resourceKey = isRoot ? decryptSourceResourceKey(row) : null
    if (!isRoot) {
      const sub = await getDriveFile(auth, input.folderId!)
      if (
        sub.mimeType !== DRIVE_FOLDER_MIME ||
        sub.trashed ||
        blocked.has(sub.id) ||
        !(await findAncestorIn(auth, sub, new Set([row.googleId]), {
          blocked,
        }))
      )
        throw new DriveServiceError(m.subfolderOutside)
      folder = {
        id: sub.id,
        name: label(sub.name, 255) ?? sub.id,
        isRoot: false,
      }
      resourceKey = sub.resourceKey
    }
    const page = await listDriveFolder(auth, folder.id, {
      pageSize: FILES_PAGE_SIZE,
      pageToken: input.pageToken,
      family: input.family ?? "all",
      includeFolders: true,
      resourceKey,
      driveId: row.sharedDriveId,
    })
    const folders: DriveFilesPage["folders"] = []
    const media: DriveFile[] = []
    let skipped = 0
    for (const f of page.files) {
      if (f.trashed) continue
      if (f.mimeType === DRIVE_FOLDER_MIME) {
        if (blocked.has(f.id)) continue
        folders.push({
          id: f.id,
          name: label(f.name, 255) ?? f.id,
          modifiedTime: f.modifiedTime,
        })
      } else if (
        f.mimeType.startsWith("image/") ||
        f.mimeType.startsWith("video/")
      )
        media.push(f)
      else skipped++
    }
    const uses = await usesOf(
      actor,
      media.map((f) => f.id)
    )
    const files: DriveFileDto[] = media.map((f) => ({
      id: f.id,
      name: label(f.name, 255) ?? f.id,
      mimeType: f.mimeType,
      family: f.mimeType.startsWith("video/") ? "video" : "image",
      sizeBytes: f.sizeBytes,
      width: f.width,
      height: f.height,
      durationMs: f.durationMs,
      modifiedTime: f.modifiedTime,
      usedIn: uses.get(f.id) ?? [],
    }))
    return {
      folder,
      folders,
      files,
      skipped,
      nextPageToken: page.nextPageToken,
    }
  } catch (e) {
    throw toDriveServiceError(e, undefined, "drive-sources")
  }
}

/**
 * Thumbnail for /api/drive/thumb/<sourceId>/<fileId>: the file must be an image / video inside the (visible) folder
 * source. null = no thumbnail / not found / not inside (the route answers 404 for all of them).
 */
export async function getDriveSourceThumbnail(
  actor: DriveActor,
  sourceId: string,
  fileId: string
): Promise<{ contentType: string; bytes: Buffer } | null> {
  const { row, auth } = await visibleFolderSource(actor, sourceId)
  const blocked = await loadBlockedFolderIds(actor)
  if (sourceIsBlocked(row, blocked)) return null
  try {
    const file = await getDriveFile(auth, fileId)
    if (file.trashed) return null
    if (
      !file.mimeType.startsWith("image/") &&
      !file.mimeType.startsWith("video/")
    )
      return null
    if (
      !(await findAncestorIn(auth, file, new Set([row.googleId]), { blocked }))
    )
      return null
    return await fetchDriveThumbnail(auth, file.id, {
      resourceKey: file.resourceKey,
    })
  } catch (e) {
    if (isDriveError(e) && !e.retryable) return null
    throw toDriveServiceError(e, undefined, "drive-sources")
  }
}

/** Sheet detail: first rows mapped to the configured columns + status counts over the rows read. */
export async function previewDriveSheetRows(
  actor: DriveActor,
  sourceId: string
): Promise<DriveSheetPreview> {
  const row = await getVisibleRow(actor, sourceId)
  if (row.kind !== "sheet") throw new DriveServiceError(m.notSheetSource)
  const auth = await usableAuthOf(row)
  const cfg = normalizeSheetConfig(row.config)
  try {
    const meta = await getSheetMeta(auth, row.googleId, row.sheetGid!)
    const read = await readSheetRows(auth, row.googleId, meta.title, {
      headerRow: cfg.headerRow,
      maxRows: SHEET_PREVIEW_READ_ROWS,
    })
    const idx = new Map<SheetColumnKey, number>()
    const missingColumns: SheetColumnKey[] = []
    for (const k of SHEET_COLUMN_KEYS) {
      const name = (
        cfg.columns as unknown as Record<string, string | null | undefined>
      )[k]
      if (!name) continue
      const i = headerIndex(read.header, name)
      if (i < 0) missingColumns.push(k)
      else idx.set(k, i)
    }
    const statusIdx = idx.get("status")
    // aliases ("Chưa tạo ads", "Đã tạo"…) are counted under the canonical value; "" = empty status
    const statusCounts: Record<string, number> = {}
    if (statusIdx !== undefined)
      for (const r of read.rows) {
        const v = sheetStatusLabel(r.cells[statusIdx])
        statusCounts[v] = (statusCounts[v] ?? 0) + 1
      }
    const rows = read.rows.slice(0, SHEET_PREVIEW_ROWS).map((r) => {
      const values: Partial<Record<SheetColumnKey, string>> = {}
      for (const [k, i] of idx) values[k] = (r.cells[i] ?? "").slice(0, 500)
      return { rowNumber: r.rowNumber, values }
    })
    return {
      spreadsheetTitle: label(meta.spreadsheetTitle, 200) ?? "",
      title: label(meta.title, 200) ?? "",
      header: read.header.map((h) => label(h, 200) ?? ""),
      missingColumns,
      rows,
      statusCounts,
      rowsRead: read.rows.length,
      more: read.nextRow !== null && read.nextRow !== undefined,
    }
  } catch (e) {
    throw toDriveServiceError(e, undefined, "drive-sources")
  }
}

// ---------------------------------------------------------------------------
// MCP scope (mcp_drive_scopes)
// ---------------------------------------------------------------------------

/** WHERE for the live sources an MCP owned by `owner` may use: company + owner's personal; admin MCP: all (G4). */
function usableForOwner(owner: DriveMcpOwner) {
  return and(
    isNull(driveSources.deletedAt),
    owner.role === "admin"
      ? undefined
      : or(
          eq(driveSources.scope, "company"),
          eq(driveSources.ownerId, owner.id)
        )
  )
}

/**
 * Options of the "Google Drive" block of the MCP wizard / config editor for an MCP owned by `owner`, grouped:
 * company / mine (the MCP owner's) / staff (other users' personal sources - admin-owned MCP only). A staff viewer
 * only gets options for their own MCPs.
 */
export async function listDriveSourcesForMcpScope(
  viewer: DriveActor,
  owner: DriveMcpOwner
): Promise<McpDriveSourceOption[]> {
  if (viewer.role !== "admin" && owner.id !== viewer.id) return []
  const rows = await selectRows(usableForOwner(owner))
  const group = (s: DriveSourceRow): McpDriveSourceOption["group"] =>
    s.scope === "company"
      ? "company"
      : s.ownerId === owner.id
        ? "mine"
        : "staff"
  const order = { company: 0, mine: 1, staff: 2 } as const
  return rows
    .map((r) => ({
      id: r.s.id,
      kind: (r.s.kind === "sheet" ? "sheet" : "folder") as SourceKind,
      scope: (r.s.scope === "company" ? "company" : "personal") as SourceScope,
      name: r.s.name,
      status: statusOf(r.s.status),
      statusMessage: r.s.statusMessage,
      group: group(r.s),
      owner: { id: r.s.ownerId, email: r.ownerEmail, name: r.ownerName },
      writeback:
        r.s.kind === "sheet" && normalizeSheetConfig(r.s.config).writeback,
    }))
    .sort(
      (a, b) =>
        order[a.group] - order[b.group] || a.name.localeCompare(b.name, "vi")
    )
}

/**
 * Options for a new MCP (mcpId omitted: owner = viewer) or an existing one (its owner; the viewer must be allowed to
 * see that MCP, else DriveServiceError notFound).
 */
export async function listDriveSourceOptionsForMcp(
  viewer: DriveActor,
  mcpId?: string
): Promise<McpDriveSourceOption[]> {
  if (!mcpId)
    return listDriveSourcesForMcpScope(viewer, {
      id: viewer.id,
      role: viewer.role,
    })
  if (!isUuid(mcpId)) throw notFound()
  const [row] = await db
    .select({ ownerId: mcpServers.ownerId, ownerRole: userTable.role })
    .from(mcpServers)
    .innerJoin(userTable, eq(userTable.id, mcpServers.ownerId))
    .where(and(eq(mcpServers.id, mcpId), isNull(mcpServers.deletedAt)))
    .limit(1)
  if (!row || !canAccessOwned(viewer, row.ownerId)) throw notFound()
  return listDriveSourcesForMcpScope(viewer, {
    id: row.ownerId,
    role: row.ownerRole === "admin" ? "admin" : "staff",
  })
}

/** The subset of `sourceIds` an MCP owned by `owner` may use (input order kept, duplicates dropped). */
export async function driveSourcesUsableForMcp(
  owner: DriveMcpOwner,
  sourceIds: string[],
  tx: Tx | typeof db = db
): Promise<string[]> {
  const ids = [...new Set(sourceIds)].filter(isUuid)
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: driveSources.id })
    .from(driveSources)
    .where(and(inArray(driveSources.id, ids), usableForOwner(owner)))
  const usable = new Set(rows.map((r) => r.id))
  return ids.filter((id) => usable.has(id))
}

/** MCP save: every id must be usable (see driveSourcesUsableForMcp), else DriveServiceError(driveSourcesNotUsable). */
export async function assertDriveSourcesUsableForMcp(
  owner: DriveMcpOwner,
  sourceIds: string[],
  tx: Tx | typeof db = db
): Promise<string[]> {
  const ids = [...new Set(sourceIds)]
  const usable = await driveSourcesUsableForMcp(owner, ids, tx)
  if (usable.length !== ids.length)
    throw new DriveServiceError(m.driveSourcesNotUsable, {
      driveSourceIds: m.driveSourcesNotUsable,
    })
  return usable
}

/** Sources in an MCP scope that the MCP may still use (McpDetail.driveSources); others are pruned on save. */
export async function loadMcpDriveSourceRefs(
  mcpId: string,
  owner: DriveMcpOwner,
  tx: Tx | typeof db = db
): Promise<McpDriveSourceRef[]> {
  const rows = await tx
    .select({
      id: driveSources.id,
      name: driveSources.name,
      kind: driveSources.kind,
      scope: driveSources.scope,
      status: driveSources.status,
      config: driveSources.config,
      ownerEmail: userTable.email,
    })
    .from(mcpDriveScopes)
    .innerJoin(driveSources, eq(driveSources.id, mcpDriveScopes.sourceId))
    .innerJoin(userTable, eq(userTable.id, driveSources.ownerId))
    .where(and(eq(mcpDriveScopes.mcpId, mcpId), usableForOwner(owner)))
    .orderBy(asc(driveSources.scope), asc(driveSources.name))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind === "sheet" ? "sheet" : "folder",
    scope: r.scope === "company" ? "company" : "personal",
    status: statusOf(r.status),
    ownerEmail: r.ownerEmail,
    writeback: r.kind === "sheet" && normalizeSheetConfig(r.config).writeback,
  }))
}
