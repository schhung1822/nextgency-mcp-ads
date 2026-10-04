// Currency unit conversion helpers. Never use floats for values sent to platform APIs:
// convert from the user's major-unit number to an integer (minor units or micros) here.

/**
 * Meta "currency offset": how many minor units make one major unit.
 * Offset 1 currencies (no minor unit on Meta) - https://developers.facebook.com/docs/marketing-api/currencies
 */
const META_OFFSET_1 = new Set([
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "ISK",
  "IDR",
  "JPY",
  "KRW",
  "PYG",
  "TWD",
  "VND",
])

export function metaCurrencyOffset(currency: string): 1 | 100 {
  return META_OFFSET_1.has(currency.toUpperCase()) ? 1 : 100
}

/** major (e.g. 50000 VND, 12.5 USD) → Meta minor-unit integer (50000, 1250) */
export function toMetaMinor(amount: number, currency: string): number {
  assertFiniteNonNegative(amount)
  return Math.round(amount * metaCurrencyOffset(currency))
}

/** Meta minor-unit (string|number) → major number */
export function fromMetaMinor(value: string | number | null | undefined, currency: string): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return n / metaCurrencyOffset(currency)
}

const MICROS = BigInt(1_000_000)

/** major → micros as decimal string (OpenAI Ads). Uses string math to avoid float drift. */
export function toMicros(amount: number): string {
  assertFiniteNonNegative(amount)
  const [intPart, fracPart = ""] = amount.toFixed(6).split(".")
  return (BigInt(intPart!) * MICROS + BigInt(fracPart.padEnd(6, "0").slice(0, 6))).toString()
}

/** micros (string|number|bigint) → major number */
export function fromMicros(value: string | number | bigint | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  try {
    const big = typeof value === "bigint" ? value : BigInt(typeof value === "number" ? Math.round(value) : value)
    const whole = big / MICROS
    const frac = big % MICROS
    return Number(whole) + Number(frac) / 1_000_000
  } catch {
    return null
  }
}

/** Parse numeric strings returned by APIs ("12.34", "1,234"?) → number|null */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

/** Round money for display/JSON output (2 decimals, 0 for zero-decimal currencies). */
export function roundMoney(amount: number | null, currency: string): number | null {
  if (amount === null) return null
  const digits = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2
  const f = 10 ** digits
  return Math.round(amount * f) / f
}

const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW", "CLP", "PYG", "ISK", "IDR", "TWD", "HUF", "COP", "CRC"])

/** Percentage change from a → b (null when a is 0/null) */
export function pctChange(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a === 0) return null
  return ((b - a) / a) * 100
}

function assertFiniteNonNegative(amount: number) {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`Invalid money amount: ${amount}`)
}
