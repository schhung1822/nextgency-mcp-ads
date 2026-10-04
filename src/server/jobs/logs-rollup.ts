// Job "logs.rollup" (every 5 minutes): recompute mcp_call_stats_hourly for the current hour and the
// previous `hours` hours from mcp_call_logs (idempotent: whole hourly buckets are replaced).
// Runs in the worker bundle: no `next/*`, no `server-only`.
import { sql } from "drizzle-orm"
import { db } from "@/server/db/client"
import type { JobDefinition } from "./types"

/** statuses counted as errors in the stats ("pending_confirmation" is not an error) */
export const ERROR_STATUSES = ["error", "denied", "rate_limited", "invalid_request"] as const

export interface LogsRollupResult {
  since: string
  rows: number
}

export async function runLogsRollup(opts: { hours?: number; now?: Date } = {}): Promise<LogsRollupResult> {
  const hours = Math.max(1, Math.min(opts.hours ?? 2, 24 * 31))
  const now = opts.now ?? new Date()
  const since = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - hours * 3_600_000)
  const r = await db.execute(sql`
    with agg as (
      select date_trunc('hour', l.created_at, 'UTC') as bucket,
             l.mcp_id,
             max(l.owner_id) as owner_id,
             coalesce(l.platform, '') as platform,
             coalesce(l.tool_name, '') as tool_name,
             count(*)::int as calls,
             (count(*) filter (where l.status in ('error', 'denied', 'rate_limited', 'invalid_request')))::int as errors,
             (count(*) filter (where l.action_kind = 'write'))::int as writes,
             coalesce(sum(l.duration_ms), 0)::bigint as duration_ms_sum
        from mcp_call_logs l
       where l.created_at >= ${since}::timestamptz
         and l.mcp_id is not null
       group by 1, 2, 4, 5
    )
    insert into mcp_call_stats_hourly as s
           (bucket, mcp_id, owner_id, platform, tool_name, calls, errors, writes, duration_ms_sum)
    select bucket, mcp_id, owner_id, platform, tool_name, calls, errors, writes, duration_ms_sum from agg
    on conflict (bucket, mcp_id, platform, tool_name) do update
       set owner_id = excluded.owner_id,
           calls = excluded.calls,
           errors = excluded.errors,
           writes = excluded.writes,
           duration_ms_sum = excluded.duration_ms_sum`)
  return { since: since.toISOString(), rows: r.rowCount ?? 0 }
}

export const logsRollupJob: JobDefinition = {
  name: "logs.rollup",
  cron: "*/5 * * * *",
  // the next run recomputes the same window, so retries are pointless
  queue: { expireInSeconds: 4 * 60, retryLimit: 0 },
  handler: async (): Promise<LogsRollupResult> => runLogsRollup(),
}
