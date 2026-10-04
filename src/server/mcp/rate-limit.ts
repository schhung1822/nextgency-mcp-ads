// In-process rate limiters for the MCP endpoint (single-instance deployment).
// - per MCP: token bucket, capacity = settings.rateLimitPerMin, refills over one minute; a request
//   is charged per JSON-RPC message (a batch of N calls costs N)
// - per MCP writes: sliding window, settings.writeRateLimitPer10Min executed writes per 10 minutes
// - per client (IPv4 address / IPv6 /64): counts 404 (unknown key) answers to slow down key guessing.
//   Only ever applied to requests whose key does NOT resolve - a valid key is never blocked by it.
import { LRUCache } from "lru-cache"
import { ipBucketKey } from "./net"

interface Bucket {
  tokens: number
  updatedAt: number
  capacity: number
}

const g = globalThis as unknown as {
  __adsMcpRate?: LRUCache<string, Bucket>
  __adsMcpMiss?: LRUCache<string, { count: number; windowStart: number }>
  __adsMcpWrites?: LRUCache<string, number[]>
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

export interface RateDecision {
  ok: boolean
  /** seconds until a request would be accepted (only when !ok) */
  retryAfterSec: number
}

/**
 * Consume `cost` requests (JSON-RPC messages) for this MCP. A request costing more than the bucket
 * capacity is refused outright (it could never be served within the configured limit).
 */
export function consumeMcpRate(mcpId: string, perMin: number, now = Date.now(), cost = 1): RateDecision {
  const capacity = Math.max(1, Math.floor(perMin))
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
export function consumeWriteRate(mcpId: string, limit: number, now = Date.now()): RateDecision {
  const max = Math.max(1, Math.floor(limit))
  const map = writes()
  const recent = (map.get(mcpId) ?? []).filter((t) => now - t < WRITE_WINDOW_MS)
  if (recent.length >= max) {
    map.set(mcpId, recent)
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + WRITE_WINDOW_MS - now) / 1000)) }
  }
  recent.push(now)
  map.set(mcpId, recent)
  return { ok: true, retryAfterSec: 0 }
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
}
