import "server-only"

// TikTok Social accounts (17-tiktok-social.md §3-§5): connect (OAuth DCR + PKCE), reconnect, list, rename,
// enable / disable, delete. Visibility like ad connections: staff see / manage their own rows, admins every row.
// One live row per TikTok username (TSD1): signing in again with the same account replaces the tokens of that row.
// Tokens never leave the server; activity logs carry no secret.
import { randomUUID } from "node:crypto"

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"

import { tiktokSocialVi } from "@/lib/i18n/vi/tiktok-social"
import type { TiktokSocialAccountDetailDto, TiktokSocialAccountDto, TiktokSocialStatus } from "@/lib/schemas/tiktok-social"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import type { AppUser } from "@/server/auth/session"
import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { mcpServers, mcpTiktokSocialScopes, tiktokSocialAccounts, user as userTable } from "@/server/db/schema"
import { appBaseUrl } from "@/server/env"
import { invalidateGrantCache } from "@/server/mcp/grant"
import { disclaimerAuditMeta, type CreateAudit } from "@/server/services/disclaimers"
import { authorizeUrl, exchangeCode, isTiktokSocialError, newPkce, revokeToken } from "@/server/tiktok-social/api"
import { caller, getProfile } from "@/server/tiktok-social/data"
import {
  clientIdForRedirect,
  decryptTiktokSocialTokens,
  encryptTiktokSocialTokens,
  erasedTiktokSocialSecret,
  isUuid,
  liveStatus,
  loadTiktokSocialAccountRow,
  type TiktokSocialAccountRow,
} from "@/server/tiktok-social/store"

const e = tiktokSocialVi.errors
const TARGET = "tiktok_social"
/** the OAuth start cookie lives this long (TikTok sign-in + consent) */
export const TTS_STATE_TTL_MS = 10 * 60_000

export type TtsActor = Pick<AppUser, "id" | "email" | "role">

/** short reason keys the OAuth callback puts in its redirect (?reason=), mapped back to Vietnamese by the page */
export const TTS_CALLBACK_REASONS = ["state", "denied", "auth", "down", "profile", "duplicate", "wrong", "not_found", "register"] as const
export type TtsCallbackReason = (typeof TTS_CALLBACK_REASONS)[number]

export class TiktokSocialServiceError extends Error {
  readonly fieldErrors?: Record<string, string>
  readonly reason?: TtsCallbackReason
  constructor(message: string, fieldErrors?: Record<string, string>, reason?: TtsCallbackReason) {
    super(message)
    this.name = "TiktokSocialServiceError"
    this.fieldErrors = fieldErrors
    this.reason = reason
  }
}

/** cookie holding the OAuth state between "Kết nối" and the callback (__Host- prefix needs https) */
export function tiktokSocialStateCookieName(): string {
  return appBaseUrl().startsWith("https://") ? "__Host-ttsocial_oauth" : "ttsocial_oauth"
}

export function tiktokSocialRedirectUri(): string {
  return `${appBaseUrl()}/api/tiktok-social/callback`
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const statusOf = (v: string): TiktokSocialStatus => (v === "expiring" || v === "invalid" || v === "disabled" ? v : "active")
const canManage = (actor: TtsActor, row: Pick<TiktokSocialAccountRow, "ownerId">) => actor.role === "admin" || row.ownerId === actor.id

function toDto(actor: TtsActor, r: TiktokSocialAccountRow, ownerEmail: string | null): TiktokSocialAccountDto {
  return {
    id: r.id,
    name: r.name,
    username: r.username,
    displayName: r.displayName,
    profileUrl: r.profileUrl,
    isBusinessAccount: r.isBusinessAccount,
    status: statusOf(r.status),
    statusMessage: r.statusMessage,
    refreshExpiresAt: r.refreshExpiresAt.toISOString(),
    lastCheckedAt: iso(r.lastCheckedAt),
    lastUsedAt: iso(r.lastUsedAt),
    createdAt: r.createdAt.toISOString(),
    canManage: canManage(actor, r),
    ownerEmail: actor.role === "admin" ? ownerEmail : null,
    ownerId: r.ownerId,
  }
}

// ---- read ----------------------------------------------------------------------------------------------------

export async function listTiktokSocialAccounts(actor: TtsActor): Promise<TiktokSocialAccountDto[]> {
  const rows = await db
    .select({ a: tiktokSocialAccounts, email: userTable.email })
    .from(tiktokSocialAccounts)
    .innerJoin(userTable, eq(userTable.id, tiktokSocialAccounts.ownerId))
    .where(and(isNull(tiktokSocialAccounts.deletedAt), actor.role === "admin" ? undefined : eq(tiktokSocialAccounts.ownerId, actor.id)))
    .orderBy(asc(tiktokSocialAccounts.name), desc(tiktokSocialAccounts.createdAt))
  return rows.map((r) => toDto(actor, r.a, r.email))
}

async function visibleRow(actor: TtsActor, id: string): Promise<TiktokSocialAccountRow> {
  const row = isUuid(id) ? await loadTiktokSocialAccountRow(id) : null
  // staff: rows of others read as "not found" (no oracle)
  if (!row || !canManage(actor, row)) throw new TiktokSocialServiceError(e.notFound, undefined, "not_found")
  return row
}

export async function getTiktokSocialAccount(actor: TtsActor, id: string): Promise<TiktokSocialAccountDetailDto | null> {
  let row: TiktokSocialAccountRow
  try {
    row = await visibleRow(actor, id)
  } catch {
    return null
  }
  const [owner] = await db.select({ email: userTable.email }).from(userTable).where(eq(userTable.id, row.ownerId)).limit(1)
  const mcps = await db
    .select({ id: mcpServers.id, name: mcpServers.name })
    .from(mcpTiktokSocialScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpTiktokSocialScopes.mcpId))
    .where(
      and(
        eq(mcpTiktokSocialScopes.accountId, row.id),
        isNull(mcpServers.deletedAt),
        actor.role === "admin" ? undefined : eq(mcpServers.ownerId, actor.id)
      )
    )
    .orderBy(asc(mcpServers.name))
  return { ...toDto(actor, row, owner?.email ?? null), scopes: row.scopes, mcps }
}

/** accounts a MCP owned by `owner` may pick (admins: every live row; staff: their own), not disabled */
export async function listPickableTiktokSocialAccounts(owner: Pick<AppUser, "id" | "role">) {
  const rows = await db
    .select({
      id: tiktokSocialAccounts.id,
      name: tiktokSocialAccounts.name,
      username: tiktokSocialAccounts.username,
      status: tiktokSocialAccounts.status,
      isBusinessAccount: tiktokSocialAccounts.isBusinessAccount,
      ownerId: tiktokSocialAccounts.ownerId,
    })
    .from(tiktokSocialAccounts)
    .where(and(isNull(tiktokSocialAccounts.deletedAt), owner.role === "admin" ? undefined : eq(tiktokSocialAccounts.ownerId, owner.id)))
    .orderBy(asc(tiktokSocialAccounts.name))
  return rows.map((r) => ({ ...r, status: statusOf(r.status) }))
}

// ---- connect (OAuth) -----------------------------------------------------------------------------------------

interface OauthState {
  /** state */
  s: string
  /** PKCE verifier */
  v: string
  /** user who started */
  u: string
  /** client id + redirect uri used for the authorize URL */
  c: string
  r: string
  /** reconnect target row */
  id?: string
  /** expiry (ms) */
  x: number
  /** disclaimer version accepted (audit) */
  dv?: string
}

/**
 * Starts a sign-in: registers this install's OAuth client (first time), builds the TikTok authorize URL and the
 * encrypted state blob the action stores in an httpOnly cookie. Reconnect: the row must be manageable by the actor.
 */
export async function beginTiktokSocialConnect(
  actor: TtsActor,
  input: { reconnectId?: string },
  audit?: CreateAudit
): Promise<{ url: string; stateBlob: string }> {
  if (input.reconnectId) await visibleRow(actor, input.reconnectId)
  const redirectUri = tiktokSocialRedirectUri()
  let clientId: string
  try {
    clientId = await clientIdForRedirect(redirectUri)
  } catch (err) {
    console.error("[tiktok-social] register", safeErrorForLog(err))
    throw new TiktokSocialServiceError(e.registerFailed, undefined, "register")
  }
  const p = newPkce()
  const state: OauthState = {
    s: p.state,
    v: p.verifier,
    u: actor.id,
    c: clientId,
    r: redirectUri,
    ...(input.reconnectId ? { id: input.reconnectId } : {}),
    x: Date.now() + TTS_STATE_TTL_MS,
    ...(audit?.disclaimerVersion ? { dv: audit.disclaimerVersion } : {}),
  }
  return {
    url: authorizeUrl({ clientId, redirectUri, challenge: p.challenge, state: p.state }),
    stateBlob: encryptSecret(JSON.stringify(state), aad.tiktokSocialOauthState()),
  }
}

function readState(blob: string | undefined): OauthState | null {
  if (!blob || blob.length > 4096) return null
  try {
    const o = JSON.parse(decryptSecret(blob, aad.tiktokSocialOauthState())) as OauthState
    return typeof o?.s === "string" && typeof o.v === "string" && typeof o.u === "string" && typeof o.c === "string" && typeof o.r === "string" && typeof o.x === "number"
      ? o
      : null
  } catch {
    return null
  }
}

/**
 * Finishes a sign-in (callback): checks the state blob (same user, same state, not expired), exchanges the code,
 * reads the TikTok profile, then inserts a row or - same username - replaces the tokens of the live row.
 */
export async function completeTiktokSocialConnect(
  actor: TtsActor,
  input: { code?: string; state?: string; error?: string; stateBlob?: string }
): Promise<{ id: string; username: string; reconnected: boolean }> {
  const st = readState(input.stateBlob)
  if (!st || st.u !== actor.id || !input.state || st.s !== input.state || st.x < Date.now()) throw new TiktokSocialServiceError(e.stateInvalid, undefined, "state")
  if (input.error || !input.code) throw new TiktokSocialServiceError(e.denied, undefined, "denied")
  // the redirect URI must still be the one the client was registered for (APP_URL unchanged)
  if (st.r !== tiktokSocialRedirectUri()) throw new TiktokSocialServiceError(e.stateInvalid, undefined, "state")

  let tokens: Awaited<ReturnType<typeof exchangeCode>>
  try {
    tokens = await exchangeCode({ clientId: st.c, redirectUri: st.r, code: input.code, verifier: st.v })
  } catch (err) {
    if (isTiktokSocialError(err) && (err.code === "auth" || err.code === "invalid_request")) throw new TiktokSocialServiceError(e.tiktokAuth, undefined, "auth")
    console.error("[tiktok-social] token", safeErrorForLog(err))
    throw new TiktokSocialServiceError(e.tiktokDown, undefined, "down")
  }
  let profile: Awaited<ReturnType<typeof getProfile>>
  try {
    profile = await getProfile(caller(tokens.accessToken))
  } catch (err) {
    console.error("[tiktok-social] profile", safeErrorForLog(err))
    throw new TiktokSocialServiceError(e.tiktokDown, undefined, "down")
  }
  const username = profile.username
  if (!username) throw new TiktokSocialServiceError(e.noProfile, undefined, "profile")

  const now = new Date()
  const result = await db.transaction(async (tx) => {
    // one writer per username at a time
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ttsocial-user:${username}`}))`)
    const [existing] = await tx
      .select()
      .from(tiktokSocialAccounts)
      .where(and(eq(tiktokSocialAccounts.username, username), isNull(tiktokSocialAccounts.deletedAt)))
      .limit(1)
    if (st.id) {
      const target = await loadTiktokSocialAccountRow(st.id, tx)
      if (!target || !canManage(actor, target)) throw new TiktokSocialServiceError(e.notFound, undefined, "not_found")
      if (target.username !== username) throw new TiktokSocialServiceError(e.wrongAccount(target.username, username), { expected: target.username, got: username }, "wrong")
    }
    const tokenCols = {
      clientId: st.c,
      credentialsEncrypted: "",
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      scopes: tokens.scopes,
      status: liveStatus(tokens.refreshExpiresAt, now),
      statusMessage: null,
      lastCheckedAt: now,
      displayName: profile.displayName,
      profileUrl: profile.profileUrl,
      isBusinessAccount: profile.isBusinessAccount,
    }
    if (existing) {
      if (!canManage(actor, existing)) throw new TiktokSocialServiceError(e.duplicateOther, undefined, "duplicate")
      await tx
        .update(tiktokSocialAccounts)
        .set({ ...tokenCols, credentialsEncrypted: encryptTiktokSocialTokens(existing.id, tokens) })
        .where(eq(tiktokSocialAccounts.id, existing.id))
      await logActivity(
        {
          actor: actorOf(actor),
          action: "tiktok_social.reconnect",
          target: { type: TARGET, id: existing.id, label: existing.name },
          metadata: { username, statusBefore: existing.status },
        },
        tx
      )
      return { id: existing.id, username, reconnected: true, previous: existing }
    }
    const id = randomUUID()
    const name = (profile.displayName ? `${profile.displayName} (@${username})` : `@${username}`).slice(0, 80)
    await tx.insert(tiktokSocialAccounts).values({
      id,
      ownerId: actor.id,
      name,
      username,
      ...tokenCols,
      credentialsEncrypted: encryptTiktokSocialTokens(id, tokens),
    })
    await logActivity(
      {
        actor: actorOf(actor),
        action: "tiktok_social.connect",
        target: { type: TARGET, id, label: name },
        metadata: {
          username,
          isBusinessAccount: profile.isBusinessAccount,
          scopes: tokens.scopes,
          ...disclaimerAuditMeta(st.dv ? { disclaimerVersion: st.dv } : undefined),
        },
      },
      tx
    )
    return { id, username, reconnected: false, previous: null }
  })
  // best effort: the replaced refresh token (a different sign-in) is revoked at TikTok
  if (result.previous) void revokeOld(result.previous, tokens.refreshToken)
  invalidateGrantCache()
  return { id: result.id, username: result.username, reconnected: result.reconnected }
}

async function revokeOld(row: TiktokSocialAccountRow, newRefresh: string): Promise<void> {
  try {
    const old = decryptTiktokSocialTokens(row)
    if (old.refreshToken !== newRefresh) await revokeToken({ clientId: row.clientId, token: old.refreshToken })
  } catch {
    /* best effort */
  }
}

// ---- manage --------------------------------------------------------------------------------------------------

export async function renameTiktokSocialAccount(actor: TtsActor, input: { id: string; name: string }): Promise<void> {
  const row = await visibleRow(actor, input.id)
  const name = input.name.trim()
  if (name === row.name) return
  await db.transaction(async (tx) => {
    await tx.update(tiktokSocialAccounts).set({ name }).where(and(eq(tiktokSocialAccounts.id, row.id), isNull(tiktokSocialAccounts.deletedAt)))
    await logActivity(
      { actor: actorOf(actor), action: "tiktok_social.update", target: { type: TARGET, id: row.id, label: name }, metadata: { before: { name: row.name }, after: { name } } },
      tx
    )
  })
  invalidateGrantCache()
}

export async function setTiktokSocialAccountEnabled(actor: TtsActor, input: { id: string; enabled: boolean }): Promise<void> {
  const row = await visibleRow(actor, input.id)
  if (input.enabled === (row.status !== "disabled")) return
  // enabling an invalid row keeps it invalid (sign in again); enabling a disabled row → live status
  const status = input.enabled ? liveStatus(row.refreshExpiresAt) : "disabled"
  await db.transaction(async (tx) => {
    await tx
      .update(tiktokSocialAccounts)
      .set({ status, statusMessage: null })
      .where(and(eq(tiktokSocialAccounts.id, row.id), isNull(tiktokSocialAccounts.deletedAt)))
    await logActivity(
      {
        actor: actorOf(actor),
        action: input.enabled ? "tiktok_social.enable" : "tiktok_social.disable",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: { username: row.username },
      },
      tx
    )
  })
  invalidateGrantCache()
}

export async function deleteTiktokSocialAccount(actor: TtsActor, input: { id: string; confirmName: string }): Promise<void> {
  const row = await visibleRow(actor, input.id)
  if (input.confirmName.trim() !== row.name.trim()) throw new TiktokSocialServiceError(e.confirmName, { confirmName: e.confirmName })
  const [affected] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mcpTiktokSocialScopes)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpTiktokSocialScopes.mcpId))
    .where(and(eq(mcpTiktokSocialScopes.accountId, row.id), isNull(mcpServers.deletedAt)))
  let refreshToken: string | null = null
  try {
    refreshToken = decryptTiktokSocialTokens(row).refreshToken
  } catch {
    /* unreadable: nothing to revoke */
  }
  await db.transaction(async (tx) => {
    await tx
      .update(tiktokSocialAccounts)
      .set({ deletedAt: new Date(), credentialsEncrypted: erasedTiktokSocialSecret(row.id), statusMessage: null })
      .where(and(eq(tiktokSocialAccounts.id, row.id), isNull(tiktokSocialAccounts.deletedAt)))
    // the MCPs stop listing it (the grant ignores deleted rows anyway)
    await tx.delete(mcpTiktokSocialScopes).where(eq(mcpTiktokSocialScopes.accountId, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "tiktok_social.delete",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: { username: row.username, affectedMcpCount: Number(affected?.n ?? 0) },
      },
      tx
    )
  })
  invalidateGrantCache()
  if (refreshToken) {
    try {
      await revokeToken({ clientId: row.clientId, token: refreshToken })
    } catch {
      /* best effort */
    }
  }
}

/** live rows a staff user still owns (user deletion is blocked while any exist) */
export async function countLiveTiktokSocialAccounts(userIds: string[]): Promise<number> {
  if (!userIds.length) return 0
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tiktokSocialAccounts)
    .where(and(inArray(tiktokSocialAccounts.ownerId, userIds), isNull(tiktokSocialAccounts.deletedAt)))
  return Number(r?.n ?? 0)
}
