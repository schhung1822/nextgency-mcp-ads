// pg-boss producer for the `notify.telegram` job. The worker registers its own (started) PgBoss with
// setNotificationJobSender(); any other process (the Next.js web app: MCP writes, connection checks) lazily starts a
// send-only PgBoss (no supervision / scheduling / migration - the worker owns those). No "next/*" imports.
import { safeErrorForLog } from "@/server/audit/safe-error"

export const NOTIFY_TELEGRAM_JOB = "notify.telegram"

export interface NotifyJobData {
  deliveryId: string
  /** expected notification_deliveries.attempts when the job runs (optimistic claim: a duplicate job is a no-op) */
  attempt: number
}

export type JobSender = (
  name: string,
  data: object,
  options?: { startAfter?: number }
) => Promise<unknown>

interface SenderGlobal {
  __adsMcpNotifySender?: JobSender | null
  __adsMcpNotifyBoss?: Promise<JobSender> | null
}
const g = globalThis as unknown as SenderGlobal

/** Worker (started PgBoss) or tests (fake). null = back to the lazy send-only PgBoss. */
export function setNotificationJobSender(sender: JobSender | null): void {
  g.__adsMcpNotifySender = sender
}

async function lazyBossSender(): Promise<JobSender> {
  g.__adsMcpNotifyBoss ??= (async () => {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error("DATABASE_URL chưa được cấu hình")
    const { PgBoss } = await import("pg-boss")
    const boss = new PgBoss({
      connectionString,
      schema: "pgboss",
      application_name: "ads-mcp-pgboss-send",
      max: 2,
      supervise: false,
      schedule: false,
      migrate: false,
    })
    boss.on("error", (e) =>
      console.error(`[notifications] pg-boss error: ${safeErrorForLog(e)}`)
    )
    await boss.start()
    const sender: JobSender = (name, data, options) => boss.send(name, data, options)
    return sender
  })().catch((e) => {
    // allow a later retry (worker not migrated yet, DB restarting…)
    g.__adsMcpNotifyBoss = null
    throw e
  })
  return g.__adsMcpNotifyBoss
}

/** Queue one delivery attempt (throws on failure - callers decide; enqueueNotification swallows). */
export async function sendNotifyJob(
  data: NotifyJobData,
  startAfterSec?: number
): Promise<void> {
  const sender = g.__adsMcpNotifySender ?? (await lazyBossSender())
  await sender(
    NOTIFY_TELEGRAM_JOB,
    data,
    startAfterSec && startAfterSec > 0
      ? { startAfter: Math.ceil(startAfterSec) }
      : undefined
  )
}
