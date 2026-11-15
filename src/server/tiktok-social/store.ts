// TikTok Social accounts - DB helpers (17-tiktok-social.md §3-§4). No imports from "next/*" or "server-only" (used by
// the worker job and src/server/mcp/grant.ts). This is the ONLY module that encrypts / decrypts TikTok Social tokens
// (AES-256-GCM, AAD tiktok_social_account:<id>:credentials). Nothing here logs. Automatic status changes (refresh,
// health) never bump updated_at.
import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db, type Tx } from "@/server/db/client"
import { tiktokSocialAccounts, tiktokSocialClients } from "@/server/db/schema"

import { isTiktokSocialError, refreshTokens, registerClient, TiktokSocialError, type TiktokSocialTokens } from "./api"

export type TiktokSocialAccountRow = typeof tiktokSocialAccounts.$inferSelect
type DbLike = Tx | typeof db

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

/** refresh the access token when it expires within this window */
export const ACCESS_REFRESH_MARGIN_MS = 10 * 60_000
/** status "expiring" (sign in again soon) when the 1-year authorization ends within this window */
export const EXPIRING_WINDOW_MS = 14 * 86_400_000

export const TTS_STATUS_VI = {
  invalid: "TikTok không còn chấp nhận đăng nhập này (đã thu hồi quyền hoặc hết hạn 1 năm). Hãy bấm Kết nối lại.",
  expired: "Quyền đăng nhập TikTok đã hết hạn 1 năm. Hãy bấm Kết nối lại.",
  unreadable: "Không giải mã được token đã lưu (khoá mã hoá đã đổi?). Hãy bấm Kết nối lại.",
} as const

// ---- encryption ----------------------------------------------------------------------------------------------

interface StoredSecret {
  accessToken: string
  refreshToken: string
}

export function encryptTiktokSocialTokens(accountId: string, t: StoredSecret): string {
  return encryptSecret(JSON.stringify({ accessToken: t.accessToken, refreshToken: t.refreshToken }), aad.tiktokSocialAccountCredentials(accountId))
}

/** Erased secret of a deleted row */
export function erasedTiktokSocialSecret(accountId: string): string {
  return encryptSecret("", aad.tiktokSocialAccountCredentials(accountId))
}

export class TiktokSocialTokenUnreadableError extends Error {
  constructor() {
    super("tiktok social token cannot be decrypted")
    this.name = "TiktokSocialTokenUnreadableError"
  }
}

export function decryptTiktokSocialTokens(row: Pick<TiktokSocialAccountRow, "id" | "credentialsEncrypted">): StoredSecret {
  let v: unknown
  try {
    v = JSON.parse(decryptSecret(row.credentialsEncrypted, aad.tiktokSocialAccountCredentials(row.id)))
  } catch {
    // never chain the cause
    throw new TiktokSocialTokenUnreadableError()
  }
  const o = v as Partial<StoredSecret> | null
  if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || !o.accessToken || !o.refreshToken) {
    throw new TiktokSocialTokenUnreadableError()
  }
  return { accessToken: o.accessToken, refreshToken: o.refreshToken }
}

// ---- OAuth client (Dynamic Client Registration) --------------------------------------------------------------

/** client_id registered for this redirect URI (registers on first use; concurrent first uses converge on one row). */
export async function clientIdForRedirect(redirectUri: string, signal?: AbortSignal): Promise<string> {
  const [hit] = await db.select().from(tiktokSocialClients).where(eq(tiktokSocialClients.redirectUri, redirectUri)).limit(1)
  if (hit) return hit.clientId
  const clientId = await registerClient(redirectUri, signal)
  await db.insert(tiktokSocialClients).values({ redirectUri, clientId }).onConflictDoNothing({ target: tiktokSocialClients.redirectUri })
  const [row] = await db.select().from(tiktokSocialClients).where(eq(tiktokSocialClients.redirectUri, redirectUri)).limit(1)
  return row?.clientId ?? clientId
}

// ---- loaders -------------------------------------------------------------------------------------------------

export async function loadTiktokSocialAccountRow(id: string, tx: DbLike = db): Promise<TiktokSocialAccountRow | null> {
  if (!isUuid(id)) return null
  const [row] = await tx
    .select()
    .from(tiktokSocialAccounts)
    .where(and(eq(tiktokSocialAccounts.id, id), isNull(tiktokSocialAccounts.deletedAt)))
    .limit(1)
  return row ?? null
}

/** status after a successful refresh / check */
export function liveStatus(refreshExpiresAt: Date, now = new Date()): "active" | "expiring" {
  return refreshExpiresAt.getTime() - now.getTime() < EXPIRING_WINDOW_MS ? "expiring" : "active"
}

async function setStatus(id: string, status: "invalid" | "active" | "expiring", message: string | null): Promise<void> {
  await db
    .update(tiktokSocialAccounts)
    .set({ status, statusMessage: message, lastCheckedAt: new Date(), updatedAt: sql`${tiktokSocialAccounts.updatedAt}` })
    .where(and(eq(tiktokSocialAccounts.id, id), isNull(tiktokSocialAccounts.deletedAt)))
}

export async function markTiktokSocialInvalid(id: string, message: string = TTS_STATUS_VI.invalid): Promise<void> {
  await setStatus(id, "invalid", message)
}

/**
 * A usable access token of a live, enabled account. Refreshes it (under a per-account advisory lock, re-reading the
 * row inside the lock so concurrent callers refresh once) when it expires within ACCESS_REFRESH_MARGIN_MS or when
 * `force` (the previous token was rejected). A refused refresh marks the account invalid.
 */
export async function tiktokSocialAccessToken(id: string, opts: { force?: boolean; signal?: AbortSignal; now?: () => Date } = {}): Promise<string> {
  const now = opts.now ?? (() => new Date())
  const row = await loadTiktokSocialAccountRow(id)
  if (!row || row.status === "disabled" || row.status === "invalid") {
    throw new TiktokSocialError({ code: "auth", message: "TikTok account not usable" })
  }
  let secret: StoredSecret
  try {
    secret = decryptTiktokSocialTokens(row)
  } catch {
    await markTiktokSocialInvalid(id, TTS_STATUS_VI.unreadable)
    throw new TiktokSocialError({ code: "auth", message: "TikTok token unreadable" })
  }
  if (!opts.force && row.accessExpiresAt.getTime() - now().getTime() > ACCESS_REFRESH_MARGIN_MS) return secret.accessToken
  if (row.refreshExpiresAt.getTime() <= now().getTime()) {
    await markTiktokSocialInvalid(id, TTS_STATUS_VI.expired)
    throw new TiktokSocialError({ code: "auth", message: "TikTok authorization expired" })
  }
  const staleAccess = secret.accessToken
  let refused = false
  const token = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ttsocial:${id}`}))`)
    const cur = await loadTiktokSocialAccountRow(id, tx)
    if (!cur || cur.status === "disabled" || cur.status === "invalid") throw new TiktokSocialError({ code: "auth", message: "TikTok account not usable" })
    const s = decryptTiktokSocialTokens(cur)
    // another caller refreshed while we waited
    if (s.accessToken !== staleAccess && cur.accessExpiresAt.getTime() - now().getTime() > ACCESS_REFRESH_MARGIN_MS) return s.accessToken
    let t: TiktokSocialTokens
    try {
      t = await refreshTokens({ clientId: cur.clientId, refreshToken: s.refreshToken, refreshExpiresAt: cur.refreshExpiresAt, now: now(), signal: opts.signal })
    } catch (e) {
      if (isTiktokSocialError(e) && e.code === "auth") refused = true
      throw e
    }
    await tx
      .update(tiktokSocialAccounts)
      .set({
        credentialsEncrypted: encryptTiktokSocialTokens(id, t),
        accessExpiresAt: t.accessExpiresAt,
        refreshExpiresAt: t.refreshExpiresAt,
        ...(t.scopes.length ? { scopes: t.scopes } : {}),
        status: liveStatus(t.refreshExpiresAt, now()),
        statusMessage: null,
        lastCheckedAt: now(),
        updatedAt: sql`${tiktokSocialAccounts.updatedAt}`,
      })
      .where(eq(tiktokSocialAccounts.id, id))
    return t.accessToken
  }).catch(async (e: unknown) => {
    if (refused) await markTiktokSocialInvalid(id)
    throw e
  })
  return token
}

/**
 * Runs `fn` with an access token; a token rejected by TikTok ("auth") is refreshed once and `fn` retried; a second
 * rejection marks the account invalid. Records last_used_at on success.
 */
export async function withTiktokSocialToken<T>(id: string, fn: (accessToken: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let token = await tiktokSocialAccessToken(id, { signal })
  let out: T
  try {
    out = await fn(token)
  } catch (e) {
    if (!isTiktokSocialError(e) || e.code !== "auth") throw e
    token = await tiktokSocialAccessToken(id, { force: true, signal })
    try {
      out = await fn(token)
    } catch (e2) {
      if (isTiktokSocialError(e2) && e2.code === "auth") await markTiktokSocialInvalid(id)
      throw e2
    }
  }
  await db
    .update(tiktokSocialAccounts)
    .set({ lastUsedAt: new Date(), updatedAt: sql`${tiktokSocialAccounts.updatedAt}` })
    .where(eq(tiktokSocialAccounts.id, id))
  return out
}

// ---- grant ---------------------------------------------------------------------------------------------------

export interface GrantTiktokSocialAccount {
  id: string
  name: string
  username: string
  displayName: string | null
  isBusinessAccount: boolean | null
  status: string
}

/**
 * TikTok accounts an MCP may read: rows picked for the MCP (mcp_tiktok_social_scopes), live, not disabled, and - for a
 * staff-owned MCP - owned by the MCP owner (an admin-owned MCP may use any row). No secrets.
 */
export async function loadGrantTiktokSocialAccounts(
  accountIds: string[],
  mcpOwner: { id: string; isAdmin: boolean }
): Promise<GrantTiktokSocialAccount[]> {
  const ids = accountIds.filter(isUuid)
  if (!ids.length) return []
  const rows = await db
    .select({
      id: tiktokSocialAccounts.id,
      ownerId: tiktokSocialAccounts.ownerId,
      name: tiktokSocialAccounts.name,
      username: tiktokSocialAccounts.username,
      displayName: tiktokSocialAccounts.displayName,
      isBusinessAccount: tiktokSocialAccounts.isBusinessAccount,
      status: tiktokSocialAccounts.status,
    })
    .from(tiktokSocialAccounts)
    .where(and(inArray(tiktokSocialAccounts.id, ids), isNull(tiktokSocialAccounts.deletedAt)))
  return rows
    .filter((r) => r.status !== "disabled" && (mcpOwner.isAdmin || r.ownerId === mcpOwner.id))
    .map(({ ownerId: _o, ...r }) => r)
    .sort((a, b) => a.name.localeCompare(b.name))
}
