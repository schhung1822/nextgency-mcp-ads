// notifications.cleanup - daily 03:40 (APP_TIMEZONE): delete notification_deliveries older than
// log_retention_months_mcp (same retention as the MCP call log).
import { cleanupDeliveries } from "@/server/notifications/process"

import { readRetentionMonths } from "./logs-maintain"
import type { JobDefinition } from "./types"

export const notificationsCleanupJob: JobDefinition = {
  name: "notifications.cleanup",
  cron: "40 3 * * *",
  queue: { expireInSeconds: 15 * 60, retryLimit: 1 },
  handler: async () => {
    const { mcp } = await readRetentionMonths()
    return { months: mcp, deleted: await cleanupDeliveries(mcp) }
  },
}
