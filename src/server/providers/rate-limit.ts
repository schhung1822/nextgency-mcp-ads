// In-process token buckets keyed by string (e.g. "meta:act_123", "meta:page:<id>").
// Single-instance deployment → in-memory is sufficient. Also supports cool-down after throttling.

interface Bucket {
  tokens: number
  updatedAt: number
  capacity: number
  refillPerMs: number
  blockedUntil: number
}

const buckets = new Map<string, Bucket>()

export interface BucketSpec {
  /** sustained requests per second */
  ratePerSec: number
  /** max burst (defaults to ratePerSec) */
  burst?: number
}

function getBucket(key: string, spec: BucketSpec): Bucket {
  let b = buckets.get(key)
  if (!b) {
    const capacity = Math.max(1, spec.burst ?? spec.ratePerSec)
    b = { tokens: capacity, updatedAt: Date.now(), capacity, refillPerMs: spec.ratePerSec / 1000, blockedUntil: 0 }
    buckets.set(key, b)
  }
  return b
}

function refill(b: Bucket, now: number) {
  b.tokens = Math.min(b.capacity, b.tokens + (now - b.updatedAt) * b.refillPerMs)
  b.updatedAt = now
}

/** Wait until a token is available (or throw if waiting would exceed maxWaitMs). */
export async function acquire(
  key: string,
  spec: BucketSpec,
  opts: { maxWaitMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const maxWait = opts.maxWaitMs ?? 30_000
  const started = Date.now()
  for (;;) {
    const b = getBucket(key, spec)
    const now = Date.now()
    refill(b, now)
    const blockedFor = b.blockedUntil - now
    if (blockedFor <= 0 && b.tokens >= 1) {
      b.tokens -= 1
      return
    }
    const wait = Math.max(blockedFor, Math.ceil((1 - b.tokens) / b.refillPerMs), 5)
    if (Date.now() - started + wait > maxWait) {
      throw new RateLimitWaitError(key, Math.max(wait, blockedFor))
    }
    await sleep(Math.min(wait, 1_000), opts.signal)
  }
}

/** Block a key for a period (e.g. Meta BUC estimated_time_to_regain_access). */
export function coolDown(key: string, ms: number) {
  const b = buckets.get(key)
  const until = Date.now() + ms
  if (b) b.blockedUntil = Math.max(b.blockedUntil, until)
  else buckets.set(key, { tokens: 0, updatedAt: Date.now(), capacity: 1, refillPerMs: 0.001, blockedUntil: until })
}

export function blockedForMs(key: string): number {
  const b = buckets.get(key)
  return b ? Math.max(0, b.blockedUntil - Date.now()) : 0
}

export class RateLimitWaitError extends Error {
  constructor(
    readonly key: string,
    readonly retryAfterMs: number
  ) {
    super(`Rate limit bucket ${key} busy for ${retryAfterMs}ms`)
    this.name = "RateLimitWaitError"
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** test helper */
export function __resetBuckets() {
  buckets.clear()
}
