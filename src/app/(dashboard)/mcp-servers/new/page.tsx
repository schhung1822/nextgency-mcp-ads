import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import { createMcpAction } from "@/server/actions/mcp-servers"
import { requireUser } from "@/server/auth/session"
import { listSelectableConnections } from "@/server/services/mcp-servers"

import { McpWizard } from "../_components/mcp-wizard"

export const metadata: Metadata = { title: t.meta.newTitle }

export default async function NewMcpPage() {
  const { user } = await requireUser()
  const connections = await listSelectableConnections({
    id: user.id,
    email: user.email,
    role: user.role,
  })
  return (
    <div className="w-full">
      <PageHeader
        title={t.wizard.title}
        description={t.wizard.description}
        backHref="/mcp-servers"
      />
      <McpWizard
        connections={connections}
        createAction={createMcpAction}
        twoFactorEnabled={user.twoFactorEnabled}
      />
    </div>
  )
}
