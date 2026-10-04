// User management + account self-service. Callers (server actions/pages) authenticate first;
// every mutation here re-checks authorization and writes activity_logs.
// Better Auth admin APIs are ALWAYS called with `headers: await headers()` (permission check) - the only
// exception is createFirstAdmin() (guarded by SETUP_TOKEN + empty-DB check under an advisory lock, and
// explicitly marked trusted through runWithUserCreateContext - hooks.ts rejects any other headerless call).
//
// Non-transactional Better Auth calls (they use their own DB connection, so they cannot join our
// transaction): createUser, setRole, setUserPassword, banUser/unbanUser, removeUser. Mitigations: the
// mustChangePassword/createdById flags are set IN the user INSERT (databaseHooks, L7); the other calls run
// inside withUserGuard's transaction (advisory lock + checks) and the activity log is written right after
// in that transaction - if the log insert fails, the Better Auth change has already happened (logged as a
// failure by logFailure).
import "server-only"
import { and, count, desc, eq, gt, inArray, isNull, like, max, ne, or, sql } from "drizzle-orm"
import { headers } from "next/headers"

import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { users as tUsers } from "@/lib/i18n/vi/users"
import { account as tAccount } from "@/lib/i18n/vi/account"
import type { UserRole } from "@/lib/schemas/users"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { getAuth } from "@/server/auth/auth"
import { apiErrorCode, UserFacingError } from "@/server/auth/errors"
import { readTwoFactorPolicy } from "@/server/auth/two-factor-policy"
import { checkUserOp, isQualifyingAdmin, roleChangeOp, verifySetupToken, type UserOp } from "@/server/auth/guards"
import { ReauthError, REAUTH_MESSAGES, requireReauth, type ReauthLog, type ReauthVerifier } from "@/server/auth/reauth"
import { AuthorizationError, type AppSession } from "@/server/auth/session"
import { runWithUserCreateContext } from "@/server/auth/user-create-context"
import { db, type Tx } from "@/server/db/client"
import { activityLogs, connections, mcpServers, session, twoFactor, user, verification } from "@/server/db/schema"

/** pg_advisory_xact_lock keys (arbitrary constants, distinct from scripts/migrate.ts). */
const SETUP_LOCK = 7272711
const ADMIN_GUARD_LOCK = 7272712

// ---------------------------------------------------------------------------
// Read models (never include tokens/secrets)
// ---------------------------------------------------------------------------

export interface UserListItem {
  id: string
  name: string
  email: string
  role: UserRole
  twoFactorEnabled: boolean
  banned: boolean
  mustChangePassword: boolean
  createdAt: string
  lastLoginAt: string | null
}

export interface SessionItem {
  id: string
  device: string
  ip: string | null
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  current: boolean
}

const toRole = (r: string | null): UserRole => (r === "admin" ? "admin" : "staff")

export async function countUsers(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(user)
  return Number(row?.n ?? 0)
}

/** Admin only (caller must have passed requireAdmin / requireUserForAction({role:"admin"})). */
export async function listUsers(): Promise<UserListItem[]> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabled,
      banned: user.banned,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(desc(user.createdAt))
  const ids = rows.map((r) => r.id)
  const last = ids.length
    ? await db
        .select({ actorId: activityLogs.actorId, at: max(activityLogs.createdAt) })
        .from(activityLogs)
        .where(and(eq(activityLogs.action, "auth.login.success"), inArray(activityLogs.actorId, ids)))
        .groupBy(activityLogs.actorId)
    : []
  const lastBy = new Map(last.map((l) => [l.actorId, l.at]))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: toRole(r.role),
    twoFactorEnabled: !!r.twoFactorEnabled,
    banned: !!r.banned,
    mustChangePassword: !!r.mustChangePassword,
    createdAt: r.createdAt.toISOString(),
    lastLoginAt: lastBy.get(r.id)?.toISOString() ?? null,
  }))
}

/** Active sessions of `userId` (caller authorizes: self or admin). Never returns the session token. */
export async function listSessionsOf(userId: string, currentSessionId?: string): Promise<SessionItem[]> {
  const rows = await db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.updatedAt))
  return rows.map((r) => ({
    id: r.id,
    device: describeUserAgent(r.userAgent),
    ip: r.ipAddress || null,
    createdAt: r.createdAt.toISOString(),
    lastActiveAt: (r.updatedAt ?? r.createdAt).toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    current: r.id === currentSessionId,
  }))
}

/** Short Vietnamese device label from a User-Agent ("Chrome trên Windows"). Heuristic, display only. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return tAccount.device.unknown
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /node|undici|curl/i.test(ua)
              ? "Ứng dụng"
              : null
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iOS/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null
  if (!browser && !os) return tAccount.device.unknown
  return tAccount.device.on(browser ?? "Trình duyệt", os ?? "hệ điều hành không rõ")
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

export interface SetupInputData {
  name: string
  email: string
  password: string
  setupToken: string
}

/**
 * Create the very first admin. Only when the user table is empty AND the SETUP_TOKEN matches; both checked
 * under a transaction-scoped advisory lock so two concurrent submissions cannot create two admins.
 * `auth.api.createUser` is intentionally called WITHOUT headers here (no session exists yet).
 */
export async function createFirstAdmin(input: SetupInputData): Promise<{ userId: string }> {
  if (!verifySetupToken(input.setupToken, process.env.SETUP_TOKEN)) {
    throw new UserFacingError(tAuth.errors.SETUP_TOKEN_INVALID)
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`)
    const [row] = await tx.select({ n: count() }).from(user)
    if (Number(row?.n ?? 0) > 0) throw new UserFacingError(tAuth.errors.SETUP_ALREADY_DONE)
    // Headerless (no session yet) → must be explicitly marked trusted; the first admin chose this password.
    const created = await runWithUserCreateContext({ kind: "setup", mustChangePassword: false }, () =>
      getAuth().api.createUser({
        body: { email: input.email, password: input.password, name: input.name, role: "admin" },
      })
    )
    const id = created.user.id
    await tx.update(user).set({ emailVerified: true }).where(eq(user.id, id))
    await logActivity(
      {
        actor: { id, email: created.user.email, role: "admin" },
        action: "setup.first_admin",
        target: { type: "user", id, label: created.user.email },
        metadata: { name: input.name, email: created.user.email },
      },
      tx
    )
    return { userId: id }
  })
}

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------

interface GuardedContext {
  tx: Tx
  target: typeof user.$inferSelect
}

/**
 * Runs `fn` inside a transaction holding a global advisory lock for user-management changes:
 * re-reads the acting admin (still admin, active, 2FA), loads the target, applies `checkUserOp`
 * (no self-action, ≥1 qualifying admin must remain) and then lets `fn` perform the change.
 * Better Auth API calls inside `fn` run on their own connection; the lock still serialises
 * concurrent admin changes (e.g. two admins demoting each other at the same time).
 */
async function withUserGuard<T>(
  actor: AppSession,
  targetId: string,
  op: UserOp | ((target: typeof user.$inferSelect) => UserOp | null),
  fn: (c: GuardedContext) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`)
    const policy = await readTwoFactorPolicy(tx)
    const [me] = await tx.select().from(user).where(eq(user.id, actor.user.id)).limit(1)
    if (!me || !isQualifyingAdmin(me, policy.admin)) throw new AuthorizationError()
    const [target] = await tx.select().from(user).where(eq(user.id, targetId)).limit(1)
    if (!target) throw new UserFacingError(tUsers.errors.notFound)
    const resolvedOp = typeof op === "function" ? op(target) : op
    if (resolvedOp === null) throw new UserFacingError(tUsers.errors.sameRole)
    const [others] = await tx
      .select({ n: count() })
      .from(user)
      .where(
        and(
          eq(user.role, "admin"),
          policy.admin ? eq(user.twoFactorEnabled, true) : undefined,
          or(isNull(user.banned), eq(user.banned, false)),
          ne(user.id, target.id)
        )
      )
    const verdict = checkUserOp({
      actorId: actor.user.id,
      requireAdminTwoFactor: policy.admin,
      target,
      op: resolvedOp,
      otherQualifyingAdmins: Number(others?.n ?? 0),
    })
    if (!verdict.ok) throw new UserFacingError(verdict.error)
    return fn({ tx, target })
  })
}

/**
 * Re-authentication of the acting admin (password + TOTP) for the most sensitive user-management actions
 * (creating an admin, resetting another admin's password/2FA, changing roles). Shared failure budget.
 * `verify` missing → "please re-enter your password" (the UI collects it when the target is an admin).
 */
async function reauthAdmin(actor: AppSession, log: ReauthLog, verify: ReauthVerifier | undefined): Promise<void> {
  if (!verify) {
    throw new ReauthError("reauth_required", REAUTH_MESSAGES.required, { "reauth.password": REAUTH_MESSAGES.required })
  }
  await requireReauth(
    { id: actor.user.id, email: actor.user.email, role: actor.user.role },
    log,
    verify,
    { sessionId: actor.sessionId }
  )
}

/** Log a failed admin mutation (outside the rolled-back transaction). Never throws. */
async function logFailure(
  actor: AppSession,
  action: Parameters<typeof logActivity>[0]["action"],
  targetId: string | null,
  e: unknown,
  label?: string | null
) {
  // re-auth failures are already logged (and counted) by the re-auth gate
  if (e instanceof ReauthError && e.code !== "reauth_required") return
  const reason = e instanceof UserFacingError ? "rejected" : (apiErrorCode(e) ?? (e instanceof Error ? e.name : "error"))
  await logActivity({
    actor: actorOf(actor.user),
    action,
    status: "failure",
    target: { type: "user", id: targetId, label: label ?? null },
    metadata: { reason, ...(e instanceof UserFacingError ? { message: e.message } : {}) },
  }).catch(() => {})
}

async function deleteTrustedDevices(tx: Tx, userId: string) {
  await tx.delete(verification).where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, userId)))
}

export async function createUserByAdmin(
  actor: AppSession,
  input: { name: string; email: string; role: UserRole; password: string },
  /** required when creating an ADMIN */
  verify?: ReauthVerifier
): Promise<{ userId: string }> {
  if (actor.user.role !== "admin") throw new AuthorizationError()
  try {
    if (input.role === "admin") {
      await reauthAdmin(
        actor,
        { action: "user.create", target: { type: "user", id: null, label: input.email }, metadata: { role: "admin" } },
        verify
      )
    }
    const h = await headers()
    // mustChangePassword + createdById are written in the INSERT itself (databaseHooks, L7).
    const created = await runWithUserCreateContext(
      { kind: "admin", createdById: actor.user.id, mustChangePassword: true },
      () =>
        getAuth().api.createUser({
          body: { email: input.email, password: input.password, name: input.name, role: input.role },
          headers: h,
        })
    )
    const id = created.user.id
    await db.transaction(async (tx) => {
      await logActivity(
        {
          actor: actorOf(actor.user),
          action: "user.create",
          target: { type: "user", id, label: created.user.email },
          metadata: { name: input.name, email: created.user.email, role: input.role },
        },
        tx
      )
    })
    return { userId: id }
  } catch (e) {
    await logFailure(actor, "user.create", null, e, input.email)
    throw e
  }
}

export async function changeUserRole(
  actor: AppSession,
  input: { userId: string; role: UserRole },
  verify: ReauthVerifier
): Promise<void> {
  const h = await headers()
  try {
    // Sensitive action: re-verify the acting admin (password + TOTP, shared budget - 05-security.md §1).
    await reauthAdmin(actor, { action: "user.role.change", target: { type: "user", id: input.userId } }, verify)
    await withUserGuard(
      actor,
      input.userId,
      (t) => roleChangeOp(t.role, input.role),
      async ({ tx, target }) => {
        await getAuth().api.setRole({ body: { userId: target.id, role: input.role }, headers: h })
        // A promoted admin must never skip 2FA through an old "trust this device" cookie.
        if (input.role === "admin") await deleteTrustedDevices(tx, target.id)
        await logActivity(
          {
            actor: actorOf(actor.user),
            action: "user.role.change",
            target: { type: "user", id: target.id, label: target.email },
            metadata: { before: { role: toRole(target.role) }, after: { role: input.role } },
          },
          tx
        )
      }
    )
  } catch (e) {
    await logFailure(actor, "user.role.change", input.userId, e)
    throw e
  }
}

/** Role of `userId` (null when not found) - decides whether the acting admin must re-authenticate. */
async function roleOfUser(userId: string): Promise<UserRole | null> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1)
  return row ? toRole(row.role) : null
}

export async function resetUserPassword(
  actor: AppSession,
  input: { userId: string; password: string },
  /** required when the target is an ADMIN */
  verify?: ReauthVerifier
): Promise<void> {
  const h = await headers()
  try {
    let reauthed = false
    if ((await roleOfUser(input.userId)) === "admin") {
      await reauthAdmin(actor, { action: "user.password.reset", target: { type: "user", id: input.userId } }, verify)
      reauthed = true
    }
    await withUserGuard(actor, input.userId, "resetPassword", async ({ tx, target }) => {
      // re-checked under the lock (the target may have been promoted meanwhile)
      if (toRole(target.role) === "admin" && !reauthed) await reauthAdmin(actor, { action: "user.password.reset" }, undefined)
      await getAuth().api.setUserPassword({ body: { userId: target.id, newPassword: input.password }, headers: h })
      await tx.update(user).set({ mustChangePassword: true }).where(eq(user.id, target.id))
      await tx.delete(session).where(eq(session.userId, target.id))
      await logActivity(
        {
          actor: actorOf(actor.user),
          action: "user.password.reset",
          target: { type: "user", id: target.id, label: target.email },
          metadata: { forcedChangeOnLogin: true, sessionsRevoked: true },
        },
        tx
      )
    })
  } catch (e) {
    await logFailure(actor, "user.password.reset", input.userId, e)
    throw e
  }
}

export async function resetUserTwoFactor(
  actor: AppSession,
  input: { userId: string },
  /** required when the target is an ADMIN */
  verify?: ReauthVerifier
): Promise<void> {
  try {
    let reauthed = false
    if ((await roleOfUser(input.userId)) === "admin") {
      await reauthAdmin(actor, { action: "user.2fa.reset", target: { type: "user", id: input.userId } }, verify)
      reauthed = true
    }
    await withUserGuard(actor, input.userId, "reset2fa", async ({ tx, target }) => {
      if (toRole(target.role) === "admin" && !reauthed) await reauthAdmin(actor, { action: "user.2fa.reset" }, undefined)
      await tx.delete(twoFactor).where(eq(twoFactor.userId, target.id))
      await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, target.id))
      await deleteTrustedDevices(tx, target.id)
      await tx.delete(session).where(eq(session.userId, target.id))
      await logActivity(
        {
          actor: actorOf(actor.user),
          action: "user.2fa.reset",
          target: { type: "user", id: target.id, label: target.email },
          metadata: { before: { twoFactorEnabled: !!target.twoFactorEnabled }, after: { twoFactorEnabled: false } },
        },
        tx
      )
    })
  } catch (e) {
    await logFailure(actor, "user.2fa.reset", input.userId, e)
    throw e
  }
}

export async function setUserBanned(actor: AppSession, input: { userId: string; banned: boolean }): Promise<void> {
  const h = await headers()
  const action = input.banned ? "user.ban" : "user.unban"
  try {
    await withUserGuard(actor, input.userId, input.banned ? "ban" : "unban", async ({ tx, target }) => {
      if (input.banned) {
        // banUser also deletes every session of the user.
        await getAuth().api.banUser({ body: { userId: target.id }, headers: h })
      } else {
        await getAuth().api.unbanUser({ body: { userId: target.id }, headers: h })
      }
      await logActivity(
        {
          actor: actorOf(actor.user),
          action,
          target: { type: "user", id: target.id, label: target.email },
          metadata: { before: { banned: !!target.banned }, after: { banned: input.banned } },
        },
        tx
      )
    })
  } catch (e) {
    await logFailure(actor, action, input.userId, e)
    throw e
  }
}

export async function revokeUserSessionsByAdmin(
  actor: AppSession,
  input: { userId: string; sessionId?: string }
): Promise<number> {
  try {
    return await withUserGuard(actor, input.userId, "revokeSessions", async ({ tx, target }) => {
      const where = input.sessionId
        ? and(eq(session.userId, target.id), eq(session.id, input.sessionId))
        : eq(session.userId, target.id)
      const deleted = await tx.delete(session).where(where).returning({ id: session.id })
      await logActivity(
        {
          actor: actorOf(actor.user),
          action: "user.sessions.revoke",
          target: { type: "user", id: target.id, label: target.email },
          metadata: { scope: input.sessionId ? "one" : "all", count: deleted.length },
        },
        tx
      )
      return deleted.length
    })
  } catch (e) {
    await logFailure(actor, "user.sessions.revoke", input.userId, e)
    throw e
  }
}

export async function deleteUserByAdmin(actor: AppSession, input: { userId: string }): Promise<void> {
  const h = await headers()
  try {
    await withUserGuard(actor, input.userId, "delete", async ({ tx, target }) => {
      // connections/mcp_servers.owner_id are ON DELETE RESTRICT (also soft-deleted rows).
      const [[c], [m]] = await Promise.all([
        tx.select({ n: count() }).from(connections).where(eq(connections.ownerId, target.id)),
        tx.select({ n: count() }).from(mcpServers).where(eq(mcpServers.ownerId, target.id)),
      ])
      const nc = Number(c?.n ?? 0)
      const nm = Number(m?.n ?? 0)
      if (nc > 0 || nm > 0) throw new UserFacingError(tUsers.errors.ownsResources(nc, nm))
      await getAuth().api.removeUser({ body: { userId: target.id }, headers: h })
      await logActivity(
        {
          actor: actorOf(actor.user),
          action: "user.delete",
          target: { type: "user", id: target.id, label: target.email },
          metadata: { name: target.name, email: target.email, role: toRole(target.role) },
        },
        tx
      )
    })
  } catch (e) {
    await logFailure(actor, "user.delete", input.userId, e)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Self-service (/account)
// ---------------------------------------------------------------------------

export async function updateOwnProfile(actor: AppSession, input: { name: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actor.user.id)).limit(1)
    if (!before) throw new AuthorizationError()
    if (before.name === input.name) return
    await tx.update(user).set({ name: input.name }).where(eq(user.id, actor.user.id))
    await logActivity(
      {
        actor: actorOf(actor.user),
        action: "user.update",
        target: { type: "user", id: actor.user.id, label: actor.user.email },
        metadata: { before: { name: before.name }, after: { name: input.name } },
      },
      tx
    )
  })
}

/** Revoke one of my sessions (not the current one) or every other session. */
export async function revokeOwnSessions(
  actor: AppSession,
  input: { sessionId?: string }
): Promise<number> {
  return db.transaction(async (tx) => {
    const where = input.sessionId
      ? and(eq(session.userId, actor.user.id), eq(session.id, input.sessionId), ne(session.id, actor.sessionId))
      : and(eq(session.userId, actor.user.id), ne(session.id, actor.sessionId))
    const deleted = await tx.delete(session).where(where).returning({ id: session.id })
    await logActivity(
      {
        actor: actorOf(actor.user),
        action: "user.sessions.revoke",
        target: { type: "user", id: actor.user.id, label: actor.user.email },
        metadata: { scope: input.sessionId ? "one" : "others", count: deleted.length, self: true },
      },
      tx
    )
    return deleted.length
  })
}

/** After a successful forced password change. */
export async function clearMustChangePassword(userId: string): Promise<void> {
  await db.update(user).set({ mustChangePassword: false }).where(eq(user.id, userId))
}

/**
 * Role of the user behind a pending 2FA sign-in challenge (cookie `better-auth.two_factor`), used only to
 * decide whether to show "trust this device" (hidden for admins; the before-hook enforces it server-side).
 * Returns null when the challenge is missing/expired.
 */
export async function pendingTwoFactorRole(cookieValue: string | undefined): Promise<UserRole | null> {
  if (!cookieValue) return null
  let raw = cookieValue
  try {
    raw = decodeURIComponent(cookieValue)
  } catch {
    /* keep raw */
  }
  const dot = raw.lastIndexOf(".")
  const identifier = dot > 0 ? raw.slice(0, dot) : raw
  // Better Auth: `2fa-${generateRandomString(20)}` (alphabet a-z A-Z 0-9 - _)
  if (!/^2fa-[A-Za-z0-9_-]{8,64}$/.test(identifier)) return null
  const rows = await db
    .select({ role: user.role })
    .from(verification)
    .innerJoin(user, eq(user.id, verification.value))
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
    .limit(1)
  return rows[0] ? toRole(rows[0].role) : null
}
