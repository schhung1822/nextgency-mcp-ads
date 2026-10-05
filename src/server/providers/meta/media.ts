// ads_upload_media for Meta.
// Image: ONLY the bytes mcp-core downloaded through the SSRF-guarded fetch (MediaUploadRequest.bytes) are
//        uploaded (base64 `bytes` to /act_{id}/adimages, meta.md §5 Media). The adapter never fetches the
//        URL itself: a request without bytes is refused (no unguarded download path).
// Video: /act_{id}/advideos with file_url (Meta's servers download it - residual risk accepted: the fetch
//        happens on Meta's network, not ours), then poll status until ready (bounded wait).
import { ProviderError } from "../errors"
import { sleep } from "../rate-limit"
import type { MediaRef, MediaUploadRequest, ProviderContext } from "../types"
import { META_TIMINGS, actId, graph, type MetaCredentials } from "./client"
import { callCtx, invalid } from "./shared"

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

function mediaError(messageVi: string, message: string): ProviderError {
  return new ProviderError({ platform: "meta", code: "invalid_request", message, userMessageVi: messageVi })
}

function looksLikeImage(buf: Buffer): boolean {
  const b = buf.subarray(0, 12)
  return (
    (b[0] === 0xff && b[1] === 0xd8) || // jpeg
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // png
    b.subarray(0, 4).toString("ascii") === "GIF8" ||
    (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") ||
    b.subarray(0, 2).toString("ascii") === "BM" ||
    b.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    b.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  )
}

interface AdImagesResponse {
  images?: Record<string, { hash?: string; url?: string }>
}

export async function uploadMetaMedia(ctx: ProviderContext<MetaCredentials>, r: MediaUploadRequest): Promise<MediaRef> {
  if (!/^https?:\/\//i.test(r.url)) throw invalid("URL phải bắt đầu bằng http:// hoặc https://.")
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
    if (bytes.length > MAX_IMAGE_BYTES) throw mediaError(`Ảnh quá lớn (tối đa ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`, `bytes ${bytes.length}`)
    if (contentType && !contentType.toLowerCase().startsWith("image/") && !looksLikeImage(bytes)) {
      throw mediaError("URL không phải file ảnh.", `content-type ${contentType}`)
    }
    if (!looksLikeImage(bytes)) throw mediaError("File tải về không phải ảnh hợp lệ (JPG/PNG/GIF/WEBP/BMP/TIFF).", "magic mismatch")
    const res = await graph<AdImagesResponse>(call, {
      method: "POST",
      path: `${account}/adimages`,
      params: { bytes: bytes.toString("base64") },
      multipart: true,
      idempotent: false,
      timeoutMs: 120_000,
    })
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

  const created = await graph<{ id?: string }>(call, {
    method: "POST",
    path: `${account}/advideos`,
    params: { file_url: r.url, ...(r.name ? { name: r.name.slice(0, 255) } : {}) },
    idempotent: false,
    timeoutMs: 120_000,
  })
  if (!created.id) {
    throw new ProviderError({
      platform: "meta",
      code: "upstream_error",
      message: "meta: advideos returned no id",
      userMessageVi: "Meta không trả video_id.",
    })
  }
  const deadline = Date.now() + META_TIMINGS.videoMaxWaitMs
  let interval = META_TIMINGS.pollIntervalMs
  for (;;) {
    const st = await graph<{ status?: { video_status?: string } }>(call, {
      method: "GET",
      path: created.id,
      params: { fields: "status" },
      idempotent: true,
    })
    const vs = st.status?.video_status
    if (vs === "ready") break
    if (vs === "error") {
      throw new ProviderError({
        platform: "meta",
        code: "invalid_request",
        message: `meta: video ${created.id} processing error`,
        userMessageVi: "Meta xử lý video thất bại (định dạng/kích thước không hợp lệ hoặc URL không tải được).",
      })
    }
    // still processing: the id is usable once Meta finishes; stop waiting at the deadline
    if (Date.now() + interval > deadline) break
    await sleep(interval, ctx.signal)
    interval = Math.min(Math.round(interval * 1.5), 10_000)
  }
  return { type: "video", id: created.id, url: null }
}
