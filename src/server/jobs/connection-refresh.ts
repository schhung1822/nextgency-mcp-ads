// Shared runner for tokens.health / accounts.sync: refresh every active connection (or one by id).
import { ensureProvidersRegistered } from "@/server/providers"

import { listActiveConnectionIds, refreshConnection } from "./lib/connection-ops"
import { mapLimit, type JobContext } from "./types"

export interface RefreshJobData {
  /** run for a single connection only (on-demand) */
  connectionId?: string
}

export interface RefreshJobSummary {
  checked: number
  active: number
  expiring: number
  invalid: number
  /** transient errors (status unchanged) */
  errors: number
  accountsSynced: number
}

/** Platforms rate-limit per app/token: keep concurrency low. */
const CONCURRENCY = 3

export async function runConnectionRefresh(
  data: RefreshJobData | null | undefined,
  ctx: Pick<JobContext, "signal" | "log">,
  opts: { syncAccounts: boolean }
): Promise<RefreshJobSummary> {
  ensureProvidersRegistered()
  const ids =
    data && typeof data.connectionId === "string" && data.connectionId
      ? [data.connectionId]
      : await listActiveConnectionIds()
  const summary: RefreshJobSummary = { checked: 0, active: 0, expiring: 0, invalid: 0, errors: 0, accountsSynced: 0 }
  await mapLimit(
    ids,
    CONCURRENCY,
    async (id) => {
      try {
        const res = await refreshConnection(id, { syncAccounts: opts.syncAccounts })
        if (!res) return
        summary.checked++
        if (res.error && res.status === null) summary.errors++
        if (res.status === "active") summary.active++
        else if (res.status === "expiring") summary.expiring++
        else if (res.status === "invalid") summary.invalid++
        if (res.accountsSummary) summary.accountsSynced += res.accountsSummary.total
        if (res.error) ctx.log(`connection ${id}: ${res.error}`)
      } catch (e) {
        // DB/decrypt failure for one connection must not stop the others
        summary.errors++
        ctx.log(`connection ${id}: ${e instanceof Error ? e.name : "error"} while refreshing`)
      }
    },
    ctx.signal
  )
  return summary
}
