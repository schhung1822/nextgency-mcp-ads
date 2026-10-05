// Shared re-auth gate (DB): failure budget shared across actions, logging, freshness, and its use by the
// users service for admin targets. Skipped when DATABASE_URL is absent.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) → DB tests are skipped */
  }
})
vi.mock("server-only", () => ({}))
// services read the request headers (Better Auth admin calls); no Next request scope in this test
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

import { and, eq, inArray } from "drizzle-orm"

import { db } from "@/server/db/client"
import { activityLogs, twoFactor, user } from "@/server/db/schema"
import { deleteUserByAdmin, resetUserPassword, resetUserTwoFactor, revokeUserSessionsByAdmin, setUserBanned } from "@/server/services/users"

import {
  isReauthFresh,
  isSessionFresh,
  REAUTH_MAX_FAILURES,
  ReauthError,
  recentReauthFailures,
  requireReauth,
  sessionFreshUntil,
  withReauth,
} from "./reauth"
import type { AppSession } from "./session"

const hasDb = !!process.env.DATABASE_URL
const P = `treauth_${randomUUID().slice(0, 8)}`
const actor = { id: `${P}_a`, email: `${P}_a@example.test`, role: "admin" }
const other = { id: `${P}_b`, email: `${P}_b@example.test`, role: "staff" }
const admin2 = { id: `${P}_c`, email: `${P}_c@example.test`, role: "admin" }
const admin3 = { id: `${P}_d`, email: `${P}_d@example.test`, role: "admin" }
const staff2 = { id: `${P}_e`, email: `${P}_e@example.test`, role: "staff" }
const bad = async () => "bad_password" as const
const okV = async () => "ok" as const

function session(u: typeof actor, sessionId = `${P}_session_${u.id}`): AppSession {
  return {
    sessionId,
    user: { id: u.id, email: u.email, name: P, role: u.role as "admin", twoFactorEnabled: true, mustChangePassword: false, banned: false },
  }
}

describe.skipIf(!hasDb)("re-auth gate (DB)", () => {
  beforeAll(async () => {
    await db.insert(user).values(
      [actor, other, admin2, admin3, staff2].map((u) => ({
        id: u.id,
        name: P,
        email: u.email,
        emailVerified: true,
        role: u.role,
        twoFactorEnabled: true,
        banned: false,
      }))
    )
  })

  afterAll(async () => {
    if (!hasDb) return
    const ids = [actor.id, other.id, admin2.id, admin3.id, staff2.id]
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, ids))
    await db.delete(twoFactor).where(inArray(twoFactor.userId, ids))
    await db.delete(user).where(inArray(user.id, ids))
  })

  it("logs failures under the protected action with metadata.reauth and shares one budget across actions", async () => {
    await expect(requireReauth(other, { action: "user.create" }, bad)).rejects.toMatchObject({ code: "reauth_failed" })
    await expect(requireReauth(other, { action: "logs.export" }, bad)).rejects.toMatchObject({ code: "reauth_failed" })
    // code_required is not a failure
    await expect(requireReauth(other, { action: "logs.export" }, async () => "code_required")).rejects.toMatchObject({
      code: "reauth_code_required",
      fieldErrors: { code: expect.any(String) },
    })
    for (let i = 2; i < REAUTH_MAX_FAILURES; i++) {
      await expect(requireReauth(other, { action: "connection.update" }, async () => "bad_code")).rejects.toMatchObject({
        code: "reauth_failed",
      })
    }
    expect(await recentReauthFailures(db, other.id)).toBe(REAUTH_MAX_FAILURES)
    const never = vi.fn(okV)
    await expect(requireReauth(other, { action: "auth.password.change" }, never)).rejects.toMatchObject({ code: "reauth_locked" })
    expect(never).not.toHaveBeenCalled()

    const rows = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.actorId, other.id), eq(activityLogs.status, "failure")))
    expect(rows.map((r) => r.action).sort()).toEqual(
      ["connection.update", "connection.update", "connection.update", "logs.export", "user.create"].sort()
    )
    expect(rows.every((r) => (r.metadata as { reauth?: boolean }).reauth === true)).toBe(true)
  })

  it("success runs onSuccess in the same transaction and marks the session fresh", async () => {
    const sid = `${P}_fresh`
    expect(await isReauthFresh(sid)).toBe(false)
    const v = await withReauth(actor, { action: "logs.export" }, okV, async () => 42, { sessionId: sid })
    expect(v).toBe(42)
    expect(await isReauthFresh(sid)).toBe(true)
    expect(await isReauthFresh(`${sid}_other`)).toBe(false)
  })

  it("fresh session: signed in ≤ 10 min ago or re-authenticated ≤ 10 min ago", async () => {
    const sid = `${P}_freshness`
    expect(await isSessionFresh({ sessionId: sid })).toBe(false)
    expect(await sessionFreshUntil({ sessionId: sid })).toBeNull()
    const signedIn = Date.now() - 60_000
    expect(await isSessionFresh({ sessionId: sid, sessionCreatedAt: signedIn })).toBe(true)
    expect(await sessionFreshUntil({ sessionId: sid, sessionCreatedAt: signedIn })).toBe(signedIn + 10 * 60_000)
    const old = Date.now() - 11 * 60_000
    expect(await isSessionFresh({ sessionId: sid, sessionCreatedAt: old })).toBe(false)
    await requireReauth(actor, { action: "logs.export" }, okV, { sessionId: sid })
    expect(await isSessionFresh({ sessionId: sid, sessionCreatedAt: old })).toBe(true)
    const until = (await sessionFreshUntil({ sessionId: sid, sessionCreatedAt: old }))!
    expect(until).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  })

  it("resetting ANOTHER ADMIN's 2FA requires re-auth; a staff target only when the session is not fresh", async () => {
    const s = session(actor)
    await expect(resetUserTwoFactor(s, { userId: admin2.id })).rejects.toBeInstanceOf(ReauthError)
    await expect(resetUserTwoFactor(s, { userId: admin2.id })).rejects.toMatchObject({
      code: "reauth_required",
      fieldErrors: { _reauth: "required" },
    })
    await expect(resetUserTwoFactor(s, { userId: admin2.id }, bad)).rejects.toMatchObject({ code: "reauth_failed" })
    let [row] = await db.select().from(user).where(eq(user.id, admin2.id))
    expect(row!.twoFactorEnabled).toBe(true)

    // the actor must itself be a qualifying admin (2FA on) for user management; admin2 stays → not last admin
    await resetUserTwoFactor(s, { userId: admin2.id }, okV)
    ;[row] = await db.select().from(user).where(eq(user.id, admin2.id))
    expect(row!.twoFactorEnabled).toBe(false)

    // staff target: the successful re-auth above marked this session fresh → no password needed now
    await resetUserTwoFactor(s, { userId: other.id })
    ;[row] = await db.select().from(user).where(eq(user.id, other.id))
    expect(row!.twoFactorEnabled).toBe(false)
  })

  it("staff target, session NOT fresh: reset 2FA / password need re-auth; a recent sign-in or re-auth is enough", async () => {
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, staff2.id))
    const stale = session(actor, `${P}_stale`) // no sessionCreatedAt, never re-authenticated
    await expect(resetUserTwoFactor(stale, { userId: staff2.id })).rejects.toMatchObject({
      code: "reauth_required",
      fieldErrors: { _reauth: "required" },
    })
    await expect(resetUserPassword(stale, { userId: staff2.id, password: "Mat-Khau-Tam-9" })).rejects.toMatchObject({
      code: "reauth_required",
    })
    await expect(resetUserTwoFactor(stale, { userId: staff2.id }, bad)).rejects.toMatchObject({ code: "reauth_failed" })
    expect((await db.select().from(user).where(eq(user.id, staff2.id)))[0]!.twoFactorEnabled).toBe(true)

    // signed in 2 minutes ago → fresh
    const recent = { ...session(actor, `${P}_recent`), sessionCreatedAt: Date.now() - 2 * 60_000 }
    await resetUserTwoFactor(recent, { userId: staff2.id })
    expect((await db.select().from(user).where(eq(user.id, staff2.id)))[0]!.twoFactorEnabled).toBe(false)

    // a real re-auth on the stale session marks it fresh for the next operations
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, staff2.id))
    await resetUserTwoFactor(stale, { userId: staff2.id }, okV)
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, staff2.id))
    await resetUserTwoFactor(stale, { userId: staff2.id })
    expect((await db.select().from(user).where(eq(user.id, staff2.id)))[0]!.twoFactorEnabled).toBe(false)
  })

  it("ban / unban / delete an ADMIN: always re-auth (a fresh session is not enough); revoke an admin's sessions: fresh is enough", async () => {
    const fresh = { ...session(actor, `${P}_fresh_admin_ops`), sessionCreatedAt: Date.now() }
    await expect(setUserBanned(fresh, { userId: admin3.id, banned: true })).rejects.toMatchObject({
      code: "reauth_required",
      fieldErrors: { _reauth: "required" },
    })
    await expect(deleteUserByAdmin(fresh, { userId: admin3.id })).rejects.toMatchObject({ code: "reauth_required" })
    await expect(setUserBanned(fresh, { userId: admin3.id, banned: true }, bad)).rejects.toMatchObject({ code: "reauth_failed" })
    expect((await db.select().from(user).where(eq(user.id, admin3.id)))[0]!.banned).toBe(false)

    // revoking sessions of an admin: fresh session OK, stale session → re-auth
    await expect(revokeUserSessionsByAdmin(fresh, { userId: admin3.id })).resolves.toBe(0)
    const stale = session(actor, `${P}_stale_revoke`)
    await expect(revokeUserSessionsByAdmin(stale, { userId: admin3.id })).rejects.toMatchObject({ code: "reauth_required" })
    await expect(revokeUserSessionsByAdmin(stale, { userId: admin3.id }, okV)).resolves.toBe(0)
  })
})
