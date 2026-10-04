// POST /conversions/insights - goal conversion totals (gated per account). No pagination: >2,000 rows → 413,
// so we split the date range (then the entity list) and merge the pieces.
import { ProviderError } from "../errors"
import { addDays, daysBetweenInclusive, todayInTz } from "../dates"
import { num } from "../money"
import { isHttpStatus, oaRequest, PLATFORM } from "./client"
import type { Ctx } from "./objects"
import { clampRange, dateRangeJson } from "./report"

/**
 * POST /conversions/insights `time_ranges` uses an EXCLUSIVE end date (unlike GET insights' inclusive `until`):
 * an inclusive [from, to] becomes {since: from, until: to + 1 day}.
 */
export function conversionRangeJson(from: string, toInclusive: string, timezone: string): string {
  return dateRangeJson(from, addDays(toInclusive, 1), timezone)
}

export interface ConversionsQuery {
  level: "campaign" | "ad_group" | "ad"
  entityIds?: string[]
  from: string
  to: string
  granularity: "day" | "total"
  breakdown?: "country" | "device"
  attributionWindowDays?: 7 | 14 | 30
  viewThroughWindowDays?: 0 | 1
  timeBasis?: "ad_event_time" | "conversion_time"
  includeEvents?: boolean
  eventNames?: string[]
}

interface RawAttributedEvent {
  entity_id: string
  event_name: string
  event_kind: string
  attributed_event_count: number
  attributed_event_value_amount: number | null
  attributed_event_value_count: number
  attributed_event_value_currency: string | null
  click_through_conversions?: number
  view_through_conversions?: number
  date?: string
  country?: string
  device?: string
}

export interface RawConversionRow {
  entity_id: string
  date?: string
  country?: string
  device?: string
  conversions: number
  click_through_conversions?: number
  view_through_conversions?: number
  order_created_attributed_sales?: string | null
  order_created_attributed_sales_currency?: string
  attributed_events?: RawAttributedEvent[]
}

export interface ConversionRow {
  entity_id: string
  date: string | null
  country: string | null
  device: string | null
  conversions: number | null
  click_through_conversions: number | null
  view_through_conversions: number | null
  /** MAJOR units of the account currency; null = unavailable (not zero) */
  order_created_attributed_sales: number | null
  attributed_events?: {
    event_name: string
    event_kind: string
    count: number
    value: number | null
    value_currency: string | null
  }[]
}

export interface ConversionsResult {
  currency: string
  timezone: string
  date_from: string
  date_to: string
  rows: ConversionRow[]
  requests: number
  warnings: string[]
}

const MAX_REQUESTS = 40

export async function getConversions(ctx: Ctx, q: ConversionsQuery): Promise<ConversionsResult> {
  const tz = ctx.account.timezone
  const clamped = clampRange(q.from, q.to, tz)
  const { since, warnings } = clamped
  let until = clamped.until
  // Conversions are processed daily and range bounds cannot be in the future: with an exclusive end, a range
  // that includes today would end tomorrow → stop at yesterday.
  const today = todayInTz(tz)
  if (until >= today) {
    until = addDays(today, -1)
    warnings.push("Chuyển đổi được xử lý theo ngày - báo cáo chuyển đổi lấy đến hết hôm qua (hôm nay chưa có số liệu).")
  }
  if (since > until) {
    return { currency: ctx.account.currency, timezone: tz, date_from: since, date_to: since, rows: [], requests: 0, warnings }
  }
  if (daysBetweenInclusive({ from: since, to: until }) > 365) {
    throw new ProviderError({
      platform: PLATFORM,
      code: "invalid_request",
      message: "Conversion range > 365 days",
      userMessageVi: "Báo cáo chuyển đổi tối đa 365 ngày mỗi lần.",
    })
  }
  if (q.eventNames?.length && !q.includeEvents) {
    throw new ProviderError({
      platform: PLATFORM,
      code: "invalid_request",
      message: "event_names requires include_events",
      userMessageVi: "event_names chỉ dùng được khi bật include_events.",
    })
  }
  let requests = 0
  let splits = 0

  const fetchOnce = async (from: string, to: string, entityIds: string[] | undefined): Promise<RawConversionRow[]> => {
    if (++requests > MAX_REQUESTS) {
      throw new ProviderError({
        platform: PLATFORM,
        code: "invalid_request",
        message: "Too many split requests",
        userMessageVi: "Báo cáo chuyển đổi quá lớn kể cả khi đã chia nhỏ - hãy giảm số đối tượng hoặc khoảng ngày.",
      })
    }
    const body: Record<string, unknown> = {
      aggregation_level: q.level,
      time_ranges: [conversionRangeJson(from, to, tz)],
      time_granularity: q.granularity === "day" ? "daily" : "none",
    }
    if (entityIds?.length) body.entity_ids = entityIds
    else body.group_by_entity = false // account-wide totals (entity_ids is required when grouping by entity)
    if (q.breakdown) body.breakdown = q.breakdown
    if (q.attributionWindowDays !== undefined) body.attribution_window_days = q.attributionWindowDays
    if (q.viewThroughWindowDays !== undefined) body.view_through_attribution_window_days = q.viewThroughWindowDays
    if (q.timeBasis) body.attribution_time_basis = q.timeBasis
    if (q.includeEvents) body.include = ["attributed_events"]
    if (q.eventNames?.length) body.event_names = q.eventNames
    const res = await oaRequest<{ data: RawConversionRow[]; account_currency?: string }>(ctx, {
      method: "POST",
      path: "/conversions/insights",
      body,
      gated: true,
      readOnly: true,
    })
    return res.data ?? []
  }

  const fetchSplit = async (from: string, to: string, entityIds: string[] | undefined): Promise<RawConversionRow[]> => {
    try {
      return await fetchOnce(from, to, entityIds)
    } catch (e) {
      if (!isHttpStatus(e, 413)) throw e
      splits++
      const days = daysBetweenInclusive({ from, to })
      if (days > 1) {
        const mid = addDays(from, Math.floor(days / 2) - 1)
        return [...(await fetchSplit(from, mid, entityIds)), ...(await fetchSplit(addDays(mid, 1), to, entityIds))]
      }
      if (entityIds && entityIds.length > 1) {
        const half = Math.ceil(entityIds.length / 2)
        return [...(await fetchSplit(from, to, entityIds.slice(0, half))), ...(await fetchSplit(from, to, entityIds.slice(half)))]
      }
      throw e
    }
  }

  const ids = q.entityIds?.length ? [...new Set(q.entityIds)] : undefined
  const raw = await fetchSplit(since, until, ids)
  let rows = raw.map(toRow)
  if (splits > 0) {
    warnings.push(`Báo cáo vượt 2.000 dòng nên đã được chia thành ${requests} yêu cầu nhỏ và ghép lại.`)
    if (q.granularity === "total") rows = mergeTotals(rows)
  }
  warnings.push(
    `Cửa sổ ghi nhận: ${q.attributionWindowDays ?? 30} ngày sau nhấp / ${q.viewThroughWindowDays ?? 1} ngày sau xem, theo ${
      (q.timeBasis ?? "ad_event_time") === "ad_event_time" ? "ngày tương tác quảng cáo" : "ngày chuyển đổi"
    }. Dữ liệu chuyển đổi cập nhật theo ngày.`
  )
  return { currency: ctx.account.currency, timezone: tz, date_from: since, date_to: until, rows, requests, warnings }
}

function toRow(r: RawConversionRow): ConversionRow {
  const row: ConversionRow = {
    entity_id: r.entity_id,
    date: r.date ?? null,
    country: r.country ?? null,
    device: r.device ?? null,
    conversions: num(r.conversions),
    click_through_conversions: num(r.click_through_conversions),
    view_through_conversions: num(r.view_through_conversions),
    order_created_attributed_sales: num(r.order_created_attributed_sales),
  }
  if (r.attributed_events) {
    row.attributed_events = r.attributed_events.map((e) => ({
      event_name: e.event_name,
      event_kind: e.event_kind,
      count: e.attributed_event_count,
      value: e.attributed_event_value_amount ?? null,
      value_currency: e.attributed_event_value_currency ?? null,
    }))
  }
  return row
}

const addNullable = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b)

/** Sum period totals that were fetched in several date windows (same currency; null stays null). */
export function mergeTotals(rows: ConversionRow[]): ConversionRow[] {
  const map = new Map<string, ConversionRow>()
  for (const r of rows) {
    const key = [r.entity_id, r.country ?? "", r.device ?? ""].join("|")
    const cur = map.get(key)
    if (!cur) {
      map.set(key, { ...r, attributed_events: r.attributed_events ? [...r.attributed_events] : undefined })
      continue
    }
    cur.conversions = addNullable(cur.conversions, r.conversions)
    cur.click_through_conversions = addNullable(cur.click_through_conversions, r.click_through_conversions)
    cur.view_through_conversions = addNullable(cur.view_through_conversions, r.view_through_conversions)
    cur.order_created_attributed_sales = addNullable(cur.order_created_attributed_sales, r.order_created_attributed_sales)
    if (r.attributed_events) {
      const events = new Map((cur.attributed_events ?? []).map((e) => [e.event_name, { ...e }]))
      for (const e of r.attributed_events) {
        const prev = events.get(e.event_name)
        if (!prev) events.set(e.event_name, { ...e })
        else {
          prev.count += e.count
          prev.value = addNullable(prev.value, e.value)
        }
      }
      cur.attributed_events = [...events.values()]
    }
  }
  return [...map.values()]
}
