import { z } from "zod"
import { driveJobs } from "../../../../lib/i18n/vi/drive-jobs"
import { createRelayLink } from "../../../drive/relay-links"
import { downloadDriveBytes, openDriveDownload } from "../../../drive/files"
import { isGoogleDriveUrl } from "../../../drive/links"
import {
  findReusableMedia,
  recordMediaUpload,
} from "../../../drive/media-uploads"
import {
  createUploadJob,
  isUploadJobLimitError,
  listUploadJobs,
  updateUploadJob,
  uploadJobLimitHit,
  type UploadJobLimitError,
  type UploadJobView,
} from "../../../drive/upload-jobs"
import { enqueueVideoUpload } from "../../../drive/upload-queue"
import {
  FILE_TYPES,
  sniffMediaType,
  type FileType,
} from "../../../net/media-type"
import { isMediaBusyError, withMediaSlot } from "../../../net/media-slots"
import {
  fetchMediaBytes,
  MEDIA_LIMITS,
  probeMedia,
  safeFetch,
  sniffImageMime,
} from "../../../net/ssrf"
import {
  isTelegramMediaError,
  prepareAttachment,
  sanitizeFileName,
  type TelegramMediaError,
} from "../../../notifications/media"
import { MAX_IMAGE_BYTES as GOOGLE_IMAGE_MAX_BYTES } from "../../../providers/google-ads/media"
import {
  parseYoutubeVideoId,
  youtubeWatchUrl,
} from "../../../providers/google-ads/youtube"
import { OPENAI_IMAGE_MAX_BYTES } from "../../../providers/openai-ads/media"
import { TIKTOK_IMAGE_MAX_BYTES } from "../../../providers/tiktok/media"
import type {
  AdsProvider,
  MediaRef,
  MediaStatus,
  MediaUploadRequest,
  MutationOptions,
  Platform,
} from "../../../providers/types"
import {
  driveCall,
  drivePublicUsable,
  mediaFamily,
  resolveDriveItem,
  type ResolvedDriveItem,
} from "../../drive-access"
import { invalid, McpToolError } from "../../errors"
import { assertGrant, platformLabel } from "../../grant"
import { driveRefForLog, stripMediaUrlQueries } from "../../log-args"
import {
  accountIdSchema,
  platformEnum,
  writeFields,
  writeOutputSchema,
} from "../../schemas"
import {
  CREATE_ANNOTATIONS,
  providerFor,
  registerToolSpec,
  runWrite,
  type ToolContext,
  type ToolEnv,
  type ToolOutcome,
} from "../../tool"
import { grantPlatformsWith, type GrantAccount } from "../../types"
import {
  fileInput,
  MEDIA_CALL_BUDGET_MS,
  MEDIA_UPLOAD_RESERVE_MS,
} from "../telegram/attachment"
import { fileFacts, nameLabel, sourceLabel } from "../drive/shared"

export const NAME = "ads_upload_media"

/**
 * Platforms whose adapter uploads the file content itself (Meta adimages bytes, Google imageAsset.data):
 * mcp-core downloads the image ONCE through the SSRF guard and hands the bytes over, so the adapter never
 * resolves/fetches the AI-supplied URL. TikTok / OpenAI (and Meta video) upload by URL: the platform's
 * servers fetch it after our probe - residual risk accepted (the fetch is not on our network).
 * Google video = a YouTube video (URL or 11-char id) turned into a YoutubeVideoAsset: nothing is downloaded.
 * Google Drive files and ChatGPT-attached images are always uploaded as BYTES, on every platform (GD1).
 */
const BYTES_PLATFORMS = new Set<Platform>(["meta", "google_ads"])

/** ChatGPT binds a file the user attached to the `file` argument (Apps SDK "File APIs"). */
export const UPLOAD_META = { "openai/fileParams": ["file"] } as const

/** Image bytes per platform (Drive / ChatGPT paths): size cap (never above the in-memory cap) and accepted types. */
const IMAGE_RULES: Record<
  string,
  { maxBytes: number; mimes: ReadonlySet<string>; types: string }
> = {
  meta: {
    maxBytes: MEDIA_LIMITS.image.maxBytes,
    mimes: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    types: "JPG, PNG, GIF, WebP",
  },
  google_ads: {
    maxBytes: GOOGLE_IMAGE_MAX_BYTES,
    mimes: new Set(["image/jpeg", "image/png", "image/gif"]),
    types: "JPEG, PNG, GIF",
  },
  tiktok: {
    maxBytes: Math.min(TIKTOK_IMAGE_MAX_BYTES, MEDIA_LIMITS.image.maxBytes),
    mimes: new Set(["image/jpeg", "image/png"]),
    types: "JPG, PNG",
  },
  openai_ads: {
    maxBytes: OPENAI_IMAGE_MAX_BYTES,
    mimes: new Set(["image/jpeg", "image/png", "image/webp"]),
    types: "JPEG, PNG, WebP",
  },
}
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime"])
/** TikTok image pixel cap (adapters task: ≤ 3,686,400 px) - warned from Drive metadata */
const TIKTOK_MAX_PIXELS = 3_686_400
/** TikTok image upload endpoint times out after 10 s: warn above this size (API review #7) */
const TIKTOK_IMAGE_WARN_BYTES = 10 * 1024 * 1024
/** OpenAI Ads images: at least 640×640 */
const OPENAI_MIN_SIDE = 640
/** kept between the video deadline and the call deadline (polling may overrun by one status call) */
const VIDEO_WAIT_MARGIN_MS = 8_000

/**
 * Drive videos the platform downloads by URL within the tool call (relay /dl/…): TikTok UPLOAD_BY_URL "better within
 * 10 MB" (10 s request timeout), Meta file_url ≤ 20 MB (v1.1.2 D6: 28-38 MB file_url uploads timed out inside the
 * call budget). Larger Drive videos go through the background chunked upload job.
 */
export const RELAY_VIDEO_MAX_BYTES: Partial<Record<Platform, number>> = {
  tiktok: 10 * 1024 * 1024,
  meta: 20 * 1024 * 1024,
}

/**
 * ChatGPT-attached videos (the platform downloads the signed link within the call; there is no background path):
 * caps unchanged by D6 (owner decision 2026-10-09) - larger ones are refused with a pointer to Google Drive.
 */
export const CHATGPT_VIDEO_MAX_BYTES: Partial<Record<Platform, number>> = {
  tiktok: 10 * 1024 * 1024,
  meta: 50 * 1024 * 1024,
}

const ACTIVE_JOB_STATUSES = new Set<UploadJobView["status"]>([
  "queued",
  "uploading",
  "processing",
])

function imageRule(platform: Platform) {
  return IMAGE_RULES[platform] ?? IMAGE_RULES.meta!
}

/** the video deadline handed to the adapter: upload timeout + processing polling end there */
/** Media uploads keep this much of their call budget for the work itself; the write pacing may wait the rest. */
const PACED_MEDIA_WORK_MS = 30_000

/** Longest write-pacing wait of a media upload whose call budget ends at `deadline` (settings.writeDelaySeconds). */
function pacedMediaWait(deadline: number): number {
  return Math.max(0, deadline - Date.now() - PACED_MEDIA_WORK_MS)
}

function videoDeadline(deadline: number): number {
  return deadline - VIDEO_WAIT_MARGIN_MS
}

/**
 * Media URL that may be returned to the AI / stored for reuse: Meta (adimages url) and TikTok (image_url /
 * preview_url) hand out SIGNED, EXPIRING CDN links (API review #6) → never kept; Google (YouTube watch URL) and
 * OpenAI keep theirs.
 */
function stableMediaUrl(platform: Platform, media: MediaRef): string | null {
  if (platform === "meta" || platform === "tiktok") return null
  return media.url ?? null
}

function tiktokImageWarning(
  platform: Platform,
  bytes: number | null
): string | null {
  return platform === "tiktok" &&
    bytes !== null &&
    bytes > TIKTOK_IMAGE_WARN_BYTES
    ? `Ảnh ${mb(bytes)} lớn hơn 10 MB - TikTok giới hạn 10 giây cho mỗi lần tải ảnh nên có thể báo lỗi hết thời gian; nên nén ảnh nhỏ hơn.`
    : null
}

/** URL for logs/previews: scheme + host + path only (signed query strings removed). */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300)
  } catch {
    return "[url]"
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

const fileTypeByMime = new Map<string, FileType>(
  Object.values(FILE_TYPES).map((t) => [t.mime, t as FileType])
)

const output = writeOutputSchema.extend({
  /** "queued": a large Drive video is uploaded by a background job (check with ads_get_media_upload) */
  status: z.enum(["confirmation_required", "success", "queued"]),
  /** Drive: the media id of this exact file version was already uploaded to this account - nothing uploaded again */
  reused: z.boolean().optional(),
  /** video: the platform was still processing when the wait budget ended (the id is usable; check later) */
  processing: z.boolean().optional(),
  /** background upload (status "queued"): id for ads_get_media_upload; null when another MCP runs that upload */
  upload_id: z.string().nullable().optional(),
  /** background upload: an upload of this file to this account was already running (nothing new started) */
  existing: z.boolean().optional(),
  /** background upload: queued | uploading | processing */
  upload_status: z.string().optional(),
  /**
   * video: the upload call timed out but the video was found again in the library by its unique name (Meta) - the id
   * is that video, nothing was uploaded twice
   */
  recovered: z.boolean().optional(),
  /** reused Meta video: live status on the platform (processing | ready | failed) when it could be read */
  media_status: z.enum(["processing", "ready", "failed"]).optional(),
})

type UploadArgs = {
  platform: Platform
  account_id: string
  type?: "image" | "video"
  url?: string
  drive_file?: string
  file?: {
    download_url: string
    file_id: string
    mime_type?: string
    file_name?: string
  }
  name?: string
  force_reupload?: boolean
} & Record<string, unknown>

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  const platforms = grantPlatformsWith(tctx.grant, "create")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Tải ảnh / video lên tài khoản",
    description:
      'Dùng khi cần đưa một ảnh hoặc video vào thư viện của tài khoản quảng cáo để dùng khi tạo quảng cáo; trả về id media (Meta image_hash/video_id, TikTok image_id/video_id, Google asset, OpenAI file_id). Gọi ads_list_accounts trước để có account_id. Chọn đúng MỘT nguồn: drive_file = file_id hoặc link Google Drive (từ drive_list_files / drive_sheet_read; link Drive trong url cũng được); file = tệp người dùng đính kèm trong ChatGPT; url = link http(s) công khai tải trực tiếp được (cần type). File Drive đã tải lên đúng tài khoản này → trả id cũ (reused: true, không cần xác nhận); force_reupload=true để tải lại. Ảnh: Meta ≤30 MB, Google JPEG/PNG/GIF ≤5 MB, TikTok JPG/PNG, OpenAI JPEG/PNG/WebP ≤20 MB. Video ≤500 MB, chỉ Meta và TikTok (Google Ads: link YouTube hoặc ID 11 ký tự trong url; OpenAI Ads chỉ nhận ảnh); có thể trả processing: true (id vẫn dùng được, xem trạng thái bằng ads_get_media_upload). Video Drive lớn (TikTok > 10 MB, Meta > 20 MB) tải ở chế độ nền: trả status "queued" + upload_id → gọi ads_get_media_upload sau ít phút để lấy media_id; video đính kèm ChatGPT > 10 MB (TikTok) / 50 MB (Meta) phải đưa lên Google Drive. Ảnh bìa video Meta không cần tải riêng: meta_create_ad nhận image_drive_file hoặc tự lấy ảnh bìa Meta. Ảnh do ChatGPT/Gemini tự tạo không gửi được. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.',
    kind: "write",
    annotations: CREATE_ANNOTATIONS,
    meta: UPLOAD_META,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      type: z
        .enum(["image", "video"])
        .optional()
        .describe(
          "Loại media: bắt buộc với url; drive_file / file tự nhận biết"
        ),
      url: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "URL công khai http(s) tải trực tiếp được tệp (Google video: link hoặc ID video YouTube)"
        ),
      drive_file: z
        .string()
        .trim()
        .max(2_048)
        .optional()
        .describe(
          "drive_file (mã drf_…, 24 giờ) hoặc file_id từ drive_list_files / drive_sheet_read, hoặc link Google Drive"
        ),
      file: fileInput.describe(
        "Tệp người dùng đính kèm trong ChatGPT (ChatGPT tự điền). Không dùng cùng url / drive_file."
      ),
      name: z.string().max(200).optional(),
      force_reupload: z
        .boolean()
        .optional()
        .describe("Drive: tải lại dù file này đã có trên tài khoản"),
      ...writeFields,
    }),
    output,
    // signed URLs (S3/GCS/CDN tokens, ChatGPT download_url) and Drive resource keys must not end up in
    // mcp_call_logs / mcp_pending_actions
    logArgs: (args) => uploadLogArgs(args),
    async handler(args, env) {
      const account = assertGrant(env.grant, {
        platform: args.platform,
        accountId: args.account_id,
        permission: "create",
      })
      env.log.setTarget({
        platform: account.platform,
        accountId: account.externalId,
      })
      const provider = providerFor(account.platform, "upload_media")
      const url = args.url?.trim() || undefined
      const driveRef = args.drive_file?.trim() || undefined
      const count = [url, driveRef, args.file].filter(
        (x) => x !== undefined
      ).length
      if (count !== 1) {
        throw invalid(
          count === 0 ? "media_source_required" : "media_source_conflict",
          count === 0
            ? "Thiếu nguồn media: truyền url, drive_file hoặc file."
            : "Chỉ truyền đúng một trong url, drive_file hoặc file.",
          "Ảnh/video trên Google Drive: drive_file; tệp đính kèm ChatGPT: file; link công khai khác: url + type."
        )
      }
      if (
        driveRef !== undefined ||
        (url !== undefined && isGoogleDriveUrl(url))
      ) {
        return uploadFromDrive(env, provider, account, args, (driveRef ?? url)!)
      }
      if (args.file) return uploadChatgptFile(env, provider, account, args)
      if (!args.type)
        throw invalid(
          "type_required",
          "Thiếu type (image hoặc video) cho url.",
          'Truyền type "image" hoặc "video".'
        )
      const type = args.type
      if (account.platform === "google_ads" && type === "video")
        return uploadYoutubeVideo(env, provider, account, {
          ...args,
          url: url!,
        })
      const deadline = Date.now() + MEDIA_CALL_BUDGET_MS
      // SSRF guard + size/type probe on both steps (the URL target may change between them)
      const probe = await probeMedia(url!, type, env.signal)
      const sizeText =
        probe.contentLength !== null
          ? `${(probe.contentLength / 1024 / 1024).toFixed(2)} MB`
          : "không rõ dung lượng"
      const warnings = [...probe.warnings]
      const big =
        type === "image"
          ? tiktokImageWarning(account.platform, probe.contentLength)
          : null
      if (big) warnings.push(big)
      return runWrite(env, {
        args,
        account,
        pacingMaxWaitMs: pacedMediaWait(deadline),
        preview: async () => ({
          changes: [
            {
              object: args.name ?? displayUrl(probe.finalUrl),
              object_id: "-",
              level: null,
              field: "upload",
              before: null,
              after: `${type} (${sizeText})`,
            },
          ],
          warnings,
          effective_at: null,
          details: {
            source: displayUrl(probe.finalUrl),
            content_type: probe.contentType,
            bytes: probe.contentLength,
          },
        }),
        execute: async () => {
          const req: MediaUploadRequest = {
            type,
            url: probe.finalUrl,
            name: args.name,
            // videos: the upload request and the processing wait end before the call budget (API review #5)
            ...(type === "video"
              ? { deadlineAt: videoDeadline(deadline) }
              : {}),
          }
          if (type === "image" && BYTES_PLATFORMS.has(account.platform)) {
            // the only download of this URL on our side: pinned, re-validated addresses on every hop
            const media = await fetchMediaBytes(url!, {
              maxBytes: MEDIA_LIMITS.image.maxBytes,
              signal: env.signal,
            })
            req.bytes = media.bytes
            req.contentType = media.contentType
            req.url = media.finalUrl
          }
          const ctx = await env.providerCtx(account)
          const media = await provider.uploadMedia(ctx, req)
          env.log.addObjectIds([media.id])
          return {
            structured: {
              warnings,
              ...(type === "video"
                ? { processing: media.processing === true }
                : {}),
              ...(media.recovered ? { recovered: true } : {}),
              result: mediaResult(account.platform, media),
            },
            summary: uploadedSummary(media, type === "image" ? "ảnh" : "video"),
            changes: [
              {
                objectId: media.id,
                field: "media_uploaded",
                before: null,
                after: displayUrl(probe.finalUrl),
              },
            ],
          }
        },
      })
    },
  })
}

/** Logged / stored args: Drive refs reduced to the file id, ChatGPT download_url redacted, URL queries stripped. */
export function uploadLogArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const out = stripMediaUrlQueries(args)
  if (typeof args.drive_file === "string")
    out.drive_file = driveRefForLog(args.drive_file)
  if (typeof args.url === "string" && isGoogleDriveUrl(args.url.trim()))
    out.url = driveRefForLog(args.url)
  if (args.file && typeof args.file === "object")
    out.file = {
      ...(args.file as Record<string, unknown>),
      download_url: "[redacted]",
    }
  return out
}

/**
 * Google Ads video = a YouTube video: a YouTube URL / 11-char id becomes a YoutubeVideoAsset. Nothing is downloaded
 * or probed on our side (the id is all Google needs); any other URL is refused with a pointer to YouTube.
 */
async function uploadYoutubeVideo(
  env: ToolEnv,
  provider: ReturnType<typeof providerFor>,
  account: GrantAccount,
  args: { url: string; name?: string } & Record<string, unknown>
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
      warnings: [
        "Google Ads dùng video YouTube có sẵn (không tải file lên); asset đã có cho video này sẽ được dùng lại.",
      ],
      effective_at: null,
      details: { youtube_video_id: videoId },
    }),
    execute: async () => {
      const ctx = await env.providerCtx(account)
      const media = await provider.uploadMedia(ctx, {
        type: "video",
        url: watchUrl,
        name: args.name,
      })
      env.log.addObjectIds([media.id])
      return {
        structured: {
          warnings: [],
          result: {
            media: {
              type: media.type,
              id: media.id,
              url: media.url ?? watchUrl,
            },
          },
        },
        summary: `Đã tạo asset video YouTube ${videoId}, id: ${media.id}.`,
        changes: [
          {
            objectId: media.id,
            field: "youtube_video_asset",
            before: null,
            after: watchUrl,
          },
        ],
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** Google Ads / OpenAI Ads take no video file (G3). */
function refuseVideo(platform: Platform): never {
  if (platform === "google_ads") {
    throw invalid(
      "unsupported_media",
      "Google Ads không nhận file video trực tiếp: video quảng cáo phải được đăng lên YouTube trước.",
      "Đăng video lên YouTube rồi truyền link youtube.com/youtu.be hoặc ID video 11 ký tự trong url (hoặc gọi google_ads_add_youtube_video)."
    )
  }
  throw invalid(
    "unsupported_media",
    `${platformLabel(platform)} chỉ nhận ảnh - không tải được video.`,
    "Dùng ảnh JPEG/PNG/WebP, hoặc dùng video cho Meta / TikTok."
  )
}

function wrongImageType(platform: Platform): McpToolError {
  return invalid(
    "media_wrong_type",
    `${platformLabel(platform)} không nhận loại ảnh này.`,
    `Ảnh cho ${platformLabel(platform)}: ${imageRule(platform).types}.`
  )
}

function imageTooLarge(platform: Platform, bytes: number | null): McpToolError {
  const max = imageRule(platform).maxBytes
  return invalid(
    "media_too_large",
    `Ảnh${bytes !== null ? ` ${mb(bytes)}` : ""} vượt giới hạn ${Math.round(max / 1024 / 1024)} MB của ${platformLabel(platform)}.`,
    "Nén / giảm kích thước ảnh rồi thử lại."
  )
}

function videoTooLarge(bytes: number): McpToolError {
  return invalid(
    "media_too_large",
    `Video ${mb(bytes)} vượt giới hạn ${Math.round(MEDIA_LIMITS.video.maxBytes / 1024 / 1024)} MB.`,
    "Dùng video nhỏ hơn."
  )
}

/** One media job per MCP + the shared per-process pool (2 files in memory, shared with Telegram). */
async function withUploadSlot<T>(
  mcpId: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await withMediaSlot(fn, { key: mcpId })
  } catch (e) {
    if (!isMediaBusyError(e)) throw e
    throw new McpToolError({
      code: "media_busy",
      messageVi:
        e.reason === "key"
          ? "MCP này đang tải một tệp khác - chưa nhận thêm được."
          : "Máy chủ đang tải tệp khác, chưa nhận thêm được.",
      hint: "Thử lại sau vài giây.",
      logStatus: "rate_limited",
    })
  }
}

/** remaining download budget: never eats the upload's share, at least 1 s */
function downloadSignal(env: ToolEnv, deadline: number): AbortSignal {
  return AbortSignal.any([
    env.signal,
    AbortSignal.timeout(
      Math.max(1_000, deadline - Date.now() - MEDIA_UPLOAD_RESERVE_MS)
    ),
  ])
}

function mediaResult(
  platform: Platform,
  media: MediaRef,
  extra: Record<string, unknown> = {}
) {
  return {
    media: {
      type: media.type,
      id: media.id,
      url: stableMediaUrl(platform, media),
    },
    ...extra,
  }
}

function uploadedSummary(media: MediaRef, what: string): string {
  return media.processing
    ? `Đã tải ${what} lên, id: ${media.id} - nền tảng đang xử lý video (id dùng được; xem trạng thái bằng ads_get_media_upload với video_id trước khi tạo quảng cáo).`
    : `Đã tải ${what} lên, id: ${media.id}.`
}

/** D8: the upload call timed out but the video was found again in the library by its unique name. */
function RECOVERED_NOTE(id: string): string {
  return `Nền tảng phản hồi chậm nhưng đã tìm lại được video vừa tải (id ${id}) trong thư viện - không tải trùng.`
}

/** Live status of an uploaded video where the platform can tell (Meta getMediaStatus); null = unknown / unsupported. */
export async function liveVideoStatus(
  env: ToolEnv,
  provider: AdsProvider,
  account: GrantAccount,
  videoId: string
): Promise<MediaStatus | null> {
  if (!provider.getMediaStatus) return null
  try {
    const ctx = await env.providerCtx(account)
    return await provider.getMediaStatus(ctx, { type: "video", id: videoId })
  } catch {
    return null
  }
}

/** Image types accepted from a URL the platform returned (Meta video thumbnails are JPEG / PNG). */
const PLATFORM_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/**
 * MutationOptions.fetchImage (D2): ONE download of an image URL the platform returned (Meta video thumbnail = signed
 * fbcdn link) through the SSRF guard - https only on every hop, pinned addresses, size cap, overall deadline, magic
 * bytes. The URL is never logged; error messages never carry it.
 */
export function fetchPlatformImage(
  env: Pick<ToolEnv, "signal" | "grant">,
  deadline: number
): NonNullable<MutationOptions["fetchImage"]> {
  return async (url, o) => {
    // S-L2: Meta CDN hosts only - the first URL and the final hop (redirects are re-checked by safeFetch too)
    if (!isPlatformImageHost(url))
      throw invalid(
        "url_not_allowed",
        "Ảnh của nền tảng nằm ở địa chỉ không được phép."
      )
    const totalTimeoutMs = Math.max(
      1_000,
      Math.min(20_000, deadline - Date.now() - COVER_UPLOAD_RESERVE_MS)
    )
    return withCoverSlot(env.grant.mcpId, deadline, async () => {
      const res = await safeFetch(url, {
        method: "GET",
        readBody: true,
        httpsOnly: true,
        maxBytes: Math.min(o.maxBytes, MEDIA_LIMITS.image.maxBytes),
        timeoutMs: Math.min(15_000, totalTimeoutMs),
        totalTimeoutMs,
        signal: env.signal,
      })
      if (!isPlatformImageHost(res.finalUrl))
        throw invalid(
          "url_not_allowed",
          "Ảnh của nền tảng nằm ở địa chỉ không được phép."
        )
      if (
        res.status < 200 ||
        res.status >= 300 ||
        !res.body ||
        res.body.length === 0
      )
        throw invalid("media_unreachable", "Không tải được ảnh từ nền tảng.")
      const contentType = sniffImageMime(res.body)
      if (!contentType || !PLATFORM_IMAGE_MIMES.has(contentType))
        throw invalid("media_wrong_type", "Nền tảng không trả ảnh hợp lệ.")
      return { bytes: new Uint8Array(res.body), contentType }
    })
  }
}

/** Hosts a platform image (Meta video thumbnail) may be downloaded from (S-L2). */
export const PLATFORM_IMAGE_HOST_SUFFIXES = [
  ".fbcdn.net",
  ".facebook.com",
  ".fbsbx.com",
] as const

function isPlatformImageHost(raw: string): boolean {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    return (
      u.protocol === "https:" &&
      PLATFORM_IMAGE_HOST_SUFFIXES.some((s) => host.endsWith(s))
    )
  } catch {
    return false
  }
}

/** kept for the adimages upload + the create call after a cover download */
const COVER_UPLOAD_RESERVE_MS = 15_000
/** how long a cover step waits for its MCP's cover slot (a parallel cover of the same MCP) */
const COVER_SLOT_WAIT_MS = 5_000

/**
 * Media slot of a cover step (Drive cover download, Meta automatic cover) - C-M3: its own key `<mcp>:cover` (an
 * ads_upload_media of the same MCP does not block it) and a short wait instead of failing at once (the confirmation
 * may already be consumed). Still busy → media_busy with a retry hint.
 */
export async function withCoverSlot<T>(
  mcpId: string,
  deadline: number,
  fn: () => Promise<T>
): Promise<T> {
  const until = Math.min(
    Date.now() + COVER_SLOT_WAIT_MS,
    deadline - COVER_UPLOAD_RESERVE_MS
  )
  for (;;) {
    try {
      return await withMediaSlot(fn, { key: `${mcpId}:cover` })
    } catch (e) {
      if (!isMediaBusyError(e)) throw e
      if (e.reason === "key" && Date.now() + 250 < until) {
        await new Promise((r) => setTimeout(r, 250))
        continue
      }
      throw new McpToolError({
        code: "media_busy",
        messageVi: "Máy chủ đang tải tệp khác, chưa xử lý được ảnh bìa.",
        hint: "Thử lại sau vài giây.",
        logStatus: "rate_limited",
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Google Drive image named inside another tool's input (meta_create_ad creative.image_drive_file - D5)
// ---------------------------------------------------------------------------

export interface DriveCover {
  item: ResolvedDriveItem
  fileId: string
  /** "name (x MB)" for previews / labels - the file name is external data */
  label: string
  /** image id of this exact file version already in the ad account (reuse), else null */
  reusedId: string | null
}

/**
 * Both steps: resolve a Drive image in the MCP's Drive scope (granted folders / public links when allowed), check it
 * is an image of the platform's types and size, and look up a reusable upload. Nothing is downloaded.
 */
export async function resolveDriveCover(
  env: ToolEnv,
  account: GrantAccount,
  ref: string
): Promise<DriveCover> {
  const r = await driveCall(() =>
    resolveDriveItem(env.grant, ref, {
      want: "media",
      allowPublic: drivePublicUsable(env.grant),
      signal: env.signal,
    })
  )
  const file = r.file
  env.log.addObjectIds([file.id])
  if (r.family !== "image") {
    throw invalid(
      "media_type_mismatch",
      "File Google Drive dùng làm ảnh bìa / ảnh quảng cáo phải là ảnh, không phải video.",
      "Chọn file ảnh (JPG/PNG) trên Google Drive."
    )
  }
  const rule = imageRule(account.platform)
  if (!rule.mimes.has(file.mimeType.toLowerCase()))
    throw wrongImageType(account.platform)
  if (file.sizeBytes !== null && file.sizeBytes > rule.maxBytes)
    throw imageTooLarge(account.platform, file.sizeBytes)
  const facts = fileFacts(file)
  let reusedId: string | null = null
  if (r.contentKey) {
    const hit = await findReusableMedia({
      adAccountId: account.id,
      driveFileId: file.id,
      contentKey: r.contentKey,
    })
    if (hit && hit.mediaType === "image") reusedId = hit.mediaId
  }
  return {
    item: r,
    fileId: file.id,
    label: `${facts.name}${facts.size_mb !== null ? ` (${facts.size_mb} MB)` : ""}`,
    reusedId,
  }
}

/** Execution: the image id of the Drive cover in the ad account - reused, or downloaded + uploaded (bytes) + recorded. */
export async function uploadDriveCover(
  env: ToolEnv,
  account: GrantAccount,
  cover: DriveCover,
  deadline: number = Date.now() + MEDIA_CALL_BUDGET_MS
): Promise<{ id: string; reused: boolean }> {
  if (cover.reusedId) return { id: cover.reusedId, reused: true }
  const provider = providerFor(account.platform, "upload_media")
  const media = await driveImage(
    env,
    provider,
    account,
    cover.item,
    { platform: account.platform, account_id: account.externalId },
    deadline,
    {
      slot: (fn) => withCoverSlot(env.grant.mcpId, deadline, fn),
      uploadDeadline: deadline - COVER_UPLOAD_RESERVE_MS,
    }
  )
  env.log.addObjectIds([media.id])
  if (cover.item.contentKey) {
    await recordMediaUpload({
      adAccountId: account.id,
      driveFileId: cover.fileId,
      contentKey: cover.item.contentKey,
      mediaType: "image",
      mediaId: media.id,
      mediaUrl: stableMediaUrl(account.platform, media),
      sizeBytes: cover.item.file.sizeBytes,
      sourceId: cover.item.source?.id ?? null,
      mcpId: env.grant.mcpId,
    }).catch(() => {
      // reuse is an optimisation: a failed bookkeeping row never fails an upload that happened
    })
  }
  return { id: media.id, reused: false }
}

// ---------------------------------------------------------------------------
// Google Drive (15-google-drive-media.md §7.2)
// ---------------------------------------------------------------------------

async function uploadFromDrive(
  env: ToolEnv,
  provider: ReturnType<typeof providerFor>,
  account: GrantAccount,
  args: UploadArgs,
  ref: string
): Promise<ToolOutcome> {
  const deadline = Date.now() + MEDIA_CALL_BUDGET_MS
  const platform = account.platform
  const r = await driveCall(() =>
    resolveDriveItem(env.grant, ref, {
      want: "media",
      allowPublic: drivePublicUsable(env.grant),
      signal: env.signal,
    })
  )
  const file = r.file
  const family = r.family!
  env.log.addObjectIds([file.id])
  if (args.type && args.type !== family) {
    throw invalid(
      "media_type_mismatch",
      `File Drive này là ${family === "image" ? "ảnh" : "video"}, không khớp type "${args.type}".`,
      "Bỏ type (tự nhận biết) hoặc chọn đúng file."
    )
  }
  const warnings: string[] = []
  if (family === "video") {
    if (platform === "google_ads" || platform === "openai_ads")
      refuseVideo(platform)
    if (!VIDEO_MIMES.has(file.mimeType.toLowerCase())) {
      throw invalid(
        "media_wrong_type",
        "Chỉ tải được video MP4 hoặc MOV.",
        "Xuất video sang MP4 (H.264) rồi tải lên Drive."
      )
    }
    if (file.sizeBytes === null || !r.contentKey) {
      throw invalid(
        "drive_size_unknown",
        "Google Drive không cho biết dung lượng / phiên bản của video này.",
        "Tải lại video lên Drive rồi thử lại."
      )
    }
    if (file.sizeBytes > MEDIA_LIMITS.video.maxBytes)
      throw videoTooLarge(file.sizeBytes)
  } else {
    const rule = imageRule(platform)
    if (!rule.mimes.has(file.mimeType.toLowerCase()))
      throw wrongImageType(platform)
    if (file.sizeBytes !== null && file.sizeBytes > rule.maxBytes)
      throw imageTooLarge(platform, file.sizeBytes)
    if (
      platform === "tiktok" &&
      file.width &&
      file.height &&
      file.width * file.height > TIKTOK_MAX_PIXELS
    ) {
      warnings.push(
        `Ảnh ${file.width}×${file.height} vượt ${TIKTOK_MAX_PIXELS.toLocaleString("vi-VN")} điểm ảnh - TikTok có thể từ chối.`
      )
    }
    if (
      platform === "openai_ads" &&
      file.width &&
      file.height &&
      (file.width < OPENAI_MIN_SIDE || file.height < OPENAI_MIN_SIDE)
    ) {
      warnings.push(
        `Ảnh ${file.width}×${file.height} nhỏ hơn ${OPENAI_MIN_SIDE}×${OPENAI_MIN_SIDE} - OpenAI Ads có thể từ chối.`
      )
    }
    const big = tiktokImageWarning(platform, file.sizeBytes)
    if (big) warnings.push(big)
  }
  const facts = fileFacts(file)
  const from = sourceLabel(r.source)
  const driveInfo = { file_id: file.id, name: facts.name, source: from }

  // reuse: the same file version is already in this ad account → no upload, no confirmation
  if (r.contentKey && args.force_reupload !== true) {
    const hit = await findReusableMedia({
      adAccountId: account.id,
      driveFileId: file.id,
      contentKey: r.contentKey,
    })
    // a reused video is checked live where the platform can tell (Meta): a video that failed on the platform is not
    // handed out again - it is uploaded anew (D8); an unreadable status keeps the reuse
    const live =
      hit && hit.mediaType === "video" && family === "video"
        ? await liveVideoStatus(env, provider, account, hit.mediaId)
        : null
    // a confirm_token means the preview chose to upload (the reused video had failed): when the live status cannot
    // be read now, the failed id is not handed out as "reused" - the confirmed upload runs (C-Low)
    const unverifiedAtConfirm =
      !!args.confirm_token &&
      hit?.mediaType === "video" &&
      live === null &&
      !!provider.getMediaStatus
    if (live?.status === "failed") {
      warnings.push(
        `Video đã tải trước đó (id ${hit!.mediaId}) bị nền tảng báo lỗi xử lý - tải lại từ Google Drive.`
      )
    } else if (hit && hit.mediaType === family && !unverifiedAtConfirm) {
      env.log.addObjectIds([hit.mediaId])
      return {
        structured: {
          status: "success",
          platform: account.platform,
          account_id: account.externalId,
          reused: true,
          ...(live ? { media_status: live.status } : {}),
          warnings,
          result: {
            media: {
              type: hit.mediaType,
              id: hit.mediaId,
              url: stableMediaUrl(platform, {
                type: hit.mediaType,
                id: hit.mediaId,
                url: hit.mediaUrl,
              }),
            },
            drive: driveInfo,
          },
        },
        summary: `File "${facts.name}" đã có trên tài khoản này - dùng lại id: ${hit.mediaId} (không tải lại; force_reupload=true để tải lại).${live?.status === "processing" ? ` Nền tảng đang xử lý video${live.progressPercent !== null ? ` (${live.progressPercent}%)` : ""} - xem bằng ads_get_media_upload với video_id trước khi tạo quảng cáo.` : ""}`,
      }
    }
  }

  // large videos: background chunked upload (owner decision 2026-10-09), small ones: relay link below
  const relayMax = RELAY_VIDEO_MAX_BYTES[platform] ?? 0
  if (family === "video" && file.sizeBytes! > relayMax) {
    return queueDriveVideo(env, account, r, args, {
      deadline,
      warnings,
      driveInfo,
      facts,
      from,
    })
  }

  const details = [
    facts.size_mb !== null ? `${facts.size_mb} MB` : null,
    facts.width && facts.height ? `${facts.width}×${facts.height}` : null,
    facts.duration_s !== null ? `${facts.duration_s} giây` : null,
  ].filter(Boolean)
  return runWrite(env, {
    args,
    account,
    pacingMaxWaitMs: pacedMediaWait(deadline),
    preview: async () => ({
      changes: [
        {
          object: args.name ?? facts.name,
          object_id: "-",
          level: null,
          field: "upload",
          before: null,
          after: `${family === "image" ? "ảnh" : "video"} từ ${from}${details.length ? ` (${details.join(", ")})` : ""}`,
        },
      ],
      warnings,
      effective_at: null,
      details: {
        drive_file_id: file.id,
        file_name: facts.name,
        source: from,
        mime: facts.mime,
        size_mb: facts.size_mb,
        width: facts.width,
        height: facts.height,
        duration_s: facts.duration_s,
      },
    }),
    execute: async () => {
      const media =
        family === "image"
          ? await driveImage(env, provider, account, r, args, deadline)
          : await driveVideo(env, provider, account, r, args, deadline)
      env.log.addObjectIds([media.id])
      // a video still processing is recorded for reuse only on Meta (D8: no duplicate upload when the AI asks again;
      // a reused Meta video is checked live and a failed one is uploaded anew). Elsewhere (API review #6) it may
      // still fail on the platform, so it is not recorded.
      if (media.processing !== true || platform === "meta") {
        await recordMediaUpload({
          adAccountId: account.id,
          driveFileId: file.id,
          contentKey: r.contentKey!,
          mediaType: family,
          mediaId: media.id,
          mediaUrl: stableMediaUrl(platform, media),
          sizeBytes: file.sizeBytes,
          sourceId: r.source?.id ?? null,
          mcpId: env.grant.mcpId,
        }).catch(() => {
          // reuse is an optimisation: a failed bookkeeping row never fails an upload that happened
        })
      }
      return {
        structured: {
          warnings: media.recovered
            ? [...warnings, RECOVERED_NOTE(media.id)]
            : warnings,
          reused: false,
          ...(family === "video"
            ? { processing: media.processing === true }
            : {}),
          ...(media.recovered ? { recovered: true } : {}),
          result: mediaResult(platform, media, { drive: driveInfo }),
        },
        summary: uploadedSummary(
          media,
          family === "image" ? `ảnh "${facts.name}"` : `video "${facts.name}"`
        ),
        changes: [
          {
            objectId: media.id,
            field: "media_uploaded",
            before: null,
            after: `Google Drive: ${facts.name} (${file.id})`,
          },
        ],
      }
    },
  })
}

/** Image: download the bytes (≤ platform cap, shared slot), check the magic bytes, upload the BYTES. */
async function driveImage(
  env: ToolEnv,
  provider: ReturnType<typeof providerFor>,
  account: GrantAccount,
  r: ResolvedDriveItem,
  args: UploadArgs,
  deadline: number,
  o: {
    /** media slot wrapper (default: the MCP's upload slot) */
    slot?: <T>(fn: () => Promise<T>) => Promise<T>
    /** deadline of the platform upload call (cover steps) */
    uploadDeadline?: number
  } = {}
): Promise<MediaRef> {
  const rule = imageRule(account.platform)
  const slot =
    o.slot ?? (<T>(fn: () => Promise<T>) => withUploadSlot(env.grant.mcpId, fn))
  return slot(async () => {
    const bytes = await driveCall(() =>
      downloadDriveBytes(r.auth, r.file.id, {
        maxBytes: rule.maxBytes,
        resourceKey: r.resourceKey,
        signal: downloadSignal(env, deadline),
      })
    ).catch((e) => {
      if (e instanceof McpToolError && e.code === "drive_too_large")
        throw imageTooLarge(account.platform, null)
      throw e
    })
    const type = sniffMediaType(bytes)
    if (!type || type.family !== "image") {
      throw invalid(
        "media_wrong_type",
        "Nội dung file trên Drive không phải ảnh hợp lệ.",
        `Ảnh cho ${platformLabel(account.platform)}: ${rule.types}.`
      )
    }
    if (!rule.mimes.has(type.mime)) throw wrongImageType(account.platform)
    const ctx = await env.providerCtx(account)
    return provider.uploadMedia(ctx, {
      type: "image",
      // informational only: adapters use the bytes and never fetch it
      url: `https://drive.google.com/file/d/${r.file.id}`,
      name: args.name,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      contentType: type.mime,
      fileName: sanitizeFileName(r.file.name, type.ext),
      ...(o.uploadDeadline !== undefined
        ? { deadlineAt: o.uploadDeadline }
        : {}),
    })
  })
}

/** First bytes of a Drive file (magic check of videos) - a ranged request, the rest is never read. */
async function driveHead(
  r: ResolvedDriveItem,
  signal: AbortSignal
): Promise<Buffer> {
  const dl = await openDriveDownload(r.auth, r.file.id, {
    range: "bytes=0-255",
    resourceKey: r.resourceKey,
    signal,
  })
  const reader = dl.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size < 256) {
      const c = await reader.read()
      if (c.done) break
      chunks.push(
        Buffer.from(c.value.buffer, c.value.byteOffset, c.value.byteLength)
      )
      size += c.value.byteLength
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, size).subarray(0, 256)
}

/**
 * Video (Meta / TikTok): magic check of the first bytes, then a temporary relay link /dl/<token>/<name> (60 min,
 * 30 fetches, this file version only) the platform downloads from. The link is a secret: never logged, never
 * returned to the AI.
 */
async function driveVideo(
  env: ToolEnv,
  provider: ReturnType<typeof providerFor>,
  account: GrantAccount,
  r: ResolvedDriveItem,
  args: UploadArgs,
  deadline: number
): Promise<MediaRef> {
  const { fileName, contentType } = await checkDriveVideo(env, r, deadline)
  const relay = await createRelayLink({
    mcpId: env.grant.mcpId,
    adAccountId: account.id,
    driveFileId: r.file.id,
    contentKey: r.contentKey!,
    // the /dl route re-checks that this source is still live and in the MCP scope (null = public link)
    sourceId: r.source?.id ?? null,
    access: r.access,
    resourceKey: r.resourceKey,
    fileName,
    contentType,
    sizeBytes: r.file.sizeBytes!,
  })
  const ctx = await env.providerCtx(account)
  return provider.uploadMedia(ctx, {
    type: "video",
    url: relay.url,
    name: args.name,
    fileName,
    deadlineAt: videoDeadline(deadline),
  })
}

/** Magic check of the first 256 bytes (Range) → sanitised file name + sniffed type of a Drive video. */
async function checkDriveVideo(
  env: ToolEnv,
  r: ResolvedDriveItem,
  deadline: number
): Promise<{ fileName: string; contentType: string }> {
  const head = await driveCall(() =>
    driveHead(r, downloadSignal(env, deadline))
  )
  const type = sniffMediaType(head)
  if (!type || type.family !== "video") {
    throw invalid(
      "media_wrong_type",
      "Nội dung file trên Drive không phải video MP4 / MOV hợp lệ.",
      "Xuất video sang MP4 (H.264) rồi tải lên Drive."
    )
  }
  return {
    fileName: sanitizeFileName(r.file.name, type.ext),
    contentType: type.mime,
  }
}

/** What the AI sees of a background upload. */
function uploadJobFields(job: UploadJobView, mcpId: string, existing: boolean) {
  // another MCP's job cannot be read with ads_get_media_upload of this MCP: no id, no status (T-7)
  if (job.mcpId !== mcpId)
    return { status: "queued" as const, upload_id: null, existing }
  return {
    status: "queued" as const,
    upload_id: job.id,
    existing,
    upload_status: job.status,
  }
}

/** A cap on active background uploads is reached (security review M-1) → rate_limited tool error. */
function uploadLimitError(e: UploadJobLimitError): McpToolError {
  const t = driveJobs.videoUpload.limits
  return new McpToolError({
    code: "upload_limit_reached",
    messageVi:
      e.kind === "mcp"
        ? t.perMcp(e.limit)
        : e.kind === "owner"
          ? t.perOwner(e.limit)
          : t.system,
    hint: t.hint,
    logStatus: "rate_limited",
  })
}

/**
 * Large Drive video (> RELAY_VIDEO_MAX_BYTES): a background job (worker "media.video_upload") uploads it in chunks
 * from Drive to the platform. An upload of the same file to the same account that is still running is returned as
 * is, without confirmation; otherwise the 2-step confirm runs, then the job is created and enqueued. The worker
 * records the media for reuse when the platform accepted it.
 */
async function queueDriveVideo(
  env: ToolEnv,
  account: GrantAccount,
  r: ResolvedDriveItem,
  args: UploadArgs,
  o: {
    deadline: number
    warnings: string[]
    driveInfo: Record<string, unknown>
    facts: ReturnType<typeof fileFacts>
    from: string
  }
): Promise<ToolOutcome> {
  const file = r.file
  const mcpId = env.grant.mcpId
  const label = `video "${o.facts.name}"`
  const base = {
    platform: account.platform,
    account_id: account.externalId,
  }
  // 1. already running for this MCP → no new job, no confirmation
  const active = (await listUploadJobs(mcpId, { limit: 50 })).find(
    (j) =>
      j.adAccountId === account.id &&
      j.driveFileId === file.id &&
      ACTIVE_JOB_STATUSES.has(j.status)
  )
  if (active) {
    env.log.addObjectIds([active.id])
    return {
      structured: {
        ...base,
        ...uploadJobFields(active, mcpId, true),
        warnings: o.warnings,
        result: { upload: jobProgress(active), drive: o.driveInfo },
      },
      summary: `${label} đang được tải lên ở chế độ nền (${jobStatusLabel(active.status)}${progressText(active)}) - không tạo thêm lượt tải. Gọi ads_get_media_upload với upload_id ${active.id} để xem tiến độ.`,
    }
  }
  const details = [
    o.facts.size_mb !== null ? `${o.facts.size_mb} MB` : null,
    o.facts.width && o.facts.height
      ? `${o.facts.width}×${o.facts.height}`
      : null,
    o.facts.duration_s !== null ? `${o.facts.duration_s} giây` : null,
  ].filter(Boolean)
  // M-1: refuse BEFORE the 2-step confirm when a cap on active background uploads is reached (checked again, locked,
  // when the job is created)
  const limitHit = await uploadJobLimitHit(mcpId)
  if (limitHit) throw uploadLimitError(limitHit)
  const backgroundNote =
    "Video lớn: tải lên ở chế độ nền (có thể mất vài phút); sau khi xác nhận sẽ có upload_id để kiểm tra bằng ads_get_media_upload."
  // 2. new upload: 2-step confirm, then create + enqueue the job
  return runWrite(env, {
    args,
    account,
    pacingMaxWaitMs: pacedMediaWait(o.deadline),
    preview: async () => ({
      changes: [
        {
          object: args.name ?? o.facts.name,
          object_id: "-",
          level: null,
          field: "upload",
          before: null,
          after: `video từ ${o.from}${details.length ? ` (${details.join(", ")})` : ""} - tải nền`,
        },
      ],
      warnings: [...o.warnings, backgroundNote],
      effective_at: null,
      details: {
        drive_file_id: file.id,
        file_name: o.facts.name,
        source: o.from,
        mime: o.facts.mime,
        size_mb: o.facts.size_mb,
        width: o.facts.width,
        height: o.facts.height,
        duration_s: o.facts.duration_s,
        background: true,
      },
    }),
    execute: async () => {
      const { fileName, contentType } = await checkDriveVideo(
        env,
        r,
        o.deadline
      )
      const { job, existing } = await createUploadJob({
        mcpId,
        adAccountId: account.id,
        platform: account.platform,
        driveFileId: file.id,
        contentKey: r.contentKey!,
        sourceId: r.source?.id ?? null,
        access: r.access,
        resourceKey: r.resourceKey,
        fileName,
        contentType,
        sizeBytes: file.sizeBytes!,
        md5: file.md5,
        name: args.name ?? null,
      }).catch((e: unknown) => {
        if (isUploadJobLimitError(e)) throw uploadLimitError(e)
        throw e
      })
      // (re-)enqueue our own job (harmless for a job already queued); another MCP's job is left to that MCP
      if (job.mcpId === mcpId) {
        try {
          await enqueueVideoUpload(job.id)
        } catch {
          await updateUploadJob(job.id, {
            status: "failed",
            errorCode: "queue_unavailable",
            errorMessage: "Không đưa được video vào hàng đợi tải nền.",
          }).catch(() => {})
          throw new McpToolError({
            code: "upload_queue_unavailable",
            messageVi:
              "Không đưa được video vào hàng đợi tải nền (bộ xử lý nền chưa sẵn sàng).",
            hint: "Thử lại sau ít phút; nếu vẫn lỗi, báo quản trị viên kiểm tra worker.",
          })
        }
      }
      // an active job of ANOTHER MCP (same account + file version): its id is never handed out nor logged (T-7)
      const ownJob = job.mcpId === mcpId
      if (ownJob) env.log.addObjectIds([job.id])
      return {
        structured: {
          ...uploadJobFields(job, mcpId, existing),
          warnings: o.warnings,
          result: {
            ...(ownJob ? { upload: jobProgress(job) } : {}),
            drive: o.driveInfo,
          },
        },
        summary: !ownJob
          ? driveJobs.videoUpload.busyElsewhere
          : existing
            ? `${label} đang được tải lên ở chế độ nền từ trước - không tạo thêm lượt tải. Gọi ads_get_media_upload để xem tiến độ.`
            : `Đã đưa ${label} vào hàng đợi tải nền (có thể mất vài phút). Gọi ads_get_media_upload với upload_id ${job.id} để lấy media_id khi xong.`,
        changes: [
          {
            objectId: ownJob ? job.id : "-",
            field: "media_upload_queued",
            before: null,
            after: `Google Drive: ${o.facts.name} (${file.id})`,
          },
        ],
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Background uploads: shared with ads_get_media_upload
// ---------------------------------------------------------------------------

export function jobStatusLabel(status: UploadJobView["status"]): string {
  switch (status) {
    case "queued":
      return "đang chờ"
    case "uploading":
      return "đang tải lên"
    case "processing":
      return "nền tảng đang xử lý"
    case "done":
      return "xong"
    case "failed":
      return "lỗi"
  }
}

export function jobPercent(job: UploadJobView): number {
  if (job.status === "done" || job.status === "processing") return 100
  if (!(job.sizeBytes > 0)) return 0
  return Math.min(
    100,
    Math.max(0, Math.floor((job.uploadedBytes / job.sizeBytes) * 100))
  )
}

function progressText(job: UploadJobView): string {
  return job.status === "uploading" ? ` ${jobPercent(job)}%` : ""
}

/** Short Vietnamese text for a job error code (the worker normally stores its own Vietnamese message). */
export function jobErrorText(code: string | null): string {
  const c = code ?? ""
  const known: Record<string, string> = {
    mcp_unavailable: "MCP đã bị tắt, hết hạn hoặc bị xoá.",
    account_not_in_scope: "Tài khoản quảng cáo không còn thuộc MCP này.",
    drive_not_in_scope: "File không còn thuộc nguồn Drive được cấp cho MCP.",
    drive_unavailable: "Không đọc được file từ Google Drive.",
    file_changed:
      "File trên Drive đã bị thay đổi sau khi xác nhận - hãy tải lại.",
    unsupported: "Nền tảng không hỗ trợ tải video kiểu này.",
    interrupted: "Lượt tải bị gián đoạn (máy chủ khởi động lại) - hãy thử lại.",
    stale: "Lượt tải bị treo quá lâu nên đã dừng - hãy thử lại.",
    expired: "Lượt tải đã hết hạn - hãy thử lại.",
    queue_unavailable: "Không đưa được video vào hàng đợi tải nền.",
    internal: "Lỗi nội bộ khi tải video.",
  }
  if (known[c]) return known[c]
  if (c.startsWith("drive_")) return "Lỗi Google Drive khi tải video."
  if (c.startsWith("provider_"))
    return "Nền tảng quảng cáo từ chối hoặc lỗi khi nhận video."
  return "Tải lên thất bại."
}

/** progress of a job as returned to the AI (no secrets, no Drive link) */
export function jobProgress(job: UploadJobView) {
  return {
    upload_id: job.id,
    status: job.status,
    progress_percent: jobPercent(job),
    file_name: nameLabel(job.fileName),
    size_mb: Math.round((job.sizeBytes / 1024 / 1024) * 100) / 100,
    media_id: job.mediaId,
    error:
      job.errorCode || job.errorMessage
        ? {
            code: job.errorCode ?? "upload_failed",
            message: (job.errorMessage ?? jobErrorText(job.errorCode)).slice(
              0,
              500
            ),
          }
        : null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt,
  }
}

// ---------------------------------------------------------------------------
// ChatGPT-attached file (Apps SDK file params)
// ---------------------------------------------------------------------------

/** TelegramMediaError of the shared download path → a neutral media error (no Telegram wording). */
function chatgptMediaError(
  e: TelegramMediaError,
  maxBytes: number
): McpToolError {
  switch (e.code) {
    case "telegram_file_too_large":
      return invalid(
        "media_too_large",
        `Tệp đính kèm vượt ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        "Dùng ảnh nhỏ hơn."
      )
    case "telegram_file_type_not_allowed":
      return invalid(
        "media_wrong_type",
        "Tệp đính kèm không phải ảnh / video được hỗ trợ.",
        "Ảnh JPG/PNG/GIF/WebP, video MP4/MOV."
      )
    case "telegram_file_timeout":
      return new McpToolError({
        code: "media_timeout",
        messageVi: "Tải tệp đính kèm quá thời gian chờ.",
        hint: "Thử lại, hoặc dùng tệp nhỏ hơn.",
      })
    case "telegram_file_invalid":
      return invalid("media_empty", "Tệp đính kèm rỗng hoặc bị hỏng.")
    case "url_not_allowed":
      return invalid(
        "url_not_allowed",
        "Link tải tệp đính kèm không được phép."
      )
    case "telegram_busy":
      return new McpToolError({
        code: "media_busy",
        messageVi: "Máy chủ đang tải tệp khác, chưa nhận thêm được.",
        hint: "Thử lại sau vài giây.",
        logStatus: "rate_limited",
      })
    default:
      return new McpToolError({
        code: "media_unreachable",
        messageVi: "Không tải được tệp đính kèm từ ChatGPT.",
        hint: "Đính kèm lại tệp trên ChatGPT bản web (chatgpt.com) rồi thử lại.",
      })
  }
}

async function uploadChatgptFile(
  env: ToolEnv,
  provider: ReturnType<typeof providerFor>,
  account: GrantAccount,
  args: UploadArgs
): Promise<ToolOutcome> {
  const deadline = Date.now() + MEDIA_CALL_BUDGET_MS
  const file = args.file!
  const fileId = file.file_id.trim()
  if (!/^https:\/\//i.test(file.download_url) || !fileId) {
    const mobile = /chat_upload/i.test(file.download_url)
    throw invalid(
      "chatgpt_file_unavailable",
      mobile
        ? "ChatGPT gửi tham chiếu tệp kiểu chat_upload (lỗi đã biết của app ChatGPT trên điện thoại) thay vì tệp thật - không đọc được tệp."
        : "Không đọc được tệp đính kèm từ ChatGPT (thiếu link tải).",
      "Đính kèm lại tệp trên ChatGPT bản web (chatgpt.com), hoặc dùng drive_file / url công khai."
    )
  }
  const family =
    args.type ??
    mediaFamily(file.mime_type ?? "") ??
    familyFromName(file.file_name)
  if (!family)
    throw invalid(
      "type_required",
      "Không rõ tệp đính kèm là ảnh hay video.",
      'Truyền type "image" hoặc "video".'
    )
  const platform = account.platform
  if (
    family === "video" &&
    (platform === "google_ads" || platform === "openai_ads")
  )
    refuseVideo(platform)
  const label = nameLabel(file.file_name, "tệp đính kèm ChatGPT")
  // the download_url is re-issued by ChatGPT on every call: the confirmation is bound to the file id, not the link
  const hashArgs = {
    ...args,
    file: {
      file_id: fileId,
      file_name: file.file_name,
      mime_type: file.mime_type,
    },
  }

  if (family === "video") {
    // SSRF guard + size/type probe on both steps; the platform downloads the (signed) link itself
    const probe = await probeMedia(file.download_url, "video", env.signal)
    if (
      probe.contentLength !== null &&
      probe.contentLength > MEDIA_LIMITS.video.maxBytes
    )
      throw videoTooLarge(probe.contentLength)
    // the platform downloads the link within this call (no background path for attachments): own cap (D6)
    const relayMax = CHATGPT_VIDEO_MAX_BYTES[platform] ?? 0
    if (probe.contentLength !== null && probe.contentLength > relayMax) {
      throw invalid(
        "media_too_large",
        `Video đính kèm ${mb(probe.contentLength)} quá lớn để gửi thẳng lên ${platformLabel(platform)} (tối đa ${Math.round(relayMax / 1024 / 1024)} MB qua tệp đính kèm).`,
        "Đưa video lên Google Drive (thư mục được cấp cho MCP hoặc link công khai) rồi dùng drive_file - video lớn sẽ được tải ở chế độ nền."
      )
    }
    const videoWarnings =
      probe.contentLength === null
        ? [
            ...probe.warnings,
            `Không rõ dung lượng video - nếu lớn hơn ${Math.round(relayMax / 1024 / 1024)} MB, ${platformLabel(platform)} có thể không tải kịp; khi đó hãy dùng Google Drive.`,
          ]
        : probe.warnings
    return runWrite(env, {
      args: hashArgs,
      account,
      pacingMaxWaitMs: pacedMediaWait(deadline),
      preview: async () => ({
        changes: [
          {
            object: args.name ?? label,
            object_id: "-",
            level: null,
            field: "upload",
            before: null,
            after: `video từ tệp đính kèm ChatGPT (${probe.contentLength !== null ? mb(probe.contentLength) : "không rõ dung lượng"})`,
          },
        ],
        warnings: videoWarnings,
        effective_at: null,
        details: {
          source: "chatgpt_file",
          file_name: label,
          content_type: probe.contentType,
          bytes: probe.contentLength,
        },
      }),
      execute: async () => {
        const ext =
          fileTypeByMime.get((probe.contentType ?? "").toLowerCase())?.ext ??
          "mp4"
        const ctx = await env.providerCtx(account)
        const media = await provider.uploadMedia(ctx, {
          type: "video",
          url: probe.finalUrl,
          name: args.name,
          fileName: sanitizeFileName(file.file_name, ext),
          deadlineAt: videoDeadline(deadline),
        })
        env.log.addObjectIds([media.id])
        return {
          structured: {
            warnings: media.recovered
              ? [...videoWarnings, RECOVERED_NOTE(media.id)]
              : videoWarnings,
            processing: media.processing === true,
            ...(media.recovered ? { recovered: true } : {}),
            result: mediaResult(platform, media),
          },
          summary: uploadedSummary(media, `video "${label}"`),
          changes: [
            {
              objectId: media.id,
              field: "media_uploaded",
              before: null,
              after: `ChatGPT: ${label}`,
            },
          ],
        }
      },
    })
  }

  const rule = imageRule(platform)
  const imageWarnings: string[] = []
  return runWrite(env, {
    args: hashArgs,
    account,
    pacingMaxWaitMs: pacedMediaWait(deadline),
    preview: async () => ({
      changes: [
        {
          object: args.name ?? label,
          object_id: "-",
          level: null,
          field: "upload",
          before: null,
          after: "ảnh từ tệp đính kèm ChatGPT",
        },
      ],
      warnings: [],
      effective_at: null,
      details: {
        source: "chatgpt_file",
        file_name: label,
        mime: file.mime_type ?? null,
      },
    }),
    execute: async () => {
      const media = await withUploadSlot(env.grant.mcpId, async () => {
        let prepared
        try {
          prepared = await prepareAttachment(
            {
              type: "chatgpt",
              downloadUrl: file.download_url,
              fileId,
              mimeType: file.mime_type,
              fileName: file.file_name,
            },
            {
              sendAs: "document",
              signal: env.signal,
              timeouts: {
                totalMs: Math.max(
                  1_000,
                  deadline - Date.now() - MEDIA_UPLOAD_RESERVE_MS
                ),
              },
            }
          )
        } catch (e) {
          if (isTelegramMediaError(e)) throw chatgptMediaError(e, rule.maxBytes)
          throw e
        }
        if (!prepared.mime.startsWith("image/")) {
          throw invalid(
            "media_wrong_type",
            "Tệp đính kèm không phải ảnh.",
            'Với video, truyền type "video".'
          )
        }
        if (!rule.mimes.has(prepared.mime)) throw wrongImageType(platform)
        if (prepared.sizeBytes > rule.maxBytes)
          throw imageTooLarge(platform, prepared.sizeBytes)
        const big = tiktokImageWarning(platform, prepared.sizeBytes)
        if (big) imageWarnings.push(big)
        const ctx = await env.providerCtx(account)
        return provider.uploadMedia(ctx, {
          type: "image",
          // informational only: adapters use the bytes; never the signed download link
          url: "https://chatgpt.com/",
          name: args.name,
          bytes: new Uint8Array(
            prepared.bytes.buffer,
            prepared.bytes.byteOffset,
            prepared.bytes.byteLength
          ),
          contentType: prepared.mime,
          fileName: prepared.fileName,
        })
      })
      env.log.addObjectIds([media.id])
      return {
        structured: {
          warnings: imageWarnings,
          result: mediaResult(platform, media),
        },
        summary: uploadedSummary(media, `ảnh "${label}"`),
        changes: [
          {
            objectId: media.id,
            field: "media_uploaded",
            before: null,
            after: `ChatGPT: ${label}`,
          },
        ],
      }
    },
  })
}

function familyFromName(name: string | undefined): "image" | "video" | null {
  const ext = /\.([A-Za-z0-9]{2,5})$/.exec(name ?? "")?.[1]?.toLowerCase()
  if (!ext) return null
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image"
  if (["mp4", "mov", "m4v"].includes(ext)) return "video"
  return null
}
