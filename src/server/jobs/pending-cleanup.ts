// Job "pending_actions.cleanup" (hourly): mark expired two-step confirmations and delete
// consumed/expired ones older than 7 days. Runs in the worker bundle: no `next/*`, no `server-only`.
import { sql } from "drizzle-orm"
import { db } from "@/server/db/client"
import type { JobDefinition } from "./types"

export const PENDING_KEEP_DAYS = 7

export interface PendingCleanupResult {
  expired: number
  deleted: number
}

export async function runPendingActionsCleanup(now: Date = new Date()): Promise<PendingCleanupResult> {
  const expired = await db.execute(sql`
    update mcp_pending_actions set status = 'expired'
     where status = 'pending' and expires_at < ${now}::timestamptz`)
  const deleted = await db.execute(sql`
    delete from mcp_pending_actions
     where status in ('consumed', 'expired')
       and coalesce(consumed_at, expires_at) < ${now}::timestamptz - make_interval(days => ${PENDING_KEEP_DAYS}::int)`)
  return { expired: expired.rowCount ?? 0, deleted: deleted.rowCount ?? 0 }
}

export const pendingActionsCleanupJob: JobDefinition = {
  name: "pending_actions.cleanup",
  cron: "7 * * * *",
  queue: { expireInSeconds: 5 * 60, retryLimit: 1 },
  handler: async (_data, ctx): Promise<PendingCleanupResult> => {
    const r = await runPendingActionsCleanup()
    ctx.log(`expired=${r.expired} deleted=${r.deleted}`)
    return r
  },
}
