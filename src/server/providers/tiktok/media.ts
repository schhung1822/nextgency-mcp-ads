// Media upload: /file/image/ad/upload/ and /file/video/ad/upload/, then poll /file/video/ad/info/ until the video is
// transcoded. file_name must be unique per advertiser (40911, images AND videos).
// - Image with `r.bytes` (Drive / pre-fetched): UPLOAD_BY_FILE, multipart/form-data with `image_file` + `image_signature`
//   (MD5 hex of the bytes) - the URL is never fetched (providers/tiktok.md §4 Media, doc 1739067433456642, 2026-10-09).
// - Otherwise (image without bytes, every video): UPLOAD_BY_URL, JSON body - TikTok's servers download the URL.
// - Large videos (background job): uploadTikTokVideoChunked - /file/start/upload/ → /file/transfer/upload/ (chunks at the
//   offsets TikTok returns, MD5 `signature` per chunk) → /file/finish/upload/ (file_id, kept 24 h) →
//   /file/video/ad/upload/ UPLOAD_BY_FILE_ID (docs 1738963828459521, 1737721229896705, 1737721489945601,
//   1737721642924033, 1737587322856449 - read 2026-10-09).
// deadlineAt: upload calls use min(own timeout, deadlineAt - now - 1 s) and polling stops at it; an upload call that
// times out is never retried (the media may exist - media-deadline.ts).
// SSRF: this adapter never fetches a URL itself. mcp-core validates and probes the URL with the SSRF guard first; the
// residual risk (TikTok resolving the host again later) is accepted because the fetch happens on TikTok's network.
import { createHash, randomBytes } from "node:crypto"
import { isProviderError, ProviderError } from "../errors"
import {
  anySignal,
  checkOffsets,
  createOnce,
  createTimeoutMs,
  isTransientChunkError,
  pollCallTimeoutMs,
  processingDeadline,
  readExact,
} from "../media-deadline"
import { sleep } from "../rate-limit"
import type {
  ChunkedVideoUploadRequest,
  MediaRef,
  MediaUploadRequest,
  ProviderContext,
} from "../types"
import { invalid, str, ttFromCtx, ttPost, type Raw, type TT } from "./api"
import { tiktokRequest, type TikTokResult } from "./client"
import type { TikTokCredentials } from "./credentials"

/** Video transcoding poll (overridable in tests). `timeoutMs` = default wait budget when the request has no maxWaitMs. */
export const VIDEO_POLL = { intervalMs: 3_000, timeoutMs: 60_000 }

/** Chunked upload tuning (mutable for tests). */
export const TIKTOK_CHUNKED = {
  /** start / finish / UPLOAD_BY_FILE_ID calls */
  phaseTimeoutMs: 60_000,
  /** one /file/transfer/upload/ call (chunks are 20 MB, the last one 5-25 MB) */
  transferTimeoutMs: 180_000,
  /** refuse server offsets asking for more than this (memory bound; = the Drive Range read cap) */
  maxChunkBytes: 32 * 1024 * 1024,
  readPieceBytes: 32 * 1024 * 1024,
  /** re-sends of the SAME chunk after a network / 5xx / signature-mismatch error */
  chunkRetries: 2,
  retryDelayMs: 1_000,
}

/**
 * UPLOAD_BY_FILE image limits (doc 1739067433456642, read 2026-10-09): "File size: within 50 MB", "JPG, JPEG, or PNG",
 * width × height ≤ 3,686,400 px. TikTok's own request timeout for this endpoint is 10 s, so a large file may fail on a
 * slow uplink - callers should keep images small.
 */
export const TIKTOK_IMAGE_MAX_BYTES = 50 * 1024 * 1024

/** Unique, ≤100-char file name: "<base>_<yyyymmddhhmmss>_<rand>" */
export function uniqueFileName(
  base: string | undefined,
  url: string,
  now: Date = new Date()
): string {
  let b = (base ?? "").trim()
  if (!b) {
    try {
      b = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
    } catch {
      b = ""
    }
  }
  b =
    b
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[^\p{L}\p{N}_\- ]+/gu, "_")
      .trim() || "media"
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)
  const suffix = `_${stamp}_${randomBytes(3).toString("hex")}`
  return `${b.slice(0, 100 - suffix.length)}${suffix}`
}

export async function uploadTikTokMedia(
  ctx: ProviderContext<TikTokCredentials>,
  r: MediaUploadRequest
): Promise<MediaRef> {
  const tt = ttFromCtx(ctx)
  // pre-fetched bytes: the URL is informational only (never fetched, may be a Drive reference)
  if (r.type === "image" && r.bytes) return uploadImageBytes(tt, r, r.bytes)
  if (!/^https?:\/\//i.test(r.url)) throw invalid("URL media phải là http(s).")
  if (r.type === "image") return uploadImage(tt, r)
  return uploadVideo(tt, r)
}

/** Base for the unique file_name: explicit name, else the sanitised file name, else the URL path. */
function nameBase(r: { name?: string; fileName?: string }): string | undefined {
  return r.name?.trim() || r.fileName?.trim() || undefined
}

async function withUniqueName<T>(
  fn: (name: string) => Promise<T>,
  base: string | undefined,
  url: string
): Promise<T> {
  try {
    return await fn(uniqueFileName(base, url))
  } catch (e) {
    // 40911 duplicate file_name → retry once with a fresh name (nothing was created)
    if (isProviderError(e) && e.upstream?.code === 40911)
      return fn(uniqueFileName(base, url))
    throw e
  }
}

async function uploadImage(tt: TT, r: MediaUploadRequest): Promise<MediaRef> {
  const res = await withUniqueName(
    (file_name) => {
      const timeoutMs = createTimeoutMs("tiktok", 60_000, r.deadlineAt)
      return createOnce("tiktok", () =>
        ttPost<Raw>(
          tt,
          "file/image/ad/upload",
          {
            advertiser_id: tt.advertiserId,
            upload_type: "UPLOAD_BY_URL",
            image_url: r.url,
            file_name,
          },
          { timeoutMs }
        )
      )
    },
    nameBase(r),
    r.url
  )
  return imageRef(res.data)
}

/** JPEG / PNG by magic bytes (TikTok UPLOAD_BY_FILE accepts only these). */
export function tiktokImageType(
  bytes: Uint8Array
): "image/jpeg" | "image/png" | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg"
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((v, i) => bytes[i] === v))
    return "image/png"
  return null
}

async function uploadImageBytes(
  tt: TT,
  r: MediaUploadRequest,
  bytes: Uint8Array
): Promise<MediaRef> {
  if (bytes.length === 0) throw invalid("File ảnh rỗng.")
  if (bytes.length > TIKTOK_IMAGE_MAX_BYTES) {
    throw invalid(
      `Ảnh quá lớn cho TikTok (tối đa ${TIKTOK_IMAGE_MAX_BYTES / 1024 / 1024} MB).`
    )
  }
  const mime = tiktokImageType(bytes)
  if (!mime) {
    throw invalid(
      "TikTok chỉ nhận ảnh JPG/PNG.",
      "Chuyển ảnh sang JPG hoặc PNG (TikTok không nhận WebP/GIF/HEIC khi tải file lên)."
    )
  }
  const signature = createHash("md5").update(bytes).digest("hex")
  const ext = mime === "image/png" ? "png" : "jpg"
  // own copy backed by a plain ArrayBuffer (BlobPart typing); the form is rebuilt for the 40911 retry
  const blob = new Blob([bytes.slice()], { type: mime })
  const res = await withUniqueName(
    (file_name) => {
      const timeoutMs = createTimeoutMs("tiktok", 60_000, r.deadlineAt)
      const form = new FormData()
      form.set("advertiser_id", tt.advertiserId)
      form.set("upload_type", "UPLOAD_BY_FILE")
      form.set("file_name", file_name)
      form.set("image_signature", signature)
      form.set("image_file", blob, `${file_name}.${ext}`)
      // never retried blindly: a timed-out upload may have been stored (a retry would only add a duplicate image)
      return createOnce("tiktok", () =>
        tiktokRequest<Raw>({
          method: "POST",
          path: "file/image/ad/upload",
          body: form,
          auth: tt.creds.accessToken,
          appId: tt.creds.appId,
          retries: 0,
          timeoutMs,
          signal: tt.signal,
          onUpstream: tt.onUpstream,
        })
      )
    },
    nameBase(r),
    r.url
  )
  return imageRef(res.data)
}

function imageRef(data: Raw): MediaRef {
  const id = str(data.image_id)
  if (!id) throw invalid("TikTok không trả về image_id.")
  return { type: "image", id, url: str(data.image_url) }
}

async function uploadVideo(tt: TT, r: MediaUploadRequest): Promise<MediaRef> {
  const res = await withUniqueName(
    (file_name) => {
      const timeoutMs = createTimeoutMs("tiktok", 120_000, r.deadlineAt)
      return createOnce("tiktok", () =>
        ttPost<Raw | Raw[]>(
          tt,
          "file/video/ad/upload",
          {
            advertiser_id: tt.advertiserId,
            upload_type: "UPLOAD_BY_URL",
            video_url: r.url,
            file_name,
          },
          { timeoutMs }
        )
      )
    },
    nameBase(r),
    r.url
  )
  return videoRef(tt, res.data, processingDeadline(r, VIDEO_POLL.timeoutMs))
}

/** video_id from the upload response (array of 1 item, or an object), then wait for transcoding until `deadline`. */
async function videoRef(
  tt: TT,
  data: Raw | Raw[],
  deadline: number | null
): Promise<MediaRef> {
  const first = (Array.isArray(data) ? data[0] : data) ?? {}
  const id = str(first.video_id)
  if (!id)
    throw invalid(
      "TikTok không trả về video_id (URL video có thể không hợp lệ)."
    )
  const info = await waitForVideo(tt, id, deadline)
  const url =
    str(info?.preview_url) ??
    str(info?.video_cover_url) ??
    str(first.video_cover_url)
  return info
    ? { type: "video", id, url }
    : { type: "video", id, url, processing: true }
}

/**
 * Poll /file/video/ad/info/ until the video is listed (transcoded). Returns null when `deadline` (absolute epoch ms)
 * passes first, when a status call times out, or right away when `deadline` is null (the id is still usable later).
 */
export async function waitForVideo(
  tt: TT,
  videoId: string,
  deadline: number | null
): Promise<Raw | null> {
  if (deadline === null) return null
  for (;;) {
    try {
      const res = await tiktokRequest<{ list?: Raw[] }>({
        method: "GET",
        path: "file/video/ad/info",
        query: { advertiser_id: tt.advertiserId, video_ids: [videoId] },
        auth: tt.creds.accessToken,
        appId: tt.creds.appId,
        retries: 1,
        timeoutMs: pollCallTimeoutMs(deadline),
        signal: tt.signal,
        onUpstream: tt.onUpstream,
      })
      const v = (res.data.list ?? []).find(
        (x) => String(x.video_id) === videoId
      )
      if (v && v.displayable !== false) return v
    } catch (e) {
      // a slow status call must not lose the created id
      if (isProviderError(e) && e.code === "timeout") return null
      if (!(isProviderError(e) && e.upstream?.code === 40901)) throw e
    }
    const left = deadline - Date.now()
    if (left <= 0) return null
    await sleep(Math.min(VIDEO_POLL.intervalMs, left), tt.signal)
  }
}

// ---------------------------------------------------------------------------
// Chunked upload (file repository) - background job for large videos
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v)
  return Number.NaN
}

function upstream(messageVi: string, message: string): ProviderError {
  return new ProviderError({
    platform: "tiktok",
    code: "upstream_error",
    message: `tiktok: ${message}`,
    userMessageVi: messageVi,
  })
}

/** First defined value among snake_case / PascalCase keys (the doc's start example uses PascalCase keys). */
function pick(data: Raw, ...keys: string[]): unknown {
  for (const k of keys)
    if (data[k] !== undefined && data[k] !== null) return data[k]
  return undefined
}

/** Same chunk may be sent again: network / timeout / 5xx, or TikTok's MD5 signature mismatch (40900). */
function chunkRetryable(e: unknown): boolean {
  return (
    isTransientChunkError(e) ||
    (isProviderError(e) && e.upstream?.code === 40900)
  )
}

/**
 * Chunked upload to TikTok's file repository then into the Asset Library:
 * start(size, content_type=video) → transfer(file chunk + MD5 signature at the offsets TikTok returns, until
 * start_offset == end_offset) → finish (file_id) → /file/video/ad/upload/ UPLOAD_BY_FILE_ID → poll until r.deadlineAt.
 * A failed chunk is re-sent ≤ TIKTOK_CHUNKED.chunkRetries times; the whole upload is never restarted. The final
 * UPLOAD_BY_FILE_ID call creates a new video_id each time → never retried after a timeout.
 */
export async function uploadTikTokVideoChunked(
  ctx: ProviderContext<TikTokCredentials>,
  r: ChunkedVideoUploadRequest
): Promise<MediaRef> {
  const size = r.sizeBytes
  if (!Number.isSafeInteger(size) || size <= 0)
    throw invalid("Kích thước video không hợp lệ.")
  if (!/^video\//i.test(r.contentType))
    throw invalid("File không phải video (chỉ nhận MP4/MOV).")
  const tt: TT = { ...ttFromCtx(ctx), signal: anySignal(ctx.signal, r.signal) }
  const base = nameBase(r) ?? "video"
  const post = <T>(path: string, body: unknown, timeoutMs: number) =>
    tiktokRequest<T>({
      method: "POST",
      path,
      body,
      auth: tt.creds.accessToken,
      appId: tt.creds.appId,
      retries: 0,
      timeoutMs,
      signal: tt.signal,
      onUpstream: tt.onUpstream,
    })

  const started = await post<Raw>(
    "file/start/upload",
    {
      advertiser_id: tt.advertiserId,
      size,
      content_type: "video",
      name: uniqueFileName(base, ""),
    },
    TIKTOK_CHUNKED.phaseTimeoutMs
  )
  const uploadId = str(pick(started.data, "upload_id", "UploadId"))
  if (!uploadId)
    throw upstream(
      "TikTok không trả upload_id khi bắt đầu tải video theo phần.",
      "start without upload_id"
    )
  let start = num(pick(started.data, "start_offset", "StartOffset"))
  let end = num(pick(started.data, "end_offset", "EndOffset"))

  let failures = 0
  let budget = Math.ceil(size / (1024 * 1024)) + 20
  while (start !== end) {
    if (--budget < 0)
      throw upstream(
        "TikTok trả vị trí phần file lặp lại bất thường khi tải video.",
        "transfer loop"
      )
    checkOffsets("tiktok", start, end, size, TIKTOK_CHUNKED.maxChunkBytes)
    const bytes = await readExact(
      "tiktok",
      r.readChunk,
      start,
      end,
      TIKTOK_CHUNKED.readPieceBytes,
      tt.signal
    )
    const form = new FormData()
    form.set("advertiser_id", tt.advertiserId)
    form.set("upload_id", uploadId)
    form.set("signature", createHash("md5").update(bytes).digest("hex"))
    form.set("start_offset", String(start))
    form.set(
      "file",
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: r.contentType }),
      r.fileName || "video.mp4"
    )
    let res: TikTokResult<Raw>
    try {
      res = await post<Raw>(
        "file/transfer/upload",
        form,
        TIKTOK_CHUNKED.transferTimeoutMs
      )
    } catch (e) {
      if (failures >= TIKTOK_CHUNKED.chunkRetries || !chunkRetryable(e)) throw e
      failures++
      await sleep(TIKTOK_CHUNKED.retryDelayMs, tt.signal)
      continue // same chunk again
    }
    failures = 0
    start = num(pick(res.data, "start_offset", "StartOffset"))
    end = num(pick(res.data, "end_offset", "EndOffset"))
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw upstream(
        "TikTok không trả vị trí phần file tiếp theo khi tải video.",
        "transfer without offsets"
      )
    }
    r.onProgress?.(Math.min(start, size))
  }
  r.onProgress?.(size)

  let fileId: string | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      const fin = await post<Raw>(
        "file/finish/upload",
        { advertiser_id: tt.advertiserId, upload_id: uploadId },
        TIKTOK_CHUNKED.phaseTimeoutMs
      )
      fileId = str(pick(fin.data, "file_id", "FileId"))
      break
    } catch (e) {
      if (attempt < TIKTOK_CHUNKED.chunkRetries && isTransientChunkError(e)) {
        await sleep(TIKTOK_CHUNKED.retryDelayMs, tt.signal)
        continue
      }
      throw e
    }
  }
  if (!fileId)
    throw upstream(
      "TikTok không trả file_id khi hoàn tất tải video theo phần.",
      "finish without file_id"
    )

  const created = await withUniqueName(
    (file_name) =>
      createOnce("tiktok", () =>
        post<Raw | Raw[]>(
          "file/video/ad/upload",
          {
            advertiser_id: tt.advertiserId,
            upload_type: "UPLOAD_BY_FILE_ID",
            file_id: fileId,
            file_name,
          },
          TIKTOK_CHUNKED.phaseTimeoutMs
        )
      ),
    base,
    ""
  )
  return videoRef(
    tt,
    created.data,
    processingDeadline({ deadlineAt: r.deadlineAt }, VIDEO_POLL.timeoutMs)
  )
}
