// Background worker (pg-boss 12). Dev: `pnpm worker:dev` (tsx watch). Prod: bundled to dist/worker.mjs.
// MUST NOT import "next/*" or "server-only" (directly or transitively) — jobs live in src/server/jobs.
// Jobs are registered from the registry in src/server/jobs/index.ts; schedules use pg-boss cron with tz.
import { PgBoss } from "pg-boss"

import { shutdownMcpLogWriter } from "@/server/audit/mcp-log-writer"
import { redactString } from "@/server/audit/redact"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { assertKeyRing } from "@/server/crypto/secret-box"
import { pool } from "@/server/db/client"
import { JOBS, jobTimezone, type JobDefinition } from "@/server/jobs"
import { setNotificationJobSender } from "@/server/notifications/queue"
import { ensureProvidersRegistered } from "@/server/providers"

const STOP_TIMEOUT_MS = 30_000

function log(msg: string) {
  console.log(`[worker] ${redactString(msg)}`)
}

/** one line, redacted, Drizzle `params:` stripped (also thrown into the pg-boss job output) */
function errText(e: unknown): string {
  return safeErrorForLog(e)
}

async function registerJob(boss: PgBoss, job: JobDefinition, signal: AbortSignal) {
  await boss.createQueue(job.name, {
    expireInSeconds: job.queue?.expireInSeconds ?? 15 * 60,
    retryLimit: job.queue?.retryLimit ?? 2,
    retryDelay: job.queue?.retryDelay ?? 60,
    retryBackoff: job.queue?.retryBackoff ?? true,
  })
  if (job.cron) {
    await boss.schedule(job.name, job.cron, null, { tz: jobTimezone(job) })
    log(`scheduled ${job.name} "${job.cron}" (${jobTimezone(job)})`)
  }
  if (job.runOnStart) {
    // one run per 10 minutes at most, however often the worker restarts
    await boss.send(job.name, {}, { singletonKey: `${job.name}:start`, singletonSeconds: 600 })
  }
  await boss.work<Record<string, unknown>>(job.name, { batchSize: 1 }, async ([j]) => {
    if (!j) return
    const started = Date.now()
    try {
      const out = await job.handler(j.data ?? {}, {
        jobId: j.id,
        signal,
        log: (msg) => log(`${job.name}#${j.id}: ${msg}`),
      })
      log(`${job.name}#${j.id} done in ${Date.now() - started} ms ${out ? JSON.stringify(out).slice(0, 500) : ""}`)
      return out
    } catch (e) {
      log(`${job.name}#${j.id} failed: ${errText(e)}`)
      throw new Error(errText(e))
    }
  })
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL chưa được cấu hình")
  // jobs decrypt connection credentials: fail fast on a malformed ENCRYPTION_KEYS (only this env: the worker
  // does not receive BETTER_AUTH_SECRET / MCP_KEY_PEPPER, so env() is NOT called here)
  assertKeyRing()
  process.env.APP_PROCESS_NAME ??= "ads-mcp-worker"
  ensureProvidersRegistered()

  const boss = new PgBoss({ connectionString, schema: "pgboss", application_name: "ads-mcp-pgboss", max: 4 })
  boss.on("error", (e) => console.error(`[worker] pg-boss error: ${errText(e)}`))
  await boss.start()
  log("pg-boss started")
  // notify.telegram retries / notification enqueues from jobs go through this started instance
  setNotificationJobSender((name, data, options) => boss.send(name, data, options))

  const abort = new AbortController()
  for (const job of JOBS) await registerJob(boss, job, abort.signal)
  log(`ready: ${JOBS.map((j) => j.name).join(", ")}`)

  let stopping = false
  const stop = async (signalName: string) => {
    if (stopping) return
    stopping = true
    log(`${signalName} received, stopping…`)
    abort.abort()
    try {
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS })
      // background upload jobs write audit rows (mcp_call_logs) - flush what is still buffered
      await shutdownMcpLogWriter()
      await pool().end()
      log("stopped")
      process.exit(0)
    } catch (e) {
      console.error(`[worker] stop failed: ${errText(e)}`)
      process.exit(1)
    }
  }
  process.on("SIGTERM", () => void stop("SIGTERM"))
  process.on("SIGINT", () => void stop("SIGINT"))
}

main().catch((e) => {
  console.error(`[worker] failed to start: ${errText(e)}`)
  process.exit(1)
})
