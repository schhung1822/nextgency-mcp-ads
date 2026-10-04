// Better Auth hooks for the auth feature. No `next/*` / "server-only" imports: this module is also
// loaded by the Better Auth CLI (auth-cli.ts) and must stay framework-free.
//
// - `authHooks.before` (options.hooks): HTTP allowlist (only what the browser needs; everything else 404);
//   password-step lockout (lockout.ts - per email+IP always, plus an account-wide threshold for accounts without
//   2FA that never refuses an IP that signed in recently); reject EVERY Better Auth admin endpoint called over HTTP (404 -
//   they are also in `disabledPaths`) and guard server-side admin calls with the app rules (admin + 2FA caller,
//   no self-action, last-admin protection, impersonation/update-user disabled, headerless create-user only
//   when trusted);
//   block admins (and staff when 2FA is required for everyone, fail-closed) from disabling 2FA; block
//   banned users on session-bound auth endpoints; never let admins "trust this device".
// - `auditPlugin()` (after hooks): activity_logs for sign-in success/failure, 2FA enable/disable/backup
//   regeneration, password change and HTTP sign-out. It is a plugin (not options.hooks.after) because user
//   after-hooks run BEFORE plugin after-hooks - we need to see the final result of the twoFactor plugin
//   (2FA challenge vs. real session). It must be registered after twoFactor() and before nextCookies().
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api"
import { and, count, eq, isNull, ne, or } from "drizzle-orm"
import type { ActivityAction } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { db } from "@/server/db/client"
import { user as userTable } from "@/server/db/schema"
import { insertActivity, requestMetaFromHeaders, type CoreActivityEntry } from "./activity-core"
import { ADMIN_MUTATION_ACTIONS, checkAdminEndpoint, type GuardUser } from "./guards"
import { readTwoFactorPolicy, twoFactorRequiredFor } from "./two-factor-policy"
import {
  clearLoginFailures,
  isKnownLoginIp,
  isLocked,
  isSignInLocked,
  normalizeEmail,
  readIpLockout,
  readLockout,
  recordLoginFailure,
} from "./lockout"
import { currentUserCreateContext, isTrustedHeaderlessCreate } from "./user-create-context"

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

interface SessionUserLike {
  id: string
  email: string
  role?: string | null
  banned?: boolean | null
  twoFactorEnabled?: boolean | null
}

const SIGN_IN = "/sign-in/email"
const VERIFY_TOTP = "/two-factor/verify-totp"
const VERIFY_BACKUP = "/two-factor/verify-backup-code"
const DISABLE_2FA = "/two-factor/disable"
const GENERATE_BACKUP = "/two-factor/generate-backup-codes"
const CHANGE_PASSWORD = "/change-password"
const SIGN_OUT = "/sign-out"

/**
 * The ONLY Better Auth endpoints reachable over HTTP (`/api/auth/*`) - exactly what the browser uses
 * (sign-in, 2FA verification during sign-in / enrolment, sign-out, session probe). Everything else answers 404:
 * those endpoints (change-password, update-user, revoke-*, list-sessions, two-factor/enable|disable|…) have
 * server-action equivalents that carry the app policy - shared re-auth failure budget, activity_logs,
 * mustChangePassword, 2FA policy - which a direct HTTP call would bypass. Server-side `auth.api.*` calls
 * (no Request) are unaffected.
 */
export const HTTP_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  SIGN_IN,
  SIGN_OUT,
  VERIFY_TOTP,
  VERIFY_BACKUP,
  "/get-session",
  "/ok",
])

/** Session-bound endpoints where a (somehow still valid) session of a banned user must be refused. */
const BAN_CHECKED_PREFIXES = ["/two-factor/enable", GENERATE_BACKUP, DISABLE_2FA, CHANGE_PASSWORD, "/update-user", "/revoke-", "/list-sessions"]

export const LOCKED_ERROR = { code: "ACCOUNT_LOCKED", message: "Account temporarily locked after too many failed sign-ins" }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function meta(ctx: HookCtx) {
  return requestMetaFromHeaders(ctx.headers ?? ctx.request?.headers ?? null)
}

function actorFromUser(u: SessionUserLike | null | undefined, fallbackEmail?: string | null) {
  return { id: u?.id ?? null, email: u?.email ?? fallbackEmail ?? null, role: (u?.role as string | null | undefined) ?? null }
}

async function audit(ctx: HookCtx, entry: Omit<CoreActivityEntry, "ip" | "userAgent">) {
  const m = meta(ctx)
  try {
    await insertActivity({ ...entry, ip: m.ip, userAgent: m.userAgent })
  } catch (e) {
    // Never break sign-in because the log insert failed; surface it to server logs (no secrets in entry).
    console.error("[auth] activity log insert failed:", entry.action, safeErrorForLog(e))
  }
}

function errorCode(returned: unknown): string | null {
  if (!isAPIError(returned)) return null
  const body = (returned as { body?: { code?: unknown } }).body
  return typeof body?.code === "string" ? body.code : String((returned as { status?: unknown }).status ?? "ERROR")
}

/** User behind the pending 2FA challenge cookie (sign-in mode), or null. */
async function pendingTwoFactorUser(ctx: HookCtx): Promise<SessionUserLike | null> {
  try {
    const cookie = ctx.context.createAuthCookie("two_factor")
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
    if (!identifier) return null
    const v = await ctx.context.internalAdapter.findVerificationValue(identifier)
    if (!v?.value) return null
    return (await ctx.context.internalAdapter.findUserById(v.value)) as SessionUserLike | null
  } catch {
    return null
  }
}

/** Qualifying admins (role admin, not banned, 2FA on when the policy requires it) other than `excludeUserId`. */
async function countOtherQualifyingAdmins(excludeUserId: string, requireTwoFactor: boolean): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(userTable)
    .where(
      and(
        eq(userTable.role, "admin"),
        requireTwoFactor ? eq(userTable.twoFactorEnabled, true) : undefined,
        or(isNull(userTable.banned), eq(userTable.banned, false)),
        ne(userTable.id, excludeUserId)
      )
    )
  return Number(row?.n ?? 0)
}

function toGuardUser(u: SessionUserLike | null | undefined): GuardUser | null {
  if (!u) return null
  return { id: u.id, role: u.role ?? null, banned: u.banned ?? null, twoFactorEnabled: u.twoFactorEnabled ?? null }
}

const TARGETED_ADMIN_PATHS = new Set(["/admin/set-role", "/admin/ban-user", "/admin/remove-user"])

async function countAllUsers(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(userTable)
  return Number(row?.n ?? 0)
}

/**
 * Guard Better Auth's own admin endpoints.
 * - Over HTTP (`ctx.request` present): ALWAYS 404 (M1). They are also in `disabledPaths`, so the router
 *   normally answers 404 before this hook; this is the second layer (path variants, future routing changes).
 *   Mutation attempts are written to activity_logs.
 * - Server-side `auth.api.*` (users service, with the request headers): caller must be an admin with 2FA,
 *   no self role-change/ban/removal, ≥1 qualifying admin must remain, impersonation/update-user disabled;
 *   a headerless create-user is accepted only when marked trusted (/setup, dev seed) or the DB is empty.
 */
/** `_flag: "router"` is set by Better Auth's HTTP router; `request` by HTTP or auth.api({ request }). */
function isHttpCall(ctx: HookCtx): boolean {
  return !!ctx.request || (ctx as { _flag?: unknown })._flag === "router"
}

async function guardAdminEndpoint(ctx: HookCtx) {
  const path = ctx.path
  const body = (ctx.body && typeof ctx.body === "object" ? ctx.body : null) as Record<string, unknown> | null
  const targetId = typeof body?.userId === "string" ? body.userId : null
  // `_flag: "router"` is set by Better Auth's HTTP router; `request` by HTTP or auth.api({ request }).
  const viaHttp = isHttpCall(ctx)
  if (viaHttp) {
    const action = ADMIN_MUTATION_ACTIONS[path]
    if (action) {
      await audit(ctx, {
        actor: actorFromUser(await currentSessionUser(ctx)),
        action: action as ActivityAction,
        status: "failure",
        target: { type: "user", id: targetId, label: null },
        metadata: { endpoint: path, reason: "HTTP_DISABLED", via: "http" },
      })
    }
    throw new APIError("NOT_FOUND", { code: "NOT_FOUND", message: "Not Found" })
  }
  const hasRequestContext = !!ctx.headers
  const caller = hasRequestContext ? await currentSessionUser(ctx) : null
  let target: SessionUserLike | null = null
  let others: number | undefined
  const policy = await readTwoFactorPolicy()
  if (targetId && TARGETED_ADMIN_PATHS.has(path)) {
    target = (await ctx.context.internalAdapter.findUserById(targetId).catch(() => null)) as SessionUserLike | null
    if (target) others = await countOtherQualifyingAdmins(target.id, policy.admin)
  }
  let trustedServerCall = false
  let userCount: number | undefined
  if (path === "/admin/create-user" && !caller && !hasRequestContext) {
    trustedServerCall = isTrustedHeaderlessCreate(currentUserCreateContext())
    if (!trustedServerCall) userCount = await countAllUsers().catch(() => undefined)
  }
  const verdict = checkAdminEndpoint({
    path,
    caller: toGuardUser(caller),
    hasRequestContext,
    viaHttp: false,
    trustedServerCall,
    userCount,
    body,
    target: toGuardUser(target),
    otherQualifyingAdmins: others,
    requireAdminTwoFactor: policy.admin,
  })
  if (verdict.ok) return
  throw new APIError(verdict.status, { code: verdict.code, message: "Admin endpoint rejected by app policy" })
}

async function currentSessionUser(ctx: HookCtx): Promise<SessionUserLike | null> {
  const s = await getSessionFromCtx(ctx).catch(() => null)
  return (s?.user as SessionUserLike | undefined) ?? null
}

// ---------------------------------------------------------------------------
// before
// ---------------------------------------------------------------------------

export const authHooks: BetterAuthOptions["hooks"] = {
  before: createAuthMiddleware(async (ctx) => {
    const path = ctx.path

    // HTTP allowlist (see HTTP_ALLOWED_PATHS). Admin endpoints are handled (and audited) by guardAdminEndpoint.
    if (!path.startsWith("/admin/") && isHttpCall(ctx) && !HTTP_ALLOWED_PATHS.has(path)) {
      throw new APIError("NOT_FOUND", { code: "NOT_FOUND", message: "Not Found" })
    }

    if (path === SIGN_IN) {
      const email = normalizeEmail(ctx.body?.email)
      if (email) {
        const ip = meta(ctx).ip
        const [emailState, ipState] = await Promise.all([
          readLockout(email).catch(() => null),
          readIpLockout(email, ip).catch(() => null),
        ])
        if (!emailState && !ipState) return
        const found = await ctx.context.internalAdapter.findUserByEmail(email).catch(() => null)
        const twoFactorEnabled = !!(found?.user as SessionUserLike | undefined)?.twoFactorEnabled
        const now = Date.now()
        // The account-wide lock never refuses a client IP that signed in as this user recently (an attacker cannot
        // lock the owner out of the app from elsewhere): only look it up when it would matter.
        const knownIp =
          !!found?.user &&
          !twoFactorEnabled &&
          isLocked(emailState, now) &&
          !isLocked(ipState, now) &&
          (await isKnownLoginIp(found.user.id, ip, now).catch(() => false))
        if (isSignInLocked({ emailState, ipState, twoFactorEnabled, knownIp, now })) {
          await audit(ctx, {
            actor: actorFromUser(found?.user as SessionUserLike | undefined, email),
            action: "auth.login.failure",
            status: "failure",
            target: { type: "user", id: found?.user.id ?? null, label: email },
            metadata: { email, reason: "ACCOUNT_LOCKED" },
          })
          throw new APIError("TOO_MANY_REQUESTS", LOCKED_ERROR)
        }
      }
      return
    }

    if (path.startsWith("/admin/")) {
      await guardAdminEndpoint(ctx)
      return
    }

    if (path === SIGN_OUT) {
      // Populate ctx.context.session so the after hook knows who signed out.
      await getSessionFromCtx(ctx).catch(() => null)
      return
    }

    if (path === DISABLE_2FA) {
      const u = await currentSessionUser(ctx)
      // 2FA is optional unless the policy (require_2fa_admin / require_2fa_all) makes it mandatory for this role.
      if (u && twoFactorRequiredFor(u.role, await readTwoFactorPolicy()))
        throw new APIError("FORBIDDEN", { code: "TWO_FACTOR_REQUIRED", message: "2FA is required by policy" })
    }

    if ((path === VERIFY_TOTP || path === VERIFY_BACKUP) && ctx.body?.trustDevice === true) {
      const u = (await currentSessionUser(ctx)) ?? (await pendingTwoFactorUser(ctx))
      if (!u || u.role === "admin") {
        // Admins never get a trusted device (UI hides the checkbox; enforce server-side too).
        return { context: { body: { ...ctx.body, trustDevice: false } } }
      }
    }

    if (BAN_CHECKED_PREFIXES.some((p) => path.startsWith(p))) {
      const u = await currentSessionUser(ctx)
      if (u?.banned) throw new APIError("FORBIDDEN", { code: "BANNED_USER", message: "User is banned" })
    }
  }),
}

// ---------------------------------------------------------------------------
// after (plugin so it runs after the twoFactor plugin's own after-hook)
// ---------------------------------------------------------------------------

const AUDITED = new Set([SIGN_IN, VERIFY_TOTP, VERIFY_BACKUP, DISABLE_2FA, GENERATE_BACKUP, CHANGE_PASSWORD, SIGN_OUT])

async function afterSignIn(ctx: HookCtx) {
  const email = normalizeEmail(ctx.body?.email)
  const returned = ctx.context.returned
  const code = errorCode(returned)
  if (code) {
    let lock: Awaited<ReturnType<typeof recordLoginFailure>> | null = null
    if (email && code === "INVALID_EMAIL_OR_PASSWORD") lock = await recordLoginFailure(email, meta(ctx).ip).catch(() => null)
    const found = email ? await ctx.context.internalAdapter.findUserByEmail(email).catch(() => null) : null
    const lockedUntil = lock?.ip.lockedUntil ?? lock?.email.lockedUntil ?? null
    await audit(ctx, {
      actor: actorFromUser(found?.user as SessionUserLike | undefined, email),
      action: "auth.login.failure",
      status: "failure",
      target: { type: "user", id: found?.user.id ?? null, label: email },
      metadata: { email, reason: code, ...(lockedUntil ? { lockedUntil: new Date(lockedUntil).toISOString() } : {}) },
    })
    return
  }
  // Password was correct → reset the per-email counter.
  if (email) await clearLoginFailures(email).catch(() => {})
  const newSession = ctx.context.newSession
  if (!newSession) return // 2FA challenge issued; success is logged after verification
  await audit(ctx, {
    actor: actorFromUser(newSession.user as unknown as SessionUserLike),
    action: "auth.login.success",
    target: { type: "user", id: newSession.user.id, label: newSession.user.email },
    metadata: { method: "password", ...(newSession.user.twoFactorEnabled ? { trustedDevice: true } : {}) },
  })
}

async function afterTwoFactorVerify(ctx: HookCtx) {
  const method = ctx.path === VERIFY_TOTP ? "totp" : "backup_code"
  // Set by verifyTwoFactor() → getSessionFromCtx(): a session means enrollment/step-up, null means sign-in.
  const prior = (ctx.context.session ?? null) as { session?: unknown; user: SessionUserLike } | null
  const code = errorCode(ctx.context.returned)
  if (prior?.session) {
    if (!code && method === "totp" && !prior.user.twoFactorEnabled) {
      await audit(ctx, {
        actor: actorFromUser(prior.user),
        action: "auth.2fa.enable",
        target: { type: "user", id: prior.user.id, label: prior.user.email },
      })
    }
    return
  }
  if (code) {
    const u = await pendingTwoFactorUser(ctx)
    await audit(ctx, {
      actor: actorFromUser(u),
      action: "auth.login.failure",
      status: "failure",
      target: { type: "user", id: u?.id ?? null, label: u?.email ?? null },
      metadata: { stage: "2fa", method, reason: code },
    })
    return
  }
  const ns = ctx.context.newSession
  if (!ns) return
  await audit(ctx, {
    actor: actorFromUser(ns.user as unknown as SessionUserLike),
    action: "auth.login.success",
    target: { type: "user", id: ns.user.id, label: ns.user.email },
    metadata: { method, trustDevice: ctx.body?.trustDevice === true },
  })
}

async function afterSessionAction(ctx: HookCtx) {
  const s = ctx.context.session as { user: SessionUserLike } | null
  const u = s?.user
  if (!u) return
  const code = errorCode(ctx.context.returned)
  const target = { type: "user", id: u.id, label: u.email }
  switch (ctx.path) {
    case DISABLE_2FA:
      if (!code) await audit(ctx, { actor: actorFromUser(u), action: "auth.2fa.disable", target })
      return
    case GENERATE_BACKUP:
      if (!code) await audit(ctx, { actor: actorFromUser(u), action: "auth.2fa.backup_codes.regenerate", target })
      return
    case CHANGE_PASSWORD:
      await audit(ctx, {
        actor: actorFromUser(u),
        action: "auth.password.change",
        target,
        status: code ? "failure" : "success",
        ...(code ? { metadata: { reason: code } } : {}),
      })
      return
    case SIGN_OUT:
      // auth.api.signOut() from signOutAction logs itself; only log real HTTP calls (authClient.signOut()).
      if (!code && ctx.request) await audit(ctx, { actor: actorFromUser(u), action: "auth.logout", target })
      return
  }
}

export function auditPlugin(): BetterAuthPlugin {
  return {
    id: "ads-mcp-audit",
    hooks: {
      after: [
        {
          matcher: (c) => AUDITED.has(c.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            try {
              if (ctx.path === SIGN_IN) await afterSignIn(ctx)
              else if (ctx.path === VERIFY_TOTP || ctx.path === VERIFY_BACKUP) await afterTwoFactorVerify(ctx)
              else await afterSessionAction(ctx)
            } catch (e) {
              console.error("[auth] audit hook failed:", ctx.path, safeErrorForLog(e))
            }
          }),
        },
      ],
    },
  }
}
