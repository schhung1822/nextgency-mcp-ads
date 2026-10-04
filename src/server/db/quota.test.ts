import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) → DB tests are skipped */
  }
})

import { eq } from "drizzle-orm"

import { db } from "./client"
import { consumeQuota, nextWindowState, peekQuota, quotaId } from "./quota"
import { verification } from "./schema"

const T0 = 1_800_000_000_000

describe("nextWindowState", () => {
  it("counts within the window and resets after it", () => {
    let s = nextWindowState(null, T0, 60_000)
    expect(s).toEqual({ count: 1, windowStart: T0 })
    s = nextWindowState(s, T0 + 1_000, 60_000)
    expect(s.count).toBe(2)
    expect(nextWindowState(s, T0 + 60_000, 60_000)).toEqual({ count: 1, windowStart: T0 + 60_000 })
  })
})

const hasDb = !!process.env.DATABASE_URL
const key = `tquota_${randomUUID()}`

describe.skipIf(!hasDb)("consumeQuota (DB)", () => {
  afterAll(async () => {
    if (hasDb) await db.delete(verification).where(eq(verification.id, quotaId("test", key)))
  })

  it("allows `max` hits per window, then reports retry-after; key is hashed", async () => {
    const results = await Promise.all(Array.from({ length: 7 }, () => consumeQuota("test", key, 5, 60_000)))
    expect(results.filter((r) => r.allowed)).toHaveLength(5)
    const denied = results.filter((r) => !r.allowed)
    expect(denied).toHaveLength(2)
    expect(denied[0]!.retryAfterSec).toBeGreaterThan(0)
    expect((await peekQuota("test", key, 5, 60_000)).allowed).toBe(false)
    expect(quotaId("test", key)).not.toContain(key)
  })
})
