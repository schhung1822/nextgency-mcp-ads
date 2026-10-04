// tokens.health - every 6 hours: re-validate the stored credentials of every active connection and
// update status (active / expiring < 7 days / invalid), token expiry, scopes and status message.
import { runConnectionRefresh, type RefreshJobData } from "./connection-refresh"
import type { JobDefinition } from "./types"

export const tokensHealthJob: JobDefinition<RefreshJobData> = {
  name: "tokens.health",
  cron: "0 */6 * * *",
  queue: { expireInSeconds: 30 * 60, retryLimit: 1 },
  handler: (data, ctx) => runConnectionRefresh(data, ctx, { syncAccounts: false }),
}
