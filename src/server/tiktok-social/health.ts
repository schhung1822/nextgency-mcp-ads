// TikTok Social health (17-tiktok-social.md §3): refreshes access tokens that expire within the next run window (so
// a token never lapses between MCP calls), marks rows "expiring" when the 1-year authorization ends within 14 days and
// "invalid" when TikTok refuses the refresh (store.tiktokSocialAccessToken does it). Transient errors keep the row as
// it is. No imports from "next/*". Nothing here logs a token.
import { and, inArray, isNull } from "drizzle-orm"

import { db } from "@/server/db/client"
import { tiktokSocialAccounts } from "@/server/db/schema"

import { isTiktokSocialError } from "./api"
import { liveStatus, tiktokSocialAccessToken } from "./store"

/** refresh tokens expiring before the next run (every 6 h) + a margin */
export const HEALTH_REFRESH_WINDOW_MS = 7 * 3_600_000

export interface TiktokSocialHealthSummary {
  checked: number
  refreshed: number
  invalid: number
  errors: number
  expiring: number
}

export async function runTiktokSocialHealth(ctx: { signal?: AbortSignal; log?: (msg: string) => void; now?: () => Date }): Promise<TiktokSocialHealthSummary> {
  const now = ctx.now ?? (() => new Date())
  const rows = await db
    .select({ id: tiktokSocialAccounts.id, status: tiktokSocialAccounts.status, accessExpiresAt: tiktokSocialAccounts.accessExpiresAt, refreshExpiresAt: tiktokSocialAccounts.refreshExpiresAt })
    .from(tiktokSocialAccounts)
    .where(and(isNull(tiktokSocialAccounts.deletedAt), inArray(tiktokSocialAccounts.status, ["active", "expiring"])))
  const sum: TiktokSocialHealthSummary = { checked: rows.length, refreshed: 0, invalid: 0, errors: 0, expiring: 0 }
  for (const r of rows) {
    if (ctx.signal?.aborted) break
    // the 1-year window: flag rows that need a new sign-in soon (no network call)
    const wanted = liveStatus(r.refreshExpiresAt, now())
    if (wanted === "expiring") sum.expiring++
    if (wanted !== r.status && r.refreshExpiresAt.getTime() > now().getTime()) {
      await db
        .update(tiktokSocialAccounts)
        .set({ status: wanted })
        .where(and(inArray(tiktokSocialAccounts.id, [r.id]), isNull(tiktokSocialAccounts.deletedAt)))
    }
    if (r.accessExpiresAt.getTime() - now().getTime() > HEALTH_REFRESH_WINDOW_MS) continue
    try {
      await tiktokSocialAccessToken(r.id, { force: true, signal: ctx.signal, now })
      sum.refreshed++
    } catch (e) {
      if (isTiktokSocialError(e) && e.code === "auth") sum.invalid++
      else sum.errors++
    }
  }
  ctx.log?.(`tiktok-social.health: ${JSON.stringify(sum)}`)
  return sum
}
