// drive.health - every 6 hours at :40 (APP_TIMEZONE): re-check the Google Drive credentials and every live Drive
// folder / Google Sheet source (status, status message, last check). See src/server/drive/health.ts.
import { runDriveHealth } from "@/server/drive/health"

import type { JobDefinition } from "./types"

export const driveHealthJob: JobDefinition = {
  name: "drive.health",
  cron: "40 */6 * * *",
  queue: { expireInSeconds: 30 * 60, retryLimit: 1 },
  handler: (_data, ctx) => runDriveHealth({ signal: ctx.signal, log: ctx.log }),
}
