// media.video_upload - on demand (sent by ads_upload_media through src/server/drive/upload-queue.ts): upload a LARGE
// Google Drive video to Meta / TikTok in chunks (owner decision 2026-10-09: small videos use the /dl relay, large
// ones this job). One job per media_upload_jobs row, never retried by pg-boss (a half-done upload must not restart
// silently - the adapter retries a failed chunk itself); concurrency 1 (worker batchSize 1) and one chunk in memory
// at a time (≤ 32 MB, readDriveRange) for the worker's 768 MB memory limit.
// Steps: claim (queued → uploading) → MCP grant re-checked (MCP usable, account in scope + "create", Drive folder
// source still granted / public-link switch still on) → Drive auth + resource key → file content key re-checked →
// folder-source file still inside the granted folder, not behind another user's personal folder (T-1) →
// provider.uploadVideoChunked (progress → job row, throttled; heartbeat every VIDEO_HEARTBEAT_MS so the stale sweep
// leaves a slow upload alone, T-3) → done: drive_media_uploads + status done (still processing at the deadline: done
// with the media id - usable) / failure: status failed + Vietnamese message. Every write to the row is conditional on
// the row still running (uploading / processing): a job the stale sweep failed is never resurrected - the worker
// stops when it notices. One mcp_call_logs row (tool "media.video_upload") per run records the platform write (T-8).
// Never logs or stores a token, a key or a URL. Bundled into the worker: no Next.js imports.
import { driveJobs, type VideoUploadErrorCode } from "@/lib/i18n/vi/drive-jobs"
import {
  capJson,
  LOG_REQUEST_MAX,
  LOG_RESPONSE_MAX,
} from "@/server/audit/cap-json"
import { flushMcpLogs, insertMcpLogNow } from "@/server/audit/mcp-log-writer"
import { redactString } from "@/server/audit/redact"
import { safeErrorForLog } from "@/server/audit/safe-error"
import {
  driveUseStillGranted,
  loadGrantForMcpId,
} from "@/server/drive/access-recheck"
import { loadBlockedFolderIds } from "@/server/drive/blocked"
import { isDriveError } from "@/server/drive/errors"
import {
  driveContentKey,
  findAncestorIn,
  getDriveFile,
  readDriveRange,
} from "@/server/drive/files"
import { recordMediaUpload } from "@/server/drive/media-uploads"
import {
  driveAuthForCredential,
  isDriveCredentialUsable,
  isUuid,
  loadDriveCredential,
  systemApiKeyAuth,
} from "@/server/drive/store"
import type { DriveAuth } from "@/server/drive/types"
import {
  claimUploadJob,
  decryptUploadJobResourceKey,
  loadUploadJobAuditInfo,
  touchUploadJob,
  updateUploadJob,
  type UploadJobRow,
  type UploadJobStatus,
} from "@/server/drive/upload-jobs"
import { VIDEO_UPLOAD_QUEUE } from "@/server/drive/upload-queue"
import { providerContextFactory } from "@/server/mcp/context"
import { McpToolError, type CallLogStatus } from "@/server/mcp/errors"
import { grantAllows } from "@/server/mcp/types"
import { ensureProvidersRegistered, getProvider } from "@/server/providers"
import { isProviderError } from "@/server/providers/errors"
import type {
  ChunkedVideoUploadRequest,
  MediaRef,
} from "@/server/providers/types"

import type { JobContext, JobDefinition } from "./types"

/** how long the platform's processing is awaited after the last upload progress (then: done, media id usable) */
export const VIDEO_PROCESSING_WAIT_MS = 10 * 60_000
/** progress is written to the job row at most this often (plus once when all bytes are acknowledged) */
export const VIDEO_PROGRESS_EVERY_MS = 5_000
/** hard stop of one job (the queue expires a job after 2 h) */
export const VIDEO_JOB_MAX_MS = 110 * 60_000
/** updated_at of a running job moves at least this often, progress or not (the stale sweep fails silent jobs) */
export const VIDEO_HEARTBEAT_MS = 60_000
/** tool name of the job's mcp_call_logs row */
export const VIDEO_UPLOAD_LOG_TOOL = "media.video_upload"

/** the worker only ever writes a row it still runs (never one the stale sweep failed meanwhile) */
const RUNNING: readonly UploadJobStatus[] = ["uploading", "processing"]
/** failures that mean "no longer allowed" (logged as denied) */
const DENIED_CODES = new Set([
  "mcp_unavailable",
  "account_not_in_scope",
  "drive_not_in_scope",
])

const m = driveJobs.videoUpload.errors

class JobFailure extends Error {
  constructor(readonly code: VideoUploadErrorCode) {
    super(`video upload: ${code}`)
    this.name = "JobFailure"
  }
}

export interface VideoUploadJobResult {
  jobId: string
  status: "done" | "failed" | "skipped"
  processing?: boolean
  errorCode?: string
}

/** Error → (code, Vietnamese message) for the job row; never an upstream URL / token / key. */
export function videoUploadFailure(
  e: unknown,
  interrupted = false
): { code: string; message: string } {
  if (e instanceof JobFailure) return { code: e.code, message: m[e.code] }
  if (interrupted) return { code: "interrupted", message: m.interrupted }
  if (isDriveError(e))
    return { code: `drive_${e.code}`, message: e.userMessageVi }
  if (isProviderError(e)) {
    const parts = [e.userMessageVi, e.hint].filter(
      (s): s is string => !!s && s.trim() !== ""
    )
    return {
      code: `provider_${e.code}`,
      message: redactString(parts.join(" ")) || m.internal,
    }
  }
  if (e instanceof McpToolError)
    return { code: e.code, message: redactString(e.messageVi) || m.internal }
  return { code: "internal", message: m.internal }
}

async function driveAuthFor(row: UploadJobRow): Promise<DriveAuth> {
  if (row.access.type === "api_key") {
    const auth = await systemApiKeyAuth()
    if (!auth) throw new JobFailure("drive_unavailable")
    return auth
  }
  const cred = await loadDriveCredential(row.access.credentialId)
  if (!cred || !isDriveCredentialUsable(cred))
    throw new JobFailure("drive_unavailable")
  return driveAuthForCredential(cred)
}

/** Abort signal: worker shutdown OR the job's hard time limit OR abort() (the row is no longer running). */
function jobSignal(ctx: JobContext): {
  signal: AbortSignal
  abort: () => void
  dispose: () => void
} {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (ctx.signal.aborted) ctrl.abort()
  else ctx.signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), VIDEO_JOB_MAX_MS)
  timer.unref?.()
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    dispose: () => {
      clearTimeout(timer)
      ctx.signal.removeEventListener("abort", onAbort)
    },
  }
}

async function upload(
  row: UploadJobRow,
  ctx: JobContext,
  signal: AbortSignal,
  onLost: () => void
): Promise<MediaRef> {
  // 1. the MCP still allows it (fresh grant: the job may run minutes after the tool call)
  const grant = await loadGrantForMcpId(row.mcpId, { fresh: true })
  if (!grant) throw new JobFailure("mcp_unavailable")
  const account = grant.accounts.find(
    (a) => a.id === row.adAccountId && a.platform === row.platform
  )
  if (!account || !grantAllows(grant, row.platform, "create"))
    throw new JobFailure("account_not_in_scope")
  const stillGranted = driveUseStillGranted(grant, {
    adAccountId: row.adAccountId,
    access: row.access.type,
    credentialId:
      row.access.type === "service_account" ? row.access.credentialId : null,
    sourceId: row.sourceId,
  })
  if (!stillGranted) throw new JobFailure("drive_not_in_scope")

  ensureProvidersRegistered()
  const provider = getProvider(row.platform)
  if (!provider.uploadVideoChunked || !/^video\//i.test(row.contentType))
    throw new JobFailure("unsupported")

  // 2. the same file version as when the AI asked
  const auth = await driveAuthFor(row)
  const resourceKey = decryptUploadJobResourceKey(row)
  const file = await getDriveFile(auth, row.driveFileId, {
    resourceKey,
    signal,
  })
  if (
    file.trashed ||
    driveContentKey(file) !== row.contentKey ||
    (file.sizeBytes !== null && file.sizeBytes !== row.sizeBytes)
  )
    throw new JobFailure("file_changed")
  // still inside the granted folder (moved out, or behind another user's personal folder registered since - T-1)
  if (row.access.type === "service_account") {
    const source = grant.driveSources.find(
      (s) => s.id === row.sourceId && s.kind === "folder"
    )
    if (!source) throw new JobFailure("drive_not_in_scope")
    const blocked = await loadBlockedFolderIds({
      id: grant.ownerId,
      role: grant.ownerRole,
    })
    const inside = await findAncestorIn(
      auth,
      file,
      new Set([source.googleId]),
      { blocked, signal }
    )
    if (!inside) throw new JobFailure("drive_not_in_scope")
  }

  // 3. provider context (connection re-checked: disabled / deleted / foreign / invalid token → McpToolError)
  const pctx = await providerContextFactory({
    ownerId: grant.ownerId,
    ownerIsAdmin: grant.ownerRole === "admin",
    signal,
  })(account)

  // 4. chunked upload with throttled progress
  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let lastWriteAt = 0
  let processingMarked = false
  let writes: Promise<void> = Promise.resolve()
  const write = (patch: Parameters<typeof updateUploadJob>[1]) => {
    writes = writes
      .then(async () => {
        const ok = await updateUploadJob(row.id, patch, {
          expectedStatuses: RUNNING,
        })
        if (!ok) onLost()
      })
      .catch((e: unknown) =>
        ctx.log(`progress update failed: ${safeErrorForLog(e)}`)
      )
  }
  const request: ChunkedVideoUploadRequest = {
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    md5: row.md5,
    contentType: row.contentType,
    name: row.name ?? undefined,
    readChunk: (start, endExclusive, chunkSignal) =>
      readDriveRange(auth, row.driveFileId, start, endExclusive, {
        resourceKey,
        signal: chunkSignal ?? signal,
      }),
    // processing is awaited VIDEO_PROCESSING_WAIT_MS after the last progress (a long upload keeps moving it)
    get deadlineAt() {
      return lastProgressAt + VIDEO_PROCESSING_WAIT_MS
    },
    onProgress: (uploadedBytes) => {
      const now = Date.now()
      lastProgressAt = now
      const complete = uploadedBytes >= row.sizeBytes
      if (complete) {
        if (processingMarked) return
        processingMarked = true
        lastWriteAt = now
        write({ uploadedBytes: row.sizeBytes, status: "processing" })
        return
      }
      if (now - lastWriteAt < VIDEO_PROGRESS_EVERY_MS) return
      lastWriteAt = now
      write({ uploadedBytes: Math.max(0, Math.floor(uploadedBytes)) })
    },
    signal,
  }
  try {
    return await provider.uploadVideoChunked(pctx, request)
  } finally {
    await writes
  }
}

interface AuditOutcome {
  status: CallLogStatus
  errorCode: string | null
  errorMessage: string | null
  mediaId: string | null
  processing: boolean
}

/** media ids are platform ids (not secrets) - still shortened and redacted before they reach a log line */
function idForLog(id: string): string {
  return redactString(id).slice(0, 100)
}

/**
 * T-8: one mcp_call_logs row per run, so the platform write of a background upload is auditable for the configured
 * retention like the tool call that queued it. Inserted with a synchronous commit (insertMcpLogNow), then flushed in
 * case it fell back to the batch buffer (DB hiccup). Never throws.
 */
async function writeAuditRow(
  row: UploadJobRow,
  o: AuditOutcome,
  startedAt: number,
  ctx: JobContext
): Promise<void> {
  try {
    const info = await loadUploadJobAuditInfo(row.id).catch(() => null)
    const request = capJson(
      {
        upload_id: row.id,
        drive_file_id: row.driveFileId,
        file_name: row.fileName,
        size_bytes: row.sizeBytes,
        content_type: row.contentType,
        attempt: row.attempts,
      },
      LOG_REQUEST_MAX
    )
    const response = capJson(
      {
        media_id: o.mediaId,
        processing: o.processing,
        error_code: o.errorCode,
      },
      LOG_RESPONSE_MAX
    )
    const changes = capJson(
      [
        o.mediaId
          ? {
              object_id: o.mediaId,
              object_name: row.name ?? row.fileName,
              level: null,
              field: "media_uploaded",
              before: null,
              after: `Google Drive: ${row.fileName} (${row.driveFileId})`,
            }
          : {
              object_id: row.id,
              object_name: row.name ?? row.fileName,
              level: null,
              field: "media_upload_failed",
              before: null,
              after: o.errorCode,
            },
      ],
      LOG_RESPONSE_MAX
    )
    await insertMcpLogNow({
      mcpId: row.mcpId,
      mcpName: info?.mcpName ?? null,
      ownerId: info?.ownerId ?? null,
      ownerEmail: info?.ownerEmail ?? null,
      jsonrpcId: null,
      method: "jobs/run",
      toolName: VIDEO_UPLOAD_LOG_TOOL,
      protocolVersion: null,
      clientName: "worker",
      clientVersion: null,
      ip: null,
      userAgent: null,
      platform: row.platform,
      adAccountId: info?.accountExternalId ?? null,
      objectIds: [
        row.id,
        row.driveFileId,
        ...(o.mediaId ? [o.mediaId] : []),
      ].map((id) => id.slice(0, 200)),
      actionKind: "write",
      status: o.status,
      errorCode: o.errorCode ? o.errorCode.slice(0, 100) : null,
      errorMessage: o.errorMessage
        ? redactString(o.errorMessage).slice(0, 2000)
        : null,
      upstreamRequestIds: null,
      durationMs: Math.max(0, Date.now() - startedAt),
      request: request.json,
      response: response.json,
      changes: changes.json,
      pendingActionId: null,
      requestBytes: request.bytes,
      responseBytes: response.bytes,
      truncated: request.truncated || response.truncated || changes.truncated,
    })
    await flushMcpLogs()
  } catch (e) {
    ctx.log(`audit log row not written: ${safeErrorForLog(e)}`)
  }
}

/** Run one media_upload_jobs row (exported for tests). Never throws for a failed upload: the row says failed. */
export async function runVideoUploadJob(
  data: { jobId?: unknown },
  ctx: JobContext
): Promise<VideoUploadJobResult> {
  const jobId = typeof data?.jobId === "string" ? data.jobId : ""
  if (!isUuid(jobId)) return { jobId: "", status: "skipped" }
  const row = await claimUploadJob(jobId)
  if (!row) return { jobId, status: "skipped" }
  ctx.log(
    `upload ${row.platform} ${row.sizeBytes} bytes (attempt ${row.attempts})`
  )
  const startedAt = Date.now()
  const { signal, abort, dispose } = jobSignal(ctx)
  // the row stopped running under us (failed by the stale sweep, deleted with its MCP): stop uploading
  let lost = false
  // set once the platform answered: a late heartbeat / progress answer no longer stops anything
  let uploaded = false
  const onLost = () => {
    if (lost || uploaded) return
    lost = true
    ctx.log("job is no longer running (failed by the stale sweep?) - stopping")
    abort()
  }
  // T-3: updated_at moves even without progress (a long chunk transfer, the processing wait)
  const heartbeat = setInterval(() => {
    touchUploadJob(row.id).then(
      (ok) => {
        if (!ok) onLost()
      },
      (e: unknown) => ctx.log(`heartbeat failed: ${safeErrorForLog(e)}`)
    )
  }, VIDEO_HEARTBEAT_MS)
  heartbeat.unref?.()

  let result: VideoUploadJobResult
  let audit: AuditOutcome
  try {
    const media = await upload(row, ctx, signal, onLost)
    uploaded = true
    if (!media?.id || media.type !== "video")
      throw new Error("adapter returned no video id")
    clearInterval(heartbeat)
    await recordMediaUpload({
      adAccountId: row.adAccountId,
      driveFileId: row.driveFileId,
      contentKey: row.contentKey,
      mediaType: "video",
      mediaId: media.id,
      // never store an expiring platform URL (API review #6)
      mediaUrl: null,
      sizeBytes: row.sizeBytes,
      sourceId: row.sourceId,
      mcpId: row.mcpId,
    }).catch((e: unknown) =>
      // reuse is an optimisation: a failed bookkeeping row never fails an upload that happened
      ctx.log(`media reuse row not saved: ${safeErrorForLog(e)}`)
    )
    const processing = media.processing === true
    const written = await updateUploadJob(
      row.id,
      {
        status: "done",
        uploadedBytes: row.sizeBytes,
        mediaId: media.id,
        errorCode: null,
        errorMessage: null,
      },
      { expectedStatuses: RUNNING }
    )
    if (written) {
      result = { jobId, status: "done", processing }
      audit = {
        status: "success",
        errorCode: null,
        errorMessage: null,
        mediaId: media.id,
        processing,
      }
    } else {
      // the stale sweep failed the row meanwhile: it stays failed (that is what the AI was told); the media id is
      // kept in the audit row and the reuse table
      ctx.log(
        `finished after the job was marked failed - media ${idForLog(media.id)} not written to the job`
      )
      result = { jobId, status: "failed", errorCode: "job_already_failed" }
      audit = {
        status: "error",
        errorCode: "job_already_failed",
        errorMessage: m.job_already_failed,
        mediaId: media.id,
        processing,
      }
    }
  } catch (e) {
    clearInterval(heartbeat)
    const f = lost
      ? { code: "stale", message: m.stale }
      : videoUploadFailure(e, ctx.signal.aborted)
    ctx.log(
      `failed (${f.code}): ${e instanceof JobFailure || lost ? f.code : safeErrorForLog(e)}`
    )
    // a lost row is already failed (by the sweep): never written again
    if (!lost) {
      await updateUploadJob(
        row.id,
        {
          status: "failed",
          errorCode: f.code.slice(0, 64),
          errorMessage: f.message.slice(0, 500),
        },
        { expectedStatuses: RUNNING }
      ).catch((e2: unknown) =>
        ctx.log(`failure not saved: ${safeErrorForLog(e2)}`)
      )
    }
    result = { jobId, status: "failed", errorCode: f.code }
    audit = {
      status: DENIED_CODES.has(f.code) ? "denied" : "error",
      errorCode: f.code,
      errorMessage: f.message,
      mediaId: null,
      processing: false,
    }
  } finally {
    clearInterval(heartbeat)
    dispose()
  }
  await writeAuditRow(row, audit, startedAt, ctx)
  return result
}

export const mediaVideoUploadJob: JobDefinition<{ jobId?: unknown }> = {
  name: VIDEO_UPLOAD_QUEUE,
  // a failed upload is never restarted by the queue (the AI asks again; the row shows why it failed)
  queue: { expireInSeconds: 2 * 60 * 60, retryLimit: 0 },
  handler: (data, ctx) => runVideoUploadJob(data ?? {}, ctx),
}
