// When a platform says the token is invalid (ProviderError code "auth_invalid"), mark the connection
// `invalid` with the Vietnamese reason so the UI shows the broken token and later MCP calls fail fast
// (context.ts refuses invalid connections). At most one UPDATE per connection per minute.
// A real transition (active/expiring → invalid) is announced on the owner's Telegram channels (connection_health).
// D6: a platform "action required" (Meta code 31: verify the account in Ads Manager) only FLAGS the connection
// (meta.actionRequired, status unchanged - reads keep working) and tells the owner on Telegram (1 / connection / day).
// B6: errors the user must fix name the connection + ad account so the AI can say which one.
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import {
  ACTION_REQUIRED_MAX_ACCOUNTS,
  META_ACTION_REQUIRED_KEY,
  readActionRequired,
  type ActionRequiredFlag,
} from "@/lib/schemas/connections"
import { sanitizeExternalLabel } from "@/lib/text-safety"
import { redactString } from "../audit/redact"
import { safeErrorForLog } from "../audit/safe-error"
import { db } from "../db/client"
import { connections } from "../db/schema"
import {
  notifyConnectionActionRequired,
  notifyConnectionHealth,
} from "../notifications"
import { isProviderError, withUserMessage } from "../providers/errors"
import type { McpGrant } from "./types"

const THROTTLE_MS = 60_000
const g = globalThis as unknown as {
  __adsMcpAuthInvalidAt?: Map<string, number>
}
const lastMarked = (g.__adsMcpAuthInvalidAt ??= new Map())

/** Mark the connection invalid (only from active/expiring; never revives or overrides "disabled"). */
export async function markConnectionInvalid(
  connectionId: string,
  messageVi: string,
  now = Date.now()
): Promise<boolean> {
  const prev = lastMarked.get(connectionId)
  if (prev !== undefined && now - prev < THROTTLE_MS) return false
  lastMarked.set(connectionId, now)
  if (lastMarked.size > 10_000) lastMarked.clear()
  // compare-and-set on the status read just before: the transition (before → invalid) is known exactly
  const [cur] = await db
    .select({ status: connections.status })
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
    .limit(1)
  if (!cur || (cur.status !== "active" && cur.status !== "expiring"))
    return false
  const statusMessage = redactString(messageVi).slice(0, 500)
  const rows = await db
    .update(connections)
    .set({ status: "invalid", statusMessage, lastCheckedAt: new Date(now) })
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.status, cur.status),
        inArray(connections.status, ["active", "expiring"]),
        isNull(connections.deletedAt)
      )
    )
    .returning({ id: connections.id })
  if (rows.length === 0) return false
  // committed (single statement): announce it - never throws, never blocks the MCP answer
  void notifyConnectionHealth({
    connectionId,
    before: cur.status,
    after: "invalid",
    statusMessage,
    now: new Date(now),
  })
  return true
}

/** If `e` is an auth_invalid ProviderError, mark the connection (errors are logged, never thrown). */
export async function noteAuthFailure(
  e: unknown,
  connectionId: string | null | undefined
): Promise<void> {
  if (!connectionId || !isProviderError(e) || e.code !== "auth_invalid") return
  try {
    await markConnectionInvalid(
      connectionId,
      e.userMessageVi || "Token không còn hợp lệ."
    )
  } catch (err) {
    console.warn(
      "[mcp] could not mark connection invalid",
      safeErrorForLog(err)
    )
  }
}

// ---------------------------------------------------------------------------
// "Cần xác thực" (D6) + connection / ad account names in errors the user must fix (B6)
// ---------------------------------------------------------------------------

/** errors that need a human on the connection: the AI is told WHICH connection / ad account (B6) */
const USER_FIXABLE_CODES: ReadonlySet<string> = new Set([
  "action_required",
  "auth_invalid",
  "permission_denied",
])

const gf = globalThis as unknown as {
  __adsMcpActionRequiredAt?: Map<string, number>
  __adsMcpActionRequiredIds?: Set<string>
}
const lastFlagged = (gf.__adsMcpActionRequiredAt ??= new Map())
/** in-process registry of connection ids seen with a live flag (filled by context.ts and this module) */
const flaggedIds = (gf.__adsMcpActionRequiredIds ??= new Set())

/** context.ts: remember whether a loaded connection carries a live flag (noteWriteSucceeded fallback). */
export function rememberActionRequired(
  connectionId: string,
  flagged: boolean
): void {
  if (!flagged) {
    flaggedIds.delete(connectionId)
    return
  }
  if (flaggedIds.size > 10_000) flaggedIds.clear()
  flaggedIds.add(connectionId)
}

function flagMessage(raw: string | null | undefined): string | undefined {
  const s = sanitizeExternalLabel(raw ? redactString(raw) : null, 300)
  return s ?? undefined
}

/**
 * Sets / refreshes connections.meta.actionRequired (status untouched: the token still works for reads). Only for live
 * connections (active / expiring). Throttled to one UPDATE per connection + ad account per minute. Every accepted
 * mark asks for a Telegram message; the per-day dedupe key keeps it at 1 per connection per day.
 */
export async function markConnectionActionRequired(
  connectionId: string,
  o: {
    platform: string
    accountExternalId: string | null
    messageVi?: string | null
  },
  now = Date.now()
): Promise<boolean> {
  const throttleKey = `${connectionId}:${o.accountExternalId ?? ""}`
  const prevAt = lastFlagged.get(throttleKey)
  if (prevAt !== undefined && now - prevAt < THROTTLE_MS) return false
  lastFlagged.set(throttleKey, now)
  if (lastFlagged.size > 10_000) lastFlagged.clear()
  const [cur] = await db
    .select({ status: connections.status, meta: connections.meta })
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
    .limit(1)
  if (!cur || (cur.status !== "active" && cur.status !== "expiring"))
    return false
  const meta =
    cur.meta && typeof cur.meta === "object"
      ? (cur.meta as Record<string, unknown>)
      : {}
  const prev = readActionRequired(meta[META_ACTION_REQUIRED_KEY], now)
  const nowIso = new Date(now).toISOString()
  const account = o.accountExternalId ? o.accountExternalId.slice(0, 64) : null
  const accounts = [
    ...new Set([...(account ? [account] : []), ...(prev?.accounts ?? [])]),
  ].slice(0, ACTION_REQUIRED_MAX_ACCOUNTS)
  const message = flagMessage(o.messageVi) ?? prev?.message
  const flag: ActionRequiredFlag = {
    since: prev?.since ?? nowIso,
    lastAt: nowIso,
    platform: o.platform,
    accountExternalId: account,
    accounts,
    ...(message ? { message } : {}),
  }
  const rows = await db
    .update(connections)
    .set({
      meta: sql`coalesce(${connections.meta}, '{}'::jsonb) || jsonb_build_object(${META_ACTION_REQUIRED_KEY}::text, ${JSON.stringify(flag)}::jsonb)`,
    })
    .where(
      and(
        eq(connections.id, connectionId),
        inArray(connections.status, ["active", "expiring"]),
        isNull(connections.deletedAt)
      )
    )
    .returning({ id: connections.id })
  if (rows.length === 0) return false
  rememberActionRequired(connectionId, true)
  // committed: announce it (never throws, never blocks the MCP answer; 1 message / connection / day)
  void notifyConnectionActionRequired({
    connectionId,
    accountExternalId: account,
    message: flag.message ?? null,
    now: new Date(now),
  })
  return true
}

/**
 * Removes the flag after a successful write on `accountExternalId` (null = on the connection as a whole). A flag that
 * lists other ad accounts keeps them; a write on an account the flag does not list leaves it untouched (Meta may block
 * per account). Compare-and-set on the flag read just before (a concurrent new failure wins).
 */
export async function clearConnectionActionRequired(
  connectionId: string,
  accountExternalId: string | null,
  now = Date.now()
): Promise<boolean> {
  const [cur] = await db
    .select({ meta: connections.meta })
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
    .limit(1)
  const meta =
    cur?.meta && typeof cur.meta === "object"
      ? (cur.meta as Record<string, unknown>)
      : null
  const raw = meta?.[META_ACTION_REQUIRED_KEY]
  if (raw === undefined || raw === null) {
    rememberActionRequired(connectionId, false)
    return false
  }
  const live = readActionRequired(raw, now)
  let remaining: string[] = []
  if (live && accountExternalId && live.accounts.length > 0) {
    if (!live.accounts.includes(accountExternalId)) return false
    remaining = live.accounts.filter((a) => a !== accountExternalId)
  }
  const sameFlag = sql`${connections.meta} -> ${META_ACTION_REQUIRED_KEY}::text = ${JSON.stringify(raw)}::jsonb`
  const next =
    live && remaining.length > 0
      ? { ...live, accounts: remaining, accountExternalId: remaining[0] }
      : null
  const rows = await db
    .update(connections)
    .set({
      meta: next
        ? sql`${connections.meta} || jsonb_build_object(${META_ACTION_REQUIRED_KEY}::text, ${JSON.stringify(next)}::jsonb)`
        : sql`${connections.meta} - ${META_ACTION_REQUIRED_KEY}::text`,
    })
    .where(
      and(
        eq(connections.id, connectionId),
        isNull(connections.deletedAt),
        sameFlag
      )
    )
    .returning({ id: connections.id })
  if (rows.length === 0) return false
  if (!next) rememberActionRequired(connectionId, false)
  return true
}

function grantHasConnection(grant: McpGrant, connectionId: string): boolean {
  return (
    grant.accounts.some((a) => a.connectionId === connectionId) ||
    grant.pages.some((p) => p.connectionId === connectionId)
  )
}

/** ` (Kết nối "X", tài khoản quảng cáo "Y" (act_1))` - names are untrusted labels: sanitised + cut. */
async function connectionSuffix(
  connectionId: string,
  grant: McpGrant,
  accountExternalId: string | null
): Promise<string | null> {
  const [row] = await db
    .select({ name: connections.name })
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
    .limit(1)
  const connName = sanitizeExternalLabel(row?.name, 80)
  const parts: string[] = []
  if (connName) parts.push(`Kết nối "${connName}"`)
  if (accountExternalId) {
    const acc = grant.accounts.find(
      (a) =>
        a.connectionId === connectionId && a.externalId === accountExternalId
    )
    const id = sanitizeExternalLabel(accountExternalId, 64)
    const accName = sanitizeExternalLabel(acc?.name, 80)
    if (id)
      parts.push(
        accName
          ? `tài khoản quảng cáo "${accName}" (${id})`
          : `tài khoản quảng cáo ${id}`
      )
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : null
}

/**
 * Called by runTool (tool.ts) when a tool call fails. Never throws: returns `e` unchanged or an enriched copy.
 * - auth_invalid: marks the connection invalid (as noteAuthFailure).
 * - action_required / auth_invalid / permission_denied (ProviderError, one connection of the grant): appends the
 *   connection + ad account names to the Vietnamese message (B6).
 * - action_required: flags the connection "cần xác thực" + Telegram (D6).
 */
export async function noteConnectionFailure(
  e: unknown,
  o: {
    connectionId: string | null
    grant: McpGrant
    accountExternalId: string | null
  }
): Promise<unknown> {
  if (!isProviderError(e) || !o.connectionId) return e
  if (e.code === "auth_invalid") await noteAuthFailure(e, o.connectionId)
  if (
    !USER_FIXABLE_CODES.has(e.code) ||
    !grantHasConnection(o.grant, o.connectionId)
  )
    return e
  const accountExternalId =
    o.accountExternalId &&
    o.grant.accounts.some(
      (a) =>
        a.connectionId === o.connectionId &&
        a.externalId === o.accountExternalId
    )
      ? o.accountExternalId
      : null
  if (e.code === "action_required") {
    try {
      await markConnectionActionRequired(o.connectionId, {
        platform: e.platform,
        accountExternalId,
        messageVi: e.userMessageVi,
      })
    } catch (err) {
      console.warn(
        "[mcp] could not flag connection action_required",
        safeErrorForLog(err)
      )
    }
  }
  try {
    const suffix = await connectionSuffix(
      o.connectionId,
      o.grant,
      accountExternalId
    )
    return suffix ? withUserMessage(e, suffix) : e
  } catch (err) {
    console.warn(
      "[mcp] could not name the connection in an error",
      safeErrorForLog(err)
    )
    return e
  }
}

/**
 * Called by runTool after a successful write on one connection. Never throws. Clears the "cần xác thực" flag of that
 * connection / ad account. Cheap: no query unless the connection is known to carry a flag - `flagged` from
 * ProviderContextFactory.actionRequired (or, when omitted, the in-process registry filled by context.ts).
 */
export async function noteWriteSucceeded(o: {
  connectionId: string
  accountExternalId: string | null
  flagged?: boolean
}): Promise<void> {
  const flagged = o.flagged ?? flaggedIds.has(o.connectionId)
  if (!flagged) return
  try {
    await clearConnectionActionRequired(o.connectionId, o.accountExternalId)
  } catch (err) {
    console.warn(
      "[mcp] could not clear connection action_required",
      safeErrorForLog(err)
    )
  }
}

/** test helper */
export function __resetAuthInvalidThrottle() {
  lastMarked.clear()
  lastFlagged.clear()
  flaggedIds.clear()
}
