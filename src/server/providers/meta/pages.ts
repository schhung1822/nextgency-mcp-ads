// Facebook Pages (read only): Page list for the connection sync, Page access tokens, posts, Post / Page Insights.
// Spec: .claude/docs/providers/meta.md §10 (tested live 2026-10-03) and .claude/docs/11-meta-pages.md.
// Page tokens live ONLY in this process memory (never stored, logged or returned).
import { createHash } from "node:crypto"
import { LRUCache } from "lru-cache"
import {
  addDays,
  daysBetweenInclusive,
  isIsoDate,
  splitRange,
  todayInTz,
} from "../dates"
import { sanitizeExternalLabel } from "../../../lib/text-safety"
import { isProviderError, ProviderError } from "../errors"
import type {
  ConnectionContext,
  PageInfo,
  PageListResult,
  PageSource,
} from "../types"
import {
  graph,
  graphBatch,
  type GraphParams,
  type MetaCallContext,
  type MetaCredentials,
} from "./client"
import { forgetAdvertisablePages } from "./lookup"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Page Insights day boundaries are America/Los_Angeles midnights (tested live, meta.md §10.5). */
export const PAGE_INSIGHTS_TZ = "America/Los_Angeles"
/** Dates of `since`/`until` filters on posts are read in this zone (the app's display zone). */
export const POSTS_TZ = "Asia/Ho_Chi_Minh"
/** Meta accepts ≤ 93 days per insights request; 90 keeps a margin. */
const INSIGHTS_CHUNK_DAYS = 90
/** How far back Page Insights go (Meta keeps 2 years). */
export const PAGE_INSIGHTS_MAX_DAYS = 730
const MAX_PAGES = 2_000
const MAX_BUSINESSES = 50
export const MESSAGE_PREVIEW_CHARS = 500

export const PAGE_TASKS = [
  "ANALYZE",
  "ADVERTISE",
  "CREATE_CONTENT",
  "MANAGE",
  "MODERATE",
  "MESSAGING",
  "MANAGE_LEADS",
] as const

/** Page metrics live in v26 (meta.md §10.5 whitelist). */
export const PAGE_METRICS = [
  "page_media_view",
  "page_total_media_view_unique",
  "page_post_engagements",
  "page_total_actions",
  "page_views_total",
  "page_follows",
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_actions_post_reactions_total",
  "page_video_views",
  "page_video_views_paid",
  "page_video_views_organic",
  "page_video_complete_views_30s",
  "page_video_view_time",
] as const
export type PageMetric = (typeof PAGE_METRICS)[number]

/** Metrics that only support period=day (requesting week/days_28 is an error). */
const DAY_ONLY_PAGE_METRICS = new Set<PageMetric>([
  "page_follows",
  "page_actions_post_reactions_total",
  "page_video_view_time",
])

/** Daily values that can be summed over a range (follower count and unique viewers cannot). */
const ADDITIVE_PAGE_METRICS = new Set<PageMetric>([
  "page_media_view",
  "page_post_engagements",
  "page_total_actions",
  "page_views_total",
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_video_views",
  "page_video_views_paid",
  "page_video_views_organic",
  "page_video_complete_views_30s",
  "page_video_view_time",
])

export const PAGE_METRIC_PRESETS: Record<"overview" | "video", PageMetric[]> = {
  overview: [
    "page_media_view",
    "page_total_media_view_unique",
    "page_post_engagements",
    "page_total_actions",
    "page_views_total",
    "page_follows",
    "page_daily_follows_unique",
    "page_daily_unfollows_unique",
  ],
  video: [
    "page_video_views",
    "page_video_views_paid",
    "page_video_views_organic",
    "page_video_complete_views_30s",
    "page_video_view_time",
  ],
}

/** Post metrics live in v26 (lifetime). */
export const POST_METRICS = [
  "post_media_view",
  "post_total_media_view_unique",
  "post_clicks",
  "post_clicks_by_type",
  "post_reactions_by_type_total",
  "post_activity_by_action_type",
  "post_video_views",
  "post_video_views_organic",
  "post_video_views_paid",
  "post_video_view_time",
  "post_video_avg_time_watched",
  "post_video_length",
  "post_video_complete_views_organic",
  "post_video_complete_views_paid",
] as const
export type PostMetric = (typeof POST_METRICS)[number]

export const POST_METRIC_PRESETS: Record<
  "basic" | "video" | "all",
  PostMetric[]
> = {
  basic: [
    "post_media_view",
    "post_total_media_view_unique",
    "post_clicks",
    "post_clicks_by_type",
    "post_reactions_by_type_total",
  ],
  video: [
    "post_video_views",
    "post_video_views_organic",
    "post_video_views_paid",
    "post_video_view_time",
    "post_video_avg_time_watched",
    "post_video_length",
    "post_video_complete_views_organic",
    "post_video_complete_views_paid",
  ],
  all: [...POST_METRICS],
}

export type PostSourceKind = "published" | "feed" | "ads" | "scheduled"
const POST_EDGE: Record<PostSourceKind, string> = {
  published: "published_posts",
  feed: "feed",
  ads: "ads_posts",
  scheduled: "scheduled_posts",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function s(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v)
  return null
}

function callCtxOf(
  ctx: ConnectionContext<MetaCredentials>,
  pageId?: string
): MetaCallContext {
  return {
    credentials: ctx.credentials,
    pageId: pageId ?? null,
    signal: ctx.signal,
    onUpstream: ctx.onUpstream,
  }
}

function invalid(vi: string, hint?: string): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "invalid_request",
    message: `meta pages: ${vi}`,
    userMessageVi: vi,
    hint,
  })
}

export function isPageId(v: string): boolean {
  return /^\d{1,30}$/.test(v)
}

/** "PAGEID_POSTID" - the Page part must be the given Page (posts of other Pages are out of scope). */
export function postBelongsToPage(postId: string, pageId: string): boolean {
  const m = /^(\d{1,30})_(\d{1,30})$/.exec(postId)
  return !!m && m[1] === pageId
}

/** Strip the `PROFILE_PLUS_` prefix of client_pages.permitted_tasks, keep known tasks, stable order. */
export function normalizePageTasks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const set = new Set(
    raw.map((t) =>
      s(t)
        .toUpperCase()
        .replace(/^PROFILE_PLUS_/, "")
    )
  )
  return PAGE_TASKS.filter((t) => set.has(t))
}

export interface PageCapabilities {
  posts: boolean
  insights: boolean
  adsPosts: boolean
}

export function pageCapabilities(tasks: readonly string[]): PageCapabilities {
  const has = (t: string) => tasks.includes(t)
  return {
    posts: has("CREATE_CONTENT") || has("MANAGE") || has("MODERATE"),
    insights: has("ANALYZE"),
    adsPosts: has("ADVERTISE"),
  }
}

function cut(
  text: unknown,
  max: number
): { text: string | null; truncated: boolean } {
  if (typeof text !== "string") return { text: null, truncated: false }
  return text.length > max
    ? { text: `${text.slice(0, max)}…`, truncated: true }
    : { text, truncated: false }
}

/** "YYYY-MM-DD" (00:00 in tz) → unix seconds. tz is a fixed-offset or IANA zone. */
function startOfDayUnix(day: string, tz: string): number {
  // walk from UTC midnight to the instant whose local date/time in tz is day 00:00
  const utc = Date.parse(`${day}T00:00:00Z`)
  const offsetMin = tzOffsetMinutes(new Date(utc), tz)
  let t = utc - offsetMin * 60_000
  // DST edge: recompute with the offset at the candidate instant
  const offset2 = tzOffsetMinutes(new Date(t), tz)
  if (offset2 !== offsetMin) t = utc - offset2 * 60_000
  return Math.floor(t / 1000)
}

function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  )
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000)
}

/** Calendar date (YYYY-MM-DD) of an instant in tz. */
function dateInTz(at: Date, tz: string): string {
  return todayInTz(tz, at)
}

/**
 * Page Insights `end_time` → the day the value belongs to. A daily value ends at the NEXT LA midnight
 * (e.g. 2026-09-26T07:00:00+0000 = 2026-09-26 00:00 PDT → day 2026-09-25).
 */
export function insightDayFromEndTime(endTime: string): string | null {
  const t = Date.parse(endTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
  if (!Number.isFinite(t)) return null
  return dateInTz(new Date(t - 1), PAGE_INSIGHTS_TZ)
}

function isInvalidMetricError(e: unknown): boolean {
  return (
    isProviderError(e) &&
    e.code === "invalid_request" &&
    /valid insights metric/i.test(String(e.upstream?.message ?? e.message))
  )
}

// ---------------------------------------------------------------------------
// Page list (connection sync)
// ---------------------------------------------------------------------------

const PAGE_FIELDS =
  "id,name,category,link,picture{url},followers_count,fan_count,verification_status,is_published"

async function listAll(
  call: MetaCallContext,
  path: string,
  params: GraphParams,
  max: number
): Promise<Raw[]> {
  const out: Raw[] = []
  let after: string | undefined
  for (;;) {
    const page = await graph<{
      data?: Raw[]
      paging?: { next?: string; cursors?: { after?: string } }
    }>(call, {
      method: "GET",
      path,
      params: after ? { ...params, after } : params,
      idempotent: true,
    })
    out.push(...(Array.isArray(page.data) ? page.data : []))
    after = page.paging?.next ? page.paging.cursors?.after : undefined
    if (!after || out.length >= max) return out.slice(0, max)
  }
}

function toPageInfo(
  p: Raw,
  source: PageSource,
  business: { id: string; name: string } | null,
  tasks: unknown
): PageInfo {
  const picture = (p.picture as { data?: { url?: unknown } } | undefined)?.data
    ?.url
  return {
    externalId: s(p.id),
    name: s(p.name) || s(p.id),
    category: s(p.category) || null,
    link: s(p.link) || null,
    pictureUrl: s(picture) || null,
    followersCount: num(p.followers_count) ?? num(p.fan_count),
    verificationStatus: s(p.verification_status) || null,
    isPublished: typeof p.is_published === "boolean" ? p.is_published : null,
    tasks: normalizePageTasks(tasks),
    sources: [source],
    businessId: business?.id ?? null,
    businessName: business?.name ?? null,
  }
}

function mergePage(into: PageInfo, add: PageInfo): void {
  for (const src of add.sources)
    if (!into.sources.includes(src)) into.sources.push(src)
  if (into.tasks.length === 0 && add.tasks.length) into.tasks = add.tasks
  into.businessId ??= add.businessId
  into.businessName ??= add.businessName
  into.followersCount ??= add.followersCount
  into.pictureUrl ??= add.pictureUrl
  into.link ??= add.link
  into.category ??= add.category
}

/** Pages of the token: /me/accounts + (business_management) every BM's owned_pages / client_pages. Never throws. */
export async function listMetaPages(
  ctx: ConnectionContext<MetaCredentials>
): Promise<PageListResult> {
  const call = callCtxOf(ctx)
  const warnings: string[] = []
  const byId = new Map<string, PageInfo>()
  const add = (p: PageInfo) => {
    if (!isPageId(p.externalId)) return
    const cur = byId.get(p.externalId)
    if (cur) mergePage(cur, p)
    else if (byId.size < MAX_PAGES) byId.set(p.externalId, p)
  }

  try {
    const mine = await listAll(
      call,
      "me/accounts",
      { fields: `${PAGE_FIELDS},tasks`, limit: 100 },
      MAX_PAGES
    )
    for (const p of mine) add(toPageInfo(p, "me_accounts", null, p.tasks))
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid")
      return { ok: false, pages: [], warnings: [e.userMessageVi] }
    const reason =
      isProviderError(e) && e.code === "permission_denied"
        ? "token thiếu quyền pages_show_list"
        : "Meta trả lỗi"
    return {
      ok: false,
      pages: [],
      warnings: [`Không đọc được danh sách Trang (${reason}).`],
    }
  }

  let businesses: Raw[] = []
  try {
    businesses = await listAll(
      call,
      "me/businesses",
      { fields: "id,name", limit: 100 },
      MAX_BUSINESSES
    )
  } catch (e) {
    // without business_management the BM step is skipped; /me/accounts alone is still a valid list
    if (!(
      isProviderError(e) &&
      ["permission_denied", "invalid_request"].includes(e.code)
    )) {
      warnings.push(
        "Không đọc được danh sách Business Manager - chỉ có Trang via quản lý trực tiếp."
      )
    }
  }
  for (const b of businesses) {
    // enough Pages already: stop calling Meta (bounded sync cost)
    if (byId.size >= MAX_PAGES) break
    const business = { id: s(b.id), name: s(b.name) }
    if (!isPageId(business.id)) continue
    for (const [edge, source] of [
      ["owned_pages", "owned_pages"],
      ["client_pages", "client_pages"],
    ] as const) {
      try {
        const fields =
          source === "client_pages"
            ? `${PAGE_FIELDS},permitted_tasks`
            : PAGE_FIELDS
        const rows = await listAll(
          call,
          `${business.id}/${edge}`,
          { fields, limit: 100 },
          MAX_PAGES
        )
        for (const p of rows)
          add(toPageInfo(p, source, business, p.permitted_tasks))
      } catch {
        warnings.push(`Không đọc được Trang của BM "${business.name}".`)
      }
    }
  }
  if (byId.size >= MAX_PAGES)
    warnings.push(`Chỉ đồng bộ ${MAX_PAGES} Trang đầu tiên.`)
  const pages = [...byId.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId)
  )
  return { ok: true, pages, warnings }
}

// ---------------------------------------------------------------------------
// Page access tokens (memory only)
// ---------------------------------------------------------------------------

/** Page tokens never reach the DB or logs; keep the in-memory copy short-lived (05-security.md §4). */
export const PAGE_TOKEN_TTL_MS = 5 * 60_000
const g = globalThis as unknown as {
  __adsMcpMetaPageTokens?: LRUCache<string, string>
}
function tokenCache() {
  g.__adsMcpMetaPageTokens ??= new LRUCache<string, string>({
    max: 1_000,
    ttl: PAGE_TOKEN_TTL_MS,
  })
  return g.__adsMcpMetaPageTokens
}

/** Keyed by a hash of (user token, Page): replacing the connection token naturally misses the cache. */
function tokenKey(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string
): string {
  const key = createHash("sha256")
    .update(`${ctx.credentials.accessToken}\u0000${pageId}`)
    .digest("hex")
  if (ctx.connectionId) {
    const keys = keysByConnection.get(ctx.connectionId) ?? new Set<string>()
    keys.add(key)
    keysByConnection.set(ctx.connectionId, keys)
    if (keysByConnection.size > 10_000) keysByConnection.clear()
  }
  return key
}

/** connection id → cache keys, so a disabled / deleted / re-tokened connection drops its Page tokens at once */
const keysByConnection: Map<string, Set<string>> = ((
  globalThis as unknown as {
    __adsMcpMetaPageTokenKeys?: Map<string, Set<string>>
  }
).__adsMcpMetaPageTokenKeys ??= new Map())

/**
 * Forget every cached Page token of a connection (call when it is disabled, deleted or gets new credentials). Also
 * drops its cached advertisable-Page lists (lookup.ts, D4) - one call site for every Page cache of the connection.
 */
export function forgetPageTokens(connectionId: string) {
  for (const key of keysByConnection.get(connectionId) ?? [])
    tokenCache().delete(key)
  keysByConnection.delete(connectionId)
  forgetAdvertisablePages(connectionId)
}

export function __clearPageTokenCache() {
  tokenCache().clear()
  keysByConnection.clear()
}

/** What a Page call was trying to read: picks the permissions named in a Graph permission error (B7). */
export type PageAccessKind = "posts" | "insights" | "token"

const PAGE_PERMISSION_TEXT: Record<PageAccessKind, string> = {
  posts:
    "Token / via không có quyền đọc bài viết của Trang này (cần quyền pages_read_engagement + pages_read_user_content và via có vai trò Tạo nội dung / Quản lý / Kiểm duyệt trên Trang).",
  insights:
    "Token / via không có quyền xem chỉ số của Trang này (cần quyền read_insights + pages_read_engagement và via có task Phân tích - ANALYZE trên Trang).",
  token:
    "Token / via không lấy được quyền truy cập Trang này (cần quyền pages_show_list + pages_read_engagement và via có vai trò trên Trang).",
}
const PAGE_PERMISSION_HINT =
  "Thêm quyền còn thiếu vào token (Graph API Explorer → tạo token mới → “Thay token” ở trang Kết nối) hoặc gán task cho via trên Trang / trong Business Manager, rồi bấm Đồng bộ lại. Lỗi này không liên quan quyền ads_management của tài khoản quảng cáo."

/**
 * A Graph permission error (#10 / #200-299 / #294) on a Page call carries the global ads hint ("ads_management").
 * Re-word it with the Page permissions / tasks that call really needs (B7). Other errors - including the Page role
 * errors this module raises itself (no upstream Graph code) - pass through untouched.
 */
export function pagePermissionError(e: unknown, kind: PageAccessKind): unknown {
  if (!isProviderError(e) || e.code !== "permission_denied") return e
  // already re-worded closer to the failing call (e.g. the Page token fetch inside a posts read): keep that text
  if (pagePermissionErrors.has(e)) return e
  const c = Number(e.upstream?.code)
  if (!(c === 10 || c === 294 || (c >= 200 && c <= 299))) return e
  const metaSays = sanitizeExternalLabel(e.upstream?.message ?? "", 200)
  const out = new ProviderError({
    platform: "meta",
    code: "permission_denied",
    message: e.message,
    userMessageVi:
      PAGE_PERMISSION_TEXT[kind] + (metaSays ? ` Meta báo: ${metaSays}` : ""),
    hint: PAGE_PERMISSION_HINT,
    upstream: e.upstream,
    retryAfterMs: e.retryAfterMs,
    cause: e,
  })
  pagePermissionErrors.add(out)
  return out
}
const pagePermissionErrors = new WeakSet<ProviderError>()

async function pageToken(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  refresh = false
): Promise<string> {
  const key = tokenKey(ctx, pageId)
  if (!refresh) {
    const hit = tokenCache().get(key)
    if (hit) return hit
  }
  let r: { access_token?: unknown }
  try {
    r = await graph<{ access_token?: unknown }>(callCtxOf(ctx, pageId), {
      method: "GET",
      path: pageId,
      params: { fields: "access_token" },
      idempotent: true,
    })
  } catch (e) {
    throw pagePermissionError(e, "token")
  }
  const token = typeof r.access_token === "string" ? r.access_token : ""
  if (!token) {
    throw new ProviderError({
      platform: "meta",
      code: "permission_denied",
      message: `meta pages: no page access token for ${pageId}`,
      userMessageVi:
        "Via của kết nối không có vai trò trên Trang này nên không đọc được bài viết/chỉ số.",
      hint: "Thêm via làm quản trị viên/biên tập viên của Trang (hoặc gán task cho via trong Business Manager) rồi đồng bộ lại.",
    })
  }
  tokenCache().set(key, token)
  return token
}

/**
 * Run `fn` with the Page token. A cached Page token Meta rejects (190) is dropped and fetched again ONCE with the
 * USER token - a dead user token therefore surfaces as auth_invalid from that fetch (the connection really is
 * invalid). When a freshly fetched Page token is still rejected, the problem is the via's role on that Page:
 * reported as permission_denied, never as a dead connection (a Page admin removing the via must not take every
 * ad tool of the connection down).
 */
async function withPageToken<T>(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  fn: (token: string) => Promise<T>,
  kind: PageAccessKind
): Promise<T> {
  try {
    return await withPageTokenRaw(ctx, pageId, fn)
  } catch (e) {
    throw pagePermissionError(e, kind)
  }
}

async function withPageTokenRaw<T>(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const isAuth = (e: unknown) => isProviderError(e) && e.code === "auth_invalid"
  try {
    return await fn(await pageToken(ctx, pageId))
  } catch (e) {
    if (!isAuth(e)) throw e
    tokenCache().delete(tokenKey(ctx, pageId))
  }
  // outside any catch: an auth_invalid here comes from the USER token and must propagate as is
  const fresh = await pageToken(ctx, pageId, true)
  try {
    return await fn(fresh)
  } catch (e2) {
    if (!isAuth(e2)) throw e2
    tokenCache().delete(tokenKey(ctx, pageId))
    throw new ProviderError({
      platform: "meta",
      code: "permission_denied",
      message: `meta pages: page token rejected for ${pageId}`,
      userMessageVi:
        "Meta từ chối quyền truy cập Trang này (via có thể đã mất vai trò trên Trang).",
      hint: "Kiểm tra vai trò của via trên Trang rồi đồng bộ lại kết nối.",
      upstream: isProviderError(e2) ? e2.upstream : undefined,
    })
  }
}

/** GET a Page-token edge (see withPageToken for the token retry rules). */
async function pageGet<T>(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  path: string,
  params: GraphParams,
  kind: PageAccessKind
): Promise<T> {
  const call = callCtxOf(ctx, pageId)
  return withPageToken(
    ctx,
    pageId,
    (token) =>
      graph<T>(call, {
        method: "GET",
        path,
        params,
        idempotent: true,
        pageAccessToken: token,
      }),
    kind
  )
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export interface PagePostSummary {
  postId: string
  createdTime: string | null
  message: string | null
  messageTruncated: boolean
  permalinkUrl: string | null
  fullPicture: string | null
  mediaType: string | null
  statusType: string | null
  isPublished: boolean | null
  isHidden: boolean | null
  promotableId: string | null
  scheduledPublishTime: string | null
  counts: {
    reactions: number | null
    comments: number | null
    shares: number
  } | null
}

export interface PostListQuery {
  source: PostSourceKind
  /** YYYY-MM-DD in POSTS_TZ, inclusive */
  since?: string
  until?: string
  limit: number
  cursor?: string | null
  includeCounts: boolean
}

const POST_LIST_FIELDS =
  "id,message,created_time,permalink_url,full_picture,status_type,is_published,is_hidden,promotable_id,attachments{media_type}"
const COUNT_FIELDS =
  "shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)"

function firstAttachment(p: Raw): Raw | undefined {
  return ((p.attachments as { data?: Raw[] } | undefined)?.data ?? [])[0]
}

function countsOf(p: Raw): PagePostSummary["counts"] {
  const total = (edge: unknown) =>
    num(
      (edge as { summary?: { total_count?: unknown } } | undefined)?.summary
        ?.total_count
    )
  return {
    reactions: total(p.reactions),
    comments: total(p.comments),
    shares: num((p.shares as { count?: unknown } | undefined)?.count) ?? 0,
  }
}

function toSummary(p: Raw, includeCounts: boolean): PagePostSummary {
  const msg = cut(p.message, MESSAGE_PREVIEW_CHARS)
  const sched = num(p.scheduled_publish_time)
  return {
    postId: s(p.id),
    createdTime: s(p.created_time) || null,
    message: msg.text,
    messageTruncated: msg.truncated,
    permalinkUrl: s(p.permalink_url) || null,
    fullPicture: s(p.full_picture) || null,
    mediaType: s(firstAttachment(p)?.media_type) || null,
    statusType: s(p.status_type) || null,
    isPublished: typeof p.is_published === "boolean" ? p.is_published : null,
    isHidden: typeof p.is_hidden === "boolean" ? p.is_hidden : null,
    promotableId: s(p.promotable_id) || null,
    scheduledPublishTime: sched ? new Date(sched * 1000).toISOString() : null,
    counts: includeCounts ? countsOf(p) : null,
  }
}

export async function listMetaPagePosts(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  q: PostListQuery
): Promise<{ posts: PagePostSummary[]; nextCursor: string | null }> {
  if (!isPageId(pageId))
    throw invalid(
      "page_id không hợp lệ.",
      "Gọi meta_list_pages để lấy đúng page_id."
    )
  if (q.since && !isIsoDate(q.since))
    throw invalid("since phải có dạng YYYY-MM-DD.")
  if (q.until && !isIsoDate(q.until))
    throw invalid("until phải có dạng YYYY-MM-DD.")
  if (q.since && q.until && q.since > q.until)
    throw invalid("since phải trước hoặc bằng until.")
  const params: GraphParams = {
    fields: [
      POST_LIST_FIELDS,
      q.includeCounts ? COUNT_FIELDS : "",
      q.source === "scheduled" ? "scheduled_publish_time" : "",
    ]
      .filter(Boolean)
      .join(","),
    limit: Math.min(Math.max(Math.trunc(q.limit), 1), 100),
  }
  if (q.since) params.since = startOfDayUnix(q.since, POSTS_TZ)
  if (q.until) params.until = startOfDayUnix(addDays(q.until, 1), POSTS_TZ) - 1
  if (q.cursor) params.after = q.cursor
  const page = await pageGet<{
    data?: Raw[]
    paging?: { next?: string; cursors?: { after?: string } }
  }>(ctx, pageId, `${pageId}/${POST_EDGE[q.source]}`, params, "posts")
  // only posts of THIS Page (their ids are PAGEID_POSTID) ever reach the AI
  const posts = (Array.isArray(page.data) ? page.data : [])
    .filter((p) => postBelongsToPage(s(p.id), pageId))
    .map((p) => toSummary(p, q.includeCounts))
  return {
    posts,
    nextCursor: page.paging?.next ? (page.paging.cursors?.after ?? null) : null,
  }
}

export interface PagePostDetail extends Omit<
  PagePostSummary,
  "message" | "messageTruncated"
> {
  message: string | null
  updatedTime: string | null
  story: string | null
  callToAction: { type: string | null; link: string | null } | null
  isEligibleForPromotion: boolean | null
  attachments: {
    mediaType: string | null
    type: string | null
    title: string | null
    description: string | null
    url: string | null
    imageUrl: string | null
    children: {
      mediaType: string | null
      title: string | null
      url: string | null
      imageUrl: string | null
    }[]
  }[]
}

const POST_DETAIL_FIELDS = [
  "id,message,story,created_time,updated_time,permalink_url,full_picture,status_type,is_published,is_hidden",
  "promotable_id,is_eligible_for_promotion,scheduled_publish_time,call_to_action",
  "attachments{media_type,type,title,description,unshimmed_url,media{image{src}},subattachments.limit(10){media_type,title,unshimmed_url,media{image{src}}}}",
  COUNT_FIELDS,
].join(",")

function imageOf(a: Raw): string | null {
  return (
    s((a.media as { image?: { src?: unknown } } | undefined)?.image?.src) ||
    null
  )
}

/** Button stored ON a Page post: `null` = the post has none. */
export interface MetaPostCta {
  type: string
  link: string | null
}

/**
 * call_to_action stored ON a Page post, read with the Page token (the user token gets #10 pages_read_engagement /
 * Page Public Content Access). [T 2026-11-12, owner-checked] a live video post keeps the button it got first (Ads
 * Manager or the first ad) for EVERY ad that uses it; an ad's own button only sticks while the post has none.
 */
export async function readMetaPostCta(
  ctx: ConnectionContext<MetaCredentials>,
  postId: string
): Promise<MetaPostCta | null> {
  const pageId = postId.split("_")[0] ?? ""
  if (!isPageId(pageId) || !postBelongsToPage(postId, pageId)) {
    throw invalid("object_story_id phải có dạng PAGEID_POSTID.")
  }
  const p = await pageGet<Raw>(
    ctx,
    pageId,
    postId,
    { fields: "id,call_to_action" },
    "posts"
  )
  const cta = p.call_to_action as
    | { type?: unknown; value?: { link?: unknown } }
    | undefined
  const type = s(cta?.type)
  return type ? { type, link: s(cta?.value?.link) || null } : null
}

export async function getMetaPagePost(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  postId: string
): Promise<PagePostDetail> {
  if (!isPageId(pageId) || !postBelongsToPage(postId, pageId)) {
    throw invalid(
      "post_id phải có dạng PAGEID_POSTID của chính Trang đã chọn.",
      "Gọi meta_list_page_posts để lấy đúng post_id."
    )
  }
  const p = await pageGet<Raw>(
    ctx,
    pageId,
    postId,
    { fields: POST_DETAIL_FIELDS },
    "posts"
  )
  // defence in depth: whatever Meta answers, the object must be this post of this Page
  if (s(p.id) !== postId || !postBelongsToPage(s(p.id), pageId)) {
    throw new ProviderError({
      platform: "meta",
      code: "not_found",
      message: `meta pages: ${postId} answered as another object`,
      userMessageVi: "Không tìm thấy bài viết này trên Trang đã chọn.",
      hint: "Gọi meta_list_page_posts để lấy đúng post_id.",
    })
  }
  const base = toSummary(p, true)
  const cta = p.call_to_action as
    { type?: unknown; value?: { link?: unknown } } | undefined
  const attachments = (
    (p.attachments as { data?: Raw[] } | undefined)?.data ?? []
  )
    .slice(0, 10)
    .map((a) => ({
      mediaType: s(a.media_type) || null,
      type: s(a.type) || null,
      title: s(a.title) || null,
      description: cut(a.description, 1_000).text,
      url: s(a.unshimmed_url) || null,
      imageUrl: imageOf(a),
      children: ((a.subattachments as { data?: Raw[] } | undefined)?.data ?? [])
        .slice(0, 10)
        .map((c) => ({
          mediaType: s(c.media_type) || null,
          title: s(c.title) || null,
          url: s(c.unshimmed_url) || null,
          imageUrl: imageOf(c),
        })),
    }))
  const { messageTruncated: _t, ...rest } = base
  return {
    ...rest,
    // the detail returns the whole text (bounded to keep tool results small)
    message: cut(p.message, 8_000).text,
    updatedTime: s(p.updated_time) || null,
    story: s(p.story) || null,
    callToAction: cta
      ? { type: s(cta.type) || null, link: s(cta.value?.link) || null }
      : null,
    isEligibleForPromotion:
      typeof p.is_eligible_for_promotion === "boolean"
        ? p.is_eligible_for_promotion
        : null,
    attachments,
  }
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

type InsightValue = number | Record<string, number> | null

interface InsightSeries {
  name?: unknown
  period?: unknown
  values?: { value?: unknown; end_time?: unknown }[]
}

function insightValue(v: unknown): InsightValue {
  const n = num(v)
  if (n !== null) return n
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, number> = {}
    for (const [k, x] of Object.entries(v as Raw)) {
      const xn = num(x)
      if (xn !== null) out[k] = xn
    }
    return out
  }
  return null
}

export interface PostInsightsResult {
  postId: string
  metrics: Record<string, InsightValue>
  invalidMetrics: string[]
  error: string | null
}

function seriesToLifetime(
  data: InsightSeries[] | undefined
): Record<string, InsightValue> {
  // some video metrics come back as BOTH a "day" and a "lifetime" series: the lifetime one wins
  const out: Record<string, InsightValue> = {}
  const isLifetime: Record<string, boolean> = {}
  for (const ser of data ?? []) {
    const name = s(ser.name)
    if (!name) continue
    const lifetime = s(ser.period) === "lifetime"
    if (name in out && isLifetime[name] && !lifetime) continue
    out[name] = insightValue(ser.values?.[0]?.value)
    isLifetime[name] = lifetime
  }
  return out
}

/** Lifetime Post Insights for posts of ONE Page, one batch call (`?ids=` is rejected from v26). */
export async function getMetaPostInsights(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  postIds: string[],
  metrics: PostMetric[]
): Promise<PostInsightsResult[]> {
  if (!isPageId(pageId)) throw invalid("page_id không hợp lệ.")
  const ids = [...new Set(postIds)]
  for (const id of ids) {
    if (!postBelongsToPage(id, pageId))
      throw invalid(
        `post_id ${id.slice(0, 64)} không thuộc Trang ${pageId}.`,
        "Mọi post_id phải là bài của cùng một Trang."
      )
  }
  const wanted = [
    ...new Set(
      metrics.filter((m) => (POST_METRICS as readonly string[]).includes(m))
    ),
  ]
  if (wanted.length === 0) throw invalid("Chọn ít nhất 1 metric hợp lệ.")
  const call = callCtxOf(ctx, pageId)
  // every batch goes through withPageToken: a rejected cached Page token never marks the connection invalid
  const batch = (ops: { method: "GET"; relative_url: string }[]) =>
    withPageToken(
      ctx,
      pageId,
      (token) =>
        graphBatch<{ data?: InsightSeries[] }>(call, ops, {
          idempotent: true,
          pageAccessToken: token,
        }),
      "insights"
    )
  const op = (id: string, ms: string[]) => ({
    method: "GET" as const,
    relative_url: `${id}/insights?metric=${encodeURIComponent(ms.join(","))}&period=lifetime`,
  })
  const res = await batch(ids.map((id) => op(id, wanted)))
  const out: PostInsightsResult[] = []
  for (let i = 0; i < ids.length; i++) {
    const r = res[i]
    if (r.ok) {
      out.push({
        postId: ids[i],
        metrics: seriesToLifetime(r.body.data),
        invalidMetrics: [],
        error: null,
      })
      continue
    }
    if (!isInvalidMetricError(r.error) || wanted.length === 1) {
      out.push({
        postId: ids[i],
        metrics: {},
        invalidMetrics: isInvalidMetricError(r.error) ? [...wanted] : [],
        error: (pagePermissionError(r.error, "insights") as ProviderError)
          .userMessageVi,
      })
      continue
    }
    // one dead metric fails the whole request: retry metric by metric for this post
    const single = await batch(wanted.map((m) => op(ids[i], [m])))
    const metricsOut: Record<string, InsightValue> = {}
    const bad: string[] = []
    single.forEach((sr, j) => {
      if (sr.ok) Object.assign(metricsOut, seriesToLifetime(sr.body.data))
      else bad.push(wanted[j])
    })
    out.push({
      postId: ids[i],
      metrics: metricsOut,
      invalidMetrics: bad,
      error: null,
    })
  }
  return out
}

export interface PageInsightsQuery {
  /** YYYY-MM-DD in PAGE_INSIGHTS_TZ, inclusive */
  since: string
  until: string
  period: "day" | "week" | "days_28"
  metrics: PageMetric[]
}

export interface PageInsightsResult {
  timezone: string
  period: PageInsightsQuery["period"]
  rows: ({ date: string } & Record<string, InsightValue | string>)[]
  totals: Record<string, number>
  invalidMetrics: string[]
  skippedMetrics: string[]
  warnings: string[]
}

export async function getMetaPageInsights(
  ctx: ConnectionContext<MetaCredentials>,
  pageId: string,
  q: PageInsightsQuery,
  now: Date = new Date()
): Promise<PageInsightsResult> {
  if (!isPageId(pageId)) throw invalid("page_id không hợp lệ.")
  if (!isIsoDate(q.since) || !isIsoDate(q.until))
    throw invalid("since/until phải có dạng YYYY-MM-DD.")
  if (q.since > q.until) throw invalid("since phải trước hoặc bằng until.")
  const today = todayInTz(PAGE_INSIGHTS_TZ, now)
  const until = q.until > today ? today : q.until
  const earliest = addDays(today, -PAGE_INSIGHTS_MAX_DAYS)
  const warnings: string[] = []
  if (q.until > today)
    warnings.push(`until được giới hạn về hôm nay (${today}, giờ Los Angeles).`)
  if (q.since < earliest)
    throw invalid(
      `Meta chỉ lưu chỉ số Trang khoảng 2 năm - since phải từ ${earliest}.`
    )
  if (q.since > until)
    throw invalid("since nằm sau ngày hiện tại theo giờ Los Angeles.")

  const requested = [
    ...new Set(
      q.metrics.filter((m) => (PAGE_METRICS as readonly string[]).includes(m))
    ),
  ] as PageMetric[]
  const skipped =
    q.period === "day"
      ? []
      : requested.filter((m) => DAY_ONLY_PAGE_METRICS.has(m))
  const metrics = requested.filter((m) => !skipped.includes(m))
  if (skipped.length)
    warnings.push(
      `Bỏ qua ${skipped.join(", ")}: chỉ có theo ngày (period=day).`
    )
  if (metrics.length === 0)
    throw invalid("Chọn ít nhất 1 metric hợp lệ cho period này.")

  const byDate = new Map<string, Record<string, InsightValue>>()
  const invalidMetrics = new Set<string>()
  const put = (series: InsightSeries[] | undefined) => {
    for (const ser of series ?? []) {
      const name = s(ser.name)
      if (!name) continue
      for (const v of ser.values ?? []) {
        const day = insightDayFromEndTime(s(v.end_time))
        if (!day || day < q.since || day > until) continue
        const row = byDate.get(day) ?? {}
        row[name] = insightValue(v.value)
        byDate.set(day, row)
      }
    }
  }

  for (const range of splitRange(
    { from: q.since, to: until },
    INSIGHTS_CHUNK_DAYS
  )) {
    // `until` is exclusive on Meta's side: ask for the day after the last wanted day
    const params = {
      period: q.period,
      since: range.from,
      until: addDays(range.to, 1),
    }
    const live = metrics.filter((m) => !invalidMetrics.has(m))
    if (live.length === 0) break
    try {
      const r = await pageGet<{ data?: InsightSeries[] }>(
        ctx,
        pageId,
        `${pageId}/insights`,
        { ...params, metric: live.join(",") },
        "insights"
      )
      put(r.data)
    } catch (e) {
      if (!isInvalidMetricError(e)) throw e
      for (const m of live) {
        try {
          const r = await pageGet<{ data?: InsightSeries[] }>(
            ctx,
            pageId,
            `${pageId}/insights`,
            { ...params, metric: m },
            "insights"
          )
          put(r.data)
        } catch (e2) {
          if (!isInvalidMetricError(e2)) throw e2
          invalidMetrics.add(m)
        }
      }
    }
  }

  // week / days_28 come back as a rolling window ending on EVERY day (tested live): keep non-overlapping windows
  // ending on `until`, every 7 / 28 days backwards
  const step = q.period === "week" ? 7 : q.period === "days_28" ? 28 : 1
  const rows: PageInsightsResult["rows"] = [...byDate.entries()]
    .filter(
      ([date]) =>
        step === 1 ||
        daysBetweenInclusive({ from: date, to: until }) % step === 1
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ ...values, date }))
  if (step > 1)
    warnings.push(
      `Mỗi dòng là tổng ${step} ngày kết thúc vào ngày "date" (các cửa sổ không chồng nhau, tính lùi từ until).`
    )
  const totals: Record<string, number> = {}
  if (q.period === "day") {
    for (const m of metrics) {
      if (!ADDITIVE_PAGE_METRICS.has(m) || invalidMetrics.has(m)) continue
      let sum = 0
      let any = false
      for (const r of rows) {
        const v = r[m]
        if (typeof v === "number") {
          sum += v
          any = true
        }
      }
      if (any) totals[m] = sum
    }
  }
  if (invalidMetrics.size)
    warnings.push(
      `Meta không còn hỗ trợ metric: ${[...invalidMetrics].join(", ")}.`
    )
  if (rows.length === 0)
    warnings.push(
      "Không có dữ liệu (Trang dưới 100 lượt thích, Trang chưa xuất bản, hoặc ngoài khoảng Meta lưu)."
    )
  return {
    timezone: PAGE_INSIGHTS_TZ,
    period: q.period,
    rows,
    totals,
    invalidMetrics: [...invalidMetrics],
    skippedMetrics: skipped,
    warnings,
  }
}
