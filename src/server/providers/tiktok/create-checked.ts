// Campaign / ad group creates carry a request_id, but TikTok deduplicates it only for 10 seconds - a blind retry after
// a timeout / 5xx can create a second (paused) object. So creates are retried only on throttle codes inside that window
// (client.ts tiktokCreateRetryDecision) and, when the outcome is unknown (timeout, 5xx, network error, 40050 duplicate
// request_id), the object is looked up by name (created after the call started) before a failure is reported. A failure
// is never marked retryable: the user must check TikTok Ads Manager first. Spec: providers/tiktok.md §4, §6.
import { ProviderError, isProviderError } from "../errors"
import { isServerCode } from "./client"
import {
  parseTikTokTime,
  str,
  ttGetAll,
  ttPost,
  type Raw,
  type TT,
} from "./api"

/** Clock skew tolerance between our clock and TikTok's create_time (same as ad-create.ts). */
const LOOKUP_SKEW_MS = 10 * 60_000

export type CreateKind = "campaign" | "adgroup"

const LABEL: Record<CreateKind, string> = {
  campaign: "chiến dịch",
  adgroup: "nhóm quảng cáo",
}

export function createVerifyHint(kind: CreateKind, name: string): string {
  return `Có thể ${LABEL[kind]} "${name.slice(0, 80)}" đã được tạo (đang TẮT) - kiểm tra trong TikTok Ads Manager (hoặc ads_list_objects) trước khi thử lại để tránh tạo trùng.`
}

/**
 * The request may have reached TikTok and been executed. A TikTok envelope (HTTP 200) with a BUSINESS error code is a
 * definite rejection (nothing was created) - only server codes (5xxxx / 60001) and 40050 (duplicate request_id) stay
 * uncertain, like timeouts, network errors and HTTP 5xx.
 */
export function isUncertainCreateError(e: unknown): boolean {
  if (!isProviderError(e)) return true // network/abort error
  const code = e.upstream?.code
  if (code === 40050) return true // duplicate request_id: TikTok already processed an earlier attempt
  if (typeof code === "number" && (e.upstream?.httpStatus ?? 200) < 500) return isServerCode(code)
  return (
    e.code === "timeout" || e.code === "upstream_error" || e.code === "unknown"
  )
}

/** Re-throw an uncertain create failure as non-retryable with a verify-before-retry hint. */
export function uncertainCreateError(
  e: unknown,
  kind: CreateKind,
  name: string,
  detail: string
): ProviderError {
  const pe = isProviderError(e) ? e : null
  return new ProviderError({
    platform: "tiktok",
    code: pe?.code ?? "upstream_error",
    message: `TikTok ${kind} create outcome unknown: ${pe?.message ?? String(e)}`,
    userMessageVi: `TikTok không phản hồi rõ khi tạo ${LABEL[kind]} (${pe?.userMessageVi ?? "lỗi mạng"}). ${detail}`,
    retryable: false,
    hint: createVerifyHint(kind, name),
    upstream: pe?.upstream,
    cause: e,
  })
}

export interface CreateSpec {
  kind: CreateKind
  /** "campaign/create" | "adgroup/create" */
  path: string
  body: Raw
  /** campaign_name / adgroup_name sent in the body (lookup key) */
  name: string
  /** ad group creates: parent campaign (lookup scope) */
  campaignId?: string
}

/**
 * POST a create with the create retry policy. Returns the new id from the response (null when TikTok answered OK
 * without an id). After an uncertain failure the object is looked up by name; found → its id + a warning; not found
 * (or the lookup failed) → non-retryable ProviderError with a "check before retrying" hint.
 */
export async function createChecked(
  tt: TT,
  spec: CreateSpec,
  warnings: string[],
  now: () => number = Date.now
): Promise<string | null> {
  const started = now()
  const idKey = spec.kind === "campaign" ? "campaign_id" : "adgroup_id"
  try {
    const res = await ttPost<Raw>(tt, spec.path, spec.body, { create: true })
    return str(res.data[idKey])
  } catch (e) {
    if (!isUncertainCreateError(e)) throw e
    let found: string[]
    try {
      found = await findCreated(tt, spec, started - LOOKUP_SKEW_MS)
    } catch {
      throw uncertainCreateError(
        e,
        spec.kind,
        spec.name,
        `Không kiểm tra lại được danh sách ${LABEL[spec.kind]}.`
      )
    }
    if (found.length === 0) {
      throw uncertainCreateError(
        e,
        spec.kind,
        spec.name,
        `Chưa thấy ${LABEL[spec.kind]} mới cùng tên (TikTok có thể hiển thị trễ).`
      )
    }
    warnings.push(
      found.length === 1
        ? `TikTok phản hồi lỗi/timeout nhưng ${LABEL[spec.kind]} đã được tạo (id ${found[0]}) - dùng id tìm thấy, không tạo lại.`
        : `TikTok phản hồi lỗi/timeout; tìm thấy ${found.length} ${LABEL[spec.kind]} mới cùng tên "${spec.name.slice(0, 80)}" (id ${found.join(", ")}) - dùng id mới nhất ${found[0]}; kiểm tra và xoá bản thừa (đang TẮT) trong TikTok Ads Manager.`
    )
    return found[0]!
  }
}

/** Ids of objects named `spec.name` created at/after `sinceMs`, newest first. */
async function findCreated(
  tt: TT,
  spec: CreateSpec,
  sinceMs: number
): Promise<string[]> {
  const nameKey = spec.kind === "campaign" ? "campaign_name" : "adgroup_name"
  const idKey = spec.kind === "campaign" ? "campaign_id" : "adgroup_id"
  let list: Raw[]
  if (spec.kind === "campaign") {
    const base = {
      advertiser_id: tt.advertiserId,
      exclude_field_types_in_response: ["NULL_FIELD"],
    }
    try {
      // `campaign_name` filter of /campaign/get/: UNVERIFIED (providers/tiktok.md §4) - results are re-filtered below
      list = await ttGetAll<Raw>(
        tt,
        "campaign/get",
        {
          ...base,
          filtering: {
            campaign_name: spec.name,
            primary_status: "STATUS_NOT_DELETE",
          },
        },
        { max: 1000 }
      )
    } catch (e) {
      if (!isProviderError(e) || e.code !== "invalid_request") throw e
      list = await ttGetAll<Raw>(
        tt,
        "campaign/get",
        { ...base, filtering: { primary_status: "STATUS_NOT_DELETE" } },
        { max: 1000 }
      )
    }
  } else {
    list = await ttGetAll<Raw>(
      tt,
      "adgroup/get",
      {
        advertiser_id: tt.advertiserId,
        filtering: {
          campaign_ids: [spec.campaignId],
          primary_status: "STATUS_NOT_DELETE",
        },
        exclude_field_types_in_response: ["NULL_FIELD"],
      },
      { max: 1000 }
    )
  }
  return list
    .map((o) => ({
      id: str(o[idKey]),
      name: str(o[nameKey]),
      t: parseTikTokTime(o.create_time)?.getTime() ?? null,
    }))
    .filter(
      (o): o is { id: string; name: string | null; t: number } =>
        !!o.id && o.name === spec.name && o.t !== null && o.t >= sinceMs
    )
    .sort((a, b) => b.t - a.t)
    .map((o) => o.id)
}
