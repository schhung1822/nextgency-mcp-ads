// /ad/create/ has NO request_id in v1.3 → it is never retried automatically. When the outcome is unknown
// (timeout / 5xx / network error) the ads may already exist: look them up by name inside the ad group
// (created after the call started) before reporting a failure, and never mark the failure retryable.
import { ProviderError, isProviderError } from "../errors"
import { parseTikTokTime, str, ttGetAll, ttPost, type Raw, type TT } from "./api"

export const AD_CREATE_VERIFY_HINT =
  "Có thể quảng cáo đã được tạo - kiểm tra trước khi thử lại (ads_list_objects level=ad, parent_id = nhóm quảng cáo)."

/** Clock skew tolerance between our clock and TikTok's create_time. */
const LOOKUP_SKEW_MS = 10 * 60_000

function isUncertain(e: unknown): boolean {
  if (!isProviderError(e)) return true // network/abort error: the request may have reached TikTok
  return e.code === "timeout" || e.code === "upstream_error" || e.code === "unknown"
}

function uncertainError(e: unknown, detail: string): ProviderError {
  const pe = isProviderError(e) ? e : null
  return new ProviderError({
    platform: "tiktok",
    code: pe?.code ?? "upstream_error",
    message: `TikTok /ad/create/ outcome unknown: ${pe?.message ?? String(e)}`,
    userMessageVi: `TikTok không phản hồi rõ khi tạo quảng cáo (${pe?.userMessageVi ?? "lỗi mạng"}). ${detail}`,
    retryable: false,
    hint: AD_CREATE_VERIFY_HINT,
    upstream: pe?.upstream,
    cause: e,
  })
}

/**
 * POST /ad/create/ once (no retry). Returns the new ad ids aligned with `creatives` (null = not created / not
 * found). After an uncertain failure, ads found by name are returned with a warning; if none is found the
 * error is re-thrown as non-retryable with a verify-before-retry hint.
 */
export async function createAdsChecked(
  tt: TT,
  adgroupId: string,
  creatives: Raw[],
  warnings: string[],
  now: () => number = Date.now
): Promise<(string | null)[]> {
  const started = now()
  try {
    const res = await ttPost<{ ad_ids?: string[] }>(
      tt,
      "ad/create",
      { advertiser_id: tt.advertiserId, adgroup_id: adgroupId, creatives },
      { retries: 0 }
    )
    const ids = (res.data.ad_ids ?? []).map(String)
    return creatives.map((_, i) => ids[i] ?? null)
  } catch (e) {
    if (!isUncertain(e)) throw e
    let found: (string | null)[]
    try {
      found = await findCreatedAds(tt, adgroupId, creatives, started - LOOKUP_SKEW_MS)
    } catch {
      throw uncertainError(e, "Không kiểm tra lại được danh sách quảng cáo trong nhóm.")
    }
    const n = found.filter(Boolean).length
    if (n === 0) throw uncertainError(e, "Chưa thấy quảng cáo mới trong nhóm (TikTok có thể hiển thị trễ).")
    warnings.push(
      n === creatives.length
        ? "TikTok phản hồi lỗi/timeout nhưng quảng cáo đã được tạo - dùng id tìm thấy, không tạo lại."
        : `TikTok phản hồi lỗi/timeout; chỉ tìm thấy ${n}/${creatives.length} quảng cáo vừa tạo - phần còn lại có thể chưa tạo hoặc chưa hiển thị. ${AD_CREATE_VERIFY_HINT}`
    )
    return found
  }
}

async function findCreatedAds(tt: TT, adgroupId: string, creatives: Raw[], sinceMs: number): Promise<(string | null)[]> {
  const ads = await ttGetAll<Raw>(
    tt,
    "ad/get",
    {
      advertiser_id: tt.advertiserId,
      filtering: { adgroup_ids: [adgroupId], primary_status: "STATUS_NOT_DELETE" },
      exclude_field_types_in_response: ["NULL_FIELD"],
    },
    { max: 1000 }
  )
  const fresh = ads.filter((a) => {
    const t = parseTikTokTime(a.create_time)
    return !!t && t.getTime() >= sinceMs
  })
  const used = new Set<string>()
  return creatives.map((c) => {
    const hit = fresh.find((a) => !used.has(String(a.ad_id)) && str(a.ad_name) === str(c.ad_name))
    if (!hit) return null
    used.add(String(hit.ad_id))
    return String(hit.ad_id)
  })
}
