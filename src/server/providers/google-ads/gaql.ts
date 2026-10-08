// Safe GAQL building blocks. Never interpolate user-provided strings or ids into a query without
// going through these helpers.
// Grammar: https://developers.google.com/google-ads/api/docs/query/grammar
//   String literal escapes: \\ \' \" \n \r \t - and newlines are prohibited (PROHIBITED_NEWLINE_IN_STRING).
//   LIKE: to match a literal [ ] % _ surround the character in square brackets.
import { ProviderError } from "../errors"
import type { NormalizedStatus } from "../types"

const MAX_STRING = 1_000

function invalid(message: string, userMessageVi: string): ProviderError {
  return new ProviderError({ platform: "google_ads", code: "invalid_request", message, userMessageVi })
}

/** Quote a user string as a GAQL single-quoted literal. Rejects control characters. */
export function gaqlString(value: string): string {
  if (typeof value !== "string") throw invalid("GAQL string expected", "Giá trị lọc phải là chuỗi.")
  if (value.length > MAX_STRING) throw invalid("GAQL string too long", `Chuỗi lọc tối đa ${MAX_STRING} ký tự.`)
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid("Control characters are not allowed in GAQL strings", "Chuỗi lọc không được chứa ký tự xuống dòng/điều khiển.")
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"')}'`
}

/** Escape LIKE wildcards so the value is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[[\]%_]/g, (c) => `[${c}]`)
}

/** `field LIKE '%value%'` with every special character escaped. */
export function likeContains(field: string, value: string): string {
  assertFieldName(field)
  return `${field} LIKE ${gaqlString(`%${escapeLike(value)}%`)}`
}

const ID_RE = /^\d{1,19}$/

/** Validate a numeric Google Ads id (campaign, ad group, ad, criterion, geo target…). */
export function assertId(id: string, label = "id"): string {
  const s = String(id ?? "").trim()
  if (!ID_RE.test(s)) {
    throw invalid(`Invalid ${label}: must be digits`, `${label} không hợp lệ: chỉ gồm chữ số (nhận "${s.slice(0, 40)}").`)
  }
  return s
}

/** `(1, 2, 3)` for IN clauses; ids validated. */
export function idList(ids: string[], label = "id"): string {
  if (!ids.length) throw invalid("Empty id list", "Danh sách id rỗng.")
  return `(${[...new Set(ids.map((i) => assertId(i, label)))].join(", ")})`
}

const FIELD_RE = /^[a-z_]+(\.[a-z0-9_]+)*$/
function assertFieldName(field: string) {
  if (!FIELD_RE.test(field)) throw new Error(`Invalid GAQL field name: ${field}`)
}

/** Strip dashes/spaces from a customer id ("123-456-7890" → "1234567890") and validate 10 digits. */
export function normalizeCustomerId(raw: string): string {
  const s = String(raw ?? "").replace(/[\s-]/g, "")
  if (!/^\d{10}$/.test(s)) {
    throw invalid("Invalid customer id", `Customer ID Google Ads phải gồm 10 chữ số (nhận "${String(raw).slice(0, 20)}").`)
  }
  return s
}

/**
 * Composite ids: ad = "AG~AD", keyword = "AG~CRIT" (as in the resource names
 * customers/C/adGroupAds/AG~AD and customers/C/adGroupCriteria/AG~CRIT). A plain id is accepted too.
 */
export function parseCompositeId(id: string, label = "id"): { adGroupId: string | null; id: string } {
  const s = String(id ?? "").trim()
  const parts = s.split("~")
  if (parts.length === 2) return { adGroupId: assertId(parts[0]!, "ad_group_id"), id: assertId(parts[1]!, label) }
  if (parts.length === 1) return { adGroupId: null, id: assertId(s, label) }
  throw invalid(`Invalid composite id ${s}`, `${label} không hợp lệ (dạng AG~ID).`)
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

export function mapStatus(raw: string | null | undefined): NormalizedStatus {
  switch (raw) {
    case "ENABLED":
      return "active"
    case "PAUSED":
      return "paused"
    case "REMOVED":
      return "removed"
    default:
      return "unknown"
  }
}

/** Normalized status filter → Google enum values (unknown statuses are ignored). */
export function toGoogleStatuses(statuses: NormalizedStatus[]): string[] {
  const out = new Set<string>()
  for (const s of statuses) {
    if (s === "active") out.add("ENABLED")
    else if (s === "paused") out.add("PAUSED")
    else if (s === "removed" || s === "deleted" || s === "archived") out.add("REMOVED")
  }
  return [...out]
}

/** WHERE condition for a status field. Default excludes REMOVED. */
export function statusCondition(field: string, statuses: NormalizedStatus[] | undefined, includeRemoved = false): string | null {
  assertFieldName(field)
  if (statuses?.length) {
    const g = toGoogleStatuses(statuses)
    if (!g.length) return `${field} = 'UNKNOWN'`
    return `${field} IN (${g.map((s) => `'${s}'`).join(", ")})`
  }
  return includeRemoved ? null : `${field} != 'REMOVED'`
}

export function where(conds: (string | null | undefined | false)[]): string {
  const c = conds.filter(Boolean) as string[]
  return c.length ? ` WHERE ${c.join(" AND ")}` : ""
}
