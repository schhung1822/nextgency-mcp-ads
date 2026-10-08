// Google Ads date-times are "yyyy-MM-dd HH:mm:ss" in the customer's time zone (v23+ start_date_time/end_date_time).
import { ProviderError } from "../errors"

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** Offset (minutes, local − UTC) of `tz` at instant `at`. */
export function tzOffsetMinutes(tz: string, at: Date): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at)
  } catch {
    return 0
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"))
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000)
}

function pad(n: number, w = 2) {
  return String(Math.abs(n)).padStart(w, "0")
}

/** ISO 8601 instant → { date, time, local: "yyyy-MM-dd HH:mm:ss" } in the account time zone. */
export function isoToAccountLocal(iso: string, tz: string): { date: string; time: string; local: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new ProviderError({
      platform: "google_ads",
      code: "invalid_request",
      message: `Invalid ISO date-time: ${iso}`,
      userMessageVi: `Thời gian không hợp lệ: "${String(iso).slice(0, 40)}" (cần ISO 8601, vd 2026-10-05T00:00:00+07:00).`,
    })
  }
  const off = tzOffsetMinutes(tz, d)
  const l = new Date(d.getTime() + off * 60_000)
  const date = `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`
  const time = `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}`
  return { date, time, local: `${date} ${time}` }
}

/** "yyyy-MM-dd HH:mm:ss" in tz → ISO 8601 with offset ("2026-10-05T00:00:00+07:00"). null for empty/invalid. */
export function accountLocalToIso(local: string | null | undefined, tz: string): string | null {
  if (!local) return null
  const m = LOCAL_RE.exec(local.trim())
  if (!m) return null
  const [, y, mo, da, h, mi, s] = m
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s))
  // two passes handle DST transitions well enough for display
  let off = tzOffsetMinutes(tz, new Date(asUtc))
  off = tzOffsetMinutes(tz, new Date(asUtc - off * 60_000))
  const sign = off >= 0 ? "+" : "-"
  return `${y}-${mo}-${da}T${h}:${mi}:${s}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

/**
 * Google schedules campaigns by DAY (mutate.ts): a start becomes 00:00:00 and an end 23:59:59 of that day in the
 * account time zone. Same rounding for the MCP lifetime-cap check (ads_update_object), so the cap is computed on the
 * flight Google will actually use. null stays null (end removed); invalid → ProviderError (like the mutate path).
 */
export function googleScheduleIso(iso: string | null, edge: "start" | "end", tz: string): string | null {
  if (iso === null) return null
  const l = isoToAccountLocal(iso, tz)
  return accountLocalToIso(`${l.date} ${edge === "start" ? "00:00:00" : "23:59:59"}`, tz)
}

/** Google uses 2037-12-30 as "no end date" sentinel. */
export function isOpenEnded(local: string | null | undefined): boolean {
  return !local || local.startsWith("2037-12-30")
}
