// S5 / M1: in-process ledger of the cumulative 24 h "started spend" cap (TikTok GMV Max create / copy / enable / raise).
// The history lives in mcp_call_logs, but a write's log row is inserted only AFTER the platform call: two confirmed
// starts running in parallel would both read the same history and pass together (2× the cap). So, per MCP + platform +
// ad account:
//   - exclusive(fn): an async mutex serialising "read history → check → reserve" (held only for that - never across
//     the platform call, and no DB transaction is opened);
//   - reserve(items): once a start passes, its {objectId, amount, at} is recorded here and added to the history read
//     by startedSpend24h (the adapter keeps the largest amount per object id, so the matching log row never double
//     counts) until that row is visible in the DB (same id, amount ≥, at ≥ reserved - skew) or 24 h passed;
//   - settle / release: create re-keys its request key to the new campaign id; a definite failure drops it; an
//     uncertain failure keeps it for 24 h (L1).
// SINGLE-NODE ASSUMPTION: production serves /mcp/* from ONE Node process (docker-compose service `web`, or the
// optional `mcp` service of the "scale" profile which then receives every /mcp/* request). Several processes serving
// MCP at once would each have their own ledger (the DB history still applies; only the parallel-race guard weakens) -
// documented in providers/tiktok.md §8 and 04-mcp-design.md. Never imports next/*.
import type {
  StartedSpendEntry,
  StartedSpendItem,
  StartedSpendLedger,
  StartedSpendReservation,
} from "../providers/types"

/** Reservation lifetime (= the cumulative window). */
export const STARTED_RESERVATION_TTL_MS = 24 * 3_600_000
/** Clock skew accepted between the reservation time and the log row's created_at when matching them. */
const VISIBLE_SKEW_MS = 2 * 60_000

interface Reservation {
  objectId: string
  amount: number
  at: number
}

interface LedgerState {
  locks: Map<string, Promise<void>>
  reservations: Map<string, Reservation[]>
}

const g = globalThis as unknown as { __adsMcpStartedLedger?: LedgerState }

function state(): LedgerState {
  g.__adsMcpStartedLedger ??= { locks: new Map(), reservations: new Map() }
  return g.__adsMcpStartedLedger
}

export function startedLedgerKey(
  mcpId: string,
  account: { platform: string; externalId: string }
): string {
  return `${mcpId}\n${account.platform}\n${account.externalId}`
}

/** Run fn alone for this key (FIFO); the lock is released even when fn throws. */
export async function withStartedLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const s = state()
  const prev = s.locks.get(key) ?? Promise.resolve()
  let unlock!: () => void
  const mine = new Promise<void>((r) => {
    unlock = r
  })
  const tail = prev.then(() => mine)
  s.locks.set(key, tail)
  await prev
  try {
    return await fn()
  } finally {
    unlock()
    if (s.locks.get(key) === tail) s.locks.delete(key)
  }
}

function live(key: string, now: number): Reservation[] {
  const s = state()
  const list = (s.reservations.get(key) ?? []).filter(
    (r) => now - r.at < STARTED_RESERVATION_TTL_MS
  )
  if (list.length) s.reservations.set(key, list)
  else s.reservations.delete(key)
  return list
}

/** Snapshot of the live reservations of a key (take it BEFORE reading the DB - see mergeStartedHistory). */
export function startedReservations(
  key: string,
  now = Date.now()
): Reservation[] {
  return live(key, now).map((r) => ({ ...r }))
}

/**
 * DB history + reservations snapshot (taken before the DB read, so a row that became visible in between is either in
 * the DB result or still reserved). Reservations whose log row is visible (same id, amount ≥, created at ≥ reserved −
 * skew) are pruned from the ledger; the others are appended as entries.
 */
export function mergeStartedHistory(
  key: string,
  dbRows: StartedSpendEntry[],
  snapshot: Reservation[],
  now = Date.now()
): StartedSpendEntry[] {
  const out = [...dbRows]
  const visible: Reservation[] = []
  for (const r of snapshot) {
    if (now - r.at >= STARTED_RESERVATION_TTL_MS) continue
    const seen = dbRows.some(
      (d) =>
        d.objectId === r.objectId &&
        d.amount >= r.amount &&
        d.at.getTime() >= r.at - VISIBLE_SKEW_MS
    )
    if (seen) visible.push(r)
    else
      out.push({ objectId: r.objectId, amount: r.amount, at: new Date(r.at) })
  }
  if (visible.length) {
    const s = state()
    const list = s.reservations.get(key)
    if (list) {
      const rest = list.filter(
        (r) =>
          !visible.some(
            (v) =>
              v.objectId === r.objectId &&
              v.amount === r.amount &&
              v.at === r.at
          )
      )
      if (rest.length) s.reservations.set(key, rest)
      else s.reservations.delete(key)
    }
  }
  return out
}

/** Record items as started now; the handle re-keys (settle) or drops (release) them. */
export function reserveStarted(
  key: string,
  items: StartedSpendItem[],
  now = Date.now()
): StartedSpendReservation {
  const s = state()
  const mine: Reservation[] = items
    .filter((i) => i.objectId && Number.isFinite(i.amount) && i.amount >= 0)
    .map((i) => ({ objectId: i.objectId, amount: i.amount, at: now }))
  if (mine.length) s.reservations.set(key, [...live(key, now), ...mine])
  const drop = (pred: (r: Reservation) => boolean) => {
    const list = s.reservations.get(key)
    if (!list) return
    const rest = list.filter((r) => !(mine.includes(r) && pred(r)))
    if (rest.length) s.reservations.set(key, rest)
    else s.reservations.delete(key)
  }
  return {
    settle(fromObjectId, to) {
      const r = mine.find((m) => m.objectId === fromObjectId)
      if (!r || !to.objectId || !Number.isFinite(to.amount)) return
      r.objectId = to.objectId
      r.amount = Math.max(r.amount, to.amount)
    },
    release(objectIds) {
      drop((r) => !objectIds || objectIds.includes(r.objectId))
    },
  }
}

/** MutationOptions.startedSpendLedger of one MCP + ad account. */
export function startedSpendLedger(key: string): StartedSpendLedger {
  return {
    exclusive: (fn) => withStartedLock(key, fn),
    reserve: (items) => reserveStarted(key, items),
  }
}

/** Tests only: forget every lock / reservation. */
export function resetStartedLedgerForTests(): void {
  g.__adsMcpStartedLedger = { locks: new Map(), reservations: new Map() }
}
