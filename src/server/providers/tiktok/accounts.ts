// Credential validation + ad account listing.
// /user/info/ (token only) → /oauth2/advertiser/get/ (app_id + secret) → /advertiser/info/ (batches).
import { isProviderError, ProviderError } from "../errors"
import type { AccountStatus, AdAccountInfo, ConnectionContext, CredentialCheck } from "../types"
import { chunk, str, ttFromConnection, ttGet, type Raw } from "./api"
import { tiktokRequest } from "./client"
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
  // GMV Max (TikTok Shop) readiness - informational only, never blocks saving
  const gmv = await probeGmvMax(ctx, advertisers)
  warnings.push(...gmv.warnings)
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
      gmvMax: gmv.meta,
    },
  }
}

/** GMV Max probe: first N authorized advertisers, one /gmv_max/store/list/ call each (sequential). */
export const GMV_PROBE_MAX_ADVERTISERS = 10
const GMV_PROBE_TIMEOUT_MS = 8_000
/** Hard total deadline of the probe, in-flight calls included (AbortSignal): validation must stay quick. */
export const GMV_PROBE_BUDGET_MS = 20_000
/** A previous probe result (connections.meta.gmvMax) is reused for this long - the periodic token check runs often. */
export const GMV_PROBE_REUSE_MS = 24 * 60 * 60_000

/** Non-secret summary stored in connections.meta.gmvMax (no shop names). */
export interface GmvMaxProbe {
  checkedAt: string
  /** developer app the probe ran with (a different app → probe again) */
  appId?: string
  /** advertisers whose shop list was read: shops the ad account can access, and shops ready for GMV Max */
  advertisers: { advertiserId: string; shops: number; ready: number }[]
  /** authorized advertisers not probed (cap / time budget / probe stopped) */
  notChecked: number
  /** every probed advertiser was refused (40001/40125): the token most likely lacks the GMV Max scope */
  permissionDenied: boolean
  /** the probe stopped on another error (rate limit, network, deadline, endpoint unavailable…) */
  failed: boolean
}

/**
 * A previous probe (ctx.connectionMeta.gmvMax) that can be reused: < 24 h old, same developer app, complete (not
 * failed / refused) and covering every advertiser the probe would ask now. Otherwise null → probe again.
 */
export function reusableGmvMaxProbe(
  previous: unknown,
  appId: string,
  advertiserIds: string[],
  nowMs: number
): GmvMaxProbe | null {
  if (!previous || typeof previous !== "object") return null
  const p = previous as Partial<GmvMaxProbe>
  const at = typeof p.checkedAt === "string" ? Date.parse(p.checkedAt) : NaN
  if (!Number.isFinite(at) || nowMs - at < 0 || nowMs - at >= GMV_PROBE_REUSE_MS) return null
  if (typeof p.appId !== "string" || p.appId !== appId) return null
  if (p.failed !== false || p.permissionDenied !== false || !Array.isArray(p.advertisers)) return null
  const probed = new Set(p.advertisers.map((a) => String(a?.advertiserId ?? "")))
  if (!advertiserIds.slice(0, GMV_PROBE_MAX_ADVERTISERS).every((id) => probed.has(id))) return null
  return p as GmvMaxProbe
}

/** Warnings for explicit findings only: ready shops, or the GMV Max permission missing. */
function gmvMaxProbeWarnings(meta: GmvMaxProbe, names: Map<string, string>): string[] {
  const warnings: string[] = []
  const ready = meta.advertisers.filter((c) => c.ready > 0)
  const name = (id: string) => names.get(id) ?? id
  if (ready.length === 1) {
    const r = ready[0]!
    warnings.push(`GMV Max (TikTok Shop): tài khoản ${name(r.advertiserId)} đã sẵn sàng với ${r.ready} cửa hàng.`)
  } else if (ready.length > 1) {
    const shown = ready.slice(0, 3).map((r) => `${name(r.advertiserId)} (${r.ready} cửa hàng)`)
    const rest = ready.length - shown.length
    warnings.push(
      `GMV Max (TikTok Shop): ${ready.length} tài khoản đã sẵn sàng - ${shown.join(", ")}${rest > 0 ? ` và ${rest} tài khoản khác` : ""}.`
    )
  }
  if (meta.permissionDenied) {
    warnings.push(
      "Token chưa có quyền GMV Max (Store Management / GMV MAX Report) - xem hướng dẫn GMV Max nếu bạn dùng TikTok Shop."
    )
  }
  return warnings
}

/**
 * D6 - non-fatal GMV Max readiness probe: GET /gmv_max/store/list/ for the first ≤10 authorized advertisers.
 * A shop is ready when `is_gmv_max_available` is true AND its exclusive GMV Max advertiser is this advertiser.
 * Also runs in the periodic token-health job: a recent complete result in connectionMeta.gmvMax (< 24 h, same app,
 * same advertisers) is reused without any call. Hard total deadline 20 s (AbortSignal, in-flight calls included).
 * Never throws. Warnings only for explicit findings: ready shops, or the GMV Max permission missing; a token
 * without any GMV Max shop gets no line (most TikTok users do not run TikTok Shop).
 */
export async function probeGmvMax(
  ctx: ConnectionContext<TikTokCredentials>,
  advertisers: Raw[],
  now: () => number = Date.now
): Promise<{ meta: GmvMaxProbe; warnings: string[] }> {
  const started = now()
  const ids = advertisers
    .map((a) => ({ id: String(a.advertiser_id ?? ""), name: str(a.advertiser_name) }))
    .filter((a) => /^\d+$/.test(a.id))
  const names = new Map(ids.map((a) => [a.id, a.name ?? a.id]))
  const appId = String(ctx.credentials.appId ?? "")
  const previous = reusableGmvMaxProbe(
    ctx.connectionMeta?.gmvMax,
    appId,
    ids.map((a) => a.id),
    started
  )
  if (previous) return { meta: previous, warnings: gmvMaxProbeWarnings(previous, names) }

  const deadline = AbortSignal.timeout(GMV_PROBE_BUDGET_MS)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline
  const checked: GmvMaxProbe["advertisers"] = []
  let denied = 0
  let failed = false
  for (const a of ids.slice(0, GMV_PROBE_MAX_ADVERTISERS)) {
    if (signal.aborted || now() - started > GMV_PROBE_BUDGET_MS) {
      if (deadline.aborted || now() - started > GMV_PROBE_BUDGET_MS) failed = true
      break
    }
    try {
      const res = await tiktokRequest<{ store_list?: unknown }>({
        method: "GET",
        path: "gmv_max/store/list",
        query: { advertiser_id: a.id },
        auth: ctx.credentials.accessToken,
        appId: ctx.credentials.appId,
        retries: 0,
        timeoutMs: GMV_PROBE_TIMEOUT_MS,
        signal,
        onUpstream: ctx.onUpstream,
      })
      const rows = (Array.isArray(res.data?.store_list) ? (res.data.store_list as unknown[]) : []).filter(
        (s): s is Raw => !!s && typeof s === "object"
      )
      // one store may be listed once per Business Center with access (owner + partner BCs): count store ids
      const shops = new Set(rows.map((s) => String(s.store_id ?? "")))
      const ready = new Set(
        rows
          .filter((shop) => {
            const exclusive = shop.exclusive_authorized_advertiser_info as Raw | null | undefined
            return shop.is_gmv_max_available === true && String(exclusive?.advertiser_id ?? "") === a.id
          })
          .map((s) => String(s.store_id ?? ""))
      )
      checked.push({ advertiserId: a.id, shops: shops.size, ready: ready.size })
    } catch (e) {
      if (!signal.aborted && isProviderError(e) && e.code === "permission_denied") {
        denied++
        // a missing scope is token-wide: two refusals before any success → stop asking
        if (checked.length === 0 && denied >= 2) break
        continue
      }
      // rate limit / network / deadline / endpoint unavailable: stop, keep the validation quick
      failed = true
      break
    }
  }
  const meta: GmvMaxProbe = {
    checkedAt: new Date(now()).toISOString(),
    appId,
    advertisers: checked,
    notChecked: ids.length - checked.length - denied,
    permissionDenied: denied > 0 && checked.length === 0,
    failed,
  }
  return { meta, warnings: gmvMaxProbeWarnings(meta, names) }
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
