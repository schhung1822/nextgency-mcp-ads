// Contract for background jobs run by scripts/worker.ts (pg-boss). Framework-agnostic:
// job modules must not import "next/*" or "server-only" (they are bundled into dist/worker.mjs).

export interface JobContext {
  jobId: string
  /** aborted when the worker is shutting down */
  signal: AbortSignal
  log: (msg: string) => void
}

export interface JobQueueOptions {
  /** seconds before a running job is considered failed (default 15 min) */
  expireInSeconds?: number
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
}

export interface JobDefinition<D = Record<string, unknown>> {
  /** pg-boss queue name: letters, digits, `_`, `-`, `.` (e.g. "tokens.health") */
  name: string
  /** 5-field cron; omit for on-demand jobs (sent with boss.send) */
  cron?: string
  /** IANA time zone for `cron` (default APP_TIMEZONE / Asia/Ho_Chi_Minh) */
  tz?: string
  queue?: JobQueueOptions
  /** must be idempotent - pg-boss may retry */
  handler: (data: D, ctx: JobContext) => Promise<unknown>
}

export const DEFAULT_JOB_TZ = "Asia/Ho_Chi_Minh"

export function jobTimezone(job: Pick<JobDefinition, "tz">): string {
  return job.tz ?? process.env.APP_TIMEZONE ?? DEFAULT_JOB_TZ
}

/** Run `fn` over `items` with at most `limit` in flight; stops scheduling new items when aborted. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}
