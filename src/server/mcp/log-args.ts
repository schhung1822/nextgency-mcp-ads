// Tool arguments as they are logged (mcp_call_logs) / stored (mcp_pending_actions): URL query strings and
// fragments are dropped because they often carry signatures (S3/GCS signed URLs, CDN tokens). Applied on top of the
// key-based redaction in logging.ts. Framework-free (MCP layer: no `next/*`).
import { redactString } from "../audit/redact"

/** Deep copy limit: anything nested deeper is replaced, never logged as-is. */
export const MAX_LOG_ARGS_DEPTH = 8
const DEPTH_MARKER = "[depth-limit]"

const HTTP_URL = /^https?:\/\//i

/** Keys whose values are media URLs (image_url, video_url, thumbnail_url, file_url, url…). */
const MEDIA_URL_KEY = /(^|_)(image|video|thumbnail|media|file)_url$|^url$/i

/** scheme + host + path; a query / fragment becomes "?[redacted]" (credentials in the authority are dropped). */
function stripQuery(raw: string, anyScheme: boolean): string {
  if (!anyScheme && !HTTP_URL.test(raw)) return raw
  try {
    const u = new URL(raw)
    if (!anyScheme && u.protocol !== "http:" && u.protocol !== "https:") return raw
    return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? "?[redacted]" : ""}`
  } catch {
    // looks like a URL but does not parse: cut at the first ? / # anyway
    return redactString(raw.replace(/[?#][\s\S]*$/, "?[redacted]"))
  }
}

function walk(v: unknown, depth: number, strip: (key: string | null, s: string) => string, key: string | null): unknown {
  if (typeof v === "string") return strip(key, v)
  if (v === null || typeof v !== "object") return v
  if (depth >= MAX_LOG_ARGS_DEPTH) return DEPTH_MARKER
  if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1, strip, key))
  const out: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = walk(item, depth + 1, strip, k)
  return out
}

/**
 * Deep copy where every http(s) URL string keeps scheme + host + path and loses its query / fragment
 * (`?[redacted]`). Other strings are untouched. Used for arguments the SDK rejected before any tool ran.
 */
export function stripUrlQueries(v: unknown, depth = 0): unknown {
  return walk(v, depth, (_k, s) => stripQuery(s, false), null)
}

/**
 * Deep copy where only media URL fields (`image_url`, `video_url`, `thumbnail_url`, `media_url`, `file_url`, `url`,
 * any nesting) lose their query / fragment; link / final_url keep their UTM parameters readable. A media field that
 * is not a parsable URL loses everything after its first ? / # and is redacted.
 */
export function stripMediaUrlQueries(args: Record<string, unknown>): Record<string, unknown> {
  const out = walk(args, 0, (k, s) => (k !== null && MEDIA_URL_KEY.test(k) ? stripQuery(s, true) : s), null)
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {}
}
