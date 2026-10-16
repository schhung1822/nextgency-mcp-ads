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
  /**
   * Optional refinement of `status` the normalized enum cannot express (TikTok: the review passed only for part of the
   * placements / creatives → "partially_approved", or part was rejected → "partially_rejected"). Absent / null = none.
   * Exposed to the AI as `status_detail`.
   */
  statusDetail?: "partially_approved" | "partially_rejected" | null
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
  /**
   * TikTok GMV Max: an admin allowed this MCP to change GMV Max campaigns (MCP setting tiktok_gmv_max_write). Set by
   * mcp-core from the grant; absent / false = every write on a GMV Max campaign is refused (fail closed).
   */
  gmvMaxWrite?: boolean
  /**
   * STRICT daily-spend guard supplied by mcp-core: throws (Vietnamese McpToolError) when the MCP has no daily cap for
   * the currency (even a legacy MCP) or an amount exceeds it. Adapters call it with WORST-CASE daily spends of writes
   * that start or raise spend beyond what the generic guardrails see (TikTok GMV Max: create / copy run at once, auto
   * budget increase / promotion days). Absent → such writes are refused (fail closed).
   */
  dailySpendGuard?: (items: DailySpendCheck[]) => void
  /**
   * MCP protection mode, set by mcp-core from the grant. "basic" = the MCP has NO money caps on purpose: mcp-core's
   * dailySpendGuard lets everything through and the adapters skip their cumulative started-spend check (S5), but a
   * write that starts a NEW object running at once (TikTok GMV Max create / copy) is refused - it needs "advanced" +
   * a daily cap. Such writes run ONLY with an explicit "advanced" (absent → refused, fail closed).
   */
  protectionMode?: "basic" | "advanced"
  /**
   * Successful executed changes of one field on one object made through ANY MCP of this app (mcp_call_logs), newest
   * first, within the last `sinceHours`. Used for warnings only (TikTok GMV Max ROI changes). Absent → no history.
   */
  fieldHistory?: (q: { objectId: string; field: string; sinceHours: number }) => Promise<FieldHistoryEntry[]>
  /**
   * true ONLY when mcp-core executes this write through a consumed two-step confirmation (confirm_token). Set on
   * execution, never on a preview. TikTok GMV Max writes refuse to execute without it (defence in depth for C4).
   */
  confirmed?: boolean
  /**
   * Worst-case daily spends (MAJOR units, account currency) of objects that THIS MCP made start running (or raised
   * while running) on this ad account within the last 24 h: executed changes with field STARTED_MAX_DAILY_SPEND_FIELD
   * in mcp_call_logs (+ error rows with STARTED_SPEND_UNCERTAIN_LOG_CODE) + the live in-process reservations of
   * startedSpendLedger. Throws when it cannot be read - callers fail closed. Absent → writes that need it are refused.
   */
  startedSpend24h?: () => Promise<StartedSpendEntry[]>
  /**
   * S5/M1 (execution only): per MCP + ad account lock + reservations of this process, so two parallel starts cannot
   * both pass the cumulative check on the same history. Absent on an execution that needs it → refused (fail closed).
   */
  startedSpendLedger?: StartedSpendLedger
  /**
   * ads_update_budget: the MCP's % change limit + 24 h cumulative rule, checked by the ADAPTER against the budget it
   * reads itself (TikTok GMV Max: /campaign/gmv_max/info/ budget). Throws a Vietnamese McpToolError when violated.
   */
  budgetChangeGuard?: (q: { current: number; next: number; currency: string }) => Promise<void>
  /**
   * EXECUTION only, set by mcp-core: SSRF-guarded download (https only, size-capped, image magic bytes checked) of an
   * image URL returned BY THE PLATFORM (Meta video thumbnail = signed fbcdn URL). Adapters never fetch such a URL
   * themselves and never return / log / store it. Absent → features that need it (Meta automatic video cover) refuse.
   */
  fetchImage?: (url: string, o: { maxBytes: number }) => Promise<{ bytes: Uint8Array; contentType: string }>
  /**
   * Google Drive image named by the input (ProviderExtension.driveImageRef), resolved by mcp-core in the MCP's Drive
   * scope. Preview: label only - nothing is uploaded (imageHash only when this file version is already in the ad
   * account). Execution: imageHash of the image uploaded / reused in this ad account (always set on execution).
   */
  driveImage?: { label: string; imageHash?: string }
  /**
   * Set by mcp-core: true when this media id is known to belong to the ad account because THIS APP uploaded it there
   * (drive_media_uploads / logged uploads). Lets adapters skip the platform-side ownership check of an AI-supplied id
   * (Meta video status / cover reads, v1.1.2 S-M1). Absent → adapters always check on the platform.
   */
  isKnownMedia?: (q: { type: "image" | "video"; id: string }) => Promise<boolean>
  /**
   * Absolute deadline (epoch ms) of media sub-steps of an EXECUTION (Meta automatic cover: status read, guarded
   * download, adimages upload), counted from the tool call's arrival. Absent → the steps' own timeouts.
   */
  deadlineAt?: number
}

/**
 * FieldChange.field recorded for every object an adapter makes START RUNNING at once (TikTok GMV Max create / copy /
 * enable): after = its worst-case daily spend (major units). Read back by MutationOptions.startedSpend24h.
 */
export const STARTED_MAX_DAILY_SPEND_FIELD = "started_max_daily_spend"

/**
 * mcp_call_logs.error_code of a write that may have started / raised spend although it failed (TikTok GMV Max create
 * timeout + not found, enable / budget raise with an unknown outcome): the row carries the STARTED_MAX_DAILY_SPEND_FIELD
 * change and startedSpend24h counts it like a success (L1).
 */
export const STARTED_SPEND_UNCERTAIN_LOG_CODE = "started_spend_uncertain"

/** S5/M1: what a write reserves under the ledger lock (objectId = campaign id, or a request key before the id is known). */
export interface StartedSpendItem {
  objectId: string
  amount: number
}

/** Reservation handle (MutationOptions.startedSpendLedger.reserve). */
export interface StartedSpendReservation {
  /** after the write: the final object id / amount of a reserved item (create: request key → new campaign id) */
  settle(fromObjectId: string, to: StartedSpendItem): void
  /** the write definitely did not start these objects (all of the reservation when omitted) */
  release(objectIds?: string[]): void
}

/** S5/M1: in-process ledger of one MCP + ad account (mcp-core: src/server/mcp/started-spend-ledger.ts). */
export interface StartedSpendLedger {
  /** run fn under the per MCP + ad account lock (check + reserve are atomic; never held across a platform call) */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** record items as started now: counted by startedSpend24h until their log row is visible (or 24 h) */
  reserve(items: StartedSpendItem[]): StartedSpendReservation
}

/** One object started by this MCP in the window (MutationOptions.startedSpend24h). */
export interface StartedSpendEntry {
  objectId: string
  /** worst-case daily spend recorded when it started, major units */
  amount: number
  at: Date
}

/** One worst-case daily spend to check against the MCP daily cap (MutationOptions.dailySpendGuard). */
export interface DailySpendCheck {
  /** Vietnamese label used in the refusal, e.g. 'Mức chi tối đa có thể mỗi ngày của chiến dịch GMV Max mới' */
  label: string
  /** MAJOR units */
  amount: number
  currency: string
}

/** A past executed change (MutationOptions.fieldHistory). */
export interface FieldHistoryEntry {
  at: Date
  before: unknown
  after: unknown
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

/**
 * Write operation asked about by AdsProvider.mustAlwaysConfirm / preflightWrite ("active" / "paused" = ads_set_status,
 * "archive" = ads_set_status status archived → AdsProvider.archiveObjects).
 */
export type AlwaysConfirmOp = TargetStatus | "update" | "copy" | "delete" | "archive"

/**
 * Worst-case DAILY spend that switching an object on can cause beyond the budget getObject reports
 * (AdsProvider.activationSpend - TikTok: GMV Max campaigns with auto budget increase / promotion days).
 */
export interface ActivationSpend {
  id: string
  /** Vietnamese label of the object, e.g. 'Chiến dịch GMV Max "Tên" (123)' */
  label: string
  currency: string
  /** configured daily budget, major units (null when unknown) */
  dailyBudget: number | null
  /** worst-case spend of ONE day, major units - compared with the MCP daily cap */
  maxDailySpend: number
  /** Vietnamese notes (how the worst case was computed, what is not included) */
  notes: string[]
}

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
    /**
     * Ad content (level "ad" only; TikTok only - every other adapter refuses it with ProviderError unsupported). Only the
     * given fields change; the platform re-reviews the ad.
     */
    creative?: CreativeUpdate
  }
}

/** ObjectUpdate.changes.creative - new ad content (TikTok /ad/update/). Absent field = unchanged. */
export interface CreativeUpdate {
  /** ad text (TikTok ad_text, ≤ 100 chars) */
  adText?: string
  /** call-to-action enum value (TikTok call_to_action, e.g. LEARN_MORE, SEND_MESSAGE) */
  callToAction?: string
  /** Spark Ads post id (TikTok tiktok_item_id) - only for ads that already use a TikTok post */
  tiktokItemId?: string
  /** video id from the ad account library - only for ads that already use a video (not a TikTok post) */
  videoId?: string
  /** image ids (TikTok image_ids: cover of a video ad, or the images of an image / carousel ad) */
  imageIds?: string[]
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
  /**
   * Status of the new objects when it is NOT the usual "paused" (TikTok GMV Max: a copy starts RUNNING - the platform
   * has no paused option). Absent = paused.
   */
  newStatus?: "active"
  /** extra change rows to log with the copy (e.g. STARTED_MAX_DAILY_SPEND_FIELD of a copy that starts running) */
  extraChanges?: FieldChange[]
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
  /**
   * video only: the upload call timed out (outcome unknown) and the video was found again in the ad account's library
   * by its unique name (Meta advideos?title=, best effort) - the id is that video, nothing was uploaded twice
   */
  recovered?: boolean
}

/** Live state of an uploaded video on the platform (AdsProvider.getMediaStatus). */
export interface MediaStatus {
  type: "video"
  id: string
  /** processing = still being uploaded / encoded (not usable in an ad yet) · ready = usable · failed = upload again */
  status: "processing" | "ready" | "failed"
  /** platform processing progress 0-100 when known */
  progressPercent: number | null
  /** Vietnamese reason when failed (sanitised platform message), else null */
  error: string | null
  /** ready videos: the platform extracted a thumbnail usable as automatic cover (null = not checked) */
  hasThumbnail: boolean | null
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
  /** TikTok: posts of a TikTok identity usable for Spark Ads (tiktok_item_id) - needs LookupQuery.parentId */
  "tiktok_posts",
] as const
export type LookupKind = (typeof LOOKUP_KINDS)[number]

export interface LookupItem {
  id: string
  name: string
  extra?: Record<string, unknown>
}

/** Input of AdsProvider.lookup. Adapters ignore the fields a kind does not use. */
export interface LookupQuery {
  q?: string
  limit?: number
  /** parent object of the lookup (kind tiktok_posts: the TikTok identity_id) */
  parentId?: string
  /** kind tiktok_posts: identity type of parentId (AUTH_CODE | TT_USER | BC_AUTH_TT); absent = adapter resolves it */
  identityType?: string
  /** kind tiktok_posts: Business Center id when identityType is BC_AUTH_TT */
  identityAuthorizedBcId?: string
  /** opaque page cursor returned as LookupResult.nextCursor by the previous call */
  cursor?: string
}

/** Result of AdsProvider.lookup. */
export interface LookupResult {
  items: LookupItem[]
  warnings: string[]
  /** next page (pass back as LookupQuery.cursor); absent / null = no more items or the kind is not paged */
  nextCursor?: string | null
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
  /**
   * Opt-in MCP setting the tool needs: not listed (and refused) unless it is on (TikTok GMV Max writes:
   * "tiktok_gmv_max_write" = McpSettings.tiktokGmvMaxWrite).
   */
  requiresSetting?: "tiktok_gmv_max_write"
  /** write tools: ALWAYS two-step confirmation, even when the MCP disabled it */
  alwaysConfirm?: true
  /**
   * create tools whose new objects start RUNNING because the platform cannot create them paused (TikTok GMV Max):
   * the generic "always created paused" notes are not shown. The adapter must warn itself.
   */
  createsActive?: true
  /**
   * false: a create tool whose result is not an ad object with a status (TikTok welcome message): the generic
   * "always created paused" preview note is not shown. Omitted = ad object (default behaviour).
   */
  createsAdObject?: false
  /**
   * Optional: Google Drive image reference carried by the input (meta_create_ad creative.image_drive_file - file id,
   * Drive link or drf_ ref). mcp-core resolves it in the MCP's Drive scope on both steps, uploads it to the ad account
   * on execution (reused per file version) and hands it over as MutationOptions.driveImage; the confirmation is bound
   * to the resolved file id. undefined = no Drive image in this input.
   */
  driveImageRef?(input: I): string | undefined
  /**
   * true: the tool may download images returned BY THE PLATFORM (Meta video thumbnails) - mcp-core then hands it
   * MutationOptions.fetchImage on execution. Other tools never get the fetcher.
   */
  fetchesPlatformImages?: true
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
    opts?: {
      includeChildren?: boolean
      /** the detail feeds a write guard - platform-specific checks fail closed instead of falling back */
      forWrite?: boolean
      /**
       * ads_get_object only: attach platform review / moderation info (TikTok: extra.review via /ad/review_info/ +
       * /adgroup/review_info/); adapters without it ignore the flag
       */
      review?: boolean
    }
  ): Promise<AdObjectDetail>

  setStatus(
    ctx: ProviderContext<C>,
    level: ObjectLevel,
    ids: string[],
    status: TargetStatus,
    opts?: MutationOptions
  ): Promise<MutationResult>
  /**
   * Optional (Meta): archive objects (status ARCHIVED - effectively irreversible). Same contract as setStatus: dryRun =
   * preview without writing; changes `{ field: "status", before, after: <platform value> }`; objects already archived /
   * deleted are skipped with a Vietnamese warning. Absent = the platform has no archive state (ads_set_status status
   * archived answers unsupported).
   */
  archiveObjects?(ctx: ProviderContext<C>, level: ObjectLevel, ids: string[], opts?: MutationOptions): Promise<MutationResult>
  /**
   * Optional: Vietnamese reasons why this write (status change, budget / field update, copy, delete) must ALWAYS go
   * through two-step confirmation, even when the MCP disabled it (TikTok: GMV Max campaigns). Empty = no extra
   * confirmation. May throw: the caller then requires confirmation (fail closed). Absent = behaviour unchanged.
   */
  mustAlwaysConfirm?(ctx: ProviderContext<C>, level: ObjectLevel, ids: string[], op: AlwaysConfirmOp): Promise<string[]>
  /**
   * Optional: worst-case daily spend of the objects that ads_set_status (status active) would switch on, for objects
   * whose spend is not described by getObject's budget (TikTok: GMV Max campaigns). Entries are compared with the MCP
   * daily cap and shown in the preview. Throws when it cannot be verified: with a daily cap the activation is then
   * refused (budget_unverifiable, fail closed). Absent = behaviour unchanged.
   */
  activationSpend?(ctx: ProviderContext<C>, level: ObjectLevel, ids: string[]): Promise<ActivationSpend[]>
  /**
   * Optional: refusals that do not depend on money checks, asked by ads_set_status (op = target status) and by
   * ads_update_budget / ads_update_object (op "update") BEFORE their cap checks so the user gets the real reason first
   * (TikTok: a GMV Max campaign on an MCP without the GMV Max switch → "locked"). Throws to refuse; absent / resolves =
   * continue unchanged.
   */
  preflightWrite?(
    ctx: ProviderContext<C>,
    level: ObjectLevel,
    ids: string[],
    op: AlwaysConfirmOp,
    opts: MutationOptions
  ): Promise<void>
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
  /**
   * Optional (Meta): live status of an uploaded video. verifyAccount: the id came from the AI (not from our own upload
   * records) - also check that the video is in this ad account's library (not found → ProviderError not_found).
   */
  getMediaStatus?(ctx: ProviderContext<C>, q: { type: "video"; id: string; verifyAccount?: boolean }): Promise<MediaStatus>
  lookup(ctx: ProviderContext<C>, kind: LookupKind, query?: LookupQuery): Promise<LookupResult>
}

export function emptyMetrics(): NormalizedMetrics {
  return Object.fromEntries(NORMALIZED_METRICS.map((k) => [k, null])) as NormalizedMetrics
}
