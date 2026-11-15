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
import { listTiktokSocialAccounts } from "@/server/services/tiktok-social-accounts"

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
    tiktokSocialAccounts,
    sp,
  ] = await Promise.all([
    listConnections(user),
    listNotificationChannels(user),
    listDriveSources(user),
    getDriveSystemInfo(),
    listPersonalDriveCredentials(user),
    listApifyTokens(user),
    listTiktokSocialAccounts(user),
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
  // TikTok sign-in callback result (?tab=tiktok-social&status=ok&u= | status=error&reason=): short, validated keys only
  const str = (v: unknown) => (typeof v === "string" ? v : undefined)
  const uname = (v: unknown) => (typeof v === "string" && /^[\w.]{1,64}$/.test(v) ? v : undefined)
  const tiktokSocialCallback =
    sp.tab === "tiktok-social" && (sp.status === "ok" || sp.status === "error")
      ? {
          status: sp.status === "ok" ? ("ok" as const) : ("error" as const),
          username: uname(sp.u),
          reconnected: sp.re === "1",
          reason: str(sp.reason)?.slice(0, 20),
          expected: uname(sp.exp),
          got: uname(sp.got),
        }
      : null
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
        tiktokSocialAccounts={tiktokSocialAccounts}
        tiktokSocialCallback={tiktokSocialCallback}
        isAdmin={user.role === "admin"}
        // a plain string: constants exported from a "use client" module are client references here
        initialTab={
          sp.tab === "telegram" || sp.tab === "drive" || sp.tab === "apify" || sp.tab === "tiktok-social"
            ? sp.tab
            : "all"
        }
        initialPlatforms={platforms}
      />
    </div>
  )
}
