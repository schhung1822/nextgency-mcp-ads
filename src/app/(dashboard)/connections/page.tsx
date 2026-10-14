import type { Metadata } from "next"

import { connections as m } from "@/lib/i18n/vi/connections"
import { CONNECTION_PLATFORMS } from "@/lib/schemas/connections"
import { requireUser } from "@/server/auth/session"
import { listApifyTokens } from "@/server/services/apify-tokens"
import { listConnections } from "@/server/services/connections"
import {
  getDriveSystemInfo,
  listPersonalDriveCredentials,
} from "@/server/services/drive-credentials"
import { listDriveSources } from "@/server/services/drive-sources"
import { listNotificationChannels } from "@/server/services/notification-channels"

import { ConnectionsTable } from "./_components/connections-table"

export const metadata: Metadata = { title: m.list.metaTitle }

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user } = await requireUser()
  // Drive: only DTOs (system email, hints) - never a key; staff get company + own sources / own service accounts.
  // Apify: DTOs with the 4-char hint only; staff get company tokens (read-only) + own personal tokens.
  const [
    items,
    channels,
    driveSources,
    driveSystem,
    drivePersonal,
    apifyTokens,
    sp,
  ] = await Promise.all([
    listConnections(user),
    listNotificationChannels(user),
    listDriveSources(user),
    getDriveSystemInfo(),
    listPersonalDriveCredentials(user),
    listApifyTokens(user),
    searchParams,
  ])
  // old platform-tab links (?platform=meta, also "meta,tiktok") preselect the "Nền tảng" filter of the ads tab
  const platforms = (typeof sp.platform === "string" ? sp.platform : "")
    .split(",")
    // YouTube ads run through Google Ads (same as /connections/new?platform=youtube)
    .map((p) => (p === "youtube" ? "google_ads" : p))
    .filter((p): p is (typeof CONNECTION_PLATFORMS)[number] =>
      (CONNECTION_PLATFORMS as readonly string[]).includes(p)
    )
  return (
    <div className="flex w-full flex-col">
      {/* the page header + guide are rendered by ConnectionsTable: both follow the selected tab */}
      <ConnectionsTable
        items={items}
        channels={channels}
        driveSources={driveSources}
        driveSystem={driveSystem}
        drivePersonalCredentials={drivePersonal}
        apifyTokens={apifyTokens}
        isAdmin={user.role === "admin"}
        // a plain string: constants exported from a "use client" module are client references here
        initialTab={
          sp.tab === "telegram" || sp.tab === "drive" || sp.tab === "apify"
            ? sp.tab
            : "all"
        }
        initialPlatforms={platforms}
      />
    </div>
  )
}
