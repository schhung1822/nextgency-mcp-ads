// Tool catalogue: deterministic order; each toolset registers itself only when the grant allows it
// (the per-tool `register` re-checks permissions and builds the `platform` enum from the grant).
import type { McpServer } from "@modelcontextprotocol/server"
import type { Permission } from "./types"
import { grantPlatformsWith, type McpGrant } from "./types"
import type { ToolContext } from "./tool"
import * as copyObject from "./tools/common/copy-object"
import * as deleteObject from "./tools/common/delete-object"
import * as getMediaUpload from "./tools/common/get-media-upload"
import * as getObject from "./tools/common/get-object"
import * as getReport from "./tools/common/get-report"
import * as listAccounts from "./tools/common/list-accounts"
import * as listObjects from "./tools/common/list-objects"
import * as lookup from "./tools/common/lookup"
import * as setStatus from "./tools/common/set-status"
import * as updateBudget from "./tools/common/update-budget"
import * as updateObject from "./tools/common/update-object"
import * as uploadMedia from "./tools/common/upload-media"
import { apifyToolsAllowed, registerApifyTools } from "./tools/apify"
import { driveToolsAllowed, registerDriveTools } from "./tools/drive"
import { registerExtensions } from "./tools/extensions"
import { metaPagesAllowed, registerMetaPageTools } from "./tools/meta-pages"
import { registerTelegramTools, telegramToolsAllowed } from "./tools/telegram"
import { registerTiktokSocialTools, tiktokSocialAllowed } from "./tools/tiktok-social"

export interface ToolsetDef {
  name: string
  permission: Permission
  isAllowed(grant: McpGrant): boolean
  register(server: McpServer, ctx: ToolContext, taken: Set<string>): void
}

function common(
  mod: { NAME: string; register(server: McpServer, ctx: ToolContext): void },
  permission: Permission
): ToolsetDef {
  return {
    name: mod.NAME,
    permission,
    isAllowed: (grant) => grantPlatformsWith(grant, permission).length > 0,
    register: (server, ctx, taken) => {
      taken.add(mod.NAME)
      mod.register(server, ctx)
    },
  }
}

export const TOOLSETS: ToolsetDef[] = [
  common(listAccounts, "read"),
  common(getReport, "read"),
  common(listObjects, "read"),
  common(getObject, "read"),
  common(lookup, "read"),
  common(setStatus, "status"),
  common(updateBudget, "update"),
  common(updateObject, "update"),
  common(copyObject, "copy"),
  common(uploadMedia, "create"),
  common(deleteObject, "delete"),
  {
    // background (large Drive video) uploads of ads_upload_media: a READ tool offered whenever ads_upload_media is
    name: getMediaUpload.NAME,
    permission: "read",
    isAllowed: (grant) => grantPlatformsWith(grant, "create").length > 0,
    register: (server, ctx, taken) => {
      taken.add(getMediaUpload.NAME)
      getMediaUpload.register(server, ctx)
    },
  },
  {
    // Facebook Pages (read only): needs Meta "read" + at least one Page in the MCP scope
    name: "meta_pages",
    permission: "read",
    isAllowed: (grant) => metaPagesAllowed(grant),
    register: (server, ctx, taken) => registerMetaPageTools(server, ctx, taken),
  },
  {
    // Telegram notification channels: independent of the ad platforms - needs ≥ 1 channel in the MCP scope
    name: "telegram",
    permission: "read",
    isAllowed: (grant) => telegramToolsAllowed(grant),
    register: (server, ctx, taken) => registerTelegramTools(server, ctx, taken),
  },
  {
    // Google Drive / Sheets (15-google-drive-media.md §7): ≥ 1 source in scope or public Drive links usable
    name: "drive",
    permission: "read",
    isAllowed: (grant) => driveToolsAllowed(grant),
    register: (server, ctx, taken) => registerDriveTools(server, ctx, taken),
  },
  {
    // Apify (16-apify.md §7): setting apify_enabled + >= 1 token in the MCP pool; independent of the ad platforms
    name: "apify",
    permission: "read",
    isAllowed: (grant) => apifyToolsAllowed(grant),
    register: (server, ctx, taken) => registerApifyTools(server, ctx, taken),
  },
  {
    // TikTok Social (17-tiktok-social.md §6): >= 1 TikTok account picked for the MCP; independent of the ad platforms
    name: "tiktok_social",
    permission: "read",
    isAllowed: (grant) => tiktokSocialAllowed(grant),
    register: (server, ctx, taken) => registerTiktokSocialTools(server, ctx, taken),
  },
  {
    name: "platform_extensions",
    permission: "read",
    isAllowed: (grant) => grantPlatformsWith(grant, "read").length > 0,
    register: (server, ctx, taken) => registerExtensions(server, ctx, taken),
  },
]

/** Names of the common tools (for docs / UI). */
export const COMMON_TOOL_PERMISSIONS: Record<string, Permission> = Object.fromEntries(
  TOOLSETS.filter(
    (t) => !["platform_extensions", "meta_pages", "telegram", "drive", "apify", "tiktok_social"].includes(t.name)
  ).map((t) => [
    t.name,
    t.permission,
  ])
)

export function registerAllowedTools(server: McpServer, ctx: ToolContext) {
  const taken = new Set<string>(Object.keys(COMMON_TOOL_PERMISSIONS))
  for (const def of TOOLSETS) {
    if (def.isAllowed(ctx.grant)) def.register(server, ctx, taken)
  }
}
