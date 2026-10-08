// notify.telegram - on demand ({ deliveryId, attempt }): send one notification_deliveries row to its Telegram channel.
// Retries are scheduled by the handler itself (new job with startAfter: 429 retry_after, 10 s / 60 s / 5 min), so
// the pg-boss retry is off. The worker runs this queue one job at a time (batchSize 1): per-channel pacing holds.
import { processDelivery } from "@/server/notifications/process"
import { NOTIFY_TELEGRAM_JOB, type NotifyJobData } from "@/server/notifications/queue"

import type { JobDefinition } from "./types"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const notifyTelegramJob: JobDefinition<Partial<NotifyJobData>> = {
  name: NOTIFY_TELEGRAM_JOB,
  queue: { expireInSeconds: 120, retryLimit: 0 },
  handler: async (data) => {
    const deliveryId = typeof data?.deliveryId === "string" && UUID_RE.test(data.deliveryId) ? data.deliveryId : null
    const attempt = typeof data?.attempt === "number" && Number.isInteger(data.attempt) && data.attempt >= 0 ? data.attempt : null
    if (!deliveryId || attempt === null) return { result: "skipped", reason: "bad job data" }
    return processDelivery({ deliveryId, attempt })
  },
}
