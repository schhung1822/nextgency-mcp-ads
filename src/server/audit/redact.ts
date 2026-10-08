// Remove secrets before anything is logged (DB logs, stdout, error messages).

/** Exact (normalised: lower case, no "-", "_" or spaces) key names that always hold secrets. */
const SECRET_EXACT = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "credential",
  "credentials",
  "privatekey",
  "serviceaccountjson",
  "appsecretproof",
  "authcode",
  "authorizationcode",
  "xamzsignature",
  "xamzcredential",
  "xamzsecuritytoken",
  "xgoogsignature",
  "xgoogcredential",
  "signature",
  "sig",
  "mcpkey",
  "xapikey",
  "apikey",
])

/** Last word of a key that marks it as a secret (developer_token, client_secret, newPassword, secret_key…). */
const SECRET_LAST_WORD = new Set(["token", "secret", "password", "passwd", "key", "signature", "credential", "credentials", "proof"])

/** Keys that end with a secret-looking word but are not secrets (kept for debugging). */
const NOT_SECRET = new Set(["idempotencykey", "budgetkey", "sortkey", "groupkey", "objectkey", "maxtokens"])

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** true when a property name designates a secret (any casing / separator style). */
export function isSecretKeyName(k: string): boolean {
  const w = words(k)
  if (w.length === 0) return false
  const flat = w.join("")
  if (NOT_SECRET.has(flat)) return false
  if (SECRET_EXACT.has(flat)) return true
  return SECRET_LAST_WORD.has(w[w.length - 1]!)
}

/** query parameters whose values are secrets (signed URLs, OAuth codes, tokens); also a bare form body "client_secret=…&…" */
const SECRET_QUERY_PARAM =
  /((?:^|[?&])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|[a-z_-]*_token|appsecret_proof|client_secret|secret|key|api[_-]?key|code|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&#\s"']+/gi

const VALUE_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
  [/\bEAA[A-Za-z0-9]{20,}/g, "EAA…[redacted]"], // Meta
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "sk-…[redacted]"], // OpenAI-style keys
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [redacted]"],
  [/\b1\/\/[0-9A-Za-z_-]{20,}/g, "1//…[redacted]"], // OAuth refresh token
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, "ya29.…[redacted]"], // OAuth access token
  [/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/g, "gh…[redacted]"], // GitHub tokens (UPDATE_GITHUB_TOKEN)
  [/\bGOCSPX-[0-9A-Za-z_-]{10,}/g, "GOCSPX-…[redacted]"], // OAuth client secret
  [/\bamcp_[A-Za-z0-9_-]{20,}/g, "amcp_…[redacted]"], // our MCP keys
  [/\bbot\d{5,16}:[A-Za-z0-9_-]+/g, "bot[redacted]"], // Telegram token in a Bot API URL path (/bot<token>/sendMessage)
  [/\b\d{5,16}:[A-Za-z0-9_-]{30,}\b/g, "[redacted-telegram-token]"], // Telegram bot token "<bot id>:<secret>"
  [/\bct_[A-Za-z0-9_-]{24,}/g, "ct_…[redacted]"], // confirm tokens
  [/\b[a-f0-9]{40}\b/g, "[redacted-hex40]"], // 40-hex tokens (heuristic)
  // NOTE: no bare 32-hex pattern - Meta image_hash values are 32-hex and must stay readable
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@"], // URL userinfo password (postgres://user:pass@host)
  [/\b(\d{6,20})\|[A-Za-z0-9_-]{16,}/g, "$1|[redacted]"], // Meta app access token "<app_id>|<app_secret>"
  [
    /("(?:client_secret|app_secret|access_token|refresh_token|appsecret_proof|api_key|password)"\s*:\s*")(?:[^"\\]|\\.)*"/gi,
    '$1[redacted]"',
  ], // secrets inside JSON text (error bodies, serialized requests)
  [SECRET_QUERY_PARAM, "$1[redacted]"],
]

export function redactString(s: string): string {
  return VALUE_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s)
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth-limit]"
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKeyName(k) ? (v === null || v === undefined || v === "" ? v : "[redacted]") : redact(v, depth + 1)
    }
    return out
  }
  return value
}

/**
 * URL safe to log: scheme + host + path; a query string (often a signature: S3/GCS signed URLs, CDN
 * tokens) is replaced by "?[redacted]". Non-URL strings are returned redacted.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? "?[redacted]" : ""}`
  } catch {
    return redactString(raw)
  }
}
