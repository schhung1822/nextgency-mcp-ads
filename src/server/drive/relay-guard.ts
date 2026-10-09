// In-memory set of the token hashes of live relay links (security review L3). Consulted only for clients blocked by
// the relay miss limiter (relay-limits.ts): a blocked client's valid token still goes on to the normal lookup - an
// attacker sharing an IP with a platform fetcher (or pointing a platform at bogus /dl/ URLs) cannot lock real fetches
// out - while its unknown tokens cost no per-request database query. The set is reloaded on a miss at most every
// REFRESH_MIN_MS (single flight), so a link created a moment ago is found. No imports from "next/*".
import { and, gt, lt, sql } from "drizzle-orm"

import { db } from "@/server/db/client"
import { driveRelayLinks } from "@/server/db/schema"

/** minimum time between two reloads of the set */
const REFRESH_MIN_MS = 2_000
/** upper bound of rows read (links live 1 h; far more than any real workload) */
const MAX_LIVE_LINKS = 50_000

interface LiveSet {
  at: number
  hashes: Set<string>
}

const g = globalThis as unknown as {
  __adsRelayLive?: LiveSet | null
  __adsRelayLiveLoading?: Promise<LiveSet> | null
}

async function loadLive(now: number): Promise<LiveSet> {
  const rows = await db
    .select({ tokenHash: driveRelayLinks.tokenHash })
    .from(driveRelayLinks)
    .where(
      and(
        gt(driveRelayLinks.expiresAt, sql`now()`),
        lt(driveRelayLinks.fetchCount, driveRelayLinks.maxFetches)
      )
    )
    .limit(MAX_LIVE_LINKS)
  return { at: now, hashes: new Set(rows.map((r) => r.tokenHash)) }
}

function reload(now: number): Promise<LiveSet> {
  g.__adsRelayLiveLoading ??= loadLive(now)
    .then((s) => {
      g.__adsRelayLive = s
      return s
    })
    .finally(() => {
      g.__adsRelayLiveLoading = null
    })
  return g.__adsRelayLiveLoading
}

/** true when `tokenHash` belongs to a live link (expired / used-up links drop out at the next reload). */
export async function isLiveRelayTokenHash(
  tokenHash: string,
  now = Date.now()
): Promise<boolean> {
  const cur = g.__adsRelayLive
  if (cur?.hashes.has(tokenHash)) return true
  if (cur && now - cur.at < REFRESH_MIN_MS) return false
  return (await reload(now)).hashes.has(tokenHash)
}

/** Tests only. */
export function __resetRelayGuard(): void {
  g.__adsRelayLive = null
  g.__adsRelayLiveLoading = null
}
