// drive.cleanup: relay links + background upload jobs housekeeping (DB helpers mocked).
import { describe, expect, it, vi } from "vitest"

vi.mock("@/server/drive/relay-links", () => ({
  deleteExpiredRelayLinks: vi.fn(async () => 4),
}))
vi.mock("@/server/drive/upload-jobs", () => ({
  failStaleUploadJobs: vi.fn(async () => 1),
  deleteOldUploadJobs: vi.fn(async () => 7),
}))

const links = await import("@/server/drive/relay-links")
const jobs = await import("@/server/drive/upload-jobs")
const { driveCleanupJob } = await import("./drive-cleanup")
const { mediaUploadSweepJob } = await import("./media-upload-sweep")

describe("drive.cleanup", () => {
  it("deletes old relay links, fails stale uploads (30 min) and deletes finished uploads after 30 days", async () => {
    const out = await driveCleanupJob.handler(
      {},
      { jobId: "j", signal: new AbortController().signal, log: () => {} }
    )
    expect(out).toEqual({ deleted: 4, staleUploads: 1, deletedUploads: 7 })
    expect(links.deleteExpiredRelayLinks).toHaveBeenCalledWith(24 * 60 * 60_000)
    expect(jobs.failStaleUploadJobs).toHaveBeenCalledWith(30 * 60_000)
    expect(jobs.deleteOldUploadJobs).toHaveBeenCalledWith(30 * 24 * 60 * 60_000)
  })

  it("media.upload_sweep: every 10 minutes, stale uploads (30 min without progress) → failed", async () => {
    vi.mocked(jobs.failStaleUploadJobs).mockClear()
    expect(mediaUploadSweepJob.cron).toBe("*/10 * * * *")
    const out = await mediaUploadSweepJob.handler(
      {},
      { jobId: "j", signal: new AbortController().signal, log: () => {} }
    )
    expect(out).toEqual({ failed: 1 })
    expect(jobs.failStaleUploadJobs).toHaveBeenCalledExactlyOnceWith(30 * 60_000)
  })
})
