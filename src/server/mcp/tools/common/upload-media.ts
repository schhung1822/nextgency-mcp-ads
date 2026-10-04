import { z } from "zod"
import { redactUrl } from "../../../audit/redact"
import { fetchMediaBytes, MEDIA_LIMITS, probeMedia } from "../../../net/ssrf"
import type { MediaUploadRequest, Platform } from "../../../providers/types"
import { assertGrant } from "../../grant"
import { accountIdSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { CREATE_ANNOTATIONS, providerFor, registerToolSpec, runWrite, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"

export const NAME = "ads_upload_media"

/**
 * Platforms whose adapter uploads the file content itself (Meta adimages bytes):
 * mcp-core downloads the image ONCE through the SSRF guard and hands the bytes over, so the adapter never
 * resolves/fetches the AI-supplied URL. OpenAI (and Meta video) upload by URL: the platform's
 * servers fetch it after our probe - residual risk accepted (the fetch is not on our network).
 */
const BYTES_PLATFORMS = new Set<Platform>(["meta"])

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
      "Dùng khi cần đưa một ảnh hoặc video từ URL công khai (http/https) vào thư viện của tài khoản quảng cáo để dùng khi tạo quảng cáo; trả về id media (Meta image_hash/video_id, OpenAI Ads file_id). Gọi ads_list_accounts trước để có account_id. Không hỗ trợ địa chỉ nội bộ; ảnh tối đa 30 MB, video tối đa 500 MB. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.",
    kind: "write",
    annotations: CREATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      type: z.enum(["image", "video"]),
      url: z.string().max(2_000).describe("URL công khai http(s) tải trực tiếp được tệp"),
      name: z.string().max(200).optional(),
      ...writeFields,
    }),
    output: writeOutputSchema,
    // signed URLs (S3/GCS/CDN tokens) must not end up in mcp_call_logs / mcp_pending_actions
    logArgs: (args) => ({ ...args, url: redactUrl(String(args.url ?? "")) }),
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "create" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId })
      const provider = providerFor(account.platform, "upload_media")
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
