// Periodic Google Drive health check (job drive.health, 15-google-drive-media.md §4.1/§5): re-validate every live
// credential (token + files.list) and every live source (still reachable, right type, not trashed; sheets: tab still
// there, Editor access when write-back is on) and store status / status_message / last_checked_at.
// Transient Google failures (rate limit, timeout, 5xx) leave the row untouched; one bad row never stops the run.
// Healthy sources refresh ancestor_ids with their own credential AND the system credential (union, T-2); a source
// whose ancestors now include another user's live personal folder is flagged (status error, H1).
// No imports from "next/*". Nothing secret is logged (counts only).
import { and, eq, isNull, ne, sql } from "drizzle-orm"

import { driveJobs } from "@/lib/i18n/vi/drive-jobs"

import { safeErrorForLog } from "../audit/safe-error"
import { db } from "../db/client"
import { driveCredentials, driveSources } from "../db/schema"
import { mapLimit } from "../jobs/types"

import { loadOtherPersonalFolderIds, sourceIsBlocked } from "./blocked"
import { DriveError, isDriveError } from "./errors"
import {
  checkServiceAccountAccess,
  getDriveFile,
  listAncestorIds,
} from "./files"
import { getSheetMeta } from "./sheets"
import {
  decryptSourceResourceKey,
  driveAuthForCredential,
  isDriveCredentialUsable,
  loadSystemDriveCredential,
  normalizeSheetConfig,
  type DriveCredentialRow,
  type DriveSourceRow,
} from "./store"
import { DRIVE_FOLDER_MIME, type DriveAuth, type DriveFile } from "./types"

export const DRIVE_SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet"
/** parallel Google checks per run (Drive metadata + Sheets meta; the Sheets limiter guards its own quota) */
export const DRIVE_HEALTH_CONCURRENCY = 3
const GOOGLE_NAME_MAX = 300

export interface DriveHealthResult {
  status: "active" | "error"
  statusMessage: string | null
  /** sources only: name on Google Drive / shared drive id at this check */
  googleName?: string
  sharedDriveId?: string | null
  /** sources only, healthy checks: visible ancestors (drive_sources.ancestor_ids, security review H1) */
  ancestorIds?: string[]
}

export interface DriveHealthSummary {
  credentials: { ok: number; error: number; skipped: number }
  sources: { ok: number; error: number; skipped: number }
}

const ok = (): DriveHealthResult => ({ status: "active", statusMessage: null })
const failed = (e: DriveError): DriveHealthResult => ({
  status: "error",
  statusMessage: e.userMessageVi,
})

/** untrusted display text: control characters removed, length capped */
function cleanName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, GOOGLE_NAME_MAX)
}

/**
 * Map a failure to a stored result; null = transient (rate limit / timeout / 5xx) or unexpected (logged) → the row
 * is left as it is and the next run tries again.
 */
function resultOfError(
  e: unknown,
  log?: (msg: string) => void
): DriveHealthResult | null {
  if (isDriveError(e)) return e.retryable ? null : failed(e)
  log?.(`drive.health: unexpected error: ${safeErrorForLog(e)}`)
  return null
}

/**
 * Visible ancestors of `file` as `auth` sees them, plus (union, nearest first) those `others` see - the system
 * credential when the source uses a personal one: a personal service account may not see a parent folder that the
 * system one sees, and the H1 rules must know every parent (security review T-2). The primary walk's failure
 * propagates; another credential that cannot see the file / fails is skipped (best effort).
 */
export async function listAncestorIdsUnion(
  auth: DriveAuth,
  file: DriveFile,
  others: readonly DriveAuth[],
  opts: {
    resourceKey?: string | null
    signal?: AbortSignal
    log?: (msg: string) => void
  } = {}
): Promise<string[]> {
  const out = await listAncestorIds(auth, file, { signal: opts.signal })
  const seen = new Set(out)
  for (const other of others) {
    try {
      const f = await getDriveFile(other, file.id, {
        resourceKey: opts.resourceKey ?? file.resourceKey,
        signal: opts.signal,
      })
      for (const id of await listAncestorIds(other, f, {
        signal: opts.signal,
      })) {
        if (seen.has(id)) continue
        seen.add(id)
        out.push(id)
      }
    } catch (e) {
      const hidden =
        isDriveError(e) &&
        (e.code === "not_found" || e.code === "permission_denied")
      if (!hidden)
        opts.log?.(
          `drive.health: ancestor walk with the system credential failed: ${safeErrorForLog(e)}`
        )
    }
  }
  return out
}

/**
 * Auth of the live, usable system credential when it differs from `credentialId` (for listAncestorIdsUnion), else
 * none. Never throws.
 */
export async function systemAuthBesides(
  credentialId: string
): Promise<DriveAuth[]> {
  try {
    const system = await loadSystemDriveCredential()
    if (
      !system ||
      system.id === credentialId ||
      !isDriveCredentialUsable(system)
    )
      return []
    return [driveAuthForCredential(system)]
  } catch {
    return []
  }
}

/**
 * Does a source of `ownerId` with these ancestors now sit inside another user's live personal folder (the folders a
 * staff member `ownerId` would be blocked from - blocked.ts)? Its sub-tree would be shared through it (H1).
 */
export async function insideOtherPersonalFolder(
  ownerId: string,
  googleId: string,
  ancestorIds: readonly string[]
): Promise<boolean> {
  if (ancestorIds.length === 0) return false
  const others = await loadOtherPersonalFolderIds(ownerId)
  return sourceIsBlocked({ googleId, ancestorIds }, others)
}

/** Token (forced refresh) + files.list pageSize=1 with the credential's service account. */
export async function checkDriveCredentialHealth(
  row: Pick<DriveCredentialRow, "id" | "credentialsEncrypted">,
  opts: { signal?: AbortSignal; log?: (msg: string) => void } = {}
): Promise<DriveHealthResult | null> {
  try {
    await checkServiceAccountAccess(driveAuthForCredential(row), opts.signal)
    return ok()
  } catch (e) {
    return resultOfError(e, opts.log)
  }
}

/** Folder / sheet still readable by `auth` with the expected type (and Editor access when write-back is on). */
export async function checkDriveSourceHealth(
  source: Pick<
    DriveSourceRow,
    "id" | "kind" | "googleId" | "sheetGid" | "config" | "resourceKeyEncrypted"
  >,
  auth: DriveAuth,
  opts: {
    signal?: AbortSignal
    log?: (msg: string) => void
    /** other credentials whose view of the ancestors is added (the system credential, T-2) */
    extraAuths?: readonly DriveAuth[]
  } = {}
): Promise<DriveHealthResult | null> {
  try {
    const resourceKey = decryptSourceResourceKey(source)
    const file = await getDriveFile(auth, source.googleId, {
      resourceKey,
      signal: opts.signal,
    })
    const named = (r: DriveHealthResult): DriveHealthResult => ({
      ...r,
      googleName: cleanName(file.name),
      sharedDriveId: file.driveId,
    })
    // healthy: refresh the ancestors too (a folder may have been moved); a failure keeps the stored value
    const healthy = async (): Promise<DriveHealthResult> => {
      const r = named(ok())
      try {
        r.ancestorIds = await listAncestorIdsUnion(
          auth,
          file,
          opts.extraAuths ?? [],
          { resourceKey, signal: opts.signal, log: opts.log }
        )
      } catch (e) {
        opts.log?.(
          `drive.health: ancestor refresh failed: ${safeErrorForLog(e)}`
        )
      }
      return r
    }
    if (file.trashed) return named(failed(new DriveError("not_found")))
    if (source.kind === "folder") {
      return file.mimeType === DRIVE_FOLDER_MIME
        ? await healthy()
        : named(failed(new DriveError("invalid_link")))
    }
    if (file.mimeType !== DRIVE_SPREADSHEET_MIME || source.sheetGid === null) {
      return named(failed(new DriveError("invalid_sheet")))
    }
    await getSheetMeta(auth, source.googleId, source.sheetGid, opts.signal)
    if (normalizeSheetConfig(source.config).writeback && !file.canEdit) {
      return named(failed(new DriveError("permission_denied")))
    }
    return await healthy()
  } catch (e) {
    return resultOfError(e, opts.log)
  }
}

async function saveCredentialResult(
  id: string,
  r: DriveHealthResult
): Promise<void> {
  await db
    .update(driveCredentials)
    .set({
      status: r.status,
      statusMessage: r.statusMessage,
      lastCheckedAt: sql`now()`,
      // a health check is not an edit
      updatedAt: sql`${driveCredentials.updatedAt}`,
    })
    // never resurrect a row deleted / disabled while the check ran
    .where(
      and(
        eq(driveCredentials.id, id),
        isNull(driveCredentials.deletedAt),
        ne(driveCredentials.status, "disabled")
      )
    )
}

async function saveSourceResult(
  id: string,
  r: DriveHealthResult
): Promise<void> {
  await db
    .update(driveSources)
    .set({
      status: r.status,
      statusMessage: r.statusMessage,
      lastCheckedAt: sql`now()`,
      ...(r.googleName !== undefined ? { googleName: r.googleName } : {}),
      ...(r.sharedDriveId !== undefined
        ? { sharedDriveId: r.sharedDriveId }
        : {}),
      ...(r.ancestorIds !== undefined ? { ancestorIds: r.ancestorIds } : {}),
      updatedAt: sql`${driveSources.updatedAt}`,
    })
    .where(
      and(
        eq(driveSources.id, id),
        isNull(driveSources.deletedAt),
        ne(driveSources.status, "disabled")
      )
    )
}

/**
 * Check every live, not disabled credential, then every live, not disabled source (with its credential; sources of a
 * credential that just failed get the credential's message without another Google call). Never throws for one row.
 */
export async function runDriveHealth(
  ctx: { signal?: AbortSignal; log?: (msg: string) => void } = {}
): Promise<DriveHealthSummary> {
  const summary: DriveHealthSummary = {
    credentials: { ok: 0, error: 0, skipped: 0 },
    sources: { ok: 0, error: 0, skipped: 0 },
  }
  const count = (
    bucket: { ok: number; error: number; skipped: number },
    r: DriveHealthResult | null
  ) => {
    if (!r) bucket.skipped++
    else if (r.status === "active") bucket.ok++
    else bucket.error++
  }

  const credentials = (
    await db
      .select()
      .from(driveCredentials)
      .where(isNull(driveCredentials.deletedAt))
  ).filter(isDriveCredentialUsable)
  const credentialById = new Map(credentials.map((c) => [c.id, c]))
  const systemCredential = credentials.find((c) => c.kind === "system") ?? null
  const credentialResult = new Map<string, DriveHealthResult | null>()
  await mapLimit(
    credentials,
    DRIVE_HEALTH_CONCURRENCY,
    async (c) => {
      const r = await checkDriveCredentialHealth(c, ctx)
      credentialResult.set(c.id, r)
      count(summary.credentials, r)
      if (r)
        await saveCredentialResult(c.id, r).catch((e) =>
          ctx.log?.(`drive.health: save failed: ${safeErrorForLog(e)}`)
        )
    },
    ctx.signal
  )

  const sourceResult = async (
    s: DriveSourceRow
  ): Promise<DriveHealthResult | null> => {
    const cred = credentialById.get(s.credentialId)
    // credential deleted / disabled: the grant already ignores the source; nothing to check
    if (!cred) return null
    const credResult = credentialResult.get(cred.id)
    if (credResult?.status === "error")
      return { status: "error", statusMessage: credResult.statusMessage }
    let auth: DriveAuth
    try {
      auth = driveAuthForCredential(cred)
    } catch (e) {
      return resultOfError(e, ctx.log)
    }
    // the system credential's view of the parents too (T-2), when it is another, healthy credential
    const extraAuths: DriveAuth[] = []
    if (
      systemCredential &&
      systemCredential.id !== cred.id &&
      credentialResult.get(systemCredential.id)?.status !== "error"
    ) {
      try {
        extraAuths.push(driveAuthForCredential(systemCredential))
      } catch {
        // unusable system credential: its own check reports it
      }
    }
    const r = await checkDriveSourceHealth(s, auth, { ...ctx, extraAuths })
    // H1: a source moved inside another user's personal folder would share it - flag it
    if (r?.status === "active" && r.ancestorIds) {
      let others = otherPersonal.get(s.ownerId)
      if (!others) {
        others = loadOtherPersonalFolderIds(s.ownerId)
        otherPersonal.set(s.ownerId, others)
      }
      try {
        if (
          sourceIsBlocked(
            { googleId: s.googleId, ancestorIds: r.ancestorIds },
            await others
          )
        )
          return {
            ...r,
            status: "error",
            statusMessage: driveJobs.sources.insideOtherPersonal,
          }
      } catch (e) {
        otherPersonal.delete(s.ownerId)
        ctx.log?.(
          `drive.health: personal folder check failed: ${safeErrorForLog(e)}`
        )
      }
    }
    return r
  }
  const otherPersonal = new Map<string, Promise<Set<string>>>()

  const sources = await db
    .select()
    .from(driveSources)
    .where(
      and(isNull(driveSources.deletedAt), ne(driveSources.status, "disabled"))
    )
  await mapLimit(
    sources,
    DRIVE_HEALTH_CONCURRENCY,
    async (s) => {
      const r = await sourceResult(s)
      count(summary.sources, r)
      if (r)
        await saveSourceResult(s.id, r).catch((e) =>
          ctx.log?.(`drive.health: save failed: ${safeErrorForLog(e)}`)
        )
    },
    ctx.signal
  )

  ctx.log?.(
    `drive.health: credentials ok=${summary.credentials.ok} error=${summary.credentials.error} skipped=${summary.credentials.skipped}; ` +
      `sources ok=${summary.sources.ok} error=${summary.sources.error} skipped=${summary.sources.skipped}`
  )
  return summary
}
