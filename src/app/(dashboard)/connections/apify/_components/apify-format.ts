// Small client-safe formatters for the Apify token screens (display only - amounts come as numbers from the DTOs
// and are never sent back to the server).
import { DISPLAY_TZ, formatMoney } from "@/lib/format"
import { apify } from "@/lib/i18n/vi/apify"
import type { ApifyTokenDto } from "@/lib/schemas/apify"

const u = apify.ui

/** USD for credit / run costs: "1,20 US$"; small amounts keep up to 4 decimals ("0,0042 US$"). */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-"
  if (v !== 0 && Math.abs(v) < 0.01) {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(v)
  }
  return formatMoney(v, "USD")
}

/** "01/11" (day/month in Asia/Ho_Chi_Minh) - credit reset / exhausted-until dates. */
export function formatDayMonth(d: string | null | undefined): string | null {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return null
  // vi-VN formats a bare day + month as "25-10": build "25/10" from the parts (same separator as formatDate)
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: DISPLAY_TZ,
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(date)
  const day = parts.find((p) => p.type === "day")?.value
  const month = parts.find((p) => p.type === "month")?.value
  return day && month ? `${day}/${month}` : null
}

/** "Starter" for plan id "STARTER"; unknown ids as sent by Apify. */
export function planLabel(planId: string | null | undefined): string | null {
  if (!planId) return null
  return u.plans[planId.toUpperCase()] ?? planId
}

/** "Bronze" for tier "BRONZE" (pay-per-event price tier). */
export function tierLabel(tier: string): string {
  const t = tier.toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** "john_doe · Starter" (or what is known of it). */
export function accountLabel(
  t: Pick<ApifyTokenDto, "apifyUsername" | "planId">
): string {
  const plan = planLabel(t.planId)
  const name = t.apifyUsername ?? u.noUsername
  return plan ? `${name} · ${plan}` : name
}

/** "1,20 US$ / 5,00 US$" (limit unknown: "1,20 US$ / chưa rõ giới hạn"); null when nothing is known. */
export function creditLabel(
  t: Pick<ApifyTokenDto, "usageUsd" | "limitUsd">
): string | null {
  if (t.usageUsd === null && t.limitUsd === null) return null
  return u.usageOf(
    t.usageUsd === null ? u.unknown : formatUsd(t.usageUsd),
    t.limitUsd === null ? u.noLimit : formatUsd(t.limitUsd)
  )
}

/** Credit left (limit - used, never below 0) for display; null when either side is unknown. */
export function creditRemaining(
  t: Pick<ApifyTokenDto, "usageUsd" | "limitUsd">
): number | null {
  if (t.usageUsd === null || t.limitUsd === null) return null
  return Math.max(0, t.limitUsd - t.usageUsd)
}

/** Share of the cycle limit already used, 0-100 (rounded), or null. */
export function creditPercent(
  t: Pick<ApifyTokenDto, "usageUsd" | "limitUsd">
): number | null {
  if (t.usageUsd === null || t.limitUsd === null || t.limitUsd <= 0) return null
  return Math.min(100, Math.max(0, Math.round((t.usageUsd / t.limitUsd) * 100)))
}

/** The exhausted-until date while it is still in the future ("01/11"), otherwise null. */
export function exhaustedUntilLabel(
  t: Pick<ApifyTokenDto, "status" | "exhaustedUntil">,
  now = Date.now()
): string | null {
  if (t.status !== "exhausted" || !t.exhaustedUntil) return null
  const at = new Date(t.exhaustedUntil).getTime()
  if (!Number.isFinite(at) || at <= now) return null
  return formatDayMonth(t.exhaustedUntil)
}

/** Status message worth showing under the badge (only for problem states). */
export function apifyStatusText(
  t: Pick<ApifyTokenDto, "status" | "statusMessage">
): string | null {
  return t.status === "invalid" || t.status === "error" ? t.statusMessage : null
}
