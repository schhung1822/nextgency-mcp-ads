// Google Drive access for MCP tools (15-google-drive-media.md §5.2, §6, §13). Decides, for ONE request, whether a
// Drive file / folder named by the AI (bare id or link) may be used, and with which credentials:
//  1. granted FOLDER sources, per credential: files.get with that service account → shortcut resolved to its target
//     (the TARGET is checked, never the shortcut) → the target must sit inside one of that credential's granted
//     folders (findAncestorIn, ≤ 10 levels). First match wins.
//  2. else, when the MCP allows public links and the system API key exists: files.get with the API key ONLY (never a
//     service-account token: a link can never reach another user's private folder) → "Anyone with the link" files.
//  3. else not_in_scope (same answer whatever the reason) / public_links_disabled for a link when the setting is off.
// Security H1 (defence in depth): a granted folder never opens another user's PERSONAL folder registered inside it -
// the ancestor walk is pruned at those folders (loadBlockedFolderIds, once per call) and they are never listed.
// Security L1: a public file that needs its resource key is handed to the AI as an opaque, MCP-bound `drf_` ref
// (file-ref.ts), never as a link carrying `resourcekey=`; refs are accepted wherever a Drive file / folder is.
// Errors are DriveError (Vietnamese message + hint) - converted to tool errors by driveToolError / driveCall.
// No imports from "next/*". Credentials / resource keys are decrypted here and never returned to the AI.
import { loadBlockedFolderIds } from "../drive/blocked"
import { isDriveError, DriveError } from "../drive/errors"
import {
  decodeDriveFileRef,
  encodeDriveFileRef,
  isDriveFileRef,
} from "../drive/file-ref"
import { toDriveError } from "../drive/client"
import {
  findAncestorIn,
  getDriveFile,
  resolveShortcut,
  driveContentKey,
} from "../drive/files"
import { isDriveId, parseDriveLink } from "../drive/links"
import {
  decryptSourceResourceKey,
  driveAuthForCredential,
  isDriveCredentialUsable,
  loadDriveCredential,
  loadDriveSource,
  systemApiKeyAuth,
} from "../drive/store"
import {
  DRIVE_FOLDER_MIME,
  DRIVE_SHORTCUT_MIME,
  type DriveAuth,
  type DriveFile,
  type DriveLink,
  type DriveMediaFamily,
} from "../drive/types"
import { McpToolError, denied, invalid } from "./errors"
import type { GrantDriveSource, McpGrant } from "./types"

/** how a file was reached: a granted folder's service account, or the system API key (public link) */
export type DriveAccess =
  { type: "service_account"; credentialId: string } | { type: "api_key" }

export interface ResolvedDriveItem {
  /** the file itself (a shortcut is replaced by its target) */
  file: DriveFile
  auth: DriveAuth
  access: DriveAccess
  /** the granted folder source the file sits in; null = public link */
  source: GrantDriveSource | null
  /** resource key to send with downloads (public links shared before 2021), never returned to the AI */
  resourceKey: string | null
  /** driveContentKey(file): null when Drive gives no version (no reuse, no relay) */
  contentKey: string | null
  /** media only */
  family: DriveMediaFamily | null
}

/**
 * Folder ids a granted folder must never open for this MCP: live PERSONAL folder sources of users other than the MCP
 * owner (empty for an admin-owned MCP - G4). Load once per tool call and pass it down.
 */
export function loadDriveBlocked(grant: McpGrant): Promise<Set<string>> {
  return loadBlockedFolderIds({ id: grant.ownerId, role: grant.ownerRole })
}

/** Public links usable by this MCP: the per-MCP switch (G6) AND a system API key. */
export function drivePublicUsable(grant: McpGrant): boolean {
  return grant.settings.drivePublicLinks && grant.drivePublicAvailable
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const DENIED_CODES = new Set([
  "not_in_scope",
  "public_links_disabled",
  "writeback_disabled",
  "not_public",
])

/** DriveError → tool error `drive_<code>` (message + hint from i18n, never a URL / key). */
export function driveToolError(e: DriveError): McpToolError {
  return new McpToolError({
    code: `drive_${e.code}`,
    messageVi: e.userMessageVi,
    hint: e.hintVi ?? undefined,
    logStatus: DENIED_CODES.has(e.code)
      ? "denied"
      : e.code === "rate_limited" || e.code === "sheet_busy"
        ? "rate_limited"
        : e.code === "invalid_link"
          ? "invalid_request"
          : "error",
  })
}

/** Run a Drive / Sheets call; DriveError (and Google auth / network errors) become tool errors. */
export async function driveCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw asToolError(e)
  }
}

/** McpToolError / RangeError pass through; anything else is mapped through toDriveError. */
export function asToolError(e: unknown): unknown {
  if (e instanceof McpToolError || e instanceof RangeError) return e
  if (isDriveError(e)) return driveToolError(e)
  if (
    e instanceof Error &&
    (e.name === "AbortError" || e.name === "TimeoutError")
  )
    return driveToolError(new DriveError("timeout"))
  return driveToolError(toDriveError(e))
}

// ---------------------------------------------------------------------------
// Sources & credentials
// ---------------------------------------------------------------------------

/** A granted source by id (and kind). Unknown / other kind → denied drive_source_not_in_scope. */
export function assertDriveSource(
  grant: McpGrant,
  sourceId: string,
  kind?: GrantDriveSource["kind"]
): GrantDriveSource {
  const id = String(sourceId ?? "").trim()
  const source = grant.driveSources.find(
    (s) => s.id === id && (!kind || s.kind === kind)
  )
  if (!source) {
    const what =
      kind === "sheet"
        ? "Google Sheet"
        : kind === "folder"
          ? "thư mục Drive"
          : "nguồn Drive"
    throw denied(
      "drive_source_not_in_scope",
      `${what} "${id.slice(0, 64)}" không thuộc phạm vi của MCP này.`,
      "Gọi drive_list_sources để lấy đúng source_id."
    )
  }
  return source
}

/** Service-account auth of a credential, or null when it is gone / disabled. Decrypt failure → DriveError auth_failed. */
export async function credentialAuth(
  credentialId: string
): Promise<DriveAuth | null> {
  const row = await loadDriveCredential(credentialId)
  if (!row || !isDriveCredentialUsable(row)) return null
  return driveAuthForCredential(row)
}

/** Auth + stored resource key of a granted source (re-checks that the source is still live). */
export async function sourceAccess(
  source: GrantDriveSource
): Promise<{ auth: DriveAuth; resourceKey: string | null }> {
  const row = await loadDriveSource(source.id)
  if (
    !row ||
    row.status === "disabled" ||
    row.credentialId !== source.credentialId
  )
    throw new DriveError("not_in_scope")
  const auth = await credentialAuth(source.credentialId)
  if (!auth) throw new DriveError("auth_failed")
  return { auth, resourceKey: decryptSourceResourceKey(row) }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Drive "not found" family: try the next credential / answer not_in_scope. */
function isMissing(e: unknown): boolean {
  return (
    isDriveError(e) &&
    (e.code === "not_found" ||
      e.code === "permission_denied" ||
      e.code === "not_public")
  )
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
}

/** Media family of a mime type; null for anything we cannot upload. */
export function mediaFamily(mime: string): DriveMediaFamily | null {
  const m = mime.toLowerCase()
  if (m.startsWith("image/")) return "image"
  if (m.startsWith("video/")) return "video"
  return null
}

/**
 * Resolve a Drive file (want "media") or folder (want "folder") named by the AI. See the header comment for the
 * rules. Throws DriveError (convert with driveCall / driveToolError) or McpToolError (bad input).
 */
export async function resolveDriveItem(
  grant: McpGrant,
  ref: string,
  o: {
    want: "media" | "folder"
    allowPublic: boolean
    signal?: AbortSignal
    /** loadDriveBlocked(grant) of this call (loaded here when omitted) */
    blocked?: ReadonlySet<string>
  }
): Promise<ResolvedDriveItem> {
  const raw = String(ref ?? "").trim()
  const link = parseDriveRef(grant, raw)
  if (o.want === "media") {
    if (link.kind === "folder") {
      throw invalid(
        "drive_folder_link",
        "Đây là link thư mục Drive, không phải link file.",
        "Gọi drive_list_files với thư mục này để lấy file_id của từng ảnh / video."
      )
    }
    if (link.kind === "sheet" || link.kind === "document")
      throw new DriveError("not_downloadable")
  } else if (link.kind !== "folder" && link.kind !== "unknown") {
    throw invalid(
      "drive_not_folder",
      "Link này không phải link thư mục Google Drive.",
      "Dán link dạng drive.google.com/drive/folders/…."
    )
  }
  // a drf_ ref stands for a public link (with its resource key)
  const isLink = isHttpUrl(raw) || isDriveFileRef(raw)
  const wanted = (f: DriveFile) =>
    o.want === "folder"
      ? f.mimeType === DRIVE_FOLDER_MIME
      : f.mimeType !== DRIVE_FOLDER_MIME

  // 1. granted folders, one credential at a time (deterministic order: grant order)
  const groups = new Map<string, GrantDriveSource[]>()
  for (const s of grant.driveSources) {
    if (s.kind !== "folder") continue
    const g = groups.get(s.credentialId)
    if (g) g.push(s)
    else groups.set(s.credentialId, [s])
  }
  let infraError: unknown = null
  let found: {
    target: DriveFile
    auth: DriveAuth
    credentialId: string
    source: GrantDriveSource | null
    rk: string | null
  } | null = null
  const blocked =
    groups.size === 0
      ? new Set<string>()
      : (o.blocked ?? (await loadDriveBlocked(grant)))
  for (const [credentialId, sources] of groups) {
    try {
      const auth = await credentialAuth(credentialId)
      if (!auth) continue
      const file = await getDriveFile(auth, link.id, {
        resourceKey: link.resourceKey,
        signal: o.signal,
      })
      let rk = link.resourceKey
      let target = file
      if (file.mimeType === DRIVE_SHORTCUT_MIME) {
        rk = file.shortcut?.targetResourceKey ?? null
        target = await resolveShortcut(auth, file, o.signal)
      }
      if (!wanted(target)) continue
      // another user's personal folder (or a file id that happens to be one): never through a granted folder
      if (blocked.has(target.id)) continue
      const ids = new Set(sources.map((s) => s.googleId))
      const match = await findAncestorIn(auth, target, ids, {
        signal: o.signal,
        blocked,
      })
      if (!match) continue
      const source = sources.find((s) => s.googleId === match) ?? null
      found = { target, auth, credentialId, source, rk: target.resourceKey ?? rk }
      break
    } catch (e) {
      if (isMissing(e)) continue
      if (e instanceof McpToolError) throw e
      // a broken credential / Google hiccup: remember it, try the other credentials first
      infraError ??= e
    }
  }
  // in a granted folder: checked outside the loop (a trashed / unusable file must not fall through to "not found")
  if (found) {
    return finalize(
      found.target,
      found.auth,
      { type: "service_account", credentialId: found.credentialId },
      found.source,
      found.rk,
      o.want
    )
  }
  // a granted folder could not be checked (broken credential, Google down): say so rather than "not found"
  const notFound = (
    code: "not_in_scope" | "not_public" | "public_links_disabled"
  ) =>
    infraError
      ? isDriveError(infraError)
        ? infraError
        : toDriveError(infraError)
      : new DriveError(code)

  // 2. public "Anyone with the link" - API key only
  if (!o.allowPublic) {
    throw notFound(
      isLink && !grant.settings.drivePublicLinks
        ? "public_links_disabled"
        : "not_in_scope"
    )
  }
  const apiAuth = await systemApiKeyAuth()
  if (!apiAuth) throw notFound("not_in_scope")
  try {
    const file = await getDriveFile(apiAuth, link.id, {
      resourceKey: link.resourceKey,
      signal: o.signal,
    })
    let rk = link.resourceKey
    let target = file
    if (file.mimeType === DRIVE_SHORTCUT_MIME) {
      rk = file.shortcut?.targetResourceKey ?? null
      target = await resolveShortcut(apiAuth, file, o.signal)
    }
    if (!wanted(target))
      throw new DriveError(
        o.want === "folder" ? "invalid_link" : "not_downloadable"
      )
    return finalize(
      target,
      apiAuth,
      { type: "api_key" },
      null,
      target.resourceKey ?? rk,
      o.want
    )
  } catch (e) {
    if (isMissing(e)) throw notFound(isLink ? "not_public" : "not_in_scope")
    throw e
  }
}

function finalize(
  file: DriveFile,
  auth: DriveAuth,
  access: DriveAccess,
  source: GrantDriveSource | null,
  resourceKey: string | null,
  want: "media" | "folder"
): ResolvedDriveItem {
  if (file.trashed) throw new DriveError("not_found")
  if (want === "folder") {
    return {
      file,
      auth,
      access,
      source,
      resourceKey,
      contentKey: null,
      family: null,
    }
  }
  if (file.mimeType.startsWith("application/vnd.google-apps."))
    throw new DriveError("not_downloadable")
  const family = mediaFamily(file.mimeType)
  if (!family) throw new DriveError("unsupported_type")
  if (!file.canDownload) throw new DriveError("not_downloadable")
  return {
    file,
    auth,
    access,
    source,
    resourceKey,
    contentKey: driveContentKey(file),
    family,
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/**
 * A Drive file / folder named by the AI → DriveLink: an opaque `drf_` ref of THIS MCP (security L1) or a bare id /
 * Drive link. A drf_ ref that is malformed, of another MCP, tampered or expired → not_in_scope (with its own hint).
 */
export function parseDriveRef(grant: McpGrant, raw: string): DriveLink {
  if (isDriveFileRef(raw)) {
    const p = decodeDriveFileRef(grant.mcpId, raw)
    if (!p) {
      throw new DriveError("not_in_scope", {
        message:
          "Mã file Drive (drf_…) không hợp lệ hoặc đã hết hạn (dùng được 24 giờ, chỉ trong MCP đã cấp).",
        hint: "Gọi lại drive_list_files / drive_sheet_read để lấy mã mới.",
      })
    }
    return { kind: "unknown", id: p.fileId, resourceKey: p.resourceKey, gid: null }
  }
  const link = parseDriveLink(raw)
  if (!link) throw new DriveError("invalid_link")
  return link
}

/**
 * What the AI passes back to ads_upload_media / drive_list_files: the bare file id, or - only when Drive requires it
 * (public links of files shared before 2021) - an opaque `drf_` ref bound to this MCP (24 h) that carries the resource
 * key encrypted. Never a link with `resourcekey=` (security L1).
 */
export function driveFileRef(
  mcpId: string,
  fileId: string,
  resourceKey: string | null
): string {
  return resourceKey
    ? encodeDriveFileRef(mcpId, { fileId, resourceKey })
    : fileId
}

/** Drive ids look like this (and long enough not to be an ordinary word in a sheet cell). */
export function looksLikeDriveId(s: string): boolean {
  return s.length >= 25 && isDriveId(s)
}
