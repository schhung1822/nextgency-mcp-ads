// Shared re-authentication gate for sensitive actions (05-security.md §1 "Xác minh lại").
//
// Used by: MCP create / reveal / rotate, creating an admin, resetting another admin's password/2FA, banning /
// unbanning / deleting an admin, role changes, relaxing security settings, connection credential replacement,
// password change, 2FA setup/disable, backup-code regeneration - and, unless the session is fresh
// (isSessionFresh), CSV log export, revoking an admin's sessions and resetting a staff member's password/2FA.
//
// - Verifies the CURRENT session's password through Better Auth (`verifyPassword`), plus the TOTP code when
//   the user has 2FA enabled (unless `passwordOnly` - used where the factor being managed is 2FA itself).
// - Server-side `auth.api.*` calls skip Better Auth's HTTP rate limit, so every attempt goes through ONE
//   per-user failure budget: 5 failures / 15 min across all actions (activity_logs rows with
//   metadata.reauth = true, status failure). Serialised per user with a transaction-scoped advisory lock so
//   parallel requests cannot exceed the budget. Failures are logged and COMMITTED; `onSuccess` runs in the
//   same transaction as the lock (its own activity log included).
import "server-only"
import { createHash } from "node:crypto"
import { and, eq, gt, gte, sql } from "drizzle-orm"
import { headers as nextHeaders } from "next/headers"

import { reauth as t } from "@/lib/i18n/vi/reauth"
import { REAUTH_REQUIRED_FIELD } from "@/lib/schemas/reauth"
import { actorOf, logActivity, type ActivityAction } from "@/server/audit/activity-log"
import { db, type Tx } from "@/server/db/client"
import { activityLogs, verification } from "@/server/db/schema"

import { UserFacingError } from "./errors"

export const REAUTH_MAX_FAILURES = 5
export const REAUTH_WINDOW_MINUTES = 15
/** A successful re-auth (or a new sign-in) keeps the session "fresh" this long (CSV export, see isSessionFresh). */
export const REAUTH_FRESH_MINUTES = 10

export type ReauthOutcome = "ok" | "bad_password" | "bad_code" | "code_required"
/** Verifies the current user's password (+ TOTP when 2FA is on). Injected so tests can fake it. */
export type ReauthVerifier = () => Promise<ReauthOutcome>

export type ReauthErrorCode = "reauth_failed" | "reauth_code_required" | "reauth_locked" | "reauth_required"

export const REAUTH_MESSAGES = t.errors

/** Expected re-auth failure; message is safe to show (Vietnamese). */
export class ReauthError extends UserFacingError {
  constructor(
    public readonly code: ReauthErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>
  ) {
    super(message)
    this.name = "ReauthError"
  }
}

/**
 * "Please re-enter your password" (no verifier was sent). `fieldErrors[REAUTH_REQUIRED_FIELD]` tells the UI to open
 * its re-auth dialog; `extra` keeps field-specific hints (e.g. "reauth.password").
 */
export function reauthRequiredError(extra: Record<string, string> = {}): ReauthError {
  return new ReauthError("reauth_required", REAUTH_MESSAGES.required, { ...extra, [REAUTH_REQUIRED_FIELD]: "required" })
}

export interface ReauthActor {
  id: string
  email: string
  role: string
}

export interface ReauthLog {
  /** activity action of the protected operation (failures are logged under it with metadata.reauth = true) */
  action: ActivityAction
  target?: { type: string; id?: string | null; label?: string | null }
  metadata?: Record<string, unknown>
}

export interface ReauthOptions {
  /** mark this session "fresh" for REAUTH_FRESH_MINUTES after a successful re-auth */
  sessionId?: string
}

/** Re-auth failures of `actorId` in the current window (all actions). */
export async function recentReauthFailures(tx: Tx | typeof db, actorId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.actorId, actorId),
        eq(activityLogs.status, "failure"),
        sql`${activityLogs.metadata}->>'reauth' = 'true'`,
        gte(activityLogs.createdAt, sql`now() - make_interval(mins => ${REAUTH_WINDOW_MINUTES})`)
      )
    )
  return Number(r?.n ?? 0)
}

const freshKey = (sessionId: string) => `reauth-fresh:${createHash("sha256").update(sessionId).digest("hex")}`

async function markFresh(tx: Tx, sessionId: string) {
  const id = freshKey(sessionId)
  const expiresAt = new Date(Date.now() + REAUTH_FRESH_MINUTES * 60_000)
  await tx
    .insert(verification)
    .values({ id, identifier: id, value: "1", expiresAt })
    .onConflictDoUpdate({ target: verification.id, set: { expiresAt, updatedAt: new Date() } })
}

/** True when this session re-authenticated within the last REAUTH_FRESH_MINUTES. */
export async function isReauthFresh(sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: verification.id })
    .from(verification)
    .where(and(eq(verification.id, freshKey(sessionId)), gt(verification.expiresAt, new Date())))
    .limit(1)
  return rows.length > 0
}

/** The parts of AppSession the freshness rule needs. */
export interface FreshnessSession {
  sessionId: string
  /** epoch ms of the sign-in that created the session */
  sessionCreatedAt?: number
}

const FRESH_MS = REAUTH_FRESH_MINUTES * 60_000

/**
 * Fresh = signed in ≤ REAUTH_FRESH_MINUTES ago OR re-authenticated ≤ REAUTH_FRESH_MINUTES ago (any sensitive action).
 * One rule for CSV export, revoking an admin's sessions and resetting a staff member's password / 2FA.
 */
export async function isSessionFresh(s: FreshnessSession): Promise<boolean> {
  if (s.sessionCreatedAt && Date.now() - s.sessionCreatedAt <= FRESH_MS) return true
  return isReauthFresh(s.sessionId)
}

/** Epoch ms until which the session stays fresh (see isSessionFresh), or null when it is not fresh now. UI hint only. */
export async function sessionFreshUntil(s: FreshnessSession): Promise<number | null> {
  const signedInUntil = s.sessionCreatedAt ? s.sessionCreatedAt + FRESH_MS : 0
  const [row] = await db
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.id, freshKey(s.sessionId)))
    .limit(1)
  const until = Math.max(signedInUntil, row ? row.expiresAt.getTime() : 0)
  return until > Date.now() ? until : null
}

/** Re-authenticate, then run `onSuccess` in the same transaction (see file header). */
export async function withReauth<T>(
  actor: ReauthActor,
  log: ReauthLog,
  verify: ReauthVerifier,
  onSuccess: (tx: Tx) => Promise<T>,
  opts: ReauthOptions = {}
): Promise<T> {
  const r = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`reauth:${actor.id}`}))`)
    if ((await recentReauthFailures(tx, actor.id)) >= REAUTH_MAX_FAILURES) return { kind: "locked" as const }
    const outcome = await verify()
    if (outcome === "code_required") return { kind: "code_required" as const }
    if (outcome !== "ok") {
      await logActivity(
        {
          actor: actorOf(actor),
          action: log.action,
          target: log.target,
          status: "failure",
          metadata: { ...(log.metadata ?? {}), reason: outcome, reauth: true },
        },
        tx
      )
      return { kind: "failed" as const }
    }
    if (opts.sessionId) await markFresh(tx, opts.sessionId)
    return { kind: "ok" as const, value: await onSuccess(tx) }
  })
  if (r.kind === "locked") throw new ReauthError("reauth_locked", REAUTH_MESSAGES.locked)
  if (r.kind === "code_required")
    throw new ReauthError("reauth_code_required", REAUTH_MESSAGES.codeRequired, { code: REAUTH_MESSAGES.codeRequired })
  if (r.kind === "failed") throw new ReauthError("reauth_failed", REAUTH_MESSAGES.failed)
  return r.value
}

/** Re-auth gate only (the protected work runs afterwards, e.g. because it needs network calls). */
export async function requireReauth(
  actor: ReauthActor,
  log: ReauthLog,
  verify: ReauthVerifier,
  opts: ReauthOptions = {}
): Promise<void> {
  await withReauth(actor, log, verify, async () => undefined, opts)
}

/**
 * Better Auth re-authentication for the CURRENT session (headers of the request):
 * `verifyPassword`, then `verifyTOTP` when 2FA is enabled. With an existing verified session, verify-totp
 * only checks the code (no session/cookie change). `passwordOnly` skips the TOTP step.
 */
export async function verifyReauthWithBetterAuth(
  requestHeaders: Headers,
  user: { twoFactorEnabled: boolean },
  input: { password: string; code?: string },
  opts: { passwordOnly?: boolean } = {}
): Promise<ReauthOutcome> {
  const { getAuth } = await import("./auth")
  const api = getAuth().api
  try {
    const r = await api.verifyPassword({ body: { password: input.password }, headers: requestHeaders })
    if (!r?.status) return "bad_password"
  } catch {
    return "bad_password"
  }
  if (opts.passwordOnly || !user.twoFactorEnabled) return "ok"
  if (!input.code) return "code_required"
  try {
    await api.verifyTOTP({ body: { code: input.code }, headers: requestHeaders })
    return "ok"
  } catch {
    return "bad_code"
  }
}

/** Verifier bound to the current request (server actions / route handlers). */
export async function requestReauthVerifier(
  user: { twoFactorEnabled: boolean },
  input: { password: string; code?: string },
  opts: { passwordOnly?: boolean } = {}
): Promise<ReauthVerifier> {
  const h = new Headers(await nextHeaders())
  return () => verifyReauthWithBetterAuth(h, user, input, opts)
}
