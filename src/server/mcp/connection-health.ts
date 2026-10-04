// When a platform says the token is invalid (ProviderError code "auth_invalid"), mark the connection
// `invalid` with the Vietnamese reason so the UI shows the broken token and later MCP calls fail fast
// (context.ts refuses invalid connections). At most one UPDATE per connection per minute.
import { and, eq, inArray, isNull } from "drizzle-orm"
import { redactString } from "../audit/redact"
import { safeErrorForLog } from "../audit/safe-error"
import { db } from "../db/client"
import { connections } from "../db/schema"
import { isProviderError } from "../providers/errors"

const THROTTLE_MS = 60_000
const g = globalThis as unknown as { __adsMcpAuthInvalidAt?: Map<string, number> }
const lastMarked = (g.__adsMcpAuthInvalidAt ??= new Map())

/** Mark the connection invalid (only from active/expiring; never revives or overrides "disabled"). */
export async function markConnectionInvalid(connectionId: string, messageVi: string, now = Date.now()): Promise<boolean> {
  const prev = lastMarked.get(connectionId)
  if (prev !== undefined && now - prev < THROTTLE_MS) return false
  lastMarked.set(connectionId, now)
  if (lastMarked.size > 10_000) lastMarked.clear()
  const rows = await db
    .update(connections)
    .set({ status: "invalid", statusMessage: redactString(messageVi).slice(0, 500), lastCheckedAt: new Date(now) })
    .where(and(eq(connections.id, connectionId), inArray(connections.status, ["active", "expiring"]), isNull(connections.deletedAt)))
    .returning({ id: connections.id })
  return rows.length > 0
}

/** If `e` is an auth_invalid ProviderError, mark the connection (errors are logged, never thrown). */
export async function noteAuthFailure(e: unknown, connectionId: string | null | undefined): Promise<void> {
  if (!connectionId || !isProviderError(e) || e.code !== "auth_invalid") return
  try {
    await markConnectionInvalid(connectionId, e.userMessageVi || "Token không còn hợp lệ.")
  } catch (err) {
    console.warn("[mcp] could not mark connection invalid", safeErrorForLog(err))
  }
}

/** test helper */
export function __resetAuthInvalidThrottle() {
  lastMarked.clear()
}
