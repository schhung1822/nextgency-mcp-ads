// Pure date-range helpers for DateRangePicker (no React). Dates are "YYYY-MM-DD" strings in a given IANA zone.
import { common } from "@/lib/i18n/vi/common"

// Same value as DISPLAY_TZ in @/lib/format (not imported to keep this module dependency-free for tests).
const DISPLAY_TZ = "Asia/Ho_Chi_Minh"

export interface DateRangeValue {
  /** inclusive, YYYY-MM-DD */
  from: string
  /** inclusive, YYYY-MM-DD */
  to: string
}

export const DATE_PRESETS = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "thisMonth",
  "lastMonth",
] as const
export type DatePreset = (typeof DATE_PRESETS)[number]
export type DatePresetOrCustom = DatePreset | "custom"

export const DATE_PRESET_LABELS: Record<DatePresetOrCustom, string> = {
  today: common.dateRange.today,
  yesterday: common.dateRange.yesterday,
  last7: common.dateRange.last7,
  last30: common.dateRange.last30,
  thisMonth: common.dateRange.thisMonth,
  lastMonth: common.dateRange.lastMonth,
  custom: common.dateRange.custom,
}

export interface PresetOptions {
  /** reference instant (default: now) */
  now?: Date
  /** IANA zone used to decide what "today" is (default Asia/Ho_Chi_Minh; pass the ad account zone for reports) */
  timeZone?: string
  /** whether "7/30 ngày qua" end today (true) or yesterday (default false - same as Ads Manager and server resolvePreset) */
  includeToday?: boolean
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(s: string): boolean {
  if (!ISO_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Calendar date of `now` in `timeZone`, as YYYY-MM-DD. */
export function todayIn(
  timeZone: string = DISPLAY_TZ,
  now: Date = new Date()
): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/** Adds whole days to a YYYY-MM-DD date (UTC arithmetic, DST-safe). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/** Resolves a preset into an inclusive {from,to} range. */
export function resolveDatePreset(
  preset: DatePreset,
  opts: PresetOptions = {}
): DateRangeValue {
  const today = todayIn(opts.timeZone, opts.now)
  const end = opts.includeToday ? today : addDays(today, -1)
  switch (preset) {
    case "today":
      return { from: today, to: today }
    case "yesterday": {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case "last7":
      return { from: addDays(end, -6), to: end }
    case "last30":
      return { from: addDays(end, -29), to: end }
    case "thisMonth":
      return { from: startOfMonth(today), to: today }
    case "lastMonth": {
      const lastDayPrev = addDays(startOfMonth(today), -1)
      return { from: startOfMonth(lastDayPrev), to: lastDayPrev }
    }
  }
}

/** Finds which preset (if any) produces exactly this range; otherwise "custom". */
export function detectDatePreset(
  value: DateRangeValue | null | undefined,
  opts: PresetOptions = {}
): DatePresetOrCustom {
  if (!value) return "custom"
  for (const p of DATE_PRESETS) {
    const r = resolveDatePreset(p, opts)
    if (r.from === value.from && r.to === value.to) return p
  }
  return "custom"
}

/** "dd/MM/yyyy" from YYYY-MM-DD without timezone shifts. */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y}`
}

/** Human label: preset name, a single day, or "dd/MM/yyyy – dd/MM/yyyy". */
export function formatDateRangeLabel(
  value: DateRangeValue | null | undefined,
  opts: PresetOptions = {}
): string {
  if (!value) return common.dateRange.placeholder
  const preset = detectDatePreset(value, opts)
  if (preset !== "custom") return DATE_PRESET_LABELS[preset]
  if (value.from === value.to) return formatIsoDate(value.from)
  return `${formatIsoDate(value.from)} – ${formatIsoDate(value.to)}`
}

/** Orders and validates a range; returns null when either end is invalid. */
export function normalizeRange(
  from: string,
  to: string
): DateRangeValue | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return null
  return from <= to ? { from, to } : { from: to, to: from }
}

/** Local-midnight Date for a YYYY-MM-DD (for the calendar UI). */
export function isoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d)
}

/** YYYY-MM-DD from a local Date picked in the calendar UI. */
export function localDateToIso(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}
