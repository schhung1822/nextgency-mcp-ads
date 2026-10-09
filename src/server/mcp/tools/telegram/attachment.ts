// Attachments of telegram_send_message (14-telegram-notifications.md §10.2): input schema of the three file sources
// (file_url | ChatGPT `file` | file_content), the exactly-one-source / caption rules, the dedupe key of ChatGPT
// files, logged args and the mapping of media / send errors to tool errors. Downloading, sniffing and uploading live
// in src/server/notifications (media.ts, deliver.ts). No "next/*" imports.
import { createHash } from "node:crypto"
import { z } from "zod"
import { notifications as nm } from "../../../../lib/i18n/vi/notifications"
import {
  formatFileSize,
  MEDIA_DOWNLOAD,
  TELEGRAM_CAPTION_TEXT_MAX,
  TELEGRAM_TEXT_FILE_MAX_BYTES,
  type AttachmentSource,
  type OutgoingMediaKind,
  type SendAs,
  type TelegramMediaError,
} from "../../../notifications/media"
import type { SendNowResult } from "../../../notifications/deliver"
import { TELEGRAM_UPLOAD_TIMEOUT_MS } from "../../../notifications/telegram"
import { invalid, McpToolError } from "../../errors"
import { stripMediaUrlQueries } from "../../log-args"

/**
 * Whole media path (slot wait + download + upload) per call: ChatGPT cuts a tool call at 60 s, so a slow source or
 * a big file ends with a clear error before that instead of a hung client.
 */
export const MEDIA_CALL_BUDGET_MS = 50_000
/** kept for the Telegram upload when the download starts (the download gets at most the rest, ≤ 25 s) */
export const MEDIA_UPLOAD_RESERVE_MS = 15_000
/** ChatGPT duplicate calls (same file_id, new download_url) inside this bucket are sent once */
export const CHATGPT_DEDUPE_BUCKET_MS = 2 * 60_000

const SEND_AS = ["auto", "photo", "video", "document"] as const

/**
 * ChatGPT file object (`_meta["openai/fileParams"]`): all 4 properties declared, download_url + file_id required,
 * no other property. The ChatGPT mobile apps send a string ("chat_upload://image_0") instead of the object: it is
 * let through (as an object whose download_url is that string) so the handler answers with a clear error rather
 * than a schema error.
 */
const chatgptFile = z
  .object({
    download_url: z
      .string()
      .max(4_096)
      .describe("Link tải tạm thời do ChatGPT cấp"),
    file_id: z.string().max(256).describe("Mã tệp ChatGPT"),
    mime_type: z
      .string()
      .max(200)
      .optional()
      .describe("Loại tệp (nếu ChatGPT gửi)"),
    file_name: z
      .string()
      .max(255)
      .optional()
      .describe("Tên tệp (nếu ChatGPT gửi)"),
  })
  .strict()

export const fileInput = z
  .preprocess(
    (v) =>
      typeof v === "string"
        ? { download_url: v.slice(0, 4_096), file_id: "" }
        : v,
    chatgptFile
  )
  .optional()
  .describe(
    "Tệp người dùng đính kèm trong ChatGPT (ChatGPT tự điền). Không dùng cùng file_url / file_content."
  )

export const attachmentInputShape = {
  file_url: z
    .string()
    .trim()
    .max(2_048)
    .optional()
    .describe(
      "Link https công khai tải trực tiếp được ảnh / video / tệp (máy chủ tự tải về rồi gửi lên Telegram)"
    ),
  file: fileInput,
  file_content: z
    .string()
    .max(TELEGRAM_TEXT_FILE_MAX_BYTES)
    .optional()
    .describe(
      "Nội dung tệp chữ do AI tự viết (báo cáo CSV/TSV/TXT/MD/JSON, UTF-8, ≤ 256 KB); cần file_name có đuôi phù hợp"
    ),
  file_name: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe(
      'Tên tệp, vd "bao-cao-chi-tieu.csv" (bắt buộc với file_content; với file_url / file thì thay tên gốc)'
    ),
  send_as: z
    .enum(SEND_AS)
    .optional()
    .describe(
      "auto (mặc định): ảnh ≤ 10 MB gửi dạng ảnh, video MP4 dạng video, còn lại dạng tệp; photo / video / document = ép kiểu gửi"
    ),
}

export interface AttachmentArgs {
  text?: string
  file_url?: string
  file?: {
    download_url: string
    file_id: string
    mime_type?: string
    file_name?: string
  }
  file_content?: string
  file_name?: string
  send_as?: SendAs
}

export interface AttachmentPlan {
  source: AttachmentSource
  sendAs: SendAs
  /** ChatGPT files only: `cgf:<mcpId>:<sha256(file_id) 32 hex>:<2-minute bucket>` */
  dedupeKey: string | null
}

/**
 * ChatGPT re-sends the same file_id (with another download_url) on a duplicate call: one delivery per MCP, file and
 * 2-minute bucket. The file id is hashed (fixed length, nothing the client chose ends up in the key as-is).
 */
export function chatgptDedupeKey(
  mcpId: string,
  fileId: string,
  now = Date.now()
): string {
  const h = createHash("sha256").update(fileId).digest("hex").slice(0, 32)
  return `cgf:${mcpId}:${h}:${Math.floor(now / CHATGPT_DEDUPE_BUCKET_MS)}`
}

/**
 * The exactly-one-source rule + text rules (§10.2). Returns null for a text-only message (behaves as before).
 * Throws invalid_request tool errors in Vietnamese.
 */
export function planAttachment(
  args: AttachmentArgs,
  ctx: { mcpId?: string; now?: number } = {}
): AttachmentPlan | null {
  const now = ctx.now ?? Date.now()
  const text = args.text?.trim() ?? ""
  const fileUrl = args.file_url?.trim() || null
  const sources = [
    fileUrl !== null,
    args.file !== undefined,
    args.file_content !== undefined,
  ].filter(Boolean).length
  if (sources > 1) {
    throw invalid(
      "attachment_conflict",
      "Mỗi tin chỉ gửi kèm được 1 tệp: chọn đúng một trong file_url, file hoặc file_content.",
      "Gửi từng tệp bằng một lần gọi riêng (mỗi lần = 1 tin trong giới hạn tin/giờ)."
    )
  }
  if (sources === 0) {
    if (args.file_name) {
      throw invalid(
        "attachment_missing",
        "Có file_name nhưng không có tệp đính kèm.",
        "file_name chỉ dùng kèm file_content, file_url hoặc file."
      )
    }
    if (!text) {
      throw invalid(
        "text_required",
        "Thiếu nội dung tin (text).",
        "Nhập text (1-3.500 ký tự) hoặc gửi kèm một tệp."
      )
    }
    return null
  }
  if (text.length > TELEGRAM_CAPTION_TEXT_MAX) {
    throw invalid(
      "caption_too_long",
      `Khi gửi kèm tệp, text là chú thích và tối đa ${TELEGRAM_CAPTION_TEXT_MAX} ký tự (hiện ${text.length}).`,
      "Rút gọn chú thích, hoặc gửi nội dung dài bằng một tin chữ riêng (không kèm tệp)."
    )
  }
  const sendAs = args.send_as ?? "auto"
  const fileName = args.file_name?.trim() || undefined
  if (args.file_content !== undefined) {
    if (!fileName) {
      throw invalid(
        "file_name_required",
        "file_content cần file_name có đuôi .csv, .tsv, .txt, .md hoặc .json.",
        'Đặt file_name, vd "bao-cao.csv".'
      )
    }
    return {
      source: { type: "text", content: args.file_content, fileName },
      sendAs,
      dedupeKey: null,
    }
  }
  if (fileUrl !== null) {
    return {
      source: { type: "url", url: fileUrl, ...(fileName ? { fileName } : {}) },
      sendAs,
      dedupeKey: null,
    }
  }
  const file = args.file!
  if (!/^https:\/\//i.test(file.download_url) || !file.file_id.trim()) {
    const mobile = /chat_upload/i.test(file.download_url)
    throw invalid(
      "chatgpt_file_unavailable",
      mobile
        ? "ChatGPT gửi tham chiếu tệp kiểu chat_upload (lỗi đã biết của app ChatGPT trên điện thoại) thay vì tệp thật - không đọc được tệp."
        : "Không đọc được tệp đính kèm từ ChatGPT (thiếu link tải).",
      "Đính kèm lại tệp trên ChatGPT bản web (chatgpt.com), hoặc dùng file_url với link https công khai."
    )
  }
  const fileId = file.file_id.trim()
  return {
    source: {
      type: "chatgpt",
      downloadUrl: file.download_url,
      fileId,
      ...(file.mime_type ? { mimeType: file.mime_type } : {}),
      ...((fileName ?? file.file_name)
        ? { fileName: fileName ?? file.file_name }
        : {}),
    },
    sendAs,
    dedupeKey: chatgptDedupeKey(ctx.mcpId ?? "-", fileId, now),
  }
}

/** Logged / stored args: no signed download_url, no URL query string, no file body. */
export function attachmentLogArgs<A extends AttachmentArgs>(
  args: A
): Record<string, unknown> {
  const out = { ...args } as Record<string, unknown>
  if (args.file_url !== undefined)
    out.file_url = stripMediaUrlQueries({ file_url: args.file_url }).file_url
  if (args.file !== undefined)
    out.file = { ...args.file, download_url: "[redacted]" }
  if (args.file_content !== undefined)
    out.file_content = `${args.file_content.length} ký tự`
  return out
}

/** Download budget left once the slot is taken: ≤ 25 s, and never eating the upload's share. */
export function downloadBudgetMs(deadline: number, now = Date.now()): number {
  return Math.max(
    1_000,
    Math.min(MEDIA_DOWNLOAD.totalMs, deadline - now - MEDIA_UPLOAD_RESERVE_MS)
  )
}

/** Upload budget left: ≤ 30 s (Telegram upload timeout), at least 1 s. */
export function uploadBudgetMs(deadline: number, now = Date.now()): number {
  return Math.max(1_000, Math.min(TELEGRAM_UPLOAD_TIMEOUT_MS, deadline - now))
}

/** TelegramMediaError (download / sniffing / slot) → tool error {code, message, hint}. */
export function mediaToolError(e: TelegramMediaError): McpToolError {
  return new McpToolError({
    code: e.code,
    messageVi: e.userMessageVi,
    hint: e.hintVi ?? undefined,
    logStatus: e.code === "telegram_busy" ? "rate_limited" : "error",
  })
}

/** A failed sendChannelMessageNow → tool error. Text-only failures (media false) keep their historical codes. */
export function sendFailureError(
  r: Extract<SendNowResult, { ok: false }>,
  o: { media?: boolean; deadlinePassed?: boolean } = {}
): McpToolError {
  if (r.kind === "channel_unavailable") {
    return new McpToolError({
      code: "channel_unavailable",
      messageVi: r.error,
      hint: "Kênh đang tắt hoặc lỗi cấu hình - chủ kênh kiểm tra lại ở trang Kết nối → Telegram.",
    })
  }
  if (r.kind === "duplicate") {
    // the earlier call is still sending: never claim it was sent
    return new McpToolError({
      code: "telegram_duplicate",
      messageVi: r.error,
      hint: "Đợi khoảng 1 phút rồi kiểm tra nhóm Telegram; chỉ gọi lại khi tin chưa xuất hiện.",
    })
  }
  if (o.media && r.kind === "file_too_large") {
    return new McpToolError({
      code: "telegram_file_too_large",
      messageVi: r.error,
      hint: nm.media.errors.telegram_file_too_large.hint,
    })
  }
  if (
    o.media &&
    (r.kind === "timeout" || (o.deadlinePassed && r.kind === "network"))
  ) {
    // the upload was cut while in flight: Telegram may still have posted it
    return new McpToolError({
      code: "telegram_file_timeout",
      messageVi: nm.media.uploadUncertain,
      hint: nm.media.uploadUncertainHint,
    })
  }
  return new McpToolError({
    code: "telegram_send_failed",
    messageVi: r.error,
    hint: "Tin chưa được gửi. Có thể thử lại sau; nếu lỗi lặp lại, chủ kênh kiểm tra bot và nhóm Telegram.",
  })
}

/** "Ảnh a.jpg (1,2 MB) + 12 ký tự" - the `changes` after-value of a media send. */
export function attachmentChangeLabel(
  media: { kind: OutgoingMediaKind; fileName: string; sizeBytes: number },
  captionChars: number
): string {
  return `${nm.media.kinds[media.kind]} ${media.fileName} (${formatFileSize(media.sizeBytes)}) + ${captionChars} ký tự`
}
