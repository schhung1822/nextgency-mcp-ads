import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  deleteMcpAction,
  revealMcpUrlAction,
  rotateMcpKeyAction,
  setMcpEnabledAction,
  updateMcpAction,
} from "@/server/actions/mcp-servers"
import { requireUser } from "@/server/auth/session"
import { listAdAccounts } from "@/server/services/ad-accounts"
import {
  getMcpServer,
  listSelectableConnections,
  type McpActor,
  type McpDetail,
  type SelectableConnection,
} from "@/server/services/mcp-servers"
import { getDriveSystemInfo } from "@/server/services/drive-credentials"
import { gmvMaxFlagsForMcpScope } from "@/server/services/mcp-gmv-max"
import { listDriveSourcesForMcpScope } from "@/server/services/drive-sources"
import { listChannelsForMcpScope } from "@/server/services/notification-channels"

import { parseDetailTab } from "../_components/detail-tabs"
import { McpDetailView } from "../_components/mcp-detail"

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Names of the ad accounts this MCP picked one by one that are switched off now. The selectable list only carries
 * ENABLED accounts, so the config editor's "no longer usable" warning needs them from the connection itself.
 * Best effort: a connection the viewer cannot read just leaves its accounts unnamed.
 */
async function switchedOffAccountNames(
  actor: McpActor,
  mcp: McpDetail,
  selectable: SelectableConnection[]
): Promise<Record<string, string>> {
  const enabled = new Map(
    selectable.map((c) => [c.id, new Set(c.accounts.map((a) => a.id))])
  )
  const wanted = new Set<string>()
  const connectionIds = new Set<string>()
  for (const p of mcp.config) {
    for (const c of p.connections) {
      const on = enabled.get(c.connectionId)
      if (c.connectionDeleted || !on || c.accountIds === null) continue
      for (const id of c.accountIds) {
        if (on.has(id)) continue
        wanted.add(id)
        connectionIds.add(c.connectionId)
      }
    }
  }
  const names: Record<string, string> = {}
  await Promise.all(
    [...connectionIds].map(async (connectionId) => {
      try {
        for (const a of await listAdAccounts(actor, connectionId)) {
          if (wanted.has(a.id)) names[a.id] = a.name
        }
      } catch {
        // not readable (deleted meanwhile / not the viewer's): the warning falls back to a count
      }
    })
  )
  return names
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const { user } = await requireUser()
  const mcp = await getMcpServer(
    { id: user.id, email: user.email, role: user.role },
    id
  )
  return { title: mcp?.name ?? t.meta.detailTitle }
}

export default async function McpDetailPage({ params, searchParams }: Props) {
  const [{ id }, sp, { user }] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ])
  const actor = { id: user.id, email: user.email, role: user.role } as const
  const mcp = await getMcpServer(actor, id)
  if (!mcp) notFound()
  const [connections, channels, driveSources, driveInfo] = await Promise.all([
    listSelectableConnections(actor, {
      id: mcp.ownerId,
      role: mcp.ownerRole,
    }),
    // Telegram channels of the MCP OWNER only (what the service accepts on save) - admins included
    listChannelsForMcpScope({ id: mcp.ownerId }),
    // Drive sources usable by the MCP OWNER (company + the owner's; admin-owned MCP: any live source)
    listDriveSourcesForMcpScope(actor, { id: mcp.ownerId, role: mcp.ownerRole }),
    getDriveSystemInfo(),
  ])
  const [accountNames, gmvFlags] = await Promise.all([
    switchedOffAccountNames(actor, mcp, connections),
    // TikTok accounts with TikTok Shop / GMV Max (connection check summary) - for the admin-only GMV Max switch
    gmvMaxFlagsForMcpScope(actor, connections),
  ])
  const initialTab = parseDetailTab(sp.tab)
  return (
    <McpDetailView
      mcp={mcp}
      connections={connections}
      channels={channels}
      driveSources={driveSources}
      drivePublicAvailable={driveInfo.hasApiKey}
      accountNames={accountNames}
      twoFactorEnabled={user.twoFactorEnabled}
      initialTab={initialTab}
      gmvMax={{ isAdmin: actor.role === "admin", flags: gmvFlags }}
      actions={{
        update: updateMcpAction,
        reveal: revealMcpUrlAction,
        rotate: rotateMcpKeyAction,
        setEnabled: setMcpEnabledAction,
        remove: deleteMcpAction,
      }}
    />
  )
}
