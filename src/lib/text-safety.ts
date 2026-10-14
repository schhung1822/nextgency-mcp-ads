// Text-safety helpers shared by input schemas (reject) and outputs (strip). Control characters and bidi overrides /
// isolates can spoof how a name reads in the UI, in logs and in AI clients (e.g. "abc" + U+202E + "gpj.exe"). Pure: usable
// from client components, schemas, services and the MCP layer.

/** Single-line names: every control character (C0/C1 incl. newline/tab) and the bidi overrides / isolates. */
export const NAME_FORBIDDEN_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u

/** Multi-line text (descriptions): like NAME_FORBIDDEN_CHARS but tab / newline / carriage return are allowed. */
export const MULTILINE_FORBIDDEN_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u

/** true when a single-line name contains a control or bidi-override character (schemas refuse it). */
export function hasForbiddenNameChars(s: string): boolean {
  return NAME_FORBIDDEN_CHARS.test(s)
}

// control chars, bidi marks / embeddings / overrides / isolates, zero-width space, word joiner + invisible math
// operators (U+2060-2064), BOM, soft hyphen, variation selectors (U+FE00-FE0F, U+E0100-E01EF), interlinear annotation
// marks (U+FFF9-FFFB) and Unicode tag characters (U+E0000-E007F: invisible "ASCII smuggling"). ZWJ / ZWNJ
// (U+200C/U+200D) stay: emoji sequences and some scripts need them.
const UNSAFE_LABEL_CHARS =
  /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD\u2060-\u2064\uFE00-\uFE0F\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/**
 * Text from outside (a Telegram chat title, a stored name) shown to an AI client or in a UI as a label: one line,
 * control / bidi / zero-width characters removed, whitespace collapsed, at most `max` characters ("…" when cut,
 * never inside a surrogate pair). null / empty → null.
 */
export function sanitizeExternalLabel(
  raw: string | null | undefined,
  max = 64
): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw)
    .replace(/[\r\n\t]+/g, " ")
    .replace(UNSAFE_LABEL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!s) return null
  if (s.length <= max) return s
  let cut = s.slice(0, Math.max(0, max - 1))
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}
