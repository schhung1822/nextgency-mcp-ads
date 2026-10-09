// Shared time-budget helpers for media uploads (Meta + TikTok adapters).
// - MediaUploadRequest.deadlineAt is an absolute budget for the WHOLE call: the upload (create) request timeout is
//   min(own timeout, deadlineAt - now - margin) and processing polling stops at the deadline (→ processing: true).
// - A create call that times out may still have created the media on the platform: it is never retried and the
//   error says so (check the media library before uploading again).
// - Chunked uploads: one failed chunk is re-sent (same chunk only) for network / 5xx errors, never the whole upload.
import { ProviderError, isProviderError } from "./errors"
import type { Platform } from "./types"

/** Budget constants (mutable for tests). */
export const MEDIA_DEADLINE = {
  /** kept free before deadlineAt so the caller can still answer in time */
  marginMs: 1_000,
  /** a create call is not sent at all when less than this is left (nothing is created) */
  minCreateCallMs: 2_000,
}
/** bounds of one status poll request while waiting for processing */
export const POLL_CALL_TIMEOUT = { minMs: 1_000, maxMs: 15_000 }

/** Timeout for a create/upload call: min(own, deadlineAt - now - margin). Throws (nothing sent) when too little is left. */
export function createTimeoutMs(
  platform: Platform,
  ownMs: number,
  deadlineAt?: number,
  now: number = Date.now()
): number {
  if (deadlineAt === undefined) return ownMs
  const left = deadlineAt - now - MEDIA_DEADLINE.marginMs
  if (left < MEDIA_DEADLINE.minCreateCallMs) {
    throw new ProviderError({
      platform,
      code: "timeout",
      message: `${platform}: media upload deadline reached before the upload call was sent`,
      userMessageVi:
        "Hết thời gian cho phép trước khi gửi file lên nền tảng (chưa tạo gì trên nền tảng). Hãy thử lại.",
      retryable: true,
    })
  }
  return Math.min(ownMs, left)
}

/**
 * Absolute end of the processing wait. `deadlineAt` wins (minus the margin); else now + (maxWaitMs ?? default).
 * null = do not poll at all (maxWaitMs <= 0 or the deadline already passed).
 */
export function processingDeadline(
  r: { maxWaitMs?: number; deadlineAt?: number },
  defaultWaitMs: number,
  now: number = Date.now()
): number | null {
  if (r.deadlineAt !== undefined) {
    const end = r.deadlineAt - MEDIA_DEADLINE.marginMs
    return end > now ? end : null
  }
  const ms = r.maxWaitMs ?? defaultWaitMs
  return ms > 0 ? now + ms : null
}

/** Timeout of one status poll request so polling never overruns the processing deadline by much. */
export function pollCallTimeoutMs(
  deadline: number,
  now: number = Date.now()
): number {
  return Math.max(
    POLL_CALL_TIMEOUT.minMs,
    Math.min(POLL_CALL_TIMEOUT.maxMs, deadline - now)
  )
}

/** Vietnamese error for a create call that timed out: the media may exist on the platform; never retried. */
export function maybeCreatedError(
  platform: Platform,
  cause: ProviderError
): ProviderError {
  return new ProviderError({
    platform,
    code: "timeout",
    message: `${platform}: media upload call timed out (${cause.message})`,
    userMessageVi:
      "Nền tảng phản hồi quá chậm khi nhận file - có thể đã tạo trên nền tảng - kiểm tra thư viện media trước khi tải lại.",
    hint: "Không tải lại ngay: mở thư viện media của tài khoản quảng cáo để xem file đã có chưa.",
    retryable: false,
    upstream: cause.upstream,
    cause,
  })
}

/** Run a create call once: a timeout becomes maybeCreatedError (no retry). */
export async function createOnce<T>(
  platform: Platform,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (isProviderError(e) && e.code === "timeout")
      throw maybeCreatedError(platform, e)
    throw e
  }
}

/** Network failure, timeout or 5xx-class error: the same chunk may be sent again. */
export function isTransientChunkError(e: unknown): boolean {
  return (
    isProviderError(e) &&
    (e.code === "timeout" || e.code === "upstream_error") &&
    e.retryable
  )
}

/** AbortSignal that fires when any of the given signals fires (undefined when none). */
export function anySignal(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => !!s)
  if (list.length === 0) return undefined
  return list.length === 1 ? list[0] : AbortSignal.any(list)
}

/**
 * Read bytes [start, end) through `readChunk` in pieces of at most `pieceBytes` (Drive Range reads are capped) and
 * check the exact length. One chunk is held in memory at a time.
 */
export async function readExact(
  platform: Platform,
  readChunk: (
    start: number,
    endExclusive: number,
    signal?: AbortSignal
  ) => Promise<Buffer>,
  start: number,
  end: number,
  pieceBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const parts: Buffer[] = []
  for (let pos = start; pos < end; pos += pieceBytes) {
    const to = Math.min(end, pos + pieceBytes)
    const buf = await readChunk(pos, to, signal)
    if (buf.length !== to - pos) {
      throw new ProviderError({
        platform,
        code: "upstream_error",
        message: `${platform}: chunk read returned ${buf.length} bytes, expected ${to - pos}`,
        userMessageVi:
          "Đọc file nguồn không đủ dữ liệu (file có thể vừa bị thay đổi). Hãy thử lại.",
      })
    }
    parts.push(buf)
  }
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
}

/** Validate server-provided chunk offsets: 0 <= start < end <= size and end - start <= maxChunk. */
export function checkOffsets(
  platform: Platform,
  start: number,
  end: number,
  size: number,
  maxChunk: number
): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > size ||
    end - start > maxChunk
  ) {
    throw new ProviderError({
      platform,
      code: "upstream_error",
      message: `${platform}: unexpected chunk offsets ${start}-${end} for size ${size}`,
      userMessageVi:
        "Nền tảng trả vị trí phần file (offset) không hợp lệ khi tải video theo phần.",
    })
  }
}
