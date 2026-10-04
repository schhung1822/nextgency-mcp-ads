// Batch writer for mcp_call_logs: singleton on globalThis, flush every 1 s or 200 rows,
// buffer capped at 10k rows (overflow counted as dropped), inserts with synchronous_commit = off.
// Never throws to callers - logging must not break MCP responses.
import { sql } from "drizzle-orm"
import { db } from "../db/client"
import { mcpCallLogs } from "../db/schema"
import { safeErrorForLog } from "./safe-error"

export type McpCallLogRow = typeof mcpCallLogs.$inferInsert

const FLUSH_INTERVAL_MS = 1_000
const BATCH_SIZE = 200
const BUFFER_CAP = 10_000

interface WriterState {
  buffer: McpCallLogRow[]
  dropped: number
  failedAttempts: number
  timer: ReturnType<typeof setInterval> | null
  flushing: Promise<void> | null
  lastDropWarnAt: number
  shuttingDown: boolean
}

const g = globalThis as unknown as { __adsMcpLogWriter?: WriterState }

function state(): WriterState {
  g.__adsMcpLogWriter ??= {
    buffer: [],
    dropped: 0,
    failedAttempts: 0,
    timer: null,
    flushing: null,
    lastDropWarnAt: 0,
    shuttingDown: false,
  }
  return g.__adsMcpLogWriter
}

function ensureTimer(s: WriterState) {
  if (s.timer) return
  s.timer = setInterval(() => {
    if (s.buffer.length > 0) void flushMcpLogs()
  }, FLUSH_INTERVAL_MS)
  // do not keep the process (tests, CLI) alive just for the log timer
  s.timer.unref?.()
}

/** Queue one row. Synchronous, O(1), never throws. */
export function enqueueMcpLog(row: McpCallLogRow): void {
  try {
    const s = state()
    if (s.buffer.length >= BUFFER_CAP) {
      s.dropped++
      const now = Date.now()
      if (now - s.lastDropWarnAt > 60_000) {
        s.lastDropWarnAt = now
        console.warn(`[mcp-log] buffer full (${BUFFER_CAP}), dropped=${s.dropped}`)
      }
      return
    }
    s.buffer.push({ ...row, createdAt: row.createdAt ?? new Date() })
    ensureTimer(s)
    if (s.buffer.length >= BATCH_SIZE || s.shuttingDown) void flushMcpLogs()
  } catch (e) {
    console.error("[mcp-log] enqueue failed", safeErrorForLog(e))
  }
}

/**
 * Insert one row NOW with a normal (synchronous) commit - used for write tools, whose log rows are the
 * audit trail of money-moving actions and must not sit in a memory buffer. Falls back to the batch
 * buffer when the insert fails (never throws).
 */
export async function insertMcpLogNow(row: McpCallLogRow): Promise<void> {
  const r = { ...row, createdAt: row.createdAt ?? new Date() }
  try {
    await db.insert(mcpCallLogs).values(r)
  } catch (e) {
    console.error("[mcp-log] synchronous insert failed, buffering", safeErrorForLog(e))
    enqueueMcpLog(r)
  }
}

async function insertBatch(rows: McpCallLogRow[]) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL synchronous_commit = off`)
    await tx.insert(mcpCallLogs).values(rows)
  })
}

/** pg error classes 22 (data exception) / 23 (integrity) / 42 (syntax) will never succeed on retry. */
function isPermanent(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code
  return typeof code === "string" && /^(22|23|42)/.test(code)
}

async function doFlush(s: WriterState) {
  while (s.buffer.length > 0) {
    const batch = s.buffer.splice(0, BATCH_SIZE)
    try {
      await insertBatch(batch)
      s.failedAttempts = 0
    } catch (e) {
      if (isPermanent(e)) {
        // isolate the poison row(s): insert one by one, drop only what fails
        for (const row of batch) {
          try {
            await insertBatch([row])
          } catch (e2) {
            s.dropped++
            console.error("[mcp-log] dropped invalid row", safeErrorForLog(e2))
          }
        }
        continue
      }
      // transient (DB down, pool exhausted…): put back and retry on the next tick
      s.failedAttempts++
      const room = Math.max(0, BUFFER_CAP - s.buffer.length)
      const keep = batch.slice(0, room)
      s.dropped += batch.length - keep.length
      s.buffer.unshift(...keep)
      if (s.failedAttempts === 1 || s.failedAttempts % 30 === 0) {
        console.error(`[mcp-log] flush failed (attempt ${s.failedAttempts}), buffered=${s.buffer.length}`, safeErrorForLog(e))
      }
      return
    }
  }
}

/** Flush everything currently buffered. Safe to call concurrently. */
export async function flushMcpLogs(): Promise<void> {
  const s = state()
  if (s.flushing) {
    await s.flushing
    if (s.buffer.length === 0) return
  }
  const p = doFlush(s).finally(() => {
    if (s.flushing === p) s.flushing = null
  })
  s.flushing = p
  await p
}

/** Called on SIGTERM/SIGINT: from now on every enqueue triggers a flush; flush what is buffered. */
export async function shutdownMcpLogWriter(timeoutMs = 5_000): Promise<void> {
  const s = state()
  s.shuttingDown = true
  const deadline = Date.now() + timeoutMs
  while (s.buffer.length > 0 && Date.now() < deadline) {
    await flushMcpLogs()
    if (s.buffer.length > 0) await new Promise((r) => setTimeout(r, 200))
  }
  if (s.buffer.length > 0) console.error(`[mcp-log] shutdown with ${s.buffer.length} unflushed rows`)
}

/** SIGTERM/SIGINT → flush (idempotent). With NEXT_MANUAL_SIG_HANDLE set, Next does not exit by itself: we do. */
export function registerMcpLogShutdownHooks() {
  const g2 = globalThis as unknown as { __adsMcpSignalsRegistered?: boolean }
  if (g2.__adsMcpSignalsRegistered) return
  g2.__adsMcpSignalsRegistered = true
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdownMcpLogWriter().finally(() => {
        if (process.env.NEXT_MANUAL_SIG_HANDLE) process.exit(signal === "SIGTERM" ? 143 : 130)
      })
    })
  }
}

export function mcpLogWriterStats() {
  const s = state()
  return { buffered: s.buffer.length, dropped: s.dropped, failedAttempts: s.failedAttempts }
}
