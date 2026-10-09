// media.video_upload against the test Postgres (skipped without DATABASE_URL): real job rows, grant, credential and
// media reuse table; Google Drive reads and the ad platform are mocked (no network).
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { db } from "@/server/db/client"
import { flushMcpLogs } from "@/server/audit/mcp-log-writer"
import {
  adAccounts,
  connections,
  driveCredentials,
  driveMediaUploads,
  driveSources,
  mcpAccountScopes,
  mcpCallLogs,
  mcpDriveScopes,
  mcpPlatformPermissions,
  mcpServers,
  mediaUploadJobs,
  user,
} from "@/server/db/schema"
import type { DriveFile } from "@/server/drive/types"
import type { ChunkedVideoUploadRequest } from "@/server/providers/types"

vi.mock("@/server/drive/files", () => ({
  getDriveFile: vi.fn(),
  readDriveRange: vi.fn(async (_a: unknown, _f: string, s: number, e: number) =>
    Buffer.alloc(e - s)
  ),
  driveContentKey: (f: DriveFile) =>
    f.md5 && f.sizeBytes !== null ? `md5:${f.md5}:${f.sizeBytes}` : null,
  // the fake Drive: a file sits directly in its parents
  findAncestorIn: vi.fn(
    async (
      _a: unknown,
      f: DriveFile,
      candidates: ReadonlySet<string>,
      o?: { blocked?: ReadonlySet<string> }
    ) => f.parents.find((p) => candidates.has(p) && !o?.blocked?.has(p)) ?? null
  ),
}))
vi.mock("@/server/mcp/context", () => ({
  providerContextFactory: vi.fn(() =>
    Object.assign(
      vi.fn(async (account: { id: string }) => ({
        connectionId: "conn",
        credentials: {},
        connectionMeta: {},
        account,
      })),
      { touched: new Set(), connection: vi.fn() }
    )
  ),
}))
const uploadChunked =
  vi.fn<(ctx: unknown, r: ChunkedVideoUploadRequest) => Promise<unknown>>()
vi.mock("@/server/providers", () => ({
  ensureProvidersRegistered: vi.fn(),
  getProvider: vi.fn(() => ({
    platform: "meta",
    uploadVideoChunked: uploadChunked,
  })),
}))

const files = await import("@/server/drive/files")
const { createUploadJob, getUploadJob } =
  await import("@/server/drive/upload-jobs")
const { encryptServiceAccount } = await import("@/server/drive/store")
const { generateKeyPairSync } = await import("node:crypto")
const { runVideoUploadJob } = await import("./media-video-upload")

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-video-job-${randomUUID().slice(0, 8)}`
const owner = { id: `${PREFIX}-owner`, email: `${PREFIX}-o@test.local` }
const SIZE = 40 * 1024 * 1024

describe.skipIf(!HAS_DB)("media.video_upload (DB)", () => {
  let mcpId = ""
  let adAccountId = ""
  let credentialId = ""
  let sourceId = ""

  beforeAll(async () => {
    await db.insert(user).values({
      id: owner.id,
      name: owner.id,
      email: owner.email,
      role: "staff",
      emailVerified: true,
    })
    mcpId = randomUUID()
    await db.insert(mcpServers).values({
      id: mcpId,
      ownerId: owner.id,
      name: `${PREFIX} mcp`,
      keyHash: `h-${mcpId}`,
      keyPrefix: "amcp_x",
      keyEncrypted: "v1.x.y.z",
    })
    await db
      .insert(mcpPlatformPermissions)
      .values({ mcpId, platform: "meta", permissions: ["read", "create"] })
    const [conn] = await db
      .insert(connections)
      .values({
        ownerId: owner.id,
        platform: "meta",
        name: `${PREFIX} conn`,
        credentialsEncrypted: "v1.x.y.z",
      })
      .returning({ id: connections.id })
    const [acc] = await db
      .insert(adAccounts)
      .values({
        connectionId: conn!.id,
        platform: "meta",
        externalId: `act_${PREFIX}`,
        name: "acc",
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
      })
      .returning({ id: adAccounts.id })
    adAccountId = acc!.id
    await db
      .insert(mcpAccountScopes)
      .values({ mcpId, connectionId: conn!.id, adAccountId })
    credentialId = randomUUID()
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    await db.insert(driveCredentials).values({
      id: credentialId,
      kind: "personal",
      ownerId: owner.id,
      credentialsEncrypted: encryptServiceAccount(credentialId, {
        clientEmail: "x@p.iam.gserviceaccount.com",
        privateKey,
        privateKeyId: null,
        projectId: null,
      }),
      clientEmail: "x@p.iam.gserviceaccount.com",
    })
    const [src] = await db
      .insert(driveSources)
      .values({
        ownerId: owner.id,
        credentialId,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-folder`,
        name: "folder",
      })
      .returning({ id: driveSources.id })
    sourceId = src!.id
    await db.insert(mcpDriveScopes).values({ mcpId, sourceId })
  })

  afterAll(async () => {
    await db.delete(mcpServers).where(eq(mcpServers.ownerId, owner.id))
    await db.delete(connections).where(eq(connections.ownerId, owner.id))
    await db.delete(driveSources).where(eq(driveSources.ownerId, owner.id))
    await db
      .delete(driveCredentials)
      .where(eq(driveCredentials.ownerId, owner.id))
    await db.delete(user).where(eq(user.id, owner.id))
  })

  const fileId = () => `${PREFIX}-file-${randomUUID().slice(0, 6)}`
  const driveFile = (
    id: string,
    md5 = "abc",
    parents = [`${PREFIX}-folder`]
  ): DriveFile => ({
    id,
    name: "v.mp4",
    mimeType: "video/mp4",
    sizeBytes: SIZE,
    md5,
    headRevisionId: null,
    version: "1",
    modifiedTime: null,
    parents,
    trashed: false,
    driveId: null,
    width: null,
    height: null,
    durationMs: null,
    canDownload: true,
    canEdit: false,
    resourceKey: null,
    shortcut: null,
  })
  const newJob = (driveFileId: string) =>
    createUploadJob({
      mcpId,
      adAccountId,
      platform: "meta",
      driveFileId,
      contentKey: `md5:abc:${SIZE}`,
      sourceId,
      access: { type: "service_account", credentialId },
      resourceKey: "0-RK",
      fileName: "v.mp4",
      contentType: "video/mp4",
      sizeBytes: SIZE,
      md5: "abc",
      name: "Video",
    })
  const ctx = () => ({
    jobId: "pg-1",
    signal: new AbortController().signal,
    log: () => {},
  })

  it("queued → processing → done; media reuse row written; a second run is a no-op", async () => {
    const id = fileId()
    vi.mocked(files.getDriveFile).mockResolvedValue(driveFile(id))
    const seen: string[] = []
    uploadChunked.mockImplementationOnce(async (_c, r) => {
      const chunk = await r.readChunk(0, 1024)
      expect(chunk.length).toBe(1024)
      r.onProgress?.(SIZE / 2)
      seen.push((await getUploadJob(jobId, mcpId))!.status)
      r.onProgress?.(SIZE)
      return { type: "video", id: "vid_int_1", processing: true }
    })
    const { job } = await newJob(id)
    const jobId = job.id
    expect(job.status).toBe("queued")

    const out = await runVideoUploadJob({ jobId }, ctx())
    expect(out).toEqual({ jobId, status: "done", processing: true })
    expect(seen).toEqual(["uploading"])
    expect(vi.mocked(files.readDriveRange).mock.calls[0]![4]).toMatchObject({
      resourceKey: "0-RK",
    })
    const done = await getUploadJob(jobId, mcpId)
    expect(done).toMatchObject({
      status: "done",
      mediaId: "vid_int_1",
      uploadedBytes: SIZE,
      errorMessage: null,
    })
    expect(done!.finishedAt).not.toBeNull()
    // T-6: the resource key is wiped once the job is finished
    const [raw] = await db
      .select({ rk: mediaUploadJobs.resourceKeyEncrypted })
      .from(mediaUploadJobs)
      .where(eq(mediaUploadJobs.id, jobId))
    expect(raw!.rk).toBeNull()
    // T-8: the platform write is in mcp_call_logs (synchronous insert, no secrets)
    await flushMcpLogs()
    const logs = await db
      .select()
      .from(mcpCallLogs)
      .where(
        and(
          eq(mcpCallLogs.mcpId, mcpId),
          eq(mcpCallLogs.toolName, "media.video_upload")
        )
      )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      mcpName: `${PREFIX} mcp`,
      ownerId: owner.id,
      ownerEmail: owner.email,
      actionKind: "write",
      status: "success",
      platform: "meta",
      adAccountId: `act_${PREFIX}`,
      objectIds: [jobId, id, "vid_int_1"],
    })
    expect(logs[0]!.changes).toEqual([
      expect.objectContaining({
        object_id: "vid_int_1",
        field: "media_uploaded",
      }),
    ])
    expect(JSON.stringify(logs[0])).not.toContain("0-RK")
    const [reuse] = await db
      .select()
      .from(driveMediaUploads)
      .where(eq(driveMediaUploads.driveFileId, id))
    expect(reuse).toMatchObject({
      adAccountId,
      mediaId: "vid_int_1",
      mediaType: "video",
      mediaUrl: null,
      sourceId,
      firstMcpId: mcpId,
    })
    // pg-boss redelivery / duplicate message: not claimable any more
    expect(await runVideoUploadJob({ jobId }, ctx())).toMatchObject({
      status: "skipped",
    })
    expect(uploadChunked).toHaveBeenCalledTimes(1)
  })

  it("T-1: a file moved out of the granted folder before the job runs → failed drive_not_in_scope, nothing uploaded", async () => {
    uploadChunked.mockClear()
    const id = fileId()
    vi.mocked(files.getDriveFile).mockResolvedValue(
      driveFile(id, "abc", ["SOMEWHERE_ELSE_123"])
    )
    const { job } = await newJob(id)
    const out = await runVideoUploadJob({ jobId: job.id }, ctx())
    expect(out).toMatchObject({
      status: "failed",
      errorCode: "drive_not_in_scope",
    })
    expect(uploadChunked).not.toHaveBeenCalled()
    await flushMcpLogs()
    const [log] = await db
      .select()
      .from(mcpCallLogs)
      .where(
        and(
          eq(mcpCallLogs.mcpId, mcpId),
          eq(mcpCallLogs.toolName, "media.video_upload"),
          eq(mcpCallLogs.status, "denied")
        )
      )
    expect(log).toMatchObject({ errorCode: "drive_not_in_scope" })
  })

  it("source removed from the MCP before the job runs → failed, nothing uploaded", async () => {
    uploadChunked.mockClear()
    const id = fileId()
    vi.mocked(files.getDriveFile).mockResolvedValue(driveFile(id))
    const { job } = await newJob(id)
    await db.delete(mcpDriveScopes).where(eq(mcpDriveScopes.mcpId, mcpId))
    try {
      const out = await runVideoUploadJob({ jobId: job.id }, ctx())
      expect(out).toMatchObject({
        status: "failed",
        errorCode: "drive_not_in_scope",
      })
    } finally {
      await db.insert(mcpDriveScopes).values({ mcpId, sourceId })
    }
    expect(uploadChunked).not.toHaveBeenCalled()
    const [row] = await db
      .select()
      .from(mediaUploadJobs)
      .where(eq(mediaUploadJobs.id, job.id))
    expect(row).toMatchObject({
      status: "failed",
      errorCode: "drive_not_in_scope",
    })
    expect(row!.errorMessage).toMatch(/Google Drive/)
    expect(row!.finishedAt).not.toBeNull()
  })
})
