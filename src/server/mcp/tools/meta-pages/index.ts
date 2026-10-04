// Facebook Pages toolset (read only, .claude/docs/11-meta-pages.md §6). Registered when the MCP may read Meta AND has
// at least one Page in scope (mcp_page_scopes).
import type { McpServer } from "@modelcontextprotocol/server"
import type { ToolContext } from "../../tool"
import { grantAllows, type McpGrant } from "../../types"
import * as getPageInsights from "./get-page-insights"
import * as getPost from "./get-post"
import * as getPostInsights from "./get-post-insights"
import * as listPagePosts from "./list-page-posts"
import * as listPages from "./list-pages"

const TOOLS = [
  listPages,
  listPagePosts,
  getPost,
  getPostInsights,
  getPageInsights,
]

export const META_PAGE_TOOL_NAMES = TOOLS.map((t) => t.NAME)

export function metaPagesAllowed(grant: McpGrant): boolean {
  return grantAllows(grant, "meta", "read") && grant.pages.length > 0
}

export function registerMetaPageTools(
  server: McpServer,
  ctx: ToolContext,
  taken: Set<string>
) {
  if (!metaPagesAllowed(ctx.grant)) return
  for (const t of TOOLS) {
    if (taken.has(t.NAME)) continue
    taken.add(t.NAME)
    t.register(server, ctx)
  }
}
