import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { DisclaimerGate } from "@/components/app/disclaimer-gate"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import { acceptDisclaimerAction } from "@/server/actions/legal"
import { createMcpAction } from "@/server/actions/mcp-servers"
import { requireUser } from "@/server/auth/session"
import { hasAcceptedDisclaimer } from "@/server/services/disclaimers"
import { getMcpApifyPoolSummary } from "@/server/services/apify-tokens"
import { getDriveSystemInfo } from "@/server/services/drive-credentials"
import { listDriveSourcesForMcpScope } from "@/server/services/drive-sources"
import { gmvMaxFlagsForMcpScope } from "@/server/services/mcp-gmv-max"
import { listSelectableConnections } from "@/server/services/mcp-servers"
import { listChannelsForMcpScope } from "@/server/services/notification-channels"

import { McpWizard } from "../_components/mcp-wizard"

export const metadata: Metadata = { title: t.meta.newTitle }

export default async function NewMcpPage() {
  const { user } = await requireUser()
  const actor = { id: user.id, email: user.email, role: user.role }
  const [connections, channels, driveSources, driveInfo, accepted, apifyPool] = await Promise.all([
    listSelectableConnections(actor),
    listChannelsForMcpScope(actor),
    listDriveSourcesForMcpScope(actor, { id: actor.id, role: actor.role }),
    getDriveSystemInfo(),
    hasAcceptedDisclaimer(actor.id, "mcp"),
    // the creator owns the new MCP: company Apify tokens + the creator's personal tokens
    getMcpApifyPoolSummary({ id: actor.id, role: actor.role }),
  ])
  // TikTok accounts with TikTok Shop / GMV Max (connection check summary) - for the admin-only GMV Max switch
  const gmvFlags = await gmvMaxFlagsForMcpScope(actor, connections)
  return (
    <div className="w-full">
      <PageHeader
        title={t.wizard.title}
        description={t.wizard.description}
        backHref="/mcp-servers"
      />
      {/* "Miễn trừ trách nhiệm" popup first, once per version - not when there is no connection yet (the wizard only says "add one") */}
      <DisclaimerGate
        kind="mcp"
        cancelHref="/mcp-servers"
        accept={acceptDisclaimerAction}
        disabled={connections.length === 0}
        alreadyAccepted={accepted}
      >
        <McpWizard
          connections={connections}
          channels={channels}
          driveSources={driveSources}
          drivePublicAvailable={driveInfo.hasApiKey}
          createAction={createMcpAction}
          twoFactorEnabled={user.twoFactorEnabled}
          gmvMax={{ isAdmin: actor.role === "admin", flags: gmvFlags }}
          apifyPool={apifyPool}
        />
      </DisclaimerGate>
    </div>
  )
}
