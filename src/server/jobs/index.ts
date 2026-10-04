// Job registry for scripts/worker.ts. To add a job: create `src/server/jobs/<name>.ts` exporting a
// JobDefinition (no "next/*" / "server-only" imports) and append it to JOBS below.
import { accountsSyncJob } from "./accounts-sync"
import { authCleanupJob } from "./auth-cleanup"
import { logsMaintainJob } from "./logs-maintain"
import { logsRollupJob } from "./logs-rollup"
import { pendingActionsCleanupJob } from "./pending-cleanup"
import { tokensHealthJob } from "./tokens-health"
import type { JobDefinition } from "./types"
import { updateCheckJob } from "./update-check"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const JOBS: JobDefinition<any>[] = [
  tokensHealthJob,
  accountsSyncJob,
  logsMaintainJob,
  logsRollupJob,
  pendingActionsCleanupJob,
  authCleanupJob,
  updateCheckJob,
]

export {
  DEFAULT_JOB_TZ,
  jobTimezone,
  mapLimit,
  type JobContext,
  type JobDefinition,
  type JobQueueOptions,
} from "./types"
