// Token pool + rotation for Apify runs (16-apify.md §5) and the apify_runs records. No imports from "next/*".
// - pickToken: groups the MCP's tokens by Apify account (tokens of one account share the credit; an unknown account
//   id is its own group), drops accounts exhausted until a future date, then picks an account at random weighted by
//   its remaining credit (cached ≤ 5 min - older data is re-read before relying on it) and a token of it at random.
// - runWithRotation: starts with the picked token; a failure whose ApifyError.rotate is set moves on to another token
//   (≤ 3 attempts, within the tool's time budget): "exhausted" marks the whole account until its credit cycle ends,
//   "invalid" marks the token, "busy" skips the account this time. Any other failure is returned at once.
// - every token status change is written without bumping updated_at, then invalidateGrantCache().
// - recordRun / loadRunForMcp / updateRunStatus / mcpApifySpendToday: the pinned-token run records.
import { randomUUID } from "node:crypto"
import { and, eq, gte, ne, sql } from "drizzle-orm"

import { apifyErrors as msg } from "@/lib/i18n/vi/apify-errors"
import { zonedDayStart } from "@/lib/schemas/logs"
import { db, type Tx } from "@/server/db/client"
import { apifyRuns } from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"

import {
  abortRun,
  APIFY_MIN_CREDIT_USD,
  APIFY_TERMINAL_STATUSES,
  getLimits,
  getRun,
  remainingCreditUsd,
  startActorRun,
  validateActorInput,
  type ApifyCallContext,
  type ApifyRun,
  type StartedRun,
  type StartRunOptions,
} from "./actors"
import { clampToDeadline, type FetchLike } from "./client"
import { ApifyError, apifyErrorText, isApifyError } from "./errors"
import {
  ApifyTokenUnreadableError,
  decryptApifyToken,
  loadApifyToken,
  loadApifyTokenRow,
  markApifyAccountExhausted,
  markApifyTokenInvalid,
  saveApifyTokenCheck,
  saveApifyTokenLimits,
  touchApifyTokenUsed,
} from "./store"
import type { ApifyRunRecord, GrantApifyToken, PickedApifyToken } from "./types"

export const APIFY_POOL = {
  /** start attempts per run (different tokens / accounts) */
  maxAttempts: 3,
  /** cached usage / limit older than this is re-read (GET /users/me/limits, free) before a run */
  creditStaleMs: 5 * 60_000,
  /** default time budget of one tool call (ChatGPT cuts at 60 s) */
  budgetMs: 45_000,
  /** do not begin another attempt with less time left than this */
  minAttemptMs: 5_000,
  /** exhausted without a known cycle end: retry the account after 24 h */
  exhaustedFallbackMs: 24 * 3_600_000,
  /** unknown credit counts as this much (USD) in the weighted pick */
  unknownCreditWeight: 1,
} as const

const DB_TZ_DAY = "Asia/Ho_Chi_Minh"

/** Accounts are grouped by apify_user_id; a token whose account is unknown is its own group. */
export function apifyAccountKey(
  t: Pick<GrantApifyToken, "id" | "apifyUserId">
): string {
  return t.apifyUserId ? `u:${t.apifyUserId}` : `t:${t.id}`
}

/** active, or exhausted whose exhausted_until has passed */
export function isGrantTokenUsable(
  t: Pick<GrantApifyToken, "status" | "exhaustedUntil">,
  now = Date.now()
): boolean {
  if (t.status === "active") return true
  return t.exhaustedUntil !== null && Date.parse(t.exhaustedUntil) <= now
}

/**
 * The cached usage / limit of a token cannot be trusted: read more than 5 min ago, its credit cycle has ended, or it
 * was marked exhausted until a date that has passed. Its remaining credit then counts as unknown (never "too low")
 * and the pool re-reads /users/me/limits before using it.
 */
export function isCreditCacheStale(
  t: Pick<GrantApifyToken, "lastCheckedAt" | "cycleEndAt" | "status" | "exhaustedUntil">,
  now = Date.now()
): boolean {
  const checked = t.lastCheckedAt ? Date.parse(t.lastCheckedAt) : NaN
  if (!Number.isFinite(checked) || now - checked > APIFY_POOL.creditStaleMs) return true
  if (t.cycleEndAt && Date.parse(t.cycleEndAt) <= now) return true
  return (
    t.status === "exhausted" &&
    t.exhaustedUntil !== null &&
    Date.parse(t.exhaustedUntil) <= now
  )
}

/** credit a run needs on an account: min(run cap, $0.05) */
export function minCreditFor(runMaxUsd: number): number {
  return Math.min(Math.max(runMaxUsd, 0), APIFY_MIN_CREDIT_USD)
}

export interface PickOptions {
  /** an account with less known remaining credit is skipped */
  minCreditUsd: number
  /** token ids not to use */
  excludeTokens?: ReadonlySet<string>
  /** account keys (apifyAccountKey) not to use */
  excludeAccounts?: ReadonlySet<string>
  now?: number
  /** tests: deterministic draw in [0, 1) */
  random?: () => number
}

interface AccountGroup {
  key: string
  tokens: GrantApifyToken[]
  /** known remaining credit (newest check of the group), null = unknown */
  remaining: number | null
}

/** Usable accounts of a token list (see pickToken), with their remaining credit. Exported for tests / summaries. */
export function usableAccounts(
  tokens: readonly GrantApifyToken[],
  o: PickOptions
): AccountGroup[] {
  const now = o.now ?? Date.now()
  const byKey = new Map<string, GrantApifyToken[]>()
  for (const t of tokens) {
    const k = apifyAccountKey(t)
    const list = byKey.get(k)
    if (list) list.push(t)
    else byKey.set(k, [t])
  }
  const out: AccountGroup[] = []
  for (const [key, list] of byKey) {
    if (o.excludeAccounts?.has(key)) continue
    // shared credit: one token exhausted until a future date = the whole account
    if (list.some((t) => !isGrantTokenUsable(t, now))) continue
    const avail = list.filter((t) => !o.excludeTokens?.has(t.id))
    if (avail.length === 0) continue
    // newest check of the account with usage + limit; stale data = unknown credit (re-read before the run)
    const checked = list
      .filter((t) => t.usageUsd !== null && t.limitUsd !== null)
      .sort(
        (a, b) =>
          Date.parse(b.lastCheckedAt ?? "") - Date.parse(a.lastCheckedAt ?? "") ||
          0
      )[0]
    const remaining =
      checked && !isCreditCacheStale(checked, now)
        ? remainingCreditUsd(checked)
        : null
    if (remaining !== null && remaining < o.minCreditUsd) continue
    out.push({ key, tokens: avail, remaining })
  }
  return out
}

/**
 * Pick a token for one run: weighted random over usable accounts (weight = remaining credit, unknown = $1), then a
 * uniformly random token of that account. null when nothing is usable.
 */
export function pickToken(
  tokens: readonly GrantApifyToken[],
  o: PickOptions
): GrantApifyToken | null {
  const groups = usableAccounts(tokens, o)
  if (groups.length === 0) return null
  const random = o.random ?? Math.random
  const weights = groups.map((g) =>
    Math.max(g.remaining ?? APIFY_POOL.unknownCreditWeight, 0.01)
  )
  const sum = weights.reduce((a, b) => a + b, 0)
  let r = random() * sum
  let group = groups[groups.length - 1]!
  for (let i = 0; i < groups.length; i++) {
    r -= weights[i]!
    if (r < 0) {
      group = groups[i]!
      break
    }
  }
  return group.tokens[
    Math.min(
      Math.floor(random() * group.tokens.length),
      group.tokens.length - 1
    )
  ]!
}

export interface RotationOptions {
  /** per-run cap (USD): an account needs min(cap, $0.05) of known remaining credit */
  runMaxUsd: number
  signal?: AbortSignal
  /** epoch ms the whole rotation must finish by (default now + 45 s) */
  deadline?: number
  maxAttempts?: number
  /** tests */
  random?: () => number
  now?: () => number
  fetchImpl?: FetchLike
  baseUrl?: string
}

export interface RotationResult<T> {
  result: T
  tokenId: string
  apifyUserId: string | null
  /** start attempts made (1 = the first token worked) */
  attempts: number
}

function exhaustedUntil(cycleEnd: Date | string | null, now: number): Date {
  const t = cycleEnd ? new Date(cycleEnd).getTime() : NaN
  return Number.isFinite(t) && t > now
    ? new Date(t)
    : new Date(now + APIFY_POOL.exhaustedFallbackMs)
}

/**
 * Run `startFn` with a token of the pool, rotating per 16-apify.md §5. `tokens` = grant.apifyTokens (no secrets:
 * each picked token's secret is decrypted here, handed to startFn and never kept). Throws:
 * - the startFn error when it is not a rotation case (ApifyError.rotate === null, or any other error);
 * - ApifyError "no_token" when no usable token is left (or the attempts are used up), or the last "busy" error when
 *   every account was busy; "timeout" when the time budget ran out; "aborted" when the caller left.
 */
export async function runWithRotation<T>(
  tokens: readonly GrantApifyToken[],
  startFn: (picked: PickedApifyToken, ctx: ApifyCallContext) => Promise<T>,
  o: RotationOptions
): Promise<RotationResult<T>> {
  const now = o.now ?? Date.now
  const deadline = o.deadline ?? now() + APIFY_POOL.budgetMs
  const maxAttempts = o.maxAttempts ?? APIFY_POOL.maxAttempts
  const minCreditUsd = minCreditFor(o.runMaxUsd)
  // local copy: refreshed credit is visible to the next pick
  const local = tokens.map((t) => ({ ...t }))
  const excludeTokens = new Set<string>()
  const excludeAccounts = new Set<string>()
  let attempts = 0
  let lastError: ApifyError | null = null
  let outOfTime = false
  let changed = false

  const markExhausted = async (
    t: { id: string; apifyUserId: string | null; ciphertext: string },
    cycleEnd: Date | string | null
  ) => {
    await markApifyAccountExhausted(
      t,
      exhaustedUntil(cycleEnd, now()),
      msg.status.outOfCredit
    )
    excludeAccounts.add(apifyAccountKey(t))
    changed = true
  }
  /** an error that only skips this account / token for this run (the last one is reported if nothing works) */
  let lastSkip: ApifyError | null = null

  try {
    while (attempts < maxAttempts) {
      if (o.signal?.aborted) throw new ApifyError("aborted")
      if (deadline - now() < APIFY_POOL.minAttemptMs) {
        outOfTime = true
        break
      }
      const t = pickToken(local, {
        minCreditUsd,
        excludeTokens,
        excludeAccounts,
        now: now(),
        random: o.random,
      })
      if (!t) break

      const row = await loadApifyTokenRow(t.id)
      // deleted / disabled / rejected since the grant was built
      if (!row || !["active", "exhausted"].includes(row.status)) {
        excludeTokens.add(t.id)
        continue
      }
      // marked out of credit meanwhile (another request): skip the whole account
      if (
        row.status === "exhausted" &&
        (!row.exhaustedUntil || row.exhaustedUntil.getTime() > now())
      ) {
        excludeAccounts.add(apifyAccountKey(t))
        continue
      }
      // every write below is bound to THIS ciphertext: a token replaced meanwhile is never marked
      const ciphertext = row.credentialsEncrypted
      let secret: string
      try {
        secret = decryptApifyToken(row)
      } catch (e) {
        if (!(e instanceof ApifyTokenUnreadableError)) throw e
        await saveApifyTokenCheck(t.id, {
          status: "error",
          statusMessage: msg.service.credentialsUnreadable,
          checked: false,
          ciphertext,
        })
        changed = true
        excludeTokens.add(t.id)
        continue
      }
      const account = {
        id: t.id,
        apifyUserId: row.apifyUserId ?? t.apifyUserId,
        ciphertext,
      }
      const ctx: ApifyCallContext = {
        token: secret,
        signal: o.signal,
        // every Apify call of this attempt (limits, validate, start, recovery) ends before the deadline
        deadline,
        fetchImpl: o.fetchImpl,
        baseUrl: o.baseUrl,
      }
      const refreshLimits = async () => {
        const limits = await getLimits({ ...ctx, timeoutMs: 8_000 })
        await saveApifyTokenLimits(t.id, { ...limits, ciphertext })
        const key = apifyAccountKey(t)
        for (const x of local) {
          if (apifyAccountKey(x) !== key) continue
          x.usageUsd = limits.usageUsd
          x.limitUsd = limits.limitUsd
          x.cycleEndAt = limits.cycleEndAt
          x.lastCheckedAt = new Date(now()).toISOString()
        }
        return limits
      }

      // stale credit data (> 5 min, cycle ended, exhausted_until passed): re-read it first (free call)
      if (isCreditCacheStale(t, now())) {
        try {
          const limits = await refreshLimits()
          const rem = remainingCreditUsd(limits)
          if (rem !== null && rem < minCreditUsd) {
            await markExhausted(account, limits.cycleEndAt)
            continue
          }
          // credit is back (new cycle / limit raised): the token is active again
          if (row.status === "exhausted") {
            await saveApifyTokenCheck(t.id, {
              status: "active",
              statusMessage: null,
              ciphertext,
            })
            changed = true
          }
        } catch (e) {
          if (!isApifyError(e)) throw e
          if (e.code === "aborted") throw e
          if (e.rotate === "invalid") {
            await markApifyTokenInvalid(t.id, apifyErrorText(e), { ciphertext })
            changed = true
            excludeTokens.add(t.id)
            lastError = e
            continue
          }
          if (e.rotate === "exhausted") {
            // cannot be verified here: skip the account for this run, mark nothing
            excludeAccounts.add(apifyAccountKey(account))
            lastError = lastSkip = e
            continue
          }
          // transient: go on with the cached data
        }
      }

      attempts++
      try {
        const result = await startFn(
          { tokenId: t.id, apifyUserId: account.apifyUserId, secret },
          ctx
        )
        await touchApifyTokenUsed(t.id).catch(() => {})
        return {
          result,
          tokenId: t.id,
          apifyUserId: account.apifyUserId,
          attempts,
        }
      } catch (e) {
        if (!isApifyError(e) || e.rotate === null) throw e
        lastError = e
        // never the same token twice in one rotation, whatever the account key says
        excludeTokens.add(t.id)
        if (e.rotate === "exhausted") {
          // a credit-type refusal of ONE run (an expensive Actor, a minimum charge…) must not take the whole account
          // out for hours: mark it only when the free limits read confirms the credit is really gone
          let confirmed = false
          let cycleEnd: Date | string | null = row.cycleEndAt
          try {
            const limits = await refreshLimits()
            const rem = remainingCreditUsd(limits)
            confirmed = rem !== null && rem < minCreditUsd
            cycleEnd = limits.cycleEndAt ?? cycleEnd
          } catch (le) {
            if (isApifyError(le) && le.rotate === "invalid") {
              await markApifyTokenInvalid(t.id, apifyErrorText(le), { ciphertext })
              changed = true
            }
          }
          if (confirmed) await markExhausted(account, cycleEnd)
          else {
            excludeAccounts.add(apifyAccountKey(account))
            lastSkip = e
          }
        } else if (e.rotate === "invalid") {
          await markApifyTokenInvalid(t.id, apifyErrorText(e), { ciphertext })
          changed = true
        } else if (e.code === "insufficient_permissions") lastSkip = e
        // busy (RAM / concurrent runs / paid plan): the account, this time only - nothing is marked
        else {
          excludeAccounts.add(apifyAccountKey(account))
          lastSkip = e
        }
      }
    }
  } finally {
    if (changed) invalidateGrantCache()
  }
  // an account was only skipped (busy / paid plan / unconfirmed credit refusal): report that reason, not
  // "no token" - even when another token turned out invalid
  if (lastSkip) throw lastSkip
  if (outOfTime && attempts === 0 && !lastError) throw new ApifyError("timeout")
  throw new ApifyError("no_token")
}

// ---------------------------------------------------------------------------------------------------------------
// One-call helper for the MCP tools: rotate → validate input (free) → start → record (token pinned) → abort if
// the caller left meanwhile
// ---------------------------------------------------------------------------------------------------------------

export interface StartForMcpParams {
  mcpId: string
  /** grant.apifyTokens */
  tokens: readonly GrantApifyToken[]
  /** "username~name" */
  actorId: string
  /** catalog task; null = Actor outside the catalog */
  taskKey: string | null
  input: Record<string, unknown>
  /** ceilings (timeoutSecs ≤ 600, memory ≤ 4096, maxTotalChargeUsd = the effective per-run cap, wait ≤ 25) */
  run: Omit<StartRunOptions, "deadline" | "isRunTaken">
  /** POST validate-input first (default true) */
  validate?: boolean
  /**
   * Daily cap of the MCP (USD, Asia/Ho_Chi_Minh day; advanced protection mode). undefined / non-finite / ≤ 0 = no
   * daily cap. When set, the run's cap is RESERVED atomically before anything starts (per-MCP advisory lock): spend
   * today + this cap > dailyMaxUsd → ApifyError "daily_budget_exceeded"; concurrent calls see each other's
   * reservations.
   */
  dailyMaxUsd?: number
  signal?: AbortSignal
  deadline?: number
  random?: () => number
  fetchImpl?: FetchLike
  baseUrl?: string
}

export interface StartForMcpResult {
  record: ApifyRunRecord
  run: StartedRun
  tokenId: string
  attempts: number
}

/** placeholder run_id of a reservation (never matches loadRunForMcp's run id pattern) */
const RESERVATION_PREFIX = "pending:"
/** status of a reservation row (counted at its max_charge_usd by mcpApifySpendToday) */
export const APIFY_RESERVATION_STATUS = "STARTING"
/** status of a reservation kept after an uncertain start (a run may exist; still counted at its cap today) */
export const APIFY_UNKNOWN_STATUS = "UNKNOWN"

/** USD for messages: up to 4 decimals, no trailing zeros */
function fmtUsd(v: number): string {
  return String(Math.round(v * 10_000) / 10_000)
}

/** a run id already recorded for ANOTHER MCP (recovery after an ambiguous start must not adopt / abort it) */
export async function runTakenByOtherMcp(
  mcpId: string,
  runId: string,
  tx: DbLike = db
): Promise<boolean> {
  const [row] = await tx
    .select({ id: apifyRuns.id })
    .from(apifyRuns)
    .where(and(eq(apifyRuns.runId, runId), ne(apifyRuns.mcpId, mcpId)))
    .limit(1)
  return !!row
}

/**
 * Reserve `capUsd` of the MCP's daily budget: under pg_advisory_xact_lock('apify:<mcpId>'), read today's spend
 * (reservations included) and insert a STARTING row when spend + cap ≤ dailyMaxUsd. The row's token_id is a
 * placeholder (a token of the grant) until the run is known.
 */
export async function reserveDailyBudget(p: {
  mcpId: string
  tokenId: string
  actorId: string
  taskKey: string | null
  capUsd: number
  dailyMaxUsd: number
  now?: Date
}): Promise<{ id: string; spentUsd: number }> {
  const cap = usd(p.capUsd) ?? 0
  if (cap <= 0) throw new ApifyError("charge_limit_invalid", { hint: null })
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`apify:${p.mcpId}`}))`
    )
    const spent = await mcpApifySpendToday(p.mcpId, p.now ?? new Date(), tx)
    if (spent + cap > p.dailyMaxUsd + 0.00005)
      throw new ApifyError("daily_budget_exceeded", {
        message: msg.dailyBudgetDetail(fmtUsd(spent), fmtUsd(cap), fmtUsd(p.dailyMaxUsd)),
      })
    const id = randomUUID()
    await tx.insert(apifyRuns).values({
      id,
      mcpId: p.mcpId,
      tokenId: p.tokenId,
      actorId: p.actorId.slice(0, 200),
      taskKey: p.taskKey,
      runId: `${RESERVATION_PREFIX}${id}`,
      status: APIFY_RESERVATION_STATUS,
      maxChargeUsd: cap,
    })
    return { id, spentUsd: spent }
  })
}

/** Postgres unique violation (also wrapped by drizzle) */
function isUniqueViolation(e: unknown): boolean {
  const code =
    (e as { code?: unknown } | null)?.code ??
    (e as { cause?: { code?: unknown } } | null)?.cause?.code
  return code === "23505"
}

/** the reservation stays counted but nobody knows whether a run exists: status UNKNOWN, bound to `tokenId` */
async function markReservationUnknown(
  reservationId: string,
  tokenId: string | null
): Promise<void> {
  await db
    .update(apifyRuns)
    .set({
      status: APIFY_UNKNOWN_STATUS,
      ...(tokenId ? { tokenId } : {}),
    })
    .where(eq(apifyRuns.id, reservationId))
}

/**
 * The reservation becomes the run's record - an atomic CLAIM: the unique index on run_id (non-reservation rows)
 * makes a second MCP fail. Dropped when this MCP already recorded the run. Run owned by another MCP → the
 * reservation is marked UNKNOWN (still counted) and ApifyError "start_uncertain" is thrown.
 */
async function settleReservation(
  reservationId: string,
  p: {
    mcpId: string
    tokenId: string
    run: ApifyRun
    actorId: string
    taskKey: string | null
    capUsd: number
  }
): Promise<ApifyRunRecord> {
  const existing = await loadRunForMcp(p.mcpId, p.run.id)
  if (existing) {
    // the same run recorded by an earlier call of this MCP (recovery): its own row already counts it
    await db.delete(apifyRuns).where(eq(apifyRuns.id, reservationId))
    await updateRunStatus(existing.id, runPatch(p.run))
    return (await loadRunForMcp(p.mcpId, p.run.id)) ?? existing
  }
  let row: RunRow | undefined
  try {
    ;[row] = await db
      .update(apifyRuns)
      .set({
        tokenId: p.tokenId,
        runId: p.run.id,
        datasetId: p.run.defaultDatasetId,
        status: p.run.status,
        usageUsd: usd(p.run.usageTotalUsd),
        startedAt: p.run.startedAt ? new Date(p.run.startedAt) : new Date(),
        finishedAt: p.run.finishedAt ? new Date(p.run.finishedAt) : null,
      })
      .where(eq(apifyRuns.id, reservationId))
      .returning()
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    // another MCP owns this run: never share it; whether OUR start created a run stays unknown
    await markReservationUnknown(reservationId, p.tokenId).catch(() => {})
    throw new ApifyError("start_uncertain")
  }
  if (row) return toRecord(row)
  // the reservation vanished (deleted meanwhile): record the run the normal way
  return recordRun({
    mcpId: p.mcpId,
    tokenId: p.tokenId,
    actorId: p.actorId,
    taskKey: p.taskKey,
    run: p.run,
    maxChargeUsd: p.capUsd,
  })
}

/**
 * One call for the MCP tools: [reserve the daily budget] → rotate tokens → validate input (free) → start → record
 * the run with its token pinned (atomic claim) → abort it if the client already left. Every Apify call of the start
 * path is clamped to `deadline` (default now + 45 s).
 * Reservation outcome: run started → the row becomes the run record; definite failure (nothing can have started:
 * validation, refusals, no token…) → row deleted; client aborted mid-POST → the run found was aborted and recorded at
 * its real cost (none found → row deleted, lookup failed → UNKNOWN); start possibly happened (start_uncertain,
 * unexpected error) → row KEPT with status UNKNOWN (still counted at its cap today, bound to the token that tried).
 */
export async function startActorRunForMcp(
  p: StartForMcpParams
): Promise<StartForMcpResult> {
  const deadline = p.deadline ?? Date.now() + APIFY_POOL.budgetMs
  const daily =
    typeof p.dailyMaxUsd === "number" &&
    Number.isFinite(p.dailyMaxUsd) &&
    p.dailyMaxUsd > 0
      ? p.dailyMaxUsd
      : null
  if (daily !== null && p.tokens.length === 0) throw new ApifyError("no_token")
  const reservation =
    daily === null
      ? null
      : await reserveDailyBudget({
          mcpId: p.mcpId,
          tokenId: p.tokens[0]!.id,
          actorId: p.actorId,
          taskKey: p.taskKey,
          capUsd: p.run.maxTotalChargeUsd,
          dailyMaxUsd: daily,
        })
  /** token whose start POST may have created a run (uncertain outcome) */
  let mayHaveStartedWith: string | null = null
  /** the client aborted during the POST: what the run lookup found, with the token / context used */
  let aborted: {
    outcome: ApifyRun | "none" | "unknown"
    tokenId: string
    ctx: ApifyCallContext
  } | null = null
  let rotation: RotationResult<StartedRun>
  try {
    rotation = await runWithRotation(
      p.tokens,
      async (picked, ctx) => {
        if (p.validate !== false)
          await validateActorInput(ctx, p.actorId, p.input, {
            build: p.run.build,
          })
        try {
          return await startActorRun(ctx, p.actorId, p.input, {
            ...p.run,
            isRunTaken: (runId) => runTakenByOtherMcp(p.mcpId, runId),
            onAbortRecovery: (outcome) => {
              aborted = { outcome, tokenId: picked.tokenId, ctx }
            },
          })
        } catch (e) {
          if (
            !isApifyError(e) ||
            e.code === "start_uncertain" ||
            e.code === "aborted"
          )
            mayHaveStartedWith = picked.tokenId
          throw e
        }
      },
      {
        runMaxUsd: p.run.maxTotalChargeUsd,
        signal: p.signal,
        deadline,
        random: p.random,
        fetchImpl: p.fetchImpl,
        baseUrl: p.baseUrl,
      }
    )
  } catch (e) {
    if (reservation)
      await settleFailedStart(reservation.id, {
        mcpId: p.mcpId,
        actorId: p.actorId,
        taskKey: p.taskKey,
        capUsd: p.run.maxTotalChargeUsd,
        mayHaveStartedWith,
        aborted,
        deadline,
      }).catch(() => {})
    throw e
  }
  let run = rotation.result
  const record = reservation
    ? await settleReservation(reservation.id, {
        mcpId: p.mcpId,
        tokenId: rotation.tokenId,
        run,
        actorId: p.actorId,
        taskKey: p.taskKey,
        capUsd: p.run.maxTotalChargeUsd,
      })
    : await recordRun({
        mcpId: p.mcpId,
        tokenId: rotation.tokenId,
        actorId: p.actorId,
        taskKey: p.taskKey,
        run,
        maxChargeUsd: p.run.maxTotalChargeUsd,
      })
  if (p.signal?.aborted && !run.isTerminal) {
    // the client left right after the start: stop the run (no money spent for nobody), with the pinned token
    try {
      const loaded = await loadApifyToken(rotation.tokenId)
      if (loaded) {
        const stopped = await abortRun(
          {
            token: loaded.secret,
            signal: AbortSignal.timeout(clampToDeadline(5_000, deadline)),
            deadline,
            fetchImpl: p.fetchImpl,
            baseUrl: p.baseUrl,
          },
          run.id
        )
        run = { ...stopped, recovered: run.recovered }
        await updateRunStatus(record.id, runPatch(stopped))
      }
    } catch {
      // best effort; the run stops at its own timeout / cost cap anyway
    }
  }
  return {
    record,
    run,
    tokenId: rotation.tokenId,
    attempts: rotation.attempts,
  }
}

/** Reservation of a start that failed: delete / record the aborted run at its real cost / keep it as UNKNOWN. */
async function settleFailedStart(
  reservationId: string,
  f: {
    mcpId: string
    actorId: string
    taskKey: string | null
    capUsd: number
    mayHaveStartedWith: string | null
    aborted: {
      outcome: ApifyRun | "none" | "unknown"
      tokenId: string
      ctx: ApifyCallContext
    } | null
    deadline: number
  }
): Promise<void> {
  if (f.aborted) {
    const { outcome, tokenId, ctx } = f.aborted
    if (outcome === "none") {
      await db.delete(apifyRuns).where(eq(apifyRuns.id, reservationId))
      return
    }
    if (outcome !== "unknown") {
      // the run was found and aborted: record it (claim) at its real cost instead of the reserved cap
      let run: ApifyRun = outcome
      if (!run.isTerminal) {
        run = await getRun(
          { ...ctx, signal: AbortSignal.timeout(clampToDeadline(3_000, f.deadline)) },
          run.id
        ).catch(() => run)
      }
      await settleReservation(reservationId, {
        mcpId: f.mcpId,
        tokenId,
        run,
        actorId: f.actorId,
        taskKey: f.taskKey,
        capUsd: f.capUsd,
      })
      return
    }
    await markReservationUnknown(reservationId, tokenId)
    return
  }
  if (f.mayHaveStartedWith) {
    await markReservationUnknown(reservationId, f.mayHaveStartedWith)
    return
  }
  // nothing can have started (validation, refusal, no token, budget…)
  await db.delete(apifyRuns).where(eq(apifyRuns.id, reservationId))
}

// ---------------------------------------------------------------------------------------------------------------
// apify_runs
// ---------------------------------------------------------------------------------------------------------------

type DbLike = Tx | typeof db
type RunRow = typeof apifyRuns.$inferSelect

function toRecord(r: RunRow): ApifyRunRecord {
  return {
    id: r.id,
    mcpId: r.mcpId,
    tokenId: r.tokenId,
    actorId: r.actorId,
    taskKey: r.taskKey,
    runId: r.runId,
    datasetId: r.datasetId,
    status: r.status,
    maxChargeUsd: r.maxChargeUsd,
    usageUsd: r.usageUsd,
    itemCount: r.itemCount,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }
}

const usd = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? null
    : Math.round(v * 10_000) / 10_000

/**
 * Store a run just started - an atomic claim: idempotent for the same MCP (a recovered run is not recorded twice);
 * a run already owned by ANOTHER MCP → ApifyError "start_uncertain" (two MCPs never own one run).
 */
export async function recordRun(
  p: {
    mcpId: string
    tokenId: string
    actorId: string
    taskKey: string | null
    run: ApifyRun
    maxChargeUsd: number
  },
  tx: DbLike = db
): Promise<ApifyRunRecord> {
  const values = {
    mcpId: p.mcpId,
    tokenId: p.tokenId,
    actorId: p.actorId.slice(0, 200),
    taskKey: p.taskKey,
    runId: p.run.id,
    datasetId: p.run.defaultDatasetId,
    status: p.run.status,
    maxChargeUsd: usd(p.maxChargeUsd) ?? 0,
    usageUsd: usd(p.run.usageTotalUsd),
    startedAt: p.run.startedAt ? new Date(p.run.startedAt) : new Date(),
    finishedAt: p.run.finishedAt ? new Date(p.run.finishedAt) : null,
  }
  // atomic claim: the unique index on run_id refuses a run another MCP already owns
  const [inserted] = await tx
    .insert(apifyRuns)
    .values(values)
    .onConflictDoNothing()
    .returning()
  if (inserted) return toRecord(inserted)
  const own = await loadRunForMcp(p.mcpId, p.run.id, tx)
  // owned by another MCP: never shared - the caller's own start stays uncertain
  if (!own) throw new ApifyError("start_uncertain")
  await updateRunStatus(
    own.id,
    {
      status: values.status,
      usageUsd: values.usageUsd,
      finishedAt: p.run.finishedAt,
    },
    tx
  )
  return (await loadRunForMcp(p.mcpId, p.run.id, tx)) ?? own
}

const RUN_ID_RE = /^[A-Za-z0-9]{1,64}$/

/** A run of THIS MCP (the AI never reaches runs of another MCP), or null. */
export async function loadRunForMcp(
  mcpId: string,
  runId: string,
  tx: DbLike = db
): Promise<ApifyRunRecord | null> {
  if (!RUN_ID_RE.test(runId)) return null
  const [row] = await tx
    .select()
    .from(apifyRuns)
    .where(and(eq(apifyRuns.mcpId, mcpId), eq(apifyRuns.runId, runId)))
    .limit(1)
  return row ? toRecord(row) : null
}

export interface RunStatusPatch {
  status: string
  /** usageTotalUsd; undefined = unchanged */
  usageUsd?: number | null
  itemCount?: number | null
  finishedAt?: string | null
  datasetId?: string | null
}

/** patch from a fresh run object */
export function runPatch(run: ApifyRun): RunStatusPatch {
  return {
    status: run.status,
    usageUsd: run.usageTotalUsd ?? undefined,
    finishedAt: run.finishedAt,
    datasetId: run.defaultDatasetId ?? undefined,
  }
}

/** Refresh a record (apify_get_run / apify_get_results / abort). */
export async function updateRunStatus(
  recordId: string,
  patch: RunStatusPatch,
  tx: DbLike = db
): Promise<void> {
  await tx
    .update(apifyRuns)
    .set({
      status: patch.status.slice(0, 20),
      ...(patch.usageUsd !== undefined
        ? { usageUsd: usd(patch.usageUsd) }
        : {}),
      ...(patch.itemCount !== undefined ? { itemCount: patch.itemCount } : {}),
      ...(patch.finishedAt !== undefined
        ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null }
        : {}),
      ...(patch.datasetId !== undefined ? { datasetId: patch.datasetId } : {}),
    })
    .where(eq(apifyRuns.id, recordId))
}

/** 00:00 today in Asia/Ho_Chi_Minh (UTC instant) */
export function vnDayStart(now: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: DB_TZ_DAY,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  return zonedDayStart(day, DB_TZ_DAY)
}

/**
 * Money committed by an MCP's runs today (Asia/Ho_Chi_Minh day, USD): a finished run counts its real cost
 * (usage_usd), an unfinished one - or a finished one whose cost was never read - its cap (max_charge_usd).
 * Used for the daily cap (apify_daily_max_usd, advanced protection mode).
 */
export async function mcpApifySpendToday(
  mcpId: string,
  now: Date = new Date(),
  tx: DbLike = db
): Promise<number> {
  const terminal = sql.join(
    APIFY_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `
  )
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(case when ${apifyRuns.status} in (${terminal}) and ${apifyRuns.usageUsd} is not null then ${apifyRuns.usageUsd} else ${apifyRuns.maxChargeUsd} end), 0)`,
    })
    .from(apifyRuns)
    .where(
      and(eq(apifyRuns.mcpId, mcpId), gte(apifyRuns.createdAt, vnDayStart(now)))
    )
  return Math.round(Number(row?.total ?? 0) * 10_000) / 10_000
}

/** Delete run records older than `days` (apify.health). Returns the count. */
export async function deleteOldApifyRuns(
  days = 90,
  tx: DbLike = db
): Promise<number> {
  const rows = await tx
    .delete(apifyRuns)
    .where(sql`${apifyRuns.createdAt} < now() - make_interval(days => ${days})`)
    .returning({ id: apifyRuns.id })
  return rows.length
}
