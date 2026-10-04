// Credential validation + account listing. One Ads API key is scoped to exactly one ad account.
import { isProviderError } from "../errors"
import { addDays, todayInTz } from "../dates"
import type { AccountStatus, AdAccountInfo, ConnectionContext, CredentialCheck } from "../types"
import { apiVersion, oaRequest, type OpenAIAdsClientCtx } from "./client"
import type { OpenAIAdsCredentials } from "./credentials"

export interface RawAdAccount {
  id: string
  name: string
  legal_name?: string
  account_name?: string
  brand_name?: string
  url: string
  preview_url: string | null
  status?: string
  timezone: string
  currency_code: string
  review: { status: string; reason?: string; screenshot_url?: string }
}

export type FeatureFlag = boolean | null

export interface OpenAIAdsFeatures {
  /** /conversions/event_settings reachable (conversion tracking + conversion bidding/reports) */
  conversions: FeatureFlag
  /** insights segments[] (country/device/product/platform) */
  insights_segments: FeatureFlag
  /** /ad_account/spend_limit_windows */
  spend_limit_windows: FeatureFlag
  /** Bulk API (limited preview, not in the OpenAPI spec) */
  bulk: FeatureFlag
}

type Ctx = ConnectionContext<OpenAIAdsCredentials>

export function getAdAccount(ctx: OpenAIAdsClientCtx): Promise<RawAdAccount> {
  return oaRequest<RawAdAccount>(ctx, { method: "GET", path: "/ad_account" })
}

export function mapAccountStatus(raw: RawAdAccount): AccountStatus {
  const s = (raw.status ?? "").toLowerCase()
  const review = (raw.review?.status ?? "").toLowerCase()
  if (["closed", "archived", "deleted"].includes(s)) return "closed"
  if (["suspended", "disabled", "paused"].includes(s) || review === "rejected") return "disabled"
  if (review === "in_review") return "pending"
  if (s === "active" || (!s && review === "approved")) return "active"
  return "unknown"
}

export function toAccountInfo(raw: RawAdAccount): AdAccountInfo {
  return {
    externalId: raw.id,
    name: raw.name || raw.brand_name || raw.account_name || raw.id,
    currency: raw.currency_code,
    timezone: raw.timezone,
    status: mapAccountStatus(raw),
    statusRaw: [raw.status ?? "unknown", raw.review?.status ? `review:${raw.review.status}` : null].filter(Boolean).join(" "),
    isManager: false,
    parentExternalId: null,
    extra: {
      legal_name: raw.legal_name ?? null,
      brand_name: raw.brand_name ?? null,
      url: raw.url ?? null,
      review_status: raw.review?.status ?? null,
      review_reason: raw.review?.reason ?? null,
    },
  }
}

export async function listAccounts(ctx: Ctx): Promise<AdAccountInfo[]> {
  return [toAccountInfo(await getAdAccount(ctx))]
}

/** true = works, false = 403/404 (not enabled), null = could not tell */
async function probe(fn: () => Promise<unknown>): Promise<FeatureFlag> {
  try {
    await fn()
    return true
  } catch (e) {
    if (isProviderError(e)) {
      if (e.code === "auth_invalid") throw e
      if (e.code === "feature_not_enabled" || e.code === "not_found" || e.code === "permission_denied") return false
    }
    return null
  }
}

/**
 * Bulk API (limited preview, not in the OpenAPI spec, no list endpoint): submit a validate-only job with
 * zero operations - nothing can be mutated. 404/403 → disabled; a validation error (400/422) or success
 * means the endpoint exists → enabled; anything else → unknown.
 */
async function probeBulk(ctx: OpenAIAdsClientCtx): Promise<FeatureFlag> {
  try {
    await oaRequest(ctx, {
      method: "POST",
      path: "/bulk_mutation_jobs",
      body: { validate_only: true, partial_failure: false, operations: [] },
      gated: true,
      readOnly: true,
    })
    return true
  } catch (e) {
    if (!isProviderError(e)) return null
    if (e.code === "auth_invalid") throw e
    if (e.code === "feature_not_enabled" || e.code === "permission_denied") return false
    if (e.code === "invalid_request") return true
    return null
  }
}

export async function probeFeatures(ctx: OpenAIAdsClientCtx, timezone: string): Promise<OpenAIAdsFeatures> {
  const yesterday = addDays(todayInTz(timezone), -1)
  const [conversions, insights_segments, spend_limit_windows, bulk] = await Promise.all([
    probe(() => oaRequest(ctx, { method: "GET", path: "/conversions/event_settings", query: { limit: 1 }, gated: true })),
    probe(() =>
      oaRequest(ctx, {
        method: "GET",
        path: "/ad_account/insights",
        gated: true,
        query: {
          aggregation_level: "ad_account",
          time_granularity: "none",
          segments: ["country"],
          fields: ["country.name", "country.impressions"],
          limit: 1,
          time_ranges: [JSON.stringify({ type: "date_range", since: yesterday, until: yesterday, timezone })],
        },
      })
    ),
    probe(() => oaRequest(ctx, { method: "GET", path: "/ad_account/spend_limit_windows", gated: true })),
    probeBulk(ctx),
  ])
  return { conversions, insights_segments, spend_limit_windows, bulk }
}

export async function validateCredentials(ctx: Ctx): Promise<CredentialCheck> {
  let account: RawAdAccount
  try {
    account = await getAdAccount(ctx)
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") {
      return {
        valid: false,
        tokenExpiresAt: null,
        scopes: null,
        warnings: [e.userMessageVi],
        meta: { apiVersion: apiVersion(), requestId: e.upstream?.requestId ?? null },
      }
    }
    throw e
  }
  const warnings: string[] = []
  const review = account.review?.status
  if (review === "in_review") warnings.push("Tài khoản quảng cáo đang được OpenAI xét duyệt - quảng cáo chưa thể chạy.")
  if (review === "rejected") warnings.push("Tài khoản quảng cáo bị OpenAI từ chối - kiểm tra trong ads.openai.com.")
  const features = await probeFeatures(ctx, account.timezone)
  if (features.conversions === false) {
    warnings.push("Tài khoản chưa bật Conversions - chiến dịch tối ưu chuyển đổi và báo cáo chuyển đổi sẽ không dùng được.")
  }
  return {
    valid: true,
    tokenExpiresAt: null,
    scopes: null,
    warnings,
    meta: {
      apiVersion: apiVersion(),
      adAccountId: account.id,
      adAccountName: account.name,
      currency: account.currency_code,
      timezone: account.timezone,
      features,
      featuresCheckedAt: new Date().toISOString(),
    },
  }
}
