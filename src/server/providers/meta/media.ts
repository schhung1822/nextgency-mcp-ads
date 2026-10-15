// ads_upload_media for Meta.
// Image: ONLY the bytes mcp-core downloaded through the SSRF-guarded fetch (MediaUploadRequest.bytes) are
//        uploaded (base64 `bytes` to /act_{id}/adimages, meta.md §5 Media). The adapter never fetches the
//        URL itself: a request without bytes is refused (no unguarded download path).
// Video: /act_{id}/advideos with file_url (Meta's servers download it - residual risk accepted: the fetch
//        happens on Meta's network, not ours), then poll status until ready within the wait budget
//        (deadlineAt wins, else maxWaitMs, default META_TIMINGS.videoMaxWaitMs); when the budget ends first the id is
//        returned with processing: true. The library name (`name` + `title`) is unique ("<name> · <6 hex>", D8): after
//        an ambiguous create timeout the video is looked up once by that title (GET advideos?title=, best effort [L])
//        and returned with recovered: true instead of "may have been created".
// Status (D7): video_status ready → usable; processing / unknown values → still processing; error / expired / a phase
//        with status error → failed (phase error messages, sanitised). getMetaMediaStatus = AdsProvider.getMediaStatus.
// Automatic video cover (D1-D3, used by meta_create_ad): Meta's preferred thumbnail of a READY video
//        (GET /{video_id}?fields=status,picture,thumbnails{uri,is_preferred,width,height}); the signed fbcdn uri is
//        downloaded by mcp-core's SSRF-guarded MutationOptions.fetchImage and uploaded as adimages bytes → image_hash
//        (Meta: do not use FB CDN URLs as image_url). The uri is never returned, logged or stored.
// Large videos (background job): uploadMetaVideoChunked - resumable upload_phase start → transfer → finish on
//        graph-video.facebook.com (meta.md §5 Media "Upload theo phần"), chunk offsets decided by Meta.
// deadlineAt: create calls use min(own timeout, deadlineAt - now - 1 s); a create call that times out is never retried
//        (the media may exist - media-deadline.ts).
import { randomBytes } from "node:crypto"

import { redactString } from "../../audit/redact"
import { sanitizeExternalLabel } from "../../../lib/text-safety"
import { isProviderError, ProviderError } from "../errors"
import {
  anySignal,
  checkOffsets,
  createOnce,
  createTimeoutMs,
  isTransientChunkError,
  maybeCreatedError,
  pollCallTimeoutMs,
  processingDeadline,
} from "../media-deadline"
import { sleep } from "../rate-limit"
import type {
  ChunkedVideoUploadRequest,
  MediaRef,
  MediaStatus,
  MediaUploadRequest,
  MutationOptions,
  ProviderContext,
} from "../types"
import {
  META_TIMINGS,
  actId,
  graph,
  type GraphErrorBody,
  type MetaCallContext,
  type MetaCredentials,
} from "./client"
import { callCtx, invalid } from "./shared"

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** Video status / cover / recovery tuning - mutable for tests. */
export const META_VIDEO = {
  /** GET advideos?title= after an ambiguous file_url timeout (runs after the deadline: kept short) */
  recoveryLookupMs: 6_000,
  /** a recovered video must have been created at most this long before the upload call started */
  recoverySkewMs: 60_000,
  /** status (+ thumbnails) read of one video */
  infoTimeoutMs: 10_000,
  /** ownership fallback scan of act/advideos (C-M2): page size and pages */
  scanPageSize: 100,
  scanPages: 2,
}

/** Unique, recognisable library name of a file_url upload (D8): "<name> · <6 hex chars>" (≤ 255 chars). */
export function uniqueVideoName(base: string | undefined): string {
  const clean = (base ?? "").replace(/\s+/g, " ").trim() || "video"
  return `${clean.slice(0, 240)} · ${randomBytes(3).toString("hex")}`
}

/** Resumable (chunked) video upload tuning - mutable for tests. */
export const META_CHUNKED = {
  /** POST start / finish */
  phaseTimeoutMs: 120_000,
  /** POST transfer of one chunk (Meta picks the chunk size - ~50 MB in its examples) */
  transferTimeoutMs: 300_000,
  /**
   * refuse server offsets asking for more than this in one chunk (memory bound: the chunk is held in memory once as
   * pieces + once as the multipart Blob; Meta asks for ~50 MB per chunk - meta.md §5 Media)
   */
  maxChunkBytes: 64 * 1024 * 1024,
  /** one readChunk call reads at most this (Drive Range reads are capped at 32 MB) */
  readPieceBytes: 16 * 1024 * 1024,
  /** re-sends of the SAME chunk after a network / 5xx error (or Meta's 1363037 offset correction) */
  chunkRetries: 2,
  retryDelayMs: 1_000,
}

/** Meta answers a transfer with this subcode + error_data {start_offset, end_offset} when it wants another range. */
const SUBCODE_RESEND_RANGE = 1363037

function mediaError(messageVi: string, message: string): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "invalid_request",
    message,
    userMessageVi: messageVi,
  })
}

function looksLikeImage(buf: Buffer): boolean {
  const b = buf.subarray(0, 12)
  return (
    (b[0] === 0xff && b[1] === 0xd8) || // jpeg
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // png
    b.subarray(0, 4).toString("ascii") === "GIF8" ||
    (b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP") ||
    b.subarray(0, 2).toString("ascii") === "BM" ||
    b.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    b.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  )
}

interface AdImagesResponse {
  images?: Record<string, { hash?: string; url?: string }>
}

export async function uploadMetaMedia(
  ctx: ProviderContext<MetaCredentials>,
  r: MediaUploadRequest
): Promise<MediaRef> {
  const account = actId(ctx.account.externalId)
  const call = callCtx(ctx)

  if (r.type === "image") {
    // bytes pre-fetched by mcp-core through the SSRF guard: never fetch the URL here (DNS rebinding, internal targets)
    if (!r.bytes) {
      throw new ProviderError({
        platform: "meta",
        code: "invalid_request",
        message: "meta image upload requires pre-fetched bytes (SSRF-guarded)",
        userMessageVi: "Lỗi nội bộ: ảnh chưa được tải qua bộ lọc an toàn.",
      })
    }
    const bytes = Buffer.from(r.bytes)
    const contentType = r.contentType ?? null
    if (bytes.length > MAX_IMAGE_BYTES)
      throw mediaError(
        `Ảnh quá lớn (tối đa ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`,
        `bytes ${bytes.length}`
      )
    if (
      contentType &&
      !contentType.toLowerCase().startsWith("image/") &&
      !looksLikeImage(bytes)
    ) {
      throw mediaError(
        "URL không phải file ảnh.",
        `content-type ${contentType}`
      )
    }
    if (!looksLikeImage(bytes))
      throw mediaError(
        "File tải về không phải ảnh hợp lệ (JPG/PNG/GIF/WEBP/BMP/TIFF).",
        "magic mismatch"
      )
    const timeoutMs = createTimeoutMs("meta", 120_000, r.deadlineAt)
    const res = await createOnce("meta", () =>
      graph<AdImagesResponse>(call, {
        method: "POST",
        path: `${account}/adimages`,
        params: { bytes: bytes.toString("base64") },
        multipart: true,
        idempotent: false,
        timeoutMs,
      })
    )
    const first = Object.values(res.images ?? {})[0]
    if (!first?.hash) {
      throw new ProviderError({
        platform: "meta",
        code: "upstream_error",
        message: "meta: adimages returned no hash",
        userMessageVi: "Meta không trả mã ảnh (image_hash).",
      })
    }
    return { type: "image", id: first.hash, url: first.url ?? null }
  }

  // image bytes never need the URL (informational only); a video is fetched by Meta from it
  if (!/^https?:\/\//i.test(r.url))
    throw invalid("URL phải bắt đầu bằng http:// hoặc https://.")
  const videoName = uniqueVideoName(r.name || r.fileName)
  const timeoutMs = createTimeoutMs("meta", 120_000, r.deadlineAt)
  const startedAt = Date.now()
  let created: { id?: string }
  try {
    created = await graph<{ id?: string }>(call, {
      method: "POST",
      path: `${account}/advideos`,
      // name + title: which one feeds the advideos `title` filter is undocumented [L] - send both
      params: { file_url: r.url, name: videoName, title: videoName },
      idempotent: false,
      timeoutMs,
    })
  } catch (e) {
    if (!isProviderError(e) || e.code !== "timeout") throw e
    // never re-sent: look the video up once by its unique title (best effort), else "may have been created"
    const found = await recoverVideoByTitle(call, account, videoName, startedAt)
    if (found)
      return { type: "video", id: found, url: null, processing: true, recovered: true }
    throw maybeCreatedError("meta", e)
  }
  if (!created.id) {
    throw new ProviderError({
      platform: "meta",
      code: "upstream_error",
      message: "meta: advideos returned no id",
      userMessageVi: "Meta không trả video_id.",
    })
  }
  return waitMetaVideo(
    call,
    created.id,
    processingDeadline(r, META_TIMINGS.videoMaxWaitMs)
  )
}

/**
 * GET act_{id}/advideos?title=<unique name> once after an ambiguous file_url timeout (D8, [L]: exact vs substring
 * match and name → title are undocumented, so the title is compared here too). Exactly one video with that title,
 * created around the upload → its id; anything else (none, several, an error) → null. Never throws.
 */
async function recoverVideoByTitle(
  call: MetaCallContext,
  account: string,
  title: string,
  startedAt: number
): Promise<string | null> {
  try {
    const res = await graph<{
      data?: { id?: unknown; title?: unknown; created_time?: unknown }[]
    }>(
      call,
      {
        method: "GET",
        path: `${account}/advideos`,
        params: { title, fields: "id,title,created_time", limit: 10 },
        idempotent: true,
        timeoutMs: META_VIDEO.recoveryLookupMs,
      }
    )
    const since = startedAt - META_VIDEO.recoverySkewMs
    const hits = (res.data ?? []).filter((v) => {
      if (v.id === undefined || v.id === null || v.title !== title) return false
      // a missing / unparsable created_time is not a match (S-L4)
      const at = typeof v.created_time === "string" ? metaTime(v.created_time) : NaN
      return !Number.isNaN(at) && at >= since
    })
    return hits.length === 1 ? String(hits[0]!.id) : null
  } catch {
    return null
  }
}

/** Meta times look like 2026-10-15T08:00:00+0000 (no colon in the offset). */
function metaTime(s: string): number {
  return Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
}

interface PhaseStatus {
  status?: string
  errors?: { code?: unknown; message?: unknown }[]
}

interface RawVideoStatus {
  video_status?: string
  processing_progress?: unknown
  uploading_phase?: PhaseStatus
  processing_phase?: PhaseStatus
  publishing_phase?: PhaseStatus
}

/** Normalised status of one video (D7). */
export interface MetaVideoState {
  kind: "ready" | "processing" | "failed"
  /** Meta's video_status as sent (for logs / tests) */
  raw: string | null
  /** processing_progress 0-100 when sent */
  progress: number | null
  /** failed: Vietnamese reason (phase error messages sanitised), else null */
  error: string | null
}

const KNOWN_VIDEO_STATUSES = new Set(["ready", "processing", "error", "expired"])

/** Phase error messages, sanitised (no URL / secret, ≤ 300 chars), or null. */
function phaseErrors(st: RawVideoStatus): string | null {
  const msgs: string[] = []
  for (const phase of [st.uploading_phase, st.processing_phase, st.publishing_phase]) {
    for (const err of phase?.errors ?? []) {
      if (typeof err?.message === "string" && err.message.trim())
        msgs.push(err.message.trim())
    }
  }
  if (msgs.length === 0) return null
  const text = redactString([...new Set(msgs)].join("; ")).replace(/https?:\/\/\S+/gi, "[url]")
  // external text shown to the AI: one line, no control / bidi / zero-width characters (S-L3)
  return sanitizeExternalLabel(text, 300)
}

/**
 * status object of GET /{video_id}?fields=status → ready / processing / failed (D7). error, expired or a phase whose
 * status is "error" = failed; unknown values (and a missing status) = still processing (logged without data).
 */
export function classifyVideoStatus(st: RawVideoStatus | undefined): MetaVideoState {
  const raw = typeof st?.video_status === "string" ? st.video_status : null
  const p = Number(st?.processing_progress)
  const progress =
    st?.processing_progress !== undefined && Number.isFinite(p)
      ? Math.max(0, Math.min(100, Math.round(p)))
      : null
  const phaseFailed = [st?.uploading_phase, st?.processing_phase, st?.publishing_phase].some(
    (ph) => ph?.status === "error"
  )
  if (raw === "ready" && !phaseFailed)
    return { kind: "ready", raw, progress: 100, error: null }
  if (raw === "error" || raw === "expired" || phaseFailed) {
    const reason =
      (st && phaseErrors(st)) ??
      (raw === "expired"
        ? "phiên tải video đã hết hạn hoặc bị huỷ trên Meta"
        : "định dạng/kích thước không hợp lệ hoặc Meta không tải được file")
    return { kind: "failed", raw, progress, error: reason }
  }
  if (raw !== null && !KNOWN_VIDEO_STATUSES.has(raw))
    console.warn(`[meta] unknown video_status "${raw.slice(0, 40).replace(/[^\w-]/g, "?")}" - treated as processing`)
  return { kind: "processing", raw, progress, error: null }
}

interface RawThumb {
  uri?: unknown
  is_preferred?: unknown
}

/** Status of a video (+ Meta's preferred thumbnail uri when asked) - the uri is a signed CDN URL: never returned. */
export interface MetaVideoInfo extends MetaVideoState {
  id: string
  /** preferred thumbnail (else the first one, else `picture` of a READY video); null when none / not asked */
  thumbnailUri: string | null
}

/** GET /{video_id}?fields=status(+picture,thumbnails{…}) → normalised status (+ thumbnail uri). */
export async function readMetaVideo(
  call: MetaCallContext,
  id: string,
  o: { thumbnails?: boolean; timeoutMs?: number } = {}
): Promise<MetaVideoInfo> {
  type Res = { status?: RawVideoStatus; picture?: unknown; thumbnails?: { data?: RawThumb[] } }
  const read = (fields: string) =>
    graph<Res>(call, {
      method: "GET",
      path: id,
      params: { fields },
      idempotent: true,
      timeoutMs: o.timeoutMs ?? META_VIDEO.infoTimeoutMs,
    })
  let res: Res
  if (!o.thumbnails) res = await read("status")
  else {
    try {
      res = await read("status,picture,thumbnails{uri,is_preferred,width,height}")
    } catch (e) {
      // C-M1: the thumbnails{…} expansion is not documented for ad videos - one retry without it (picture only)
      if (isProviderError(e) && ["auth_invalid", "rate_limited", "timeout", "not_found", "permission_denied"].includes(e.code)) throw e
      res = await read("status,picture")
    }
  }
  const state = classifyVideoStatus(res.status)
  let thumbnailUri: string | null = null
  if (o.thumbnails && state.kind === "ready") {
    const list = (res.thumbnails?.data ?? []).filter(
      (t) => typeof t?.uri === "string" && /^https:\/\//i.test(t.uri)
    )
    const pick = list.find((t) => t.is_preferred === true) ?? list[0]
    // `picture` only once ready: while processing it is Meta's generic placeholder
    thumbnailUri =
      (pick?.uri as string | undefined) ??
      (typeof res.picture === "string" && /^https:\/\//i.test(res.picture) ? res.picture : null)
  }
  return { ...state, id, thumbnailUri }
}

/** Video still processing (D4): a non-retryable tool error "video_processing". */
export function videoProcessingError(id: string, progress: number | null): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "invalid_request",
    toolCode: "video_processing",
    message: `meta: video ${id} is still processing`,
    userMessageVi: `Video ${id} đang được Meta xử lý${progress !== null ? ` (${progress}%)` : ""} nên chưa lấy được ảnh bìa tự động - chưa tạo quảng cáo.`,
    hint: "Thử lại sau ít phút (xem trạng thái bằng ads_get_media_upload với video_id), hoặc truyền ảnh bìa: image_drive_file (ảnh trên Google Drive), image_hash hoặc image_url.",
  })
}

/** Video processing failed / expired (D4): tool error "video_failed" with Meta's (sanitised) reason. */
export function videoFailedError(id: string, reason: string | null): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "invalid_request",
    toolCode: "video_failed",
    message: `meta: video ${id} processing failed`,
    userMessageVi: `Meta xử lý video ${id} thất bại${reason ? `: ${reason}` : ""}. Video này không dùng được để tạo quảng cáo.`,
    hint: "Kiểm tra video (MP4/MOV, H.264, không quá ngắn) rồi tải lên lại bằng ads_upload_media (video Google Drive: force_reupload=true).",
  })
}

/** Ready video without any thumbnail (D1 auto cover impossible). */
function noThumbnailError(id: string): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "invalid_request",
    toolCode: "video_thumbnail_missing",
    message: `meta: video ${id} has no thumbnail`,
    userMessageVi: `Meta chưa có ảnh bìa tự động cho video ${id} - chưa tạo quảng cáo.`,
    hint: "Truyền ảnh bìa: image_drive_file (ảnh trên Google Drive), image_hash (ads_upload_media) hoặc image_url.",
  })
}

/**
 * Signed uri of Meta's preferred thumbnail of a READY video (D1). processing → video_processing, failed →
 * video_failed, ready without thumbnail → video_thumbnail_missing. The uri is for immediate use only (validate_only
 * preview or a download right away) - never returned, logged or stored.
 */
export async function metaVideoCoverUri(
  ctx: ProviderContext<MetaCredentials>,
  videoId: string,
  deadlineAt?: number
): Promise<string> {
  const info = await readMetaVideo(callCtx(ctx), videoId, {
    thumbnails: true,
    timeoutMs: stepTimeout(META_VIDEO.infoTimeoutMs, deadlineAt),
  })
  if (info.kind === "processing") throw videoProcessingError(videoId, info.progress)
  if (info.kind === "failed") throw videoFailedError(videoId, info.error)
  if (!info.thumbnailUri) throw noThumbnailError(videoId)
  return info.thumbnailUri
}

/**
 * D2: download Meta's thumbnail through mcp-core's SSRF-guarded fetch (opts.fetchImage) and upload the BYTES to
 * adimages → image_hash. Any download failure becomes a neutral error that never carries the uri.
 */
/** Timeout of one cover sub-step: its own bound, never past the execution deadline (≥ 1 s). */
function stepTimeout(ownMs: number, deadlineAt?: number): number {
  if (deadlineAt === undefined) return ownMs
  return Math.max(1_000, Math.min(ownMs, deadlineAt - Date.now()))
}

export async function uploadMetaCoverFromUri(
  ctx: ProviderContext<MetaCredentials>,
  uri: string,
  fetchImage: MutationOptions["fetchImage"],
  deadlineAt?: number
): Promise<string> {
  if (!fetchImage) {
    throw new ProviderError({
      platform: "meta",
      code: "invalid_request",
      message: "meta: automatic video cover needs mcp-core's guarded image fetch",
      userMessageVi: "Lỗi nội bộ: chưa có bộ tải ảnh an toàn để lấy ảnh bìa video.",
    })
  }
  let img: { bytes: Uint8Array; contentType: string }
  try {
    img = await fetchImage(uri, { maxBytes: MAX_IMAGE_BYTES })
  } catch {
    // the cause may describe the signed URL: dropped on purpose
    throw new ProviderError({
      platform: "meta",
      code: "upstream_error",
      toolCode: "video_cover_failed",
      message: "meta: automatic video cover download failed",
      userMessageVi: "Không tải được ảnh bìa Meta tự chọn của video - chưa tạo quảng cáo.",
      hint: "Thử lại sau ít phút, hoặc truyền ảnh bìa: image_drive_file (ảnh trên Google Drive) hoặc image_hash.",
    })
  }
  const ref = await uploadMetaMedia(ctx, {
    type: "image",
    // informational only (the adapter uses the bytes): never the signed uri
    url: "meta-video-thumbnail",
    bytes: img.bytes,
    contentType: img.contentType,
    fileName: "video-cover.jpg",
    deadlineAt,
  })
  return ref.id
}

/**
 * AdsProvider.getMediaStatus (D7): live status of a video. verifyAccount (an id typed by the AI): the video must be
 * in this ad account's library - GET act/advideos filtering id IN [id] ([M]: works in practice, undocumented);
 * not listed (or the check fails) → not_found.
 */
export async function getMetaMediaStatus(
  ctx: ProviderContext<MetaCredentials>,
  q: { type: "video"; id: string; verifyAccount?: boolean }
): Promise<MediaStatus> {
  if (!/^\d{1,30}$/.test(q.id)) throw invalid("video_id chỉ gồm chữ số.")
  const call = callCtx(ctx)
  if (q.verifyAccount) await assertVideoInAccount(call, actId(ctx.account.externalId), q.id)
  // thumbnails only tell has_thumbnail; readMetaVideo falls back to status,picture when the expansion fails
  const info = await readMetaVideo(call, q.id, { thumbnails: true })
  return {
    type: "video",
    id: q.id,
    status: info.kind,
    progressPercent: info.progress,
    error: info.error,
    hasThumbnail: info.kind === "ready" ? info.thumbnailUri !== null : null,
  }
}

/**
 * S-M1: an AI-supplied video id must belong to the ad account before its status / cover is read. Ids this app
 * uploaded to the account (opts.isKnownMedia - mcp-core's records) are trusted; any other id is checked in the
 * account's library. Failure → a neutral not_found that says nothing about the video's state.
 */
export async function ensureMetaVideoInAccount(
  ctx: ProviderContext<MetaCredentials>,
  id: string,
  opts: Pick<MutationOptions, "isKnownMedia">
): Promise<void> {
  if (opts.isKnownMedia && (await opts.isKnownMedia({ type: "video", id }).catch(() => false))) return
  await assertVideoInAccount(callCtx(ctx), actId(ctx.account.externalId), id)
}

/**
 * The video is in act/advideos. First the (undocumented [M]) filtering id IN [id]: listed → ok; an empty answer →
 * not found. A filtering error, or an answer listing OTHER videos (filter ignored), means "could not verify" → scan
 * the first META_VIDEO.scanPages pages (fields=id, limit scanPageSize) instead (C-M2).
 */
async function assertVideoInAccount(call: MetaCallContext, account: string, id: string): Promise<void> {
  const notFound = () =>
    new ProviderError({
      platform: "meta",
      code: "not_found",
      message: `meta: video ${id} not found in ${account}`,
      userMessageVi: `Không thấy video ${id} trong thư viện video của tài khoản quảng cáo này.`,
      hint: "Kiểm tra lại video_id và account_id (video phải được tải lên đúng tài khoản quảng cáo).",
    })
  type Page = { data?: { id?: unknown }[]; paging?: { cursors?: { after?: string }; next?: string } }
  const fatal = (e: unknown) => isProviderError(e) && (e.code === "auth_invalid" || e.code === "rate_limited")
  try {
    const res = await graph<Page>(call, {
      method: "GET",
      path: `${account}/advideos`,
      params: { fields: "id", filtering: [{ field: "id", operator: "IN", value: [id] }], limit: 5 },
      idempotent: true,
      timeoutMs: META_VIDEO.infoTimeoutMs,
    })
    const data = res.data ?? []
    if (data.some((v) => String(v.id) === id)) return
    if (data.length === 0) throw notFound()
    // other videos listed: the filter was ignored → scan below
  } catch (e) {
    if (fatal(e)) throw e
    if (isProviderError(e) && e.code === "not_found" && e.message.startsWith(`meta: video ${id} not found`)) throw e
  }
  let after: string | undefined
  for (let page = 0; page < META_VIDEO.scanPages; page++) {
    let res: Page
    try {
      res = await graph<Page>(call, {
        method: "GET",
        path: `${account}/advideos`,
        params: { fields: "id", limit: META_VIDEO.scanPageSize, ...(after ? { after } : {}) },
        idempotent: true,
        timeoutMs: META_VIDEO.infoTimeoutMs,
      })
    } catch (e) {
      if (fatal(e)) throw e
      throw notFound()
    }
    if ((res.data ?? []).some((v) => String(v.id) === id)) return
    after = res.paging?.next ? res.paging.cursors?.after : undefined
    if (!after) break
  }
  throw notFound()
}

/** Poll GET /{video_id}?fields=status until ready; at the deadline (or a slow status call) → processing: true. */
async function waitMetaVideo(
  call: MetaCallContext,
  id: string,
  deadline: number | null
): Promise<MediaRef> {
  const processing: MediaRef = {
    type: "video",
    id,
    url: null,
    processing: true,
  }
  // no wait budget left: the id is usable once Meta finishes processing
  if (deadline === null) return processing
  let interval = META_TIMINGS.pollIntervalMs
  for (;;) {
    let st: MetaVideoState
    try {
      st = await readMetaVideo(call, id, { timeoutMs: pollCallTimeoutMs(deadline) })
    } catch (e) {
      // a slow status call must not lose the created id
      if (isProviderError(e) && e.code === "timeout") return processing
      throw e
    }
    if (st.kind === "ready") return { type: "video", id, url: null }
    if (st.kind === "failed") throw videoFailedError(id, st.error)
    // still processing (or an unknown status): the id is usable once Meta finishes; stop waiting at the deadline
    const left = deadline - Date.now()
    if (left <= 0) return processing
    await sleep(Math.min(interval, left), call.signal)
    interval = Math.min(Math.round(interval * 1.5), 10_000)
  }
}

// ---------------------------------------------------------------------------
// Resumable (chunked) upload - background job for large videos
// ---------------------------------------------------------------------------

/** Meta returns offsets as strings ("52428800"). */
function offset(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v)
  return Number.NaN
}

function upstream(messageVi: string, message: string): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "upstream_error",
    message: `meta: ${message}`,
    userMessageVi: messageVi,
  })
}

/** error_data {start_offset, end_offset} of a 1363037 transfer error (object or JSON string), else null. */
export function resendRange(
  err: GraphErrorBody
): { start: number; end: number } | null {
  if (err.error_subcode !== SUBCODE_RESEND_RANGE) return null
  let data = err.error_data
  if (typeof data === "string") {
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!data || typeof data !== "object") return null
  const d = data as { start_offset?: unknown; end_offset?: unknown }
  const start = offset(d.start_offset)
  const end = offset(d.end_offset)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    ? { start, end }
    : null
}

interface PhaseResponse {
  upload_session_id?: unknown
  video_id?: unknown
  start_offset?: unknown
  end_offset?: unknown
  success?: unknown
}

/**
 * Resumable upload to /act_{id}/advideos on graph-video.facebook.com (Meta Business SDK video_uploader flow):
 * start(file_size) → transfer(video_file_chunk at the offsets Meta returns, until start_offset == end_offset) →
 * finish(title) → poll status until r.deadlineAt. A failed chunk is re-sent ≤ META_CHUNKED.chunkRetries times
 * (network / 5xx, or Meta's 1363037 range correction); the whole upload is never restarted - on failure the session
 * is cancelled (best effort) and the error is thrown.
 */
export async function uploadMetaVideoChunked(
  ctx: ProviderContext<MetaCredentials>,
  r: ChunkedVideoUploadRequest
): Promise<MediaRef> {
  const size = r.sizeBytes
  if (!Number.isSafeInteger(size) || size <= 0)
    throw invalid("Kích thước video không hợp lệ.")
  if (!/^video\//i.test(r.contentType))
    throw invalid("File không phải video (chỉ nhận MP4/MOV).")
  const account = actId(ctx.account.externalId)
  const call: MetaCallContext = {
    ...callCtx(ctx),
    signal: anySignal(ctx.signal, r.signal),
  }
  const fileName = r.fileName || "video.mp4"
  const title = (r.name || fileName).slice(0, 255)

  const started = await graph<PhaseResponse>(call, {
    method: "POST",
    host: "video",
    path: `${account}/advideos`,
    params: { upload_phase: "start", file_size: size },
    idempotent: false,
    timeoutMs: META_CHUNKED.phaseTimeoutMs,
  })
  const sessionId = started.upload_session_id
    ? String(started.upload_session_id)
    : null
  const videoId = started.video_id ? String(started.video_id) : null
  if (!sessionId || !videoId)
    throw upstream(
      "Meta không trả upload_session_id/video_id khi bắt đầu tải video.",
      "start without session"
    )

  try {
    await transferAll(
      call,
      account,
      sessionId,
      r,
      offset(started.start_offset),
      offset(started.end_offset)
    )
  } catch (e) {
    await cancelSession(ctx, account, sessionId)
    throw e
  }
  r.onProgress?.(size)
  await finishSession(call, account, sessionId, videoId, title)
  return waitMetaVideo(
    call,
    videoId,
    processingDeadline(
      { deadlineAt: r.deadlineAt },
      META_TIMINGS.videoMaxWaitMs
    )
  )
}

async function transferAll(
  call: MetaCallContext,
  account: string,
  sessionId: string,
  r: ChunkedVideoUploadRequest,
  firstStart: number,
  firstEnd: number
): Promise<void> {
  const size = r.sizeBytes
  let start = firstStart
  let end = firstEnd
  let failures = 0
  // bound the loop even if Meta keeps answering tiny ranges
  let budget = Math.ceil(size / (1024 * 1024)) + 20
  while (start !== end) {
    if (--budget < 0)
      throw upstream(
        "Meta trả vị trí phần file lặp lại bất thường khi tải video.",
        "transfer loop"
      )
    checkOffsets("meta", start, end, size, META_CHUNKED.maxChunkBytes)
    // the Blob is built from the pieces directly (no Buffer.concat copy); the pieces are dropped after this turn
    const chunk = new File(
      await readPieces(r, start, end, call.signal),
      r.fileName || "video.mp4",
      { type: r.contentType }
    )
    const seen: { range?: { start: number; end: number } | null } = {}
    let res: PhaseResponse
    try {
      res = await graph<PhaseResponse>(call, {
        method: "POST",
        host: "video",
        path: `${account}/advideos`,
        params: {
          upload_phase: "transfer",
          upload_session_id: sessionId,
          start_offset: start,
          video_file_chunk: chunk,
        },
        multipart: true,
        idempotent: false,
        timeoutMs: META_CHUNKED.transferTimeoutMs,
        onGraphError: (err) => {
          seen.range = resendRange(err)
        },
      })
    } catch (e) {
      if (failures >= META_CHUNKED.chunkRetries) throw e
      if (seen.range) {
        // Meta asks for another range (e.g. the previous attempt was partly received)
        failures++
        start = seen.range.start
        end = seen.range.end
        continue
      }
      if (!isTransientChunkError(e)) throw e
      failures++
      await sleep(META_CHUNKED.retryDelayMs, call.signal)
      continue // same chunk again
    }
    failures = 0
    start = offset(res.start_offset)
    end = offset(res.end_offset)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw upstream(
        "Meta không trả vị trí phần file tiếp theo khi tải video.",
        "transfer without offsets"
      )
    }
    r.onProgress?.(Math.min(start, size))
  }
}

/**
 * Bytes [start, end) of the source in pieces of ≤ META_CHUNKED.readPieceBytes, each checked for its exact length
 * (a short read = the file changed). end - start is already bounded by checkOffsets (≤ maxChunkBytes).
 */
async function readPieces(
  r: ChunkedVideoUploadRequest,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>[]> {
  const pieces: Uint8Array<ArrayBuffer>[] = []
  for (let pos = start; pos < end; pos += META_CHUNKED.readPieceBytes) {
    const to = Math.min(end, pos + META_CHUNKED.readPieceBytes)
    const buf = await r.readChunk(pos, to, signal)
    if (buf.length !== to - pos) {
      throw new ProviderError({
        platform: "meta",
        code: "upstream_error",
        message: `meta: chunk read returned ${buf.length} bytes, expected ${to - pos}`,
        userMessageVi:
          "Đọc file nguồn không đủ dữ liệu (file có thể vừa bị thay đổi). Hãy thử lại.",
      })
    }
    pieces.push(
      new Uint8Array(
        buf.buffer as ArrayBuffer,
        buf.byteOffset,
        buf.byteLength
      )
    )
  }
  return pieces
}

async function finishSession(
  call: MetaCallContext,
  account: string,
  sessionId: string,
  videoId: string,
  title: string
): Promise<void> {
  let earlierTransient = false
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await graph<PhaseResponse>(call, {
        method: "POST",
        host: "video",
        path: `${account}/advideos`,
        params: { upload_phase: "finish", upload_session_id: sessionId, title },
        idempotent: false,
        timeoutMs: META_CHUNKED.phaseTimeoutMs,
      })
      if (res.success === false || res.success === "false") {
        throw upstream(
          "Meta không xác nhận hoàn tất tải video.",
          "finish success=false"
        )
      }
      return
    } catch (e) {
      if (attempt < META_CHUNKED.chunkRetries && isTransientChunkError(e)) {
        earlierTransient = true
        await sleep(META_CHUNKED.retryDelayMs, call.signal)
        continue
      }
      if (earlierTransient) {
        // an earlier finish may have gone through: accept it when Meta already processes the video
        const st = await readMetaVideo(call, videoId).catch(() => null)
        if (st?.raw === "processing" || st?.raw === "ready") return
      }
      if (isProviderError(e) && e.code === "timeout")
        throw maybeCreatedError("meta", e)
      throw e
    }
  }
}

/** Best effort: abandon the upload session (never throws; not tied to the caller's abort signal). */
async function cancelSession(
  ctx: ProviderContext<MetaCredentials>,
  account: string,
  sessionId: string
): Promise<void> {
  try {
    await graph(
      { ...callCtx(ctx), signal: undefined },
      {
        method: "POST",
        host: "video",
        path: `${account}/advideos`,
        params: { upload_phase: "cancel", upload_session_id: sessionId },
        idempotent: false,
        timeoutMs: 15_000,
      }
    )
  } catch {
    // ignore - the session expires on Meta's side
  }
}
