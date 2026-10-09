// Telegram Bot API client (core.telegram.org/bots/api, Bot API 10.x). MUST NOT import "next/*" or "server-only":
// shared by the web app (wizard checks, test messages, MCP tool) and the pg-boss worker.
// The bot token lives in the URL PATH (`/bot<token>/<method>`): the URL is never logged, never put in an error
// message and redirects are refused. Every error is a TelegramError carrying a Vietnamese message + how to fix it.
import { notifications as m } from "@/lib/i18n/vi/notifications"
import { TELEGRAM_BOT_TOKEN_RE } from "@/lib/schemas/notifications"
import { redactString } from "@/server/audit/redact"
import { isSafeTelegramBaseUrl } from "@/server/env"

import { creditFooter, withFooter, type CreditFooter } from "./credit"
import type { OutgoingMedia, OutgoingMediaKind } from "./media"

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org"
export const TELEGRAM_TIMEOUT_MS = 10_000
/** multipart uploads (photo / video / document ≤ 50 MB) */
export const TELEGRAM_UPLOAD_TIMEOUT_MS = 30_000

/**
 * `TELEGRAM_API_BASE_URL` (optional, env only): unset/empty = https://api.telegram.org. Must be https (http only for
 * localhost - a local Bot API server / test double), without credentials, query or fragment. Invalid → null.
 */
export function telegramApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.TELEGRAM_API_BASE_URL?.trim()
  if (!raw) return DEFAULT_TELEGRAM_API_BASE_URL
  return isValidTelegramBaseUrl(raw) ? raw.replace(/\/+$/, "") : null
}

/** https (http only for localhost), no credentials / query / fragment - same rule as env.ts validation. */
export const isValidTelegramBaseUrl = isSafeTelegramBaseUrl

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TelegramErrorKind =
  | "invalid_token" // malformed token (never sent)
  | "unauthorized" // 401 / 404: wrong or revoked token
  | "chat_not_found" // 400 chat not found
  | "thread_not_found" // 400 message thread not found
  | "forbidden" // 403 (blocked / kicked / not a member) or 400 "not enough rights"
  | "parse_entities" // 400 can't parse entities (HTML)
  | "migrated" // 400 group upgraded to supergroup (parameters.migrate_to_chat_id)
  | "rate_limited" // 429 (parameters.retry_after)
  | "bad_request" // any other 4xx
  | "file_too_large" // 413 Request Entity Too Large (upload)
  | "server" // 5xx
  | "network" // no response (DNS, refused, reset…)
  | "timeout" // no response within TELEGRAM_TIMEOUT_MS
  | "invalid_response" // unreadable body
  | "config" // TELEGRAM_API_BASE_URL invalid

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind
  /** Telegram error_code / HTTP status; null when there was no response */
  readonly code: number | null
  /** Telegram `description`, redacted + capped (for logs / delivery.error_message) */
  readonly description: string | null
  readonly retryAfterSec: number | null
  readonly migrateToChatId: string | null
  /** Vietnamese message + how to fix (safe for the UI) */
  readonly userMessageVi: string

  constructor(args: {
    kind: TelegramErrorKind
    code?: number | null
    description?: string | null
    retryAfterSec?: number | null
    migrateToChatId?: string | null
    userMessageVi: string
  }) {
    // the technical message never contains the URL / token: kind + code + redacted description only
    const description = args.description
      ? redactString(args.description).slice(0, 300)
      : null
    super(
      `telegram ${args.kind}${args.code ? ` ${args.code}` : ""}${description ? `: ${description}` : ""}`
    )
    this.name = "TelegramError"
    this.kind = args.kind
    this.code = args.code ?? null
    this.description = description
    this.retryAfterSec = args.retryAfterSec ?? null
    this.migrateToChatId = args.migrateToChatId ?? null
    this.userMessageVi = args.userMessageVi
  }

  /** 429 / 5xx / no response: worth retrying later (worker only). */
  get retryable(): boolean {
    return (
      this.kind === "rate_limited" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout"
    )
  }

  /** The channel configuration is broken (token / chat / thread / rights): mark the channel `error`. */
  get channelBroken(): boolean {
    return (
      this.kind === "unauthorized" ||
      this.kind === "invalid_token" ||
      this.kind === "chat_not_found" ||
      this.kind === "thread_not_found" ||
      this.kind === "forbidden"
    )
  }
}

export function isTelegramError(e: unknown): e is TelegramError {
  return e instanceof TelegramError
}

function botLabel(botUsername?: string | null): string {
  return botUsername ? `@${botUsername}` : "bot"
}

/** photo refused by Telegram (size / ratio / format): worth one resend as a document */
const PHOTO_REJECTED_RE =
  /photo_[a-z_]*invalid|image_process_failed|photo_save_file_invalid|dimensions/i

/** media 400s: the file / its URL could not be used */
function isMediaRejection(d: string): boolean {
  return (
    PHOTO_REJECTED_RE.test(d) ||
    d.includes("wrong file") ||
    d.includes("failed to get http url content") ||
    d.includes("wrong type of the web page content") ||
    d.includes("wrong remote file")
  )
}

/** sendPhoto refused the image itself (PHOTO_INVALID_DIMENSIONS, IMAGE_PROCESS_FAILED…): nothing was posted. */
export function isPhotoRejected(e: unknown): boolean {
  return (
    isTelegramError(e) &&
    e.kind === "bad_request" &&
    PHOTO_REJECTED_RE.test(e.description ?? "")
  )
}

/** Telegram error body → TelegramError (pure, exported for tests). */
export function mapTelegramError(
  httpStatus: number,
  body: {
    error_code?: unknown
    description?: unknown
    parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown }
  } | null,
  botUsername?: string | null
): TelegramError {
  const code =
    typeof body?.error_code === "number" ? body.error_code : httpStatus
  const description =
    typeof body?.description === "string" ? body.description : null
  const d = (description ?? "").toLowerCase()
  const bot = botLabel(botUsername)
  const params = body?.parameters ?? {}

  if (code === 429) {
    const ra = Number(params.retry_after)
    const retryAfterSec =
      Number.isFinite(ra) && ra > 0 ? Math.min(Math.ceil(ra), 3600) : 30
    return new TelegramError({
      kind: "rate_limited",
      code,
      description,
      retryAfterSec,
      userMessageVi: m.telegram.rateLimited(retryAfterSec),
    })
  }
  if (code === 413 || d.includes("request entity too large")) {
    return new TelegramError({
      kind: "file_too_large",
      code,
      description,
      userMessageVi: m.telegram.fileTooLarge,
    })
  }
  if (code === 401 || code === 404) {
    return new TelegramError({
      kind: "unauthorized",
      code,
      description,
      userMessageVi: m.telegram.unauthorized,
    })
  }
  if (code >= 500) {
    return new TelegramError({
      kind: "server",
      code,
      description,
      userMessageVi: m.telegram.unavailable,
    })
  }
  const migrate = params.migrate_to_chat_id
  if (
    typeof migrate === "number" ||
    (typeof migrate === "string" && /^-?\d+$/.test(migrate))
  ) {
    return new TelegramError({
      kind: "migrated",
      code,
      description,
      migrateToChatId: String(migrate),
      userMessageVi: m.telegram.warnMigrated,
    })
  }
  if (code === 403) {
    const userMessageVi = d.includes("blocked by the user")
      ? m.telegram.blockedByUser(bot)
      : m.telegram.forbidden(bot)
    return new TelegramError({
      kind: "forbidden",
      code,
      description,
      userMessageVi,
    })
  }
  if (code === 400) {
    if (d.includes("chat not found")) {
      return new TelegramError({
        kind: "chat_not_found",
        code,
        description,
        userMessageVi: m.telegram.chatNotFound(bot),
      })
    }
    if (
      d.includes("thread not found") ||
      d.includes("topic_deleted") ||
      d.includes("topic_closed") ||
      d.includes("topic not found")
    ) {
      return new TelegramError({
        kind: "thread_not_found",
        code,
        description,
        userMessageVi: m.telegram.threadNotFound,
      })
    }
    if (
      d.includes("can't parse entities") ||
      d.includes("can't find end") ||
      d.includes("unsupported start tag")
    ) {
      return new TelegramError({
        kind: "parse_entities",
        code,
        description,
        userMessageVi: m.telegram.parseFailed,
      })
    }
    if (
      d.includes("not enough rights") ||
      d.includes("need administrator rights") ||
      d.includes("have no rights") ||
      d.includes("chat_write_forbidden") ||
      d.includes("chat_restricted") ||
      d.includes("bot is not a member")
    ) {
      return new TelegramError({
        kind: "forbidden",
        code,
        description,
        userMessageVi: m.telegram.forbidden(bot),
      })
    }
    if (isMediaRejection(d)) {
      return new TelegramError({
        kind: "bad_request",
        code,
        description,
        userMessageVi: m.telegram.mediaRejected,
      })
    }
  }
  return new TelegramError({
    kind: "bad_request",
    code,
    description,
    userMessageVi: m.telegram.badRequest,
  })
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface TelegramBody {
  ok?: unknown
  result?: unknown
  error_code?: unknown
  description?: unknown
  parameters?: Record<string, unknown>
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface TelegramCallOptions {
  signal?: AbortSignal
  /** default TELEGRAM_TIMEOUT_MS */
  timeoutMs?: number
  /** tests */
  fetchImpl?: FetchLike
  /** used in error messages ("Thêm @bot vào nhóm…") */
  botUsername?: string | null
  /** tests: override TELEGRAM_API_BASE_URL */
  baseUrl?: string
}

/** POST JSON to one Bot API method; returns `result` or throws TelegramError. */
export async function callTelegram<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  opts: TelegramCallOptions = {}
): Promise<T> {
  return postTelegram<T>(
    token,
    method,
    {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    },
    opts,
    m.telegram.timeout
  )
}

/**
 * POST multipart/form-data to one Bot API method (file uploads: sendPhoto / sendVideo / sendDocument). The
 * content-type (with its boundary) is set by fetch from the FormData - never by hand. Same token hygiene as
 * callTelegram; default timeout TELEGRAM_UPLOAD_TIMEOUT_MS.
 */
export async function callTelegramMultipart<T>(
  token: string,
  method: string,
  form: FormData,
  opts: TelegramCallOptions = {}
): Promise<T> {
  return postTelegram<T>(
    token,
    method,
    { headers: { accept: "application/json" }, body: form },
    { ...opts, timeoutMs: opts.timeoutMs ?? TELEGRAM_UPLOAD_TIMEOUT_MS },
    m.telegram.uploadTimeout
  )
}

async function postTelegram<T>(
  token: string,
  method: string,
  req: { headers: Record<string, string>; body: string | FormData },
  opts: TelegramCallOptions,
  timeoutMessageVi: string
): Promise<T> {
  if (!TELEGRAM_BOT_TOKEN_RE.test(token)) {
    throw new TelegramError({
      kind: "invalid_token",
      userMessageVi: m.telegram.unauthorized,
    })
  }
  if (!/^[A-Za-z]+$/.test(method))
    throw new Error("telegram: invalid method name")
  const base = opts.baseUrl ?? telegramApiBaseUrl()
  if (!base || !isValidTelegramBaseUrl(base)) {
    throw new TelegramError({
      kind: "config",
      userMessageVi: m.telegram.configInvalid,
    })
  }

  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, opts.timeoutMs ?? TELEGRAM_TIMEOUT_MS)
  const onAbort = () => ac.abort()
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: ac.signal,
      // a redirect would carry the token to another URL
      redirect: "error",
      cache: "no-store",
    })
  } catch {
    // never forward the fetch error: its message / cause may include the URL (= the token)
    throw new TelegramError(
      timedOut
        ? { kind: "timeout", userMessageVi: timeoutMessageVi }
        : { kind: "network", userMessageVi: m.telegram.unavailable }
    )
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }

  let body: TelegramBody | null = null
  try {
    const text = await res.text()
    body = text ? (JSON.parse(text) as TelegramBody) : null
  } catch {
    body = null
  }
  if (res.ok && body?.ok === true) return body.result as T
  if (!body || typeof body !== "object") {
    if (res.status >= 500)
      throw new TelegramError({
        kind: "server",
        code: res.status,
        userMessageVi: m.telegram.unavailable,
      })
    if (res.ok)
      throw new TelegramError({
        kind: "invalid_response",
        code: res.status,
        userMessageVi: m.telegram.invalidResponse,
      })
  }
  throw mapTelegramError(res.ok ? 400 : res.status, body, opts.botUsername)
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export interface TelegramBotInfo {
  id: string
  username: string
  name: string
}

export interface TelegramChatInfo {
  id: string
  type: "private" | "group" | "supergroup" | "channel"
  title: string | null
  username: string | null
  isForum: boolean
}

export interface TelegramMemberInfo {
  status:
    | "creator"
    | "administrator"
    | "member"
    | "restricted"
    | "left"
    | "kicked"
    | string
  canPostMessages: boolean | null
  canSendMessages: boolean | null
}

export async function getMe(
  token: string,
  opts: TelegramCallOptions = {}
): Promise<TelegramBotInfo> {
  const r = await callTelegram<{
    id?: unknown
    username?: unknown
    first_name?: unknown
  }>(token, "getMe", {}, opts)
  if (typeof r?.id !== "number" && typeof r?.id !== "string") {
    throw new TelegramError({
      kind: "invalid_response",
      userMessageVi: m.telegram.invalidResponse,
    })
  }
  return {
    id: String(r.id),
    username: typeof r.username === "string" ? r.username : "",
    name: typeof r.first_name === "string" ? r.first_name : "",
  }
}

export async function getChat(
  token: string,
  chatId: string,
  opts: TelegramCallOptions = {}
): Promise<TelegramChatInfo> {
  const r = await callTelegram<Record<string, unknown>>(
    token,
    "getChat",
    { chat_id: chatId },
    opts
  )
  const type = r?.type
  if (
    (typeof r?.id !== "number" && typeof r?.id !== "string") ||
    !["private", "group", "supergroup", "channel"].includes(String(type))
  ) {
    throw new TelegramError({
      kind: "invalid_response",
      userMessageVi: m.telegram.invalidResponse,
    })
  }
  const privateName = [r.first_name, r.last_name]
    .filter((x): x is string => typeof x === "string" && x !== "")
    .join(" ")
  return {
    id: String(r.id),
    type: type as TelegramChatInfo["type"],
    title: typeof r.title === "string" ? r.title : privateName || null,
    username: typeof r.username === "string" ? r.username : null,
    isForum: r.is_forum === true,
  }
}

export async function getChatMember(
  token: string,
  chatId: string,
  userId: string,
  opts: TelegramCallOptions = {}
): Promise<TelegramMemberInfo> {
  const r = await callTelegram<Record<string, unknown>>(
    token,
    "getChatMember",
    { chat_id: chatId, user_id: Number(userId) },
    opts
  )
  return {
    status: typeof r?.status === "string" ? r.status : "unknown",
    canPostMessages:
      typeof r?.can_post_messages === "boolean" ? r.can_post_messages : null,
    canSendMessages:
      typeof r?.can_send_messages === "boolean" ? r.can_send_messages : null,
  }
}

export interface SendMessageParams {
  chatId: string
  text: string
  /** null = plain text */
  parseMode?: "HTML" | null
  /** forum topic; 1 (General) and null are omitted */
  messageThreadId?: number | null
  disableNotification?: boolean
}

export async function sendMessage(
  token: string,
  params: SendMessageParams,
  opts: TelegramCallOptions = {}
): Promise<{ messageId: number }> {
  const payload: Record<string, unknown> = {
    chat_id: params.chatId,
    text: params.text,
    link_preview_options: { is_disabled: true },
  }
  if (params.parseMode !== null) payload.parse_mode = params.parseMode ?? "HTML"
  if (params.messageThreadId && params.messageThreadId > 1)
    payload.message_thread_id = params.messageThreadId
  if (params.disableNotification) payload.disable_notification = true
  const r = await callTelegram<{ message_id?: unknown }>(
    token,
    "sendMessage",
    payload,
    opts
  )
  const id = Number(r?.message_id)
  return { messageId: Number.isFinite(id) ? id : 0 }
}

/** Remove HTML tags and decode the entities escapeHtml produces (plain-text fallback). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

export interface SendTextResult {
  messageId: number
  /** set when Telegram reported a group → supergroup migration: persist it as the new chat id */
  migratedChatId: string | null
  /** true when the HTML was rejected and the message went out as plain text */
  sentAsPlainText: boolean
}

/** extra options of sendTelegramText / sendTelegramMedia */
export interface TelegramSendOptions extends TelegramCallOptions {
  disableNotification?: boolean
  /** credit line appended to the text / caption (§10.1); default creditFooter(), null = none */
  footer?: CreditFooter | null
}

/**
 * sendMessage with the two one-shot recoveries of the spec: "can't parse entities" → resend once as plain text;
 * group migrated → resend once to `migrate_to_chat_id`. No retry for anything else (429 / 5xx / network are the
 * caller's decision: the worker re-queues, the MCP tool reports). The credit footer is appended here (HTML, or its
 * plain form in the fallback): the caller fits `html` so that html + footer stay within 4096 characters.
 */
export async function sendTelegramText(
  token: string,
  target: { chatId: string; messageThreadId: number | null },
  html: string,
  opts: TelegramSendOptions = {}
): Promise<SendTextResult> {
  const footer = opts.footer === undefined ? creditFooter() : opts.footer
  let chatId = target.chatId
  let parseMode: "HTML" | null = "HTML"
  let text = withFooter(html, footer?.html)
  let migratedChatId: string | null = null
  let migrated = false
  let plain = false
  for (;;) {
    try {
      const r = await sendMessage(
        token,
        {
          chatId,
          text,
          parseMode,
          messageThreadId: target.messageThreadId,
          disableNotification: opts.disableNotification,
        },
        opts
      )
      return { messageId: r.messageId, migratedChatId, sentAsPlainText: plain }
    } catch (e) {
      if (
        isTelegramError(e) &&
        e.kind === "migrated" &&
        e.migrateToChatId &&
        !migrated
      ) {
        migrated = true
        chatId = e.migrateToChatId
        migratedChatId = e.migrateToChatId
        continue
      }
      if (isTelegramError(e) && e.kind === "parse_entities" && !plain) {
        plain = true
        parseMode = null
        text = withFooter(htmlToPlainText(html), footer?.plain)
        continue
      }
      throw e
    }
  }
}

export interface SendMediaResult extends SendTextResult {
  /** what Telegram received: a photo it refused is resent once as a document */
  sentAs: OutgoingMediaKind
}

const MEDIA_METHODS = {
  photo: { method: "sendPhoto", field: "photo" },
  video: { method: "sendVideo", field: "video" },
  document: { method: "sendDocument", field: "document" },
} as const

/**
 * Upload one file (multipart) with a caption: sendPhoto / sendVideo (supports_streaming) / sendDocument. Same
 * one-shot recoveries as sendTelegramText (migrated chat, plain caption on "can't parse entities") plus: a photo
 * Telegram refuses (dimensions / processing) is resent once as a document - safe, a refused photo was not posted.
 * The caller fits `captionHtml` so that caption + footer stay within 1024 characters. No other retry.
 */
export async function sendTelegramMedia(
  token: string,
  target: { chatId: string; messageThreadId: number | null },
  media: OutgoingMedia,
  captionHtml: string,
  opts: TelegramSendOptions = {}
): Promise<SendMediaResult> {
  const footer = opts.footer === undefined ? creditFooter() : opts.footer
  // one immutable Blob reused by every attempt (Buffer.concat / Buffer.from bytes are ArrayBuffer-backed)
  const file = new Blob([media.bytes as Uint8Array<ArrayBuffer>], {
    type: media.mime,
  })
  let chatId = target.chatId
  let kind: OutgoingMediaKind = media.kind
  let migratedChatId: string | null = null
  let migrated = false
  let plain = false
  for (;;) {
    const { method, field } = MEDIA_METHODS[kind]
    const caption = plain
      ? withFooter(htmlToPlainText(captionHtml), footer?.plain)
      : withFooter(captionHtml, footer?.html)
    const form = new FormData()
    form.append("chat_id", chatId)
    if (target.messageThreadId && target.messageThreadId > 1)
      form.append("message_thread_id", String(target.messageThreadId))
    if (caption) {
      form.append("caption", caption)
      if (!plain) form.append("parse_mode", "HTML")
    }
    if (opts.disableNotification) form.append("disable_notification", "true")
    if (kind === "video") form.append("supports_streaming", "true")
    form.append(field, file, media.fileName)
    try {
      const r = await callTelegramMultipart<{ message_id?: unknown }>(
        token,
        method,
        form,
        opts
      )
      const id = Number(r?.message_id)
      return {
        messageId: Number.isFinite(id) ? id : 0,
        migratedChatId,
        sentAsPlainText: plain,
        sentAs: kind,
      }
    } catch (e) {
      if (!isTelegramError(e)) throw e
      if (e.kind === "migrated" && e.migrateToChatId && !migrated) {
        migrated = true
        chatId = e.migrateToChatId
        migratedChatId = e.migrateToChatId
        continue
      }
      if (e.kind === "parse_entities" && !plain) {
        plain = true
        continue
      }
      if (kind === "photo" && isPhotoRejected(e)) {
        kind = "document"
        continue
      }
      throw e
    }
  }
}
