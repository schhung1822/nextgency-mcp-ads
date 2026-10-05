// System notices (.claude/docs/13-system-notices.md): short announcements fetched hourly from the noti.vn webhook
// and shown ONLY in the web top bar ticker (never sent to AI clients through MCP results). Framework-free and
// import-free: used by the worker job, the web app and client components.

export interface SystemNotice {
  /** stable key for React lists (webhook row id when present) */
  id: string
  /** single line of plain text (escaped by React; never rendered as HTML) */
  content: string
}

export const MAX_NOTICES = 10
export const MAX_NOTICE_CHARS = 300

/** Values of `status` that hide a row (anything else - incl. a missing status - shows it). */
const OFF_STATUSES = new Set([
  "off",
  "false",
  "0",
  "disabled",
  "inactive",
  "hidden",
  "tat",
  "tắt",
])

// control chars, zero-width / bidi overrides (spoofing), BOM
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g

/** One line of plain text, at most MAX_NOTICE_CHARS (whitespace collapsed, unsafe characters removed). */
export function sanitizeNoticeText(raw: string): string {
  const s = raw
    .replace(/\r\n?|\n|\t/g, " ")
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
  if (s.length <= MAX_NOTICE_CHARS) return s
  let cut = s.slice(0, MAX_NOTICE_CHARS - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1) // do not split a surrogate pair
  return `${cut.trimEnd()}…`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isOn(status: unknown): boolean {
  if (status === undefined || status === null) return true
  if (typeof status === "boolean") return status
  if (typeof status === "number") return status !== 0
  if (typeof status === "string")
    return !OFF_STATUSES.has(status.trim().toLowerCase())
  return true
}

/** Rows of the webhook answer: one object, an array of objects, or a wrapper { list | data | items | rows: [...] }. */
function rowsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload)) {
    for (const k of ["list", "data", "items", "rows", "records", "notices"]) {
      const inner = payload[k]
      if (Array.isArray(inner)) return inner
    }
    return [payload]
  }
  return []
}

/**
 * Webhook JSON -> notices to display. Each row needs a string `content`; rows whose `status` is off are skipped,
 * empty contents and exact duplicates are dropped, at most MAX_NOTICES are kept (in the webhook's order).
 */
export function parseNoticesPayload(payload: unknown): SystemNotice[] {
  const out: SystemNotice[] = []
  const seen = new Set<string>()
  for (const [i, row] of rowsOf(payload).entries()) {
    if (out.length >= MAX_NOTICES) break
    if (!isRecord(row) || typeof row.content !== "string" || !isOn(row.status))
      continue
    const content = sanitizeNoticeText(row.content)
    if (!content || seen.has(content)) continue
    seen.add(content)
    const rawId = row.Id ?? row.id
    const id =
      typeof rawId === "string" || typeof rawId === "number"
        ? `n-${String(rawId).slice(0, 40)}`
        : `i-${i}`
    out.push({ id: out.some((n) => n.id === id) ? `${id}-${i}` : id, content })
  }
  return out
}
