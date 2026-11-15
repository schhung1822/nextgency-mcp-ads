// Job registry for scripts/worker.ts. To add a job: create `src/server/jobs/<name>.ts` exporting a
// JobDefinition (no "next/*" / "server-only" imports) and append it to JOBS below.
import { accountsSyncJob } from "./accounts-sync"
import { apifyHealthJob } from "./apify-health"
import { authCleanupJob } from "./auth-cleanup"
import { driveCleanupJob } from "./drive-cleanup"
import { driveHealthJob } from "./drive-health"
import { logsMaintainJob } from "./logs-maintain"
import { logsRollupJob } from "./logs-rollup"
import { mediaUploadSweepJob } from "./media-upload-sweep"
import { mediaVideoUploadJob } from "./media-video-upload"
import { noticesFetchJob } from "./notices-fetch"
import { notificationsCleanupJob } from "./notifications-cleanup"
import { notificationsSweepJob } from "./notifications-sweep"
import { notifyTelegramJob } from "./notify-telegram"
import { pendingActionsCleanupJob } from "./pending-cleanup"
import { tiktokSocialHealthJob } from "./tiktok-social-health"
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
  noticesFetchJob,
  notifyTelegramJob,
  notificationsSweepJob,
  notificationsCleanupJob,
  driveHealthJob,
  driveCleanupJob,
  mediaVideoUploadJob,
  mediaUploadSweepJob,
  apifyHealthJob,
  tiktokSocialHealthJob,
]

export {
  DEFAULT_JOB_TZ,
  jobTimezone,
  mapLimit,
  type JobContext,
  type JobDefinition,
  type JobQueueOptions,
} from "./types"
