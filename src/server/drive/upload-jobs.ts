// Background (chunked) video uploads Drive → Meta / TikTok (owner decision 2026-10-09: small videos via the /dl relay,
// large ones via this job). Table media_upload_jobs (migration 0008). The resource key is encrypted with
// AAD media_upload_job:<id>:resource_key and only decrypted by the worker. Views never contain secrets.
// No imports from "next/*".
import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import type { AnyPgColumn, PgUpdateSetSource } from "drizzle-orm/pg-core"

import { driveUi } from "@/lib/i18n/vi/drive-ui"

import { aad, decryptSecret, encryptSecret } from "../crypto/secret-box"
import { db, type Tx } from "../db/client"
import { adAccounts, mcpServers, mediaUploadJobs, user } from "../db/schema"
import type { Platform } from "../providers/types"

import { isUuid } from "./store"

export type UploadJobStatus =
  "queued" | "uploading" | "processing" | "done" | "failed"

export type UploadJobAccess =
  { type: "service_account"; credentialId: string } | { type: "api_key" }

export const ACTIVE_UPLOAD_JOB_STATUSES = [
  "queued",
  "uploading",
  "processing",
] as const satisfies readonly UploadJobStatus[]
const FINISHED_STATUSES = ["done", "failed"] as const
/** queued jobs older than this are failed by failStaleUploadJobs (lost queue message) */
export const UPLOAD_JOB_QUEUED_MAX_MS = 24 * 60 * 60_000
const LIST_DEFAULT = 10
const LIST_MAX = 50
const MAX_TEXT = 500

export interface CreateUploadJobInput {
  mcpId: string
  /** ad_accounts.id */
  adAccountId: string
  platform: Platform
  driveFileId: string
  contentKey: string
  /** drive_sources.id the file was resolved through (null = public link) */
  sourceId: string | null
  access: UploadJobAccess
  resourceKey: string | null
  fileName: string
  contentType: string
  sizeBytes: number
  md5: string | null
  /** media library name */
  name: string | null
}

/** What tools / UI may show - never secrets. */
export interface UploadJobView {
  id: string
  mcpId: string
  adAccountId: string
  platform: Platform
  driveFileId: string
  fileName: string
  sizeBytes: number
  status: UploadJobStatus
  uploadedBytes: number
  mediaId: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

/** Full row for the worker (decrypts nothing - use decryptUploadJobResourceKey). */
export interface UploadJobRow extends UploadJobView {
  contentKey: string
  sourceId: string | null
  access: UploadJobAccess
  resourceKeyEncrypted: string | null
  contentType: string
  md5: string | null
  name: string | null
  attempts: number
}

type DbRow = typeof mediaUploadJobs.$inferSelect

function statusOf(v: string): UploadJobStatus {
  return v === "uploading" ||
    v === "processing" ||
    v === "done" ||
    v === "failed"
    ? v
    : "queued"
}

function toView(r: DbRow): UploadJobView {
  return {
    id: r.id,
    mcpId: r.mcpId,
    adAccountId: r.adAccountId,
    platform: r.platform,
    driveFileId: r.driveFileId,
    fileName: r.fileName,
    sizeBytes: r.sizeBytes,
    status: statusOf(r.status),
    uploadedBytes: r.uploadedBytes,
    mediaId: r.mediaId,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  }
}

function toRow(r: DbRow): UploadJobRow {
  return {
    ...toView(r),
    contentKey: r.contentKey,
    sourceId: r.sourceId,
    access:
      r.access === "service_account" && r.credentialId
        ? { type: "service_account", credentialId: r.credentialId }
        : { type: "api_key" },
    resourceKeyEncrypted: r.resourceKeyEncrypted,
    contentType: r.contentType,
    md5: r.md5,
    name: r.name,
    attempts: r.attempts,
  }
}

function clip(v: string | null | undefined): string | null {
  return v == null ? null : v.slice(0, MAX_TEXT)
}

async function findActive(
  input: Pick<
    CreateUploadJobInput,
    "adAccountId" | "driveFileId" | "contentKey"
  >,
  tx: Tx | typeof db = db
): Promise<DbRow | null> {
  const [r] = await tx
    .select()
    .from(mediaUploadJobs)
    .where(
      and(
        eq(mediaUploadJobs.adAccountId, input.adAccountId),
        eq(mediaUploadJobs.driveFileId, input.driveFileId),
        eq(mediaUploadJobs.contentKey, input.contentKey),
        inArray(mediaUploadJobs.status, [...ACTIVE_UPLOAD_JOB_STATUSES])
      )
    )
    .limit(1)
  return r ?? null
}

/**
 * Caps on ACTIVE background uploads (security review M-1): each one holds a worker slot for minutes and moves up to
 * 500 MB through the server. Mutable for tests only.
 */
export const UPLOAD_JOB_LIMITS = {
  /** active (queued / uploading / processing) jobs of one MCP */
  perMcp: 3,
  /** active jobs of all the MCPs of one owner */
  perOwner: 5,
  /** queued jobs of the whole install (the worker runs one at a time) */
  systemQueued: 30,
}

export type UploadJobLimitKind = "mcp" | "owner" | "system"

/** createUploadJob refused a new job: a cap of UPLOAD_JOB_LIMITS is reached. */
export class UploadJobLimitError extends Error {
  constructor(
    readonly kind: UploadJobLimitKind,
    readonly limit: number
  ) {
    super(`upload job limit reached (${kind})`)
    this.name = "UploadJobLimitError"
  }
}

export function isUploadJobLimitError(e: unknown): e is UploadJobLimitError {
  return e instanceof UploadJobLimitError
}

const ACTIVE_SQL = sql.raw(
  `(${ACTIVE_UPLOAD_JOB_STATUSES.map((s) => `'${s}'`).join(",")})`
)

/**
 * Which cap (if any) a NEW job of `mcpId` would exceed: the MCP's active jobs, the active jobs of every MCP of the
 * same owner (mcp_servers.owner_id), the queued jobs of the whole install. null = a new job is allowed.
 * Used by ads_upload_media before the 2-step confirm and again (locked) by createUploadJob.
 */
export async function uploadJobLimitHit(
  mcpId: string,
  tx: Tx | typeof db = db
): Promise<UploadJobLimitError | null> {
  if (!isUuid(mcpId)) return null
  const res = await tx.execute<{ mcp: number; owner: number; queued: number }>(
    sql`select
      (select count(*) from media_upload_jobs where mcp_id = ${mcpId} and status in ${ACTIVE_SQL})::int as mcp,
      (select count(*) from media_upload_jobs j join mcp_servers m on m.id = j.mcp_id
        where m.owner_id = (select owner_id from mcp_servers where id = ${mcpId}) and j.status in ${ACTIVE_SQL})::int as owner,
      (select count(*) from media_upload_jobs where status = 'queued')::int as queued`
  )
  const c = res.rows[0]
  if (!c) return null
  if (Number(c.mcp) >= UPLOAD_JOB_LIMITS.perMcp)
    return new UploadJobLimitError("mcp", UPLOAD_JOB_LIMITS.perMcp)
  if (Number(c.owner) >= UPLOAD_JOB_LIMITS.perOwner)
    return new UploadJobLimitError("owner", UPLOAD_JOB_LIMITS.perOwner)
  if (Number(c.queued) >= UPLOAD_JOB_LIMITS.systemQueued)
    return new UploadJobLimitError("system", UPLOAD_JOB_LIMITS.systemQueued)
  return null
}

/**
 * Insert a queued job, or return the ACTIVE (queued/uploading/processing) job for the same
 * (adAccountId, driveFileId, contentKey) with `existing: true` (no duplicate uploads).
 * A NEW job is refused with UploadJobLimitError when a cap of UPLOAD_JOB_LIMITS is reached (checked under an advisory
 * lock per MCP OWNER - it serialises every MCP of that owner, so the per-MCP and per-owner caps cannot be raced).
 * NOTE: the active job may belong to ANOTHER MCP (same ad account + file) - compare `job.mcpId`; getUploadJob only
 * returns jobs of the asking MCP.
 */
export async function createUploadJob(
  input: CreateUploadJobInput
): Promise<{ job: UploadJobView; existing: boolean }> {
  if (!input.contentKey) throw new Error("upload job: content key required")
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw new Error("upload job: invalid size")
  if (!input.fileName) throw new Error("upload job: file name required")
  // the active row can finish between the conflicting insert and the select → try again (bounded)
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ ownerId: mcpServers.ownerId })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.mcpId))
        .limit(1)
      if (!owner) throw new Error("upload job: MCP not found")
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`media_upload_job_owner:${owner.ownerId}`}))`
      )
      // an upload of this file version already running: no new job, no cap
      const active = await findActive(input, tx)
      if (active) return { job: toView(active), existing: true }
      const hit = await uploadJobLimitHit(input.mcpId, tx)
      if (hit) throw hit
      return insertJob(input, tx)
    })
    if (out) return out
  }
  throw new Error("upload job: could not create (concurrent updates)")
}

/** insert; null when the partial unique index refused it and the conflicting row is already gone */
async function insertJob(
  input: CreateUploadJobInput,
  tx: Tx
): Promise<{ job: UploadJobView; existing: boolean } | null> {
  const id = randomUUID()
  const [row] = await tx
    .insert(mediaUploadJobs)
    .values({
      id,
      mcpId: input.mcpId,
      adAccountId: input.adAccountId,
      platform: input.platform,
      driveFileId: input.driveFileId,
      contentKey: input.contentKey,
      sourceId: input.sourceId,
      access: input.access.type,
      credentialId:
        input.access.type === "service_account"
          ? input.access.credentialId
          : null,
      resourceKeyEncrypted: input.resourceKey
        ? encryptSecret(input.resourceKey, aad.mediaUploadJobResourceKey(id))
        : null,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      md5: input.md5,
      name: input.name,
      status: "queued",
    })
    // the only unique constraint besides the (random) primary key is the partial "one active job" index
    .onConflictDoNothing()
    .returning()
  if (row) return { job: toView(row), existing: false }
  // another owner's MCP inserted the same account + file version meanwhile (it committed before our insert)
  const active = await findActive(input, tx)
  return active ? { job: toView(active), existing: true } : null
}

/** Job of this MCP (null when missing or owned by another MCP). */
export async function getUploadJob(
  id: string,
  mcpId: string
): Promise<UploadJobView | null> {
  if (!isUuid(id) || !isUuid(mcpId)) return null
  const [r] = await db
    .select()
    .from(mediaUploadJobs)
    .where(and(eq(mediaUploadJobs.id, id), eq(mediaUploadJobs.mcpId, mcpId)))
    .limit(1)
  return r ? toView(r) : null
}

/** Recent jobs of an MCP (newest first; limit 1-50, default 10). */
export async function listUploadJobs(
  mcpId: string,
  opts: { limit?: number } = {}
): Promise<UploadJobView[]> {
  if (!isUuid(mcpId)) return []
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? LIST_DEFAULT) || LIST_DEFAULT, 1),
    LIST_MAX
  )
  const rows = await db
    .select()
    .from(mediaUploadJobs)
    .where(eq(mediaUploadJobs.mcpId, mcpId))
    .orderBy(desc(mediaUploadJobs.createdAt), desc(mediaUploadJobs.id))
    .limit(limit)
  return rows.map(toView)
}

/** Worker: the full row (no decryption), or null. */
export async function loadUploadJob(id: string): Promise<UploadJobRow | null> {
  if (!isUuid(id)) return null
  const [r] = await db
    .select()
    .from(mediaUploadJobs)
    .where(eq(mediaUploadJobs.id, id))
    .limit(1)
  return r ? toRow(r) : null
}

/** Atomically move queued → uploading (attempts + 1); null when not claimable. */
export async function claimUploadJob(id: string): Promise<UploadJobRow | null> {
  if (!isUuid(id)) return null
  const [r] = await db
    .update(mediaUploadJobs)
    .set({
      status: "uploading",
      attempts: sql`${mediaUploadJobs.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(mediaUploadJobs.id, id), eq(mediaUploadJobs.status, "queued"))
    )
    .returning()
  return r ? toRow(r) : null
}

/** statuses the worker owns: a row the stale sweep already failed is never written again (T-3) */
export const RUNNING_UPLOAD_JOB_STATUSES = [
  "uploading",
  "processing",
] as const satisfies readonly UploadJobStatus[]

/**
 * Progress / result of a job. updated_at always moves (stale detection); finished_at is set when the status becomes
 * done / failed, and the resource key is wiped then (no longer needed). error_message must be Vietnamese and safe to
 * show (never secrets) - capped at 500 chars. `expectedStatuses`: only update a row in one of these statuses (the
 * worker passes RUNNING_UPLOAD_JOB_STATUSES so a job failed by the stale sweep is not resurrected). Returns whether a
 * row was updated.
 */
export async function updateUploadJob(
  id: string,
  patch: Partial<{
    status: UploadJobStatus
    uploadedBytes: number
    mediaId: string | null
    errorCode: string | null
    errorMessage: string | null
  }>,
  opts: { expectedStatuses?: readonly UploadJobStatus[] } = {}
): Promise<boolean> {
  if (!isUuid(id)) return false
  const set: PgUpdateSetSource<typeof mediaUploadJobs> = {
    updatedAt: sql`now()`,
  }
  if (patch.status !== undefined) {
    set.status = patch.status
    const finished = patch.status === "done" || patch.status === "failed"
    set.finishedAt = finished ? sql`now()` : null
    if (finished) set.resourceKeyEncrypted = null
  }
  if (patch.uploadedBytes !== undefined) {
    if (!Number.isSafeInteger(patch.uploadedBytes) || patch.uploadedBytes < 0)
      throw new Error("upload job: invalid uploadedBytes")
    set.uploadedBytes = patch.uploadedBytes
  }
  if (patch.mediaId !== undefined) set.mediaId = clip(patch.mediaId)
  if (patch.errorCode !== undefined) set.errorCode = clip(patch.errorCode)
  if (patch.errorMessage !== undefined)
    set.errorMessage = clip(patch.errorMessage)
  const r = await db
    .update(mediaUploadJobs)
    .set(set)
    .where(
      and(
        eq(mediaUploadJobs.id, id),
        opts.expectedStatuses
          ? inArray(mediaUploadJobs.status, [...opts.expectedStatuses])
          : undefined
      )
    )
  return (r.rowCount ?? 0) > 0
}

/**
 * Worker heartbeat: moves updated_at of a RUNNING job (uploading / processing) so the stale sweep does not fail it
 * while a long chunk or the processing wait makes no progress. false = the row is no longer running (failed by the
 * sweep, deleted) - the worker should stop.
 */
export async function touchUploadJob(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const r = await db
    .update(mediaUploadJobs)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        eq(mediaUploadJobs.id, id),
        inArray(mediaUploadJobs.status, [...RUNNING_UPLOAD_JOB_STATUSES])
      )
    )
  return (r.rowCount ?? 0) > 0
}

/** Who / what a job belongs to, for its mcp_call_logs audit row (T-8). Never secrets. */
export interface UploadJobAuditInfo {
  mcpName: string | null
  ownerId: string | null
  ownerEmail: string | null
  /** ad_accounts.external_id (what mcp_call_logs.ad_account_id stores) */
  accountExternalId: string | null
}

export async function loadUploadJobAuditInfo(
  id: string
): Promise<UploadJobAuditInfo | null> {
  if (!isUuid(id)) return null
  const [r] = await db
    .select({
      mcpName: mcpServers.name,
      ownerId: mcpServers.ownerId,
      ownerEmail: user.email,
      accountExternalId: adAccounts.externalId,
    })
    .from(mediaUploadJobs)
    .leftJoin(mcpServers, eq(mcpServers.id, mediaUploadJobs.mcpId))
    .leftJoin(user, eq(user.id, mcpServers.ownerId))
    .leftJoin(adAccounts, eq(adAccounts.id, mediaUploadJobs.adAccountId))
    .where(eq(mediaUploadJobs.id, id))
    .limit(1)
  return r ?? null
}

export function decryptUploadJobResourceKey(
  row: Pick<UploadJobRow, "id" | "resourceKeyEncrypted">
): string | null {
  if (!row.resourceKeyEncrypted) return null
  try {
    return decryptSecret(
      row.resourceKeyEncrypted,
      aad.mediaUploadJobResourceKey(row.id)
    )
  } catch {
    // ENCRYPTION_KEYS problem (operator); no cause (it may describe the ciphertext)
    throw new Error("media_upload_job resource key cannot be decrypted")
  }
}

function olderThan(column: AnyPgColumn, ms: number) {
  const secs = Math.max(0, ms) / 1000
  return lt(
    column,
    sql`now() - make_interval(secs => ${secs}::double precision)`
  )
}

/**
 * uploading/processing jobs not updated for olderThanMs → failed (worker crash), and queued jobs older than
 * UPLOAD_JOB_QUEUED_MAX_MS (lost queue message - they would block new uploads of the file); returns count.
 */
export async function failStaleUploadJobs(
  olderThanMs: number
): Promise<number> {
  const stale = await db
    .update(mediaUploadJobs)
    .set({
      status: "failed",
      errorCode: "stale",
      errorMessage: driveUi.service.uploadJobStale,
      resourceKeyEncrypted: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        inArray(mediaUploadJobs.status, ["uploading", "processing"]),
        olderThan(mediaUploadJobs.updatedAt, olderThanMs)
      )
    )
  const expired = await db
    .update(mediaUploadJobs)
    .set({
      status: "failed",
      errorCode: "expired",
      errorMessage: driveUi.service.uploadJobExpired,
      resourceKeyEncrypted: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(mediaUploadJobs.status, "queued"),
        olderThan(
          mediaUploadJobs.updatedAt,
          Math.max(olderThanMs, UPLOAD_JOB_QUEUED_MAX_MS)
        )
      )
    )
  return (stale.rowCount ?? 0) + (expired.rowCount ?? 0)
}

/** delete finished jobs older than olderThanMs; returns count. */
export async function deleteOldUploadJobs(
  olderThanMs: number
): Promise<number> {
  const r = await db
    .delete(mediaUploadJobs)
    .where(
      and(
        inArray(mediaUploadJobs.status, [...FINISHED_STATUSES]),
        or(
          olderThan(mediaUploadJobs.finishedAt, olderThanMs),
          and(
            sql`${mediaUploadJobs.finishedAt} is null`,
            olderThan(mediaUploadJobs.updatedAt, olderThanMs)
          )
        )
      )
    )
  return r.rowCount ?? 0
}
