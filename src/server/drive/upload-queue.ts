// Enqueue a background video upload (pg-boss queue "media.video_upload", handled by the worker job of the same
// name: src/server/jobs/media-video-upload.ts). Same producer pattern as src/server/notifications/queue.ts: the worker
// may register its started PgBoss (setVideoUploadJobSender); any other process (the Next.js web app: MCP tools) lazily
// starts a send-only PgBoss (no supervision / scheduling / migration - the worker owns those and creates the queue).
// No imports from "next/*".
import { safeErrorForLog } from "@/server/audit/safe-error"

export const VIDEO_UPLOAD_QUEUE = "media.video_upload"

export interface VideoUploadJobData {
  /** media_upload_jobs.id */
  jobId: string
}

export type VideoUploadJobSender = (
  name: string,
  data: VideoUploadJobData,
  options: { singletonKey: string }
) => Promise<unknown>

interface SenderGlobal {
  __adsMcpVideoUploadSender?: VideoUploadJobSender | null
  __adsMcpVideoUploadBoss?: Promise<VideoUploadJobSender> | null
}
const g = globalThis as unknown as SenderGlobal

/** Worker (started PgBoss) or tests (fake). null = back to the lazy send-only PgBoss. */
export function setVideoUploadJobSender(
  sender: VideoUploadJobSender | null
): void {
  g.__adsMcpVideoUploadSender = sender
}

async function lazyBossSender(): Promise<VideoUploadJobSender> {
  g.__adsMcpVideoUploadBoss ??= (async () => {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error("DATABASE_URL chưa được cấu hình")
    const { PgBoss } = await import("pg-boss")
    const boss = new PgBoss({
      connectionString,
      schema: "pgboss",
      application_name: "ads-mcp-pgboss-send-media",
      max: 2,
      supervise: false,
      schedule: false,
      migrate: false,
    })
    boss.on("error", (e) =>
      console.error(`[media-upload] pg-boss error: ${safeErrorForLog(e)}`)
    )
    await boss.start()
    const sender: VideoUploadJobSender = (name, data, options) =>
      boss.send(name, data, options)
    return sender
  })().catch((e) => {
    // allow a later retry (worker not migrated yet, DB restarting…)
    g.__adsMcpVideoUploadBoss = null
    throw e
  })
  return g.__adsMcpVideoUploadBoss
}

/** Send { jobId } to the queue (singleton per jobId). Throws when the queue is unavailable. */
export async function enqueueVideoUpload(jobId: string): Promise<void> {
  if (typeof jobId !== "string" || !jobId)
    throw new Error("enqueueVideoUpload: job id required")
  const sender = g.__adsMcpVideoUploadSender ?? (await lazyBossSender())
  await sender(VIDEO_UPLOAD_QUEUE, { jobId }, { singletonKey: jobId })
}
