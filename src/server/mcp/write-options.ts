// MutationOptions that mcp-core hands to the adapters on every write (preview AND execution):
// - gmvMaxWrite: the admin-only MCP switch "tiktok_gmv_max_write" (TikTok GMV Max campaigns; fail closed when off);
// - dailySpendGuard: STRICT worst-case daily-spend check (a daily cap for the currency is mandatory, even on a legacy
//   MCP) for writes that start or raise spend beyond what the generic guardrails see (GMV Max create / copy / auto
//   budget / promotion days / budget changes);
// - fieldHistory: past executed changes of one field on one object (mcp_call_logs) - used for warnings only;
// - startedSpend24h: worst-case daily spends of objects THIS MCP made start running (or raised while running) on this
//   ad account in the last 24 h (TikTok GMV Max create / copy / enable / raise - cumulative cap, fail closed), DB rows
//   + live reservations of startedSpendLedger (in-process lock + reservations against parallel starts, M1).
// Never imports next/*.
import { and, desc, eq, gt, isNotNull, or, sql } from "drizzle-orm"
import { safeErrorForLog } from "../audit/safe-error"
import { db } from "../db/client"
import { mcpCallLogs } from "../db/schema"
import {
  STARTED_MAX_DAILY_SPEND_FIELD,
  STARTED_SPEND_UNCERTAIN_LOG_CODE,
  type DailySpendCheck,
  type FieldHistoryEntry,
  type MutationOptions,
  type StartedSpendEntry,
} from "../providers/types"
import { denied } from "./errors"
import { checkDailyCap } from "./guardrails"
import {
  mergeStartedHistory,
  startedLedgerKey,
  startedReservations,
  startedSpendLedger,
} from "./started-spend-ledger"
import type { GrantAccount, McpGrant, McpSettings } from "./types"

/** Longest look-back of fieldHistory (hours). */
export const FIELD_HISTORY_MAX_HOURS = 24 * 14

/** Refusal when the MCP has no daily cap for the currency (writes that need the strict guard). */
export function dailyCapRequiredError(currency: string, label: string) {
  return denied(
    "budget_cap_missing",
    `MCP này chưa đặt trần ngân sách/ngày cho tiền tệ ${currency} - bắt buộc với thao tác này (${label}).`,
    `Nhờ chủ MCP vào trang quản trị Ads MCP → MCP → mở MCP này → tab Cấu hình → mục "Trần chi tiêu theo tiền tệ", nhập Ngân sách/ngày cho ${currency} rồi lưu; sau đó thử lại.`
  )
}

/**
 * STRICT guard: every item needs a daily cap for its currency (legacy MCPs included) and must fit it. Amounts are the
 * worst-case spend of ONE day (major units). Throws McpToolError(denied).
 */
export function strictDailySpendGuard(
  settings: McpSettings
): (items: DailySpendCheck[]) => void {
  return (items) => {
    for (const it of items) {
      const cur = it.currency.toUpperCase()
      const cap = settings.maxDailyBudget?.[cur]
      if (!(typeof cap === "number" && Number.isFinite(cap) && cap > 0))
        throw dailyCapRequiredError(cur, it.label)
      if (!Number.isFinite(it.amount) || it.amount < 0) {
        throw denied(
          "budget_unverifiable",
          `Không tính được ${it.label} nên chưa thực hiện.`,
          "Thử lại sau."
        )
      }
      checkDailyCap(settings, it.amount, cur, it.label)
    }
  }
}

interface LoggedChangeRow {
  object_id?: unknown
  field?: unknown
  before?: unknown
  after?: unknown
}

/**
 * Successful executed changes of `field` on `objectId` in this ad account (any MCP of this app), newest first.
 * Only rows with status success (previews are pending_confirmation, failures error/denied) - the changes column is
 * written for executed writes only. A failing query → [] (warnings only, never blocks a write).
 */
export async function loadFieldHistory(
  account: Pick<GrantAccount, "platform" | "externalId">,
  q: { objectId: string; field: string; sinceHours: number }
): Promise<FieldHistoryEntry[]> {
  const hours = Math.max(
    1,
    Math.min(FIELD_HISTORY_MAX_HOURS, Math.ceil(q.sinceHours))
  )
  try {
    const rows = await db
      .select({ at: mcpCallLogs.createdAt, changes: mcpCallLogs.changes })
      .from(mcpCallLogs)
      .where(
        and(
          eq(mcpCallLogs.platform, account.platform),
          eq(mcpCallLogs.adAccountId, account.externalId),
          eq(mcpCallLogs.status, "success"),
          eq(mcpCallLogs.actionKind, "write"),
          gt(
            mcpCallLogs.createdAt,
            sql`now() - (${hours} * interval '1 hour')`
          ),
          sql`${mcpCallLogs.changes} @> ${JSON.stringify([{ object_id: q.objectId, field: q.field }])}::jsonb`
        )
      )
      .orderBy(desc(mcpCallLogs.createdAt))
      .limit(50)
    const out: FieldHistoryEntry[] = []
    for (const r of rows) {
      const list = Array.isArray(r.changes)
        ? (r.changes as LoggedChangeRow[])
        : []
      for (const c of list) {
        if (c && String(c.object_id) === q.objectId && c.field === q.field)
          out.push({
            at: r.at,
            before: c.before ?? null,
            after: c.after ?? null,
          })
      }
    }
    return out
  } catch (e) {
    console.warn("[mcp] field history lookup failed", safeErrorForLog(e))
    return []
  }
}

/** Look-back of startedSpend24h (hours). */
export const STARTED_SPEND_WINDOW_HOURS = 24

/** Rows read by loadStartedSpend24h; reaching it means the history may be incomplete → refused (fail closed). */
export const STARTED_SPEND_MAX_ROWS = 500

/** The started-spend history cannot be trusted (truncated changes, too many rows) - the caller refuses the write. */
export class StartedHistoryUnreadableError extends Error {
  constructor(reason: string) {
    super(`started-spend history unreadable: ${reason}`)
    this.name = "StartedHistoryUnreadableError"
  }
}

/**
 * Objects this MCP made start running (or raised while running) on this ad account within the last 24 h: write rows
 * of THIS MCP whose changes carry STARTED_MAX_DAILY_SPEND_FIELD - executed (status success) or failed with an uncertain
 * outcome (error_code STARTED_SPEND_UNCERTAIN_LOG_CODE, L1) - newest first. Parameterised; scoped to MCP + platform + ad
 * account. THROWS (money guard - the caller refuses the write) when the query fails, when such a row of the window
 * has its changes column truncated by capJson (not an array → its started rows are unreadable, M3) or when the row
 * limit is reached.
 */
export async function loadStartedSpend24h(
  mcpId: string,
  account: Pick<GrantAccount, "platform" | "externalId">
): Promise<StartedSpendEntry[]> {
  const scope = and(
    eq(mcpCallLogs.mcpId, mcpId),
    eq(mcpCallLogs.platform, account.platform),
    eq(mcpCallLogs.adAccountId, account.externalId),
    eq(mcpCallLogs.actionKind, "write"),
    or(
      eq(mcpCallLogs.status, "success"),
      eq(mcpCallLogs.errorCode, STARTED_SPEND_UNCERTAIN_LOG_CODE)
    ),
    gt(
      mcpCallLogs.createdAt,
      sql`now() - (${STARTED_SPEND_WINDOW_HOURS} * interval '1 hour')`
    )
  )
  const truncated = await db
    .select({ at: mcpCallLogs.createdAt })
    .from(mcpCallLogs)
    .where(
      and(
        scope,
        isNotNull(mcpCallLogs.changes),
        sql`jsonb_typeof(${mcpCallLogs.changes}) <> 'array'`
      )
    )
    .limit(1)
  if (truncated.length)
    throw new StartedHistoryUnreadableError("a write row has truncated changes")
  const rows = await db
    .select({ at: mcpCallLogs.createdAt, changes: mcpCallLogs.changes })
    .from(mcpCallLogs)
    .where(
      and(
        scope,
        sql`${mcpCallLogs.changes} @> ${JSON.stringify([{ field: STARTED_MAX_DAILY_SPEND_FIELD }])}::jsonb`
      )
    )
    .orderBy(desc(mcpCallLogs.createdAt))
    .limit(STARTED_SPEND_MAX_ROWS)
  if (rows.length >= STARTED_SPEND_MAX_ROWS)
    throw new StartedHistoryUnreadableError("row limit reached")
  const out: StartedSpendEntry[] = []
  for (const r of rows) {
    const list = Array.isArray(r.changes)
      ? (r.changes as LoggedChangeRow[])
      : []
    for (const c of list) {
      if (!c || c.field !== STARTED_MAX_DAILY_SPEND_FIELD) continue
      const amount = Number(c.after)
      if (
        c.object_id === undefined ||
        c.object_id === null ||
        !Number.isFinite(amount) ||
        amount < 0
      )
        continue
      out.push({ objectId: String(c.object_id), amount, at: r.at })
    }
  }
  return out
}

/** The write options of this grant + account (spread into every provider write call, preview and execution). */
export function writeOptions(
  grant: Pick<McpGrant, "settings" | "mcpId">,
  account: Pick<GrantAccount, "platform" | "externalId">
): Pick<
  MutationOptions,
  | "gmvMaxWrite"
  | "dailySpendGuard"
  | "fieldHistory"
  | "startedSpend24h"
  | "startedSpendLedger"
> {
  const key = startedLedgerKey(grant.mcpId, account)
  return {
    // fail closed: only an explicit true (parseMcpSettings) enables GMV Max writes
    gmvMaxWrite: grant.settings.tiktokGmvMaxWrite === true,
    dailySpendGuard: strictDailySpendGuard(grant.settings),
    fieldHistory: (q) => loadFieldHistory(account, q),
    startedSpend24h: async () => {
      // M1: the reservations snapshot is taken BEFORE the DB read (a row that becomes visible in between is counted
      // once: in the DB result or still reserved - the adapter keeps the largest amount per object id)
      const snapshot = startedReservations(key)
      return mergeStartedHistory(
        key,
        await loadStartedSpend24h(grant.mcpId, account),
        snapshot
      )
    },
    startedSpendLedger: startedSpendLedger(key),
  }
}
