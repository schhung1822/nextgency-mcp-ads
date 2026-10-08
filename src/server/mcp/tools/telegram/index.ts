// Telegram toolset (notification channels, .claude/docs/14-telegram-notifications.md §6). Independent of the ad
// platforms: registered when the MCP has at least one usable channel in scope (mcp_notification_scopes);
// telegram_send_message only when the MCP setting "AI được gửi tin" (telegram_tool) is on.
import type { McpServer } from "@modelcontextprotocol/server"
import type { ToolContext } from "../../tool"
import type { McpGrant } from "../../types"
import * as listChannels from "./list-channels"
import * as sendMessage from "./send-message"

export const TELEGRAM_TOOL_NAMES = [listChannels.NAME, sendMessage.NAME]

export function telegramToolsAllowed(grant: McpGrant): boolean {
  return grant.notificationChannels.length > 0
}

export function registerTelegramTools(
  server: McpServer,
  ctx: ToolContext,
  taken: Set<string>
) {
  if (!telegramToolsAllowed(ctx.grant)) return
  if (!taken.has(listChannels.NAME)) {
    taken.add(listChannels.NAME)
    listChannels.register(server, ctx)
  }
  if (ctx.grant.settings.telegramTool && !taken.has(sendMessage.NAME)) {
    taken.add(sendMessage.NAME)
    sendMessage.register(server, ctx)
  }
}
