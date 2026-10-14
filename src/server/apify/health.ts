// Apify token checks (16-apify.md §4): GET /v2/users/me + /v2/users/me/limits (both free) for every live token that
// is not disabled, storing account info + status. Used by the apify.health job (every 6 hours) and by the
// "Kiểm tra lại" service. Transient failures (rate limit, timeout, 5xx, network) leave the row untouched; status
// writes never bump updated_at and never touch a deleted / disabled row. The job also deletes apify_runs > 90 days.
// No imports from "next/*" or "server-only" (bundled into the worker). Nothing secret is logged (counts only).
import { and, isNull, ne } from "drizzle-orm"

import { apifyErrors as msg } from "@/lib/i18n/vi/apify-errors"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { db } from "@/server/db/client"
import { apifyTokens } from "@/server/db/schema"
import { mapLimit } from "@/server/jobs/types"
import { invalidateGrantCache } from "@/server/mcp/grant"

import {
  APIFY_MIN_CREDIT_USD,
  getAccountInfo,
  remainingCreditUsd,
} from "./actors"
import type { FetchLike } from "./client"
import { ApifyError, apifyErrorText, isApifyError } from "./errors"
import { deleteOldApifyRuns } from "./pool"
import {
  ApifyTokenUnreadableError,
  decryptApifyToken,
  saveApifyTokenCheck,
  type ApifyStatusPatch,
  type ApifyTokenRow,
} from "./store"
import type { ApifyAccountInfo } from "./types"

export const APIFY_HEALTH_CONCURRENCY = 3
/** apify_runs rows kept this long (16-apify.md §3) */
export const APIFY_RUNS_RETENTION_DAYS = 90
const EXHAUSTED_FALLBACK_MS = 24 * 3_600_000

export interface ApifyCheckOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
  baseUrl?: string
  now?: number
}

export type ApifyCheckResult =
  /** Apify answered: account info + the status it implies (active / exhausted / error when Actors are disabled) */
  | { kind: "ok"; account: ApifyAccountInfo; patch: ApifyStatusPatch }
  /** the token / account is broken (401 → invalid, out of credit → exhausted, other refusal → error) */
  | { kind: "failed"; patch: ApifyStatusPatch; error: ApifyError | null }
  /** Apify unreachable (rate limit, timeout, 5xx, network, abort): keep the row as it is */
  | { kind: "transient"; error: ApifyError }

function untilOf(cycleEnd: string | Date | null, now: number): Date {
  const t = cycleEnd ? new Date(cycleEnd).getTime() : NaN
  return Number.isFinite(t) && t > now
    ? new Date(t)
    : new Date(now + EXHAUSTED_FALLBACK_MS)
}

/**
 * Status implied by fresh account info: no credit left (remaining < $0.05) → exhausted until the cycle ends; Actors
 * disabled on the account for another reason → error; otherwise active.
 */
export function statusFromAccount(
  info: ApifyAccountInfo,
  now = Date.now()
): ApifyStatusPatch {
  const rem = remainingCreditUsd(info)
  if (rem !== null && rem < APIFY_MIN_CREDIT_USD)
    return {
      status: "exhausted",
      statusMessage: msg.status.outOfCredit,
      exhaustedUntil: untilOf(info.cycleEndAt, now),
    }
  if (!info.actorsEnabled)
    return { status: "error", statusMessage: msg.status.actorsDisabled }
  return { status: "active", statusMessage: null, exhaustedUntil: null }
}

/** Check a plaintext token (create / preview / replace / recheck / job). Never throws for Apify failures. */
export async function checkApifySecret(
  secret: string,
  o: ApifyCheckOptions & { cycleEndAt?: Date | null } = {}
): Promise<ApifyCheckResult> {
  const now = o.now ?? Date.now()
  try {
    const account = await getAccountInfo({
      token: secret,
      signal: o.signal,
      fetchImpl: o.fetchImpl,
      baseUrl: o.baseUrl,
    })
    return { kind: "ok", account, patch: statusFromAccount(account, now) }
  } catch (e) {
    const err = isApifyError(e) ? e : new ApifyError("network")
    if (err.retryable || err.code === "aborted")
      return { kind: "transient", error: err }
    if (err.rotate === "invalid")
      return {
        kind: "failed",
        error: err,
        patch: { status: "invalid", statusMessage: apifyErrorText(err) },
      }
    if (err.rotate === "exhausted")
      return {
        kind: "failed",
        error: err,
        patch: {
          status: "exhausted",
          statusMessage: msg.status.outOfCredit,
          exhaustedUntil: untilOf(o.cycleEndAt ?? null, now),
        },
      }
    return {
      kind: "failed",
      error: err,
      patch: { status: "error", statusMessage: apifyErrorText(err) },
    }
  }
}

/** Check a stored token (decrypts it here; an unreadable ciphertext → error). */
export async function checkApifyTokenRow(
  row: Pick<ApifyTokenRow, "id" | "credentialsEncrypted" | "cycleEndAt">,
  o: ApifyCheckOptions = {}
): Promise<ApifyCheckResult> {
  let secret: string
  try {
    secret = decryptApifyToken(row)
  } catch (e) {
    if (!(e instanceof ApifyTokenUnreadableError)) throw e
    return {
      kind: "failed",
      error: null,
      patch: {
        status: "error",
        statusMessage: msg.service.credentialsUnreadable,
      },
    }
  }
  return checkApifySecret(secret, { ...o, cycleEndAt: row.cycleEndAt })
}

export interface ApifyHealthSummary {
  active: number
  exhausted: number
  invalid: number
  error: number
  /** transient failures (row unchanged) */
  skipped: number
  runsDeleted: number
}

/** Job apify.health: check every live, not disabled token; delete old run records. One bad row never stops it. */
export async function runApifyHealth(
  ctx: ApifyCheckOptions & { log?: (msg: string) => void } = {}
): Promise<ApifyHealthSummary> {
  const summary: ApifyHealthSummary = {
    active: 0,
    exhausted: 0,
    invalid: 0,
    error: 0,
    skipped: 0,
    runsDeleted: 0,
  }
  const rows = await db
    .select()
    .from(apifyTokens)
    .where(
      and(isNull(apifyTokens.deletedAt), ne(apifyTokens.status, "disabled"))
    )
  let changed = false
  await mapLimit(
    rows,
    APIFY_HEALTH_CONCURRENCY,
    async (row) => {
      try {
        const r = await checkApifyTokenRow(row, ctx)
        if (r.kind === "transient") {
          summary.skipped++
          return
        }
        summary[r.patch.status]++
        const saved = await saveApifyTokenCheck(row.id, {
          ...r.patch,
          account: r.kind === "ok" ? r.account : null,
          // the token that was checked: a token replaced / disabled meanwhile is left alone
          ciphertext: row.credentialsEncrypted,
        })
        if (saved && (r.patch.status !== row.status || r.kind === "ok"))
          changed = true
      } catch (e) {
        summary.skipped++
        ctx.log?.(`apify.health: check failed: ${safeErrorForLog(e)}`)
      }
    },
    ctx.signal
  )
  try {
    summary.runsDeleted = await deleteOldApifyRuns(APIFY_RUNS_RETENTION_DAYS)
  } catch (e) {
    ctx.log?.(`apify.health: runs cleanup failed: ${safeErrorForLog(e)}`)
  }
  // per process: the worker has no grant cache of its own to speak of, the web one expires within seconds
  if (changed) invalidateGrantCache()
  ctx.log?.(
    `apify.health: active=${summary.active} exhausted=${summary.exhausted} invalid=${summary.invalid} ` +
      `error=${summary.error} skipped=${summary.skipped} runs_deleted=${summary.runsDeleted}`
  )
  return summary
}
