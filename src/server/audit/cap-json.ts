import { redact } from "./redact"

export interface CappedJson {
  json: unknown
  bytes: number
  truncated: boolean
}

/** Redact then cap a value for storage in a jsonb log column. */
export function capJson(value: unknown, maxBytes: number): CappedJson {
  if (value === undefined) return { json: null, bytes: 0, truncated: false }
  let s: string
  try {
    s = JSON.stringify(redact(value)) ?? "null"
  } catch {
    s = JSON.stringify(String(value))
  }
  const bytes = Buffer.byteLength(s, "utf8")
  if (bytes <= maxBytes) return { json: JSON.parse(s), bytes, truncated: false }
  return {
    json: { _truncated: true, _bytes: bytes, preview: Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8") },
    bytes,
    truncated: true,
  }
}

export const LOG_REQUEST_MAX = 16 * 1024
export const LOG_RESPONSE_MAX = 32 * 1024
