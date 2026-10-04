// Display formatting (vi-VN). Safe for client and server.
import { formatDistanceToNow } from "date-fns"
import { vi } from "date-fns/locale"

export const DISPLAY_TZ = "Asia/Ho_Chi_Minh"

export function formatMoney(amount: number | null | undefined, currency = "VND"): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "-"
  try {
    return new Intl.NumberFormat("vi-VN", { style: "currency", currency }).format(amount)
  } catch {
    return `${formatNumber(amount)} ${currency}`
  }
}

export function formatNumber(n: number | null | undefined, maxFractionDigits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-"
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: maxFractionDigits }).format(n)
}

export function formatPercent(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-"
  return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(n)}%`
}

function toDate(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d)
}

/** dd/MM/yyyy HH:mm in Asia/Ho_Chi_Minh */
export function formatDateTime(d: Date | string | number | null | undefined, tz = DISPLAY_TZ): string {
  if (d === null || d === undefined) return "-"
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(toDate(d))
}

/** dd/MM/yyyy */
export function formatDate(d: Date | string | number | null | undefined, tz = DISPLAY_TZ): string {
  if (d === null || d === undefined) return "-"
  return new Intl.DateTimeFormat("vi-VN", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(
    toDate(d)
  )
}

/** "5 phút trước" */
export function formatRelative(d: Date | string | number | null | undefined): string {
  if (d === null || d === undefined) return "-"
  return formatDistanceToNow(toDate(d), { addSuffix: true, locale: vi })
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-"
  if (ms < 1000) return `${ms} ms`
  return `${formatNumber(ms / 1000, 1)} s`
}
