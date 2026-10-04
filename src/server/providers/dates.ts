import type { DateRange } from "./types"

export const DATE_PRESETS = [
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_30d",
  "this_month",
  "last_month",
] as const
export type DatePreset = (typeof DATE_PRESETS)[number]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA time zone. */
export function todayInTz(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTz(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return `${get("year")}-${get("month")}-${get("day")}`
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetweenInclusive(r: DateRange): number {
  const a = Date.parse(`${r.from}T00:00:00Z`)
  const b = Date.parse(`${r.to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000) + 1
}

/** Resolve a preset to an inclusive date range in the account's time zone. last_Nd excludes today (like Ads Manager). */
export function resolvePreset(preset: DatePreset, timezone: string, now: Date = new Date()): DateRange {
  const today = todayInTz(timezone, now)
  switch (preset) {
    case "today":
      return { from: today, to: today }
    case "yesterday": {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case "last_7d":
      return { from: addDays(today, -7), to: addDays(today, -1) }
    case "last_14d":
      return { from: addDays(today, -14), to: addDays(today, -1) }
    case "last_30d":
      return { from: addDays(today, -30), to: addDays(today, -1) }
    case "this_month":
      return { from: `${today.slice(0, 7)}-01`, to: today }
    case "last_month": {
      const firstThis = `${today.slice(0, 7)}-01`
      const lastPrev = addDays(firstThis, -1)
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev }
    }
  }
}

/** Validate and normalise an explicit range. Throws RangeError with a Vietnamese message. */
export function assertRange(r: DateRange, maxDays = 1100): DateRange {
  if (!isIsoDate(r.from) || !isIsoDate(r.to)) throw new RangeError("Ngày phải có dạng YYYY-MM-DD.")
  if (r.from > r.to) throw new RangeError("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.")
  if (daysBetweenInclusive(r) > maxDays) throw new RangeError(`Khoảng ngày tối đa ${maxDays} ngày.`)
  return r
}

/** Split [from,to] into consecutive windows of at most maxDays each (platforms that cap the days per report request). */
export function splitRange(r: DateRange, maxDays: number): DateRange[] {
  const out: DateRange[] = []
  let start = r.from
  while (start <= r.to) {
    const end = addDays(start, maxDays - 1)
    const to = end < r.to ? end : r.to
    out.push({ from: start, to })
    start = addDays(to, 1)
  }
  return out
}

function safeTz(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return tz
  } catch {
    return "UTC"
  }
}
