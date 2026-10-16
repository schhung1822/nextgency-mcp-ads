// Pacing of ad-platform writes per MCP (settings.writeDelaySeconds, advanced protection mode only).
// An executed write starts at least `delay` after the previous write of the same MCP FINISHED; writes arriving in the
// meantime wait their turn (FIFO) instead of being refused, so the AI does not have to retry. The total wait of one
// call is capped (MAX_WAIT_MS): ChatGPT cuts a tool call at 60 s, so wait + the write itself must stay well below
// that. A call that cannot fit is refused with write_cooldown + the time to wait (refused at once when its place in
// the queue already makes the cap impossible). A cancelled request (client gone / tool timeout) leaves the queue and
// never executes later.
// In-process state (single web instance, like rate-limit.ts): resets on restart.
import { McpToolError } from "./errors"
import { WRITE_DELAY_SECONDS } from "./types"

/** Longest a call may wait for its turn + the delay before it is refused (= the largest delay a user can set). */
export const MAX_WAIT_MS = WRITE_DELAY_SECONDS.max * 1000

interface Lane {
  /** a write of this MCP holds the lane (from its turn until it finished) */
  busy: boolean
  /** callers waiting for the lane, FIFO; each is handed the lane directly by release() */
  queue: Waiter[]
  /** when the last executed write finished (ms epoch), 0 = never */
  lastDoneAt: number
}

interface Waiter {
  grant: () => void
}

const g = globalThis as unknown as { __adsMcpWritePacing?: Map<string, Lane> }

function lanes(): Map<string, Lane> {
  g.__adsMcpWritePacing ??= new Map()
  return g.__adsMcpWritePacing
}

/** Tests only. */
export function __resetWritePacing(): void {
  lanes().clear()
}

/**
 * Hand-back of the lane: `executed` = the write reached the execution step (success or failure) - the next write waits
 * the delay from now; false = nothing was executed (refusal before execution) - the cooldown is left as it was.
 */
export type ReleaseWritePacing = (executed: boolean) => void

export interface AcquiredWritePacing {
  release: ReleaseWritePacing
  /** time this call waited (queue + delay), ms - shown to the AI when ≥ 1 s */
  waitedMs: number
}

const NOOP: AcquiredWritePacing = { release: () => {}, waitedMs: 0 }

function cooldownError(
  delaySec: number,
  retryAfterSec: number,
  confirmable: boolean
): McpToolError {
  return new McpToolError({
    code: "write_cooldown",
    messageVi: `MCP này giãn cách các lệnh ghi (mỗi lệnh cách lệnh trước ít nhất ${delaySec} giây) và đang có lệnh ghi khác chạy hoặc chờ - lệnh này CHƯA được thực hiện.`,
    hint: `Đợi khoảng ${retryAfterSec} giây rồi gọi lại với cùng tham số${confirmable ? " (confirm_token vẫn dùng được nếu chưa hết hạn)" : ""}; gửi từng lệnh một thay vì gửi dồn. Chủ MCP có thể giảm giãn cách trong cấu hình MCP (Bảo vệ → Tùy chỉnh nâng cao).`,
    logStatus: "rate_limited",
    retryAfterSec,
  })
}

function abortedError(): McpToolError {
  return new McpToolError({
    code: "write_cancelled",
    messageVi:
      "Yêu cầu đã bị huỷ trong lúc chờ tới lượt ghi - lệnh này CHƯA được thực hiện.",
    hint: "Gọi lại nếu vẫn cần thực hiện.",
    logStatus: "error",
  })
}

function release(
  mcpId: string,
  lane: Lane,
  executed: boolean,
  now = Date.now()
): void {
  if (executed) lane.lastDoneAt = now
  const next = lane.queue.shift()
  if (next) {
    // the lane stays busy: ownership goes straight to the next caller (FIFO, no barging)
    next.grant()
    return
  }
  lane.busy = false
  // a lane that never executed anything carries no cooldown: drop it (lanes with a cooldown stay - one per MCP)
  if (lane.lastDoneAt === 0) lanes().delete(mcpId)
}

/**
 * Wait for this MCP's turn to write, then for `delaySec` after its previous write finished. Resolves with the release
 * handle the caller MUST call exactly once (finally). delaySec ≤ 0 → no pacing at all (resolves at once).
 * Throws write_cooldown when the wait would exceed `maxWaitMs`, write_cancelled when `signal` aborts first.
 */
export async function acquireWritePacing(
  mcpId: string,
  delaySec: number,
  signal: AbortSignal,
  maxWaitMs = MAX_WAIT_MS,
  o: { confirmable?: boolean } = {}
): Promise<AcquiredWritePacing> {
  if (!(Number.isFinite(delaySec) && delaySec > 0)) return NOOP
  const delayMs = Math.round(delaySec * 1000)
  const cap = Math.max(0, Math.min(maxWaitMs, MAX_WAIT_MS))
  const confirmable = o.confirmable === true
  if (signal.aborted) throw abortedError()
  const map = lanes()
  let lane = map.get(mcpId)
  if (!lane) {
    lane = { busy: false, queue: [], lastDoneAt: 0 }
    map.set(mcpId, lane)
  }
  const l = lane
  const started = Date.now()
  const deadline = started + cap

  // 1) the turn (FIFO): only one write of the MCP at a time
  if (l.busy) {
    // every write ahead (the running one + the queue) costs at least the delay after it: refuse at once when even
    // that lower bound does not fit (no point in waiting just to be refused)
    const ahead = l.queue.length + 1
    if (ahead * delayMs > cap)
      throw cooldownError(
        delaySec,
        Math.ceil((ahead * delayMs) / 1000),
        confirmable
      )
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const waiter: Waiter = {
        grant: () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        },
      }
      const leave = (err: McpToolError) => {
        if (settled) return
        settled = true
        cleanup()
        const i = l.queue.indexOf(waiter)
        if (i >= 0) l.queue.splice(i, 1)
        reject(err)
      }
      const onAbort = () => leave(abortedError())
      // the writes ahead took longer than expected: give up at the deadline (the caller retries later)
      const timer = setTimeout(
        () =>
          leave(
            cooldownError(
              delaySec,
              Math.max(
                1,
                Math.ceil((delayMs * Math.max(1, l.queue.length)) / 1000)
              ),
              confirmable
            )
          ),
        Math.max(0, deadline - Date.now())
      )
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      l.queue.push(waiter)
    })
  } else {
    l.busy = true
  }

  // 2) the delay since the previous write finished (we hold the lane: nobody else can write meanwhile). Clamped to the
  // delay: a wall clock stepping back must not turn into a huge wait.
  const wait = Math.min(delayMs, l.lastDoneAt + delayMs - Date.now())
  if (wait > 0) {
    if (Date.now() + wait > deadline) {
      release(mcpId, l, false)
      throw cooldownError(
        delaySec,
        Math.max(1, Math.ceil(wait / 1000)),
        confirmable
      )
    }
    try {
      await sleep(wait, signal)
    } catch {
      release(mcpId, l, false)
      throw abortedError()
    }
  }

  let done = false
  return {
    waitedMs: Date.now() - started,
    release: (executed) => {
      if (done) return
      done = true
      release(mcpId, l, executed)
    },
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"))
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error("aborted"))
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
