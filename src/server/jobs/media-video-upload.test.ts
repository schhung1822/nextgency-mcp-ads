// media.video_upload worker job with the DB / Drive / provider helpers mocked (no network, no DB).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_MCP_SETTINGS, type McpGrant } from "@/server/mcp/types"
import { DriveError } from "@/server/drive/errors"
import type { DriveFile } from "@/server/drive/types"
import type { UploadJobRow } from "@/server/drive/upload-jobs"
import { ProviderError } from "@/server/providers/errors"
import type { ChunkedVideoUploadRequest } from "@/server/providers/types"

vi.mock("@/server/drive/upload-jobs", () => ({
  claimUploadJob: vi.fn(),
  updateUploadJob: vi.fn(async () => true),
  touchUploadJob: vi.fn(async () => true),
  loadUploadJobAuditInfo: vi.fn(async () => ({
    mcpName: "MCP",
    ownerId: "u1",
    ownerEmail: "u1@example.test",
    accountExternalId: "act_1",
  })),
  decryptUploadJobResourceKey: vi.fn(() => "rk-1"),
}))
vi.mock("@/server/drive/blocked", () => ({
  loadBlockedFolderIds: vi.fn(async () => new Set<string>()),
}))
vi.mock("@/server/audit/mcp-log-writer", () => ({
  insertMcpLogNow: vi.fn(async () => {}),
  flushMcpLogs: vi.fn(async () => {}),
}))
vi.mock("@/server/drive/access-recheck", async (orig) => {
  const actual = await orig<typeof import("@/server/drive/access-recheck")>()
  return { ...actual, loadGrantForMcpId: vi.fn() }
})
vi.mock("@/server/drive/store", () => ({
  isUuid: (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v),
  loadDriveCredential: vi.fn(),
  isDriveCredentialUsable: (r: { deletedAt: Date | null; status: string }) =>
    !r.deletedAt && r.status !== "disabled",
  driveAuthForCredential: vi.fn(() => ({
    type: "service_account",
    sa: {},
    cacheKey: "drive_credential:c1",
  })),
  systemApiKeyAuth: vi.fn(),
}))
vi.mock("@/server/drive/files", () => ({
  getDriveFile: vi.fn(),
  readDriveRange: vi.fn(),
  findAncestorIn: vi.fn(),
  driveContentKey: (f: DriveFile) =>
    f.md5 && f.sizeBytes !== null ? `md5:${f.md5}:${f.sizeBytes}` : null,
}))
vi.mock("@/server/drive/media-uploads", () => ({
  recordMediaUpload: vi.fn(async () => {}),
}))
vi.mock("@/server/mcp/context", () => ({
  providerContextFactory: vi.fn(() =>
    Object.assign(
      vi.fn(async (account: { id: string }) => ({
        connectionId: "conn1",
        credentials: { token: "secret" },
        connectionMeta: {},
        account,
      })),
      { touched: new Set(), connection: vi.fn() }
    )
  ),
}))
vi.mock("@/server/providers", () => ({
  ensureProvidersRegistered: vi.fn(),
  getProvider: vi.fn(),
}))

const jobs = await import("@/server/drive/upload-jobs")
const recheck = await import("@/server/drive/access-recheck")
const store = await import("@/server/drive/store")
const files = await import("@/server/drive/files")
const uploads = await import("@/server/drive/media-uploads")
const context = await import("@/server/mcp/context")
const providers = await import("@/server/providers")
const blockedMod = await import("@/server/drive/blocked")
const logWriter = await import("@/server/audit/mcp-log-writer")
const {
  runVideoUploadJob,
  mediaVideoUploadJob,
  videoUploadFailure,
  VIDEO_HEARTBEAT_MS,
} = await import("./media-video-upload")
const RUNNING = { expectedStatuses: ["uploading", "processing"] }

const JOB_ID = "0192f000-0000-7000-8000-000000000001"
const SIZE = 50 * 1024 * 1024

function jobRow(over: Partial<UploadJobRow> = {}): UploadJobRow {
  return {
    id: JOB_ID,
    mcpId: "m1",
    adAccountId: "a1",
    platform: "meta",
    driveFileId: "FILEID1234567890",
    fileName: "video.mp4",
    sizeBytes: SIZE,
    status: "uploading",
    uploadedBytes: 0,
    mediaId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    contentKey: `md5:abc:${SIZE}`,
    sourceId: "s1",
    access: { type: "service_account", credentialId: "c1" },
    resourceKeyEncrypted: "v1.x",
    contentType: "video/mp4",
    md5: "abc",
    name: "Video 1",
    attempts: 1,
    ...over,
  }
}

function grant(over: Partial<McpGrant> = {}): McpGrant {
  return {
    mcpId: "m1",
    mcpName: "MCP",
    ownerId: "u1",
    ownerEmail: "u1@example.test",
    ownerRole: "staff",
    settings: { ...DEFAULT_MCP_SETTINGS },
    permissions: { meta: ["read", "create"] },
    accounts: [
      {
        id: "a1",
        connectionId: "conn1",
        platform: "meta",
        externalId: "act_1",
        name: "TKQC",
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
      },
    ],
    pages: [],
    notificationChannels: [],
    driveSources: [
      {
        id: "s1",
        kind: "folder",
        scope: "company",
        name: "Creative",
        googleId: "FOLDERID12345678",
        sheetGid: null,
        credentialId: "c1",
        ownerId: "admin1",
        status: "active",
        sharedDriveId: null,
        config: { recursiveDepth: 2 } as never,
      },
    ],
    drivePublicAvailable: true,
    apifyTokens: [],
    ...over,
  }
}

function driveFile(over: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "FILEID1234567890",
    name: "video.mp4",
    mimeType: "video/mp4",
    sizeBytes: SIZE,
    md5: "abc",
    headRevisionId: null,
    version: "3",
    modifiedTime: null,
    parents: [],
    trashed: false,
    driveId: null,
    width: null,
    height: null,
    durationMs: null,
    canDownload: true,
    canEdit: false,
    resourceKey: null,
    shortcut: null,
    ...over,
  }
}

const claim = vi.mocked(jobs.claimUploadJob)
const update = vi.mocked(jobs.updateUploadJob)
const loadGrant = vi.mocked(recheck.loadGrantForMcpId)
const loadCred = vi.mocked(store.loadDriveCredential)
const apiKeyAuth = vi.mocked(store.systemApiKeyAuth)
const getFile = vi.mocked(files.getDriveFile)
const readRange = vi.mocked(files.readDriveRange)
const record = vi.mocked(uploads.recordMediaUpload)
const touch = vi.mocked(jobs.touchUploadJob)
const ancestorIn = vi.mocked(files.findAncestorIn)
const loadBlocked = vi.mocked(blockedMod.loadBlockedFolderIds)
const insertLog = vi.mocked(logWriter.insertMcpLogNow)
const getProvider = vi.mocked(providers.getProvider)
const uploadChunked =
  vi.fn<(ctx: unknown, r: ChunkedVideoUploadRequest) => Promise<unknown>>()

function ctx(signal = new AbortController().signal) {
  return { jobId: "pgboss-1", signal, log: vi.fn() }
}

beforeEach(() => {
  claim.mockResolvedValue(jobRow())
  loadGrant.mockResolvedValue(grant())
  loadCred.mockResolvedValue({
    id: "c1",
    status: "active",
    deletedAt: null,
  } as never)
  apiKeyAuth.mockResolvedValue({ type: "api_key", apiKey: "AIza-test" })
  getFile.mockResolvedValue(driveFile())
  update.mockResolvedValue(true)
  touch.mockResolvedValue(true)
  ancestorIn.mockResolvedValue("FOLDERID12345678")
  loadBlocked.mockResolvedValue(new Set())
  readRange.mockImplementation(async (_a, _f, s, e) => Buffer.alloc(e - s))
  uploadChunked.mockImplementation(async (_c, r) => {
    await r.readChunk(0, 1024)
    r.onProgress?.(SIZE / 2)
    r.onProgress?.(SIZE)
    return { type: "video", id: "vid_123" }
  })
  getProvider.mockReturnValue({
    platform: "meta",
    uploadVideoChunked: uploadChunked,
  } as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("media.video_upload", () => {
  it("is registered without retries and a 2 h expiry", async () => {
    expect(mediaVideoUploadJob.name).toBe("media.video_upload")
    expect(mediaVideoUploadJob.queue).toMatchObject({
      retryLimit: 0,
      expireInSeconds: 7200,
    })
    expect(mediaVideoUploadJob.cron).toBeUndefined()
    const { JOBS } = await import("./index")
    expect(JOBS).toContain(mediaVideoUploadJob)
  })

  it("uploads in chunks read from Drive and records the media id", async () => {
    const out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out).toEqual({ jobId: JOB_ID, status: "done", processing: false })
    expect(claim).toHaveBeenCalledWith(JOB_ID)
    expect(loadGrant).toHaveBeenCalledWith("m1", { fresh: true })
    // provider context of the owner (connection re-checked by the factory)
    expect(context.providerContextFactory).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "u1", ownerIsAdmin: false })
    )
    const [, req] = uploadChunked.mock.calls[0]!
    expect(req).toMatchObject({
      fileName: "video.mp4",
      sizeBytes: SIZE,
      md5: "abc",
      contentType: "video/mp4",
      name: "Video 1",
    })
    expect(req.deadlineAt).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(readRange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service_account" }),
      "FILEID1234567890",
      0,
      1024,
      expect.objectContaining({ resourceKey: "rk-1" })
    )
    // progress: the first half is throttled into one write, completion → processing
    // every write is conditional on the row still running (never resurrects a job failed by the stale sweep)
    expect(update).toHaveBeenCalledWith(
      JOB_ID,
      { uploadedBytes: SIZE / 2 },
      RUNNING
    )
    expect(update).toHaveBeenCalledWith(
      JOB_ID,
      { uploadedBytes: SIZE, status: "processing" },
      RUNNING
    )
    expect(update).toHaveBeenLastCalledWith(
      JOB_ID,
      {
        status: "done",
        uploadedBytes: SIZE,
        mediaId: "vid_123",
        errorCode: null,
        errorMessage: null,
      },
      RUNNING
    )
    // T-1: the file is still inside the granted folder (other users' personal folders pruned)
    expect(loadBlocked).toHaveBeenCalledWith({ id: "u1", role: "staff" })
    expect(ancestorIn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service_account" }),
      expect.objectContaining({ id: "FILEID1234567890" }),
      new Set(["FOLDERID12345678"]),
      expect.objectContaining({ blocked: expect.any(Set) })
    )
    // T-8: one audit row for the platform write
    expect(insertLog).toHaveBeenCalledTimes(1)
    expect(insertLog.mock.calls[0]![0]).toMatchObject({
      mcpId: "m1",
      mcpName: "MCP",
      ownerId: "u1",
      ownerEmail: "u1@example.test",
      toolName: "media.video_upload",
      actionKind: "write",
      status: "success",
      platform: "meta",
      adAccountId: "act_1",
      objectIds: [JOB_ID, "FILEID1234567890", "vid_123"],
      changes: [
        expect.objectContaining({
          object_id: "vid_123",
          field: "media_uploaded",
        }),
      ],
    })
    expect(logWriter.flushMcpLogs).toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith({
      adAccountId: "a1",
      driveFileId: "FILEID1234567890",
      contentKey: `md5:abc:${SIZE}`,
      mediaType: "video",
      mediaId: "vid_123",
      mediaUrl: null,
      sizeBytes: SIZE,
      sourceId: "s1",
      mcpId: "m1",
    })
  })

  it("still processing at the deadline → done with the media id (usable)", async () => {
    uploadChunked.mockResolvedValueOnce({
      type: "video",
      id: "vid_9",
      processing: true,
    })
    const out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out).toMatchObject({ status: "done", processing: true })
    expect(update).toHaveBeenLastCalledWith(
      JOB_ID,
      expect.objectContaining({
        status: "done",
        mediaId: "vid_9",
        errorMessage: null,
      }),
      RUNNING
    )
  })

  it("skips invalid ids and jobs that cannot be claimed", async () => {
    expect(await runVideoUploadJob({ jobId: "nope" }, ctx())).toMatchObject({
      status: "skipped",
    })
    expect(claim).not.toHaveBeenCalled()
    claim.mockResolvedValueOnce(null)
    expect(await runVideoUploadJob({ jobId: JOB_ID }, ctx())).toMatchObject({
      status: "skipped",
    })
    expect(update).not.toHaveBeenCalled()
  })

  it.each([
    [
      "MCP unusable",
      () => loadGrant.mockResolvedValueOnce(null),
      "mcp_unavailable",
    ],
    [
      "account removed",
      () => loadGrant.mockResolvedValueOnce(grant({ accounts: [] })),
      "account_not_in_scope",
    ],
    [
      "create permission removed",
      () =>
        loadGrant.mockResolvedValueOnce(
          grant({ permissions: { meta: ["read"] } })
        ),
      "account_not_in_scope",
    ],
    [
      "source no longer granted",
      () => loadGrant.mockResolvedValueOnce(grant({ driveSources: [] })),
      "drive_not_in_scope",
    ],
    [
      "public links switched off",
      () => {
        claim.mockResolvedValueOnce(
          jobRow({ access: { type: "api_key" }, sourceId: null })
        )
        loadGrant.mockResolvedValueOnce(
          grant({
            settings: { ...DEFAULT_MCP_SETTINGS, drivePublicLinks: false },
          })
        )
      },
      "drive_not_in_scope",
    ],
    [
      "credential disabled",
      () =>
        loadCred.mockResolvedValueOnce({
          id: "c1",
          status: "disabled",
          deletedAt: null,
        } as never),
      "drive_unavailable",
    ],
    [
      "file replaced on Drive",
      () => getFile.mockResolvedValueOnce(driveFile({ md5: "other" })),
      "file_changed",
    ],
    [
      "file trashed",
      () => getFile.mockResolvedValueOnce(driveFile({ trashed: true })),
      "file_changed",
    ],
    [
      "file moved out of the granted folder / behind another user's personal folder (T-1)",
      () => ancestorIn.mockResolvedValueOnce(null),
      "drive_not_in_scope",
    ],
    [
      "platform without chunked upload",
      () => getProvider.mockReturnValueOnce({ platform: "meta" } as never),
      "unsupported",
    ],
  ])(
    "%s → failed with a Vietnamese message, no upload",
    async (_l, setup, code) => {
      setup()
      const out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
      expect(out).toMatchObject({ status: "failed", errorCode: code })
      expect(uploadChunked).not.toHaveBeenCalled()
      expect(record).not.toHaveBeenCalled()
      const patch = update.mock.calls.at(-1)![1]
      expect(patch).toMatchObject({ status: "failed", errorCode: code })
      expect(patch.errorMessage).toMatch(/[ăâđêôơư]/i)
      expect(update.mock.calls.at(-1)![2]).toEqual(RUNNING)
      // the failure is audited too (denied for scope problems), without a media id
      expect(insertLog).toHaveBeenCalledTimes(1)
      expect(insertLog.mock.calls[0]![0]).toMatchObject({
        status:
          code.endsWith("in_scope") || code === "mcp_unavailable"
            ? "denied"
            : "error",
        errorCode: code,
        changes: [expect.objectContaining({ field: "media_upload_failed" })],
      })
    }
  )

  it("T-3: a heartbeat moves updated_at while a chunk makes no progress; a row failed by the sweep stops the upload and is never overwritten", async () => {
    vi.useFakeTimers()
    try {
      let seenAbort = false
      uploadChunked.mockImplementationOnce(
        (_c, r) =>
          new Promise((_resolve, reject) => {
            r.signal?.addEventListener("abort", () => {
              seenAbort = true
              reject(new DOMException("aborted", "AbortError"))
            })
          })
      )
      // 1st heartbeat: still running; 2nd: the stale sweep failed the row meanwhile
      touch.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const run = runVideoUploadJob({ jobId: JOB_ID }, ctx())
      await vi.advanceTimersByTimeAsync(VIDEO_HEARTBEAT_MS)
      expect(touch).toHaveBeenCalledTimes(1)
      expect(seenAbort).toBe(false)
      await vi.advanceTimersByTimeAsync(VIDEO_HEARTBEAT_MS)
      const out = await run
      expect(touch).toHaveBeenCalledTimes(2)
      expect(seenAbort).toBe(true)
      expect(out).toMatchObject({ status: "failed", errorCode: "stale" })
      // the failed row is left as the sweep wrote it
      expect(update).not.toHaveBeenCalledWith(
        JOB_ID,
        expect.objectContaining({ status: "failed" }),
        expect.anything()
      )
      expect(insertLog.mock.calls[0]![0]).toMatchObject({
        status: "error",
        errorCode: "stale",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("T-3: the upload finished after the sweep failed the row → no done written, the media id is only logged / kept for reuse", async () => {
    // progress writes still succeed; the final conditional done finds the row failed
    update.mockImplementation(async (_id, patch) => patch.status !== "done")
    const out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out).toMatchObject({
      status: "failed",
      errorCode: "job_already_failed",
    })
    expect(update).toHaveBeenLastCalledWith(
      JOB_ID,
      expect.objectContaining({ status: "done" }),
      RUNNING
    )
    expect(update).not.toHaveBeenCalledWith(
      JOB_ID,
      expect.objectContaining({ status: "failed" }),
      expect.anything()
    )
    expect(record).toHaveBeenCalled()
    expect(insertLog.mock.calls[0]![0]).toMatchObject({
      status: "error",
      errorCode: "job_already_failed",
      objectIds: [JOB_ID, "FILEID1234567890", "vid_123"],
    })
  })

  it("provider / Drive errors keep their Vietnamese message, never secrets", async () => {
    uploadChunked.mockRejectedValueOnce(
      new ProviderError({
        platform: "meta",
        code: "invalid_request",
        message: "Graph error access_token=EAAB123secret",
        userMessageVi: "Meta từ chối video (định dạng không hỗ trợ).",
      })
    )
    let out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out).toMatchObject({
      status: "failed",
      errorCode: "provider_invalid_request",
    })
    let patch = update.mock.calls.at(-1)![1]
    expect(patch.errorMessage).toBe(
      "Meta từ chối video (định dạng không hỗ trợ)."
    )
    expect(JSON.stringify(update.mock.calls)).not.toContain("EAAB123secret")

    readRange.mockRejectedValueOnce(new DriveError("rate_limited"))
    out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out).toMatchObject({ errorCode: "drive_rate_limited" })

    uploadChunked.mockRejectedValueOnce(
      new Error(
        "socket hang up https://graph-video.facebook.com/x?access_token=EAAB"
      )
    )
    out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out).toMatchObject({ errorCode: "internal" })
    patch = update.mock.calls.at(-1)![1]
    expect(patch.errorMessage).not.toMatch(/facebook|access_token/)
  })

  it("worker shutdown → failed as interrupted; the upload sees the abort", async () => {
    const ac = new AbortController()
    uploadChunked.mockImplementationOnce(async (_c, r) => {
      ac.abort()
      expect(r.signal?.aborted).toBe(true)
      throw new DOMException("aborted", "AbortError")
    })
    const out = await runVideoUploadJob({ jobId: JOB_ID }, ctx(ac.signal))
    expect(out).toMatchObject({ status: "failed", errorCode: "interrupted" })
  })

  it("api_key jobs read Drive with the system API key", async () => {
    claim.mockResolvedValueOnce(
      jobRow({ access: { type: "api_key" }, sourceId: null })
    )
    const out = await runVideoUploadJob({ jobId: JOB_ID }, ctx())
    expect(out.status).toBe("done")
    expect(readRange.mock.calls[0]![0]).toMatchObject({ type: "api_key" })
    expect(loadCred).not.toHaveBeenCalled()
  })

  it("videoUploadFailure maps unknown errors to a generic message", () => {
    expect(videoUploadFailure(new Error("x")).code).toBe("internal")
    expect(videoUploadFailure(new Error("x"), true).code).toBe("interrupted")
  })
})
