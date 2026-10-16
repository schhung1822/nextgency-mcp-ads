// In-process rate limiters for the MCP endpoint (single-instance deployment).
// - per MCP: token bucket, capacity = settings.rateLimitPerMin, refills over one minute; a request
//   is charged per JSON-RPC message (a batch of N calls costs N)
// - per MCP writes: sliding window, settings.writeRateLimitPer10Min executed writes per 10 minutes
// - per client (IPv4 address / IPv6 /64): counts 404 (unknown key) answers to slow down key guessing.
//   Only ever applied to requests whose key does NOT resolve - a valid key is never blocked by it.
//   A blocked client's keys are checked against the in-memory set of usable MCP keys (grant.ts isActiveMcpKey), so a
//   blocked guesser costs no per-request database query.
// All of this lives in process memory and resets on restart (accepted: one web instance).
import { LRUCache } from "lru-cache"
import { ipBucketKey } from "./net"
import { DEFAULT_MCP_SETTINGS } from "./types"

interface Bucket {
  tokens: number
  updatedAt: number
  capacity: number
}

const g = globalThis as unknown as {
  __adsMcpRate?: LRUCache<string, Bucket>
  __adsMcpMiss?: LRUCache<string, { count: number; windowStart: number }>
  __adsMcpWrites?: LRUCache<string, number[]>
  __adsMcpWriteRefunds?: LRUCache<string, number[]>
}

function buckets() {
  g.__adsMcpRate ??= new LRUCache<string, Bucket>({ max: 50_000, ttl: 10 * 60_000 })
  return g.__adsMcpRate
}

function misses() {
  g.__adsMcpMiss ??= new LRUCache<string, { count: number; windowStart: number }>({ max: 100_000, ttl: 60 * 60_000 })
  return g.__adsMcpMiss
}

function writes() {
  g.__adsMcpWrites ??= new LRUCache<string, number[]>({ max: 50_000, ttl: WRITE_WINDOW_MS })
  return g.__adsMcpWrites
}

function refunds() {
  g.__adsMcpWriteRefunds ??= new LRUCache<string, number[]>({ max: 50_000, ttl: WRITE_WINDOW_MS })
  return g.__adsMcpWriteRefunds
}

export interface RateDecision {
  ok: boolean
  /** seconds until a request would be accepted (only when !ok) */
  retryAfterSec: number
}

export interface WriteRateDecision extends RateDecision {
  /** timestamp recorded for this write (only when ok) - refundWriteRate(mcpId, at) gives the slot back */
  at?: number
}

/**
 * Consume `cost` requests (JSON-RPC messages) for this MCP. A request costing more than the bucket
 * capacity is refused outright (it could never be served within the configured limit).
 */
export function consumeMcpRate(mcpId: string, perMin: number, now = Date.now(), cost = 1): RateDecision {
  // no limit (basic protection mode; callers skip this already): Infinity in the bucket math would give NaN tokens
  if (perMin === Number.POSITIVE_INFINITY) return { ok: true, retryAfterSec: 0 }
  // any other non-finite value (NaN…) is a bug: fall back to the default limit, never "unlimited"
  const capacity = Number.isFinite(perMin) ? Math.max(1, Math.floor(perMin)) : DEFAULT_MCP_SETTINGS.rateLimitPerMin
  const need = Math.max(1, Math.floor(cost))
  const refillPerMs = capacity / 60_000
  const map = buckets()
  let b = map.get(mcpId)
  if (!b || b.capacity !== capacity) {
    b = { tokens: capacity, updatedAt: now, capacity }
  } else {
    b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * refillPerMs)
    b.updatedAt = now
  }
  if (b.tokens >= need) {
    b.tokens -= need
    map.set(mcpId, b)
    return { ok: true, retryAfterSec: 0 }
  }
  map.set(mcpId, b)
  if (need > capacity) return { ok: false, retryAfterSec: 60 }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((need - b.tokens) / refillPerMs / 1000)) }
}

// ---------------------------------------------------------------------------
// Write operations (executed writes, previews are free)
// ---------------------------------------------------------------------------
export const WRITE_WINDOW_MS = 10 * 60_000

/** Record one executed write for this MCP, or refuse when `limit` writes already ran in the window. */
export function consumeWriteRate(mcpId: string, limit: number, now = Date.now()): WriteRateDecision {
  // no limit (basic protection mode; callers skip this already) - nothing to record
  if (limit === Number.POSITIVE_INFINITY) return { ok: true, retryAfterSec: 0 }
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_MCP_SETTINGS.writeRateLimitPer10Min
  const map = writes()
  const recent = (map.get(mcpId) ?? []).filter((t) => now - t < WRITE_WINDOW_MS)
  if (recent.length >= max) {
    map.set(mcpId, recent)
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + WRITE_WINDOW_MS - now) / 1000)) }
  }
  recent.push(now)
  map.set(mcpId, recent)
  return { ok: true, retryAfterSec: 0, at: now }
}

/**
 * Most refunds per MCP within the write window (WRITE_WINDOW_MS): a loop of writes the platform keeps refusing still
 * runs into write_rate_limited after this many free retries.
 */
export const WRITE_REFUND_LIMIT = 5

/**
 * Give back ONE write recorded by consumeWriteRate (`at` = its timestamp) - the platform refused that write before
 * anything changed (write-refund.ts). Returns false (slot stays spent) when it already left the window or when the MCP
 * already got WRITE_REFUND_LIMIT refunds in the last WRITE_WINDOW_MS.
 */
export function refundWriteRate(mcpId: string, at: number, now = Date.now()): boolean {
  const map = writes()
  const recent = map.get(mcpId)
  if (!recent) return false
  const i = recent.indexOf(at)
  if (i < 0) return false
  const given = (refunds().get(mcpId) ?? []).filter((t) => now - t < WRITE_WINDOW_MS)
  if (given.length >= WRITE_REFUND_LIMIT) {
    refunds().set(mcpId, given)
    return false
  }
  given.push(now)
  refunds().set(mcpId, given)
  recent.splice(i, 1)
  map.set(mcpId, recent)
  return true
}

// ---------------------------------------------------------------------------
// Unknown keys per client
// ---------------------------------------------------------------------------

/** Unknown-key answers allowed per client and window before the client gets 429 (for unknown keys only). */
export const NOT_FOUND_LIMIT = 20
export const NOT_FOUND_WINDOW_MS = 10 * 60_000

/** Is this client currently blocked from probing unknown keys? */
export function notFoundBlocked(ip: string | null, now = Date.now()): RateDecision {
  const e = misses().get(ipBucketKey(ip))
  if (!e || now - e.windowStart >= NOT_FOUND_WINDOW_MS) return { ok: true, retryAfterSec: 0 }
  if (e.count < NOT_FOUND_LIMIT) return { ok: true, retryAfterSec: 0 }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((e.windowStart + NOT_FOUND_WINDOW_MS - now) / 1000)) }
}

/** Record one 404 for this client. */
export function recordNotFound(ip: string | null, now = Date.now()) {
  const key = ipBucketKey(ip)
  const map = misses()
  const e = map.get(key)
  if (!e || now - e.windowStart >= NOT_FOUND_WINDOW_MS) map.set(key, { count: 1, windowStart: now })
  else map.set(key, { count: e.count + 1, windowStart: e.windowStart })
}

/** test helper */
export function __resetRateLimits() {
  buckets().clear()
  misses().clear()
  writes().clear()
  refunds().clear()
}
