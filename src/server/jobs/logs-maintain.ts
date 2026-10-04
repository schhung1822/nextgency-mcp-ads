// Job "logs.maintain" (daily 03:15 APP_TIMEZONE): create the next monthly partitions of both log tables,
// then drop partitions older than the retention settings, and prune the hourly stats rollup (13 months).
// Runs in the worker bundle: no `next/*`, no `server-only` (reads app_settings directly).
import { inArray, sql } from "drizzle-orm"
import { db } from "@/server/db/client"
import { appSettings } from "@/server/db/schema"
import type { JobDefinition } from "./types"

export const LOG_PARENT_TABLES = ["mcp_call_logs", "activity_logs"] as const
export type LogParentTable = (typeof LOG_PARENT_TABLES)[number]

export const PARTITIONS_AHEAD = 3
export const STATS_KEEP_MONTHS = 13

export interface RetentionMonths {
  mcp: number
  staff: number
}

function validMonths(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 24 ? n : null
}

/** log_retention_months_mcp / _staff from app_settings (default LOG_RETENTION_MONTHS env, else 3). */
export async function readRetentionMonths(): Promise<RetentionMonths> {
  const fallback = validMonths(Number(process.env.LOG_RETENTION_MONTHS ?? 3)) ?? 3
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, ["log_retention_months_mcp", "log_retention_months_staff"]))
  const get = (k: string) => validMonths(rows.find((r) => r.key === k)?.value) ?? fallback
  return { mcp: get("log_retention_months_mcp"), staff: get("log_retention_months_staff") }
}

export interface LogsMaintainResult {
  retention: RetentionMonths
  dropped: Record<LogParentTable, number>
  statsRowsDeleted: number
  errors: string[]
}

export interface LogsMaintainOptions {
  /** override settings (tests) */
  retention?: Partial<RetentionMonths>
  ahead?: number
}

export async function runLogsMaintenance(opts: LogsMaintainOptions = {}): Promise<LogsMaintainResult> {
  const settings = await readRetentionMonths()
  const retention: RetentionMonths = {
    mcp: validMonths(opts.retention?.mcp) ?? settings.mcp,
    staff: validMonths(opts.retention?.staff) ?? settings.staff,
  }
  const ahead = Math.max(1, Math.min(opts.ahead ?? PARTITIONS_AHEAD, 12))
  const dropped: Record<LogParentTable, number> = { mcp_call_logs: 0, activity_logs: 0 }
  const errors: string[] = []

  for (const parent of LOG_PARENT_TABLES) {
    try {
      await db.execute(sql`select app_ensure_monthly_partitions(${parent}, ${ahead}::int)`)
    } catch (e) {
      errors.push(`${parent}: ensure partitions failed: ${(e as Error).message}`)
    }
    const keep = parent === "mcp_call_logs" ? retention.mcp : retention.staff
    try {
      // DROP of a partition takes ACCESS EXCLUSIVE on the parent: never wait long behind writers.
      dropped[parent] = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`)
        const r = await tx.execute<{ n: number }>(
          sql`select app_drop_expired_partitions(${parent}, ${keep}::int) as n`
        )
        return Number(r.rows[0]?.n ?? 0)
      })
    } catch (e) {
      errors.push(`${parent}: drop expired partitions failed (retry tomorrow): ${(e as Error).message}`)
    }
  }

  let statsRowsDeleted = 0
  try {
    const r = await db.execute(
      sql`delete from mcp_call_stats_hourly where bucket < date_trunc('month', now(), 'UTC') - make_interval(months => ${STATS_KEEP_MONTHS}::int)`
    )
    statsRowsDeleted = r.rowCount ?? 0
  } catch (e) {
    errors.push(`mcp_call_stats_hourly: prune failed: ${(e as Error).message}`)
  }

  return { retention, dropped, statsRowsDeleted, errors }
}

export const logsMaintainJob: JobDefinition = {
  name: "logs.maintain",
  cron: "15 3 * * *",
  // DROP waits at most 5 s for its lock; a failed run is retried once, otherwise tomorrow
  queue: { expireInSeconds: 15 * 60, retryLimit: 1, retryDelay: 600 },
  handler: async (_data, ctx): Promise<LogsMaintainResult> => {
    const result = await runLogsMaintenance()
    ctx.log(
      `retention mcp=${result.retention.mcp} staff=${result.retention.staff}; dropped mcp=${result.dropped.mcp_call_logs} staff=${result.dropped.activity_logs}; stats pruned=${result.statsRowsDeleted}`
    )
    if (result.errors.length) {
      // fail the job so pg-boss records it (retry / next day); messages contain no secrets
      throw new Error(`logs.maintain: ${result.errors.join(" | ")}`)
    }
    return result
  },
}
