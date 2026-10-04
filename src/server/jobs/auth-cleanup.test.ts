// auth.cleanup against a private database: expired verification / session / rate_limit rows go, live ones stay.
import { afterAll, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("../__tests__/people/temp-db")
  const t = await createTempDb("authclean")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))

import { eq, like } from "drizzle-orm"

import { db, pool } from "@/server/db/client"
import { rateLimit, session, user, verification } from "@/server/db/schema"

import { authCleanupJob, AUTH_GRACE_HOURS, RATE_LIMIT_IDLE_MINUTES, runAuthCleanup } from "./auth-cleanup"
import { JOBS } from "./index"

const hasDb = !!tmp
const NOW = new Date("2026-10-03T00:00:00.000Z")
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)

describe.skipIf(!hasDb)("auth.cleanup (DB)", () => {
  afterAll(async () => {
    await pool().end()
    ;(globalThis as Record<string, unknown>).__adsMcpPool = undefined
    ;(globalThis as Record<string, unknown>).__adsMcpDb = undefined
    await tmp?.drop()
  }, 60_000) // DROP DATABASE ... WITH (FORCE) can exceed the 10 s default while the whole suite loads the server

  it("xoá hàng đã hết hạn quá thời gian ân hạn, giữ hàng còn hạn và hàng mới hết hạn", async () => {
    await db.insert(user).values({ id: "u1", name: "U", email: "u1@example.test" })
    await db.insert(verification).values([
      { id: "lockout:old", identifier: "lockout:old", value: "{}", expiresAt: ago(AUTH_GRACE_HOURS + 1) },
      { id: "quota:old", identifier: "quota:old", value: "{}", expiresAt: ago(24 * 20) },
      { id: "recent-expired", identifier: "recent-expired", value: "{}", expiresAt: ago(AUTH_GRACE_HOURS - 1) },
      { id: "live", identifier: "live", value: "{}", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    ])
    await db.insert(session).values([
      { id: "s-old", token: "t-old", userId: "u1", expiresAt: ago(AUTH_GRACE_HOURS + 5), updatedAt: ago(100) },
      { id: "s-live", token: "t-live", userId: "u1", expiresAt: new Date(NOW.getTime() + 3_600_000), updatedAt: NOW },
    ])
    await db.insert(rateLimit).values([
      { id: "r-old", key: "10.0.0.1|/sign-in/email", count: 3, lastRequest: NOW.getTime() - (RATE_LIMIT_IDLE_MINUTES + 5) * 60_000 },
      { id: "r-new", key: "10.0.0.2|/sign-in/email", count: 1, lastRequest: NOW.getTime() - 30_000 },
    ])

    const r = await runAuthCleanup(NOW)
    expect(r).toEqual({ verification: 2, sessions: 1, rateLimit: 1 })
    expect((await db.select().from(verification)).map((v) => v.id).sort()).toEqual(["live", "recent-expired"])
    expect((await db.select().from(session)).map((s) => s.id)).toEqual(["s-live"])
    expect((await db.select().from(rateLimit)).map((x) => x.id)).toEqual(["r-new"])
    // idempotent
    expect(await runAuthCleanup(NOW)).toEqual({ verification: 0, sessions: 0, rateLimit: 0 })
    await db.delete(user).where(eq(user.id, "u1"))
    await db.delete(verification).where(like(verification.id, "%"))
  })

  it("xoá theo lô: một đống hàng cũ lớn hơn kích thước lô vẫn được dọn hết", async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      id: `bulk-${i}`,
      identifier: `bulk-${i}`,
      value: "{}",
      expiresAt: ago(AUTH_GRACE_HOURS + 2),
    }))
    for (let i = 0; i < rows.length; i += 2000) await db.insert(verification).values(rows.slice(i, i + 2000))
    const r = await runAuthCleanup(NOW)
    expect(r.verification).toBe(12_000)
    expect(await db.select().from(verification)).toHaveLength(0)
  })

  it("đã đăng ký trong JOBS, chạy hằng ngày, tên hợp lệ", () => {
    expect(JOBS).toContain(authCleanupJob)
    expect(authCleanupJob.name).toBe("auth.cleanup")
    expect(authCleanupJob.cron!.split(/\s+/)).toHaveLength(5)
  })
})
