// Image upload: POST /upload with JSON {image_url} → {file_id}. OpenAI fetches the URL itself.
// SSRF: we never fetch the URL here; mcp-core validates/probes it with the SSRF guard first. Residual risk
// (OpenAI re-resolving the host) is accepted: the fetch happens on OpenAI's network. `r.bytes` is ignored.
// Requirements (docs): JPEG/PNG/WebP, at least 640×640. Video creatives are not supported by OpenAI Ads.
import { ProviderError, unsupported } from "../errors"
import type { MediaRef, MediaUploadRequest } from "../types"
import { oaRequest, PLATFORM, type OpenAIAdsClientCtx } from "./client"

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

/** Upload an image by URL; returns the OpenAI file_id. */
export async function uploadImageUrl(ctx: OpenAIAdsClientCtx, imageUrl: string): Promise<string> {
  assertImageUrl(imageUrl)
  const res = await oaRequest<{ file_id: string }>(ctx, {
    method: "POST",
    path: "/upload",
    body: { image_url: imageUrl },
  })
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

export async function uploadMedia(ctx: OpenAIAdsClientCtx, r: MediaUploadRequest): Promise<MediaRef> {
  if (r.type === "video") throw unsupported(PLATFORM, "tải video (quảng cáo ChatGPT chỉ dùng ảnh)")
  const fileId = await uploadImageUrl(ctx, r.url)
  return { type: "image", id: fileId, url: r.url }
}
