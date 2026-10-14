// Apify toolset (16-apify.md §7). Independent of the ad platforms: registered when the MCP setting apify_enabled is
// on AND the MCP's token pool (company tokens + the owner's personal tokens) has at least one token:
//  - apify_list_tasks, apify_run_task, apify_get_run, apify_get_results, apify_abort_run
//  - + apify_search_actors, apify_get_actor, apify_run_actor when the admin-only switch apify_store_actors is on
// Every handler re-checks its own rules (registration is not a security boundary).
import type { McpServer } from "@modelcontextprotocol/server"

import type { ToolContext } from "../../tool"
import type { McpGrant } from "../../types"
import * as abortRun from "./abort-run"
import * as getActor from "./get-actor"
import * as getResults from "./get-results"
import * as getRun from "./get-run"
import * as listTasks from "./list-tasks"
import * as runActor from "./run-actor"
import * as runTask from "./run-task"
import * as searchActors from "./search-actors"

/** catalog tools (apify_enabled + ≥ 1 token) */
export const APIFY_CATALOG_TOOL_NAMES = [
  listTasks.NAME,
  runTask.NAME,
  getRun.NAME,
  getResults.NAME,
  abortRun.NAME,
]
/** + Actors outside the catalog (admin switch apify_store_actors) */
export const APIFY_STORE_TOOL_NAMES = [
  searchActors.NAME,
  getActor.NAME,
  runActor.NAME,
]
export const APIFY_TOOL_NAMES = [
  ...APIFY_CATALOG_TOOL_NAMES,
  ...APIFY_STORE_TOOL_NAMES,
]

export function apifyToolsAllowed(grant: McpGrant): boolean {
  return grant.settings.apifyEnabled && grant.apifyTokens.length > 0
}

export function registerApifyTools(
  server: McpServer,
  ctx: ToolContext,
  taken: Set<string>
) {
  if (!apifyToolsAllowed(ctx.grant)) return
  const add = (mod: {
    NAME: string
    register(server: McpServer, ctx: ToolContext): void
  }) => {
    if (taken.has(mod.NAME)) return
    taken.add(mod.NAME)
    mod.register(server, ctx)
  }
  for (const mod of [listTasks, runTask, getRun, getResults, abortRun]) add(mod)
  if (ctx.grant.settings.apifyStoreActors) {
    for (const mod of [searchActors, getActor, runActor]) add(mod)
  }
}
