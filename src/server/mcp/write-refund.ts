// Refund of one MCP write-limit slot (settings.writeRateLimitPer10Min) when an executed write was refused by the ad
// platform BEFORE anything changed (D5, v1.1.6). Pure module: tool.ts (runWrite) feeds it the thrown error, the tool
// name and what the call sent upstream during the execution.
//
// A slot is given back only when ALL of these hold (fail closed - anything unclear keeps the slot spent):
//  - the tool is a single-step write (ATOMIC_WRITE_TOOLS) - multi-step creates / copies / uploads never refund
//  - the error is a ProviderError (raised by the adapter / platform, never an MCP refusal of the AI's input) without
//    audit data (an uncertain write, errors.ts ProviderErrorAudit)
//  - its code says the platform refused the request as a whole: rate limit / quota, token or permission problems, an
//    account the owner must act on, or a validation error the PLATFORM returned (upstream info present - a
//    validation of the AI's input by the adapter does not count)
//  - what was sent upstream proves nothing was written: no write request at all, or every write request was refused
//    (4xx, except the last one which may be the failing envelope of a platform answering HTTP 200 - TikTok) and the
//    LAST upstream request of the execution is that refused write (a read-back after a successful write ends with a
//    GET → no refund). A network failure on a write (status 0) never refunds: the platform may have applied it.
// Never refunded either: a refusal for suspected abuse / spam (ABUSE_UPSTREAM_CODES, Meta 368). On top of these rules
// refundWriteRate (rate-limit.ts) gives at most WRITE_REFUND_LIMIT refunds per MCP per 10-minute window, so a loop of
// refused writes still ends in write_rate_limited.
// Money caps never depend on the write counter (they read executed rows from mcp_call_logs / the started-spend
// ledger), so a refund cannot loosen them.
import { isProviderError, type ProviderError, type ProviderErrorCode } from "../providers/errors"
import type { Platform, UpstreamEvent } from "../providers/types"

/** Single-step write tools (one platform write request per object, no create). */
export const ATOMIC_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "ads_set_status",
  "ads_update_budget",
  "ads_update_object",
  "ads_delete_object",
  "meta_update_targeting",
  "tiktok_update_targeting",
  "openai_ads_update_ad_group",
])

/** Platform refusals that never apply a change (owner decision 2 of v1.1.6). */
export const REFUNDABLE_CODES: ReadonlySet<ProviderErrorCode> =
  new Set<ProviderErrorCode>([
    "rate_limited",
    "quota_exceeded",
    "action_required",
    "auth_invalid",
    "permission_denied",
    "invalid_request",
  ])

/**
 * Platform error codes that signal abuse / spam throttling: a refusal for suspected abuse never gives the slot back
 * (refunding would let the AI keep hammering an account the platform already flagged). Meta 368 "temporarily blocked
 * for policies violations" (every subcode) is mapped to rate_limited by the Meta client. TikTok documents no such code.
 */
export const ABUSE_UPSTREAM_CODES: Readonly<Partial<Record<Platform, ReadonlySet<string>>>> = {
  meta: new Set(["368"]),
}

function isAbuseRefusal(e: ProviderError): boolean {
  const code = e.upstream?.code
  return code != null && ABUSE_UPSTREAM_CODES[e.platform]?.has(String(code)) === true
}

/** Does this upstream request change something? Reads (GET / Google search / OAuth token exchange) do not. */
export function isWriteRequest(
  e: Pick<UpstreamEvent, "platform" | "method" | "url">
): boolean {
  const m = e.method.toUpperCase()
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false
  if (e.platform === "google_ads") {
    let url: URL | null = null
    try {
      url = new URL(e.url)
    } catch {
      return true
    }
    // GAQL reads are POST googleAds:search / :searchStream; the OAuth refresh is a POST to the token endpoint
    if (/\/googleAds:search(Stream)?$/.test(url.pathname)) return false
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token")
      return false
  }
  return true
}

interface Observed {
  status: number
  write: boolean
}

/**
 * Upstream requests of one tool call (fed by the provider context's onUpstream). Keeps only counters and the last
 * request: a call may make thousands of report requests.
 */
export class UpstreamWriteTracker {
  private seq = 0
  private writes = 0
  /** writes that were not a definite refusal (status 0 / 1xx–3xx / 5xx …, or 2xx) */
  private unclearWrites = 0
  private last: Observed | null = null
  private lastWrite: Observed | null = null

  observe(
    e: Pick<UpstreamEvent, "platform" | "method" | "url" | "status">
  ): void {
    const write = isWriteRequest(e)
    const o: Observed = { status: e.status, write }
    this.seq += 1
    this.last = o
    if (!write) return
    if (!isRefusalStatus(e.status)) this.unclearWrites += 1
    this.writes += 1
    this.lastWrite = o
  }

  /** State at the start of an execution (compare with since()). */
  mark(): WriteMark {
    return {
      seq: this.seq,
      writes: this.writes,
      unclearWrites: this.unclearWrites,
    }
  }

  /** What happened upstream after `mark`. */
  since(mark: WriteMark): UpstreamWrites {
    const writes = this.writes - mark.writes
    const events = this.seq - mark.seq
    return {
      writes,
      // earlier writes of this execution that were not refused (the last write is judged separately)
      unclearEarlierWrites:
        this.unclearWrites -
        mark.unclearWrites -
        (writes > 0 && this.lastWrite && !isRefusalStatus(this.lastWrite.status) ? 1 : 0),
      lastIsWrite: events > 0 && this.last?.write === true,
      lastWriteStatus: writes > 0 ? (this.lastWrite?.status ?? 0) : null,
    }
  }
}

export interface WriteMark {
  seq: number
  writes: number
  unclearWrites: number
}

export interface UpstreamWrites {
  /** write requests sent during the execution */
  writes: number
  /** write requests before the last one that were not a definite refusal (4xx) */
  unclearEarlierWrites: number
  /** the last upstream request of the execution is a write */
  lastIsWrite: boolean
  /** HTTP status of the last write (0 = network failure / timeout), null without writes */
  lastWriteStatus: number | null
}

function isRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500
}

/**
 * True when the slot spent by this execution can be given back: the platform refused the write and nothing changed.
 * `upstream` null (unknown) → false.
 */
export function isDefiniteNoChange(
  e: unknown,
  toolName: string,
  upstream: UpstreamWrites | null
): boolean {
  if (!ATOMIC_WRITE_TOOLS.has(toolName) || !upstream) return false
  if (!isProviderError(e) || e.audit) return false
  if (!REFUNDABLE_CODES.has(e.code)) return false
  if (isAbuseRefusal(e)) return false
  const fromPlatform =
    e.upstream != null &&
    (e.upstream.code != null || e.upstream.httpStatus != null)
  // a validation error must be the platform's answer, not the adapter checking the AI's input
  if (e.code === "invalid_request" && !fromPlatform) return false
  if (upstream.writes === 0) return true
  if (upstream.unclearEarlierWrites > 0 || !upstream.lastIsWrite) return false
  const status = upstream.lastWriteStatus ?? 0
  if (status <= 0) return false
  // the last write was refused by HTTP status, or answered 200 with the platform error envelope that became `e`
  return (
    isRefusalStatus(status) ||
    (status >= 200 && status < 300 && fromPlatform && e.upstream?.code != null)
  )
}
