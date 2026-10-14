// Apify API errors → ApifyError (16-apify.md §4, providers/apify.md §9). No imports from "next/*".
// Classification is by HTTP status AND `error.type` (the spec's ErrorType enum is incomplete: several variants are
// matched). `rotate` tells the token pool what to do when a run cannot START with this token:
//   "exhausted" → the whole Apify account (same apify_user_id) is out of credit until the cycle ends
//   "invalid"   → this token is rejected (401 / disabled account): mark it invalid
//   "busy"      → this account cannot take the run right now (RAM / concurrent runs / plan / scoped token): skip it
//   null        → not a token problem (input, Actor, rate limit, 5xx…): fail immediately, never try another token
// Messages never contain a URL or a token; the upstream message is redacted, cleaned and capped.
import { apifyErrors as m } from "@/lib/i18n/vi/apify-errors"
import { sanitizeExternalLabel } from "@/lib/text-safety"
import { redactString } from "@/server/audit/redact"

export type ApifyErrorCode = keyof typeof m.api
export type ApifyRotate = "exhausted" | "invalid" | "busy" | null

const ROTATE: Partial<Record<ApifyErrorCode, Exclude<ApifyRotate, null>>> = {
  invalid_token: "invalid",
  out_of_credit: "exhausted",
  account_busy: "busy",
  paid_plan_required: "busy",
  insufficient_permissions: "busy",
}

const RETRYABLE: ReadonlySet<ApifyErrorCode> = new Set<ApifyErrorCode>([
  "rate_limited",
  "upstream",
  "timeout",
  "network",
])

const UPSTREAM_MESSAGE_MAX = 300

/** untrusted upstream text: secrets redacted, control / bidi characters removed, capped */
export function cleanUpstreamText(
  v: unknown,
  max = UPSTREAM_MESSAGE_MAX
): string | null {
  if (typeof v !== "string") return null
  // cut first: the redaction regexes must never run over an arbitrarily long upstream string
  return sanitizeExternalLabel(redactString(v.slice(0, max * 4)), max)
}

export class ApifyError extends Error {
  readonly code: ApifyErrorCode
  /** HTTP status answered by Apify; null when there was no answer */
  readonly httpStatus: number | null
  /** Apify `error.type` (e.g. "user-or-token-not-found") */
  readonly apifyType: string | null
  /** Apify `error.message`, redacted + cleaned + ≤ 300 chars (logs / platform_error; untrusted text) */
  readonly upstreamMessage: string | null
  /** worth retrying later (429, 5xx, timeout, network) */
  readonly retryable: boolean
  readonly rotate: ApifyRotate
  /** Retry-After of a 429 / 503 answer (seconds), when Apify sent one */
  readonly retryAfterSec: number | null
  readonly userMessageVi: string
  readonly hint: string | null

  constructor(
    code: ApifyErrorCode,
    o: {
      httpStatus?: number | null
      apifyType?: string | null
      upstreamMessage?: string | null
      message?: string
      hint?: string | null
      retryAfterSec?: number | null
    } = {}
  ) {
    // Apify error types are kebab-case words: anything else is dropped (the value may reach logs / the AI)
    const apifyType =
      o.apifyType
        ? String(o.apifyType)
            .slice(0, 200)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "")
            .slice(0, 100) || null
        : null
    super(
      `apify ${code}${o.httpStatus ? ` ${o.httpStatus}` : ""}${apifyType ? ` ${apifyType}` : ""}`
    )
    this.name = "ApifyError"
    this.code = code
    this.httpStatus = o.httpStatus ?? null
    this.apifyType = apifyType
    this.upstreamMessage = cleanUpstreamText(o.upstreamMessage)
    this.retryable = RETRYABLE.has(code)
    this.rotate = ROTATE[code] ?? null
    this.retryAfterSec = o.retryAfterSec ?? null
    this.userMessageVi = o.message ?? m.api[code].message
    this.hint = o.hint === undefined ? m.api[code].hint : o.hint
  }
}

export function isApifyError(e: unknown): e is ApifyError {
  return e instanceof ApifyError
}

/** "message hint" (Vietnamese) of an ApifyError - for status_message / user-facing errors */
export function apifyErrorText(e: ApifyError): string {
  return e.hint ? `${e.userMessageVi} ${e.hint}` : e.userMessageVi
}

// ---------------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------------

/** out of credit / monthly hard limit / billing (never x402: that one means "no token sent") */
const CREDIT_TYPE_RE =
  /not-enough-usage|usage-limit|monthly-usage|usage-hard-limit|hard-limit|insufficient-credit|not-enough-credit|credits?-exhausted|payment-required|billing/
const CREDIT_MESSAGE_RE =
  /hard limit|usage limit|monthly usage|not enough (usage|credit)|insufficient (credit|funds)|exceeded (your|their) (usage|limit)|credits? (exhausted|exceeded)/i
const MEMORY_TYPE_RE = /memory-limit-exceeded/
const CONCURRENCY_TYPE_RE =
  /concurrent-runs?|cannot-start-actor-runs?|too-many-(concurrent|running)|max-concurrent/
const PAID_PLAN_TYPES = new Set([
  "apify-plan-required-to-use-paid-actor",
  "actor-is-not-rented",
  "rental-not-allowed",
  "cannot-rent-paid-actor",
  "paid-actor-requires-paid-plan",
])
const ACTOR_BLOCKED_TYPES = new Set([
  "full-permission-actor-not-approved",
  "actor-disabled",
  "public-actor-disabled",
  "actor-is-deprecated",
  "actor-under-maintenance",
])
const CHARGE_LIMIT_TYPES = new Set([
  "max-total-charge-usd-below-minimum",
  "max-total-charge-usd-must-be-greater-than-zero",
])

/**
 * Apify error answer → ApifyError (pure, exported for tests). `body` is the parsed JSON (`{error:{type,message}}`)
 * or null when unreadable.
 */
export function mapApifyError(
  httpStatus: number,
  body: unknown,
  extra: { retryAfterSec?: number | null } = {}
): ApifyError {
  const err =
    body && typeof body === "object"
      ? (body as { error?: unknown }).error
      : undefined
  const e =
    err && typeof err === "object" ? (err as Record<string, unknown>) : {}
  const type = typeof e.type === "string" ? e.type.trim().toLowerCase() : ""
  const message = typeof e.message === "string" ? e.message : ""
  const make = (code: ApifyErrorCode) =>
    new ApifyError(code, {
      httpStatus,
      apifyType: type || null,
      upstreamMessage: message || null,
      retryAfterSec: extra.retryAfterSec ?? null,
    })

  // 402 x402-payment-required = the request carried NO token (Apify offers anonymous x402 payments): a bug, not
  // an empty wallet - never rotate / mark tokens on it
  if (type === "x402-payment-required" || type === "token-not-provided")
    return make("token_missing")
  if (MEMORY_TYPE_RE.test(type) || CONCURRENCY_TYPE_RE.test(type))
    return make("account_busy")
  if (PAID_PLAN_TYPES.has(type)) return make("paid_plan_required")
  if (CHARGE_LIMIT_TYPES.has(type)) return make("charge_limit_invalid")
  if (ACTOR_BLOCKED_TYPES.has(type)) return make("actor_not_allowed")
  if (type === "user-disabled") return make("invalid_token")
  if (type === "insufficient-permissions" || type === "insufficient-permission")
    return make("insufficient_permissions")
  if (CREDIT_TYPE_RE.test(type)) return make("out_of_credit")
  // 403 platform-feature-disabled: "Monthly usage hard limit exceeded" (or the account may not run Actors now -
  // billing): treat as out of credit until the cycle ends; apify.health re-checks the account
  if (type === "platform-feature-disabled") return make("out_of_credit")
  if (type === "invalid-input") return make("input_invalid")
  if (type === "rate-limit-exceeded") return make("rate_limited")

  if (httpStatus === 401) return make("invalid_token")
  // any other 402: "exceeded their usage limit, does not have enough credits…"
  if (httpStatus === 402) return make("out_of_credit")
  if (httpStatus === 403 && CREDIT_MESSAGE_RE.test(message))
    return make("out_of_credit")
  if (httpStatus === 403) return make("forbidden")
  if (httpStatus === 404) return make("not_found")
  if (httpStatus === 429) return make("rate_limited")
  if (httpStatus >= 500 || httpStatus === 408) return make("upstream")
  if (httpStatus >= 400) return make("bad_request")
  return make("invalid_response")
}
