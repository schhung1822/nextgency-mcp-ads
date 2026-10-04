// Sign-in lockout for the PASSWORD step (Better Auth has none). IP-based rate limiting is Better Auth's own
// (`rateLimit.customRules`).
//
// Two counters per email, both in the `verification` table (survive restarts, work across instances):
// - `lockout:<sha256(email)>:ip:<sha256(ip)>`  - failures for the email from ONE client IP: 10 within 15 minutes
//                                                → that IP is locked out of that email for 15 minutes;
// - `lockout:<sha256(email)>`                  - every failure for the email, from any IP: 50 within 15 minutes
//                                                → account-wide lock for 15 minutes (distributed guessing).
//
// Decision (05-security.md §1, M3 + owner decision 2026-10-02 "2FA optional, off by default, admins included"):
// an unauthenticated attacker must not be able to lock the owner out of the app.
// - Per-(email, IP) lock: always applies. One attacker IP is locked after 10 wrong passwords but cannot lock the
//   real user anywhere else.
// - Account-wide lock: only for accounts WITHOUT 2FA (their only factor is the password) and with a much higher
//   threshold (50) so a single attacker needs many IPs to trigger it. Even then a client IP that signed in
//   successfully as this user within the last 30 days ("known IP", from activity_logs - the IP comes from the
//   proxy header Caddy overwrites, not from the client) is never refused by it.
// - Account WITH 2FA: only the per-(email, IP) lock applies; the TOTP step has its own account lockout in
//   Better Auth (10 failures → 15 min) and needs the correct password first.
// The `unlock <email>` CLI command clears every counter of an email (+ the 2FA lockout).
// No `next/*` imports: used from Better Auth hooks and scripts/cli.ts.
import { createHash } from "node:crypto"
import { and, eq, gte, like, or, sql } from "drizzle-orm"
import { db } from "@/server/db/client"
import { activityLogs, verification } from "@/server/db/schema"

/** Failed passwords per (email, client IP) before that IP is locked out of that email. */
export const LOCKOUT_MAX_FAILURES = 10
/** Failed passwords per email, any IP, before the account-wide lock (accounts without 2FA only). */
export const LOCKOUT_EMAIL_MAX_FAILURES = 50
export const LOCKOUT_WINDOW_MS = 15 * 60_000
export const LOCKOUT_DURATION_MS = 15 * 60_000
/** A client IP with a successful sign-in this recent is "known" for the account-wide lock. */
export const KNOWN_IP_DAYS = 30

export interface LockoutState {
  /** failures counted in the current window */
  failures: number
  /** epoch ms when the current counting window started */
  windowStart: number
  /** epoch ms until which sign-in is refused (null = not locked) */
  lockedUntil: number | null
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null
  const e = email.trim().toLowerCase()
  return e.length > 0 && e.length <= 254 ? e : null
}

export function isLocked(state: LockoutState | null | undefined, now: number): boolean {
  return !!state?.lockedUntil && state.lockedUntil > now
}

/** Pure transition for one failed password attempt (`maxFailures` = threshold of THIS counter). */
export function nextStateAfterFailure(
  state: LockoutState | null | undefined,
  now: number,
  maxFailures: number = LOCKOUT_MAX_FAILURES
): LockoutState {
  if (state && isLocked(state, now)) return state // already locked: do not extend
  const fresh = !state || now - state.windowStart >= LOCKOUT_WINDOW_MS || (state.lockedUntil !== null && state.lockedUntil <= now)
  const base: LockoutState = fresh ? { failures: 0, windowStart: now, lockedUntil: null } : state
  const failures = base.failures + 1
  if (failures >= maxFailures) {
    return { failures: 0, windowStart: now, lockedUntil: now + LOCKOUT_DURATION_MS }
  }
  return { failures, windowStart: base.windowStart, lockedUntil: null }
}

/** When the stored row can be discarded. */
export function stateExpiry(state: LockoutState): number {
  return Math.max(state.windowStart + LOCKOUT_WINDOW_MS, state.lockedUntil ?? 0)
}

export function parseState(value: string | null | undefined): LockoutState | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<LockoutState>
    if (typeof v.failures !== "number" || typeof v.windowStart !== "number") return null
    return {
      failures: v.failures,
      windowStart: v.windowStart,
      lockedUntil: typeof v.lockedUntil === "number" ? v.lockedUntil : null,
    }
  } catch {
    return null
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

export function lockoutKey(email: string): string {
  return `lockout:${sha(email)}`
}

/** Per-(email, client IP) counter. Unknown IP (no proxy header) shares one "unknown" bucket. */
export function lockoutIpKey(email: string, ip: string | null | undefined): string {
  return `${lockoutKey(email)}:ip:${sha(ip?.trim() || "unknown")}`
}

/**
 * Whether the password step must be refused (design above). `twoFactorEnabled` is the account's flag (false for
 * unknown emails); `knownIp` = this client IP signed in successfully as this account recently.
 */
export function isSignInLocked(input: {
  emailState: LockoutState | null | undefined
  ipState: LockoutState | null | undefined
  twoFactorEnabled: boolean
  /** default false */
  knownIp?: boolean
  now: number
}): boolean {
  if (isLocked(input.ipState, input.now)) return true
  if (input.twoFactorEnabled || input.knownIp) return false
  return isLocked(input.emailState, input.now)
}

/** Did `ip` sign in successfully as `userId` within the last KNOWN_IP_DAYS days? (uses the activity log) */
export async function isKnownLoginIp(userId: string, ip: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!ip) return false
  const rows = await db
    .select({ id: activityLogs.id })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.actorId, userId),
        eq(activityLogs.action, "auth.login.success"),
        eq(activityLogs.status, "success"),
        sql`${activityLogs.ip} = ${ip}::inet`,
        gte(activityLogs.createdAt, new Date(now - KNOWN_IP_DAYS * 86_400_000))
      )
    )
    .limit(1)
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function readKey(id: string): Promise<LockoutState | null> {
  const rows = await db
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.id, id))
    .limit(1)
  return parseState(rows[0]?.value)
}

export async function readLockout(email: string): Promise<LockoutState | null> {
  return readKey(lockoutKey(email))
}

export async function readIpLockout(email: string, ip: string | null | undefined): Promise<LockoutState | null> {
  return readKey(lockoutIpKey(email, ip))
}

async function bump(id: string, now: number, maxFailures: number): Promise<LockoutState> {
  return db.transaction(async (tx) => {
    await tx
      .insert(verification)
      .values({ id, identifier: id, value: "", expiresAt: new Date(now + LOCKOUT_WINDOW_MS) })
      .onConflictDoNothing({ target: verification.id })
    const rows = await tx.execute<{ value: string }>(
      sql`select ${verification.value} as value from ${verification} where ${verification.id} = ${id} for update`
    )
    const next = nextStateAfterFailure(parseState(rows.rows[0]?.value), now, maxFailures)
    await tx
      .update(verification)
      .set({ value: JSON.stringify(next), expiresAt: new Date(stateExpiry(next)), updatedAt: new Date(now) })
      .where(eq(verification.id, id))
    return next
  })
}

/** Atomically count a failed password for `email` (per email and per email+IP); returns both new states. */
export async function recordLoginFailure(
  email: string,
  ip: string | null | undefined,
  now = Date.now()
): Promise<{ email: LockoutState; ip: LockoutState }> {
  const emailState = await bump(lockoutKey(email), now, LOCKOUT_EMAIL_MAX_FAILURES)
  const ipState = await bump(lockoutIpKey(email, ip), now, LOCKOUT_MAX_FAILURES)
  return { email: emailState, ip: ipState }
}

/** Remove every lockout counter of `email` (all IPs). Returns how many rows were removed. */
export async function clearLoginFailures(email: string): Promise<number> {
  const base = lockoutKey(email)
  const res = await db
    .delete(verification)
    .where(or(eq(verification.id, base), like(verification.id, `${base}:ip:%`)))
    .returning({ id: verification.id })
  return res.length
}
