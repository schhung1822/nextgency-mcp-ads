import type { Metadata } from "next"
import Link from "next/link"
import { Add01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PageGuide, PageHeader } from "@/components/app"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { Button } from "@/components/ui/button"
import { connections as m } from "@/lib/i18n/vi/connections"
import { requireUser } from "@/server/auth/session"
import { listConnections } from "@/server/services/connections"

import { ConnectionsTable } from "./_components/connections-table"

export const metadata: Metadata = { title: m.list.metaTitle }

export default async function ConnectionsPage() {
  const { user } = await requireUser()
  const items = await listConnections(user)
  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.connections} />
      <PageHeader
        title={m.list.title}
        description={m.list.description}
        // empty list: the empty state carries the one brand button instead
        primaryAction={
          items.length > 0 ? (
            <Button variant="brand" asChild>
              <Link href="/connections/new">
                <HugeiconsIcon
                  icon={Add01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden
                />
                {m.list.add}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <ConnectionsTable items={items} isAdmin={user.role === "admin"} />
    </div>
  )
}
