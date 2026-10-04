// Job "auth.cleanup" (daily 03:45 APP_TIMEZONE): delete expired rows of the auth tables that nothing else
// removes, so they cannot grow without bound (an unauthenticated client creates lockout / rate-limit rows
// with every failed sign-in):
//  - verification : sign-in lockout counters, quota windows (setup / CSV export), re-auth "fresh session" marks,
//                   2FA challenges and attempt counters, trusted-device records - all carry expires_at;
//  - session      : expired sessions of users who never came back (Better Auth only deletes them lazily);
//  - rate_limit   : per-IP/path counters of Better Auth (windows are ≤ 60 s; idle rows are useless after an hour).
// Runs in the worker bundle: no `next/*`, no `server-only`.
import { sql } from "drizzle-orm"
import { db } from "@/server/db/client"
import type { JobDefinition } from "./types"

/** keep expired rows this long (clock skew / debugging) */
export const AUTH_GRACE_HOURS = 24
/** idle Better Auth rate-limit counters are dropped after this */
export const RATE_LIMIT_IDLE_MINUTES = 60
const BATCH = 5000
const MAX_BATCHES = 200

export interface AuthCleanupResult {
  verification: number
  sessions: number
  rateLimit: number
}

/** Delete in bounded batches so a huge backlog never holds a long lock. */
async function deleteBatched(table: "verification" | "session" | "rate_limit", where: ReturnType<typeof sql>): Promise<number> {
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await db.execute(
      sql`delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where ${where} limit ${BATCH})`
    )
    const n = r.rowCount ?? 0
    total += n
    if (n < BATCH) break
  }
  return total
}

export async function runAuthCleanup(now: Date = new Date()): Promise<AuthCleanupResult> {
  // Better Auth's expires_at columns are `timestamp without time zone` holding UTC wall time: compare with a UTC
  // ISO string (a bound Date would be serialised in the server's local time zone).
  const graceCutoff = new Date(now.getTime() - AUTH_GRACE_HOURS * 3_600_000).toISOString()
  const rateCutoffMs = now.getTime() - RATE_LIMIT_IDLE_MINUTES * 60_000
  return {
    verification: await deleteBatched("verification", sql`expires_at < ${graceCutoff}::timestamp`),
    sessions: await deleteBatched("session", sql`expires_at < ${graceCutoff}::timestamp`),
    rateLimit: await deleteBatched("rate_limit", sql`last_request < ${rateCutoffMs}`),
  }
}

export const authCleanupJob: JobDefinition = {
  name: "auth.cleanup",
  cron: "45 3 * * *",
  queue: { expireInSeconds: 15 * 60, retryLimit: 1 },
  handler: async (_data, ctx): Promise<AuthCleanupResult> => {
    const r = await runAuthCleanup()
    ctx.log(`verification=${r.verification} sessions=${r.sessions} rate_limit=${r.rateLimit}`)
    return r
  },
}
