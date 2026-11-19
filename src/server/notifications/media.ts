// Attachments of telegram_send_message (14-telegram-notifications.md §10.2-§10.3): download a public https URL or
// a file the user attached in ChatGPT through the SSRF guard (or take a text file the AI wrote), allow only a short
// list of file types recognised by their MAGIC BYTES (never the Content-Type / extension; Office files by the
// names in the ZIP central directory - nothing is decompressed), choose photo / video / document and sanitise the
// file name. Bytes stay in memory (never on disk). No "next/*" imports.
// URLs - ChatGPT download URLs are signed bearer links - are never logged nor put in an error message.
import { formatNumber } from "@/lib/format"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import { redactString } from "@/server/audit/redact"
import { McpToolError } from "@/server/mcp/errors"
import {
  detectFileType as detectAllowedFileType,
  extOf,
  FILE_TYPES as T,
  isMediaTypeError,
  isTextExt,
  zipEntryNames,
  type FileFamily,
  type FileType,
} from "@/server/net/media-type"
import {
  isMediaBusyError,
  MEDIA_SLOTS,
  withMediaSlot as withSharedMediaSlot,
} from "@/server/net/media-slots"
import { assertPublicUrlSyntax, safeFetch } from "@/server/net/ssrf"

// File-type detection and the media semaphore live in src/server/net (shared with Google Drive); re-exported here
// so the Telegram API is unchanged.
export { MEDIA_SLOTS, zipEntryNames, type FileFamily, type FileType }

export type OutgoingMediaKind = "photo" | "video" | "document"

export interface OutgoingMedia {
  kind: OutgoingMediaKind
  bytes: Buffer
  /** sanitised, extension matching the sniffed type */
  fileName: string
  /** sniffed type */
  mime: string
  sizeBytes: number
}

export type SendAs = "auto" | "photo" | "video" | "document"

export type AttachmentSource =
  /** fileName (optional, the tool's file_name) wins over the URL's last path segment */
  | { type: "url"; url: string; fileName?: string }
  | {
      type: "chatgpt"
      downloadUrl: string
      fileId: string
      mimeType?: string
      fileName?: string
    }
  | { type: "text"; content: string; fileName: string }

export type TelegramMediaErrorCode =
  | "telegram_file_fetch_failed"
  | "telegram_file_too_large"
  | "telegram_file_type_not_allowed"
  | "telegram_file_timeout"
  | "telegram_file_invalid"
  | "telegram_busy"
  | "url_not_allowed"

/** Vietnamese message + hint (i18n), never the URL. */
export class TelegramMediaError extends Error {
  readonly code: TelegramMediaErrorCode
  readonly userMessageVi: string
  readonly hintVi: string | null

  constructor(
    code: TelegramMediaErrorCode,
    override: { message?: string; hint?: string | null } = {}
  ) {
    const d = m.media.errors[code]
    super(`telegram media ${code}`)
    this.name = "TelegramMediaError"
    this.code = code
    this.userMessageVi = override.message ?? d.message
    this.hintVi = override.hint !== undefined ? override.hint : d.hint
  }
}

export function isTelegramMediaError(e: unknown): e is TelegramMediaError {
  return e instanceof TelegramMediaError
}

/** AI caption characters when a file is attached (Telegram caption 1024 = title + caption + credit footer) */
export const TELEGRAM_CAPTION_TEXT_MAX = 800
/** text file written by the AI (file_content) */
export const TELEGRAM_TEXT_FILE_MAX_BYTES = 256 * 1024
/** Bot API multipart upload limit (any file) */
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
/** Bot API limit for sendPhoto */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024
/** download budget (ChatGPT cuts a tool call at 60 s): overall deadline, socket idle timeout, redirects */
export const MEDIA_DOWNLOAD = {
  totalMs: 25_000,
  idleMs: 10_000,
  maxRedirects: 3,
} as const
const FILE_STEM_MAX = 64

// ---------------------------------------------------------------------------
// File types (allowlist: src/server/net/media-type.ts)
// ---------------------------------------------------------------------------

/**
 * Allowlisted type of a downloaded file from its bytes; text types (no magic bytes) need a csv/tsv/txt/md/json
 * hint (name or mime) AND valid UTF-8 without NUL. Throws telegram_file_type_not_allowed for anything else.
 */
export function detectFileType(
  b: Buffer,
  hint: { name?: string | null; mime?: string | null } = {}
): FileType {
  try {
    return detectAllowedFileType(b, hint)
  } catch (e) {
    if (!isMediaTypeError(e)) throw e
    if (e.reason === "macro")
      throw new TelegramMediaError("telegram_file_type_not_allowed", {
        message: m.media.macro,
        hint: m.media.macroHint,
      })
    if (e.reason === "office_embedded")
      throw new TelegramMediaError("telegram_file_type_not_allowed", {
        message: m.media.officeEmbedded,
        hint: m.media.officeEmbeddedHint,
      })
    if (e.reason === "markup")
      throw new TelegramMediaError("telegram_file_type_not_allowed", {
        message: m.media.markup,
      })
    throw new TelegramMediaError("telegram_file_type_not_allowed")
  }
}

// ---------------------------------------------------------------------------
// photo / video / document
// ---------------------------------------------------------------------------

const notPhoto = () =>
  new TelegramMediaError("telegram_file_type_not_allowed", {
    message: m.media.notPhoto,
    hint: m.media.sendAsHint,
  })
const notVideo = () =>
  new TelegramMediaError("telegram_file_type_not_allowed", {
    message: m.media.notVideo,
    hint: m.media.sendAsHint,
  })

/**
 * auto: JPEG/PNG/WebP ≤ 10 MB → photo (GIF → document: sendPhoto would drop the animation; > 10 MB → document);
 * MP4 → video; MOV and everything else → document. An explicit photo / video the file cannot be → error.
 */
export function resolveMediaKind(
  type: FileType,
  sizeBytes: number,
  sendAs: SendAs
): OutgoingMediaKind {
  if (type.family === "image") {
    if (sendAs === "video") throw notVideo()
    if (sendAs === "document") return "document"
    if (sendAs === "photo") {
      if (sizeBytes > TELEGRAM_PHOTO_MAX_BYTES)
        throw new TelegramMediaError("telegram_file_too_large", {
          message: m.media.photoTooLarge,
          hint: m.media.sendAsHint,
        })
      return "photo"
    }
    return type.ext === "gif" || sizeBytes > TELEGRAM_PHOTO_MAX_BYTES
      ? "document"
      : "photo"
  }
  if (sendAs === "photo") throw notPhoto()
  if (type.family === "video") {
    if (sendAs === "document") return "document"
    if (type.ext !== "mp4") {
      if (sendAs === "video") throw notVideo()
      return "document"
    }
    return "video"
  }
  if (sendAs === "video") throw notVideo()
  return "document"
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** tep-YYYYMMDD-HHmm in Vietnam time */
function fallbackStem(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  )
  return `${m.media.fallbackFileStem}-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`
}

/**
 * NFC (Telegram would drop NFD diacritics), no control / bidi / zero-width characters, none of / \ : * ? " < > |
 * nor % (the Bot API url-decodes file names), stem ≤ 64 characters, extension = the sniffed type (a wrong or
 * missing one is replaced). Empty → tep-<YYYYMMDD-HHmm>.
 */
export function sanitizeFileName(
  raw: string | null | undefined,
  ext: string,
  now: Date = new Date()
): string {
  let s = redactString(String(raw ?? "")).normalize("NFC")
  s = s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[\\/:*?"<>|%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/^[.\s]+|[.\s]+$/g, "")
  const stem = Array.from(s).slice(0, FILE_STEM_MAX).join("").trim()
  return `${stem || fallbackStem(now)}.${ext}`
}

/** last path segment of a URL, decoded (no query / fragment) */
function urlFileName(raw: string): string | null {
  try {
    const seg = new URL(raw).pathname.split("/").filter(Boolean).pop()
    if (!seg) return null
    try {
      return decodeURIComponent(seg)
    } catch {
      return seg
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Text files written by the AI (file_content)
// ---------------------------------------------------------------------------

/**
 * Cell boundaries for formula neutralisation, whatever the file's delimiter: Excel splits a CSV on "," or ";"
 * depending on the locale (Vietnamese Windows: ";"), and on tab / CR / LF - so every one of them outside double
 * quotes starts a new cell (a lone CR too).
 */
const CELL_BOUNDARY = new Set([",", ";", "\t", "\r", "\n"])
/** a plain number (+84901, -5, 1.234,5, -12%): the only cells allowed to start with + or - */
const PLAIN_NUMBER = /^[ \u00a0]*[+-]?\d[\d.,]*%?[ \u00a0]*$/

/** a cell a spreadsheet could run as a formula: = @ (after spaces), + / - unless a plain number, tab / CR / LF */
function isDangerousCell(cell: string): boolean {
  const first = cell[0]
  if (first === "\t" || first === "\r" || first === "\n") return true
  const c = cell.replace(/^[ \u00a0]+/, "")[0]
  if (c === "=" || c === "@") return true
  if (c === "+" || c === "-") return !PLAIN_NUMBER.test(cell)
  return false
}

/**
 * CSV / TSV formula injection: prefix every dangerous cell with ' (a quoted cell keeps its quotes: "'=…").
 * Boundaries are , ; tab CR LF outside double quotes, for any delimiter (see CELL_BOUNDARY).
 */
export function neutralizeFormulas(text: string): string {
  const n = text.length
  let out = ""
  let i = 0
  for (;;) {
    if (text[i] === '"') {
      // quoted cell: up to the closing quote ("" is an escaped quote)
      let j = i + 1
      while (j < n && !(text[j] === '"' && text[j + 1] !== '"'))
        j += text[j] === '"' ? 2 : 1
      j = Math.min(j, n)
      const content = text.slice(i + 1, j)
      out += `"${isDangerousCell(content) ? "'" : ""}${content}`
      i = j
    } else {
      let j = i
      while (j < n && !CELL_BOUNDARY.has(text[j]!)) j++
      const cell = text.slice(i, j)
      out += `${isDangerousCell(cell) ? "'" : ""}${cell}`
      i = j
    }
    // the closing quote and anything after it up to the next boundary (malformed CSV) stay as they are
    while (i < n && !CELL_BOUNDARY.has(text[i]!)) out += text[i++]
    if (i >= n) return out
    out += text[i++]
  }
}

function prepareTextFile(
  content: string,
  fileName: string,
  sendAs: SendAs,
  now: Date
): OutgoingMedia {
  const ext = extOf(fileName)
  if (!isTextExt(ext))
    throw new TelegramMediaError("telegram_file_type_not_allowed", {
      message: m.media.textExtension,
      hint: m.media.textExtensionHint,
    })
  if (sendAs === "photo") throw notPhoto()
  if (sendAs === "video") throw notVideo()
  if (!content.trim() || content.includes("\u0000"))
    throw new TelegramMediaError("telegram_file_invalid", {
      message: m.media.textInvalid,
    })
  if (Buffer.byteLength(content, "utf8") > TELEGRAM_TEXT_FILE_MAX_BYTES)
    throw new TelegramMediaError("telegram_file_too_large", {
      message: m.media.textTooLarge,
      hint: m.media.textTooLargeHint,
    })
  // a token / key the AI copied never reaches the chat
  let text = redactString(content)
  if (ext === "csv" || ext === "tsv") {
    text = text.replace(/^\uFEFF/, "")
    // BOM: Excel then reads Vietnamese (UTF-8) correctly
    text = `\uFEFF${neutralizeFormulas(text)}`
  }
  const type = T[ext]
  const bytes = Buffer.from(text, "utf8")
  return {
    kind: "document",
    bytes,
    fileName: sanitizeFileName(fileName, type.ext, now),
    mime: type.mime,
    sizeBytes: bytes.length,
  }
}

// ---------------------------------------------------------------------------
// Download (SSRF-guarded)
// ---------------------------------------------------------------------------

/** tests (flows): replaces the guarded downloader when no fetchImpl is passed; null = production path */
let mediaFetchOverride: typeof fetch | null = null
export function setMediaFetchImpl(f: typeof fetch | null): void {
  // never in a running server: the injected path has no DNS pinning
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST)
    throw new Error("setMediaFetchImpl is test-only")
  mediaFetchOverride = f
}

interface Downloaded {
  bytes: Buffer
  contentType: string | null
}

interface DownloadTimeouts {
  totalMs: number
  idleMs: number
}

/** ssrf.ts errors (McpToolError) → TelegramMediaError; the ssrf message names the reason, never the URL */
function fromGuardError(e: unknown): TelegramMediaError {
  if (e instanceof TelegramMediaError) return e
  if (e instanceof McpToolError) {
    if (e.code === "url_not_allowed")
      return new TelegramMediaError("url_not_allowed", { message: e.messageVi })
    if (e.code === "media_too_large")
      return new TelegramMediaError("telegram_file_too_large")
    if (e.code === "media_timeout")
      return new TelegramMediaError("telegram_file_timeout")
    if (e.code === "too_many_redirects")
      return new TelegramMediaError("telegram_file_fetch_failed", {
        message: m.media.tooManyRedirects,
      })
  }
  return new TelegramMediaError("telegram_file_fetch_failed")
}

const statusError = (status: number) =>
  new TelegramMediaError("telegram_file_fetch_failed", {
    message: m.media.fetchFailedStatus(status),
  })

function headerValue(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null
}

/** Production: node http(s) with DNS pinning + re-check of every redirect (safeFetch), https only. */
async function downloadGuarded(
  raw: string,
  t: DownloadTimeouts,
  signal?: AbortSignal
): Promise<Downloaded> {
  let res
  try {
    res = await safeFetch(raw, {
      method: "GET",
      readBody: true,
      httpsOnly: true,
      maxBytes: TELEGRAM_UPLOAD_MAX_BYTES,
      maxRedirects: MEDIA_DOWNLOAD.maxRedirects,
      timeoutMs: t.idleMs,
      totalTimeoutMs: t.totalMs,
      signal,
    })
  } catch (e) {
    throw fromGuardError(e)
  }
  if (res.status < 200 || res.status >= 300 || !res.body)
    throw statusError(res.status)
  return {
    bytes: res.body,
    contentType: headerValue(res.headers["content-type"]),
  }
}

/** settle `p` unless the stream stays idle for `idleMs` or the overall deadline passes */
function within<T>(
  p: Promise<T>,
  idleMs: number,
  deadline: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => {
      cleanup()
      reject(new TelegramMediaError("telegram_file_timeout"))
    }
    const timer = setTimeout(fail, idleMs)
    const cleanup = () => {
      clearTimeout(timer)
      deadline.removeEventListener("abort", fail)
    }
    if (deadline.aborted) return fail()
    deadline.addEventListener("abort", fail, { once: true })
    p.then(
      (v) => {
        cleanup()
        resolve(v)
      },
      (e: unknown) => {
        cleanup()
        reject(e)
      }
    )
  })
}

/**
 * Injected fetch (tests / flows): the same rules without DNS pinning - https only, public host / IP literal,
 * manual redirects (≤ 3, each re-checked), size cap while streaming, idle + overall timeouts.
 */
async function downloadWithFetch(
  raw: string,
  f: typeof fetch,
  t: DownloadTimeouts,
  signal?: AbortSignal
): Promise<Downloaded> {
  const deadline = AbortSignal.timeout(t.totalMs)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  let url = raw
  for (let hop = 0; ; hop++) {
    let target: URL
    try {
      target = assertPublicUrlSyntax(url, { httpsOnly: true }).url
    } catch (e) {
      throw fromGuardError(e)
    }
    let res: Response
    try {
      res = await within(
        f(target.toString(), {
          method: "GET",
          redirect: "manual",
          signal: combined,
          headers: { "user-agent": "ads-mcp-nextgency/1.0 (+media-fetch)" },
        }),
        t.idleMs,
        deadline
      )
    } catch (e) {
      if (e instanceof TelegramMediaError) throw e
      throw new TelegramMediaError(
        deadline.aborted
          ? "telegram_file_timeout"
          : "telegram_file_fetch_failed"
      )
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location")
      void res.body?.cancel().catch(() => {})
      if (!location) throw statusError(res.status)
      if (hop >= MEDIA_DOWNLOAD.maxRedirects)
        throw new TelegramMediaError("telegram_file_fetch_failed", {
          message: m.media.tooManyRedirects,
        })
      try {
        url = new URL(location, target).toString()
      } catch {
        // an unparsable Location: no TypeError (which would carry the URL) escapes
        throw new TelegramMediaError("telegram_file_fetch_failed")
      }
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      void res.body?.cancel().catch(() => {})
      throw statusError(res.status)
    }
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > TELEGRAM_UPLOAD_MAX_BYTES) {
      void res.body?.cancel().catch(() => {})
      throw new TelegramMediaError("telegram_file_too_large")
    }
    const chunks: Buffer[] = []
    let size = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const r = await within(reader.read(), t.idleMs, deadline)
          if (r.done) break
          size += r.value.byteLength
          if (size > TELEGRAM_UPLOAD_MAX_BYTES)
            throw new TelegramMediaError("telegram_file_too_large")
          // a view, not a copy (Buffer.concat below makes the one copy)
          chunks.push(
            Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength)
          )
        }
      } catch (e) {
        void reader.cancel().catch(() => {})
        if (e instanceof TelegramMediaError) throw e
        throw new TelegramMediaError(
          deadline.aborted
            ? "telegram_file_timeout"
            : "telegram_file_fetch_failed"
        )
      }
    }
    return {
      bytes: Buffer.concat(chunks, size),
      contentType: res.headers.get("content-type"),
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Turn one attachment source into the file to upload: download (https, SSRF guard, ≤ 50 MB, ≤ 25 s, idle 10 s,
 * ≤ 3 redirects) or build the text file, check the type by magic bytes, pick photo / video / document, sanitise
 * the name (file_name → ChatGPT file_name → URL path → tep-<date>). Throws TelegramMediaError only.
 */
export async function prepareAttachment(
  src: AttachmentSource,
  opts: {
    sendAs: SendAs
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    now?: Date
    /** tests: shorter download timeouts */
    timeouts?: Partial<DownloadTimeouts>
  }
): Promise<OutgoingMedia> {
  const now = opts.now ?? new Date()
  if (src.type === "text")
    return prepareTextFile(src.content, src.fileName, opts.sendAs, now)
  const url = src.type === "url" ? src.url : src.downloadUrl
  const t: DownloadTimeouts = {
    totalMs: opts.timeouts?.totalMs ?? MEDIA_DOWNLOAD.totalMs,
    idleMs: opts.timeouts?.idleMs ?? MEDIA_DOWNLOAD.idleMs,
  }
  const f = opts.fetchImpl ?? mediaFetchOverride
  const dl = f
    ? await downloadWithFetch(url, f, t, opts.signal)
    : await downloadGuarded(url, t, opts.signal)
  if (dl.bytes.length === 0)
    throw new TelegramMediaError("telegram_file_invalid", {
      message: m.media.emptyFile,
    })
  // a ChatGPT download URL is an opaque signed link: its path is no file name
  const nameHint =
    src.type === "url"
      ? src.fileName?.trim() || urlFileName(src.url)
      : (src.fileName ?? null)
  const mimeHint =
    src.type === "chatgpt" ? (src.mimeType ?? dl.contentType) : dl.contentType
  const type = detectFileType(dl.bytes, { name: nameHint, mime: mimeHint })
  const kind = resolveMediaKind(type, dl.bytes.length, opts.sendAs)
  return {
    kind,
    bytes: dl.bytes,
    fileName: sanitizeFileName(nameHint, type.ext, now),
    mime: type.mime,
    sizeBytes: dl.bytes.length,
  }
}

// ---------------------------------------------------------------------------
// Concurrency (memory bound: ≤ 2 files of ≤ 50 MB in RAM per process)
// ---------------------------------------------------------------------------

/**
 * Per-process semaphore (shared with Google Drive - src/server/net/media-slots.ts): 2 media jobs at once; a caller
 * waits ≤ 5 s, then TelegramMediaError("telegram_busy").
 * `key` (the MCP id): one media job per key at a time - a second one is refused at once (telegram_busy, "busy with
 * another file"), so one MCP can never hold both slots. `admit` runs once the key is held, before waiting for a slot
 * (e.g. count the attempt; throw to refuse).
 */
export async function withMediaSlot<T>(
  fn: () => Promise<T>,
  o: { key?: string; admit?: () => Promise<void> } = {}
): Promise<T> {
  try {
    return await withSharedMediaSlot(fn, o)
  } catch (e) {
    if (!isMediaBusyError(e)) throw e
    if (e.reason === "key")
      throw new TelegramMediaError("telegram_busy", {
        message: m.media.busyMcp,
        hint: m.media.busyMcpHint,
      })
    throw new TelegramMediaError("telegram_busy")
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "350 KB", "1,2 MB" (vi-VN) */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${formatNumber(bytes / 1024, bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${formatNumber(bytes / 1024 / 1024, 1)} MB`
}

/** "[Ảnh: a.jpg · 1,2 MB]" / "[Video: …]" / "[Tệp: …]" (delivery preview, logs) */
export function mediaPreviewLabel(
  media: Pick<OutgoingMedia, "kind" | "fileName" | "sizeBytes">
): string {
  return m.media.previewLabel(
    m.media.kinds[media.kind],
    redactString(media.fileName),
    formatFileSize(media.sizeBytes)
  )
}
