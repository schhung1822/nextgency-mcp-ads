// One request helper for the Apify API v2 (16-apify.md §4, providers/apify.md). MUST NOT import "next/*" or
// "server-only": shared by the web app (services, MCP tools) and the pg-boss worker (apify.health).
// - token ONLY in `Authorization: Bearer` - never `?token=` (URLs end up in logs); a query key "token" is refused
// - fixed base URL (APIFY_API_BASE_URL override: https only), path segments validated + encoded
// - `redirect: "error"` (a redirect would carry the Authorization header elsewhere), `cache: "no-store"`
// - per-call timeout linked to the caller's AbortSignal
// - retry with backoff for GET (and explicitly idempotent POSTs) on 429 / 5xx / network errors: ≤ 2 retries, ≤ 5 s
//   of waiting in total. Starting a run is NEVER retried here (see actors.ts startActorRun).
// - never rethrows a fetch error (its message / cause may contain the URL): every failure is an ApifyError.
import { isSafeHttpsBaseUrl } from "@/server/env"

import { ApifyError, isApifyError, mapApifyError } from "./errors"

export const DEFAULT_APIFY_API_BASE_URL = "https://api.apify.com"

export const APIFY_TIMEOUTS = {
  /** metadata calls (users/me, limits, actor, run, store) */
  defaultMs: 15_000,
  /** dataset items / build (README, input schema) */
  dataMs: 20_000,
  /** added to waitForFinish (long-poll) of start run / get run */
  longPollExtraMs: 10_000,
} as const

const DEFAULT_RETRIES = 2
/** total time spent sleeping between retries of one call */
const MAX_TOTAL_BACKOFF_MS = 5_000
/** largest body read: JSON answers / dataset items (callers always send `limit`) */
export const APIFY_MAX_BODY_BYTES = 4 * 1024 * 1024
export const APIFY_MAX_DATASET_BYTES = 8 * 1024 * 1024
const ERROR_BODY_MAX = 64 * 1024

/**
 * `APIFY_API_BASE_URL` (optional, env only): unset / empty = https://api.apify.com. https only, no credentials, query
 * or fragment (same rule as env.ts). Invalid → null (callers raise ApifyError "config").
 */
export function apifyApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.APIFY_API_BASE_URL?.trim()
  if (!raw) return DEFAULT_APIFY_API_BASE_URL
  return isSafeHttpsBaseUrl(raw) ? raw.replace(/\/+$/, "") : null
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ApifyCallOptions {
  /** caller signal (MCP request, job shutdown) */
  signal?: AbortSignal
  /**
   * epoch ms the caller must answer by (MCP tool budget): every attempt's timeout is clamped to the time left
   * (≥ 1 s) and no retry sleeps past it
   */
  deadline?: number
  /** per attempt; default APIFY_TIMEOUTS.defaultMs */
  timeoutMs?: number
  /** tests */
  fetchImpl?: FetchLike
  /** tests: override APIFY_API_BASE_URL */
  baseUrl?: string
}

export type ApifyQuery = Record<
  string,
  string | number | boolean | null | undefined
>

export interface ApifyRequest {
  method: "GET" | "POST"
  /** "/v2/…" - build it with apifyPath() */
  path: string
  query?: ApifyQuery
  /** JSON body (POST) */
  body?: unknown
  /** return the whole parsed body (dataset items, KV records) instead of its `data` envelope */
  raw?: boolean
  /** retry 429 / 5xx / network errors: default true for GET, false for POST (pass true only when idempotent) */
  retry?: boolean
  /** largest successful body accepted (default APIFY_MAX_BODY_BYTES) */
  maxBytes?: number
}

export interface ApifyResponse<T> {
  status: number
  data: T
  headers: Headers
}

/** resource ids / "username~name" / record keys: anything else is refused before reaching the network */
const SEGMENT_RE = /^[A-Za-z0-9._~-]{1,200}$/

/** "/v2/<seg>/<seg>…" with every segment validated and URL-encoded. */
export function apifyPath(...segments: string[]): string {
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s === "." || s === "..")
      throw new ApifyError("bad_request", { hint: null })
  }
  return `/v2/${segments.map((s) => encodeURIComponent(s)).join("/")}`
}

/**
 * `ms` capped to the time left before `deadline` (epoch ms), never below `minMs` (default 1 s). No deadline → `ms`.
 * Use it for every Apify timeout of a call that must fit a tool's time budget.
 */
export function clampToDeadline(
  ms: number,
  deadline: number | undefined,
  minMs = 1_000
): number {
  if (deadline === undefined || !Number.isFinite(deadline)) return ms
  return Math.max(minMs, Math.min(ms, deadline - Date.now()))
}

/** Apify API tokens are "apify_api_<alnum>"; anything with other characters is never sent (header injection). */
const TOKEN_CHARS_RE = /^[A-Za-z0-9_]{10,200}$/

// ---------------------------------------------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------------------------------------------

let retryBaseMs = 500
/** tests: shorter backoff */
export function __setApifyRetryBaseMs(ms: number): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST)
    throw new Error("__setApifyRetryBaseMs is test-only")
  retryBaseMs = ms
}

/** exponential backoff with jitter: [base·2^(n-1), 2·base·2^(n-1)]; Retry-After (seconds) honoured when given */
function retryDelayMs(attempt: number, retryAfterSec: number | null): number {
  if (retryAfterSec !== null) return retryAfterSec * 1000
  const d = retryBaseMs * 2 ** (attempt - 1)
  return d + Math.random() * d
}

/**
 * Retry-After in seconds (delta-seconds form only), null when absent / empty / not a number - the exponential
 * backoff applies then (a missing header must never mean "retry at once").
 */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null
  const n = Number(raw.trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApifyError("aborted"))
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new ApifyError("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function readText(
  res: Response,
  max: number
): Promise<{ text: string; tooLarge: boolean }> {
  if (!res.body) return { text: "", tooLarge: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    size += r.value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      return { text: "", tooLarge: true }
    }
    chunks.push(r.value)
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false }
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------------------------

/** One attempt. Throws ApifyError for every failure (network, timeout, abort, HTTP error, unreadable body). */
async function attempt<T>(
  token: string | null,
  url: string,
  req: ApifyRequest,
  opts: ApifyCallOptions
): Promise<ApifyResponse<T>> {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, clampToDeadline(opts.timeoutMs ?? APIFY_TIMEOUTS.defaultMs, opts.deadline))
  const onAbort = () => ctrl.abort()
  if (opts.signal?.aborted) ctrl.abort()
  else opts.signal?.addEventListener("abort", onAbort, { once: true })
  const failure = () =>
    new ApifyError(
      opts.signal?.aborted && !timedOut
        ? "aborted"
        : timedOut
          ? "timeout"
          : "network"
    )
  try {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (token) headers.Authorization = `Bearer ${token}`
    let body: string | undefined
    if (req.body !== undefined) {
      body = JSON.stringify(req.body)
      headers["Content-Type"] = "application/json"
    }
    let res: Response
    try {
      res = await (opts.fetchImpl ?? fetch)(url, {
        method: req.method,
        headers,
        body,
        signal: ctrl.signal,
        // a redirect would carry the Authorization header to another URL
        redirect: "error",
        cache: "no-store",
      })
    } catch {
      // never forward the fetch error: its message / cause may include the URL
      throw failure()
    }
    let read: { text: string; tooLarge: boolean }
    try {
      read = await readText(
        res,
        res.ok ? (req.maxBytes ?? APIFY_MAX_BODY_BYTES) : ERROR_BODY_MAX
      )
    } catch {
      throw failure()
    }
    if (!res.ok) {
      const parsed = read.tooLarge ? null : parseJson(read.text)
      throw mapApifyError(res.status, parsed ?? null, {
        retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
      })
    }
    if (read.tooLarge)
      throw new ApifyError("response_too_large", { httpStatus: res.status })
    const parsed = parseJson(read.text)
    if (parsed === undefined)
      throw new ApifyError("invalid_response", { httpStatus: res.status })
    let data: unknown = parsed
    if (
      !req.raw &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "data" in parsed
    )
      data = (parsed as { data: unknown }).data
    return { status: res.status, data: data as T, headers: res.headers }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Call the Apify API. `token` null = anonymous (public Store / Actor endpoints only). Retries per ApifyRequest.retry;
 * every failure is an ApifyError (message without URL / token).
 */
export async function apifyRequest<T>(
  token: string | null,
  req: ApifyRequest,
  opts: ApifyCallOptions = {}
): Promise<ApifyResponse<T>> {
  if (token !== null && !TOKEN_CHARS_RE.test(token))
    throw new ApifyError("invalid_token")
  if (
    !req.path.startsWith("/v2/") ||
    req.path.includes("?") ||
    req.path.includes("#")
  )
    throw new ApifyError("bad_request", { hint: null })
  const base = opts.baseUrl ?? apifyApiBaseUrl()
  if (!base || !isSafeHttpsBaseUrl(base)) throw new ApifyError("config")
  const url = new URL(base.replace(/\/+$/, "") + req.path)
  for (const [k, v] of Object.entries(req.query ?? {})) {
    // the token travels in the Authorization header only
    if (k.toLowerCase() === "token")
      throw new Error("apify: token must not be sent as a query parameter")
    if (v === undefined || v === null) continue
    url.searchParams.set(
      k,
      typeof v === "boolean" ? (v ? "true" : "false") : String(v)
    )
  }
  const retries = (req.retry ?? req.method === "GET") ? DEFAULT_RETRIES : 0
  let slept = 0
  for (let n = 0; ; n++) {
    try {
      return await attempt<T>(token, url.toString(), req, opts)
    } catch (e) {
      const err = isApifyError(e) ? e : new ApifyError("network")
      // timeouts are not retried (the time is already spent); aborts never
      const again =
        n < retries &&
        (err.code === "rate_limited" ||
          err.code === "upstream" ||
          err.code === "network")
      if (!again) throw err
      const wait = retryDelayMs(n + 1, err.retryAfterSec)
      if (slept + wait > MAX_TOTAL_BACKOFF_MS) throw err
      // never sleep into the caller's deadline (the retry itself needs ≥ 1 s)
      if (opts.deadline !== undefined && Date.now() + wait + 1_000 > opts.deadline)
        throw err
      slept += wait
      await sleep(wait, opts.signal)
    }
  }
}
