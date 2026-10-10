// GMV Max detection for the generic write guards (decision D3, .claude/docs/providers/tiktok.md §8).
// /campaign/get/ has no reliable GMV Max flag: rows that are not a KNOWN non-shop objective are CANDIDATES
// (PRODUCT_SALES is shared with VSA/LSA; a missing / unknown objective_type fails closed). Candidates are
// cross-checked with GET /gmv_max/campaign/get/ (doc 1826463372290177: `filtering` is required with
// gmv_max_promotion_types; campaign_ids ≤100; page_size 1-100; `fields` is a documented parameter).
// No candidate → zero extra calls (existing behaviour unchanged). A failed check throws: callers fail CLOSED.
// Dependency-light on purpose (api.ts + shared strings only) so objects.ts / mutate.ts / copy.ts / gmv-max.ts can
// all import it.
import { isProviderError, ProviderError } from "../errors"
import type { TargetStatus } from "../types"
import { chunk, normalizeStatus, ttGetAll, type Raw, type TT } from "./api"
import {
  gmvMaxEnableWarning,
  gmvMaxPauseWarning,
  gmvMaxPermissionUnverifiedMessage,
  gmvMaxNoAdGroupsMessage,
  gmvMaxScopeHint,
  gmvMaxUnverifiedMessage,
} from "./gmv-max-text"

export type GmvMaxType = "PRODUCT" | "LIVE"

/** gmv_max_promotion_types value → our type, in query order. */
export const GMV_MAX_PROMOTION_TYPES: readonly (readonly [
  string,
  GmvMaxType,
])[] = [
  ["PRODUCT_GMV_MAX", "PRODUCT"],
  ["LIVE_GMV_MAX", "LIVE"],
]

/** /gmv_max/campaign/get/ limits: campaign_ids ≤100, page_size 1-100. */
export const GMV_MAX_IDS_PER_CALL = 100

/**
 * Objectives that are certainly NOT TikTok Shop campaigns (TikTok objective_type enum, tiktok.md §4 /campaign/create/:
 * REACH|TRAFFIC|VIDEO_VIEWS|ENGAGEMENT|APP_PROMOTION|LEAD_GENERATION|WEB_CONVERSIONS|PRODUCT_SALES|RF_REACH).
 * Everything else - PRODUCT_SALES, a missing/empty value or an objective we do not know - is a GMV Max candidate.
 */
export const NON_SHOP_OBJECTIVES: ReadonlySet<string> = new Set([
  "REACH",
  "RF_REACH",
  "TRAFFIC",
  "VIDEO_VIEWS",
  "ENGAGEMENT",
  "APP_PROMOTION",
  "LEAD_GENERATION",
  "WEB_CONVERSIONS",
])

/** GMV Max hint for refusals: the GMV Max tools to use instead. */
export const GMV_MAX_READ_TOOLS_HINT =
  "Xem bằng tiktok_gmv_max_campaigns / tiktok_gmv_max_report; sản phẩm / video đổi bằng tiktok_gmv_max_update / tiktok_gmv_max_creatives (cần quản trị viên bật quyền GMV Max cho MCP)."

/** Status change requested on campaigns whose GMV Max check failed (fail closed: handled as GMV Max). */
export function gmvMaxStatusUnverifiedWarning(ids: string[]): string {
  return (
    `Không xác minh được chiến dịch ${ids.join(", ")} có phải GMV Max hay không (TikTok không trả lời yêu cầu kiểm tra) - ` +
    "xử lý như GMV Max để an toàn: luôn cần xác nhận 2 bước."
  )
}

/** Same, when the check was refused for lack of permission (40001/40125). */
export function gmvMaxStatusPermissionWarning(ids: string[]): string {
  return (
    `Token chưa có quyền đọc chiến dịch GMV Max nên không xác minh được chiến dịch ${ids.join(", ")} có phải GMV Max hay không - ` +
    "xử lý như GMV Max để an toàn: luôn cần xác nhận 2 bước. Cấp quyền Ads Management > Campaign > Read Campaigns cho developer app để kiểm tra được."
  )
}

/**
 * Error text safe for warnings: our Vietnamese text + the upstream code only - never the raw TikTok message
 * (mapTikTokError appends " (TikTok: <message>)" to userMessageVi).
 */
export function gmvMaxErrorText(e: unknown): string {
  if (!isProviderError(e)) return "Lỗi không xác định khi gọi TikTok."
  const raw = e.upstream?.message ?? ""
  let vi = e.userMessageVi
  const suffix = raw ? ` (TikTok: ${raw})` : ""
  if (suffix && vi.endsWith(suffix)) vi = vi.slice(0, -suffix.length)
  else vi = vi.replace(/\s*\(TikTok: [\s\S]*\)$/, "")
  const code = e.upstream?.code
  return code !== undefined && code !== null ? `${vi} (mã ${code})` : vi
}

/** A /campaign/get/ row that may be a GMV Max campaign (any objective that is not a known non-shop one). */
export function isGmvMaxCandidate(row: Raw): boolean {
  if (row.campaign_id === undefined || row.campaign_id === null) return false
  const objective =
    typeof row.objective_type === "string" ? row.objective_type.trim() : ""
  return !NON_SHOP_OBJECTIVES.has(objective)
}

/** Unique campaign ids of the candidate rows, in input order. */
export function gmvMaxCandidateIds(rows: Raw[]): string[] {
  return [
    ...new Set(
      rows.filter(isGmvMaxCandidate).map((r) => String(r.campaign_id))
    ),
  ]
}

/**
 * Which of the given raw /campaign/get/ rows are GMV Max campaigns → Map<campaign_id, "PRODUCT"|"LIVE">.
 * Only candidates are checked; without candidates nothing is called. Throws (ProviderError from the client) when a
 * check call fails - callers must fail closed.
 * The default `primary_status` of /gmv_max/campaign/get/ is undocumented (only STATUS_DELIVERY_OK / STATUS_DISABLE /
 * STATUS_DELETE are), so the check runs in passes, each only for the ids still unresolved:
 *   1. no primary_status (the doc example returns DISABLE campaigns);
 *   2. primary_status STATUS_DISABLE;
 *   3. primary_status STATUS_DELETE - only for candidates that /campaign/get/ itself reports deleted.
 * Each pass: PRODUCT_GMV_MAX then LIVE_GMV_MAX, campaign_ids in batches of ≤100.
 */
export async function detectGmvMaxCampaigns(
  tt: TT,
  rawCampaigns: Raw[]
): Promise<Map<string, GmvMaxType>> {
  const found = new Map<string, GmvMaxType>()
  const candidates = gmvMaxCandidateIds(rawCampaigns)
  if (!candidates.length) return found
  const deleted = new Set(
    rawCampaigns
      .filter(
        (r) =>
          isGmvMaxCandidate(r) &&
          normalizeStatus(r.operation_status, r.secondary_status) === "deleted"
      )
      .map((r) => String(r.campaign_id))
  )
  const passes: { primaryStatus: string | null; ids: string[] }[] = [
    { primaryStatus: null, ids: candidates },
    { primaryStatus: "STATUS_DISABLE", ids: candidates },
    {
      primaryStatus: "STATUS_DELETE",
      ids: candidates.filter((id) => deleted.has(id)),
    },
  ]
  for (const pass of passes) {
    for (const [promotionType, type] of GMV_MAX_PROMOTION_TYPES) {
      const remaining = pass.ids.filter((id) => !found.has(id))
      if (!remaining.length) break
      for (const batch of chunk(remaining, GMV_MAX_IDS_PER_CALL)) {
        const filtering: Raw = {
          gmv_max_promotion_types: [promotionType],
          campaign_ids: batch,
        }
        if (pass.primaryStatus) filtering.primary_status = pass.primaryStatus
        const list = await ttGetAll<Raw>(
          tt,
          "gmv_max/campaign/get",
          {
            advertiser_id: tt.advertiserId,
            fields: ["campaign_id"],
            filtering,
          },
          { pageSize: GMV_MAX_IDS_PER_CALL, max: GMV_MAX_IDS_PER_CALL }
        )
        for (const row of list) {
          const id = String(row.campaign_id ?? "")
          if (batch.includes(id) && !found.has(id)) found.set(id, type)
        }
      }
    }
  }
  return found
}

/** ProviderError for a write refused because the GMV Max check failed (fail closed). auth_invalid is returned as is. */
export function gmvMaxCheckFailure(e: unknown, id: string): ProviderError {
  if (isProviderError(e) && e.code === "auth_invalid") return e
  const denied = isProviderError(e) && e.code === "permission_denied"
  return new ProviderError({
    platform: "tiktok",
    code: denied ? "permission_denied" : "upstream_error",
    message: `TikTok GMV Max check failed for campaign ${id} (write refused, fail closed)`,
    userMessageVi: denied
      ? gmvMaxPermissionUnverifiedMessage(id)
      : gmvMaxUnverifiedMessage(id),
    hint: denied
      ? gmvMaxScopeHint("/gmv_max/campaign/get/")
      : `TikTok: ${gmvMaxErrorText(e)}`.slice(0, 400),
    retryable: denied ? false : isProviderError(e) ? e.retryable : true,
    upstream: isProviderError(e) ? e.upstream : undefined,
    cause: e,
  })
}

/**
 * Refuse a new ad group under a GMV Max campaign (GMV Max has no ad groups / ads in the API). Non-candidates return without any
 * call. Check failure on a candidate → refused as unverifiable (fail closed; a permission refusal gets its own message
 * + scope hint); an invalid token keeps its own error so the connection is flagged.
 */
export async function assertNotGmvMaxCampaign(
  tt: TT,
  campaign: Raw
): Promise<void> {
  if (!isGmvMaxCandidate(campaign)) return
  const id = String(campaign.campaign_id)
  let gmv: Map<string, GmvMaxType>
  try {
    gmv = await detectGmvMaxCampaigns(tt, [campaign])
  } catch (e) {
    throw gmvMaxCheckFailure(e, id)
  }
  if (gmv.has(id)) {
    throw new ProviderError({
      platform: "tiktok",
      code: "unsupported",
      message: `gmv_max_no_ad_groups: campaign ${id} is a ${gmv.get(id)} GMV Max campaign`,
      userMessageVi: gmvMaxNoAdGroupsMessage(id),
      hint: GMV_MAX_READ_TOOLS_HINT,
    })
  }
}

export interface GmvMaxStatusCheck {
  /** campaign ids handled as GMV Max (detected, or unverifiable → fail closed) */
  ids: string[]
  /** Vietnamese warnings for the preview / result (empty when no GMV Max campaign) */
  warnings: string[]
}

/**
 * set_status on campaign rows (D3): GMV Max ids get a pause/enable warning; when the check fails every candidate is
 * handled as GMV Max (fail closed). Deleted rows are ignored. Never throws because of the GMV check.
 */
export async function gmvMaxStatusCheck(
  tt: TT,
  campaigns: Raw[],
  status: TargetStatus
): Promise<GmvMaxStatusCheck> {
  const rows = campaigns.filter(
    (o) => normalizeStatus(o.operation_status, o.secondary_status) !== "deleted"
  )
  const candidates = gmvMaxCandidateIds(rows)
  if (!candidates.length) return { ids: [], warnings: [] }
  const warn = status === "active" ? gmvMaxEnableWarning : gmvMaxPauseWarning
  try {
    const gmv = await detectGmvMaxCampaigns(tt, rows)
    const ids = candidates.filter((id) => gmv.has(id))
    return { ids, warnings: ids.map(warn) }
  } catch (e) {
    const denied = isProviderError(e) && e.code === "permission_denied"
    return {
      ids: candidates,
      warnings: [
        denied
          ? gmvMaxStatusPermissionWarning(candidates)
          : gmvMaxStatusUnverifiedWarning(candidates),
        ...candidates.map(warn),
      ],
    }
  }
}
