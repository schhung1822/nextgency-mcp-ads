// Re-check, at USE time, that what an MCP call allowed earlier is still granted (security review L4): the /dl relay
// (a platform fetches minutes after the tool call) and the background video upload job (may run later still).
// The MCP grant is rebuilt with the same rules as the /mcp endpoint (grant.ts: MCP usable, owner not banned,
// permissions, account scope, live Drive sources, public-link switch). No imports from "next/*".
import { eq } from "drizzle-orm"
import { LRUCache } from "lru-cache"

import { db } from "@/server/db/client"
import { mcpServers } from "@/server/db/schema"

import { loadGrantByHash } from "../mcp/grant"
import { grantAllows, type McpGrant } from "../mcp/types"

/** grants are rebuilt at most every few seconds per MCP (a platform may send many Range requests) */
const GRANT_TTL_MS = 5_000

const g = globalThis as unknown as {
  __adsDriveRecheckGrants?: LRUCache<string, { grant: McpGrant | null }>
}

function cache() {
  g.__adsDriveRecheckGrants ??= new LRUCache<
    string,
    { grant: McpGrant | null }
  >({
    max: 1_000,
    ttl: GRANT_TTL_MS,
  })
  return g.__adsDriveRecheckGrants
}

/** The current grant of an MCP by id; null when the MCP is unusable (disabled, deleted, expired, owner banned). */
export async function loadGrantForMcpId(
  mcpId: string,
  opts: { fresh?: boolean } = {}
): Promise<McpGrant | null> {
  if (!opts.fresh) {
    const hit = cache().get(mcpId)
    if (hit) return hit.grant
  }
  const [m] = await db
    .select({ keyHash: mcpServers.keyHash })
    .from(mcpServers)
    .where(eq(mcpServers.id, mcpId))
    .limit(1)
  const grant = m?.keyHash ? await loadGrantByHash(m.keyHash) : null
  cache().set(mcpId, { grant })
  return grant
}

/** How a relay link / upload job reads the Drive file (stored when the tool call resolved it). */
export interface DriveUseRef {
  /** ad_accounts.id the media goes to */
  adAccountId: string
  access: string
  credentialId: string | null
  /** drive_sources.id the file was found in (null = public "Anyone with the link" file) */
  sourceId: string | null
}

/**
 * Still allowed by `grant`?
 * - the ad account is still in scope with the "create" permission on its platform (uploading media);
 * - service_account: the folder source is still granted to the MCP (live, credential unchanged);
 * - api_key (public link): the MCP's public-links switch is still on and a system API key exists.
 */
export function driveUseStillGranted(
  grant: McpGrant,
  ref: DriveUseRef
): boolean {
  const account = grant.accounts.find((a) => a.id === ref.adAccountId)
  if (!account || !grantAllows(grant, account.platform, "create")) return false
  if (ref.access === "api_key") {
    if (!grant.settings.drivePublicLinks || !grant.drivePublicAvailable)
      return false
    return (
      ref.sourceId === null ||
      grant.driveSources.some((s) => s.id === ref.sourceId)
    )
  }
  if (ref.access !== "service_account" || !ref.credentialId || !ref.sourceId)
    return false
  const source = grant.driveSources.find((s) => s.id === ref.sourceId)
  return (
    !!source &&
    source.kind === "folder" &&
    source.credentialId === ref.credentialId
  )
}

/** Tests only. */
export function __resetAccessRecheckCache(): void {
  cache().clear()
}
