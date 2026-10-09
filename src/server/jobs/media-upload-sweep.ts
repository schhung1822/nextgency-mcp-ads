// media.upload_sweep - every 10 minutes: background video uploads whose worker stopped reporting progress for 30
// minutes (crash, OOM kill, restart without a graceful stop) are marked failed. Without it a stuck job would block
// new uploads of the same file (one ACTIVE job per account + file version) until the daily drive.cleanup.
import { failStaleUploadJobs } from "@/server/drive/upload-jobs"

import { UPLOAD_JOB_STALE_MS } from "./drive-cleanup"
import type { JobDefinition } from "./types"

export const mediaUploadSweepJob: JobDefinition = {
  name: "media.upload_sweep",
  cron: "*/10 * * * *",
  queue: { expireInSeconds: 5 * 60, retryLimit: 0 },
  handler: async () => ({
    failed: await failStaleUploadJobs(UPLOAD_JOB_STALE_MS),
  }),
}
