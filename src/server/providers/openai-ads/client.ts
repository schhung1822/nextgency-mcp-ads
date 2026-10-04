// HTTP client for the OpenAI Ads Advertiser API (https://api.ads.openai.com/v1).
// - Authorization: Bearer <apiKey>. Never sends `OpenAI-Ad-Account` (partner/OAuth only).
// - Error object {error:{message,type,param,code}} + x-request-id → ProviderError.
// - Rate limits are enforced per ad account AND per IP (600/min per endpoint, 1,200/min overall), so the
//   buckets here are process-global (one VPS = one IP) and stay below the published limits.
// - Writes: creates carry a DETERMINISTIC Idempotency-Key (reused on every retry; never random, so a re-run of
//   the same confirmed action cannot duplicate); other writes are never retried blindly after 5xx/timeout -
//   `verify()` re-reads the object first (503 means "may have been saved"); a 409 on a non-create write is
//   re-read and re-merged via `rebuild()` instead of resending the stale body.
import { createHash } from "node:crypto"
import { ProviderError, type ProviderErrorCode } from "../errors"
import { httpJson, retryAfterMs, type HttpResponse } from "../http"
import { acquire, coolDown, RateLimitWaitError, sleep, type BucketSpec } from "../rate-limit"
import type { UpstreamEvent } from "../types"
import type { OpenAIAdsCredentials } from "./credentials"

export const PLATFORM = "openai_ads" as const

export function apiVersion(): string {
  return process.env.OPENAI_ADS_API_VERSION ?? "v1"
}

export function baseUrl(): string {
  return `https://api.ads.openai.com/${apiVersion()}`
}

/** Below the published 1,200 req/min overall limit (shared by every account on this IP). */
export const GLOBAL_BUCKET: BucketSpec = { ratePerSec: 1_100 / 60, burst: 20 }
/** Below the published 600 req/min per-endpoint limit. */
export const ENDPOINT_BUCKET: BucketSpec = { ratePerSec: 550 / 60, burst: 10 }
const GLOBAL_KEY = "openai_ads:ip"

export interface OpenAIAdsClientCtx {
  credentials: OpenAIAdsCredentials
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
}

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>

export interface OaRequest<T = unknown> {
  method: "GET" | "POST" | "DELETE"
  /** path below /v1, e.g. "/campaigns/cmpn_123" */
  path: string
  /** arrays are sent as repeated `key[]=value` (fields[], time_ranges[], filters[], include[]…) */
  query?: Record<string, QueryValue>
  body?: unknown
  /** create requests: sent as Idempotency-Key and reused on every retry */
  idempotencyKey?: string
  /** account-gated endpoint: 403/404 → feature_not_enabled */
  gated?: boolean
  /**
   * Non-create writes: called after a 5xx/timeout (the change may have been saved) with the body that was sent.
   * Return the re-read object when the change is visible (treated as success), or null to allow ONE retry.
   * Without verify, a non-create write is never retried after 5xx/timeout.
   */
  verify?: (sentBody: unknown) => Promise<T | null>
  /**
   * Non-create writes: on 409 (revision conflict) re-read the object and return a freshly merged body to send
   * once more, or null to give up. Without rebuild, a 409 on a non-create write is never resent.
   */
  rebuild?: () => Promise<unknown | null>
  /** POST endpoints that only read (e.g. /conversions/insights): retried like GET */
  readOnly?: boolean
  timeoutMs?: number
}

// Test hook: scale retry delays (0 in unit tests).
let delayScale = 1
export function __setRetryDelayScale(scale: number) {
  delayScale = scale
}

const STATIC_SEGMENTS = new Set([
  "campaigns",
  "ad_groups",
  "ads",
  "ad_account",
  "insights",
  "activate",
  "pause",
  "archive",
  "upload",
  "uploads",
  "geo_lookup",
  "search",
  "conversions",
  "event_settings",
  "custom_audiences",
  "spend_limit_windows",
  "bulk_mutation_jobs",
  "preview",
  "operations",
])

/** "/campaigns/cmpn_1/pause" → "/campaigns/{id}/pause" (rate-limit bucket + logs) */
export function routeTemplate(path: string): string {
  return path
    .split("/")
    .map((s) => (s === "" || STATIC_SEGMENTS.has(s) ? s : "{id}"))
    .join("/")
}

export function buildOaUrl(path: string, query?: Record<string, QueryValue>): string {
  const u = new URL(baseUrl() + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        const key = k.endsWith("[]") ? k : `${k}[]`
        for (const item of v as ReadonlyArray<string | number>) u.searchParams.append(key, String(item))
      } else {
        u.searchParams.set(k, String(v))
      }
    }
  }
  return u.toString()
}

/** Deterministic per-object key derived from a caller key (copy/create retries never duplicate). */
export function deriveIdempotencyKey(base: string, ...parts: string[]): string {
  return "adsmcp-" + createHash("sha256").update([base, ...parts].join("\u0000")).digest("hex").slice(0, 48)
}

/** JSON with sorted object keys (stable hash input). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v) ?? "null"
}

/**
 * Idempotency-Key for a create: derived from the caller's per-request key (mcp-core passes the pending-action id)
 * when present, otherwise from a hash of the account + tool + canonical input. Never random - a retried or
 * re-confirmed action must hit OpenAI's idempotency cache instead of creating a duplicate.
 */
export function createIdempotencyKey(accountId: string, tool: string, input: unknown, callerKey?: string | null): string {
  return callerKey ? deriveIdempotencyKey(callerKey, accountId, tool) : deriveIdempotencyKey("input", accountId, tool, canonicalJson(input))
}

interface OaErrorBody {
  error?: { message?: unknown; type?: unknown; param?: unknown; code?: unknown }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

const MAX_RATE_LIMIT_RETRIES = 3
const MAX_READ_5XX_RETRIES = 2
const MAX_CREATE_5XX_RETRIES = 2

export async function oaRequest<T>(ctx: OpenAIAdsClientCtx, req: OaRequest<T>): Promise<T> {
  const url = buildOaUrl(req.path, req.query)
  const template = `${req.method} ${routeTemplate(req.path)}`
  const isWrite = req.method !== "GET" && !req.readOnly
  const isCreate = req.idempotencyKey !== undefined
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.credentials.apiKey}` }
  if (req.idempotencyKey !== undefined) headers["Idempotency-Key"] = req.idempotencyKey

  let rateLimitRetries = 0
  let conflictRetries = 0
  let serverRetries = 0
  let verifiedRetry = false
  let body = req.body

  for (;;) {
    await takeTokens(template, ctx.signal)
    let res: HttpResponse<unknown>
    try {
      res = await httpJson<unknown>({
        platform: PLATFORM,
        method: req.method,
        url,
        headers,
        body,
        signal: ctx.signal,
        timeoutMs: req.timeoutMs,
        retries: 0,
        onUpstream: ctx.onUpstream,
        requestIdHeader: "x-request-id",
      })
    } catch (e) {
      // network failure / timeout: the request may or may not have reached OpenAI
      if (!(e instanceof ProviderError) || ctx.signal?.aborted) throw e
      const next = await afterServerFailure(e)
      if (next.done) return next.value as T
      continue
    }

    if (res.status >= 200 && res.status < 300) return res.body as T

    if (res.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      rateLimitRetries++
      const wait = retryAfterMs(res.headers) ?? 2_000 * 2 ** (rateLimitRetries - 1)
      coolDown(`openai_ads:ep:${template}`, wait)
      await sleep(scaled(wait), ctx.signal)
      continue // same Idempotency-Key
    }
    if (res.status === 409 && conflictRetries < 1) {
      if (isWrite && !isCreate) {
        // Revision conflict on an update: the object changed since it was read. Never resend the stale body -
        // re-read and re-merge (rebuild) once, or surface the conflict.
        if (!req.rebuild) throw mapOpenAIError(res, { gated: req.gated, path: req.path })
        conflictRetries++
        await sleep(scaled(500), ctx.signal)
        const next = await req.rebuild()
        if (next === null) throw mapOpenAIError(res, { gated: req.gated, path: req.path })
        body = next
        continue
      }
      // create (same Idempotency-Key) or read: idempotency conflict / transient "Ad Account is missing details"
      conflictRetries++
      await sleep(scaled(500), ctx.signal)
      continue
    }
    if (res.status >= 500) {
      const err = mapOpenAIError(res, { gated: req.gated, path: req.path })
      const next = await afterServerFailure(err)
      if (next.done) return next.value as T
      continue
    }
    throw mapOpenAIError(res, { gated: req.gated, path: req.path })
  }

  async function afterServerFailure(err: ProviderError): Promise<{ done: true; value: unknown } | { done: false }> {
    if (!isWrite) {
      if (serverRetries >= MAX_READ_5XX_RETRIES) throw err
      serverRetries++
      await sleep(scaled(1_000 * 2 ** (serverRetries - 1)), ctx.signal)
      return { done: false }
    }
    if (isCreate) {
      // Same Idempotency-Key: OpenAI returns the existing object if the first attempt was saved.
      // Retries exhausted: the object may exist → never retryable, verify first.
      if (serverRetries >= MAX_CREATE_5XX_RETRIES) throw maybeCreated(err)
      serverRetries++
      await sleep(scaled(1_000 * 2 ** (serverRetries - 1)), ctx.signal)
      return { done: false }
    }
    // Non-create write: never retry blindly - re-read first.
    if (!req.verify || verifiedRetry) throw maybeSaved(err)
    verifiedRetry = true
    await sleep(scaled(1_000), ctx.signal)
    const current = await req.verify(body)
    if (current !== null) return { done: true, value: current }
    return { done: false }
  }
}

function scaled(ms: number): number {
  return Math.max(0, Math.round(ms * delayScale))
}

async function takeTokens(template: string, signal?: AbortSignal) {
  try {
    await acquire(GLOBAL_KEY, GLOBAL_BUCKET, { signal })
    await acquire(`openai_ads:ep:${template}`, ENDPOINT_BUCKET, { signal })
  } catch (e) {
    if (e instanceof RateLimitWaitError) {
      throw new ProviderError({
        platform: PLATFORM,
        code: "rate_limited",
        message: `OpenAI Ads local rate limit busy (${e.key})`,
        userMessageVi: "Đang chạm giới hạn tốc độ gọi OpenAI Ads (dùng chung theo IP máy chủ). Thử lại sau ít phút.",
        retryable: true,
        retryAfterMs: e.retryAfterMs,
      })
    }
    throw e
  }
}

function maybeCreated(err: ProviderError): ProviderError {
  return new ProviderError({
    platform: PLATFORM,
    code: err.code,
    message: err.message,
    userMessageVi: "OpenAI Ads không xác nhận được việc tạo (lỗi máy chủ/hết thời gian sau nhiều lần thử) - đối tượng CÓ THỂ đã được tạo.",
    retryable: false,
    hint: "Có thể đã tạo - kiểm tra bằng ads_list_objects trước khi thử lại.",
    upstream: err.upstream,
    cause: err,
  })
}

function maybeSaved(err: ProviderError): ProviderError {
  return new ProviderError({
    platform: PLATFORM,
    code: err.code,
    message: err.message,
    userMessageVi:
      "OpenAI Ads không xác nhận được kết quả (lỗi máy chủ/hết thời gian) - thay đổi CÓ THỂ đã được lưu. Hãy xem lại đối tượng trước khi thử lại.",
    retryable: false,
    hint: "Gọi ads_get_object để kiểm tra trạng thái hiện tại trước khi thử lại.",
    upstream: err.upstream,
    cause: err,
  })
}

export function mapOpenAIError(
  res: Pick<HttpResponse<unknown>, "status" | "body" | "requestId" | "headers">,
  opts: { gated?: boolean; path?: string } = {}
): ProviderError {
  const body = (res.body && typeof res.body === "object" ? res.body : {}) as OaErrorBody
  const upstreamMessage = (str(body.error?.message) ?? (typeof res.body === "string" ? res.body : null))?.slice(0, 500) ?? null
  const upstreamCode = str(body.error?.code) ?? str(body.error?.type)
  const param = str(body.error?.param)
  const upstream = {
    code: upstreamCode,
    subcode: param,
    message: upstreamMessage,
    requestId: res.requestId,
    httpStatus: res.status,
  }
  const detail = upstreamMessage ? `: ${upstreamMessage}` : ""
  const make = (code: ProviderErrorCode, vi: string, extra: { retryable?: boolean; hint?: string; retryAfterMs?: number } = {}) =>
    new ProviderError({
      platform: PLATFORM,
      code,
      message: `OpenAI Ads HTTP ${res.status}${upstreamCode ? ` ${upstreamCode}` : ""}${detail}`,
      userMessageVi: vi,
      upstream,
      ...extra,
    })
  const msgLower = (upstreamMessage ?? "").toLowerCase()

  switch (true) {
    case res.status === 401:
      return make("auth_invalid", "API key OpenAI Ads không hợp lệ hoặc đã bị thu hồi. Hãy tạo key mới trong ads.openai.com → Settings và cập nhật kết nối.")
    case res.status === 403 && (opts.gated || msgLower.includes("not enabled")):
      return make("feature_not_enabled", `Tính năng này chưa được bật cho tài khoản OpenAI Ads${detail}.`, {
        hint: "Liên hệ đội OpenAI Ads để bật tính năng cho tài khoản.",
      })
    case res.status === 403:
      return make("permission_denied", `API key không có quyền thực hiện thao tác này${detail}.`, {
        hint: "API key phải do người có vai trò Admin trên tài khoản quảng cáo tạo.",
      })
    case res.status === 404 && opts.gated === true:
      return make("feature_not_enabled", "Tính năng này chưa được bật cho tài khoản OpenAI Ads (API trả 404).", {
        hint: "Liên hệ đội OpenAI Ads để bật tính năng cho tài khoản.",
      })
    case res.status === 404:
      return make("not_found", `Không tìm thấy đối tượng trên OpenAI Ads${detail}.`, {
        hint: "Gọi ads_list_objects để lấy đúng id.",
      })
    case res.status === 409:
      return make("conflict", `Xung đột khi cập nhật (dữ liệu đã thay đổi hoặc trùng Idempotency-Key)${detail}.`, {
        hint: "Đọc lại đối tượng rồi thử lại.",
      })
    case res.status === 413:
      return make("invalid_request", "Báo cáo quá lớn (vượt 2.000 dòng). Hãy thu hẹp khoảng ngày hoặc số đối tượng.", {
        hint: "Chia nhỏ khoảng ngày hoặc giảm entity_ids.",
      })
    case res.status === 422 && (upstreamCode === "budget_window_amount_below_spend" || /below.*spen|already spent|spent/.test(msgLower)):
      return make("invalid_request", "Không thể đặt ngân sách thấp hơn số tiền đã chi tiêu.", {
        hint: "Chọn mức ngân sách lớn hơn số đã chi (xem ads_get_report).",
      })
    case res.status === 422:
      return make("invalid_request", `OpenAI Ads từ chối thay đổi${detail}.`)
    case res.status === 400:
      return make("invalid_request", `Yêu cầu không hợp lệ${detail}.`)
    case res.status === 429:
      return make("rate_limited", "OpenAI Ads đang giới hạn tốc độ gọi API. Thử lại sau ít phút.", {
        retryable: true,
        retryAfterMs: retryAfterMs(res.headers) ?? undefined,
      })
    case res.status >= 500:
      return make("upstream_error", `OpenAI Ads đang gặp lỗi máy chủ (HTTP ${res.status}).`, { retryable: true })
    default:
      return make("unknown", `Lỗi không xác định từ OpenAI Ads (HTTP ${res.status})${detail}.`)
  }
}

export function isHttpStatus(e: unknown, status: number): e is ProviderError {
  return e instanceof ProviderError && e.upstream?.httpStatus === status
}

// ---------------------------------------------------------------------------
// Pagination helpers (resource lists: {object:"list", data, first_id, last_id, has_more})
// ---------------------------------------------------------------------------

export interface OaList<T> {
  object?: string
  data: T[]
  first_id?: string | null
  last_id?: string | null
  has_more?: boolean
}

/** Fetch every page (after=last_id) up to maxItems. */
export async function listAll<T>(
  ctx: OpenAIAdsClientCtx,
  path: string,
  query: Record<string, QueryValue>,
  opts: { maxItems?: number; gated?: boolean } = {}
): Promise<{ items: T[]; truncated: boolean }> {
  const max = opts.maxItems ?? 5_000
  const items: T[] = []
  let after: string | null = null
  for (;;) {
    const page: OaList<T> = await oaRequest<OaList<T>>(ctx, {
      method: "GET",
      path,
      query: { ...query, limit: 500, after: after ?? undefined },
      gated: opts.gated,
    })
    items.push(...(page.data ?? []))
    if (items.length >= max) return { items: items.slice(0, max), truncated: true }
    if (!page.has_more || !page.last_id || page.last_id === after) return { items, truncated: false }
    after = page.last_id
  }
}

// ---------------------------------------------------------------------------
// Opaque cursors
// ---------------------------------------------------------------------------

export function encodeCursor(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...data }), "utf8").toString("base64url")
}

export function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 1) return parsed as Record<string, unknown>
  } catch {
    // fallthrough
  }
  throw new ProviderError({
    platform: PLATFORM,
    code: "invalid_request",
    message: "Invalid cursor",
    userMessageVi: "Cursor phân trang không hợp lệ - hãy gọi lại từ trang đầu.",
  })
}

export function invalidRequest(message: string, userMessageVi: string, hint?: string): ProviderError {
  return new ProviderError({ platform: PLATFORM, code: "invalid_request", message, userMessageVi, hint })
}
