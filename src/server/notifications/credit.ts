// Credit line ending EVERY Telegram message - an italic "Ads MCP Simple" link (like n8n's "This message was sent
// automatically with n8n"), 14-telegram-notifications.md §10.1. Appended exactly once, at the send
// layer (sendTelegramText / sendTelegramMedia), never by the builders / enqueue / preview. Imports nothing from
// format.ts or telegram.ts (both use it - no import cycle). No "next/*" imports.
import { notifications as m } from "@/lib/i18n/vi/notifications"

/** Fixed on purpose: not configurable by env. */
export const TELEGRAM_CREDIT_URL = "https://s.noti.vn/s/ads-mcp-simple"

export interface CreditFooter {
  /** parse_mode HTML: italic link */
  html: string
  /** plain-text fallback ("can't parse entities"): the link spelled out */
  plain: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function creditFooter(): CreditFooter {
  const t = m.messages.credit
  return {
    html: `\n\n<i><a href="${TELEGRAM_CREDIT_URL}">${escapeHtml(t.linkLabel)}</a></i>`,
    plain: `\n\n${t.linkLabel}: ${TELEGRAM_CREDIT_URL}`,
  }
}

/** body + footer; an empty body (media without caption) gets the footer alone, without the leading blank line. */
export function withFooter(
  body: string,
  footer: string | null | undefined
): string {
  if (!footer) return body
  return body.trim() ? `${body}${footer}` : footer.replace(/^\s+/, "")
}
