// Session helpers for pages, layouts, server actions and route handlers.
// Layouts are NOT a security boundary: call requireUser()/requireAdmin() again in every action.
import "server-only"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { cache } from "react"
import { getAuth } from "./auth"
import { readTwoFactorPolicy, twoFactorRequiredFor } from "./two-factor-policy"

export type AppRole = "admin" | "staff"

export interface AppUser {
  id: string
  email: string
  name: string
  role: AppRole
  image?: string | null
  twoFactorEnabled: boolean
  mustChangePassword: boolean
  banned: boolean
}

export interface AppSession {
  user: AppUser
  sessionId: string
  /** epoch ms when this session was created (sign-in) - "fresh session" checks */
  sessionCreatedAt?: number
}

function toAppUser(u: Record<string, unknown>): AppUser {
  return {
    id: String(u.id),
    email: String(u.email),
    name: String(u.name ?? ""),
    role: u.role === "admin" ? "admin" : "staff",
    image: (u.image as string | null | undefined) ?? null,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
    mustChangePassword: Boolean(u.mustChangePassword),
    banned: Boolean(u.banned),
  }
}

/** Current session or null (cached per request). */
export const getSession = cache(async (): Promise<AppSession | null> => {
  // Read request headers BEFORE touching the DB: this opts the route into dynamic rendering, so
  // `next build` never tries to prerender auth-gated pages (no DATABASE_URL at build time).
  const h = await headers()
  const s = await getAuth().api.getSession({ headers: h })
  if (!s?.user) return null
  const user = toAppUser(s.user as unknown as Record<string, unknown>)
  if (user.banned) return null
  const sessionId = String(s.session.id)
  // Absolute lifetime cap from the `session_max_hours` setting (Better Auth's expiresIn is static: 12 h
  // sliding). A session older than the cap is treated as signed out and its row is deleted.
  const createdAt = new Date(s.session.createdAt as unknown as string | Date).getTime()
  if (Number.isFinite(createdAt) && Date.now() - createdAt > (await sessionMaxHours()) * 3_600_000) {
    await revokeSessionRow(sessionId)
    return null
  }
  return { user, sessionId, sessionCreatedAt: Number.isFinite(createdAt) ? createdAt : undefined }
})

async function sessionMaxHours(): Promise<number> {
  try {
    const { getSetting } = await import("@/server/services/settings")
    const h = Number(await getSetting("session_max_hours"))
    return Number.isFinite(h) && h >= 1 ? h : 12
  } catch {
    return 12 // = Better Auth's own expiresIn
  }
}

async function revokeSessionRow(id: string): Promise<void> {
  try {
    const [{ db }, { session }, { eq }] = await Promise.all([
      import("@/server/db/client"),
      import("@/server/db/schema"),
      import("drizzle-orm"),
    ])
    await db.delete(session).where(eq(session.id, id))
  } catch {
    /* best effort: the session is rejected either way */
  }
}

export interface RequireUserOptions {
  /** restrict to admins (non-admin → 404 to avoid leaking admin pages) */
  role?: "admin"
  /** allow access while a forced step is pending (the 2FA-setup / change-password pages themselves) */
  allowPendingSetup?: boolean
}

export const ROUTES = {
  login: "/login",
  enable2fa: "/security/enable-2fa",
  changePassword: "/security/change-password",
} as const

/**
 * Pages/layouts: redirect when not signed in, when a forced step is pending
 * (must change password, 2FA required by policy), and 404 for admin-only pages.
 * Server actions should use requireUserForAction() instead (no redirects).
 */
export async function requireUser(
  opts: RequireUserOptions = {}
): Promise<AppSession> {
  const s = await getSession()
  if (!s) redirect(ROUTES.login)
  if (!opts.allowPendingSetup) {
    if (s.user.mustChangePassword) redirect(ROUTES.changePassword)
    if (
      !s.user.twoFactorEnabled &&
      twoFactorRequiredFor(s.user.role, await readTwoFactorPolicy())
    ) {
      redirect(ROUTES.enable2fa)
    }
  }
  if (opts.role === "admin" && s.user.role !== "admin") notFound()
  return s
}

export async function requireAdmin(): Promise<AppSession> {
  return requireUser({ role: "admin" })
}

export class AuthorizationError extends Error {
  constructor(message = "Bạn không có quyền thực hiện thao tác này.") {
    super(message)
    this.name = "AuthorizationError"
  }
}

/** Server actions / route handlers: throws AuthorizationError instead of redirecting. */
export async function requireUserForAction(
  opts: { role?: "admin"; allowPendingSetup?: boolean } = {}
): Promise<AppSession> {
  const s = await getSession()
  if (!s)
    throw new AuthorizationError(
      "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
    )
  if (!opts.allowPendingSetup) {
    if (s.user.mustChangePassword)
      throw new AuthorizationError("Bạn cần đổi mật khẩu trước khi tiếp tục.")
    if (
      !s.user.twoFactorEnabled &&
      twoFactorRequiredFor(s.user.role, await readTwoFactorPolicy())
    ) {
      throw new AuthorizationError(
        "Hệ thống yêu cầu bật xác thực 2 bước trước khi tiếp tục."
      )
    }
  }
  if (opts.role === "admin" && s.user.role !== "admin")
    throw new AuthorizationError()
  return s
}

export function isAdmin(user: Pick<AppUser, "role">): boolean {
  return user.role === "admin"
}

/** Staff may only touch their own resources; admins may touch everything. */
export function canAccessOwned(
  user: Pick<AppUser, "id" | "role">,
  ownerId: string
): boolean {
  return user.role === "admin" || user.id === ownerId
}

export function assertCanAccessOwned(
  user: Pick<AppUser, "id" | "role">,
  ownerId: string
): void {
  if (!canAccessOwned(user, ownerId)) throw new AuthorizationError()
}
