// drive.cleanup - daily 03:50 (APP_TIMEZONE): delete temporary video links (/dl/<token>/…) that expired more than
// 24 hours ago (15-google-drive-media.md §8, §10); background video uploads: mark uploads whose worker stopped
// reporting progress for 30 minutes as failed (crash / restart), delete finished upload jobs older than 30 days.
import { deleteExpiredRelayLinks } from "@/server/drive/relay-links"
import {
  deleteOldUploadJobs,
  failStaleUploadJobs,
} from "@/server/drive/upload-jobs"

import type { JobDefinition } from "./types"

export const DRIVE_RELAY_KEEP_MS = 24 * 60 * 60_000
export const UPLOAD_JOB_STALE_MS = 30 * 60_000
export const UPLOAD_JOB_KEEP_MS = 30 * 24 * 60 * 60_000

export const driveCleanupJob: JobDefinition = {
  name: "drive.cleanup",
  cron: "50 3 * * *",
  queue: { expireInSeconds: 15 * 60, retryLimit: 1 },
  handler: async () => ({
    deleted: await deleteExpiredRelayLinks(DRIVE_RELAY_KEEP_MS),
    staleUploads: await failStaleUploadJobs(UPLOAD_JOB_STALE_MS),
    deletedUploads: await deleteOldUploadJobs(UPLOAD_JOB_KEEP_MS),
  }),
}
