// accounts.sync - daily 02:30 (Asia/Ho_Chi_Minh): re-validate + re-list ad accounts of every active
// connection. New accounts are added DISABLED (an MCP scoped to "all accounts" must not silently grow), missing ones are marked
// "closed" (never deleted).
import { runConnectionRefresh, type RefreshJobData } from "./connection-refresh"
import type { JobDefinition } from "./types"

export const accountsSyncJob: JobDefinition<RefreshJobData> = {
  name: "accounts.sync",
  cron: "30 2 * * *",
  tz: "Asia/Ho_Chi_Minh",
  queue: { expireInSeconds: 60 * 60, retryLimit: 1 },
  handler: (data, ctx) => runConnectionRefresh(data, ctx, { syncAccounts: true }),
}
