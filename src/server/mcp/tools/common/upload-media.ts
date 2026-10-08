import { z } from "zod"
import { fetchMediaBytes, MEDIA_LIMITS, probeMedia } from "../../../net/ssrf"
import { parseYoutubeVideoId, youtubeWatchUrl } from "../../../providers/google-ads/youtube"
import type { MediaUploadRequest, Platform } from "../../../providers/types"
import { invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { stripMediaUrlQueries } from "../../log-args"
import { accountIdSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { CREATE_ANNOTATIONS, providerFor, registerToolSpec, runWrite, type ToolContext, type ToolEnv } from "../../tool"
import { grantPlatformsWith, type GrantAccount } from "../../types"

export const NAME = "ads_upload_media"

/**
 * Platforms whose adapter uploads the file content itself (Meta adimages bytes, Google imageAsset.data):
 * mcp-core downloads the image ONCE through the SSRF guard and hands the bytes over, so the adapter never
 * resolves/fetches the AI-supplied URL. TikTok / OpenAI (and Meta video) upload by URL: the platform's
 * servers fetch it after our probe - residual risk accepted (the fetch is not on our network).
 * Google video = a YouTube video (URL or 11-char id) turned into a YoutubeVideoAsset: nothing is downloaded.
 */
const BYTES_PLATFORMS = new Set<Platform>(["meta", "google_ads"])

/** URL for logs/previews: scheme + host + path only (signed query strings removed). */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300)
  } catch {
    return "[url]"
  }
}

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "create")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Tải ảnh / video lên tài khoản",
    description:
      "Dùng khi cần đưa một ảnh hoặc video từ URL công khai (http/https) vào thư viện của tài khoản quảng cáo để dùng khi tạo quảng cáo; trả về id media (Meta image_hash/video_id, TikTok image_id/video_id, Google asset, OpenAI file_id). Google Ads: ảnh JPEG/PNG/GIF ≤5 MB; video phải là video YouTube (link youtube.com/youtu.be hoặc ID 11 ký tự) - không tải file video lên Google. Gọi ads_list_accounts trước để có account_id. Không hỗ trợ địa chỉ nội bộ; ảnh tối đa 30 MB, video tối đa 500 MB. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.",
    kind: "write",
    annotations: CREATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      type: z.enum(["image", "video"]),
      url: z.string().max(2_000).describe("URL công khai http(s) tải trực tiếp được tệp (Google video: link hoặc ID video YouTube)"),
      name: z.string().max(200).optional(),
      ...writeFields,
    }),
    output: writeOutputSchema,
    // signed URLs (S3/GCS/CDN tokens) must not end up in mcp_call_logs / mcp_pending_actions
    logArgs: (args) => stripMediaUrlQueries(args),
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "create" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId })
      const provider = providerFor(account.platform, "upload_media")
      if (account.platform === "google_ads" && args.type === "video") return uploadYoutubeVideo(env, provider, account, args)
      // SSRF guard + size/type probe on both steps (the URL target may change between them)
      const probe = await probeMedia(args.url, args.type, env.signal)
      const sizeText = probe.contentLength !== null ? `${(probe.contentLength / 1024 / 1024).toFixed(2)} MB` : "không rõ dung lượng"
      return runWrite(env, {
        args,
        account,
        preview: async () => ({
          changes: [
            {
              object: args.name ?? displayUrl(probe.finalUrl),
              object_id: "-",
              level: null,
              field: "upload",
              before: null,
              after: `${args.type} (${sizeText})`,
            },
          ],
          warnings: probe.warnings,
          effective_at: null,
          details: { source: displayUrl(probe.finalUrl), content_type: probe.contentType, bytes: probe.contentLength },
        }),
        execute: async () => {
          const req: MediaUploadRequest = { type: args.type, url: probe.finalUrl, name: args.name }
          if (args.type === "image" && BYTES_PLATFORMS.has(account.platform)) {
            // the only download of this URL on our side: pinned, re-validated addresses on every hop
            const media = await fetchMediaBytes(args.url, { maxBytes: MEDIA_LIMITS.image.maxBytes, signal: env.signal })
            req.bytes = media.bytes
            req.contentType = media.contentType
            req.url = media.finalUrl
          }
          const ctx = await env.providerCtx(account)
          const media = await provider.uploadMedia(ctx, req)
          env.log.addObjectIds([media.id])
          return {
            structured: {
              warnings: probe.warnings,
              result: { media: { type: media.type, id: media.id, url: media.url ?? null } },
            },
            summary: `Đã tải ${args.type === "image" ? "ảnh" : "video"} lên, id: ${media.id}.`,
            changes: [{ objectId: media.id, field: "media_uploaded", before: null, after: displayUrl(probe.finalUrl) }],
          }
        },
      })
    },
  })
}

/**
 * Google Ads video = a YouTube video: a YouTube URL / 11-char id becomes a YoutubeVideoAsset. Nothing is downloaded
 * or probed on our side (the id is all Google needs); any other URL is refused with a pointer to YouTube.
 */
async function uploadYoutubeVideo(
  env: ToolEnv,
  provider: ReturnType<typeof providerFor>,
  account: GrantAccount,
  args: { type: "image" | "video"; url: string; name?: string } & Record<string, unknown>
) {
  const videoId = parseYoutubeVideoId(args.url)
  if (!videoId) {
    throw invalid(
      "unsupported_media",
      "Google Ads không nhận file video trực tiếp: video quảng cáo phải được đăng lên YouTube trước.",
      "Truyền link YouTube (youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…) hoặc ID video 11 ký tự; hoặc gọi google_ads_add_youtube_video."
    )
  }
  const watchUrl = youtubeWatchUrl(videoId)
  return runWrite(env, {
    args,
    account,
    preview: async () => ({
      changes: [
        {
          object: args.name ?? `YouTube ${videoId}`,
          object_id: "-",
          level: null,
          field: "youtube_video_asset",
          before: null,
          after: watchUrl,
        },
      ],
      warnings: ["Google Ads dùng video YouTube có sẵn (không tải file lên); asset đã có cho video này sẽ được dùng lại."],
      effective_at: null,
      details: { youtube_video_id: videoId },
    }),
    execute: async () => {
      const ctx = await env.providerCtx(account)
      const media = await provider.uploadMedia(ctx, { type: "video", url: watchUrl, name: args.name })
      env.log.addObjectIds([media.id])
      return {
        structured: { warnings: [], result: { media: { type: media.type, id: media.id, url: media.url ?? watchUrl } } },
        summary: `Đã tạo asset video YouTube ${videoId}, id: ${media.id}.`,
        changes: [{ objectId: media.id, field: "youtube_video_asset", before: null, after: watchUrl }],
      }
    },
  })
}
