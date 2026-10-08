// Media upload by URL: /file/image/ad/upload/ and /file/video/ad/upload/ (UPLOAD_BY_URL, JSON body),
// then poll /file/video/ad/info/ until the video is transcoded. file_name must be unique per advertiser.
// SSRF: this adapter never fetches the URL itself - TikTok's servers download it. mcp-core validates and
// probes the URL with the SSRF guard first; the residual risk (TikTok resolving the host again later) is
// accepted because the fetch happens on TikTok's network, not ours. `r.bytes` is ignored here.
import { randomBytes } from "node:crypto"
import { isProviderError } from "../errors"
import { sleep } from "../rate-limit"
import type { MediaRef, MediaUploadRequest, ProviderContext } from "../types"
import { invalid, str, ttFromCtx, ttGet, ttPost, type Raw, type TT } from "./api"
import type { TikTokCredentials } from "./credentials"

/** Video transcoding poll (overridable in tests). */
export const VIDEO_POLL = { intervalMs: 3_000, timeoutMs: 60_000 }

/** Unique, ≤100-char file name: "<base>_<yyyymmddhhmmss>_<rand>" */
export function uniqueFileName(base: string | undefined, url: string, now: Date = new Date()): string {
  let b = (base ?? "").trim()
  if (!b) {
    try {
      b = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
    } catch {
      b = ""
    }
  }
  b = b.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^\p{L}\p{N}_\- ]+/gu, "_").trim() || "media"
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
  const suffix = `_${stamp}_${randomBytes(3).toString("hex")}`
  return `${b.slice(0, 100 - suffix.length)}${suffix}`
}

export async function uploadTikTokMedia(
  ctx: ProviderContext<TikTokCredentials>,
  r: MediaUploadRequest
): Promise<MediaRef> {
  const tt = ttFromCtx(ctx)
  if (!/^https?:\/\//i.test(r.url)) throw invalid("URL media phải là http(s).")
  if (r.type === "image") return uploadImage(tt, r)
  return uploadVideo(tt, r)
}

async function withUniqueName<T>(fn: (name: string) => Promise<T>, r: MediaUploadRequest): Promise<T> {
  try {
    return await fn(uniqueFileName(r.name, r.url))
  } catch (e) {
    // 40911 duplicate file_name → retry once with a fresh name (nothing was created)
    if (isProviderError(e) && e.upstream?.code === 40911) return fn(uniqueFileName(r.name, r.url))
    throw e
  }
}

async function uploadImage(tt: TT, r: MediaUploadRequest): Promise<MediaRef> {
  const res = await withUniqueName(
    (file_name) =>
      ttPost<Raw>(tt, "file/image/ad/upload", {
        advertiser_id: tt.advertiserId,
        upload_type: "UPLOAD_BY_URL",
        image_url: r.url,
        file_name,
      }),
    r
  )
  const id = str(res.data.image_id)
  if (!id) throw invalid("TikTok không trả về image_id.")
  return { type: "image", id, url: str(res.data.image_url) }
}

async function uploadVideo(tt: TT, r: MediaUploadRequest): Promise<MediaRef> {
  const res = await withUniqueName(
    (file_name) =>
      ttPost<Raw | Raw[]>(
        tt,
        "file/video/ad/upload",
        { advertiser_id: tt.advertiserId, upload_type: "UPLOAD_BY_URL", video_url: r.url, file_name },
        { timeoutMs: 120_000 }
      ),
    r
  )
  const first = (Array.isArray(res.data) ? res.data[0] : res.data) ?? {}
  const id = str(first.video_id)
  if (!id) throw invalid("TikTok không trả về video_id (URL video có thể không hợp lệ).")
  const info = await waitForVideo(tt, id)
  return { type: "video", id, url: str(info?.preview_url) ?? str(info?.video_cover_url) ?? str(first.video_cover_url) }
}

/** Poll /file/video/ad/info/ until the video is listed (transcoded). Returns null on timeout (id still usable later). */
export async function waitForVideo(tt: TT, videoId: string): Promise<Raw | null> {
  const started = Date.now()
  for (;;) {
    try {
      const res = await ttGet<{ list?: Raw[] }>(tt, "file/video/ad/info", { advertiser_id: tt.advertiserId, video_ids: [videoId] })
      const v = (res.data.list ?? []).find((x) => String(x.video_id) === videoId)
      if (v && v.displayable !== false) return v
    } catch (e) {
      if (!(isProviderError(e) && e.upstream?.code === 40901)) throw e
    }
    if (Date.now() - started >= VIDEO_POLL.timeoutMs) return null
    await sleep(VIDEO_POLL.intervalMs, tt.signal)
  }
}
