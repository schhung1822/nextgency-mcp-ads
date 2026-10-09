// Google Drive toolset (15-google-drive-media.md §7). Registered when the MCP has ≥ 1 Drive source in scope OR may use
// public Drive links (setting drive_public_links + system API key + "create" on ≥ 1 platform):
//  - drive_list_sources: always (no Google call)
//  - drive_list_files: ≥ 1 folder source, or public links usable
//  - drive_sheet_read: ≥ 1 sheet source
//  - drive_sheet_update_rows: ≥ 1 sheet source with write-back + setting drive_sheet_writeback + "create" somewhere
// Every handler re-checks its own rules (registration is not a security boundary).
import type { McpServer } from "@modelcontextprotocol/server"
import type { SheetSourceConfig } from "../../../drive/types"
import { drivePublicUsable } from "../../drive-access"
import type { ToolContext } from "../../tool"
import { grantPlatformsWith, type McpGrant } from "../../types"
import * as listFiles from "./list-files"
import * as listSources from "./list-sources"
import * as sheetRead from "./sheet-read"
import * as sheetUpdateRows from "./sheet-update-rows"

export const DRIVE_TOOL_NAMES = [
  listSources.NAME,
  listFiles.NAME,
  sheetRead.NAME,
  sheetUpdateRows.NAME,
]

/** public links are worth offering only to an MCP that can upload media somewhere */
function publicLinksOffered(grant: McpGrant): boolean {
  return (
    drivePublicUsable(grant) && grantPlatformsWith(grant, "create").length > 0
  )
}

export function driveToolsAllowed(grant: McpGrant): boolean {
  return grant.driveSources.length > 0 || publicLinksOffered(grant)
}

export function registerDriveTools(
  server: McpServer,
  ctx: ToolContext,
  taken: Set<string>
) {
  const { grant } = ctx
  if (!driveToolsAllowed(grant)) return
  const add = (mod: {
    NAME: string
    register(server: McpServer, ctx: ToolContext): void
  }) => {
    if (taken.has(mod.NAME)) return
    taken.add(mod.NAME)
    mod.register(server, ctx)
  }
  const sheets = grant.driveSources.filter((s) => s.kind === "sheet")
  add(listSources)
  if (
    grant.driveSources.some((s) => s.kind === "folder") ||
    publicLinksOffered(grant)
  )
    add(listFiles)
  if (sheets.length) add(sheetRead)
  if (
    sheets.some((s) => (s.config as SheetSourceConfig).writeback) &&
    grant.settings.driveSheetWriteback &&
    grantPlatformsWith(grant, "create").length > 0
  ) {
    add(sheetUpdateRows)
  }
}
