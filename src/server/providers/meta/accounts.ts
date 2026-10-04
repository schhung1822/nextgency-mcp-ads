import { isProviderError, ProviderError } from "../errors"
import { httpJson } from "../http"
import { fromMetaMinor } from "../money"
import type { AdAccountInfo, ConnectionContext, CredentialCheck } from "../types"
import { graph, graphAll, mapGraphError, META_GRAPH_HOST, metaApiVersion, type MetaCredentials } from "./client"
import { META_RECOMMENDED_SCOPES } from "./credentials"
import { connCallCtx, mapAccountStatus } from "./shared"

const DAY_MS = 86_400_000
const EXPIRY_WARN_MS = 7 * DAY_MS

interface DebugTokenData {
  app_id?: string
  type?: string
  application?: string
  is_valid?: boolean
  expires_at?: number
  data_access_expires_at?: number
  scopes?: string[]
  user_id?: string
  error?: { code?: number; message?: string; subcode?: number }
}

function tsToDate(sec: number | undefined): Date | null {
  if (!sec || sec <= 0) return null
  return new Date(sec * 1000)
}

function scopeWarnings(scopes: string[] | null): string[] {
  if (!scopes) return []
  const w: string[] = []
  if (!scopes.includes("ads_management")) {
    w.push("Token thiếu quyền ads_management - sẽ không bật/tắt, sửa hay tạo quảng cáo được.")
  }
  if (!scopes.includes("ads_management") && !scopes.includes("ads_read")) {
    w.push("Token thiếu quyền ads_read - không đọc được chỉ số quảng cáo.")
  }
  if (!scopes.includes("business_management")) {
    w.push("Token thiếu quyền business_management - vẫn kết nối được các tài khoản được gán trực tiếp, nhưng có thể không thấy tài khoản thuộc Business (khi điền Business ID).")
  }
  const missingPages = META_RECOMMENDED_SCOPES.filter((s) => !scopes.includes(s))
  if (missingPages.length) {
    w.push(`Token thiếu quyền ${missingPages.join(", ")} - không tra cứu/chọn được Trang khi tạo quảng cáo.`)
  }
  return w
}

function expiryWarnings(expiresAt: Date | null, dataAccessExpiresAt: Date | null, now = Date.now()): string[] {
  const w: string[] = []
  if (expiresAt) {
    const left = expiresAt.getTime() - now
    if (left <= 0) w.push("Token đã hết hạn.")
    else if (left < EXPIRY_WARN_MS) {
      w.push(`Token sẽ hết hạn sau ${Math.max(1, Math.ceil(left / DAY_MS))} ngày - hãy tạo token mới (nên dùng System User token hạn “Never”).`)
    }
  }
  if (dataAccessExpiresAt) {
    const left = dataAccessExpiresAt.getTime() - now
    if (left > 0 && left < EXPIRY_WARN_MS) {
      w.push(`Quyền truy cập dữ liệu của token sẽ hết sau ${Math.max(1, Math.ceil(left / DAY_MS))} ngày.`)
    }
  }
  return w
}

async function debugToken(
  ctx: ConnectionContext<MetaCredentials>,
  inspectorToken: string
): Promise<DebugTokenData | null> {
  const res = await graph<{ data?: DebugTokenData }>(connCallCtx(ctx), {
    method: "GET",
    path: "debug_token",
    params: { input_token: ctx.credentials.accessToken },
    accessTokenOverride: inspectorToken,
    idempotent: true,
  })
  return res.data ?? null
}

export async function validateMetaCredentials(ctx: ConnectionContext<MetaCredentials>): Promise<CredentialCheck> {
  const c = ctx.credentials
  const call = connCallCtx(ctx)
  const warnings: string[] = []
  const meta: Record<string, unknown> = {}

  // 1) debug_token: with app token when app id+secret are known, else with the token itself ([M]).
  let dbg: DebugTokenData | null = null
  if (c.appId && c.appSecret) {
    dbg = await debugToken(ctx, `${c.appId}|${c.appSecret}`)
  } else {
    try {
      dbg = await debugToken(ctx, c.accessToken)
    } catch (e) {
      if (isProviderError(e) && e.code === "auth_invalid") throw e
      dbg = null // fall back to /me + /me/permissions
    }
  }

  if (dbg) {
    meta.appId = dbg.app_id ?? null
    meta.application = dbg.application ?? null
    meta.tokenType = dbg.type ?? null
    meta.userId = dbg.user_id ?? null
    if (dbg.is_valid === false) {
      return {
        valid: false,
        tokenExpiresAt: tsToDate(dbg.expires_at),
        scopes: dbg.scopes ?? null,
        warnings: [`Token không hợp lệ${dbg.error?.message ? `: ${dbg.error.message}` : ""}.`],
        meta,
      }
    }
    if (c.appId && dbg.app_id && dbg.app_id !== c.appId) {
      warnings.push("Token không thuộc App ID đã nhập - appsecret_proof sẽ sai. Kiểm tra lại App ID/App Secret.")
    }
  }

  // 2) /me - confirms the token works with the app secret proof (if any).
  let me: { id?: string; name?: string }
  try {
    me = await graph<{ id?: string; name?: string }>(call, { method: "GET", path: "me", params: { fields: "id,name" }, idempotent: true })
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") {
      return { valid: false, tokenExpiresAt: null, scopes: null, warnings: [e.userMessageVi], meta }
    }
    throw e
  }
  meta.userId ??= me.id ?? null
  meta.name = me.name ?? null

  let scopes: string[] | null = dbg?.scopes ?? null
  if (!scopes) {
    const perms = await graph<{ data?: { permission: string; status: string }[] }>(call, {
      method: "GET",
      path: "me/permissions",
      idempotent: true,
    })
    scopes = (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission)
  }

  const expiresAt = tsToDate(dbg?.expires_at)
  const dataAccessExpiresAt = tsToDate(dbg?.data_access_expires_at)
  warnings.push(...expiryWarnings(expiresAt, dataAccessExpiresAt))
  warnings.push(...scopeWarnings(scopes))
  if (!dbg) warnings.push("Không đọc được hạn token (nhập App ID + App Secret để kiểm tra).")
  if (dbg?.type === "USER" && expiresAt) {
    warnings.push(
      c.appId && c.appSecret
        ? "User token (token cá nhân của via) có hạn khoảng 60 ngày - hệ thống sẽ cảnh báo trước 7 ngày; khi đó tạo token mới trong Graph API Explorer và bấm “Thay token”."
        : "User token có hạn. Nhập thêm App ID + App Secret để hệ thống tự đổi sang token dài hạn (60 ngày) và theo dõi hạn token."
    )
  }
  meta.dataAccessExpiresAt = dataAccessExpiresAt?.toISOString() ?? null
  meta.hasAppSecretProof = !!c.appSecret
  if (c.businessId) meta.businessId = c.businessId

  return { valid: true, tokenExpiresAt: expiresAt, scopes, warnings, meta }
}

/** Always-safe fields (ads_read). */
const ACCOUNT_FIELDS_CORE = ["id", "account_id", "name", "account_status", "currency", "timezone_name"]
const ACCOUNT_FIELDS_MINIMAL = [
  ...ACCOUNT_FIELDS_CORE,
  "disable_reason",
  "timezone_offset_hours_utc",
  "amount_spent",
  "spend_cap",
  "balance",
  "min_daily_budget",
]
/**
 * Preferred set. `business{id,name}` and `user_tasks` can require business_management on personal
 * (via) user tokens - on a permission error we fall back to MINIMAL, then CORE.
 */
const ACCOUNT_FIELD_SETS = [
  [...ACCOUNT_FIELDS_MINIMAL, "user_tasks", "business{id,name}"].join(","),
  ACCOUNT_FIELDS_MINIMAL.join(","),
  ACCOUNT_FIELDS_CORE.join(","),
]

/** Meta #100 "Requires business_management permission to access the field" (or similar permission errors on a field). */
export function isBusinessFieldPermissionError(e: unknown): boolean {
  if (!isProviderError(e)) return false
  const msg = `${e.upstream?.message ?? ""} ${e.message}`.toLowerCase()
  return (
    msg.includes("business_management") ||
    (e.upstream?.code === 100 && (msg.includes("business") || msg.includes("permission"))) ||
    e.code === "permission_denied"
  )
}

interface RawAdAccount {
  id: string
  account_id?: string
  name?: string
  account_status?: number
  disable_reason?: number
  currency?: string
  timezone_name?: string
  timezone_offset_hours_utc?: number
  amount_spent?: string
  spend_cap?: string
  balance?: string
  min_daily_budget?: number | string
  business?: { id: string; name: string }
  user_tasks?: string[]
}

/** null when Meta did not return a usable ISO-4217 currency: never guess (money conversion depends on it). */
export function mapAdAccount(a: RawAdAccount, source: string): AdAccountInfo | null {
  const currency = typeof a.currency === "string" ? a.currency.trim().toUpperCase() : ""
  if (!/^[A-Z]{3}$/.test(currency)) return null
  const st = mapAccountStatus(a.account_status)
  return {
    externalId: a.id.startsWith("act_") ? a.id : `act_${a.id}`,
    name: a.name ?? a.id,
    currency,
    timezone: a.timezone_name ?? "UTC",
    status: st.status,
    statusRaw: st.raw,
    extra: {
      accountId: a.account_id ?? a.id.replace(/^act_/, ""),
      disableReason: a.disable_reason ?? null,
      timezoneOffsetHoursUtc: a.timezone_offset_hours_utc ?? null,
      amountSpent: fromMetaMinor(a.amount_spent, currency),
      spendCap: fromMetaMinor(a.spend_cap, currency),
      balance: fromMetaMinor(a.balance, currency),
      minDailyBudget: fromMetaMinor(a.min_daily_budget, currency),
      business: a.business ?? null,
      userTasks: a.user_tasks ?? [],
      source,
    },
  }
}

export async function listMetaAccounts(ctx: ConnectionContext<MetaCredentials>): Promise<AdAccountInfo[]> {
  const call = connCallCtx(ctx)
  let level = 0
  /** list an edge; on a field-permission error (e.g. business_management) retry with a smaller field set */
  const list = async (edge: string): Promise<RawAdAccount[]> => {
    for (;;) {
      try {
        return (await graphAll<RawAdAccount>(call, edge, { fields: ACCOUNT_FIELD_SETS[level]!, limit: 200 })).data
      } catch (e) {
        if (level >= ACCOUNT_FIELD_SETS.length - 1 || !isBusinessFieldPermissionError(e)) throw e
        level++
      }
    }
  }
  const byId = new Map<string, AdAccountInfo>()
  const skipped = new Set<string>()
  const add = (rows: RawAdAccount[], source: string) => {
    for (const r of rows) {
      const info = mapAdAccount(r, source)
      if (!info) {
        // Accounts without a currency are skipped: a guessed currency would mis-scale every budget (VND vs USD offset).
        skipped.add(r.id)
        continue
      }
      if (!byId.has(info.externalId)) byId.set(info.externalId, info)
    }
  }
  add(await list("me/adaccounts"), "me")
  const bid = ctx.credentials.businessId
  if (bid) {
    add(await list(`${bid}/owned_ad_accounts`), "business_owned")
    try {
      add(await list(`${bid}/client_ad_accounts`), "business_client")
    } catch (e) {
      // client accounts need extra business permissions; owned + assigned accounts are enough
      if (!isProviderError(e) || e.code !== "permission_denied") throw e
    }
  }
  if (byId.size === 0 && skipped.size > 0) {
    throw new ProviderError({
      platform: "meta",
      code: "upstream_error",
      message: `meta: ${skipped.size} ad account(s) returned without currency`,
      userMessageVi: `Meta không trả tiền tệ của ${skipped.size} tài khoản quảng cáo - không thể kết nối an toàn (tiền sẽ bị quy đổi sai).`,
      hint: "Kiểm tra token có quyền ads_read/ads_management trên tài khoản rồi thử lại.",
    })
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** User tokens expiring within this window are exchanged for a long-lived (~60 day) token. */
const EXCHANGE_IF_EXPIRES_WITHIN_MS = 3 * DAY_MS

/**
 * Personal (via) user tokens from Graph API Explorer live 1–2 hours. With App ID + App Secret we exchange
 * them for a long-lived token (~60 days) before validating/saving:
 * GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token
 * System User / already long-lived tokens are returned unchanged. Never logs the tokens (URL redacted).
 */
export async function prepareMetaCredentials(
  ctx: ConnectionContext<MetaCredentials>
): Promise<{ credentials: MetaCredentials; notes: string[] }> {
  const c = ctx.credentials
  if (!c.appId || !c.appSecret) return { credentials: c, notes: [] }
  let dbg: DebugTokenData | null
  try {
    dbg = await debugToken(ctx, `${c.appId}|${c.appSecret}`)
  } catch {
    return { credentials: c, notes: [] } // validation will report the real problem
  }
  if (!dbg || dbg.is_valid === false || dbg.type !== "USER") return { credentials: c, notes: [] }
  const exp = tsToDate(dbg.expires_at)
  if (!exp || exp.getTime() - Date.now() > EXCHANGE_IF_EXPIRES_WITHIN_MS) return { credentials: c, notes: [] }

  const res = await httpJson<{ access_token?: string; expires_in?: number; error?: Parameters<typeof mapGraphError>[0] }>({
    platform: "meta",
    method: "GET",
    url: `${META_GRAPH_HOST}/${metaApiVersion()}/oauth/access_token`,
    query: { grant_type: "fb_exchange_token", client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: c.accessToken },
    redactQueryKeys: ["client_secret", "fb_exchange_token"],
    signal: ctx.signal,
    onUpstream: ctx.onUpstream,
    retries: 1,
  })
  const token = res.body?.access_token
  if (res.status !== 200 || !token) {
    const err = mapGraphError(res.body?.error ?? null, res.status, res.requestId)
    throw new ProviderError({
      platform: "meta",
      code: err.code,
      message: `meta: long-lived token exchange failed: ${err.message}`,
      userMessageVi: `Không đổi được sang token dài hạn: ${err.userMessageVi}`,
      hint: "Kiểm tra App ID/App Secret đúng của app đã dùng để tạo token trong Graph API Explorer.",
      upstream: err.upstream,
    })
  }
  const days = res.body?.expires_in ? Math.round(res.body.expires_in / 86_400) : 60
  return {
    credentials: { ...c, accessToken: token },
    notes: [`Đã tự đổi token ngắn hạn sang token dài hạn (khoảng ${days} ngày).`],
  }
}
