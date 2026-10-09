// media_upload_jobs (background video uploads) + loadBlockedFolderIds against the test Postgres
// (skipped without DATABASE_URL).
import { randomUUID } from "node:crypto"
import { eq, inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { db } from "@/server/db/client"
import {
  adAccounts,
  connections,
  driveCredentials,
  driveSources,
  mcpServers,
  mediaUploadJobs,
  user,
} from "@/server/db/schema"

import { loadBlockedFolderIds } from "./blocked"
import { encryptServiceAccount } from "./store"
import {
  claimUploadJob,
  createUploadJob,
  decryptUploadJobResourceKey,
  deleteOldUploadJobs,
  failStaleUploadJobs,
  getUploadJob,
  isUploadJobLimitError,
  listUploadJobs,
  loadUploadJob,
  loadUploadJobAuditInfo,
  touchUploadJob,
  updateUploadJob,
  UPLOAD_JOB_LIMITS,
  UPLOAD_JOB_QUEUED_MAX_MS,
  uploadJobLimitHit,
  type CreateUploadJobInput,
} from "./upload-jobs"

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-upjobs-${randomUUID().slice(0, 8)}`
const owner = { id: `${PREFIX}-owner`, email: `${PREFIX}-o@test.local` }
const other = { id: `${PREFIX}-other`, email: `${PREFIX}-x@test.local` }
const savedLimits = { ...UPLOAD_JOB_LIMITS }

describe.skipIf(!HAS_DB)("media upload jobs (DB)", () => {
  let mcpId = ""
  let mcp2 = ""
  let adAccountId = ""
  let credentialId = ""
  let sourceId = ""

  beforeAll(async () => {
    // the generic tests below create many jobs of one MCP: caps are tested on their own (raised here)
    Object.assign(UPLOAD_JOB_LIMITS, {
      perMcp: 1_000,
      perOwner: 1_000,
      systemQueued: 100_000,
    })
    await db.insert(user).values(
      [owner, other].map((u) => ({
        id: u.id,
        name: u.id,
        email: u.email,
        role: "staff",
        emailVerified: true,
      }))
    )
    mcpId = randomUUID()
    mcp2 = randomUUID()
    await db.insert(mcpServers).values(
      [mcpId, mcp2].map((id) => ({
        id,
        ownerId: owner.id,
        name: `${PREFIX} ${id}`,
        keyHash: `h-${id}`,
        keyPrefix: "amcp_x",
        keyEncrypted: "v1.x.y.z",
      }))
    )
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
    credentialId = randomUUID()
    await db.insert(driveCredentials).values({
      id: credentialId,
      kind: "personal",
      ownerId: owner.id,
      credentialsEncrypted: encryptServiceAccount(credentialId, {
        clientEmail: "x@p.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
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
  })

  afterAll(async () => {
    Object.assign(UPLOAD_JOB_LIMITS, savedLimits)
    await db
      .delete(mcpServers)
      .where(inArray(mcpServers.ownerId, [owner.id, other.id]))
    await db.delete(connections).where(eq(connections.ownerId, owner.id))
    await db
      .delete(driveSources)
      .where(inArray(driveSources.ownerId, [owner.id, other.id]))
    await db
      .delete(driveCredentials)
      .where(eq(driveCredentials.ownerId, owner.id))
    await db.delete(user).where(inArray(user.id, [owner.id, other.id]))
  })

  let n = 0
  function input(
    extra: Partial<CreateUploadJobInput> = {}
  ): CreateUploadJobInput {
    n++
    return {
      mcpId,
      adAccountId,
      platform: "meta",
      driveFileId: `${PREFIX}-file-${n}`,
      contentKey: `md5:abc${n}:300000000`,
      sourceId,
      access: { type: "service_account", credentialId },
      resourceKey: null,
      fileName: "Video lớn.mp4",
      contentType: "video/mp4",
      sizeBytes: 300_000_000,
      md5: `abc${n}`,
      name: "Video tuần 41",
      ...extra,
    }
  }

  async function backdate(
    id: string,
    column: "updated_at" | "finished_at",
    ms: number
  ) {
    await db.execute(
      sql`update media_upload_jobs set ${sql.raw(column)} = now() - make_interval(secs => ${ms / 1000}::double precision) where id = ${id}`
    )
  }

  it("create: queued job, resource key encrypted with the job id AAD, view without secrets", async () => {
    const { job, existing } = await createUploadJob(
      input({ resourceKey: "0-RkEyJob" })
    )
    expect(existing).toBe(false)
    expect(job).toMatchObject({
      mcpId,
      adAccountId,
      platform: "meta",
      status: "queued",
      uploadedBytes: 0,
      sizeBytes: 300_000_000,
      mediaId: null,
      finishedAt: null,
    })
    expect(JSON.stringify(job)).not.toContain("0-RkEyJob")
    expect(job).not.toHaveProperty("resourceKeyEncrypted")
    const row = await loadUploadJob(job.id)
    expect(row!.resourceKeyEncrypted).not.toContain("0-RkEyJob")
    expect(decryptUploadJobResourceKey(row!)).toBe("0-RkEyJob")
    expect(() =>
      decryptUploadJobResourceKey({ ...row!, id: randomUUID() })
    ).toThrow("cannot be decrypted")
    expect(row!.access).toEqual({ type: "service_account", credentialId })
    expect(row!.sourceId).toBe(sourceId)
    // public link job: api_key access, no credential
    const pub = await createUploadJob(
      input({ access: { type: "api_key" }, sourceId: null })
    )
    expect((await loadUploadJob(pub.job.id))!.access).toEqual({
      type: "api_key",
    })
  })

  it("dedupe: an ACTIVE job for the same account + file version is returned (existing), a finished one is not", async () => {
    const base = input()
    const first = await createUploadJob(base)
    const again = await createUploadJob({ ...base, mcpId: mcp2 })
    expect(again).toEqual({ job: first.job, existing: true })
    // parallel creates → exactly one row
    const many = await Promise.all(
      Array.from({ length: 5 }, () => createUploadJob(base))
    )
    expect(new Set(many.map((r) => r.job.id))).toEqual(new Set([first.job.id]))
    // a new content key (file replaced) is another job
    const v2 = await createUploadJob({ ...base, contentKey: "md5:zzz:1" })
    expect(v2.existing).toBe(false)
    // finished → a new upload may start
    await updateUploadJob(first.job.id, { status: "failed", errorMessage: "x" })
    const retry = await createUploadJob(base)
    expect(retry.existing).toBe(false)
    expect(retry.job.id).not.toBe(first.job.id)
  })

  it("claim: queued → uploading once (attempts + 1); progress / done set finished_at", async () => {
    const { job } = await createUploadJob(input())
    const claimed = await claimUploadJob(job.id)
    expect(claimed).toMatchObject({ status: "uploading", attempts: 1 })
    expect(await claimUploadJob(job.id)).toBeNull()
    expect(await claimUploadJob("not-a-uuid")).toBeNull()
    await updateUploadJob(job.id, { uploadedBytes: 100_000_000 })
    let v = await getUploadJob(job.id, mcpId)
    expect(v).toMatchObject({ status: "uploading", uploadedBytes: 100_000_000 })
    await updateUploadJob(job.id, { status: "processing", mediaId: "vid_1" })
    v = await getUploadJob(job.id, mcpId)
    expect(v).toMatchObject({
      status: "processing",
      mediaId: "vid_1",
      finishedAt: null,
    })
    await updateUploadJob(job.id, {
      status: "done",
      uploadedBytes: 300_000_000,
      errorMessage: "y".repeat(2000),
    })
    v = await getUploadJob(job.id, mcpId)
    expect(v!.status).toBe("done")
    expect(v!.finishedAt).not.toBeNull()
    expect(v!.errorMessage).toHaveLength(500)
    await expect(
      updateUploadJob(job.id, { uploadedBytes: -1 })
    ).rejects.toThrow()
  })

  it("get / list are scoped to the MCP, newest first, bounded", async () => {
    const { job } = await createUploadJob(input({ mcpId: mcp2 }))
    expect(await getUploadJob(job.id, mcp2)).not.toBeNull()
    expect(await getUploadJob(job.id, mcpId)).toBeNull()
    expect(await getUploadJob("x", mcp2)).toBeNull()
    const list = await listUploadJobs(mcpId)
    expect(list.length).toBeGreaterThan(0)
    expect(list.length).toBeLessThanOrEqual(10)
    expect(list.every((j) => j.mcpId === mcpId)).toBe(true)
    const times = list.map((j) => j.createdAt)
    expect([...times].sort().reverse()).toEqual(times)
    expect(await listUploadJobs(mcpId, { limit: 1 })).toHaveLength(1)
    expect(
      (await listUploadJobs(mcpId, { limit: 999 })).length
    ).toBeLessThanOrEqual(50)
    expect(await listUploadJobs("nope")).toEqual([])
  })

  it("failStaleUploadJobs: silent uploading / processing jobs and very old queued jobs fail with a Vietnamese message", async () => {
    const stale = (await createUploadJob(input())).job
    await claimUploadJob(stale.id)
    await backdate(stale.id, "updated_at", 31 * 60_000)
    const fresh = (await createUploadJob(input())).job
    await claimUploadJob(fresh.id)
    const queuedOld = (await createUploadJob(input())).job
    await backdate(
      queuedOld.id,
      "updated_at",
      UPLOAD_JOB_QUEUED_MAX_MS + 60_000
    )
    const queuedNew = (await createUploadJob(input())).job
    await backdate(queuedNew.id, "updated_at", 31 * 60_000)

    expect(await failStaleUploadJobs(30 * 60_000)).toBeGreaterThanOrEqual(2)
    const s = await getUploadJob(stale.id, mcpId)
    expect(s).toMatchObject({
      status: "failed",
      errorCode: "stale",
      errorMessage: driveUi.service.uploadJobStale,
    })
    expect(s!.finishedAt).not.toBeNull()
    expect((await getUploadJob(fresh.id, mcpId))!.status).toBe("uploading")
    expect(await getUploadJob(queuedOld.id, mcpId)).toMatchObject({
      status: "failed",
      errorCode: "expired",
    })
    expect((await getUploadJob(queuedNew.id, mcpId))!.status).toBe("queued")
  })

  it("deleteOldUploadJobs: only finished jobs older than the limit", async () => {
    const old = (await createUploadJob(input())).job
    await updateUploadJob(old.id, { status: "done" })
    await backdate(old.id, "finished_at", 31 * 86_400_000)
    const recent = (await createUploadJob(input())).job
    await updateUploadJob(recent.id, { status: "failed" })
    const active = (await createUploadJob(input())).job
    await backdate(active.id, "updated_at", 31 * 86_400_000)
    expect(await deleteOldUploadJobs(30 * 86_400_000)).toBeGreaterThanOrEqual(1)
    expect(await loadUploadJob(old.id)).toBeNull()
    expect(await loadUploadJob(recent.id)).not.toBeNull()
    expect(await loadUploadJob(active.id)).not.toBeNull()
  })

  it("DB constraints: access ↔ credential, status values; cascade with the MCP; source delete sets null", async () => {
    const bad = {
      mcpId,
      adAccountId,
      platform: "meta" as const,
      driveFileId: "f",
      contentKey: "k",
      fileName: "a.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    }
    await expect(
      db.insert(mediaUploadJobs).values({ ...bad, access: "service_account" })
    ).rejects.toThrow()
    await expect(
      db
        .insert(mediaUploadJobs)
        .values({ ...bad, access: "api_key", credentialId })
    ).rejects.toThrow()
    await expect(
      db
        .insert(mediaUploadJobs)
        .values({ ...bad, access: "api_key", status: "weird" })
    ).rejects.toThrow()

    const [tmp] = await db
      .insert(driveSources)
      .values({
        ownerId: owner.id,
        credentialId,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-tmp`,
        name: "tmp",
      })
      .returning({ id: driveSources.id })
    const viaTmp = (await createUploadJob(input({ sourceId: tmp!.id }))).job
    await db.delete(driveSources).where(eq(driveSources.id, tmp!.id))
    expect((await loadUploadJob(viaTmp.id))!.sourceId).toBeNull()

    const { job } = await createUploadJob(input({ mcpId: mcp2 }))
    await db.delete(mcpServers).where(eq(mcpServers.id, mcp2))
    expect(await loadUploadJob(job.id)).toBeNull()
  })

  it("loadBlockedFolderIds: other people's live personal FOLDERS for staff, nothing for admins", async () => {
    const values = [
      // other's personal folder → blocked
      {
        ownerId: other.id,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-o-folder`,
      },
      // other's personal sheet → not a folder
      {
        ownerId: other.id,
        kind: "sheet",
        scope: "personal",
        googleId: `${PREFIX}-o-sheet`,
        sheetGid: 0,
      },
      // other's deleted personal folder → gone
      {
        ownerId: other.id,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-o-deleted`,
        deletedAt: new Date(),
      },
      // company folder (owned by other) → shared
      {
        ownerId: other.id,
        kind: "folder",
        scope: "company",
        googleId: `${PREFIX}-o-company`,
      },
      // other's personal folder in error state → still theirs
      {
        ownerId: other.id,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-o-error`,
        status: "error",
      },
    ]
    await db
      .insert(driveSources)
      .values(values.map((v) => ({ ...v, credentialId, name: v.googleId })))
    const forOwner = await loadBlockedFolderIds({ id: owner.id, role: "staff" })
    const mine = [...forOwner].filter((id) => id.startsWith(PREFIX))
    expect(mine.sort()).toEqual(
      [`${PREFIX}-o-error`, `${PREFIX}-o-folder`].sort()
    )
    // the owner's own personal folder is not blocked for the owner, but is for the other user
    expect(forOwner.has(`${PREFIX}-folder`)).toBe(false)
    expect(
      (await loadBlockedFolderIds({ id: other.id, role: "staff" })).has(
        `${PREFIX}-folder`
      )
    ).toBe(true)
    expect(
      (await loadBlockedFolderIds({ id: owner.id, role: "admin" })).size
    ).toBe(0)

    // a personal folder registered INSIDE an older company folder was already shared → not blocked;
    // one that a company folder was registered ABOVE later (H1 legacy) stays blocked
    const [company] = await db
      .select({ createdAt: driveSources.createdAt })
      .from(driveSources)
      .where(eq(driveSources.googleId, `${PREFIX}-o-company`))
    const day = 86_400_000
    await db.insert(driveSources).values([
      {
        ownerId: other.id,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-o-inside-company`,
        ancestorIds: [`${PREFIX}-o-company`, "ROOT"],
        createdAt: new Date(company!.createdAt.getTime() + day),
        credentialId,
        name: "inside",
      },
      {
        ownerId: other.id,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-o-below-later-company`,
        ancestorIds: ["X", `${PREFIX}-o-company`],
        createdAt: new Date(company!.createdAt.getTime() - day),
        credentialId,
        name: "legacy",
      },
    ])
    const again = await loadBlockedFolderIds({ id: owner.id, role: "staff" })
    expect(again.has(`${PREFIX}-o-inside-company`)).toBe(false)
    expect(again.has(`${PREFIX}-o-below-later-company`)).toBe(true)
    // the company folder deleted → the folder is private again → blocked
    await db
      .update(driveSources)
      .set({ deletedAt: new Date() })
      .where(eq(driveSources.googleId, `${PREFIX}-o-company`))
    expect(
      (await loadBlockedFolderIds({ id: owner.id, role: "staff" })).has(
        `${PREFIX}-o-inside-company`
      )
    ).toBe(true)
  })

  it("T-3: updates with expectedStatuses never touch a job the stale sweep failed; touchUploadJob = heartbeat of running jobs only", async () => {
    const { job } = await createUploadJob(input())
    // queued: not running yet → no heartbeat
    expect(await touchUploadJob(job.id)).toBe(false)
    await claimUploadJob(job.id)
    await backdate(job.id, "updated_at", 10 * 60_000)
    const before = (await loadUploadJob(job.id))!.updatedAt
    expect(await touchUploadJob(job.id)).toBe(true)
    expect(
      new Date((await loadUploadJob(job.id))!.updatedAt).getTime()
    ).toBeGreaterThan(new Date(before).getTime())
    const RUNNING = { expectedStatuses: ["uploading", "processing"] as const }
    expect(await updateUploadJob(job.id, { uploadedBytes: 5 }, RUNNING)).toBe(
      true
    )
    // the sweep fails it (no update for 31 min)
    await backdate(job.id, "updated_at", 31 * 60_000)
    expect(await failStaleUploadJobs(30 * 60_000)).toBeGreaterThanOrEqual(1)
    expect(await touchUploadJob(job.id)).toBe(false)
    expect(
      await updateUploadJob(
        job.id,
        { status: "done", mediaId: "vid_late" },
        RUNNING
      )
    ).toBe(false)
    expect(await getUploadJob(job.id, mcpId)).toMatchObject({
      status: "failed",
      errorCode: "stale",
      mediaId: null,
    })
    expect(await touchUploadJob("nope")).toBe(false)
    expect(await updateUploadJob("nope", { status: "done" })).toBe(false)
  })

  it("T-6: the resource key is wiped when a job becomes done / failed (also by the stale sweep)", async () => {
    const a = (await createUploadJob(input({ resourceKey: "0-RkA" }))).job
    const b = (await createUploadJob(input({ resourceKey: "0-RkB" }))).job
    const c = (await createUploadJob(input({ resourceKey: "0-RkC" }))).job
    await claimUploadJob(a.id)
    await updateUploadJob(a.id, { status: "processing" })
    expect((await loadUploadJob(a.id))!.resourceKeyEncrypted).not.toBeNull()
    await updateUploadJob(a.id, { status: "done", mediaId: "v" })
    expect((await loadUploadJob(a.id))!.resourceKeyEncrypted).toBeNull()
    await updateUploadJob(b.id, { status: "failed", errorCode: "x" })
    expect((await loadUploadJob(b.id))!.resourceKeyEncrypted).toBeNull()
    await claimUploadJob(c.id)
    await backdate(c.id, "updated_at", 31 * 60_000)
    await failStaleUploadJobs(30 * 60_000)
    const cRow = (await loadUploadJob(c.id))!
    expect(cRow.status).toBe("failed")
    expect(cRow.resourceKeyEncrypted).toBeNull()
  })

  it("T-8: loadUploadJobAuditInfo gives the MCP name, owner and the account's external id (no secrets)", async () => {
    const { job } = await createUploadJob(input())
    expect(await loadUploadJobAuditInfo(job.id)).toEqual({
      mcpName: `${PREFIX} ${mcpId}`,
      ownerId: owner.id,
      ownerEmail: owner.email,
      accountExternalId: `act_${PREFIX}`,
    })
    expect(await loadUploadJobAuditInfo(randomUUID())).toBeNull()
    expect(await loadUploadJobAuditInfo("x")).toBeNull()
  })

  it("M-1: at most 3 active jobs per MCP, 5 per owner over all their MCPs, 30 queued in the whole install", async () => {
    Object.assign(UPLOAD_JOB_LIMITS, savedLimits)
    expect(UPLOAD_JOB_LIMITS).toEqual({
      perMcp: 3,
      perOwner: 5,
      systemQueued: 30,
    })
    try {
      // a fresh owner with three MCPs
      const capOwner = {
        id: `${PREFIX}-cap`,
        email: `${PREFIX}-cap@test.local`,
      }
      await db.insert(user).values({
        id: capOwner.id,
        name: capOwner.id,
        email: capOwner.email,
        role: "staff",
        emailVerified: true,
      })
      const mcps = [randomUUID(), randomUUID(), randomUUID()]
      await db.insert(mcpServers).values(
        mcps.map((id) => ({
          id,
          ownerId: capOwner.id,
          name: `${PREFIX} cap ${id}`,
          keyHash: `h-${id}`,
          keyPrefix: "amcp_x",
          keyEncrypted: "v1.x.y.z",
        }))
      )
      try {
        const [m1, m2, m3] = mcps as [string, string, string]
        const first = await createUploadJob(input({ mcpId: m1 }))
        const second = await createUploadJob(input({ mcpId: m1 }))
        const third = (await createUploadJob(input({ mcpId: m1 }))).job
        await claimUploadJob(third.id) // uploading still counts as active
        expect(await uploadJobLimitHit(m1)).toMatchObject({
          kind: "mcp",
          limit: 3,
        })
        const refused = await createUploadJob(input({ mcpId: m1 })).catch(
          (e: unknown) => e
        )
        expect(isUploadJobLimitError(refused)).toBe(true)
        expect(refused).toMatchObject({ kind: "mcp" })
        // the same running file is still returned (existing) at the cap: no new job needed
        const same = await createUploadJob({
          ...input({ mcpId: m1 }),
          driveFileId: (await loadUploadJob(first.job.id))!.driveFileId,
          contentKey: (await loadUploadJob(first.job.id))!.contentKey,
        })
        expect(same).toMatchObject({
          existing: true,
          job: { id: first.job.id },
        })
        // another MCP of the same owner: 2 more, then the OWNER cap (5)
        await createUploadJob(input({ mcpId: m2 }))
        await createUploadJob(input({ mcpId: m2 }))
        expect(await uploadJobLimitHit(m3)).toMatchObject({ kind: "owner" })
        await expect(
          createUploadJob(input({ mcpId: m3 }))
        ).rejects.toMatchObject({ kind: "owner", limit: 5 })
        // a finished job frees a slot
        await updateUploadJob(second.job.id, { status: "failed" })
        expect(await uploadJobLimitHit(m3)).toBeNull()
        const freed = await createUploadJob(input({ mcpId: m3 }))
        expect(freed.existing).toBe(false)
        // parallel creates never pass the caps (one lock per owner)
        await updateUploadJob(freed.job.id, { status: "done" })
        const raced = await Promise.allSettled(
          Array.from({ length: 4 }, () => createUploadJob(input({ mcpId: m3 })))
        )
        expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1)
        // the install-wide queued cap (other owners' queued jobs count)
        const [q] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(mediaUploadJobs)
          .where(eq(mediaUploadJobs.status, "queued"))
        Object.assign(UPLOAD_JOB_LIMITS, {
          perMcp: 1_000,
          perOwner: 1_000,
          systemQueued: Number(q!.n),
        })
        expect(await uploadJobLimitHit(mcpId)).toMatchObject({
          kind: "system",
        })
        await expect(createUploadJob(input())).rejects.toMatchObject({
          kind: "system",
        })
      } finally {
        await db.delete(mcpServers).where(inArray(mcpServers.id, mcps))
        await db.delete(user).where(eq(user.id, capOwner.id))
      }
    } finally {
      Object.assign(UPLOAD_JOB_LIMITS, {
        perMcp: 1_000,
        perOwner: 1_000,
        systemQueued: 100_000,
      })
    }
  })
})
