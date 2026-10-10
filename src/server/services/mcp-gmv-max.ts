// TikTok GMV Max flags for the MCP form (wizard step "Chọn quyền" / config editor): which TikTok ad accounts the
// MCP owner can pick have TikTok Shop / GMV Max, read from the connection check's non-secret summary
// (connections.meta.gmvMax - counts only, no shop names, no secrets). Read-only.
import "server-only"
import { and, eq, inArray, isNull } from "drizzle-orm"

import {
  gmvMaxFlagsFromMeta,
  type GmvMaxAccountFlags,
} from "@/lib/tiktok-gmv-max"
import { db } from "@/server/db/client"
import { connections } from "@/server/db/schema"

import type { McpActor, SelectableConnection } from "./mcp-servers"

/**
 * Flags for the ad accounts of `selectable` (the list `listSelectableConnections` returned for the MCP owner - already
 * scoped by owner/role). Connections are re-checked here: staff only ever read their own connections.
 */
export async function gmvMaxFlagsForMcpScope(
  actor: McpActor,
  selectable: readonly SelectableConnection[]
): Promise<GmvMaxAccountFlags> {
  const tiktok = selectable.filter(
    (c) => c.platform === "tiktok" && c.accounts.length > 0
  )
  if (tiktok.length === 0) return {}
  const rows = await db
    .select({
      id: connections.id,
      ownerId: connections.ownerId,
      meta: connections.meta,
    })
    .from(connections)
    .where(
      and(
        inArray(
          connections.id,
          tiktok.map((c) => c.id)
        ),
        eq(connections.platform, "tiktok"),
        isNull(connections.deletedAt),
        actor.role === "admin" ? undefined : eq(connections.ownerId, actor.id)
      )
    )
  const byId = new Map(tiktok.map((c) => [c.id, c]))
  const out: GmvMaxAccountFlags = {}
  for (const r of rows) {
    const conn = byId.get(r.id)
    if (conn) Object.assign(out, gmvMaxFlagsFromMeta(r.meta, conn.accounts))
  }
  return out
}
