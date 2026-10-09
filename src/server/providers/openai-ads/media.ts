// Image upload: POST /upload → {file_id}. Two request formats (openai-ads.openapi.json UploadImageBody, docs "Files",
// re-checked 2026-10-09):
// - `r.bytes` present (Drive / pre-fetched): multipart/form-data with a binary `file` part - the URL is never fetched.
// - otherwise JSON {image_url}: OpenAI fetches the URL itself.
// SSRF: we never fetch the URL here; mcp-core validates/probes it with the SSRF guard first. Residual risk
// (OpenAI re-resolving the host) is accepted: the fetch happens on OpenAI's network.
// Requirements (docs): JPEG/PNG/WebP, at least 640×640; no `purpose` for ad creatives (`account_favicon` only for the
// brand icon). Max file size is not documented (UNVERIFIED) → OPENAI_IMAGE_MAX_BYTES is our own cap.
// Video creatives are not supported by OpenAI Ads.
import { ProviderError, unsupported } from "../errors"
import type { MediaRef, MediaUploadRequest } from "../types"
import { isHttpStatus, oaRequest, PLATFORM, type OpenAIAdsClientCtx } from "./client"

/** Own cap for multipart uploads - OpenAI does not publish a limit (UNVERIFIED, providers/openai-ads.md §Upload). */
export const OPENAI_IMAGE_MAX_BYTES = 20 * 1024 * 1024

export function assertImageUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw invalidUrl(url)
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw invalidUrl(url)
}

function invalidUrl(url: string) {
  return new ProviderError({
    platform: PLATFORM,
    code: "invalid_request",
    message: `Invalid image URL: ${url.slice(0, 200)}`,
    userMessageVi: "URL ảnh không hợp lệ - cần đường dẫn http(s) công khai tới ảnh JPEG/PNG/WebP (tối thiểu 640×640).",
  })
}

function invalidImage(message: string, userMessageVi: string, hint?: string) {
  return new ProviderError({ platform: PLATFORM, code: "invalid_request", message, userMessageVi, hint })
}

function requireFileId(res: { file_id?: string } | null | undefined): string {
  if (!res?.file_id) {
    throw new ProviderError({
      platform: PLATFORM,
      code: "upstream_error",
      message: "Upload response without file_id",
      userMessageVi: "OpenAI Ads không trả về file_id sau khi tải ảnh lên.",
    })
  }
  return res.file_id
}

/** Upload an image by URL; returns the OpenAI file_id. */
export async function uploadImageUrl(ctx: OpenAIAdsClientCtx, imageUrl: string): Promise<string> {
  assertImageUrl(imageUrl)
  const res = await oaRequest<{ file_id: string }>(ctx, {
    method: "POST",
    path: "/upload",
    body: { image_url: imageUrl },
  })
  return requireFileId(res)
}

/** JPEG / PNG / WebP by magic bytes (the formats OpenAI Ads documents for creatives). */
export function openaiImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((v, i) => bytes[i] === v)) return "image/png"
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  return null
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }

/** Multipart part filename: no path / quotes / control chars, ≤ 100 chars, extension matching the sniffed type. */
export function multipartFileName(fileName: string | undefined, mime: string): string {
  const ext = EXT[mime] ?? "bin"
  const base = (fileName ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^\p{L}\p{N}_\-. ]+/gu, "_")
    .trim()
    .slice(0, 90)
  return `${base || "image"}.${ext}`
}

/** Upload image bytes (multipart `file`); returns the OpenAI file_id. */
export async function uploadImageBytes(ctx: OpenAIAdsClientCtx, bytes: Uint8Array, fileName?: string): Promise<string> {
  if (bytes.length === 0) throw invalidImage("empty image", "File ảnh rỗng.")
  if (bytes.length > OPENAI_IMAGE_MAX_BYTES) {
    throw invalidImage(
      `image too large: ${bytes.length} bytes`,
      `Ảnh quá lớn cho OpenAI Ads (tối đa ${OPENAI_IMAGE_MAX_BYTES / 1024 / 1024} MB).`
    )
  }
  const mime = openaiImageType(bytes)
  if (!mime) {
    throw invalidImage(
      "unsupported image type",
      "OpenAI Ads chỉ nhận ảnh JPEG/PNG/WebP.",
      "Chuyển ảnh sang JPG, PNG hoặc WebP (tối thiểu 640×640)."
    )
  }
  const form = new FormData()
  // own copy backed by a plain ArrayBuffer (BlobPart typing)
  form.set("file", new Blob([bytes.slice()], { type: mime }), multipartFileName(fileName, mime))
  try {
    const res = await oaRequest<{ file_id: string }>(ctx, { method: "POST", path: "/upload", body: form, timeoutMs: 60_000 })
    return requireFileId(res)
  } catch (e) {
    // mapOpenAIError's 413 text is about report size - give the upload-specific message instead
    if (isHttpStatus(e, 413)) {
      throw new ProviderError({
        platform: PLATFORM,
        code: "invalid_request",
        message: e.message,
        userMessageVi: "Ảnh quá lớn - OpenAI Ads từ chối file (HTTP 413).",
        hint: "Giảm dung lượng ảnh (nén JPG/WebP) rồi thử lại.",
        upstream: e.upstream,
        cause: e,
      })
    }
    throw e
  }
}

export async function uploadMedia(ctx: OpenAIAdsClientCtx, r: MediaUploadRequest): Promise<MediaRef> {
  if (r.type === "video") throw unsupported(PLATFORM, "tải video (quảng cáo ChatGPT chỉ dùng ảnh)")
  // pre-fetched bytes: the URL is informational only (never fetched, never returned - it may be a Drive reference)
  if (r.bytes) return { type: "image", id: await uploadImageBytes(ctx, r.bytes, r.fileName ?? r.name), url: null }
  const fileId = await uploadImageUrl(ctx, r.url)
  return { type: "image", id: fileId, url: r.url }
}
