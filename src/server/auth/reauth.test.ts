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

import { and, eq, inArray } from "drizzle-orm"

import { db } from "@/server/db/client"
import { activityLogs, twoFactor, user } from "@/server/db/schema"
import { resetUserTwoFactor } from "@/server/services/users"

import { isReauthFresh, REAUTH_MAX_FAILURES, ReauthError, recentReauthFailures, requireReauth, withReauth } from "./reauth"
import type { AppSession } from "./session"

const hasDb = !!process.env.DATABASE_URL
const P = `treauth_${randomUUID().slice(0, 8)}`
const actor = { id: `${P}_a`, email: `${P}_a@example.test`, role: "admin" }
const other = { id: `${P}_b`, email: `${P}_b@example.test`, role: "staff" }
const admin2 = { id: `${P}_c`, email: `${P}_c@example.test`, role: "admin" }
const bad = async () => "bad_password" as const
const okV = async () => "ok" as const

function session(u: typeof actor): AppSession {
  return {
    sessionId: `${P}_session_${u.id}`,
    user: { id: u.id, email: u.email, name: P, role: u.role as "admin", twoFactorEnabled: true, mustChangePassword: false, banned: false },
  }
}

describe.skipIf(!hasDb)("re-auth gate (DB)", () => {
  beforeAll(async () => {
    await db.insert(user).values(
      [actor, other, admin2].map((u) => ({
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
    const ids = [actor.id, other.id, admin2.id]
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

  it("resetting ANOTHER ADMIN's 2FA requires re-auth; a staff target does not", async () => {
    const s = session(actor)
    await expect(resetUserTwoFactor(s, { userId: admin2.id })).rejects.toBeInstanceOf(ReauthError)
    await expect(resetUserTwoFactor(s, { userId: admin2.id })).rejects.toMatchObject({ code: "reauth_required" })
    await expect(resetUserTwoFactor(s, { userId: admin2.id }, bad)).rejects.toMatchObject({ code: "reauth_failed" })
    let [row] = await db.select().from(user).where(eq(user.id, admin2.id))
    expect(row!.twoFactorEnabled).toBe(true)

    // the actor must itself be a qualifying admin (2FA on) for user management; admin2 stays → not last admin
    await resetUserTwoFactor(s, { userId: admin2.id }, okV)
    ;[row] = await db.select().from(user).where(eq(user.id, admin2.id))
    expect(row!.twoFactorEnabled).toBe(false)

    // staff target: no re-auth needed
    await resetUserTwoFactor(s, { userId: other.id })
    ;[row] = await db.select().from(user).where(eq(user.id, other.id))
    expect(row!.twoFactorEnabled).toBe(false)
  })
})
