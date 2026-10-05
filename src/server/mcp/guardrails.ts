// Money guardrails shared by every write path (04-mcp-design.md §6): per-currency daily cap, lifetime
// cap (daily cap × flight days, or an explicit cap), bid cap. Amounts are MAJOR units. All checks throw
// McpToolError(denied) with a Vietnamese explanation and run BEFORE the preview and the execution.
import { roundMoney } from "../providers/money"
import type { ExtensionMoneyItem } from "../providers/types"
import { denied, invalid } from "./errors"
import { LIFETIME_DEFAULT_DAYS, type McpSettings } from "./types"

const DAY_MS = 86_400_000

export const fmtMoney = (n: number, cur: string) => `${new Intl.NumberFormat("vi-VN").format(roundMoney(n, cur) ?? n)} ${cur}`

const CAP_HINT = "Chọn mức thấp hơn, hoặc nhờ chủ MCP nâng trần trong cấu hình MCP."

/** Vietnamese name of an object level (messages). */
export const LEVEL_VI: Record<string, string> = { campaign: "chiến dịch", ad_group: "nhóm quảng cáo", ad: "quảng cáo" }

export interface Flight {
  startTime?: string | null
  endTime?: string | null
}

/** Parse ISO date-time, "YYYY-MM-DD" (start/end of day, UTC) or "YYYY-MM-DD HH:MM:SS" (UTC). */
export function parseFlightTime(raw: string | null | undefined, edge: "start" | "end"): number | null {
  if (!raw || typeof raw !== "string") return null
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`)
    return Number.isFinite(t) ? t + (edge === "end" ? DAY_MS : 0) : null
  }
  const tt = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s)
  const t = Date.parse(tt ? `${tt[1]}T${tt[2]}Z` : s)
  return Number.isFinite(t) ? t : null
}

/** Days a flight lasts (rounded up, ≥ 1); null when the end is unknown. */
export function flightDays(f: Flight, now = Date.now()): number | null {
  const end = parseFlightTime(f.endTime, "end")
  if (end === null) return null
  const start = Math.max(parseFlightTime(f.startTime, "start") ?? now, Math.min(now, end))
  return Math.max(1, Math.ceil((end - start) / DAY_MS))
}

function capOf(map: Record<string, number> | undefined, cur: string): number | undefined {
  const v = map?.[cur]
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * MCPs created/saved since the security release (moneyCapsRequired) must have a daily cap for the account
 * currency before any write that can start or raise spend. Legacy MCPs are not blocked (see legacyCapWarning).
 */
export function requireMoneyCaps(s: McpSettings, currency: string, action: string): void {
  if (!s.moneyCapsRequired) return
  const cur = currency.toUpperCase()
  if (capOf(s.maxDailyBudget, cur) !== undefined) return
  throw denied(
    "budget_cap_missing",
    `MCP này chưa đặt trần ngân sách/ngày cho tiền tệ ${cur} nên không được ${action}.`,
    `Nhờ chủ MCP vào trang quản trị Ads MCP → MCP → mở MCP này → tab Cấu hình → mục "Trần chi tiêu theo tiền tệ", nhập Ngân sách/ngày cho ${cur} rồi lưu; sau đó thử lại.`
  )
}

/** Preview warning for a legacy MCP (created before caps became mandatory) without a daily cap for this currency. */
export function legacyCapWarning(s: McpSettings, currency: string): string[] {
  const cur = currency.toUpperCase()
  return !s.moneyCapsRequired && capOf(s.maxDailyBudget, cur) === undefined
    ? [`MCP này chưa đặt trần ngân sách/ngày cho ${cur} - AI có thể đặt/bật ngân sách không giới hạn. Nên đặt trần trong cấu hình MCP.`]
    : []
}

export function checkDailyCap(settings: McpSettings, amount: number, currency: string, field = "Ngân sách ngày"): void {
  const cur = currency.toUpperCase()
  const cap = capOf(settings.maxDailyBudget, cur)
  if (cap !== undefined && amount > cap) {
    throw denied("budget_cap_exceeded", `${field} ${fmtMoney(amount, cur)} vượt trần ${fmtMoney(cap, cur)} mà MCP này cho phép.`, CAP_HINT)
  }
}

/** The maximum lifetime budget allowed for this flight, or null when no cap is configured. */
export function lifetimeLimit(settings: McpSettings, currency: string, flight: Flight, now = Date.now()): { limit: number; basis: string } | null {
  const cur = currency.toUpperCase()
  const daily = capOf(settings.maxDailyBudget, cur)
  const explicit = capOf(settings.maxLifetimeBudget, cur)
  const candidates: { limit: number; basis: string }[] = []
  if (daily !== undefined) {
    const days = flightDays(flight, now)
    candidates.push(
      days !== null
        ? { limit: daily * days, basis: `trần ngày ${fmtMoney(daily, cur)} × ${days} ngày chạy` }
        : { limit: daily * LIFETIME_DEFAULT_DAYS, basis: `trần ngày ${fmtMoney(daily, cur)} × ${LIFETIME_DEFAULT_DAYS} ngày (chưa có ngày kết thúc)` }
    )
  }
  if (explicit !== undefined) candidates.push({ limit: explicit, basis: `trần ngân sách trọn đời ${fmtMoney(explicit, cur)}` })
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.limit < a.limit ? b : a))
}

export function checkLifetimeCap(settings: McpSettings, amount: number, currency: string, flight: Flight, field = "Ngân sách trọn đời", now = Date.now()): void {
  const cur = currency.toUpperCase()
  const l = lifetimeLimit(settings, cur, flight, now)
  if (l && amount > l.limit + 1e-9) {
    throw denied(
      "budget_cap_exceeded",
      `${field} ${fmtMoney(amount, cur)} vượt mức tối đa ${fmtMoney(l.limit, cur)} (${l.basis}) mà MCP này cho phép.`,
      CAP_HINT
    )
  }
}

export function checkBidCap(settings: McpSettings, amount: number, currency: string, field = "Giá thầu"): void {
  const cur = currency.toUpperCase()
  const cap = capOf(settings.maxBid, cur)
  if (cap !== undefined && amount > cap) {
    throw denied("bid_cap_exceeded", `${field} ${fmtMoney(amount, cur)} vượt trần giá thầu ${fmtMoney(cap, cur)} mà MCP này cho phép.`, CAP_HINT)
  }
}

/** Enforce every declared money item of an extension input. */
export function enforceMoneyItems(settings: McpSettings, currency: string, items: ExtensionMoneyItem[], now = Date.now()): void {
  for (const it of items) {
    if (typeof it.amount !== "number" || !Number.isFinite(it.amount) || it.amount < 0) {
      throw invalid("invalid_amount", `Giá trị tiền không hợp lệ ở ${it.field}.`)
    }
    if (it.kind === "daily_budget") checkDailyCap(settings, it.amount, currency, `Ngân sách ngày (${it.field})`)
    else if (it.kind === "lifetime_budget") checkLifetimeCap(settings, it.amount, currency, it, `Ngân sách trọn đời (${it.field})`, now)
    else checkBidCap(settings, it.amount, currency, `Giá thầu (${it.field})`)
  }
}

// ---------------------------------------------------------------------------
// Fail-closed scan: money-like keys in an input of an extension that declares no moneyOf()
// ---------------------------------------------------------------------------
export const MONEY_KEY = /(^|_)(budget|bid|bid_amount|bid_price|max_bid|cpc_bid|cpa|target_cpa|target_roas|cost_cap|spend_cap|price|amount|micros)($|_)/i

/** Paths of numeric values under money-like keys (depth-limited). */
export function moneyLikePaths(value: unknown, path = "", depth = 0): string[] {
  if (depth > 8 || !value || typeof value !== "object") return []
  const out: string[] = []
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>)
  for (const [k, v] of entries) {
    const p = path ? `${path}.${k}` : k
    if ((typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) && MONEY_KEY.test(k)) out.push(p)
    else if (v && typeof v === "object") {
      // a {type, amount} budget object: the parent key carries the meaning
      if (MONEY_KEY.test(k) && !Array.isArray(v)) {
        const inner = moneyLikePaths(v, p, depth + 1)
        if (inner.length === 0 && Object.values(v as Record<string, unknown>).some((x) => typeof x === "number")) out.push(p)
        else out.push(...inner)
      } else out.push(...moneyLikePaths(v, p, depth + 1))
    }
  }
  return out
}
