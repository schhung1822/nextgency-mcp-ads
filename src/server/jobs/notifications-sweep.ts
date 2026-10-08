// notifications.sweep - every 5 minutes: re-queue deliveries whose job was never created (the web app could not reach
// pg-boss), give up deliveries pending for more than 1 hour, and announce finished system updates (the updater
// container cannot enqueue: see notifyRecentUpdateResults).
import { sweepDeliveries } from "@/server/notifications/process"

import type { JobDefinition } from "./types"

export const notificationsSweepJob: JobDefinition = {
  name: "notifications.sweep",
  cron: "*/5 * * * *",
  queue: { expireInSeconds: 5 * 60, retryLimit: 0 },
  handler: () => sweepDeliveries(),
}
