// In-process budget for the Google Sheets API (doc 15 §9.4): Google allows 60 reads + 60 writes per minute per user
// per project, and the whole install usually reads with ONE service account, so every MCP shares that budget.
// Sliding 60 s windows, reads and writes counted separately, per process → DriveError sheet_busy past the budget.
// On top of it, each MCP has its own smaller budget (security review L2: one MCP cannot use up the whole install's
// quota): MCP_SHEETS_PER_MIN reads + MCP_SHEETS_PER_MIN writes per minute, counted by the drive_* tools - and each MCP
// OWNER a slightly larger one over all their MCPs (T-5: many MCPs of one person cannot use it up either).
// No imports from "next/*".
import { LRUCache } from "lru-cache"

import { DriveError } from "./errors"
import { DRIVE_LIMITS } from "./types"

/** Sliding-window counter: at most `limit` takes within any `windowMs`. */
export class SlidingWindowLimiter {
  private readonly stamps: number[] = []
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  private prune(t: number): void {
    while (this.stamps.length && this.stamps[0]! <= t - this.windowMs)
      this.stamps.shift()
  }

  /** take one unit; false (nothing taken) when the window is full */
  tryTake(): boolean {
    const t = this.now()
    this.prune(t)
    if (this.stamps.length >= this.limit) return false
    this.stamps.push(t)
    return true
  }

  /** ms until one unit frees up (0 = available now) */
  waitMs(): number {
    const t = this.now()
    this.prune(t)
    if (this.stamps.length < this.limit) return 0
    return this.stamps[0]! + this.windowMs - t
  }

  /** give back the `n` most recent units (all-or-nothing callers) */
  untake(n: number): void {
    if (n > 0) this.stamps.splice(Math.max(0, this.stamps.length - n), n)
  }

  reset(): void {
    this.stamps.length = 0
  }
}

export type SheetsCallKind = "read" | "write"

const limiters: Record<SheetsCallKind, SlidingWindowLimiter> = {
  read: new SlidingWindowLimiter(DRIVE_LIMITS.sheetsReadsPerMin, 60_000),
  write: new SlidingWindowLimiter(DRIVE_LIMITS.sheetsWritesPerMin, 60_000),
}

/** Count one Sheets API call; DriveError sheet_busy (retryable) when this process used its budget for the minute. */
export function takeSheetsQuota(kind: SheetsCallKind): void {
  if (!limiters[kind].tryTake()) throw new DriveError("sheet_busy")
}

/** Sheets API calls one MCP may make per minute, per kind (inside the global budget above). */
export const MCP_SHEETS_PER_MIN = 20

const mcpLimiters = new LRUCache<
  string,
  Record<SheetsCallKind, SlidingWindowLimiter>
>({
  max: 10_000,
  ttl: 10 * 60_000,
})

/** Sheets API calls all the MCPs of one owner may make per minute, per kind (inside the global budget). */
export const OWNER_SHEETS_PER_MIN = 25

const ownerLimiters = new LRUCache<
  string,
  Record<SheetsCallKind, SlidingWindowLimiter>
>({
  max: 10_000,
  ttl: 10 * 60_000,
})

function limiterOf(
  cache: LRUCache<string, Record<SheetsCallKind, SlidingWindowLimiter>>,
  key: string,
  limit: number,
  kind: SheetsCallKind,
  now: () => number
): SlidingWindowLimiter {
  let pair = cache.get(key)
  if (!pair) {
    pair = {
      read: new SlidingWindowLimiter(limit, 60_000, now),
      write: new SlidingWindowLimiter(limit, 60_000, now),
    }
    cache.set(key, pair)
  }
  return pair[kind]
}

/**
 * Count `units` Sheets calls of one MCP. Returns 0 when taken, else the seconds until enough units free up (nothing
 * is taken then). The caller (MCP tool) turns a refusal into its own error.
 */
export function tryTakeMcpSheetsQuota(
  mcpId: string,
  kind: SheetsCallKind,
  units = 1,
  now: () => number = Date.now
): number {
  return takeAll(
    limiterOf(mcpLimiters, mcpId, MCP_SHEETS_PER_MIN, kind, now),
    units
  )
}

/**
 * Count `units` Sheets calls of one MCP AND of its owner (all or nothing over both budgets). Returns null when taken,
 * else which budget refused and the seconds until enough units free up there.
 */
export function tryTakeSheetsBudget(
  mcpId: string,
  ownerId: string,
  kind: SheetsCallKind,
  units = 1,
  now: () => number = Date.now
): { scope: "mcp" | "owner"; waitSec: number } | null {
  const n = Math.max(1, Math.floor(units))
  const mcp = limiterOf(mcpLimiters, mcpId, MCP_SHEETS_PER_MIN, kind, now)
  const waitMcp = takeAll(mcp, n)
  if (waitMcp > 0) return { scope: "mcp", waitSec: waitMcp }
  const owner = limiterOf(
    ownerLimiters,
    ownerId,
    OWNER_SHEETS_PER_MIN,
    kind,
    now
  )
  const waitOwner = takeAll(owner, n)
  if (waitOwner > 0) {
    // all or nothing: the MCP units of this call are given back
    mcp.untake(n)
    return { scope: "owner", waitSec: waitOwner }
  }
  return null
}

/** take `units` from `l` (all or nothing): 0 when taken, else seconds to wait */
function takeAll(l: SlidingWindowLimiter, units: number): number {
  const n = Math.max(1, Math.floor(units))
  if (n > l.limit) return 60
  for (let i = 0; i < n; i++) {
    if (!l.tryTake()) {
      // all or nothing: give back what this call took
      l.untake(i)
      return Math.max(1, Math.ceil(l.waitMs() / 1000))
    }
  }
  return 0
}

/** tests */
export function __resetSheetsLimiter(): void {
  limiters.read.reset()
  limiters.write.reset()
  mcpLimiters.clear()
  ownerLimiters.clear()
}
