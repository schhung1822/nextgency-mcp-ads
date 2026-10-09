import type { z } from "zod"

// Shared contract for every ad-platform adapter.
// IMPORTANT: no imports from "next/*" anywhere under src/server/providers (runs in worker/tests too).

import { RELEASED_PLATFORMS, type Platform } from "../../lib/platforms"

export type { Platform } from "../../lib/platforms"
export { ALL_PLATFORMS } from "../../lib/platforms"

/** Platforms shipped in this build (src/lib/platforms.ts) - every runtime loop over platforms uses this list. */
export const PLATFORMS: readonly Platform[] = RELEASED_PLATFORMS

/** Object levels, normalised across platforms (Meta "adset" → "ad_group"). */
export type ObjectLevel = "campaign" | "ad_group" | "ad" | "keyword"
export type ReportLevel = "account" | ObjectLevel

export type NormalizedStatus =
  | "active"
  | "paused"
  | "archived"
  | "deleted"
  | "removed"
  | "pending_review"
  | "rejected"
  | "disabled"
  | "unknown"

export type AccountStatus = "active" | "disabled" | "pending" | "closed" | "unknown"

export type Capability =
  | "report"
  | "list_objects"
  | "get_object"
  | "set_status"
  | "update_budget"
  | "update_object"
  | "copy"
  | "delete"
  | "upload_media"
  | "lookup"
  | "create"
  | "update_targeting"
  | "conversions"

/** native = API supports it · emulated = app builds it from several calls · gated = only for some accounts · unsupported */
export type CapabilityMode = "native" | "emulated" | "gated" | "unsupported"

// ---------------------------------------------------------------------------
// Accounts & credentials
// ---------------------------------------------------------------------------

export interface AdAccountInfo {
  /** Platform id: Meta "act_123", OpenAI "adacct_…" */
  externalId: string
  name: string
  /** ISO 4217 */
  currency: string
  /** IANA time zone */
  timezone: string
  status: AccountStatus
  statusRaw: string
  isManager?: boolean
  parentExternalId?: string | null
  /** Non-secret extra info (min_daily_budget, business, balance…) */
  extra?: Record<string, unknown>
}

/** A Facebook Page reachable by the connection's token (Meta only - providers/meta.md §10.2). */
export interface PageInfo {
  /** Page id */
  externalId: string
  name: string
  category: string | null
  link: string | null
  pictureUrl: string | null
  followersCount: number | null
  /** blue_verified | gray_verified | not_verified */
  verificationStatus: string | null
  isPublished: boolean | null
  /**
   * Normalised tasks of the token user on the Page (ANALYZE, ADVERTISE, CREATE_CONTENT, MANAGE, MODERATE,
   * MESSAGING, MANAGE_LEADS). Empty = only seen through a Business Manager (list only, no posts/insights).
   */
  tasks: string[]
  sources: PageSource[]
  businessId: string | null
  businessName: string | null
}

export type PageSource = "me_accounts" | "owned_pages" | "client_pages"

export interface PageListResult {
  /** false = the Page list could not be read at all: keep the stored Pages untouched */
  ok: boolean
  pages: PageInfo[]
  /** Vietnamese, shown on the connection's Pages tab */
  warnings: string[]
}

export interface CredentialCheck {
  valid: boolean
  /** null = never expires / unknown */
  tokenExpiresAt: Date | null
  scopes: string[] | null
  /** Vietnamese, user-facing */
  warnings: string[]
  /** Non-secret metadata stored in connections.meta (app id, login_customer_id, probed features…) */
  meta: Record<string, unknown>
}

/** Reference to the ad account an operation runs against. */
export interface AdAccountRef {
  /** internal uuid (ad_accounts.id) */
  id: string
  externalId: string
  name: string
  currency: string
  timezone: string
}

export interface UpstreamEvent {
  platform: Platform
  method: string
  /** URL without secrets (no access_token query) */
  url: string
  status: number
  durationMs: number
  requestId?: string | null
}

export interface ProviderContext<C = unknown> {
  connectionId: string
  credentials: C
  /** Non-secret connections.meta */
  connectionMeta: Record<string, unknown>
  account: AdAccountRef
  signal?: AbortSignal
  /** Collects upstream request ids for logging */
  onUpstream?: (e: UpstreamEvent) => void
}

export interface ConnectionContext<C = unknown> {
  connectionId?: string
  credentials: C
  connectionMeta?: Record<string, unknown>
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** YYYY-MM-DD, inclusive, interpreted in the ad account's time zone */
export interface DateRange {
  from: string
  to: string
}

export const METRIC_PRESETS = ["basic", "conversion", "video", "all"] as const
export type MetricPreset = (typeof METRIC_PRESETS)[number]

export const NORMALIZED_METRICS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "link_clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversions",
  "conversion_value",
  "cpa",
  "roas",
  "purchases",
  "leads",
  "messages",
  "video_views",
] as const
export type NormalizedMetricKey = (typeof NORMALIZED_METRICS)[number]

/** Money values are in MAJOR units of the account currency. ctr is a percentage (2.5 = 2.5%). null = not available. */
export type NormalizedMetrics = Record<NormalizedMetricKey, number | null>

export interface ReportFilters {
  campaignIds?: string[]
  adGroupIds?: string[]
  adIds?: string[]
  statuses?: NormalizedStatus[]
  nameContains?: string
  /** include deleted/archived objects (heavier queries on some platforms) */
  includeDeleted?: boolean
  /**
   * Google Ads only (other adapters ignore it): campaign.advertising_channel_type values (SEARCH, VIDEO, DEMAND_GEN,
   * PERFORMANCE_MAX…, case-insensitive) or "youtube" (= VIDEO + DEMAND_GEN). Not allowed at level "account".
   */
  channelTypes?: string[]
  /** Google Ads only: segments.ad_network_type values (SEARCH, SEARCH_PARTNERS, CONTENT, MIXED, YOUTUBE, GOOGLE_TV) */
  adNetworkTypes?: string[]
}

export interface ReportQuery {
  level: ReportLevel
  dateRange: DateRange
  granularity: "day" | "total"
  metrics: MetricPreset
  filters?: ReportFilters
  /** opaque adapter cursor */
  cursor?: string | null
  /** rows per page, adapter may cap */
  limit: number
}

export interface ReportRow {
  /** YYYY-MM-DD when granularity = day */
  date?: string
  level: ReportLevel
  campaignId?: string | null
  campaignName?: string | null
  adGroupId?: string | null
  adGroupName?: string | null
  adId?: string | null
  adName?: string | null
  keyword?: string | null
  status?: NormalizedStatus | null
  metrics: NormalizedMetrics
  /** platform-native extra fields (only when metrics = "all") */
  extra?: Record<string, unknown>
}

export interface ReportPage {
  rows: ReportRow[]
  nextCursor: string | null
  currency: string
  timezone: string
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export interface Budget {
  type: "daily" | "lifetime"
  /** MAJOR units of account currency */
  amount: number
  currency: string
  /** where the budget lives */
  level: "campaign" | "ad_group"
  /** budget shared between several campaigns */
  shared?: boolean
  /**
   * Flexible daily budget (TikTok BUDGET_MODE_DYNAMIC_DAILY_BUDGET): the platform may spend up to 125% of the
   * amount in one day, so the MCP daily cap is checked against amount × 1.25 (mcp/guardrails.ts checkDailyCap).
   */
  dynamic?: true
}

export interface AdObjectSummary {
  id: string
  level: ObjectLevel
  name: string
  status: NormalizedStatus
  statusRaw: string
  campaignId?: string | null
  parentId?: string | null
  budget?: Budget | null
  objective?: string | null
  /** ISO 8601 */
  startTime?: string | null
  endTime?: string | null
  createdTime?: string | null
  extra?: Record<string, unknown>
}

export interface AdObjectDetail extends AdObjectSummary {
  /** Platform-native configuration (targeting, bidding, creative…) - never contains credentials */
  config: Record<string, unknown>
  children?: AdObjectDetail[]
}

export interface ListQuery {
  level: ObjectLevel
  /** campaign id for ad_group, ad_group id for ad/keyword */
  parentId?: string | null
  statuses?: NormalizedStatus[]
  nameContains?: string
  cursor?: string | null
  limit: number
  /** Google Ads only (other adapters ignore it): channel types or "youtube" - see ReportFilters.channelTypes */
  channelTypes?: string[]
}

export interface ObjectPage {
  items: AdObjectSummary[]
  nextCursor: string | null
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface MutationOptions {
  /** Validate + compute preview without changing anything */
  dryRun?: boolean
  /** Maps to the platform idempotency key (OpenAI Idempotency-Key) */
  idempotencyKey?: string
}

export interface FieldChange {
  objectId: string
  objectName?: string | null
  level?: ObjectLevel
  field: string
  before: unknown
  after: unknown
}

export interface MutationResult {
  /** true when dryRun: nothing was changed */
  preview: boolean
  changes: FieldChange[]
  /** Vietnamese, user-facing */
  warnings: string[]
  /** When the change takes effect if not immediately */
  effectiveAt?: string | null
  /** ids of objects created (create tools) */
  createdIds?: string[]
}

export type TargetStatus = "active" | "paused"

export interface BudgetUpdate {
  level: "campaign" | "ad_group"
  id: string
  type: "daily" | "lifetime"
  /** MAJOR units */
  amount: number
}

export interface ObjectUpdate {
  level: ObjectLevel
  id: string
  changes: {
    name?: string
    /** ISO 8601 with offset */
    startTime?: string | null
    endTime?: string | null
    /** MAJOR units */
    bidAmount?: number | null
    finalUrl?: string
  }
}

export interface CopyRequest {
  level: Exclude<ObjectLevel, "keyword">
  id: string
  /** copy children too */
  deep: boolean
  /** target campaign (for ad_group) / target ad group (for ad); default = same parent */
  targetParentId?: string | null
  namePrefix?: string
  nameSuffix?: string
  /**
   * Explicit opt-in (MCP input `allow_incomplete_targeting: true`) to accept a copy that drops targeting/exclusion
   * criteria the adapter cannot re-create. Default: the adapter fails closed with a Vietnamese error.
   */
  allowIncomplete?: boolean
}

export interface CopyMapping {
  level: ObjectLevel
  sourceId: string
  newId: string | null
  error?: string
}

export interface CopyResult {
  preview: boolean
  mode: "native" | "emulated"
  rootNewId: string | null
  mappings: CopyMapping[]
  warnings: string[]
}

export interface MediaUploadRequest {
  type: "image" | "video"
  /**
   * public http(s) URL - caller must already have passed the SSRF guard. When `bytes` is present it is only
   * informational (never fetched, never required to be http(s)).
   */
  url: string
  name?: string
  /**
   * File content already downloaded by mcp-core through the SSRF-guarded fetch. When present, adapters
   * MUST use it and never fetch `url` themselves (`url` is then only informational).
   */
  bytes?: Uint8Array
  /** sniffed MIME type of `bytes` */
  contentType?: string
  /**
   * Sanitised file name (with extension, no path) of the media - used where the platform needs one (TikTok
   * `file_name` base, multipart part filename). Optional: adapters fall back to `name` / the URL path.
   */
  fileName?: string
  /**
   * Video processing wait budget (ms) after the upload call: Meta status / TikTok info polling stop at this
   * budget and return the id with `processing: true`. Omitted = the adapter default (60 s); <= 0 = do not wait.
   */
  maxWaitMs?: number
  /**
   * Absolute deadline (epoch ms) for the WHOLE call: the upload request timeout is min(own timeout, deadlineAt - now)
   * and processing polling stops at it (→ processing: true). Wins over maxWaitMs when both are set.
   */
  deadlineAt?: number
}

/** Chunked (resumable) video upload driven by the server (background job) - Meta upload_phase, TikTok file/*upload. */
export interface ChunkedVideoUploadRequest {
  /** sanitised file name with extension */
  fileName: string
  sizeBytes: number
  /** lowercase hex MD5 of the whole file when known (Drive md5Checksum), else null */
  md5: string | null
  /** video/mp4 | video/quicktime */
  contentType: string
  /** library name (defaults to fileName) */
  name?: string
  /** read bytes [start, endExclusive) of the file (Drive Range read); may be called again for a retried chunk */
  readChunk(start: number, endExclusive: number, signal?: AbortSignal): Promise<Buffer>
  /** absolute epoch ms: stop waiting for processing after it (→ processing: true) */
  deadlineAt?: number
  /** progress callback (bytes acknowledged by the platform) */
  onProgress?(uploadedBytes: number): void
  signal?: AbortSignal
}

export interface MediaRef {
  type: "image" | "video"
  /** Meta image_hash / video_id, OpenAI file_id */
  id: string
  url?: string | null
  /** video only: true when the wait budget ended before the platform finished processing (id still usable later) */
  processing?: boolean
}

export const LOOKUP_KINDS = [
  "pages",
  "pixels",
  "instagram_accounts",
  "identities",
  "locations",
  "interests",
  "languages",
  "conversion_events",
  "custom_audiences",
] as const
export type LookupKind = (typeof LOOKUP_KINDS)[number]

export interface LookupItem {
  id: string
  name: string
  extra?: Record<string, unknown>
}


// ---------------------------------------------------------------------------
// UI metadata: credential form + step-by-step guide (Vietnamese)
// ---------------------------------------------------------------------------

export interface CredentialFieldSpec {
  /** key in the raw credentials object passed to parseCredentials() */
  key: string
  label: string
  type: "secret" | "text" | "textarea" | "select"
  required: boolean
  placeholder?: string
  help?: string
  options?: { value: string; label: string }[]
  /** only show when another field has this value */
  showWhen?: { key: string; equals: string }
}

export interface ConnectionGuide {
  /** one-line summary shown on the platform card */
  summary: string
  steps: { title: string; detail: string; link?: { label: string; url: string } }[]
  requiredScopes?: string[]
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Platform-specific operations exposed as MCP tools (create campaign, targeting…)
// mcp-core registers every extension of a platform as a tool named `name`.
// ---------------------------------------------------------------------------

export type ExtensionPermission = "read" | "update" | "create"

/**
 * A money value carried by an extension input, declared so mcp-core can enforce the MCP's budget/bid
 * caps BEFORE anything is sent (create tools must not bypass the guardrails of ads_update_budget).
 */
export interface ExtensionMoneyItem {
  /** target CPA / cost caps count as bids; a flexible daily budget is daily_budget + dynamic: true */
  kind: "daily_budget" | "lifetime_budget" | "bid"
  /** daily_budget only: flexible daily budget that may spend up to 125%/day (TikTok) → cap checked against amount × 1.25 */
  dynamic?: true
  /** MAJOR units of the account currency */
  amount: number
  /** input path for messages, e.g. "budget.amount", "ad_groups[0].cpc_bid" */
  field: string
  /** flight of a lifetime budget when known: ISO 8601 date-time, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (UTC) */
  startTime?: string | null
  endTime?: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ProviderExtension<C = unknown, I = any, O = unknown> {
  /** MCP tool name, snake_case ≤40 chars, platform prefix (meta_, openai_ads_) */
  name: string
  permission: ExtensionPermission
  /** Vietnamese short title */
  title: string
  /** "Dùng khi …" - Vietnamese, ≤1500 chars, mention prerequisite tools */
  description: string
  /** zod object schema of the tool input EXCLUDING account_id/confirm_token (added by mcp-core) */
  input: z.ZodType<I>
  /** true for writes: mcp-core runs dryRun first for two-step confirmation */
  write: boolean
  /**
   * Every budget / bid in the (parsed) input, MAJOR units. REQUIRED for write extensions that take
   * money: mcp-core refuses money-like inputs of extensions that do not declare them.
   */
  moneyOf?(input: I): ExtensionMoneyItem[]
  run(ctx: ProviderContext<C>, input: I, opts: MutationOptions): Promise<O>
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface AdsProvider<C = unknown> {
  platform: Platform
  capabilities: Record<Capability, CapabilityMode>
  /** form fields for the "add connection" wizard */
  credentialFields: CredentialFieldSpec[]
  /** Vietnamese how-to for obtaining the token */
  guide: ConnectionGuide
  /** platform-specific MCP tools */
  extensions: ProviderExtension<C>[]
  /** zod-parse raw form input into typed credentials (throws ProviderError code "invalid_credentials_input") */
  parseCredentials(raw: unknown): C
  /** Last characters of the main secret, for display */
  credentialHint(c: C): string
  /**
   * Optional: normalise credentials before validation/saving (e.g. Meta: exchange a short-lived user token
   * for a 60-day token). Returns the credentials to store + Vietnamese notes shown to the user.
   */
  prepareCredentials?(ctx: ConnectionContext<C>): Promise<{ credentials: C; notes: string[] }>
  validateCredentials(ctx: ConnectionContext<C>): Promise<CredentialCheck>
  listAccounts(ctx: ConnectionContext<C>): Promise<AdAccountInfo[]>
  /** Optional (Meta): Facebook Pages of the token, synced together with the ad accounts. Must not throw. */
  listPages?(ctx: ConnectionContext<C>): Promise<PageListResult>

  getReport(ctx: ProviderContext<C>, q: ReportQuery): Promise<ReportPage>
  listObjects(ctx: ProviderContext<C>, q: ListQuery): Promise<ObjectPage>
  getObject(
    ctx: ProviderContext<C>,
    level: ObjectLevel,
    id: string,
    opts?: { includeChildren?: boolean }
  ): Promise<AdObjectDetail>

  setStatus(
    ctx: ProviderContext<C>,
    level: ObjectLevel,
    ids: string[],
    status: TargetStatus,
    opts?: MutationOptions
  ): Promise<MutationResult>
  updateBudget(ctx: ProviderContext<C>, u: BudgetUpdate, opts?: MutationOptions): Promise<MutationResult>
  updateObject(ctx: ProviderContext<C>, u: ObjectUpdate, opts?: MutationOptions): Promise<MutationResult>
  copyObject(ctx: ProviderContext<C>, r: CopyRequest, opts?: MutationOptions): Promise<CopyResult>
  deleteObject(
    ctx: ProviderContext<C>,
    level: ObjectLevel,
    id: string,
    opts?: MutationOptions
  ): Promise<MutationResult>
  uploadMedia(ctx: ProviderContext<C>, r: MediaUploadRequest): Promise<MediaRef>
  /** server-driven chunked video upload (Meta, TikTok); absent = not supported */
  uploadVideoChunked?(ctx: ProviderContext<C>, r: ChunkedVideoUploadRequest): Promise<MediaRef>
  lookup(
    ctx: ProviderContext<C>,
    kind: LookupKind,
    query?: { q?: string; limit?: number }
  ): Promise<{ items: LookupItem[]; warnings: string[] }>
}

export function emptyMetrics(): NormalizedMetrics {
  return Object.fromEntries(NORMALIZED_METRICS.map((k) => [k, null])) as NormalizedMetrics
}
