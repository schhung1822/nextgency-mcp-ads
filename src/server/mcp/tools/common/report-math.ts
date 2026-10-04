// Metric selection, rounding and per-currency totals for ads_get_report. Never sums across currencies.
import { roundMoney } from "../../../providers/money"
import {
  NORMALIZED_METRICS,
  type MetricPreset,
  type NormalizedMetricKey,
  type NormalizedMetrics,
} from "../../../providers/types"

const BASIC: NormalizedMetricKey[] = ["spend", "impressions", "reach", "frequency", "clicks", "link_clicks", "ctr", "cpc", "cpm"]
const CONVERSION: NormalizedMetricKey[] = [...BASIC, "conversions", "conversion_value", "cpa", "roas", "purchases", "leads", "messages"]
const VIDEO: NormalizedMetricKey[] = [...BASIC, "video_views"]

export const PRESET_METRICS: Record<MetricPreset, NormalizedMetricKey[]> = {
  basic: BASIC,
  conversion: CONVERSION,
  video: VIDEO,
  all: [...NORMALIZED_METRICS],
}

export const MONEY_METRICS = new Set<NormalizedMetricKey>(["spend", "cpc", "cpm", "cpa", "conversion_value"])
const ADDITIVE: NormalizedMetricKey[] = [
  "spend",
  "impressions",
  "clicks",
  "link_clicks",
  "conversions",
  "conversion_value",
  "purchases",
  "leads",
  "messages",
  "video_views",
]

/** Requested metrics → (keys to output, smallest adapter preset that contains them). */
export function resolveMetrics(m: MetricPreset | NormalizedMetricKey[]): { keys: NormalizedMetricKey[]; preset: MetricPreset } {
  if (typeof m === "string") return { keys: PRESET_METRICS[m], preset: m }
  const keys = [...new Set(m)]
  for (const p of ["basic", "conversion", "video"] as const) {
    if (keys.every((k) => PRESET_METRICS[p].includes(k))) return { keys, preset: p }
  }
  return { keys, preset: "all" }
}

function round(n: number | null, digits: number): number | null {
  if (n === null || !Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function formatMetric(key: NormalizedMetricKey, value: number | null, currency: string): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (MONEY_METRICS.has(key)) return roundMoney(value, currency)
  if (key === "ctr" || key === "frequency" || key === "roas") return round(value, 2)
  return round(value, 2)
}

export function pickMetrics(metrics: NormalizedMetrics, keys: NormalizedMetricKey[], currency: string): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const k of keys) out[k] = formatMetric(k, metrics?.[k] ?? null, currency)
  return out
}

export interface CurrencyTotals {
  currency: string
  rows: number
  accounts: number
  metrics: Record<string, number | null>
}

/** Totals per currency. Ratios are recomputed from sums; reach/frequency are not additive → null. */
export function totalsByCurrency(
  rows: { currency: string; accountKey: string; metrics: NormalizedMetrics }[],
  keys: NormalizedMetricKey[]
): CurrencyTotals[] {
  const groups = new Map<string, { rows: number; accounts: Set<string>; sums: Map<NormalizedMetricKey, number | null> }>()
  for (const r of rows) {
    const g =
      groups.get(r.currency) ?? { rows: 0, accounts: new Set<string>(), sums: new Map(ADDITIVE.map((k) => [k, null] as [NormalizedMetricKey, number | null])) }
    g.rows++
    g.accounts.add(r.accountKey)
    for (const k of ADDITIVE) {
      const v = r.metrics?.[k]
      if (v !== null && v !== undefined && Number.isFinite(v)) g.sums.set(k, (g.sums.get(k) ?? 0) + v)
    }
    groups.set(r.currency, g)
  }
  const out: CurrencyTotals[] = []
  for (const [currency, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const s = (k: NormalizedMetricKey) => g.sums.get(k) ?? null
    const div = (a: number | null, b: number | null, mul = 1) => (a === null || b === null || b === 0 ? null : (a / b) * mul)
    const derived: Partial<Record<NormalizedMetricKey, number | null>> = {
      ctr: div(s("clicks"), s("impressions"), 100),
      cpc: div(s("spend"), s("clicks")),
      cpm: div(s("spend"), s("impressions"), 1000),
      cpa: div(s("spend"), s("conversions")),
      roas: div(s("conversion_value"), s("spend")),
      reach: null,
      frequency: null,
    }
    const metrics: Record<string, number | null> = {}
    for (const k of keys) {
      const v = k in derived ? (derived[k] ?? null) : s(k)
      metrics[k] = formatMetric(k, v, currency)
    }
    out.push({ currency, rows: g.rows, accounts: g.accounts.size, metrics })
  }
  return out
}
