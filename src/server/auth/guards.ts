// Pure authorization guards for user management + setup token check (unit-tested, no I/O).
import { createHash, timingSafeEqual } from "node:crypto"

import { users as tUsers } from "@/lib/i18n/vi/users"

/** Same as env.ts SETUP_TOKEN_MIN_LENGTH (kept here so this module stays dependency-free). */
export const SETUP_TOKEN_MIN_LENGTH = 24

export interface GuardUser {
  id: string
  role: string | null
  banned: boolean | null
  twoFactorEnabled: boolean | null
}

/**
 * Admin that keeps the system manageable: role admin, not banned, and - when the 2FA policy requires it
 * for admins (setting `require_2fa_admin`, default off) - 2FA enabled.
 */
export function isQualifyingAdmin(
  u: Pick<GuardUser, "role" | "banned" | "twoFactorEnabled">,
  requireTwoFactor = true
): boolean {
  return u.role === "admin" && !u.banned && (!requireTwoFactor || !!u.twoFactorEnabled)
}

/**
 * Operations an admin performs on another user. `demote` = admin → staff.
 * Those marked in LOSES_ADMIN make the target stop counting as a qualifying admin.
 */
export type UserOp =
  | "create"
  | "demote"
  | "promote"
  | "ban"
  | "unban"
  | "delete"
  | "reset2fa"
  | "resetPassword"
  | "revokeSessions"

const LOSES_ADMIN: ReadonlySet<UserOp> = new Set(["demote", "ban", "delete", "reset2fa"])

export type GuardResult = { ok: true } | { ok: false; error: string }

/**
 * Rules (05-security.md §1): an admin never acts on themselves from user management,
 * and there must always remain ≥1 active admin with 2FA.
 * `otherQualifyingAdmins` = qualifying admins excluding the target (computed under a lock).
 */
export function checkUserOp(input: {
  actorId: string
  target: GuardUser
  op: UserOp
  otherQualifyingAdmins: number
  /** 2FA policy for admins (require_2fa_admin); default true = strictest */
  requireAdminTwoFactor?: boolean
}): GuardResult {
  const { actorId, target, op, otherQualifyingAdmins } = input
  const req2fa = input.requireAdminTwoFactor ?? true
  if (target.id === actorId) return { ok: false, error: tUsers.errors.self }
  if (LOSES_ADMIN.has(op) && isQualifyingAdmin(target, req2fa) && otherQualifyingAdmins < 1) {
    return { ok: false, error: tUsers.errors.lastAdmin }
  }
  return { ok: true }
}

/** Which op a role change is. */
export function roleChangeOp(from: string | null, to: "admin" | "staff"): UserOp | null {
  if (from === to) return null
  return to === "staff" ? "demote" : "promote"
}

// ---------------------------------------------------------------------------
// Better Auth admin endpoints - enforced in hooks.ts.
// Over HTTP (/api/auth/admin/*) EVERY admin endpoint is rejected with 404: the app never uses the browser
// admin client, and those endpoints would bypass the users-service policy (re-auth, trusted-device purge,
// mustChangePassword, createdById, session_max_hours…). They are also listed in `disabledPaths`.
// Server-side `auth.api.*` calls from the users service still go through the checks below.
// ---------------------------------------------------------------------------

/** Every Better Auth admin plugin endpoint (1.7.7). All of them are in `disabledPaths` (HTTP → 404). */
export const ADMIN_ENDPOINT_PATHS = [
  "/admin/set-role",
  "/admin/get-user",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/list-users",
  "/admin/list-user-sessions",
  "/admin/unban-user",
  "/admin/ban-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
] as const

/** Endpoints the app never uses: rejected outright (impersonation is unaudited; update-user can set arbitrary fields). */
export const ADMIN_DISABLED_PATHS: ReadonlySet<string> = new Set([
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/update-user",
])

/** Admin endpoints that act on `body.userId` and may not target the caller. */
const NO_SELF_PATHS: ReadonlySet<string> = new Set(["/admin/set-role", "/admin/ban-user", "/admin/remove-user"])

/** Admin endpoints that change data (audited when called over HTTP). */
export const ADMIN_MUTATION_ACTIONS: Readonly<Record<string, string>> = {
  "/admin/create-user": "user.create",
  "/admin/set-role": "user.role.change",
  "/admin/ban-user": "user.ban",
  "/admin/unban-user": "user.unban",
  "/admin/remove-user": "user.delete",
  "/admin/set-user-password": "user.password.reset",
  "/admin/revoke-user-session": "user.sessions.revoke",
  "/admin/revoke-user-sessions": "user.sessions.revoke",
  "/admin/update-user": "user.update",
  "/admin/impersonate-user": "user.update",
  "/admin/stop-impersonating": "user.update",
}

/** Only exactly "admin" / "staff" (no arrays, no comma lists, no other casing). */
export function isValidRole(role: unknown): role is "admin" | "staff" {
  return role === "admin" || role === "staff"
}

export type AdminEndpointVerdict =
  | { ok: true }
  | { ok: false; status: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "NOT_FOUND"; code: string }

export interface AdminEndpointInput {
  path: string
  /** signed-in caller (null when no valid session) */
  caller: GuardUser | null
  /** the call carries a Request or headers (HTTP, or auth.api with headers) */
  hasRequestContext: boolean
  /** the call came in over HTTP (`ctx.request` present) - always rejected */
  viaHttp?: boolean
  /** headerless create-user explicitly marked trusted by server code (/setup, dev seed) */
  trustedServerCall?: boolean
  /** number of users (only needed for a headerless create-user without the trusted flag) */
  userCount?: number
  body?: Record<string, unknown> | null
  /** user referenced by body.userId (loaded by the hook), if any */
  target?: GuardUser | null
  /** qualifying admins excluding the target */
  otherQualifyingAdmins?: number
  /** 2FA policy for admins (require_2fa_admin); default true = strictest */
  requireAdminTwoFactor?: boolean
}

/** Decide whether a Better Auth admin endpoint call may proceed. Pure - the hook loads the inputs. */
export function checkAdminEndpoint(input: AdminEndpointInput): AdminEndpointVerdict {
  const { path, caller, hasRequestContext, body, target } = input
  if (input.viaHttp) return { ok: false, status: "NOT_FOUND", code: "NOT_FOUND" }
  if (ADMIN_DISABLED_PATHS.has(path)) return { ok: false, status: "FORBIDDEN", code: "ADMIN_ENDPOINT_DISABLED" }

  if (path === "/admin/create-user") {
    if (body?.role !== undefined && !isValidRole(body.role)) return { ok: false, status: "BAD_REQUEST", code: "INVALID_ROLE" }
    // `data` can set banned/role/arbitrary fields - the app never passes it.
    if (body?.data !== undefined && body.data !== null && Object.keys(body.data as object).length > 0)
      return { ok: false, status: "BAD_REQUEST", code: "FIELD_NOT_ALLOWED" }
    // Server-side call without any request context (no session to check): only when server code marked it
    // trusted (/setup under its advisory lock, dev seed) or while the user table is still empty.
    if (!caller && !hasRequestContext) {
      if (input.trustedServerCall || input.userCount === 0) return { ok: true }
      return { ok: false, status: "UNAUTHORIZED", code: "UNAUTHORIZED" }
    }
  }

  const req2fa = input.requireAdminTwoFactor ?? true
  if (!caller) return { ok: false, status: "UNAUTHORIZED", code: "UNAUTHORIZED" }
  if (!isQualifyingAdmin(caller, req2fa)) return { ok: false, status: "FORBIDDEN", code: "FORBIDDEN" }

  if (path === "/admin/set-role" && !isValidRole(body?.role)) return { ok: false, status: "BAD_REQUEST", code: "INVALID_ROLE" }

  const targetId = typeof body?.userId === "string" ? body.userId : null
  if (NO_SELF_PATHS.has(path) && targetId === caller.id) return { ok: false, status: "FORBIDDEN", code: "SELF_ACTION" }

  const losesAdmin =
    path === "/admin/ban-user" ||
    path === "/admin/remove-user" ||
    (path === "/admin/set-role" && body?.role !== "admin")
  if (losesAdmin && target && isQualifyingAdmin(target, req2fa) && (input.otherQualifyingAdmins ?? 0) < 1) {
    return { ok: false, status: "FORBIDDEN", code: "LAST_ADMIN" }
  }
  return { ok: true }
}

/**
 * Constant-time comparison of the /setup token. Hashing both sides first gives equal-length buffers
 * (timingSafeEqual requires it) and hides the expected length. Empty/missing expected → always false.
 */
export function verifySetupToken(provided: string | null | undefined, expected: string | null | undefined): boolean {
  // too short to be safe (env.ts refuses it too) → /setup stays closed
  if (!expected || expected.trim().length < SETUP_TOKEN_MIN_LENGTH) return false
  if (typeof provided !== "string" || provided.length === 0) return false
  const a = createHash("sha256").update(provided.trim(), "utf8").digest()
  const b = createHash("sha256").update(expected.trim(), "utf8").digest()
  return timingSafeEqual(a, b)
}
