// Telegram summary after a successful MCP write execution (14-telegram-notifications.md §5 `mcp_write`).
// Only when the MCP has `telegram_notify_writes` and at least one channel in scope. Fire-and-forget: the write
// already succeeded and is logged - a Telegram problem must never fail or delay it (notifyMcpWrite never throws).
import type { FieldChange } from "../providers/types"
import { notifyMcpWrite, type NotifyChange } from "../notifications"
import type { GrantAccount, McpGrant } from "./types"

/**
 * Changes as the message shows them. FieldChange values of executed writes are MAJOR units of the account currency
 * (adapters convert minor units / micros before reporting before → after), so the currency is attached and the
 * formatter prints top-level money fields as money; nested objects (created object summaries) stay as they are.
 */
export function notifyChangesOf(
  changes: FieldChange[],
  currency: string
): NotifyChange[] {
  return changes.map((c) => ({ ...c, currency }))
}

export function notifyWriteExecuted(o: {
  grant: McpGrant
  account: GrantAccount
  toolName: string
  changes: FieldChange[]
  reason?: string | null
}): void {
  const { grant } = o
  if (
    !grant.settings.telegramNotifyWrites ||
    grant.notificationChannels.length === 0 ||
    o.changes.length === 0
  )
    return
  void notifyMcpWrite({
    mcpId: grant.mcpId,
    mcpName: grant.mcpName,
    channelIds: grant.notificationChannels.map((c) => c.id),
    platform: o.account.platform,
    accountId: o.account.externalId,
    toolName: o.toolName,
    changes: notifyChangesOf(o.changes, o.account.currency),
    reason: o.reason ?? null,
  })
}
