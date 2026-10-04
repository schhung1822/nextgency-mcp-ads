// One-line, secret-free description of an unexpected error for stdout / server logs.
// Framework-free (used by Better Auth hooks, MCP, worker and scripts).
//
// Drizzle wraps driver errors as `Failed query: <sql>\nparams: <values>` - the params can hold
// ciphertext, emails, MCP arguments… so the `params:` section is ALWAYS stripped, and the Postgres
// `detail` (which repeats row values, e.g. on unique violations) is never included.
import { redactString } from "./redact"

const MAX = 500

function codeOf(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === "string" || typeof c === "number" ? String(c) : null
}

/** Remove the `params:` section of a Drizzle "Failed query" message (and anything after it). */
export function stripQueryParams(message: string): string {
  return message.replace(/\s*\bparams:[\s\S]*$/i, "")
}

function one(e: Error): string {
  const code = codeOf(e)
  const msg = stripQueryParams(e.message ?? "").replace(/\s+/g, " ").trim()
  return `${e.name}${code ? `[${code}]` : ""}${msg ? `: ${msg}` : ""}`
}

/** `Name[code]: message (cause: Name[code]: message)` - redacted, params stripped, ≤500 chars. */
export function safeErrorForLog(e: unknown): string {
  if (!(e instanceof Error)) return typeof e === "string" ? redactString(stripQueryParams(e)).slice(0, MAX) : "unknown error"
  let text = one(e)
  const cause = (e as { cause?: unknown }).cause
  if (cause instanceof Error) text += ` (cause: ${one(cause)})`
  else if (cause && codeOf(cause)) text += ` (cause code: ${codeOf(cause)})`
  return redactString(text).slice(0, MAX)
}
