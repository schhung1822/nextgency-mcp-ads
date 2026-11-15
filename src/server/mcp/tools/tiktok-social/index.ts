// TikTok Social toolset (organic TikTok accounts, 17-tiktok-social.md §6) - read only. Registered when the MCP has at
// least one TikTok Social account in scope; independent of the ad platforms.
import type { McpServer } from "@modelcontextprotocol/server"

import type { ToolContext } from "../../tool"
import { tiktokSocialAllowed } from "./shared"
import { TIKTOK_SOCIAL_TOOLS } from "./tools"

export { tiktokSocialAllowed }
export const TIKTOK_SOCIAL_TOOL_NAMES = TIKTOK_SOCIAL_TOOLS.map((t) => t.NAME)

export function registerTiktokSocialTools(server: McpServer, ctx: ToolContext, taken: Set<string>) {
  if (!tiktokSocialAllowed(ctx.grant)) return
  for (const t of TIKTOK_SOCIAL_TOOLS) {
    if (taken.has(t.NAME)) continue
    taken.add(t.NAME)
    t.register(server, ctx)
  }
}
