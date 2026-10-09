// Drive v3 REST (https://www.googleapis.com/drive/v3) - metadata, folder listing, downloads, ancestry.
// Every request: supportsAllDrives=true; `X-Goog-Drive-Resource-Keys: <id>/<key>` when a resource key is known;
// api_key auth → `key=` query param and NO Authorization header; retries (backoff) only for metadata calls.
// No imports from "next/*".
import {
  DRIVE_API_BASE,
  DRIVE_SCOPES,
  DRIVE_TIMEOUTS,
  driveJson,
  driveStream,
  isAllowedGoogleHost,
  toDriveError,
} from "./client"
import { DriveError, isDriveError } from "./errors"
import { isDriveId } from "./links"
import {
  DRIVE_FOLDER_MIME,
  DRIVE_LIMITS,
  DRIVE_SHORTCUT_MIME,
  type DriveAuth,
  type DriveDownload,
  type DriveFile,
  type DriveListOptions,
  type DriveListPage,
} from "./types"
import { getGoogleAccessToken } from "../google/service-account"

export { DRIVE_SCOPES }

/** files.get / files.list fields (DriveFile) */
export const DRIVE_FILE_FIELDS =
  "id,name,mimeType,size,md5Checksum,headRevisionId,version,modifiedTime,parents,trashed,driveId," +
  "imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis)," +
  "capabilities(canDownload,canEdit),resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey)"

/** metadata calls made by one ancestor walk at most (several parents per level are rare) */
const ANCESTOR_MAX_CALLS = 50
const THUMBNAIL_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

interface RawFile {
  id?: unknown
  name?: unknown
  mimeType?: unknown
  size?: unknown
  md5Checksum?: unknown
  headRevisionId?: unknown
  version?: unknown
  modifiedTime?: unknown
  parents?: unknown
  trashed?: unknown
  driveId?: unknown
  imageMediaMetadata?: { width?: unknown; height?: unknown } | null
  videoMediaMetadata?: {
    width?: unknown
    height?: unknown
    durationMillis?: unknown
  } | null
  capabilities?: { canDownload?: unknown; canEdit?: unknown } | null
  resourceKey?: unknown
  shortcutDetails?: {
    targetId?: unknown
    targetMimeType?: unknown
    targetResourceKey?: unknown
  } | null
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null

/** int64 fields come as strings ("12345"); null when absent / not a safe non-negative integer */
function int(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d{1,16}$/.test(v)
        ? Number(v)
        : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function normalizeDriveFile(raw: unknown): DriveFile {
  const f = (raw && typeof raw === "object" ? raw : {}) as RawFile
  const id = str(f.id)
  if (!id) throw new DriveError("upstream_error", { retryable: false })
  const img = f.imageMediaMetadata ?? null
  const vid = f.videoMediaMetadata ?? null
  const sc = f.shortcutDetails ?? null
  const scTarget = sc ? str(sc.targetId) : null
  return {
    id,
    name: typeof f.name === "string" ? f.name : "",
    mimeType: str(f.mimeType) ?? "application/octet-stream",
    sizeBytes: int(f.size),
    md5: str(f.md5Checksum),
    headRevisionId: str(f.headRevisionId),
    version:
      f.version === undefined || f.version === null ? null : String(f.version),
    modifiedTime: str(f.modifiedTime),
    parents: Array.isArray(f.parents)
      ? f.parents.filter((p): p is string => typeof p === "string" && p !== "")
      : [],
    trashed: f.trashed === true,
    driveId: str(f.driveId),
    width: int(vid?.width) ?? int(img?.width),
    height: int(vid?.height) ?? int(img?.height),
    durationMs: int(vid?.durationMillis),
    canDownload: f.capabilities?.canDownload === true,
    canEdit: f.capabilities?.canEdit === true,
    resourceKey: str(f.resourceKey),
    shortcut: scTarget
      ? {
          targetId: scTarget,
          targetMimeType: str(sc?.targetMimeType),
          targetResourceKey: str(sc?.targetResourceKey),
        }
      : null,
  }
}

function assertId(id: string): void {
  if (!isDriveId(id)) throw new DriveError("invalid_link")
}

const fileUrl = (id: string) =>
  `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}`

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** files.get (metadata). 404 → DriveError not_found (api_key auth → not_public). */
export async function getDriveFile(
  auth: DriveAuth,
  fileId: string,
  opts: { resourceKey?: string | null; signal?: AbortSignal } = {}
): Promise<DriveFile> {
  assertId(fileId)
  const raw = await driveJson<unknown>(auth, {
    url: fileUrl(fileId),
    query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
    resourceKeys: [{ id: fileId, key: opts.resourceKey }],
    signal: opts.signal,
    timeoutMs: DRIVE_TIMEOUTS.metadataMs,
  })
  return normalizeDriveFile(raw)
}

/** RFC 3339 for a Drive query (re-serialised: nothing from the input reaches the query verbatim) */
function rfc3339(v: string): string {
  const t = Date.parse(v)
  if (!Number.isFinite(t))
    throw new TypeError("modifiedAfter must be an RFC 3339 date-time")
  return new Date(t).toISOString()
}

/** Drive query string literal: backslash and single quote escaped */
export function driveQueryLiteral(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

/** the `q` of listDriveFolder (exported for tests) */
export function buildFolderQuery(
  folderId: string,
  opts: Pick<
    DriveListOptions,
    "family" | "includeFolders" | "nameContains" | "modifiedAfter"
  > = {}
): string {
  const parts = [`${driveQueryLiteral(folderId)} in parents`, "trashed = false"]
  const mime: string[] = []
  if (opts.family === "image" || opts.family === "all")
    mime.push("mimeType contains 'image/'")
  if (opts.family === "video" || opts.family === "all")
    mime.push("mimeType contains 'video/'")
  if (mime.length && opts.includeFolders)
    mime.push(`mimeType = '${DRIVE_FOLDER_MIME}'`)
  if (mime.length)
    parts.push(mime.length === 1 ? mime[0]! : `(${mime.join(" or ")})`)
  const name = opts.nameContains?.trim()
  if (name) parts.push(`name contains ${driveQueryLiteral(name.slice(0, 200))}`)
  if (opts.modifiedAfter)
    parts.push(
      `modifiedTime > ${driveQueryLiteral(rfc3339(opts.modifiedAfter))}`
    )
  return parts.join(" and ")
}

/**
 * files.list `'<folderId>' in parents and trashed = false` (+ mime family / name / modified filters). No family →
 * every child (callers count what they skip). Shared drive folders (driveId) → corpora=drive.
 */
export async function listDriveFolder(
  auth: DriveAuth,
  folderId: string,
  opts: DriveListOptions = {}
): Promise<DriveListPage> {
  assertId(folderId)
  const pageSize = Math.min(1000, Math.max(1, Math.trunc(opts.pageSize ?? 100)))
  const corpora: Record<string, string> = opts.driveId
    ? { corpora: "drive", driveId: opts.driveId }
    : auth.type === "service_account"
      ? { corpora: "user" }
      : {}
  const raw = await driveJson<{ files?: unknown; nextPageToken?: unknown }>(
    auth,
    {
      url: `${DRIVE_API_BASE}/files`,
      query: {
        q: buildFolderQuery(folderId, opts),
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        pageSize,
        pageToken: opts.pageToken || undefined,
        orderBy: "folder,modifiedTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...corpora,
      },
      resourceKeys: [{ id: folderId, key: opts.resourceKey }],
      signal: opts.signal,
      timeoutMs: DRIVE_TIMEOUTS.listMs,
    }
  )
  const files = Array.isArray(raw?.files)
    ? raw.files.map(normalizeDriveFile)
    : []
  return {
    files,
    nextPageToken:
      typeof raw?.nextPageToken === "string" && raw.nextPageToken
        ? raw.nextPageToken
        : null,
  }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** largest piece readDriveRange reads into memory (one upload chunk at a time) */
export const DRIVE_RANGE_MAX_BYTES = 32 * 1024 * 1024

const CONTENT_RANGE_RE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/

/** a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range; anything else is ignored (full answer, RFC 9110) */
function validRange(range: string | null | undefined): string | null {
  const r = range?.trim()
  if (!r) return null
  return /^bytes=(\d{1,15}-\d{0,15}|-\d{1,15})$/.test(r) ? r : null
}

/**
 * files.get?alt=media as a stream (Range passed through → 206). Never buffers the body. Asks for the raw bytes
 * (`Accept-Encoding: identity`, security review L9): byte ranges / Content-Length must describe the file itself, so an
 * encoded answer is refused.
 */
export async function openDriveDownload(
  auth: DriveAuth,
  fileId: string,
  opts: {
    range?: string | null
    resourceKey?: string | null
    signal?: AbortSignal
  } = {}
): Promise<DriveDownload> {
  assertId(fileId)
  const range = validRange(opts.range)
  const res = await driveStream(auth, {
    url: fileUrl(fileId),
    query: { alt: "media", supportsAllDrives: true },
    resourceKeys: [{ id: fileId, key: opts.resourceKey }],
    headers: {
      Accept: "*/*",
      "Accept-Encoding": "identity",
      ...(range ? { Range: range } : {}),
    },
    signal: opts.signal,
    timeoutMs: DRIVE_TIMEOUTS.downloadHeadersMs,
  })
  const encoding = (res.headers.get("content-encoding") ?? "")
    .trim()
    .toLowerCase()
  if (
    (res.status !== 200 && res.status !== 206) ||
    (encoding !== "" && encoding !== "identity")
  ) {
    await res.body.cancel().catch(() => {})
    throw new DriveError("upstream_error", {
      httpStatus: res.status,
      retryable: false,
    })
  }
  const len = Number(res.headers.get("content-length"))
  return {
    status: res.status,
    body: res.body,
    contentLength:
      res.headers.get("content-length") !== null &&
      Number.isSafeInteger(len) &&
      len >= 0
        ? len
        : null,
    contentRange: res.headers.get("content-range"),
    contentType: res.headers.get("content-type"),
  }
}

/**
 * Bytes [start, endExclusive) of a file (Range GET) - the background video upload reads one chunk at a time with it.
 * The answer must be a 206 for exactly that range (else DriveError upstream_error); at most DRIVE_RANGE_MAX_BYTES.
 */
export async function readDriveRange(
  auth: DriveAuth,
  fileId: string,
  start: number,
  endExclusive: number,
  opts: { resourceKey?: string | null; signal?: AbortSignal } = {}
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    endExclusive <= start ||
    endExclusive - start > DRIVE_RANGE_MAX_BYTES
  )
    throw new RangeError("readDriveRange: invalid range")
  const want = endExclusive - start
  const dl = await openDriveDownload(auth, fileId, {
    range: `bytes=${start}-${endExclusive - 1}`,
    resourceKey: opts.resourceKey,
    signal: opts.signal,
  })
  const m = CONTENT_RANGE_RE.exec(dl.contentRange ?? "")
  if (
    dl.status !== 206 ||
    !m ||
    Number(m[1]) !== start ||
    Number(m[2]) !== endExclusive - 1 ||
    (dl.contentLength !== null && dl.contentLength !== want)
  ) {
    await dl.body.cancel().catch(() => {})
    throw new DriveError("upstream_error", { retryable: false })
  }
  const buf = await readCapped(dl.body, want)
  if (buf.length !== want)
    throw new DriveError("upstream_error", { retryable: true })
  return buf
}

/** Read a stream into memory, aborting past maxBytes (DriveError too_large). */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      size += r.value.byteLength
      if (size > maxBytes) throw new DriveError("too_large")
      chunks.push(
        Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength)
      )
    }
  } catch (e) {
    void reader.cancel().catch(() => {})
    throw toDriveError(e)
  }
  return Buffer.concat(chunks, size)
}

/** Download into memory, aborting past maxBytes (DriveError too_large). Images only (≤ 30 MB). */
export async function downloadDriveBytes(
  auth: DriveAuth,
  fileId: string,
  opts: { maxBytes: number; resourceKey?: string | null; signal?: AbortSignal }
): Promise<Buffer> {
  const dl = await openDriveDownload(auth, fileId, {
    resourceKey: opts.resourceKey,
    signal: opts.signal,
  })
  if (dl.contentLength !== null && dl.contentLength > opts.maxBytes) {
    await dl.body.cancel().catch(() => {})
    throw new DriveError("too_large")
  }
  return readCapped(dl.body, opts.maxBytes)
}

// ---------------------------------------------------------------------------
// Shortcuts & ancestry
// ---------------------------------------------------------------------------

/** Shortcut → its target's metadata (re-checked by the caller like any other file). Non-shortcuts returned as is. */
export async function resolveShortcut(
  auth: DriveAuth,
  file: DriveFile,
  signal?: AbortSignal
): Promise<DriveFile> {
  if (file.mimeType !== DRIVE_SHORTCUT_MIME) return file
  if (!file.shortcut) throw new DriveError("not_found")
  const target = await getDriveFile(auth, file.shortcut.targetId, {
    resourceKey: file.shortcut.targetResourceKey,
    signal,
  })
  // a shortcut cannot point at another shortcut; refuse rather than loop
  if (target.mimeType === DRIVE_SHORTCUT_MIME) throw new DriveError("not_found")
  return target
}

/** parents of a folder this auth can see; null = hidden (404 / 403) */
async function visibleParents(
  auth: DriveAuth,
  id: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  if (!isDriveId(id)) return null
  try {
    const raw = await driveJson<{ parents?: unknown }>(auth, {
      url: fileUrl(id),
      query: { fields: "id,parents", supportsAllDrives: true },
      signal,
      timeoutMs: DRIVE_TIMEOUTS.metadataMs,
    })
    return Array.isArray(raw?.parents)
      ? raw.parents.filter(
          (p): p is string => typeof p === "string" && p !== ""
        )
      : []
  } catch (e) {
    if (
      isDriveError(e) &&
      (e.code === "not_found" ||
        e.code === "permission_denied" ||
        e.code === "not_public")
    )
      return null
    throw e
  }
}

/** what the walk does after visiting a node: go on, stop the whole walk, or not climb above this node */
type WalkStep = "continue" | "stop" | "prune"

/**
 * Breadth-first walk over `parents` (nearest first), visited set against cycles, at most `maxDepth` levels and
 * ANCESTOR_MAX_CALLS metadata calls. `visit` returns "stop" to end the walk, "prune" to end this branch (its
 * parents are not expanded through it). Hidden parents end their branch silently.
 */
async function walkAncestors(
  auth: DriveAuth,
  file: DriveFile,
  maxDepth: number,
  visit: (id: string) => WalkStep,
  signal?: AbortSignal
): Promise<void> {
  const visited = new Set<string>([file.id])
  let level = file.parents.filter((p) => !visited.has(p))
  let calls = 0
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: string[] = []
    for (const id of level) {
      if (visited.has(id)) continue
      visited.add(id)
      const step = visit(id)
      if (step === "stop") return
      if (step === "prune") continue
      if (depth === maxDepth || calls >= ANCESTOR_MAX_CALLS) continue
      calls++
      const parents = await visibleParents(auth, id, signal)
      if (parents) for (const p of parents) if (!visited.has(p)) next.push(p)
    }
    level = next
  }
}

/**
 * Walk `parents` up to `maxDepth` levels (only the levels this auth can see) and return the first id found in
 * `candidates` (the file's own id counts when it is a folder), else null.
 * `blocked` (security review H1): folders the caller must not reach THROUGH (other people's personal folders). A
 * branch reaching a blocked id before a candidate is pruned - that path does not count; a candidate that is itself
 * blocked still counts (it is granted on its own). A file that is itself a blocked folder → null.
 */
export async function findAncestorIn(
  auth: DriveAuth,
  file: DriveFile,
  candidates: ReadonlySet<string>,
  opts: {
    maxDepth?: number
    signal?: AbortSignal
    blocked?: ReadonlySet<string>
  } = {}
): Promise<string | null> {
  if (file.mimeType === DRIVE_FOLDER_MIME && candidates.has(file.id))
    return file.id
  if (candidates.size === 0) return null
  const blocked = opts.blocked
  if (blocked?.has(file.id)) return null
  let found: string | null = null
  await walkAncestors(
    auth,
    file,
    opts.maxDepth ?? DRIVE_LIMITS.ancestorMaxDepth,
    (id) => {
      if (candidates.has(id)) {
        found = id
        return "stop"
      }
      return blocked?.has(id) ? "prune" : "continue"
    },
    opts.signal
  )
  return found
}

/** Ids of every visible ancestor (nearest first), up to maxDepth. */
export async function listAncestorIds(
  auth: DriveAuth,
  file: DriveFile,
  opts: { maxDepth?: number; signal?: AbortSignal } = {}
): Promise<string[]> {
  const out: string[] = []
  await walkAncestors(
    auth,
    file,
    opts.maxDepth ?? DRIVE_LIMITS.ancestorMaxDepth,
    (id) => {
      out.push(id)
      return "continue"
    },
    opts.signal
  )
  return out
}

/** Version key for de-duplication: md5 (binary files) or headRevisionId, plus the size. null = unknown. */
export function driveContentKey(file: DriveFile): string | null {
  if (file.md5 && file.sizeBytes !== null)
    return `md5:${file.md5}:${file.sizeBytes}`
  if (file.headRevisionId && file.sizeBytes !== null)
    return `rev:${file.headRevisionId}:${file.sizeBytes}`
  if (file.version) return `ver:${file.version}`
  return null
}

// ---------------------------------------------------------------------------
// Checks & thumbnails
// ---------------------------------------------------------------------------

/** Service account sanity check: token + files.list pageSize=1. Maps 403 accessNotConfigured → api_disabled. */
export async function checkServiceAccountAccess(
  auth: DriveAuth,
  signal?: AbortSignal
): Promise<void> {
  if (auth.type !== "service_account") throw new DriveError("not_configured")
  try {
    // a fresh token: a revoked / deleted key must fail the check even with a cached token
    await getGoogleAccessToken(auth.sa, DRIVE_SCOPES, {
      cacheKey: auth.cacheKey,
      signal,
      forceRefresh: true,
    })
  } catch (e) {
    throw toDriveError(e)
  }
  await driveJson<unknown>(auth, {
    url: `${DRIVE_API_BASE}/files`,
    query: {
      pageSize: 1,
      fields: "files(id)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    signal,
    timeoutMs: DRIVE_TIMEOUTS.metadataMs,
    retries: 0,
  })
}

/** Small preview image for the web UI (credentialed thumbnailLink fetch, ≤ 1 MB, image/* only). null = none. */
export async function fetchDriveThumbnail(
  auth: DriveAuth,
  fileId: string,
  opts: { resourceKey?: string | null; signal?: AbortSignal } = {}
): Promise<{ contentType: string; bytes: Buffer } | null> {
  assertId(fileId)
  const meta = await driveJson<{ thumbnailLink?: unknown }>(auth, {
    url: fileUrl(fileId),
    query: { fields: "id,thumbnailLink", supportsAllDrives: true },
    resourceKeys: [{ id: fileId, key: opts.resourceKey }],
    signal: opts.signal,
    timeoutMs: DRIVE_TIMEOUTS.metadataMs,
  })
  const link =
    typeof meta?.thumbnailLink === "string" ? meta.thumbnailLink : null
  if (!link) return null
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return null
  }
  if (
    u.protocol !== "https:" ||
    !u.hostname.toLowerCase().endsWith(".googleusercontent.com") ||
    !isAllowedGoogleHost(u.hostname)
  )
    return null
  let res
  try {
    res = await driveStream(auth, {
      url: u.toString(),
      headers: { Accept: "image/*" },
      signal: opts.signal,
      timeoutMs: DRIVE_TIMEOUTS.metadataMs,
    })
  } catch (e) {
    // an expired / missing thumbnail is "no thumbnail", not an error of the file
    if (
      isDriveError(e) &&
      (e.code === "not_found" ||
        e.code === "not_public" ||
        e.code === "permission_denied")
    )
      return null
    throw e
  }
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase()
  if (!THUMBNAIL_CONTENT_TYPES.has(contentType)) {
    await res.body.cancel().catch(() => {})
    return null
  }
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > DRIVE_LIMITS.thumbnailMaxBytes) {
    await res.body.cancel().catch(() => {})
    return null
  }
  try {
    return {
      contentType,
      bytes: await readCapped(res.body, DRIVE_LIMITS.thumbnailMaxBytes),
    }
  } catch (e) {
    if (isDriveError(e) && e.code === "too_large") return null
    throw e
  }
}
