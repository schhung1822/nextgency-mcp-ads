import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import { createMcpAction } from "@/server/actions/mcp-servers"
import { requireUser } from "@/server/auth/session"
import { getDriveSystemInfo } from "@/server/services/drive-credentials"
import { listDriveSourcesForMcpScope } from "@/server/services/drive-sources"
import { listSelectableConnections } from "@/server/services/mcp-servers"
import { listChannelsForMcpScope } from "@/server/services/notification-channels"

import { McpWizard } from "../_components/mcp-wizard"

export const metadata: Metadata = { title: t.meta.newTitle }

export default async function NewMcpPage() {
  const { user } = await requireUser()
  const actor = { id: user.id, email: user.email, role: user.role }
  const [connections, channels, driveSources, driveInfo] = await Promise.all([
    listSelectableConnections(actor),
    listChannelsForMcpScope(actor),
    listDriveSourcesForMcpScope(actor, { id: actor.id, role: actor.role }),
    getDriveSystemInfo(),
  ])
  return (
    <div className="w-full">
      <PageHeader
        title={t.wizard.title}
        description={t.wizard.description}
        backHref="/mcp-servers"
      />
      <McpWizard
        connections={connections}
        channels={channels}
        driveSources={driveSources}
        drivePublicAvailable={driveInfo.hasApiKey}
        createAction={createMcpAction}
        twoFactorEnabled={user.twoFactorEnabled}
      />
    </div>
  )
}
