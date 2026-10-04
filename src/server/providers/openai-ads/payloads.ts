// Money/time conversions and "sanitize read object → write params" helpers shared by mutate/copy/extensions.
// Update endpoints REPLACE nested objects (budget, bidding_config, creative, targeting, context_hints,
// conversion_event_setting_ids), so every write sends the full merged object built here.
import { ProviderError } from "../errors"
import { roundMoney, toMicros } from "../money"
import { canonicalJson, PLATFORM } from "./client"
import type {
  RawAdGroup,
  RawBiddingConfig,
  RawBudget,
  RawCampaign,
  RawCreative,
  RawLandingPageConfiguration,
  RawProductSet,
  RawTargeting,
} from "./objects"

/** Minimum campaign budget (BudgetParams.minimum). Currency-specific daily minimums are enforced by OpenAI. */
export const MIN_BUDGET_MICROS = 1_000_000
/** BiddingConfigParams.max_bid_micros maximum */
export const MAX_BID_MICROS = 30_400_000_000_000
export const MIN_UNIX = 946_684_800
export const MAX_UNIX = 4_102_444_800

function invalid(message: string, vi: string, hint?: string) {
  return new ProviderError({ platform: PLATFORM, code: "invalid_request", message, userMessageVi: vi, hint })
}

/** MAJOR units → integer micros as a JSON-safe number (string math via toMicros, no float drift). */
export function microsInt(amount: number, what = "amount"): number {
  if (!Number.isFinite(amount) || amount < 0) throw invalid(`Invalid ${what}: ${amount}`, `Số tiền không hợp lệ (${what}).`)
  const micros = Number(toMicros(amount))
  if (!Number.isSafeInteger(micros)) throw invalid(`${what} too large`, `Số tiền quá lớn (${what}).`)
  return micros
}

/** Micros in one minimum currency unit: 10,000 for 2-decimal currencies (USD cent), 1,000,000 for VND/JPY… */
export function minUnitMicros(currency: string): number {
  return roundMoney(0.01, currency || "USD") === 0 ? 1_000_000 : 10_000
}

/** Round micros (half-up) to a multiple of `step`; warn when the value changes. */
function roundTo(micros: number, step: number, what: string, currency: string, warnings?: string[]): number {
  const rounded = Math.round(micros / step) * step
  if (rounded !== micros) {
    warnings?.push(`${what} được làm tròn thành ${rounded / 1_000_000} ${currency} (đơn vị tiền nhỏ nhất).`)
  }
  return rounded
}

/** Budget in the currency's minimum unit (cents for USD, whole đồng for VND). */
export function budgetParams(type: "daily" | "lifetime", amount: number, currency = "USD", warnings?: string[]): RawBudget {
  const micros = roundTo(microsInt(amount, "budget"), minUnitMicros(currency), "Ngân sách", currency, warnings)
  if (micros < MIN_BUDGET_MICROS) {
    throw invalid("Budget below 1,000,000 micros", "Ngân sách tối thiểu là 1 đơn vị tiền tệ của tài khoản (1.000.000 micros).")
  }
  return type === "daily" ? { daily_spend_limit_micros: micros } : { lifetime_spend_limit_micros: micros }
}

/**
 * Bid per billable event. Click/conversion bids are rounded to the currency's minimum unit; impression bids are
 * per impression, so they are rounded to 1/1000 of it (= a whole minimum unit of CPM, e.g. $0.0605 → CPM $60.50).
 */
export function bidMicros(amount: number, currency = "USD", opts: { perImpression?: boolean; warnings?: string[] } = {}): number {
  const step = opts.perImpression ? Math.max(1, minUnitMicros(currency) / 1000) : minUnitMicros(currency)
  const micros = roundTo(microsInt(amount, "bid"), step, "Giá thầu", currency, opts.warnings)
  if (micros < 1) throw invalid("Bid must be > 0", "Giá thầu phải lớn hơn 0 (sau khi làm tròn theo đơn vị tiền tệ).")
  if (micros > MAX_BID_MICROS) throw invalid("Bid too large", "Giá thầu vượt mức tối đa OpenAI Ads cho phép.")
  return micros
}

/** What max_bid means for a campaign bidding_type (oCPC: max_bid_micros is the target CPA). */
export function bidMeaningVi(biddingType: string | null | undefined, billing: string | null | undefined): string {
  if (biddingType === "conversions") return "CPA mục tiêu (giá cho mỗi chuyển đổi)"
  if (billing === "impression" || biddingType === "impressions") return "giá mỗi lượt hiển thị (không phải CPM)"
  return "giá tối đa mỗi lượt nhấp"
}

/** ISO 8601 (with offset) → Unix seconds, validated against the API bounds. */
export function isoToUnix(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw invalid(`Invalid ${field}`, `${field} phải là thời điểm ISO 8601 (vd 2026-10-05T00:00:00+07:00).`)
  const s = Math.floor(ms / 1000)
  if (s < MIN_UNIX || s > MAX_UNIX) throw invalid(`${field} out of range`, `${field} nằm ngoài khoảng 2000-01-01 đến 2100-01-01.`)
  return s
}

// ---------------------------------------------------------------------------
// Read object → write params (drops read-only fields)
// ---------------------------------------------------------------------------

export function budgetToParams(b: RawBudget | null | undefined): RawBudget | undefined {
  if (!b) return undefined
  if (typeof b.daily_spend_limit_micros === "number") return { daily_spend_limit_micros: b.daily_spend_limit_micros }
  if (typeof b.lifetime_spend_limit_micros === "number") return { lifetime_spend_limit_micros: b.lifetime_spend_limit_micros }
  return undefined
}

function geoToParams(g: RawTargeting["locations"]) {
  if (!g) return undefined
  const out: { countries?: string[]; include?: { id: string }[] } = {}
  if (g.countries?.length) out.countries = [...g.countries]
  if (g.include?.length) out.include = g.include.map((l) => ({ id: l.id }))
  return Object.keys(out).length ? out : undefined
}

export function targetingToParams(t: RawTargeting | null | undefined): Record<string, unknown> | undefined {
  if (!t) return undefined
  const out: Record<string, unknown> = {}
  const locations = geoToParams(t.locations)
  if (locations) out.locations = locations
  const excluded = geoToParams(t.excluded_locations)
  if (excluded) out.excluded_locations = excluded
  if (t.custom_audiences?.ids?.length) out.custom_audiences = { ids: [...t.custom_audiences.ids] }
  if (t.excluded_custom_audiences?.ids?.length) out.excluded_custom_audiences = { ids: [...t.excluded_custom_audiences.ids] }
  if (t.platforms?.included?.length) out.platforms = { included: [...t.platforms.included] }
  return Object.keys(out).length ? out : undefined
}

export function landingPageToParams(l: RawLandingPageConfiguration | null | undefined) {
  return l && typeof l.query_string_template === "string" ? { query_string_template: l.query_string_template } : undefined
}

const PARAM_STRATEGIES = new Set(["fixed_bid", "maximize_clicks", "maximize_conversions"])

/** Full bidding_config params from a read object (strategy "automated_bid" is read-only → omitted = AutoBid). */
export function biddingToParams(bc: RawBiddingConfig): RawBiddingConfig {
  const out: RawBiddingConfig = { billing_event_type: bc.billing_event_type }
  const strategy = bc.strategy && PARAM_STRATEGIES.has(bc.strategy) ? bc.strategy : undefined
  if (strategy) out.strategy = strategy
  // fixed bid (explicit, or implied by a bid without strategy); never for Maximize or read-only automated_bid
  const fixed = strategy === "fixed_bid" || (!bc.strategy && typeof bc.max_bid_micros === "number")
  if (fixed && typeof bc.max_bid_micros === "number") out.max_bid_micros = bc.max_bid_micros
  // audience multipliers are only valid with fixed bids
  out.custom_audience_bid_multipliers = fixed
    ? (bc.custom_audience_bid_multipliers ?? []).map((m) => ({
        custom_audience_id: m.custom_audience_id,
        bid_multiplier_micros: m.bid_multiplier_micros,
      }))
    : []
  return out
}

export function productSetToParams(p: RawProductSet | null | undefined) {
  if (!p) return undefined
  return {
    product_feed_id: p.product_feed_id,
    filters: (p.filters ?? []).map((f) => ({ field: f.field, operator: f.operator, values: [...f.values] })),
  }
}

/** Creative params accepted by Create/UpdateAdCreativeParams (image_url is read-only and never sent). */
export function creativeToParams(c: RawCreative): Record<string, unknown> {
  const out: Record<string, unknown> = { type: c.type, title: c.title, body: c.body }
  if (c.price) out.price = c.price
  if (c.target_url) out.target_url = c.target_url
  if (c.file_id) out.file_id = c.file_id
  if (c.image_crop && c.file_id) out.image_crop = { ...c.image_crop }
  return out
}

export function campaignCreateParams(src: RawCampaign, name: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name,
    status: "paused",
    budget: budgetToParams(src.budget),
    bidding_type: src.bidding_type,
  }
  if (src.description) body.description = src.description
  if (src.mode) body.mode = src.mode
  if (src.product_feed_id) body.product_feed_id = src.product_feed_id
  if (src.business_agent_id) body.business_agent_id = src.business_agent_id
  const targeting = targetingToParams(src.targeting)
  if (targeting) body.targeting = targeting
  const lp = landingPageToParams(src.landing_page_configuration)
  if (lp) body.landing_page_configuration = lp
  if (src.conversion_event_setting_ids?.length) body.conversion_event_setting_ids = [...src.conversion_event_setting_ids]
  return body
}

export function adGroupCreateParams(src: RawAdGroup, campaignId: string, name: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    campaign_id: campaignId,
    name,
    status: "paused",
    bidding_config: biddingToParams(src.bidding_config),
  }
  if (src.description) body.description = src.description
  if (src.context_hints?.length) body.context_hints = [...src.context_hints]
  const ps = productSetToParams(src.product_set)
  if (ps) body.product_set = ps
  const lp = landingPageToParams(src.landing_page_configuration)
  if (lp) body.landing_page_configuration = lp
  return body
}

/** Name for copies: prefix + name + suffix, clamped to the API's 3..1000 chars. */
export function copyName(name: string, prefix?: string, suffix?: string): string {
  const out = `${prefix ?? ""}${name}${suffix ?? ""}`.slice(0, 1000)
  return out.length >= 3 && out.trim().length > 0 ? out : out.trim().padEnd(3, "_")
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

/**
 * true when every field of a sent update body is visible on the re-read object (used to decide whether a write
 * that failed with 5xx/timeout was actually saved). Compares the changed fields themselves, not `updated_at`.
 */
export function writeApplied(sent: Record<string, unknown>, obj: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(sent)) {
    const cur = obj[k]
    if (k === "bidding_config") {
      const s = (v ?? {}) as RawBiddingConfig
      const c = (cur ?? {}) as RawBiddingConfig
      if (s.billing_event_type !== undefined && s.billing_event_type !== c.billing_event_type) return false
      if (s.strategy !== undefined && s.strategy !== c.strategy) return false
      if (s.max_bid_micros !== undefined && s.max_bid_micros !== c.max_bid_micros) return false
      const mult = (x: RawBiddingConfig) =>
        (x.custom_audience_bid_multipliers ?? []).map((m) => ({ id: m.custom_audience_id, m: m.bid_multiplier_micros }))
      if (s.custom_audience_bid_multipliers !== undefined && !sameJson(mult(s), mult(c))) return false
    } else if (k === "creative") {
      const s = (v ?? {}) as Record<string, unknown>
      const c = (cur ?? {}) as Record<string, unknown>
      // file_id may be re-issued on re-upload → compare the textual/URL parts only
      for (const f of ["type", "title", "body", "target_url"]) if (s[f] !== undefined && !sameJson(s[f], c[f])) return false
    } else if (k === "budget") {
      const s = (v ?? {}) as Record<string, unknown>
      const c = (cur ?? {}) as Record<string, unknown>
      for (const [bk, bv] of Object.entries(s)) if (c[bk] !== bv) return false
    } else if (k === "targeting") {
      if (!sameJson(v, targetingToParams(cur as RawTargeting | null))) return false
    } else if (!sameJson(v, cur)) {
      return false
    }
  }
  return true
}
