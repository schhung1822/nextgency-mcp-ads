import type { Metadata } from "next"
import Link from "next/link"
import { Add01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PageGuide, PageHeader } from "@/components/app"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { Button } from "@/components/ui/button"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import { requireUser } from "@/server/auth/session"
import { listMcpServers } from "@/server/services/mcp-servers"

import { McpList } from "./_components/mcp-list"

export const metadata: Metadata = { title: t.meta.listTitle }

export default async function McpServersPage() {
  const { user } = await requireUser()
  const items = await listMcpServers({
    id: user.id,
    email: user.email,
    role: user.role,
  })
  return (
    <div className="w-full">
      <PageGuide guide={tg.mcpList} />
      <PageHeader
        title={t.list.title}
        description={t.list.description}
        // empty list: the empty state carries the one brand button instead
        primaryAction={
          items.length > 0 ? (
            <Button variant="brand" asChild>
              <Link href="/mcp-servers/new">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                {t.list.create}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <McpList items={items} isAdmin={user.role === "admin"} />
    </div>
  )
}
