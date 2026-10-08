// System update service (.claude/docs/10-update-system.md): status snapshot, manual "Kiểm tra ngay" and the
// "Cập nhật" request. The web app NEVER runs docker: it only inserts a `pending` row into
// system_update_requests; the separate `updater` service claims and executes it (backup -> pull -> migrate ->
// restart -> healthcheck, rollback on failure) and writes the outcome + activity logs
// (system.update_succeeded / _failed / _rolled_back) itself.
import "server-only"
import { and, desc, eq, inArray, lt } from "drizzle-orm"
import { cache } from "react"

import { updates as t } from "@/lib/i18n/vi/updates"
import {
  UPDATE_STEPS,
  UPDATER_ONLINE_WINDOW_MS,
  type UpdateBlockReason,
  type UpdateRequestStatus,
  type UpdateRequestView,
  type UpdateStatus,
  type UpdateStepName,
  type VersionBadge,
} from "@/lib/update-types"
import { isNewerVersion, parseSemver } from "@/lib/version"
import { getAppVersion } from "@/server/app-version"
import { actorOf, logActivity, type ActivityAction } from "@/server/audit/activity-log"
import { UserFacingError } from "@/server/auth/errors"
import { withReauth, type ReauthActor, type ReauthVerifier } from "@/server/auth/reauth"
import { db, type Tx } from "@/server/db/client"
import { systemUpdateRequests, user } from "@/server/db/schema"
import { consumeQuota } from "@/server/db/quota"
import {
  checkLatestRelease,
  persistCheckResult,
  readLatestRelease,
  readUpdateSettings,
  type UpdateCheckResult,
} from "@/server/jobs/lib/update-check"

/**
 * Actions the `updater` writes itself (same transaction as its status change). Listed here so the code base has one
 * place that names them next to the one the web writes (the activity-coverage test checks every action is produced).
 */
export const UPDATER_ACTIVITY_ACTIONS = [
  "system.update_succeeded",
  "system.update_failed",
  "system.update_rolled_back",
] as const satisfies readonly ActivityAction[]

/** A `pending` row nobody claimed for this long means no updater is working: it stops blocking new requests. */
export const STALE_PENDING_MS = 10 * 60_000
/** "Kiểm tra ngay": at most this many manual checks per window and user (GitHub's anonymous limit is 60/hour). */
const CHECK_QUOTA_MAX = 6
const CHECK_QUOTA_WINDOW_MS = 60_000

export type UpdateServiceErrorCode =
  | "forbidden"
  | "invalid_target"
  | "no_update"
  | "dev_build"
  | "target_mismatch"
  | "busy"
  | "updater_offline"
  | "throttled"

export class UpdateServiceError extends UserFacingError {
  constructor(
    public readonly code: UpdateServiceErrorCode,
    message: string
  ) {
    super(message)
    this.name = "UpdateServiceError"
  }
}

export type UpdateActor = ReauthActor

function assertAdmin(actor: Pick<UpdateActor, "role">): void {
  if (actor.role !== "admin") throw new UpdateServiceError("forbidden", t.errors.forbidden)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type RequestRow = Omit<typeof systemUpdateRequests.$inferSelect, "log" | "requestedBy" | "updatedAt">

/** Heartbeat younger than 90 s = updater online. */
export function isUpdaterOnline(heartbeatAt: string | null | undefined, now: Date): boolean {
  if (!heartbeatAt) return false
  const at = Date.parse(heartbeatAt)
  if (Number.isNaN(at)) return false
  const age = now.getTime() - at
  return age >= -5_000 && age < UPDATER_ONLINE_WINDOW_MS // a few seconds of clock skew is tolerated
}

/** Does this request block a new one? (running always does; a pending one only while it is young.) */
export function isBlockingRequest(r: Pick<UpdateRequestView, "status" | "createdAt">, now: Date): boolean {
  if (r.status === "running") return true
  if (r.status !== "pending") return false
  return now.getTime() - Date.parse(r.createdAt) < STALE_PENDING_MS
}

export function deriveBlockReason(input: {
  currentIsRelease: boolean
  hasUpdate: boolean
  active: Pick<UpdateRequestView, "status" | "createdAt"> | null
  updaterOnline: boolean
  now: Date
}): UpdateBlockReason | null {
  if (!input.currentIsRelease) return "dev_build"
  if (input.active && isBlockingRequest(input.active, input.now)) return "busy"
  if (!input.hasUpdate) return "no_update"
  if (!input.updaterOnline) return "updater_offline"
  return null
}

function isStep(v: string | null): v is UpdateStepName {
  return v === "rollback" || (v !== null && (UPDATE_STEPS as readonly string[]).includes(v))
}

function toView(row: RequestRow, requestedByEmail: string | null): UpdateRequestView {
  return {
    id: row.id,
    fromVersion: row.fromVersion,
    targetVersion: row.targetVersion,
    status: row.status as UpdateRequestStatus,
    step: isStep(row.step) ? row.step : null,
    message: row.message,
    requestedBy: requestedByEmail,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Aggregated state for /settings/updates and /api/updates/status (admin only - re-checked here too). */
export async function getUpdateStatus(actor: Pick<UpdateActor, "role">, now: Date = new Date()): Promise<UpdateStatus> {
  assertAdmin(actor)
  const current = getAppVersion()
  const currentIsRelease = parseSemver(current) !== null
  const [settings, rows] = await Promise.all([
    readUpdateSettings(),
    db
      // not the whole row: the technical `log` column (<= 64 KB) is never read by the web
      .select({
        id: systemUpdateRequests.id,
        fromVersion: systemUpdateRequests.fromVersion,
        targetVersion: systemUpdateRequests.targetVersion,
        status: systemUpdateRequests.status,
        step: systemUpdateRequests.step,
        message: systemUpdateRequests.message,
        createdAt: systemUpdateRequests.createdAt,
        startedAt: systemUpdateRequests.startedAt,
        finishedAt: systemUpdateRequests.finishedAt,
        email: user.email,
      })
      .from(systemUpdateRequests)
      .leftJoin(user, eq(user.id, systemUpdateRequests.requestedBy))
      .orderBy(desc(systemUpdateRequests.createdAt))
      .limit(10),
  ])
  const history = rows.map(({ email, ...r }) => toView(r, email))
  // at most one request is ever open and it is always the newest
  const open = history.find((h) => h.status === "pending" || h.status === "running") ?? null
  const hasUpdate = currentIsRelease && !!settings.latest && isNewerVersion(settings.latest.version, current)
  const updaterOnline = isUpdaterOnline(settings.heartbeat?.at, now)
  return {
    current,
    currentIsRelease,
    latest: settings.latest,
    hasUpdate,
    checkError: settings.checkError,
    updater: { online: updaterOnline, lastSeenAt: settings.heartbeat?.at ?? null, version: settings.heartbeat?.version ?? null },
    active: open,
    history,
    blockReason: deriveBlockReason({ currentIsRelease, hasUpdate, active: open, updaterOnline, now }),
    serverTime: now.toISOString(),
  }
}

/**
 * Version info for the user menu (rendered by the dashboard layout on every navigation): the running version for
 * everybody, and for admins one primary-key query for a newer known release. Never calls GitHub and never throws.
 */
export const getVersionBadge = cache(async (role: "admin" | "staff"): Promise<VersionBadge> => {
  const current = getAppVersion()
  if (role !== "admin") return { current, latestVersion: null, latestKnown: null }
  try {
    const latest = await readLatestRelease()
    const newer = !!latest && !!parseSemver(current) && isNewerVersion(latest.version, current)
    return { current, latestVersion: newer ? latest.version : null, latestKnown: latest?.version ?? null }
  } catch {
    return { current, latestVersion: null, latestKnown: null }
  }
})

// ---------------------------------------------------------------------------
// "Kiểm tra ngay"
// ---------------------------------------------------------------------------

export interface CheckNowResult {
  /** null = GitHub answered; otherwise the friendly reason (already stored as update_check_error) */
  error: string | null
  status: UpdateStatus
}

/**
 * Admin-triggered check: asks GitHub, stores the result and writes ONE `system.update_check` activity log (the
 * scheduled job does not log). Rate limited per user so the button cannot exhaust GitHub's quota. `trigger` is
 * "auto" when the update page checks by itself on open (recorded in the log metadata).
 */
export async function checkForUpdatesNow(
  actor: UpdateActor,
  now: Date = new Date(),
  trigger: "manual" | "auto" = "manual"
): Promise<CheckNowResult> {
  assertAdmin(actor)
  const quota = await consumeQuota("update-check", actor.id, CHECK_QUOTA_MAX, CHECK_QUOTA_WINDOW_MS, now.getTime())
  if (!quota.allowed) throw new UpdateServiceError("throttled", t.errors.checkThrottled(quota.retryAfterSec))
  const result: UpdateCheckResult = await checkLatestRelease({ now })
  await db.transaction(async (tx) => {
    await persistCheckResult(tx, result, now)
    await logActivity(
      {
        actor: actorOf(actor),
        action: "system.update_check",
        target: { type: "system", id: null, label: result.ok ? result.release.tag : null },
        status: result.ok ? "success" : "failure",
        metadata: result.ok
          ? { version: result.release.version, current: getAppVersion(), trigger }
          : { code: result.code, current: getAppVersion(), trigger },
      },
      tx
    )
  })
  return { error: result.ok ? null : result.message, status: await getUpdateStatus(actor, now) }
}

// ---------------------------------------------------------------------------
// "Cập nhật"
// ---------------------------------------------------------------------------

function parseTarget(raw: unknown): string {
  if (typeof raw !== "string" || !parseSemver(raw)) throw new UpdateServiceError("invalid_target", t.errors.invalidTarget)
  return raw
}

/** Everything that must hold to enqueue an update; run before the password prompt and again inside the transaction. */
async function assertCanStart(tx: Tx | typeof db, target: string, now: Date): Promise<{ current: string }> {
  const current = getAppVersion()
  if (!parseSemver(current)) throw new UpdateServiceError("dev_build", t.errors.devBuild)
  const settings = await readUpdateSettings(tx)
  if (!settings.latest || !isNewerVersion(settings.latest.version, current)) throw new UpdateServiceError("no_update", t.errors.noUpdate)
  // never trust the client's string: it must equal the release the SERVER found on GitHub
  if (settings.latest.version !== target) throw new UpdateServiceError("target_mismatch", t.errors.targetMismatch)
  const open = await tx
    .select({ status: systemUpdateRequests.status, createdAt: systemUpdateRequests.createdAt })
    .from(systemUpdateRequests)
    .where(inArray(systemUpdateRequests.status, ["pending", "running"]))
    .limit(1)
  if (open[0] && isBlockingRequest({ status: open[0].status as UpdateRequestStatus, createdAt: open[0].createdAt.toISOString() }, now))
    throw new UpdateServiceError("busy", t.errors.busy)
  if (!isUpdaterOnline(settings.heartbeat?.at, now)) throw new UpdateServiceError("updater_offline", t.errors.updaterOffline)
  return { current }
}

/** Close pending requests nobody claimed for STALE_PENDING_MS (no updater was running) so they stop blocking. */
async function expireStalePending(tx: Tx, now: Date): Promise<void> {
  await tx
    .update(systemUpdateRequests)
    .set({
      status: "failed",
      message: t.errors.staleExpired,
      finishedAt: now,
    })
    .where(and(eq(systemUpdateRequests.status, "pending"), lt(systemUpdateRequests.createdAt, new Date(now.getTime() - STALE_PENDING_MS))))
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code
  return code === "23505"
}

/**
 * Enqueue an update to `input.targetVersion`. Admin only; the target must equal the latest release stored by the
 * server (`update_latest`); re-auth (password + TOTP) through the shared gate; one open request at a time (partial
 * unique index); `system.update_requested` is logged in the same transaction as the insert.
 */
export async function startUpdate(
  actor: UpdateActor,
  input: { targetVersion: unknown },
  verify: ReauthVerifier,
  opts: { sessionId?: string; now?: Date } = {}
): Promise<{ id: string; fromVersion: string; targetVersion: string }> {
  assertAdmin(actor)
  const target = parseTarget(input.targetVersion)
  const now = opts.now ?? new Date()
  await assertCanStart(db, target, now) // precise error before asking for the password again
  return withReauth(
    actor,
    { action: "system.update_requested", target: { type: "system", id: null, label: `v${target}` }, metadata: { target } },
    verify,
    async (tx) => {
      await expireStalePending(tx, now)
      const { current } = await assertCanStart(tx, target, now)
      let row: { id: string }
      try {
        const inserted = await tx
          .insert(systemUpdateRequests)
          .values({ fromVersion: current, targetVersion: target, status: "pending", requestedBy: actor.id })
          .returning({ id: systemUpdateRequests.id })
        row = inserted[0]!
      } catch (e) {
        if (isUniqueViolation(e)) throw new UpdateServiceError("busy", t.errors.busy)
        throw e
      }
      await logActivity(
        {
          actor: actorOf(actor),
          action: "system.update_requested",
          target: { type: "system", id: row.id, label: `v${current} -> v${target}` },
          metadata: { from: current, target },
        },
        tx
      )
      return { id: row.id, fromVersion: current, targetVersion: target }
    },
    { sessionId: opts.sessionId }
  )
}
