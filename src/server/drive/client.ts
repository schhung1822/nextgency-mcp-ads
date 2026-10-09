// One request helper for Google Drive v3 + Sheets v4 (doc 15 §4, §12, §13): fixed hosts only, redirects followed
// manually (≤ 3, only to Google hosts), service-account bearer token (refreshed once on 401, sent ONLY to the pinned
// hosts of GOOGLE_AUTH_HOSTS - dropped on any other host / redirect) or an anonymous API key (`key=` query param,
// never an Authorization header), resource keys header (API hosts only), timeouts, retry with backoff for
// 429 / 403 rate limits / 5xx on NON-streaming calls, Google errors mapped to DriveError.
// Never puts the API key, the token, a resource key or a full URL in an error message or a log.
// No imports from "next/*".
import {
  getGoogleAccessToken,
  isGoogleAuthError,
} from "../google/service-account"
import { DriveError, isDriveError, type DriveErrorCode } from "./errors"
import type { DriveAuth } from "./types"

/** Scopes requested for Drive + Sheets by a service account. */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
] as const

export const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
export const SHEETS_API_BASE = "https://sheets.googleapis.com/v4"

export const DRIVE_TIMEOUTS = {
  /** files.get, spreadsheets.get, values:batchGet / batchUpdate */
  metadataMs: 15_000,
  /** files.list */
  listMs: 20_000,
  /** downloads: until the response headers arrive */
  downloadHeadersMs: 15_000,
  /** downloads: max silence between two body chunks */
  downloadIdleMs: 30_000,
} as const

const MAX_REDIRECTS = 3
const DEFAULT_RETRIES = 2
/** largest Google error body read */
const ERROR_BODY_MAX = 64 * 1024

/** hosts a Drive / Sheets request (or a redirect) may reach */
export function isAllowedGoogleHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === "www.googleapis.com" ||
    h === "sheets.googleapis.com" ||
    (h.endsWith(".googleusercontent.com") &&
      h.length > ".googleusercontent.com".length)
  )
}

/** the API key and resource keys travel only to the API hosts (never to googleusercontent.com) */
function takesApiKey(host: string): boolean {
  const h = host.toLowerCase()
  return h === "www.googleapis.com" || h === "sheets.googleapis.com"
}

/**
 * Hosts that receive the service-account bearer token (security review L5): the two API hosts and the thumbnail
 * hosts Drive's thumbnailLink points at. Every other host - also a redirect target on *.googleusercontent.com - is
 * reached WITHOUT an Authorization header.
 */
export const GOOGLE_AUTH_HOSTS: ReadonlySet<string> = new Set([
  "www.googleapis.com",
  "sheets.googleapis.com",
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
  "drive-thirdparty.googleusercontent.com",
])

export function isGoogleAuthHost(host: string): boolean {
  return GOOGLE_AUTH_HOSTS.has(host.toLowerCase())
}

export interface DriveRequest {
  /** absolute https URL on an allowed host (no secrets in it - the API key is added here) */
  url: string
  method?: "GET" | "POST"
  query?: Record<string, string | number | boolean | null | undefined>
  /** JSON body (POST) */
  json?: unknown
  /** `X-Goog-Drive-Resource-Keys: <id>/<key>,…` (entries without a key are skipped) */
  resourceKeys?: ReadonlyArray<{ id: string; key: string | null | undefined }>
  headers?: Record<string, string>
  signal?: AbortSignal
  /** JSON calls: the whole exchange; streams: until the response headers arrive */
  timeoutMs: number
  /** retries after the first attempt for 429 / 403 rate limits / 5xx (default 2; streams never retry) */
  retries?: number
}

export function resourceKeysHeader(
  list: ReadonlyArray<{ id: string; key: string | null | undefined }> = []
): string | null {
  const parts = list.filter((r) => r.key).map((r) => `${r.id}/${r.key}`)
  return parts.length ? parts.join(",") : null
}

function buildUrl(req: DriveRequest, auth: DriveAuth): URL {
  const u = new URL(req.url)
  if (u.protocol !== "https:" || !isAllowedGoogleHost(u.hostname))
    throw new DriveError("upstream_error", { retryable: false })
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null) continue
    u.searchParams.set(k, String(v))
  }
  if (auth.type === "api_key" && takesApiKey(u.hostname))
    u.searchParams.set("key", auth.apiKey)
  return u
}

async function authHeader(
  auth: DriveAuth,
  forceRefresh: boolean,
  signal: AbortSignal
): Promise<Record<string, string>> {
  if (auth.type === "api_key") return {}
  const token = await getGoogleAccessToken(auth.sa, DRIVE_SCOPES, {
    cacheKey: auth.cacheKey,
    signal,
    forceRefresh,
  })
  return { Authorization: `Bearer ${token}` }
}

/** One exchange: auth, manual redirects (≤ 3, Google hosts only). Throws on network errors (mapped by callers). */
async function send(
  auth: DriveAuth,
  req: DriveRequest,
  signal: AbortSignal,
  forceRefresh: boolean
): Promise<Response> {
  let url = buildUrl(req, auth)
  let method = req.method ?? "GET"
  let body: string | undefined =
    req.json === undefined ? undefined : JSON.stringify(req.json)
  const base: Record<string, string> = {
    Accept: "application/json",
    ...req.headers,
  }
  // the token is fetched only when a hop goes to a pinned host
  let bearer: Record<string, string> | null = null
  const rk = resourceKeysHeader(req.resourceKeys)
  for (let hop = 0; ; hop++) {
    const headers = { ...base }
    if (isGoogleAuthHost(url.hostname)) {
      bearer ??= await authHeader(auth, forceRefresh, signal)
      Object.assign(headers, bearer)
    }
    if (rk && takesApiKey(url.hostname))
      headers["X-Goog-Drive-Resource-Keys"] = rk
    if (body !== undefined) headers["Content-Type"] = "application/json"
    const res = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal,
      redirect: "manual",
    })
    const isRedirect =
      res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)
    if (!isRedirect) return res
    const location = res.headers.get("location")
    void res.body?.cancel().catch(() => {})
    if (!location || hop >= MAX_REDIRECTS)
      throw new DriveError("upstream_error", { retryable: false })
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new DriveError("upstream_error", { retryable: false })
    }
    // never leave Google; the bearer token / resource keys are re-decided per hop (pinned hosts only)
    if (next.protocol !== "https:" || !isAllowedGoogleHost(next.hostname))
      throw new DriveError("upstream_error", { retryable: false })
    if (res.status === 303) {
      method = "GET"
      body = undefined
    }
    url = next
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface GoogleErrorInfo {
  reasons: Set<string>
  message: string
}

function googleErrorInfo(body: unknown): GoogleErrorInfo {
  const reasons = new Set<string>()
  let message = ""
  const err =
    body && typeof body === "object"
      ? (body as { error?: unknown }).error
      : undefined
  if (typeof err === "string") reasons.add(err)
  else if (err && typeof err === "object") {
    const e = err as {
      message?: unknown
      status?: unknown
      errors?: unknown
      details?: unknown
    }
    if (typeof e.message === "string") message = e.message
    if (typeof e.status === "string") reasons.add(e.status)
    for (const list of [e.errors, e.details]) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const r = (item as { reason?: unknown } | null)?.reason
        if (typeof r === "string") reasons.add(r)
      }
    }
  }
  return { reasons, message }
}

const API_KEY_REASONS = [
  "keyInvalid",
  "API_KEY_INVALID",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_ANDROID_APP_BLOCKED",
  "API_KEY_IOS_APP_BLOCKED",
]
const API_DISABLED_REASONS = ["accessNotConfigured", "SERVICE_DISABLED"]
const RATE_LIMIT_REASONS = [
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "quotaExceeded",
  "dailyLimitExceeded",
]
const ABUSE_REASONS = ["cannotDownloadAbusiveFile", "abuse"]
const NOT_DOWNLOADABLE_REASONS = [
  "fileNotDownloadable",
  "cannotDownloadFile",
  "exportOnlyAllowedForGoogleDocs",
]
const PERMISSION_REASONS = [
  "insufficientFilePermissions",
  "forbidden",
  "appNotAuthorizedToFile",
  "domainPolicy",
  "PERMISSION_DENIED",
]

const hasAny = (s: Set<string>, list: readonly string[]) =>
  list.some((r) => s.has(r))

/** true for answers worth retrying on a non-streaming call: 429, 5xx, 403 rate limits */
export function isRetryableGoogleStatus(
  status: number,
  body: unknown
): boolean {
  if (status === 429 || status >= 500) return true
  if (status !== 403) return false
  return hasAny(googleErrorInfo(body).reasons, [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "RATE_LIMIT_EXCEEDED",
  ])
}

/**
 * Google error answer → DriveError. With api_key auth a missing / forbidden file means "not shared publicly"
 * (the key only reads "Anyone with the link" files).
 */
export function mapGoogleError(
  status: number,
  body: unknown,
  auth: Pick<DriveAuth, "type">
): DriveError {
  const { reasons, message } = googleErrorInfo(body)
  const apiKey = auth.type === "api_key"
  const make = (code: DriveErrorCode, retryable?: boolean) =>
    new DriveError(code, { httpStatus: status, retryable })
  if (hasAny(reasons, API_KEY_REASONS) || /API key not valid/i.test(message))
    return make("api_key_invalid")
  if (hasAny(reasons, API_DISABLED_REASONS)) return make("api_disabled")
  if (status === 429 || hasAny(reasons, RATE_LIMIT_REASONS))
    return make("rate_limited")
  if (hasAny(reasons, ABUSE_REASONS)) return make("abusive_file")
  if (hasAny(reasons, NOT_DOWNLOADABLE_REASONS)) return make("not_downloadable")
  if (status === 416) return make("range_not_satisfiable")
  if (status === 404 || reasons.has("notFound") || reasons.has("NOT_FOUND"))
    return make(apiKey ? "not_public" : "not_found")
  if (status === 401) return make(apiKey ? "not_public" : "auth_failed")
  if (status === 403 || hasAny(reasons, PERMISSION_REASONS))
    return make(apiKey ? "not_public" : "permission_denied")
  return make("upstream_error", status >= 500)
}

/** Any error from a Drive / Sheets call (GoogleAuthError, abort, network) → DriveError. */
export function toDriveError(e: unknown): DriveError {
  if (isDriveError(e)) return e
  if (isGoogleAuthError(e)) {
    if (e.code === "invalid_json")
      return new DriveError("auth_failed", {
        message: e.userMessageVi ?? undefined,
        cause: e,
      })
    if (e.code === "network")
      return new DriveError(e.timedOut ? "timeout" : "upstream_error", {
        retryable: true,
        cause: e,
      })
    if (
      e.code === "upstream" &&
      (e.httpStatus === 429 || (e.httpStatus ?? 0) >= 500)
    )
      return new DriveError("upstream_error", {
        httpStatus: e.httpStatus,
        retryable: true,
        cause: e,
      })
    return new DriveError("auth_failed", { httpStatus: e.httpStatus, cause: e })
  }
  const name = (e as { name?: unknown } | null)?.name
  if (name === "AbortError" || name === "TimeoutError")
    return new DriveError("timeout")
  return new DriveError("upstream_error")
}

/** network failure of fetch() → DriveError (the fetch error itself may carry the URL: never attached) */
function fetchFailure(
  e: unknown,
  timedOut: () => boolean,
  callerSignal?: AbortSignal
): DriveError {
  if (isDriveError(e) || isGoogleAuthError(e)) return toDriveError(e)
  if (timedOut() || callerSignal?.aborted) return new DriveError("timeout")
  return new DriveError("upstream_error", { retryable: true })
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

let retryBaseMs = 1_000
/** tests: shorter backoff */
export function __setDriveRetryBaseMs(ms: number): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST)
    throw new Error("__setDriveRetryBaseMs is test-only")
  retryBaseMs = ms
}

function retryDelayMs(attempt: number, headers: Headers): number {
  const ra = headers.get("retry-after")
  const secs = ra === null ? NaN : Number(ra)
  const base = Number.isFinite(secs)
    ? secs * 1000
    : retryBaseMs * 2 ** (attempt - 1)
  return Math.min(base + Math.random() * (retryBaseMs / 4), 10_000)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DriveError("timeout"))
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DriveError("timeout"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** controller aborted by the caller's signal or by a timer; `timedOut()` tells which */
function linkedController(signal?: AbortSignal) {
  const ctrl = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => ctrl.abort()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    startTimer(ms: number) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, ms)
    },
    stopTimer: () => clearTimeout(timer),
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      size += r.value.byteLength
      if (size > max) {
        void reader.cancel().catch(() => {})
        break
      }
      chunks.push(r.value)
    }
  } catch {
    // a broken error body: mapped by status alone
  }
  return Buffer.concat(chunks).toString("utf8")
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * JSON call (metadata, listing, Sheets values). Retries 429 / 403 rate limits / 5xx with backoff (Retry-After
 * honoured, ≤ 10 s); a service account token is refreshed once on 401. Errors → DriveError.
 */
export async function driveJson<T>(
  auth: DriveAuth,
  req: DriveRequest
): Promise<T> {
  const retries = req.retries ?? DEFAULT_RETRIES
  let attempt = 0
  let refreshed = false
  for (;;) {
    const c = linkedController(req.signal)
    c.startTimer(req.timeoutMs)
    let retryHeaders = new Headers()
    try {
      let res: Response
      try {
        res = await send(auth, req, c.signal, refreshed)
      } catch (e) {
        throw fetchFailure(e, c.timedOut, req.signal)
      }
      let text: string
      try {
        text = await readText(res, res.ok ? 32 * 1024 * 1024 : ERROR_BODY_MAX)
      } catch (e) {
        throw fetchFailure(e, c.timedOut, req.signal)
      }
      if (c.timedOut()) throw new DriveError("timeout")
      if (res.ok) return parseJson(text) as T
      const body = parseJson(text)
      if (res.status === 401 && auth.type === "service_account" && !refreshed) {
        refreshed = true
        continue
      }
      if (attempt < retries && isRetryableGoogleStatus(res.status, body)) {
        attempt++
        retryHeaders = res.headers
      } else throw mapGoogleError(res.status, body, auth)
    } finally {
      c.dispose()
    }
    await sleep(retryDelayMs(attempt, retryHeaders), req.signal)
  }
}

export interface DriveStreamResponse {
  status: number
  headers: Headers
  /** body with an idle timeout; cancelling it aborts the upstream request */
  body: ReadableStream<Uint8Array>
}

/**
 * Streaming call (downloads, thumbnails): no retry, no buffering. The header timeout is `req.timeoutMs`, then
 * every chunk must arrive within `idleMs`. A service account token is refreshed once on 401. Non-2xx → DriveError.
 */
export async function driveStream(
  auth: DriveAuth,
  req: DriveRequest,
  idleMs: number = DRIVE_TIMEOUTS.downloadIdleMs
): Promise<DriveStreamResponse> {
  let refreshed = false
  for (;;) {
    const c = linkedController(req.signal)
    c.startTimer(req.timeoutMs)
    let res: Response
    try {
      res = await send(auth, req, c.signal, refreshed)
    } catch (e) {
      c.dispose()
      throw fetchFailure(e, c.timedOut, req.signal)
    }
    if (res.status < 200 || res.status >= 300) {
      let text = ""
      try {
        text = await readText(res, ERROR_BODY_MAX)
      } finally {
        c.dispose()
      }
      if (res.status === 401 && auth.type === "service_account" && !refreshed) {
        refreshed = true
        continue
      }
      throw mapGoogleError(res.status, parseJson(text), auth)
    }
    c.stopTimer()
    const src =
      res.body ??
      new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() })
    return {
      status: res.status,
      headers: res.headers,
      body: idleTimeoutStream(src, idleMs, c),
    }
  }
}

/** Wrap a body: each read must settle within idleMs (else DriveError timeout); cancel → upstream aborted. */
function idleTimeoutStream(
  src: ReadableStream<Uint8Array>,
  idleMs: number,
  c: ReturnType<typeof linkedController>
): ReadableStream<Uint8Array> {
  const reader = src.getReader()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    c.dispose()
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const r = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new DriveError("timeout")),
                idleMs
              )
            }),
          ])
          if (r.done) {
            finish()
            controller.close()
            return
          }
          controller.enqueue(r.value)
        } catch (e) {
          c.abort()
          void reader.cancel().catch(() => {})
          finish()
          controller.error(
            isDriveError(e)
              ? e
              : new DriveError(
                  c.signal.aborted ? "timeout" : "upstream_error",
                  {
                    retryable: true,
                  }
                )
          )
        } finally {
          clearTimeout(timer)
        }
      },
      async cancel(reason) {
        c.abort()
        finish()
        await reader.cancel(reason).catch(() => {})
      },
    },
    { highWaterMark: 0 }
  )
}
