// Fixed-window counters stored in the `verification` table (survive restarts, shared by every instance).
// Used for small, security-relevant throttles: CSV export per user, /setup wrong-token attempts per IP.
// Framework-free (no `next/*`).
import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"

import { db } from "./client"
import { verification } from "./schema"

export interface WindowState {
  count: number
  windowStart: number
}

export interface QuotaResult {
  allowed: boolean
  /** seconds until the window resets (when not allowed) */
  retryAfterSec: number
  count: number
}

/** Pure: apply one hit to a fixed window. */
export function nextWindowState(state: WindowState | null, now: number, windowMs: number): WindowState {
  if (!state || now - state.windowStart >= windowMs) return { count: 1, windowStart: now }
  return { count: state.count + 1, windowStart: state.windowStart }
}

function parse(value: string | null | undefined): WindowState | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<WindowState>
    return typeof v.count === "number" && typeof v.windowStart === "number" ? { count: v.count, windowStart: v.windowStart } : null
  } catch {
    return null
  }
}

/** Storage id for a quota bucket; the raw key (user id, IP…) is hashed. */
export function quotaId(scope: string, key: string): string {
  return `quota:${scope}:${createHash("sha256").update(key).digest("hex")}`
}

function result(state: WindowState, max: number, windowMs: number, now: number): QuotaResult {
  const allowed = state.count <= max
  return {
    allowed,
    count: state.count,
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((state.windowStart + windowMs - now) / 1000)),
  }
}

/** Atomically count one hit; `allowed` is false once more than `max` hits happened in the window. */
export async function consumeQuota(scope: string, key: string, max: number, windowMs: number, now = Date.now()): Promise<QuotaResult> {
  const id = quotaId(scope, key)
  return db.transaction(async (tx) => {
    await tx
      .insert(verification)
      .values({ id, identifier: id, value: "", expiresAt: new Date(now + windowMs) })
      .onConflictDoNothing({ target: verification.id })
    const rows = await tx.execute<{ value: string }>(
      sql`select ${verification.value} as value from ${verification} where ${verification.id} = ${id} for update`
    )
    const next = nextWindowState(parse(rows.rows[0]?.value), now, windowMs)
    await tx
      .update(verification)
      .set({ value: JSON.stringify(next), expiresAt: new Date(next.windowStart + windowMs), updatedAt: new Date(now) })
      .where(eq(verification.id, id))
    return result(next, max, windowMs, now)
  })
}

/** Read-only check (does not count a hit). */
export async function peekQuota(scope: string, key: string, max: number, windowMs: number, now = Date.now()): Promise<QuotaResult> {
  const rows = await db
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.id, quotaId(scope, key)))
    .limit(1)
  const state = parse(rows[0]?.value)
  if (!state || now - state.windowStart >= windowMs) return { allowed: true, retryAfterSec: 0, count: 0 }
  // "allowed" = one more hit would still be within the budget
  return result({ ...state, count: state.count + 1 }, max, windowMs, now)
}
