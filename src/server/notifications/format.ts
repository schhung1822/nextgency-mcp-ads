// Telegram message builders (parse_mode HTML). Every dynamic value - ad/connection names come from ad platforms
// and users, i.e. untrusted - goes through escapeHtml; only <b> <i> <code> <blockquote> are emitted. Dynamic parts
// are truncated BEFORE escaping so a cut never splits an entity. No "next/*" imports (worker + web).
import { PLATFORM_LABELS } from "@/lib/constants"
import { formatDateTime, formatMoney } from "@/lib/format"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import { redactString } from "@/server/audit/redact"
import { stripMediaUrlQueries, stripUrlQueries } from "@/server/mcp/log-args"
import type { FieldChange, Platform } from "@/server/providers/types"

import { TELEGRAM_CAPTION_TEXT_MAX } from "./media"
import { htmlToPlainText } from "./telegram"

export { creditFooter, TELEGRAM_CREDIT_URL, type CreditFooter } from "./credit"

/** Telegram hard limit for a message text (after entity parsing). */
export const TELEGRAM_MAX_MESSAGE = 4096
/** Telegram hard limit for a photo / video / document caption (after entity parsing). */
export const TELEGRAM_MAX_CAPTION = 1024
/** Budget for the dynamic part of a message (before escaping; the rest is our fixed template). */
export const MAX_DYNAMIC_TEXT = 3500
export const PREVIEW_MAX = 300
const MAX_CHANGE_LINES = 15

/** & first, then < > (and " for attribute safety). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Cut to `max` characters (never inside a surrogate pair) and append "…". */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = Math.max(0, max - 1)
  const code = s.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut--
  return `${s.slice(0, cut)}…`
}

/** escapeHtml(truncateText(s, max)) */
export function esc(s: string | null | undefined, max = 200): string {
  return escapeHtml(truncateText(String(s ?? ""), max))
}

/** Plain-text preview for notification_deliveries.preview (redacted, whitespace collapsed, <= 300 chars). */
export function previewOf(html: string): string {
  const plain = htmlToPlainText(html).replace(/\s+/g, " ").trim()
  return truncateText(redactString(plain), PREVIEW_MAX)
}

/**
 * Final guard. Telegram counts characters AFTER entity parsing: the text without tags, entities decoded (measured
 * here with .length = UTF-16 units, never fewer than Telegram's count). That text + `reserveChars` (the credit
 * footer appended at send time, §10.1) must fit `max` (4096 text / 1024 caption); otherwise the message is
 * converted to plain text, cut and re-escaped (cutting HTML could leave an open tag). Always returns valid HTML for
 * parse_mode HTML. Builders stay far below the limit.
 */
export function fitMessage(
  html: string,
  reserveChars = 0,
  max = TELEGRAM_MAX_MESSAGE
): string {
  const budget = Math.max(1, max - reserveChars)
  const plain = htmlToPlainText(html)
  if (plain.length <= budget) return html
  return escapeHtml(truncateText(plain, budget))
}

/** an http(s) URL inside free text: scheme + host + path kept, query / fragment dropped */
const URL_IN_TEXT = /\b(https?:\/\/[^\s?#<>"']+)[?#][^\s<>"']*/gi

/**
 * Secrets never leave through Telegram: every dynamic text of an MCP message is redacted (token patterns of
 * audit/redact) and loses the query / fragment of the URLs it contains (signed media URLs, OAuth codes) - BEFORE
 * truncation and escaping.
 */
export function scrubText(s: string | null | undefined): string {
  return redactString(String(s ?? "").replace(URL_IN_TEXT, "$1?[redacted]"))
}

/** A changed value before it is turned into text: URL query strings dropped (deep; media URL fields: any scheme). */
function scrubValue(v: unknown, field: string): unknown {
  if (v === null || v === undefined) return v
  return stripMediaUrlQueries({ [field]: stripUrlQueries(v) })[field]
}

function platformLabel(p: string | null | undefined): string {
  return p ? (PLATFORM_LABELS[p as Platform] ?? p) : ""
}

// ---------------------------------------------------------------------------
// Test message
// ---------------------------------------------------------------------------

export function buildTestMessage(args: {
  channelName: string
  actorEmail?: string | null
  now?: Date
}): string {
  const lines = [
    `✅ <b>${escapeHtml(m.messages.test.title)}</b>`,
    esc(m.messages.test.body(truncateText(args.channelName, 100)), 400),
  ]
  if (args.actorEmail)
    lines.push(
      `${escapeHtml(m.messages.test.by)}: <code>${esc(args.actorEmail, 200)}</code>`
    )
  lines.push(`<i>${escapeHtml(formatDateTime(args.now ?? new Date()))}</i>`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

export type ConnectionHealthEvent =
  "connection_expiring" | "connection_invalid" | "connection_recovered"

export function buildConnectionHealthMessage(args: {
  event: ConnectionHealthEvent
  connectionName: string
  platform: string
  ownerEmail?: string | null
  statusMessage?: string | null
  tokenExpiresAt?: Date | null
}): string {
  const t = m.messages.connection
  const head =
    args.event === "connection_expiring"
      ? `⏳ <b>${escapeHtml(t.expiring)}</b>`
      : args.event === "connection_invalid"
        ? `⛔ <b>${escapeHtml(t.invalid)}</b>`
        : `✅ <b>${escapeHtml(t.recovered)}</b>`
  const lines = [
    head,
    `${escapeHtml(t.connection)}: <code>${esc(args.connectionName, 200)}</code> · ${esc(platformLabel(args.platform), 40)}`,
  ]
  if (args.ownerEmail)
    lines.push(`${escapeHtml(t.owner)}: ${esc(args.ownerEmail, 200)}`)
  if (args.tokenExpiresAt && args.event !== "connection_invalid") {
    lines.push(
      `${escapeHtml(t.expiresAt)}: ${escapeHtml(formatDateTime(args.tokenExpiresAt))}`
    )
  }
  if (args.statusMessage)
    lines.push(
      `<blockquote>${esc(redactString(args.statusMessage), 1000)}</blockquote>`
    )
  if (args.event === "connection_expiring")
    lines.push(`<i>${escapeHtml(t.fixExpiring)}</i>`)
  if (args.event === "connection_invalid")
    lines.push(`<i>${escapeHtml(t.fixInvalid)}</i>`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// System update
// ---------------------------------------------------------------------------

export function buildUpdateAvailableMessage(args: {
  version: string
  currentVersion?: string | null
  notes?: string | null
}): string {
  const t = m.messages.update
  const lines = [
    `🆕 <b>${escapeHtml(t.available)}</b>`,
    `${escapeHtml(t.version)}: <code>v${esc(args.version, 40)}</code>`,
  ]
  if (args.currentVersion)
    lines.push(
      `${escapeHtml(t.current)}: <code>v${esc(args.currentVersion, 40)}</code>`
    )
  const notes = args.notes?.trim()
  if (notes) lines.push(`<blockquote>${esc(notes, 1500)}</blockquote>`)
  lines.push(`<i>${escapeHtml(t.howTo)}</i>`)
  return lines.join("\n")
}

export type UpdateResultStatus = "succeeded" | "failed" | "rolled_back"

export function buildUpdateResultMessage(args: {
  status: UpdateResultStatus
  targetVersion: string
  message?: string | null
}): string {
  const t = m.messages.update
  const head =
    args.status === "succeeded"
      ? `✅ <b>${escapeHtml(t.succeeded)}</b>`
      : args.status === "rolled_back"
        ? `↩️ <b>${escapeHtml(t.rolledBack)}</b>`
        : `❌ <b>${escapeHtml(t.failed)}</b>`
  const lines = [
    head,
    `${escapeHtml(t.target)}: <code>v${esc(args.targetVersion, 40)}</code>`,
  ]
  if (args.message)
    lines.push(
      `<blockquote>${esc(redactString(args.message), 1000)}</blockquote>`
    )
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// MCP: AI wrote to an ad platform / AI message
// ---------------------------------------------------------------------------

/**
 * One changed field. Money: pass values in MAJOR units with `currency` (formatted "200.000 ₫"), or a ready-made
 * `display` (the MCP layer already converted minor units / micros). Otherwise values are shown as text.
 */
export type NotifyChange = FieldChange & {
  currency?: string | null
  display?: { before: string; after: string } | null
}

const STATUS_FIELDS = new Set([
  "status",
  "effective_status",
  "configured_status",
])

function normStatus(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.toLowerCase()
  if (s === "active" || s === "enabled" || s === "on") return "active"
  if (s === "paused" || s === "disabled" || s === "off") return "paused"
  if (s === "archived") return "archived"
  if (s === "deleted" || s === "removed") return "deleted"
  return null
}

function isMoneyField(field: string): boolean {
  return /budget|bid|amount|spend_cap|cost_cap/i.test(field)
}

function valueText(
  v: unknown,
  field: string,
  currency?: string | null
): string {
  if (v === null || v === undefined || v === "")
    return m.messages.mcpWrite.empty
  if (STATUS_FIELDS.has(field)) {
    const st = normStatus(v)
    if (st) return m.messages.mcpWrite.status[st] ?? String(v)
  }
  if (typeof v === "number" && currency && isMoneyField(field))
    return formatMoney(v, currency)
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function levelLabel(level: string | null | undefined, n: number): string {
  const label =
    m.messages.mcpWrite.levels[level ?? "object"] ??
    m.messages.mcpWrite.levels.object!
  return m.messages.mcpWrite.objects(n, label)
}

function headline(
  toolName: string,
  changes: NotifyChange[]
): { emoji: string; text: string } {
  const t = m.messages.mcpWrite
  const objects = new Set(changes.map((c) => c.objectId))
  const levels = new Set(changes.map((c) => c.level ?? "object"))
  const what = levelLabel(
    levels.size === 1 ? [...levels][0] : "object",
    Math.max(objects.size, 1)
  )
  const tool = toolName.toLowerCase()
  if (/delete|archive|remove/.test(tool))
    return { emoji: "🗑", text: t.deleted(what) }
  if (/copy|duplicate/.test(tool)) return { emoji: "📄", text: t.copied(what) }
  if (/create|upload/.test(tool) || changes.some((c) => c.field === "create"))
    return { emoji: "🆕", text: t.created(what) }
  if (changes.length > 0 && changes.every((c) => STATUS_FIELDS.has(c.field))) {
    const targets = new Set(changes.map((c) => normStatus(c.after)))
    if (targets.size === 1 && targets.has("paused"))
      return { emoji: "⏸", text: t.paused(what) }
    if (targets.size === 1 && targets.has("active"))
      return { emoji: "▶️", text: t.activated(what) }
    if (
      targets.size === 1 &&
      (targets.has("archived") || targets.has("deleted"))
    )
      return { emoji: "🗑", text: t.deleted(what) }
  }
  if (changes.length > 0 && changes.every((c) => isMoneyField(c.field)))
    return { emoji: "💰", text: t.budget(what) }
  return { emoji: "✏️", text: t.updated(what) }
}

export function buildMcpWriteMessage(args: {
  mcpName: string
  platform: string
  accountId?: string | null
  toolName: string
  changes: NotifyChange[]
  reason?: string | null
}): string {
  const t = m.messages.mcpWrite
  const h = headline(args.toolName, args.changes)
  const meta = [
    `${escapeHtml(t.mcp)}: <code>${esc(scrubText(args.mcpName), 100)}</code>`,
    esc(platformLabel(args.platform), 40),
  ]
  if (args.accountId)
    meta.push(
      `${escapeHtml(t.account)} <code>${esc(scrubText(args.accountId), 64)}</code>`
    )
  const lines = [
    `${h.emoji} <b>${escapeHtml(h.text)}</b>`,
    meta.join(" · "),
    `${escapeHtml(t.tool)}: <code>${esc(scrubText(args.toolName), 64)}</code>`,
  ]

  // budget for the change lines: the dynamic part stays under MAX_DYNAMIC_TEXT (before escaping)
  let budget = MAX_DYNAMIC_TEXT - 600
  const shown = args.changes.slice(0, MAX_CHANGE_LINES)
  let printed = 0
  for (const c of shown) {
    // every dynamic part is scrubbed (redact + URL queries) BEFORE truncate / escape
    const objectId = scrubText(c.objectId)
    const name = c.objectName
      ? `${truncateText(scrubText(c.objectName), 80)} (${truncateText(objectId, 40)})`
      : truncateText(objectId, 40)
    const before = scrubText(
      c.display
        ? c.display.before
        : valueText(scrubValue(c.before, c.field), c.field, c.currency)
    )
    const after = scrubText(
      c.display
        ? c.display.after
        : valueText(scrubValue(c.after, c.field), c.field, c.currency)
    )
    const fieldPart =
      STATUS_FIELDS.has(c.field) || c.field === "create"
        ? ""
        : ` · ${truncateText(scrubText(c.field), 40)}`
    const raw = `${name}${fieldPart}: ${truncateText(before, 120)} → ${truncateText(after, 120)}`
    if (raw.length > budget) break
    budget -= raw.length
    lines.push(`• ${escapeHtml(raw)}`)
    printed++
  }
  if (args.changes.length > printed)
    lines.push(escapeHtml(t.more(args.changes.length - printed)))
  if (args.reason?.trim())
    lines.push(
      `${escapeHtml(t.reason)}: ${esc(scrubText(args.reason.trim()), 500)}`
    )
  return lines.join("\n")
}

/**
 * telegram_send_message: fixed title (AI cannot fake it) + escaped text (AI cannot inject HTML). The AI text is
 * scrubbed first (scrubText: a token / key the AI copied never reaches the chat, and links keep scheme + host + path
 * but lose their query / fragment - a signed URL pasted into the text is never posted nor stored in the preview).
 */
export function buildAiMessage(args: {
  mcpName: string
  text: string
}): string {
  return `<b>${escapeHtml(m.messages.aiMessage.title(truncateText(scrubText(args.mcpName), 100)))}</b>\n\n${esc(scrubText(args.text), MAX_DYNAMIC_TEXT)}`
}

/**
 * Caption of a telegram_send_message attachment: the same fixed title (MCP name ≤ 60) + the scrubbed (redacted, URL
 * queries dropped), escaped AI text (≤ TELEGRAM_CAPTION_TEXT_MAX, optional) - with the credit footer it stays under
 * the 1024-character caption.
 */
export function buildAiCaption(args: {
  mcpName: string
  text?: string | null
}): string {
  const title = `<b>${escapeHtml(m.messages.aiMessage.title(truncateText(scrubText(args.mcpName), 60)))}</b>`
  const text = args.text?.trim() ? scrubText(args.text) : ""
  return text ? `${title}\n\n${esc(text, TELEGRAM_CAPTION_TEXT_MAX)}` : title
}
