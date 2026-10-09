// ads_upload_media for Meta.
// Image: ONLY the bytes mcp-core downloaded through the SSRF-guarded fetch (MediaUploadRequest.bytes) are
//        uploaded (base64 `bytes` to /act_{id}/adimages, meta.md §5 Media). The adapter never fetches the
//        URL itself: a request without bytes is refused (no unguarded download path).
// Video: /act_{id}/advideos with file_url (Meta's servers download it - residual risk accepted: the fetch
//        happens on Meta's network, not ours), then poll status until ready within the wait budget
//        (deadlineAt wins, else maxWaitMs, default META_TIMINGS.videoMaxWaitMs); when the budget ends first the id is
//        returned with processing: true.
// Large videos (background job): uploadMetaVideoChunked - resumable upload_phase start → transfer → finish on
//        graph-video.facebook.com (meta.md §5 Media "Upload theo phần"), chunk offsets decided by Meta.
// deadlineAt: create calls use min(own timeout, deadlineAt - now - 1 s); a create call that times out is never retried
//        (the media may exist - media-deadline.ts).
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
  MediaUploadRequest,
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
  const videoName = r.name || r.fileName
  const timeoutMs = createTimeoutMs("meta", 120_000, r.deadlineAt)
  const created = await createOnce("meta", () =>
    graph<{ id?: string }>(call, {
      method: "POST",
      path: `${account}/advideos`,
      params: {
        file_url: r.url,
        ...(videoName ? { name: videoName.slice(0, 255) } : {}),
      },
      idempotent: false,
      timeoutMs,
    })
  )
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

async function videoStatus(
  call: MetaCallContext,
  id: string,
  timeoutMs?: number
): Promise<string | undefined> {
  const st = await graph<{ status?: { video_status?: string } }>(call, {
    method: "GET",
    path: id,
    params: { fields: "status" },
    idempotent: true,
    timeoutMs,
  })
  return st.status?.video_status
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
    let vs: string | undefined
    try {
      vs = await videoStatus(call, id, pollCallTimeoutMs(deadline))
    } catch (e) {
      // a slow status call must not lose the created id
      if (isProviderError(e) && e.code === "timeout") return processing
      throw e
    }
    if (vs === "ready") return { type: "video", id, url: null }
    if (vs === "error") {
      throw new ProviderError({
        platform: "meta",
        code: "invalid_request",
        message: `meta: video ${id} processing error`,
        userMessageVi:
          "Meta xử lý video thất bại (định dạng/kích thước không hợp lệ hoặc URL không tải được).",
      })
    }
    // still processing: the id is usable once Meta finishes; stop waiting at the deadline
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
        const vs = await videoStatus(call, videoId).catch(() => undefined)
        if (vs === "processing" || vs === "ready") return
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
