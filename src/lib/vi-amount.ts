// Numbers typed by Vietnamese users in the tip forms (/tips/*): "200000", "200.000", "1.000.000", "200,000" (thousands
// separators) and "12,5" / "12.50" (decimals). Anything ambiguous or malformed is REJECTED - never guessed and never
// silently replaced by a default - so the form can show what is wrong and how to fix it. Pure + client-safe.

export type ViAmountError = "empty" | "format"

export type ViAmountResult =
  { ok: true; value: number } | { ok: false; error: ViAmountError }

/** "1.000.000" / "200,000": groups of exactly 3 digits after the first 1-3, ONE kind of separator */
const THOUSANDS_RE = /^\d{1,3}(?:([.,])\d{3})(?:\1\d{3})*$/
/** "12,5" / "12.50": a single separator followed by 1-2 decimals */
const DECIMAL_RE = /^\d+[.,]\d{1,2}$/
const DIGITS_RE = /^\d+$/

/**
 * Parses a non-negative number written the Vietnamese way. Spaces (also non-breaking / thin) are ignored.
 * - only digits → integer ("200000")
 * - `^\d{1,3}([.,]\d{3})+$` with one kind of separator → thousands separators ("200.000", "1,000,000")
 * - one "," or "." followed by 1-2 digits → decimal ("12,5", "0.75")
 * - anything else (minus sign, "1.000,50", "1,000.5", "2.5.0", letters…) → error "format"
 */
export function parseViAmount(raw: string): ViAmountResult {
  const s = raw.replace(/[\s   ]/g, "")
  if (s === "") return { ok: false, error: "empty" }
  if (DIGITS_RE.test(s)) return { ok: true, value: Number(s) }
  if (THOUSANDS_RE.test(s))
    return { ok: true, value: Number(s.replace(/[.,]/g, "")) }
  if (DECIMAL_RE.test(s))
    return { ok: true, value: Number(s.replace(",", ".")) }
  return { ok: false, error: "format" }
}

export type ViNumberError = ViAmountError | "integer" | "min" | "max"

export interface ViNumberRule {
  /** smallest allowed value (inclusive) */
  min?: number
  /** the value must be strictly greater than `min` (e.g. a budget > 0) */
  minExclusive?: boolean
  /** largest allowed value (inclusive) */
  max?: number
  /** whole numbers only (rows per run, ads per run) */
  integer?: boolean
}

export type ViNumberResult =
  | { ok: true; value: number }
  | { ok: false; error: ViNumberError; value?: number }

/** parseViAmount + range / integer checks. Out of range is an error (never clamped). */
export function checkViNumber(
  raw: string,
  rule: ViNumberRule = {}
): ViNumberResult {
  const parsed = parseViAmount(raw)
  if (!parsed.ok) return parsed
  const v = parsed.value
  if (rule.integer && !Number.isInteger(v))
    return { ok: false, error: "integer", value: v }
  if (
    rule.min !== undefined &&
    (rule.minExclusive ? v <= rule.min : v < rule.min)
  )
    return { ok: false, error: "min", value: v }
  if (rule.max !== undefined && v > rule.max)
    return { ok: false, error: "max", value: v }
  return { ok: true, value: v }
}
