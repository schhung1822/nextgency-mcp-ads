// Facebook Pages toolset (read only, .claude/docs/11-meta-pages.md §6). Registered when the MCP may read Meta AND has
// at least one Page in scope (mcp_page_scopes). The Messenger inbox tools (§13) additionally need the admin-only MCP
// switch meta_page_messages.
import type { McpServer } from "@modelcontextprotocol/server"
import type { ToolContext } from "../../tool"
import { grantAllows, type McpGrant } from "../../types"
import * as getConversation from "./get-conversation"
import * as getPageInsights from "./get-page-insights"
import * as getPost from "./get-post"
import * as getPostInsights from "./get-post-insights"
import * as listConversations from "./list-conversations"
import * as listPagePosts from "./list-page-posts"
import * as listPostComments from "./list-post-comments"
import * as listPages from "./list-pages"

const TOOLS = [
  listPages,
  listPagePosts,
  getPost,
  listPostComments,
  getPostInsights,
  getPageInsights,
]

/** Messenger inbox (admin switch settings.metaPageMessages) */
const MESSAGE_TOOLS = [listConversations, getConversation]

export const META_PAGE_TOOL_NAMES = TOOLS.map((t) => t.NAME)
export const META_MESSAGE_TOOL_NAMES = MESSAGE_TOOLS.map((t) => t.NAME)

export function metaPagesAllowed(grant: McpGrant): boolean {
  return grantAllows(grant, "meta", "read") && grant.pages.length > 0
}

export function registerMetaPageTools(
  server: McpServer,
  ctx: ToolContext,
  taken: Set<string>
) {
  if (!metaPagesAllowed(ctx.grant)) return
  // fail closed: only an explicit admin-approved switch lists the inbox tools
  const tools = ctx.grant.settings.metaPageMessages === true ? [...TOOLS, ...MESSAGE_TOOLS] : TOOLS
  for (const t of tools) {
    if (taken.has(t.NAME)) continue
    taken.add(t.NAME)
    t.register(server, ctx)
  }
}
