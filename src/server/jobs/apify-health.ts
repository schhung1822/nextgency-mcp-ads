// apify.health - every 6 hours at :10 (APP_TIMEZONE): re-check every live Apify token (GET /v2/users/me + limits:
// account, plan, credit, cycle end, status) and delete apify_runs records older than 90 days.
// See src/server/apify/health.ts (16-apify.md §4).
import { runApifyHealth } from "@/server/apify/health"

import type { JobDefinition } from "./types"

export const apifyHealthJob: JobDefinition = {
  name: "apify.health",
  cron: "10 */6 * * *",
  queue: { expireInSeconds: 30 * 60, retryLimit: 1 },
  handler: (_data, ctx) => runApifyHealth({ signal: ctx.signal, log: ctx.log }),
}
