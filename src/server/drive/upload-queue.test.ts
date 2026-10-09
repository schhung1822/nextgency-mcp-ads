// Producer of the media.video_upload queue (fake sender: no pg-boss, no DB).
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  enqueueVideoUpload,
  setVideoUploadJobSender,
  VIDEO_UPLOAD_QUEUE,
} from "./upload-queue"

afterEach(() => setVideoUploadJobSender(null))

describe("enqueueVideoUpload", () => {
  it("sends { jobId } to media.video_upload, singleton per job id", async () => {
    const send = vi.fn(async () => "pgboss-id")
    setVideoUploadJobSender(send)
    await enqueueVideoUpload("0192f000-0000-7000-8000-000000000001")
    expect(VIDEO_UPLOAD_QUEUE).toBe("media.video_upload")
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "media.video_upload",
      { jobId: "0192f000-0000-7000-8000-000000000001" },
      { singletonKey: "0192f000-0000-7000-8000-000000000001" }
    )
  })

  it("throws when the queue is unavailable (the caller marks the job failed)", async () => {
    setVideoUploadJobSender(async () => {
      throw new Error("Queue media.video_upload does not exist")
    })
    await expect(enqueueVideoUpload("j1")).rejects.toThrow(/does not exist/)
    await expect(enqueueVideoUpload("")).rejects.toThrow(/job id/)
  })
})
