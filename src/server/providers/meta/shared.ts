// Small helpers shared by the Meta adapter modules.
import { ProviderError } from "../errors"
import { fromMetaMinor } from "../money"
import type {
  AccountStatus,
  Budget,
  ConnectionContext,
  NormalizedStatus,
  ObjectLevel,
  ProviderContext,
} from "../types"
import { accountNumericId, actId, type MetaCallContext, type MetaCredentials } from "./client"

export type MetaLevel = "campaign" | "adset" | "ad"

export function callCtx(ctx: ProviderContext<MetaCredentials>): MetaCallContext {
  return {
    credentials: ctx.credentials,
    accountId: actId(ctx.account.externalId),
    signal: ctx.signal,
    onUpstream: ctx.onUpstream,
  }
}

export function connCallCtx(ctx: ConnectionContext<MetaCredentials>): MetaCallContext {
  return { credentials: ctx.credentials, signal: ctx.signal, onUpstream: ctx.onUpstream }
}

export function toMetaLevel(level: ObjectLevel): MetaLevel {
  switch (level) {
    case "campaign":
      return "campaign"
    case "ad_group":
      return "adset"
    case "ad":
      return "ad"
    default:
      throw new ProviderError({
        platform: "meta",
        code: "unsupported",
        message: `meta: level ${level} is not supported`,
        userMessageVi: "Meta không có cấp từ khoá (keyword).",
      })
  }
}

export function fromMetaLevel(level: MetaLevel): ObjectLevel {
  return level === "adset" ? "ad_group" : level
}

export const LEVEL_EDGE: Record<MetaLevel, string> = { campaign: "campaigns", adset: "adsets", ad: "ads" }
export const LEVEL_VI: Record<MetaLevel, string> = { campaign: "chiến dịch", adset: "nhóm quảng cáo", ad: "quảng cáo" }

/** effective_status / status → normalized status */
export function mapEffectiveStatus(raw: string | null | undefined): NormalizedStatus {
  switch ((raw ?? "").toUpperCase()) {
    case "ACTIVE":
      return "active"
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "paused"
    case "ARCHIVED":
      return "archived"
    case "DELETED":
      return "deleted"
    case "PENDING_REVIEW":
    case "IN_PROCESS":
    case "PREAPPROVED":
      return "pending_review"
    case "DISAPPROVED":
      return "rejected"
    case "WITH_ISSUES":
    case "PENDING_BILLING_INFO":
      return "disabled"
    default:
      return "unknown"
  }
}

/**
 * Valid `effective_status` values per object level (Graph API reference: Ad Campaign / Ad Set / Ad).
 * Campaign: no *_PAUSED inheritance and no review states; ad set: + CAMPAIGN_PAUSED; ad: everything.
 * Sending a value that is not in the level's enum makes Meta reject the filter (#100).
 */
export const EFFECTIVE_STATUSES_BY_LEVEL: Record<MetaLevel, readonly string[]> = {
  campaign: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
  adset: ["ACTIVE", "PAUSED", "DELETED", "CAMPAIGN_PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
  ad: [
    "ACTIVE",
    "PAUSED",
    "DELETED",
    "PENDING_REVIEW",
    "DISAPPROVED",
    "PREAPPROVED",
    "PENDING_BILLING_INFO",
    "CAMPAIGN_PAUSED",
    "ARCHIVED",
    "ADSET_PAUSED",
    "IN_PROCESS",
    "WITH_ISSUES",
  ],
}

/**
 * Normalized statuses → Meta effective_status values (for filtering), restricted to the values valid for
 * `level` when given. An empty result means no object of that level can have the requested status.
 */
export function effectiveStatusesFor(statuses: NormalizedStatus[], level?: MetaLevel): string[] {
  const out = new Set<string>()
  for (const s of statuses) {
    switch (s) {
      case "active":
        out.add("ACTIVE")
        break
      case "paused":
        out.add("PAUSED").add("CAMPAIGN_PAUSED").add("ADSET_PAUSED")
        break
      case "archived":
        out.add("ARCHIVED")
        break
      case "deleted":
      case "removed":
        out.add("DELETED")
        break
      case "pending_review":
        out.add("PENDING_REVIEW").add("IN_PROCESS").add("PREAPPROVED")
        break
      case "rejected":
        out.add("DISAPPROVED")
        break
      case "disabled":
        out.add("WITH_ISSUES").add("PENDING_BILLING_INFO")
        break
    }
  }
  const valid = level ? EFFECTIVE_STATUSES_BY_LEVEL[level] : null
  return [...out].filter((v) => !valid || valid.includes(v))
}

/** Every effective_status of a level (used to include DELETED/ARCHIVED objects). */
export function allEffectiveStatuses(level: MetaLevel): string[] {
  return [...EFFECTIVE_STATUSES_BY_LEVEL[level]]
}

/** Filtering by statuses that no object of this level can have → reject instead of silently dropping the filter. */
export function noMatchingStatus(level: MetaLevel): ProviderError {
  return invalid(
    `Trạng thái đã chọn không áp dụng cho cấp ${LEVEL_VI[level]} trên Meta.`,
    "Ví dụ: chỉ quảng cáo mới có trạng thái bị từ chối/chờ duyệt."
  )
}

export const ACCOUNT_STATUS: Record<number, { status: AccountStatus; raw: string }> = {
  1: { status: "active", raw: "ACTIVE" },
  2: { status: "disabled", raw: "DISABLED" },
  3: { status: "disabled", raw: "UNSETTLED" },
  7: { status: "pending", raw: "PENDING_RISK_REVIEW" },
  8: { status: "pending", raw: "PENDING_SETTLEMENT" },
  9: { status: "active", raw: "IN_GRACE_PERIOD" },
  100: { status: "closed", raw: "PENDING_CLOSURE" },
  101: { status: "closed", raw: "CLOSED" },
  201: { status: "active", raw: "ANY_ACTIVE" },
  202: { status: "closed", raw: "ANY_CLOSED" },
}

export function mapAccountStatus(code: unknown): { status: AccountStatus; raw: string } {
  const n = typeof code === "number" ? code : Number(code)
  return ACCOUNT_STATUS[n] ?? { status: "unknown", raw: String(code ?? "UNKNOWN") }
}

function positiveMinor(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false
  const n = Number(v)
  return Number.isFinite(n) && n > 0
}

/** Budget from a campaign/adset node (minor units → major). */
type BudgetNode = { daily_budget?: unknown; lifetime_budget?: unknown } & Record<string, unknown>

export function budgetFromNode(
  node: BudgetNode,
  currency: string,
  level: "campaign" | "ad_group"
): Budget | null {
  if (positiveMinor(node.daily_budget)) {
    return { type: "daily", amount: fromMetaMinor(node.daily_budget as string, currency)!, currency, level }
  }
  if (positiveMinor(node.lifetime_budget)) {
    return { type: "lifetime", amount: fromMetaMinor(node.lifetime_budget as string, currency)!, currency, level }
  }
  return null
}

export function hasBudget(node: BudgetNode | null | undefined): boolean {
  return !!node && (positiveMinor(node.daily_budget) || positiveMinor(node.lifetime_budget))
}

/** Throw not_found when an object does not belong to the ad account of the context (grant boundary). */
export function assertSameAccount(
  ctx: ProviderContext<MetaCredentials>,
  node: { id?: string; account_id?: string | number | null },
  what: string
): void {
  const expected = accountNumericId(ctx.account.externalId)
  const got = node.account_id === undefined || node.account_id === null ? null : accountNumericId(String(node.account_id))
  if (got !== expected) {
    throw new ProviderError({
      platform: "meta",
      code: "not_found",
      message: `meta: ${what} ${node.id ?? ""} does not belong to ${ctx.account.externalId}`,
      userMessageVi: `Không tìm thấy ${what} ${node.id ?? ""} trong tài khoản quảng cáo đã chọn.`,
      hint: "Gọi ads_list_objects với đúng account_id để lấy id.",
    })
  }
}

export function invalid(messageVi: string, hint?: string): ProviderError {
  return new ProviderError({
    platform: "meta",
    code: "invalid_request",
    message: `meta: ${messageVi}`,
    userMessageVi: messageVi,
    hint,
  })
}

/** Format a MAJOR amount for Vietnamese messages ("500.000 VND", "12,5 USD"). */
export function fmtMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return "-"
  return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(amount)} ${currency}`
}

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
])

export function isEuCountry(code: string): boolean {
  return EU_COUNTRIES.has(code.toUpperCase())
}

export function base64UrlJson(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64url")
}

export function parseBase64UrlJson<T>(s: string): T | null {
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T
  } catch {
    return null
  }
}

export function invalidCursor(): ProviderError {
  return invalid("Cursor không hợp lệ hoặc không khớp với truy vấn. Hãy gọi lại từ đầu không kèm cursor.")
}
