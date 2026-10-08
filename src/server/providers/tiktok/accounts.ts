// Credential validation + ad account listing.
// /user/info/ (token only) → /oauth2/advertiser/get/ (app_id + secret) → /advertiser/info/ (batches).
import { isProviderError, ProviderError } from "../errors"
import type { AccountStatus, AdAccountInfo, ConnectionContext, CredentialCheck } from "../types"
import { chunk, str, ttFromConnection, ttGet, type Raw } from "./api"
import type { TikTokCredentials } from "./credentials"

/** /advertiser/info/ batch size. TikTok documents no explicit maximum - 100 is conservative [L]. */
const ADVERTISER_INFO_BATCH = 100

const ADVERTISER_FIELDS = [
  "advertiser_id",
  "name",
  "currency",
  "timezone",
  "display_timezone",
  "status",
  "role",
  "balance",
  "owner_bc_id",
  "country",
  "company",
  "create_time",
  "rejection_reason",
]

const SCOPE_NAMES: Record<number, string> = {
  1: "Ad Account Management",
  2: "Ads Management",
  3: "Audience Management",
  4: "Reporting",
  6: "Creative Management",
  8: "Pixel Management",
}
const REQUIRED_SCOPES = [1, 2, 4, 6, 8]

/**
 * Permission area (first-level scope id) of a granted scope id. TikTok returns first-level ids (1, 2, 4…) or only
 * the child permissions of an area (e.g. 10/100/15x under Ad Account Management) - an area counts as granted
 * when its first-level id OR any of its child ids is present (providers/tiktok.md §2, checked 2026-10-08).
 * Ids stay strings: some scope ids are 19-digit and exceed Number.MAX_SAFE_INTEGER.
 */
export function scopeArea(id: string): number | null {
  if (!/^\d+$/.test(id)) return null
  if (id === "1" || id === "10" || id === "100" || /^15\d$/.test(id)) return 1
  if (id === "2" || id === "20" || id === "21" || id === "22" || /^2\d\d$/.test(id)) return 2
  if (id === "3") return 3
  if (id === "4" || /^4[0-4]$/.test(id)) return 4
  if (["6", "60", "61", "69", "601", "610", "611", "693"].includes(id)) return 6
  if (id === "8" || id === "80" || id === "800") return 8
  return null
}

/** Normalise stored/returned scope ids (numbers from older connections, strings now) to digit strings. */
export function normalizeScopeIds(raw: unknown[]): string[] {
  return raw
    .map((v) => (typeof v === "number" || typeof v === "bigint" ? String(v) : typeof v === "string" ? v.trim() : ""))
    .filter((v) => /^\d+$/.test(v))
}

export async function validateTikTokCredentials(ctx: ConnectionContext<TikTokCredentials>): Promise<CredentialCheck> {
  const tt = ttFromConnection(ctx)
  const warnings: string[] = []
  let user: Raw
  try {
    user = (await ttGet<Raw>(tt, "user/info", {})).data
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") {
      return { valid: false, tokenExpiresAt: null, scopes: null, warnings: [e.userMessageVi], meta: {} }
    }
    throw e
  }
  let advertisers: Raw[] = []
  try {
    advertisers = await listAuthorizedAdvertisers(ctx)
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") {
      return {
        valid: false,
        tokenExpiresAt: null,
        scopes: null,
        warnings: [e.userMessageVi],
        meta: { appId: ctx.credentials.appId },
      }
    }
    throw e
  }
  if (advertisers.length === 0) {
    warnings.push(
      "Token hợp lệ nhưng chưa có tài khoản quảng cáo nào cấp quyền cho app này. Hãy mở Advertiser authorization URL và chọn tài khoản."
    )
  }
  // Scopes are only returned by /oauth2/access_token/ - reuse what the auth_code helper stored, if any.
  const storedScope = ctx.connectionMeta?.scope
  let scopes: string[] | null = null
  if (Array.isArray(storedScope)) {
    const ids = normalizeScopeIds(storedScope)
    const areas = new Set(ids.map(scopeArea).filter((a): a is number => a !== null))
    scopes = [
      ...[...areas].sort((a, b) => a - b).map((a) => SCOPE_NAMES[a] ?? `scope_${a}`),
      ...ids.filter((id) => scopeArea(id) === null).map((id) => `scope_${id}`),
    ]
    const missing = REQUIRED_SCOPES.filter((id) => !areas.has(id))
    if (missing.length) {
      warnings.push(`Token thiếu quyền: ${missing.map((id) => SCOPE_NAMES[id]).join(", ")}. Một số thao tác sẽ lỗi 40001.`)
    }
  } else {
    warnings.push(
      "TikTok không cho kiểm tra scope của token có sẵn - nếu thiếu quyền, lỗi 40001 sẽ xuất hiện khi thao tác. Dùng \"Đổi auth_code\" để app ghi nhận scope."
    )
  }
  return {
    valid: true,
    tokenExpiresAt: null,
    scopes,
    warnings,
    meta: {
      appId: ctx.credentials.appId,
      coreUserId: str(user.core_user_id),
      displayName: str(user.display_name),
      advertiserCount: advertisers.length,
      ...(Array.isArray(storedScope) ? { scope: storedScope } : {}),
    },
  }
}

async function listAuthorizedAdvertisers(ctx: ConnectionContext<TikTokCredentials>): Promise<Raw[]> {
  const res = await ttGet<{ list?: Raw[] }>(ttFromConnection(ctx), "oauth2/advertiser/get", {
    app_id: ctx.credentials.appId,
    secret: ctx.credentials.secret,
  })
  return res.data.list ?? []
}

export async function listTikTokAccounts(ctx: ConnectionContext<TikTokCredentials>): Promise<AdAccountInfo[]> {
  const authorized = await listAuthorizedAdvertisers(ctx)
  const names = new Map(authorized.map((a) => [String(a.advertiser_id), str(a.advertiser_name) ?? ""]))
  const ids = [...names.keys()]
  const out: AdAccountInfo[] = []
  let skipped = 0
  for (const batch of chunk(ids, ADVERTISER_INFO_BATCH)) {
    const res = await ttGet<{ list?: Raw[] }>(ttFromConnection(ctx), "advertiser/info", {
      advertiser_ids: batch,
      fields: ADVERTISER_FIELDS,
    })
    // Accounts the token lists but /advertiser/info/ does not return are skipped: never fabricate a currency.
    for (const a of res.data.list ?? []) {
      const info = toAccountInfo(a, names.get(String(a.advertiser_id)) ?? "")
      if (info) out.push(info)
      else skipped++
    }
  }
  if (!out.length && skipped) {
    throw new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: `TikTok returned ${skipped} advertiser(s) without currency`,
      userMessageVi: `TikTok không trả tiền tệ của ${skipped} tài khoản quảng cáo - không thể kết nối an toàn (tiền sẽ bị quy đổi sai).`,
      hint: "Kiểm tra quyền Ad Account Management của token rồi thử lại.",
    })
  }
  return out
}

export function isIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string") return false
  if (!tz.includes("/") && tz !== "UTC") return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function mapAccountStatus(status: unknown): AccountStatus {
  switch (status) {
    case "STATUS_ENABLE":
      return "active"
    case "STATUS_DISABLE":
      return "closed"
    case "STATUS_PENDING_CONFIRM":
    case "STATUS_PENDING_VERIFIED":
    case "STATUS_PENDING_CONFIRM_MODIFY":
    case "STATUS_WAIT_FOR_BPM_AUDIT":
    case "STATUS_WAIT_FOR_PUBLIC_AUTH":
    case "STATUS_CONTRACT_PENDING":
      return "pending"
    case "STATUS_CONFIRM_FAIL":
    case "STATUS_CONFIRM_FAIL_END":
    case "STATUS_CONFIRM_MODIFY_FAIL":
    case "STATUS_LIMIT":
    case "STATUS_SELF_SERVICE_UNAUDITED":
      return "disabled"
    default:
      return typeof status === "string" && status.startsWith("STATUS_PENDING") ? "pending" : "unknown"
  }
}

/** null when TikTok returned no usable ISO-4217 currency: never guess one (budgets would be mis-scaled). */
export function toAccountInfo(a: Raw, fallbackName = ""): AdAccountInfo | null {
  const currency = (str(a.currency) ?? "").trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return null
  const display = a.display_timezone
  const tzRaw = a.timezone
  // `timezone` is the ad account time zone (may be a GMT offset like "Etc/GMT-7", which Intl supports);
  // `display_timezone` is only a display name (doc 1739593083610113) → fallback
  const timezone = isIanaTimeZone(tzRaw) ? tzRaw : isIanaTimeZone(display) ? display : "UTC"
  const balance = Number(a.balance)
  return {
    externalId: String(a.advertiser_id),
    name: str(a.name) ?? (fallbackName || String(a.advertiser_id)),
    currency,
    timezone,
    status: mapAccountStatus(a.status),
    statusRaw: str(a.status) ?? "",
    parentExternalId: str(a.owner_bc_id),
    extra: {
      timezoneRaw: str(tzRaw),
      displayTimezone: str(display),
      ...(timezone === "UTC" && !isIanaTimeZone(display) && !isIanaTimeZone(tzRaw)
        ? { timezoneWarning: "Không xác định được múi giờ IANA - tạm dùng UTC." }
        : {}),
      balance: Number.isFinite(balance) ? balance : null,
      role: str(a.role),
      ownerBcId: str(a.owner_bc_id),
      country: str(a.country),
      company: str(a.company),
      rejectionReason: str(a.rejection_reason),
    },
  }
}
