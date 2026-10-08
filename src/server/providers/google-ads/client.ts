// Thin typed REST client for the Google Ads API (no gRPC / google-ads-api library).
// Every call goes through httpJson (timeout, retry, token bucket, upstream logging).
import { ProviderError } from "../errors"
import { httpJson, type HttpResponse } from "../http"
import { RateLimitWaitError } from "../rate-limit"
import type { UpstreamEvent } from "../types"
import { getToken } from "./auth"
import type { GoogleAdsCredentials } from "./credentials"
import { isExpiredTokenError, parseFailureDetails, parseGoogleError, retryDecision, toProviderError, errorCodeString, type GoogleAdsErrorItem } from "./errors"
import { normalizeCustomerId } from "./gaql"

export function apiVersion(): string {
  return process.env.GOOGLE_ADS_API_VERSION ?? "v25"
}

export function apiBase(): string {
  return `https://googleads.googleapis.com/${apiVersion()}/`
}

/** Fixed by Google (pageSize is not supported). */
export const SEARCH_PAGE_ROWS = 10_000
export const MAX_MUTATE_OPERATIONS = 10_000

export interface ClientContext {
  connectionId?: string
  credentials: GoogleAdsCredentials
  connectionMeta?: Record<string, unknown>
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
}

export interface ClientOptions {
  /** retries after the first attempt (default 3) */
  retries?: number
  /** max concurrent requests per customer (default 2) */
  perCustomerConcurrency?: number
}

/** A GAQL result row (lowerCamelCase JSON). Read with `field(row, "campaign_budget.amount_micros")`. */
export type GoogleAdsRow = Record<string, unknown>

export interface SearchPage {
  results: GoogleAdsRow[]
  nextPageToken: string | null
  totalResultsCount: number | null
  fieldMask: string | null
}

export interface OperationFailure {
  /** index of the failing operation in the request */
  index: number | null
  code: string | null
  message: string
}

export interface MutateResponse<R = Record<string, unknown>> {
  results: R[]
  failures: OperationFailure[]
  requestId: string | null
}

/** Hint attached to any create whose outcome is unknown (5xx / timeout / network error): never retry blindly. */
export const CREATE_MAYBE_DONE_HINT = "Có thể đã tạo - hãy kiểm tra trước khi thử lại."

export interface RequestOptions {
  method: "GET" | "POST"
  /** path after the version prefix, e.g. "customers/123/googleAds:search" */
  path: string
  body?: unknown
  /** customer the request targets (for login-customer-id resolution + rate limiting) */
  customerId?: string | null
  /** override login-customer-id (null = send none) */
  loginCustomerId?: string | null
  /** safe to retry on 5xx / timeout (reads, updates). Creates and removes are not (rule: no blind retry). */
  idempotent?: boolean
  /** non-idempotent write kind, for the "may have been applied" message (default create) */
  writeKind?: "create" | "remove"
}

// ---------------------------------------------------------------------------
// Per-customer concurrency limiter (Google recommends 1–2 concurrent requests per customer)
// ---------------------------------------------------------------------------

const slots = new Map<string, { active: number; queue: (() => void)[] }>()

async function withSlot<T>(key: string, max: number, fn: () => Promise<T>): Promise<T> {
  let s = slots.get(key)
  if (!s) {
    s = { active: 0, queue: [] }
    slots.set(key, s)
  }
  const slot = s
  if (slot.active >= max) await new Promise<void>((resolve) => slot.queue.push(resolve))
  slot.active++
  try {
    return await fn()
  } finally {
    slot.active--
    const next = slot.queue.shift()
    if (next) next()
    else if (slot.active === 0) slots.delete(key)
  }
}

// ---------------------------------------------------------------------------

/** snake_case GAQL path → value in the camelCase JSON row. */
export function field(row: unknown, path: string): unknown {
  let cur: unknown = row
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined
    const camel = seg.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    cur = (cur as Record<string, unknown>)[camel]
  }
  return cur
}

export function str(row: unknown, path: string): string | null {
  const v = field(row, path)
  return v === undefined || v === null ? null : String(v)
}

/** numeric metric: absent → `dflt` (Google omits zero values) */
export function numField(row: unknown, path: string, dflt: number | null = 0): number | null {
  const v = field(row, path)
  if (v === undefined || v === null || v === "") return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function resourceId(resourceName: string | null | undefined): string | null {
  if (!resourceName) return null
  const last = resourceName.split("/").pop() ?? ""
  return last || null
}

export class GoogleAdsClient {
  readonly creds: GoogleAdsCredentials
  private readonly ctx: ClientContext
  private readonly retries: number
  private readonly concurrency: number

  constructor(ctx: ClientContext, opts: ClientOptions = {}) {
    this.ctx = ctx
    this.creds = ctx.credentials
    this.retries = opts.retries ?? 3
    this.concurrency = opts.perCustomerConcurrency ?? 2
  }

  /**
   * login-customer-id to use for a customer: discovered map entry (root through which the account is reachable -
   * an account directly accessible outside the MCC tree maps to itself) → explicit MCC credential → none.
   * The explicit MCC is NOT forced on accounts the map says are reachable another way.
   */
  loginCustomerIdFor(customerId?: string | null): string | null {
    const map = this.ctx.connectionMeta?.login_customer_map
    if (customerId && map && typeof map === "object") {
      const v = (map as Record<string, unknown>)[customerId]
      if (typeof v === "string" && /^\d{10}$/.test(v)) return v
    }
    if (this.creds.login_customer_id) return this.creds.login_customer_id
    return null
  }

  async request<T>(o: RequestOptions): Promise<T> {
    return (await this.requestWithMeta<T>(o)).body
  }

  /** Like request() but also returns Google's `request-id` response header (for logs / mutate results). */
  async requestWithMeta<T>(o: RequestOptions): Promise<{ body: T; requestId: string | null }> {
    const cid = o.customerId ? normalizeCustomerId(o.customerId) : null
    const login = o.loginCustomerId !== undefined ? o.loginCustomerId : this.loginCustomerIdFor(cid)
    const run = () => this.send<T>(o, cid, login)
    try {
      return cid ? await withSlot(`google_ads:${cid}`, this.concurrency, run) : await run()
    } catch (e) {
      if (e instanceof RateLimitWaitError) {
        throw new ProviderError({
          platform: "google_ads",
          code: "rate_limited",
          message: e.message,
          userMessageVi: "Đang có quá nhiều yêu cầu tới tài khoản Google Ads này, thử lại sau ít giây.",
          retryable: true,
          retryAfterMs: e.retryAfterMs,
        })
      }
      throw e
    }
  }

  private async send<T>(o: RequestOptions, cid: string | null, login: string | null): Promise<{ body: T; requestId: string | null }> {
    const idempotent = o.idempotent ?? true
    let refreshed = false
    for (;;) {
      const token = await getToken(this.creds, {
        connectionId: this.ctx.connectionId,
        signal: this.ctx.signal,
        onUpstream: this.ctx.onUpstream,
        forceRefresh: refreshed,
      })
      const headers: Record<string, string> = { Authorization: `Bearer ${token.accessToken}` }
      if (login) headers["login-customer-id"] = login.replace(/-/g, "")
      // No developer-token header: optional and ignored since 2026-09-09, Google announced it will start rejecting
      // developer tokens in a future major version (providers/google-ads.md §1.1). Old stored values are ignored.
      let res: HttpResponse<unknown>
      try {
        res = await httpJson<unknown>({
          platform: "google_ads",
          method: o.method,
          url: apiBase() + o.path,
          headers,
          body: o.body,
          signal: this.ctx.signal,
          onUpstream: this.ctx.onUpstream,
          requestIdHeader: "request-id",
          retries: this.retries,
          bucket: cid ? { key: `google_ads:customer:${cid}`, spec: { ratePerSec: 4, burst: 4 } } : undefined,
          retryOn: (r) => (r.status < 400 ? false : retryDecision(parseGoogleError(r.status, r.body, r.requestId), idempotent)),
        })
      } catch (e) {
        // Network error / timeout: for non-idempotent writes the create may have happened (caller checks existence).
        if (e instanceof ProviderError && !idempotent) throw maybeCreated(e, o.writeKind)
        throw e
      }
      if (res.status >= 200 && res.status < 300) return { body: res.body as T, requestId: res.requestId }
      const parsed = parseGoogleError(res.status, res.body, res.requestId)
      if (!refreshed && isExpiredTokenError(parsed)) {
        refreshed = true
        continue
      }
      const err = toProviderError(parsed)
      // 5xx on a create: Google may have applied it before failing → never retryable, verify first.
      if (!idempotent && (res.status >= 500 || err.code === "timeout" || err.code === "upstream_error")) throw maybeCreated(err, o.writeKind)
      throw err
    }
  }

  // -------------------------------------------------------------------------

  async listAccessibleCustomers(): Promise<string[]> {
    const body = await this.request<{ resourceNames?: string[] }>({
      method: "GET",
      path: "customers:listAccessibleCustomers",
      loginCustomerId: null,
    })
    return (body?.resourceNames ?? []).map((r) => resourceId(r)).filter((x): x is string => !!x)
  }

  /** One page of googleAds:search (fixed 10,000 rows/page; pageSize is not sent). */
  async search(customerId: string, query: string, pageToken?: string | null, opts: { loginCustomerId?: string | null; totalCount?: boolean } = {}): Promise<SearchPage> {
    const body: Record<string, unknown> = { query }
    if (pageToken) body.pageToken = pageToken
    if (opts.totalCount) body.searchSettings = { returnTotalResultsCount: true }
    const cid = normalizeCustomerId(customerId)
    const r = await this.request<{ results?: GoogleAdsRow[]; nextPageToken?: string; totalResultsCount?: string; fieldMask?: string }>({
      method: "POST",
      path: `customers/${cid}/googleAds:search`,
      body,
      customerId: cid,
      loginCustomerId: opts.loginCustomerId,
    })
    return {
      results: r?.results ?? [],
      nextPageToken: r?.nextPageToken || null,
      totalResultsCount: r?.totalResultsCount ? Number(r.totalResultsCount) : null,
      fieldMask: r?.fieldMask ?? null,
    }
  }

  /** Follow pages until maxRows (next pages are free of quota). */
  async searchAll(customerId: string, query: string, opts: { maxRows?: number; loginCustomerId?: string | null } = {}): Promise<{ rows: GoogleAdsRow[]; truncated: boolean }> {
    const max = opts.maxRows ?? 50_000
    const rows: GoogleAdsRow[] = []
    let token: string | null = null
    do {
      const page = await this.search(customerId, query, token, { loginCustomerId: opts.loginCustomerId })
      rows.push(...page.results)
      token = page.nextPageToken
      if (rows.length >= max) return { rows: rows.slice(0, max), truncated: rows.length > max || !!token }
    } while (token)
    return { rows, truncated: false }
  }

  /** `customers/{cid}/{service}:mutate` (campaigns, campaignBudgets, adGroups, adGroupAds, adGroupCriteria, campaignCriteria, ads, assets). */
  async mutate<R = Record<string, unknown>>(
    customerId: string,
    service: string,
    operations: Record<string, unknown>[],
    opts: { validateOnly?: boolean; partialFailure?: boolean; responseContentType?: "RESOURCE_NAME_ONLY" | "MUTABLE_RESOURCE"; idempotent?: boolean } = {}
  ): Promise<MutateResponse<R>> {
    if (!/^[a-zA-Z]+$/.test(service)) throw new Error(`Invalid service ${service}`)
    assertOpCount(operations.length)
    const cid = normalizeCustomerId(customerId)
    const body: Record<string, unknown> = { operations }
    if (opts.partialFailure) body.partialFailure = true
    if (opts.validateOnly) body.validateOnly = true
    if (opts.responseContentType) body.responseContentType = opts.responseContentType
    const hasCreate = operations.some((op) => "create" in op)
    // a remove retried after Google applied it fails ("already removed") → no blind retry; deleteObject re-reads status
    const hasRemove = operations.some((op) => "remove" in op)
    const { body: r, requestId } = await this.requestWithMeta<{
      results?: R[]
      partialFailureError?: { details?: Record<string, unknown>[]; message?: string }
    }>({
      method: "POST",
      path: `customers/${cid}/${service}:mutate`,
      body,
      customerId: cid,
      // validateOnly never changes anything → safe to retry
      idempotent: opts.idempotent ?? (opts.validateOnly ? true : !hasCreate && !hasRemove),
      writeKind: hasRemove && !hasCreate ? "remove" : "create",
    })
    return { results: r?.results ?? [], failures: parsePartialFailure(r?.partialFailureError), requestId }
  }

  /** `customers/{cid}/googleAds:mutate` - multi-resource, atomic unless partialFailure; supports temp (negative) ids. */
  async googleAdsMutate(
    customerId: string,
    mutateOperations: Record<string, unknown>[],
    opts: { validateOnly?: boolean; partialFailure?: boolean; idempotent?: boolean } = {}
  ): Promise<MutateResponse<Record<string, unknown>>> {
    assertOpCount(mutateOperations.length)
    const cid = normalizeCustomerId(customerId)
    const body: Record<string, unknown> = { mutateOperations }
    if (opts.partialFailure) body.partialFailure = true
    if (opts.validateOnly) body.validateOnly = true
    const { body: r, requestId } = await this.requestWithMeta<{
      mutateOperationResponses?: Record<string, unknown>[]
      partialFailureError?: { details?: Record<string, unknown>[]; message?: string }
    }>({
      method: "POST",
      path: `customers/${cid}/googleAds:mutate`,
      body,
      customerId: cid,
      idempotent: opts.idempotent ?? !!opts.validateOnly,
    })
    return { results: r?.mutateOperationResponses ?? [], failures: parsePartialFailure(r?.partialFailureError), requestId }
  }

  /** Unscoped POST (e.g. geoTargetConstants:suggest). */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "POST", path, body, loginCustomerId: null })
  }
}

/** Re-throw an uncertain create/remove failure as non-retryable with a verify-before-retry hint. */
function maybeCreated(e: ProviderError, kind: "create" | "remove" = "create"): ProviderError {
  return new ProviderError({
    platform: "google_ads",
    code: e.code,
    message: e.message,
    userMessageVi: `${e.userMessageVi} Thao tác ${kind === "remove" ? "xoá" : "tạo"} có thể đã được thực hiện.`,
    retryable: false,
    hint: kind === "remove" ? "Có thể đã xoá - kiểm tra trạng thái (ads_get_object) trước khi thử lại." : CREATE_MAYBE_DONE_HINT,
    upstream: e.upstream,
    cause: e,
  })
}

function assertOpCount(n: number) {
  if (n === 0) {
    throw new ProviderError({ platform: "google_ads", code: "invalid_request", message: "No operations", userMessageVi: "Không có thao tác nào để thực hiện." })
  }
  if (n > MAX_MUTATE_OPERATIONS) {
    throw new ProviderError({
      platform: "google_ads",
      code: "invalid_request",
      message: `Too many operations: ${n}`,
      userMessageVi: `Quá nhiều thao tác trong 1 yêu cầu (${n} > ${MAX_MUTATE_OPERATIONS}).`,
    })
  }
}

export function parsePartialFailure(err: { details?: Record<string, unknown>[]; message?: string } | undefined | null): OperationFailure[] {
  if (!err) return []
  const { errors } = parseFailureDetails(err.details)
  if (!errors.length) return err.message ? [{ index: null, code: null, message: err.message }] : []
  return errors.map((e: GoogleAdsErrorItem) => {
    const first = e.location?.fieldPathElements?.[0]
    return { index: typeof first?.index === "number" ? first.index : null, code: errorCodeString(e.errorCode), message: e.message ?? "" }
  })
}
