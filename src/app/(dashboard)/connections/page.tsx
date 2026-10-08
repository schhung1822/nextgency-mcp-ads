import type { Metadata } from "next"

import { connections as m } from "@/lib/i18n/vi/connections"
import { requireUser } from "@/server/auth/session"
import { listConnections } from "@/server/services/connections"
import { listNotificationChannels } from "@/server/services/notification-channels"

import { ConnectionsTable } from "./_components/connections-table"

export const metadata: Metadata = { title: m.list.metaTitle }

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user } = await requireUser()
  const [items, channels, sp] = await Promise.all([
    listConnections(user),
    listNotificationChannels(user),
    searchParams,
  ])
  return (
    <div className="flex w-full flex-col">
      {/* the page header + guide are rendered by ConnectionsTable: both follow the selected tab */}
      <ConnectionsTable
        items={items}
        channels={channels}
        isAdmin={user.role === "admin"}
        // a plain string: constants exported from a "use client" module are client references here
        initialTab={sp.tab === "telegram" ? "telegram" : "all"}
      />
    </div>
  )
}
