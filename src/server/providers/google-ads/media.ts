// Media for Google Ads:
// - Image: assets:mutate with imageAsset.data base64 - ONLY the bytes mcp-core downloaded through the SSRF-guarded
//   fetch (MediaUploadRequest.bytes). The adapter never fetches the URL itself: a request without bytes is refused.
// - Video: Google Ads has no video file upload here - video ads use YouTube videos. A YouTube URL or 11-char video id
//   becomes a YoutubeVideoAsset (no download, no upload). Resumable YouTube upload: later.
import { ProviderError } from "../errors"
import type { MediaRef, MediaUploadRequest } from "../types"
import { str } from "./client"
import { clientFor, customerIdOf, invalidRequest, type GCtx } from "./context"
import { gaqlString } from "./gaql"
import { parseYoutubeVideoId, youtubeWatchUrl } from "./youtube"

/** Google image asset size limit is 5120 KB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ALLOWED = new Set(["image/jpeg", "image/png", "image/gif"])

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg"
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif"
  return null
}

/** Validate bytes handed over by mcp-core (size limit of Google + JPEG/PNG/GIF only). */
export function checkImageBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw tooLarge()
  const mime = sniffMime(bytes)
  if (!mime || !ALLOWED.has(mime))
    throw invalidRequest(
      "Unsupported image type",
      "Chỉ hỗ trợ ảnh JPEG, PNG hoặc GIF."
    )
  return bytes
}

function tooLarge() {
  return invalidRequest(
    "Image too large",
    "Ảnh vượt quá 5 MB (giới hạn của Google Ads)."
  )
}

function noAsset(): ProviderError {
  return new ProviderError({
    platform: "google_ads",
    code: "unknown",
    message: "No asset resource name",
    userMessageVi: "Google Ads không trả về asset.",
  })
}

export interface YoutubeAssetResult {
  /** asset resource name customers/{cid}/assets/{id} */
  resourceName: string
  youtubeVideoId: string
  /** true = an asset for this video already existed (nothing created) */
  existing: boolean
}

/** Existing YOUTUBE_VIDEO asset of the account for this video id (existence check instead of a blind create). */
export async function findYoutubeAsset(
  ctx: GCtx,
  cid: string,
  videoId: string
): Promise<string | null> {
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = ${gaqlString(videoId)}`,
    { maxRows: 1 }
  )
  return rows[0] ? str(rows[0], "asset.resource_name") : null
}

/**
 * YoutubeVideoAsset from a YouTube URL / 11-char id. Reuses an existing asset of the same video; dryRun only
 * validates (validateOnly) and never creates.
 */
export async function createYoutubeVideoAsset(
  ctx: GCtx,
  input: { video: string; name?: string | null },
  opts: { dryRun?: boolean } = {}
): Promise<
  | YoutubeAssetResult
  | { resourceName: null; youtubeVideoId: string; existing: false }
> {
  const videoId = parseYoutubeVideoId(input.video)
  if (!videoId) {
    throw invalidRequest(
      "Invalid YouTube video",
      "Không nhận ra video YouTube: hãy dùng link youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/… hoặc ID video 11 ký tự.",
      "Video phải được đăng lên YouTube trước (công khai hoặc không công khai), Google Ads không nhận file video trực tiếp."
    )
  }
  const cid = customerIdOf(ctx)
  const found = await findYoutubeAsset(ctx, cid, videoId)
  if (found)
    return { resourceName: found, youtubeVideoId: videoId, existing: true }
  const name = (input.name?.trim() || `YouTube ${videoId}`).slice(0, 128)
  const res = await clientFor(ctx).mutate<{ resourceName?: string }>(
    cid,
    "assets",
    [
      {
        create: {
          name,
          youtubeVideoAsset: { youtubeVideoId: videoId },
        },
      },
    ],
    { idempotent: false, validateOnly: !!opts.dryRun }
  )
  if (opts.dryRun)
    return { resourceName: null, youtubeVideoId: videoId, existing: false }
  const rn = res.results[0]?.resourceName
  if (!rn) throw noAsset()
  return { resourceName: rn, youtubeVideoId: videoId, existing: false }
}

export async function uploadMedia(
  ctx: GCtx,
  r: MediaUploadRequest
): Promise<MediaRef> {
  if (r.type === "video") {
    // YouTube URL / id → YoutubeVideoAsset; a video FILE cannot be uploaded to Google Ads
    if (!parseYoutubeVideoId(r.url)) {
      throw new ProviderError({
        platform: "google_ads",
        code: "unsupported",
        message: "Google Ads video upload is not supported",
        userMessageVi:
          "Google Ads không nhận file video trực tiếp: video quảng cáo phải được đăng lên YouTube trước, sau đó dùng link hoặc ID video YouTube.",
        hint: "Gọi google_ads_add_youtube_video với link YouTube để tạo asset video.",
      })
    }
    const res = await createYoutubeVideoAsset(ctx, {
      video: r.url,
      name: r.name,
    })
    if (!res.resourceName) throw noAsset()
    return {
      type: "video",
      id: res.resourceName,
      url: youtubeWatchUrl(res.youtubeVideoId),
    }
  }
  // bytes pre-fetched by mcp-core through the SSRF guard: never fetch the URL here (DNS rebinding, internal targets)
  if (!r.bytes) {
    throw new ProviderError({
      platform: "google_ads",
      code: "invalid_request",
      message:
        "google_ads image upload requires pre-fetched bytes (SSRF-guarded)",
      userMessageVi: "Lỗi nội bộ: ảnh chưa được tải qua bộ lọc an toàn.",
    })
  }
  const cid = customerIdOf(ctx)
  const bytes = checkImageBytes(r.bytes)
  const name = (
    r.name?.trim() || `Image ${new Date().toISOString().replace(/[:.]/g, "-")}`
  ).slice(0, 128)
  const res = await clientFor(ctx).mutate<{ resourceName?: string }>(
    cid,
    "assets",
    [
      {
        create: {
          name,
          imageAsset: { data: Buffer.from(bytes).toString("base64") },
        },
      },
    ],
    { idempotent: false }
  )
  const rn = res.results[0]?.resourceName
  if (!rn) throw noAsset()
  return { type: "image", id: rn, url: null }
}
