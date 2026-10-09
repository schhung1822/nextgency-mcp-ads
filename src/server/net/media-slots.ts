// Per-process semaphore for media jobs that hold a file in memory (Telegram attachments, Google Drive creatives):
// ONE shared pool, so Telegram + Drive together stay within the web container's memory (mem_limit 1 GB).
// Neutral error (MediaBusyError): each caller maps it to its own error type. No "next/*" imports.

/** media jobs at once in this process, and how long a caller waits for a free slot */
export const MEDIA_SLOTS = { concurrent: 2, waitMs: 5_000 } as const

/** process: no free slot within MEDIA_SLOTS.waitMs; key: this key (MCP) already runs a media job */
export type MediaBusyReason = "process" | "key"

export class MediaBusyError extends Error {
  readonly reason: MediaBusyReason
  constructor(reason: MediaBusyReason) {
    super(`media busy (${reason})`)
    this.name = "MediaBusyError"
    this.reason = reason
  }
}

export function isMediaBusyError(e: unknown): e is MediaBusyError {
  return e instanceof MediaBusyError
}

let activeSlots = 0
const slotWaiters: Array<() => void> = []
/** keys (MCP ids) with a media job running in this process */
const busyKeys = new Set<string>()

function acquireSlot(): Promise<void> {
  if (activeSlots < MEDIA_SLOTS.concurrent) {
    activeSlots++
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer)
      activeSlots++
      resolve()
    }
    const timer = setTimeout(() => {
      const i = slotWaiters.indexOf(grant)
      if (i >= 0) slotWaiters.splice(i, 1)
      reject(new MediaBusyError("process"))
    }, MEDIA_SLOTS.waitMs)
    slotWaiters.push(grant)
  })
}

function releaseSlot(): void {
  activeSlots--
  slotWaiters.shift()?.()
}

/**
 * 2 media jobs at once per process; a caller waits ≤ 5 s, then MediaBusyError("process").
 * `key` (the MCP id): one media job per key at a time - a second one is refused at once (MediaBusyError("key")), so
 * one MCP can never hold both slots. `admit` runs once the key is held, before waiting for a slot (e.g. count the
 * attempt; throw to refuse). Errors of `fn` / `admit` pass through unchanged.
 */
export async function withMediaSlot<T>(
  fn: () => Promise<T>,
  o: { key?: string; admit?: () => Promise<void> } = {}
): Promise<T> {
  const key = o.key
  if (key !== undefined) {
    if (busyKeys.has(key)) throw new MediaBusyError("key")
    busyKeys.add(key)
  }
  try {
    if (o.admit) await o.admit()
    await acquireSlot()
    try {
      return await fn()
    } finally {
      releaseSlot()
    }
  } finally {
    if (key !== undefined) busyKeys.delete(key)
  }
}
