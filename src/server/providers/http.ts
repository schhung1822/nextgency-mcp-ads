// Generic JSON HTTP helper for platform adapters: timeout, abort, retry with jittered backoff,
// optional token bucket, upstream event reporting. Each adapter decides what is retryable and
// maps platform errors to ProviderError.
import { ProviderError } from "./errors"
import { acquire, sleep, type BucketSpec } from "./rate-limit"
import type { Platform, UpstreamEvent } from "./types"

export interface HttpRequest {
  platform: Platform
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  url: string
  headers?: Record<string, string>
  /** query params; arrays/objects are JSON-encoded unless already strings */
  query?: Record<string, unknown>
  /** JSON body (object) or raw body (FormData / URLSearchParams / string) */
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  /** number of retries after the first attempt (default 2) */
  retries?: number
  /** decide whether a response should be retried (default: 429 + 5xx) */
  retryOn?: (res: HttpResponse) => boolean | number
  /** rate limit bucket */
  bucket?: { key: string; spec: BucketSpec }
  onUpstream?: (e: UpstreamEvent) => void
  /** header name holding request id (x-fb-trace-id, x-request-id, request-id…) */
  requestIdHeader?: string
  /** strip these query keys from the URL reported in onUpstream (secrets) */
  redactQueryKeys?: string[]
}

export interface HttpResponse<T = unknown> {
  status: number
  headers: Headers
  body: T
  requestId: string | null
  durationMs: number
}

const DEFAULT_TIMEOUT = 60_000

export function buildUrl(base: string, query?: Record<string, unknown>): string {
  if (!query) return base
  const u = new URL(base)
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    u.searchParams.set(k, typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v))
  }
  return u.toString()
}

function safeUrl(url: string, redact: string[] = []): string {
  try {
    const u = new URL(url)
    for (const k of ["access_token", "appsecret_proof", "secret", "key", ...redact]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "[redacted]")
    }
    return u.toString()
  } catch {
    return "[invalid-url]"
  }
}

export async function httpJson<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
  const retries = req.retries ?? 2
  const url = buildUrl(req.url, req.query)
  let attempt = 0
  for (;;) {
    if (req.bucket) await acquire(req.bucket.key, req.bucket.spec, { signal: req.signal })
    const res = await once<T>(req, url)
    const decision = (req.retryOn ?? defaultRetryOn)(res as HttpResponse)
    if (decision && attempt < retries) {
      attempt++
      const base = typeof decision === "number" ? decision : retryAfterMs(res.headers) ?? 1_000 * 2 ** (attempt - 1)
      await sleep(Math.min(base + Math.random() * 400, 60_000), req.signal)
      continue
    }
    return res
  }
}

async function once<T>(req: HttpRequest, url: string): Promise<HttpResponse<T>> {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT)
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers }
  let body: BodyInit | undefined
  if (req.body !== undefined) {
    if (
      typeof req.body === "string" ||
      req.body instanceof FormData ||
      req.body instanceof URLSearchParams ||
      req.body instanceof Blob
    ) {
      body = req.body as BodyInit
    } else {
      body = JSON.stringify(req.body)
      headers["Content-Type"] ??= "application/json"
    }
  }
  const started = Date.now()
  let response: Response
  try {
    // never follow redirects: fetch would replay platform auth headers (Access-Token, developer-token,
    // Authorization on same-origin hops…) to wherever the Location points
    response = await fetch(url, { method: req.method, headers, body, signal, redirect: "manual" })
  } catch (e) {
    const durationMs = Date.now() - started
    req.onUpstream?.({ platform: req.platform, method: req.method, url: safeUrl(url, req.redactQueryKeys), status: 0, durationMs })
    const isTimeout = timeout.aborted && !req.signal?.aborted
    throw new ProviderError({
      platform: req.platform,
      code: isTimeout ? "timeout" : "upstream_error",
      message: `${req.method} ${safeUrl(url, req.redactQueryKeys)} failed: ${(e as Error).message}`,
      userMessageVi: isTimeout
        ? "Nền tảng quảng cáo phản hồi quá chậm (hết thời gian chờ)."
        : "Không kết nối được tới nền tảng quảng cáo.",
      retryable: true,
      cause: e,
    })
  }
  const durationMs = Date.now() - started
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined)
    req.onUpstream?.({ platform: req.platform, method: req.method, url: safeUrl(url, req.redactQueryKeys), status: response.status, durationMs })
    throw new ProviderError({
      platform: req.platform,
      code: "upstream_error",
      message: `${req.method} ${safeUrl(url, req.redactQueryKeys)} answered with a redirect (HTTP ${response.status}); redirects are not followed`,
      userMessageVi: "Nền tảng quảng cáo trả về chuyển hướng bất thường; yêu cầu đã bị dừng để bảo vệ token.",
      retryable: false,
    })
  }
  const text = await response.text()
  let parsed: unknown = text
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  } else parsed = null
  const requestId =
    (req.requestIdHeader && response.headers.get(req.requestIdHeader)) ||
    response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    response.headers.get("x-fb-trace-id") ||
    null
  req.onUpstream?.({
    platform: req.platform,
    method: req.method,
    url: safeUrl(url, req.redactQueryKeys),
    status: response.status,
    durationMs,
    requestId,
  })
  return { status: response.status, headers: response.headers, body: parsed as T, requestId, durationMs }
}

export function defaultRetryOn(res: HttpResponse): boolean {
  return res.status === 429 || res.status >= 500
}

export function retryAfterMs(headers: Headers): number | null {
  const v = headers.get("retry-after")
  if (!v) return null
  const secs = Number(v)
  if (Number.isFinite(secs)) return secs * 1000
  const date = Date.parse(v)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}
