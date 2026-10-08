import { roundMoney, toMicros } from "../money"
import { str, type GoogleAdsClient } from "./client"
import { invalidRequest } from "./context"

// ---------------------------------------------------------------------------
// currency_constant.billable_unit_micros: Google requires budget/bid micros to be a multiple of it.
// Loaded once per process per currency (best effort - on failure the fixed-precision rounding below is used).
// The actual units of VND/KRW/IDR… are UNVERIFIED (providers/google-ads.md §5).
// ---------------------------------------------------------------------------

const BILLABLE_UNITS = new Map<string, bigint>()
/** currency → time of the last failed lookup (retried after FAILURE_TTL_MS) */
const FAILED = new Map<string, number>()
const FAILURE_TTL_MS = 3_600_000

/** Test helper. */
export function __resetBillableUnits(): void {
  BILLABLE_UNITS.clear()
  FAILED.clear()
}

export function billableUnitMicros(currency: string): bigint | null {
  return BILLABLE_UNITS.get(currency.toUpperCase()) ?? null
}

/** Read currency_constant.billable_unit_micros for `currency` once per process. Never throws. */
export async function primeBillableUnit(client: Pick<GoogleAdsClient, "searchAll">, cid: string, currency: string, now = Date.now()): Promise<void> {
  const cur = (currency || "").toUpperCase()
  if (!/^[A-Z]{3}$/.test(cur) || BILLABLE_UNITS.has(cur)) return
  const failedAt = FAILED.get(cur)
  if (failedAt !== undefined && now - failedAt < FAILURE_TTL_MS) return
  try {
    const { rows } = await client.searchAll(
      cid,
      `SELECT currency_constant.code, currency_constant.billable_unit_micros FROM currency_constant WHERE currency_constant.code = '${cur}'`,
      { maxRows: 1 }
    )
    const raw = rows[0] ? str(rows[0], "currency_constant.billable_unit_micros") : null
    const unit = raw && /^\d{1,15}$/.test(raw) ? BigInt(raw) : BigInt(0)
    if (unit > BigInt(0)) BILLABLE_UNITS.set(cur, unit)
    else FAILED.set(cur, now)
  } catch {
    FAILED.set(cur, now)
  }
}

/**
 * MAJOR units → micros string for Google. Amounts must be a multiple of the currency's billable unit
 * (currency_constant.billable_unit_micros, see primeBillableUnit) → rounded DOWN to a multiple (never above the amount
 * the MCP caps were checked against) with a warning.
 * Unknown unit: rounded to the currency's precision (VND/JPY… → integer, others → 2 decimals).
 */
export function moneyToMicros(amount: number, currency: string, warnings?: string[], label = "Số tiền"): string {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw invalidRequest(`Invalid amount ${amount}`, `${label} phải là số dương (đơn vị chính của tiền tệ tài khoản).`)
  }
  const unit = billableUnitMicros(currency || "USD")
  if (unit) {
    const exact = BigInt(toMicros(amount))
    const rounded = (exact / unit) * unit // floor to a multiple, integer math
    if (rounded <= BigInt(0)) throw invalidRequest(`Amount too small ${amount}`, `${label} quá nhỏ cho tiền tệ ${currency}.`)
    if (rounded !== exact) {
      const major = Number(rounded / BigInt(1_000_000)) + Number(rounded % BigInt(1_000_000)) / 1_000_000
      warnings?.push(`${label} ${amount} đã được làm tròn thành ${major} ${currency} (bội số đơn vị tính tiền nhỏ nhất của Google).`)
    }
    return rounded.toString()
  }
  const rounded = roundMoney(amount, currency || "USD")!
  if (rounded <= 0) throw invalidRequest(`Amount too small ${amount}`, `${label} quá nhỏ cho tiền tệ ${currency}.`)
  if (rounded !== amount) warnings?.push(`${label} ${amount} đã được làm tròn thành ${rounded} ${currency} (đơn vị nhỏ nhất của tiền tệ).`)
  return toMicros(rounded)
}

export function fmtMoney(amount: number | null, currency: string): string {
  if (amount === null) return "-"
  return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(amount)} ${currency}`
}
