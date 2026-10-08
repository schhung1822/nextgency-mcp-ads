// Worker side of the queue: `notify.telegram` (send one delivery, retry policy), `notifications.sweep` (re-queue
// lost jobs, expire stuck deliveries, update results) and `notifications.cleanup` (retention).
// Retry policy (14-telegram-notifications.md §3-4): at most 4 attempts; 429 → after retry_after + jitter;
// 5xx / no response → 10 s, 60 s, 5 min; any other error is final. Telegram has no idempotency key: a delivery is
// claimed with an optimistic `attempts` check so a duplicate job never sends twice. No "next/*" imports.
import { and, eq, gte, lt, sql } from "drizzle-orm"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { db } from "@/server/db/client"
import { notificationDeliveries } from "@/server/db/schema"

import { channelConfig, loadChannel, sendToChannel } from "./deliver"
import { notifyRecentUpdateResults } from "./events"
import { sendNotifyJob, type NotifyJobData } from "./queue"
import type { TelegramCallOptions } from "./telegram"

export const MAX_ATTEMPTS = 4
/** delay before attempt 2, 3, 4 after a 5xx / network error */
export const BACKOFF_SECONDS = [10, 60, 300] as const
/** Telegram: <= 1 message / second / chat, groups <= 20 messages / minute */
export const MIN_GAP_MS = 1100
export const GROUP_PER_MINUTE = 19
/** pending deliveries older than this are given up (sweep) */
export const PENDING_MAX_AGE_MS = 60 * 60 * 1000
/** a never-attempted delivery older than this lost its job (web could not queue it) → re-queue */
export const REQUEUE_AFTER_MS = 2 * 60 * 1000

export type ProcessOutcome =
  | { result: "sent"; messageId: number }
  | { result: "retry"; afterSec: number; attempts: number }
  | { result: "failed"; reason: string }
  | { result: "deferred"; afterSec: number }
  | { result: "skipped"; reason: string }

const lastSentByChannel = new Map<string, number>()

export function retryDelaySec(
  kind: string,
  attempts: number,
  retryAfterSec: number | null,
  rand: () => number = Math.random
): number {
  if (kind === "rate_limited")
    return (retryAfterSec ?? 30) + 1 + Math.floor(rand() * 3)
  return BACKOFF_SECONDS[
    Math.min(Math.max(attempts, 1), BACKOFF_SECONDS.length) - 1
  ]!
}

async function finalFail(
  id: string,
  reason: string,
  code: number | null = null
) {
  await db
    .update(notificationDeliveries)
    .set({
      status: "failed",
      errorMessage: reason.slice(0, 1000),
      errorCode: code,
      message: null,
    })
    .where(eq(notificationDeliveries.id, id))
}

export interface ProcessOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: TelegramCallOptions["fetchImpl"]
  rand?: () => number
}

/** Handler of `notify.telegram`. DB errors propagate (pg-boss records the failure); Telegram errors never do. */
export async function processDelivery(
  data: NotifyJobData,
  opts: ProcessOptions = {}
): Promise<ProcessOutcome> {
  const now = opts.now ?? Date.now
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const [d] = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, data.deliveryId))
    .limit(1)
  if (!d) return { result: "skipped", reason: "not found" }
  if (d.status !== "pending")
    return { result: "skipped", reason: `status ${d.status}` }
  if (d.attempts !== data.attempt)
    return { result: "skipped", reason: "stale job" }

  const channel = await loadChannel(d.channelId)
  if (!channel) {
    await finalFail(d.id, m.telegram.skippedDeleted)
    return { result: "failed", reason: "channel deleted" }
  }
  if (channel.status === "disabled") {
    await finalFail(d.id, m.telegram.skippedDisabled)
    return { result: "failed", reason: "channel disabled" }
  }
  if (channel.status === "error") {
    await finalFail(d.id, m.telegram.skippedError(channel.statusMessage ?? ""))
    return { result: "failed", reason: "channel error" }
  }
  if (!d.message) {
    await finalFail(d.id, m.telegram.badRequest)
    return { result: "failed", reason: "empty message" }
  }

  // group / supergroup: <= 20 messages per minute → wait for the window instead of burning an attempt on a 429
  const cfg = channelConfig(channel)
  if (cfg.chatType === "group" || cfg.chatType === "supergroup") {
    const since = new Date(now() - 60_000)
    const [w] = await db
      .select({
        n: sql<number>`count(*)::int`,
        oldest: sql<Date | null>`min(${notificationDeliveries.sentAt})`,
      })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.channelId, channel.id),
          eq(notificationDeliveries.status, "sent"),
          gte(notificationDeliveries.sentAt, since)
        )
      )
    if (Number(w?.n ?? 0) >= GROUP_PER_MINUTE) {
      const oldest = w?.oldest ? new Date(w.oldest).getTime() : now()
      const afterSec = Math.max(
        1,
        Math.ceil((oldest + 60_000 - now()) / 1000) + 1
      )
      await sendNotifyJob({ deliveryId: d.id, attempt: d.attempts }, afterSec)
      return { result: "deferred", afterSec }
    }
  }
  // <= 1 message / second / chat (the worker runs this queue one job at a time)
  const last = Math.max(
    lastSentByChannel.get(channel.id) ?? 0,
    channel.lastSentAt?.getTime() ?? 0
  )
  const wait = last + MIN_GAP_MS - now()
  if (wait > 0) await sleep(Math.min(wait, MIN_GAP_MS))

  // optimistic claim: only the job that saw `attempts = data.attempt` proceeds
  const claimed = await db
    .update(notificationDeliveries)
    .set({ attempts: sql`${notificationDeliveries.attempts} + 1` })
    .where(
      and(
        eq(notificationDeliveries.id, d.id),
        eq(notificationDeliveries.status, "pending"),
        eq(notificationDeliveries.attempts, data.attempt)
      )
    )
    .returning({ attempts: notificationDeliveries.attempts })
  if (claimed.length === 0)
    return { result: "skipped", reason: "claimed by another job" }
  const attempts = claimed[0]!.attempts

  const out = await sendToChannel(channel, d.message, {
    fetchImpl: opts.fetchImpl,
  })
  lastSentByChannel.set(channel.id, now())
  if (out.ok) {
    await db
      .update(notificationDeliveries)
      .set({
        status: "sent",
        sentAt: new Date(now()),
        telegramMessageId: out.messageId,
        message: null,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(notificationDeliveries.id, d.id))
    return { result: "sent", messageId: out.messageId }
  }
  if (out.retryable && attempts < MAX_ATTEMPTS) {
    const afterSec = retryDelaySec(
      out.kind,
      attempts,
      out.retryAfterSec,
      opts.rand
    )
    await db
      .update(notificationDeliveries)
      .set({ errorCode: out.code, errorMessage: out.detail })
      .where(eq(notificationDeliveries.id, d.id))
    try {
      await sendNotifyJob({ deliveryId: d.id, attempt: attempts }, afterSec)
    } catch (e) {
      console.error(
        `[notifications] could not schedule retry of ${d.id}: ${safeErrorForLog(e)}`
      )
      await finalFail(
        d.id,
        `${out.detail} ${m.telegram.retryUnavailable}`,
        out.code
      )
      return { result: "failed", reason: "retry not scheduled" }
    }
    return { result: "retry", afterSec, attempts }
  }
  await finalFail(d.id, out.detail, out.code)
  return { result: "failed", reason: out.kind }
}

export interface SweepResult {
  requeued: number
  expired: number
  updateResults: number
}

/** `notifications.sweep` (every 5 min): re-queue never-attempted deliveries, give up stuck ones, update results. */
export async function sweepDeliveries(
  opts: { now?: Date } = {}
): Promise<SweepResult> {
  const now = opts.now ?? new Date()
  const expired = await db
    .update(notificationDeliveries)
    .set({ status: "failed", errorMessage: m.telegram.expired, message: null })
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        lt(
          notificationDeliveries.createdAt,
          new Date(now.getTime() - PENDING_MAX_AGE_MS)
        )
      )
    )
    .returning({ id: notificationDeliveries.id })
  const lost = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        eq(notificationDeliveries.attempts, 0),
        lt(
          notificationDeliveries.createdAt,
          new Date(now.getTime() - REQUEUE_AFTER_MS)
        )
      )
    )
    .limit(500)
  let requeued = 0
  for (const r of lost) {
    try {
      await sendNotifyJob({ deliveryId: r.id, attempt: 0 })
      requeued++
    } catch (e) {
      console.warn(
        `[notifications] sweep could not queue ${r.id}: ${safeErrorForLog(e)}`
      )
    }
  }
  const updateResults = await notifyRecentUpdateResults({ now })
  return { requeued, expired: expired.length, updateResults }
}

/** `notifications.cleanup` (daily): delete deliveries older than `months` (log_retention_months_mcp). */
export async function cleanupDeliveries(months: number): Promise<number> {
  const keep = Math.min(Math.max(Math.trunc(months), 1), 24)
  const res = await db
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, sql`now() - make_interval(months => ${keep}::int)`))
  return res.rowCount ?? 0
}
