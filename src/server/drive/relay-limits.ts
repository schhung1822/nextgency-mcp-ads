// Limits of the public video relay /dl/<token>/<name> (15-google-drive-media.md §8, GD5; security review L3,
// API review #4). Per process, in memory (one web container) - reset on restart (accepted, like the MCP limiters):
// - concurrent streams: per link RELAY_LIMITS.streamsPerToken, per client (IPv6 grouped by /64, same bucket rule as
//   the MCP endpoint) RELAY_LIMITS.streamsPerIp, process-wide RELAY_LIMITS.streamsTotal;
// - one stream lasts at most RELAY_LIMITS.maxStreamMs;
// - unknown / invalid tokens per client (GET + HEAD): after RELAY_LIMITS.missLimit misses in missWindowMs the client
//   is "blocked" - its tokens must then be in the in-memory set of live link hashes (relay-guard.ts) to reach the DB;
// - byte budget per link: at most byteBudgetFactor × file size served in total (Range requests are not counted as
//   fetches, the budget bounds them).
// Maps are keyed by the token HASH, never the raw token. No imports from "next/*".
import { LRUCache } from "lru-cache"

import { ipBucketKey } from "../mcp/net"

import { DRIVE_LIMITS } from "./types"

export const RELAY_LIMITS = {
  /** concurrent streams of one link (platform fetchers open several range requests) */
  streamsPerToken: DRIVE_LIMITS.relayStreamsPerToken,
  streamsPerIp: DRIVE_LIMITS.relayStreamsPerIp,
  /** concurrent streams of the whole web process */
  streamsTotal: 32,
  /** a single stream is cut after this long */
  maxStreamMs: 30 * 60_000,
  /** unknown / invalid tokens per client and window before the client is blocked */
  missLimit: 20,
  missWindowMs: 10 * 60_000,
  /** total bytes served per link ≤ factor × file size */
  byteBudgetFactor: 3,
} as const

interface Counters {
  perToken: Map<string, number>
  perIp: Map<string, number>
  total: number
}

const g = globalThis as unknown as {
  __adsRelayStreams?: Counters
  __adsRelayMiss?: LRUCache<string, { count: number; windowStart: number }>
  __adsRelayBytes?: LRUCache<string, number>
}

function counters(): Counters {
  g.__adsRelayStreams ??= { perToken: new Map(), perIp: new Map(), total: 0 }
  return g.__adsRelayStreams
}

function misses() {
  g.__adsRelayMiss ??= new LRUCache<
    string,
    { count: number; windowStart: number }
  >({
    max: 100_000,
    ttl: RELAY_LIMITS.missWindowMs,
  })
  return g.__adsRelayMiss
}

/** bytes reserved per token hash; links live ≤ 1 h, entries outlive them a little */
function budgets() {
  g.__adsRelayBytes ??= new LRUCache<string, number>({
    max: 50_000,
    ttl: 3 * 60 * 60_000,
  })
  return g.__adsRelayBytes
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function dec(map: Map<string, number>, key: string): void {
  const n = (map.get(key) ?? 0) - 1
  if (n > 0) map.set(key, n)
  else map.delete(key)
}

/** Releases one acquired stream slot; safe to call more than once. */
export type RelayStreamRelease = () => void

/**
 * Take one stream slot for (link, client). `tokenKey` must not be the raw token (use its hash). Returns null when the
 * per-link, per-client or process-wide limit is reached.
 */
export function acquireRelayStream(
  tokenKey: string,
  clientIp: string | null,
  limits: { perToken?: number; perIp?: number; total?: number } = {}
): RelayStreamRelease | null {
  const c = counters()
  const ipKey = ipBucketKey(clientIp)
  const maxToken = limits.perToken ?? RELAY_LIMITS.streamsPerToken
  const maxIp = limits.perIp ?? RELAY_LIMITS.streamsPerIp
  const maxTotal = limits.total ?? RELAY_LIMITS.streamsTotal
  if (c.total >= maxTotal) return null
  if ((c.perToken.get(tokenKey) ?? 0) >= maxToken) return null
  if ((c.perIp.get(ipKey) ?? 0) >= maxIp) return null
  inc(c.perToken, tokenKey)
  inc(c.perIp, ipKey)
  c.total++
  let released = false
  return () => {
    if (released) return
    released = true
    dec(c.perToken, tokenKey)
    dec(c.perIp, ipKey)
    c.total = Math.max(0, c.total - 1)
  }
}

/** Streams in flight (tests / diagnostics). */
export function relayStreamsInFlight(): {
  tokens: number
  ips: number
  streams: number
} {
  const c = counters()
  return { tokens: c.perToken.size, ips: c.perIp.size, streams: c.total }
}

// ---------------------------------------------------------------------------
// Unknown / invalid tokens per client
// ---------------------------------------------------------------------------

export interface RelayMissDecision {
  /** false = blocked: only tokens of live links (relay-guard.ts) may go on */
  ok: boolean
  retryAfterSec: number
}

export function relayMissBlocked(
  ip: string | null,
  now = Date.now()
): RelayMissDecision {
  const e = misses().get(ipBucketKey(ip))
  if (!e || now - e.windowStart >= RELAY_LIMITS.missWindowMs)
    return { ok: true, retryAfterSec: 0 }
  if (e.count < RELAY_LIMITS.missLimit) return { ok: true, retryAfterSec: 0 }
  return {
    ok: false,
    retryAfterSec: Math.max(
      1,
      Math.ceil((e.windowStart + RELAY_LIMITS.missWindowMs - now) / 1000)
    ),
  }
}

/** One 404 for an unknown / malformed / dead token (GET or HEAD). */
export function recordRelayMiss(ip: string | null, now = Date.now()): void {
  const key = ipBucketKey(ip)
  const map = misses()
  const e = map.get(key)
  if (!e || now - e.windowStart >= RELAY_LIMITS.missWindowMs)
    map.set(key, { count: 1, windowStart: now })
  else map.set(key, { count: e.count + 1, windowStart: e.windowStart })
}

// ---------------------------------------------------------------------------
// Byte budget per link
// ---------------------------------------------------------------------------

function budgetMax(sizeBytes: number): number {
  return Math.max(1, sizeBytes) * RELAY_LIMITS.byteBudgetFactor
}

/** Is the link's byte budget already used up (checked before calling Drive)? */
export function relayBudgetExhausted(
  tokenKey: string,
  sizeBytes: number
): boolean {
  return (budgets().get(tokenKey) ?? 0) >= budgetMax(sizeBytes)
}

/**
 * Reserve `bytes` of the link's budget (≤ factor × size in total). Returns a refund function (give back what was
 * not sent - call once with the bytes actually sent), or null when the reservation does not fit.
 */
export function reserveRelayBytes(
  tokenKey: string,
  sizeBytes: number,
  bytes: number
): ((sentBytes: number) => void) | null {
  const map = budgets()
  const used = map.get(tokenKey) ?? 0
  const want = Math.max(0, bytes)
  if (used + want > budgetMax(sizeBytes)) return null
  map.set(tokenKey, used + want)
  let refunded = false
  return (sent) => {
    if (refunded) return
    refunded = true
    const back = want - Math.min(want, Math.max(0, sent))
    if (back <= 0) return
    const now = map.get(tokenKey)
    if (now !== undefined) map.set(tokenKey, Math.max(0, now - back))
  }
}

/** Tests only. */
export function __resetRelayLimits(): void {
  const c = counters()
  c.perToken.clear()
  c.perIp.clear()
  c.total = 0
  misses().clear()
  budgets().clear()
}
