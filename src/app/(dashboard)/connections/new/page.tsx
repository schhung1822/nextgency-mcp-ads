import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { DisclaimerGate } from "@/components/app/disclaimer-gate"
import { connections as m } from "@/lib/i18n/vi/connections"
import { platformSchema } from "@/lib/schemas/connections"
import { acceptDisclaimerAction } from "@/server/actions/legal"
import { requireUser } from "@/server/auth/session"
import { getPlatformFormSpecs } from "@/server/services/connections"
import { hasAcceptedDisclaimer } from "@/server/services/disclaimers"

import { NewConnectionWizard } from "./_components/new-connection-wizard"

export const metadata: Metadata = { title: m.new.metaTitle }

export default async function NewConnectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireUser()
  const sp = await searchParams
  // ?platform=youtube (links from the former "YouTube Ads" card) = the Google Ads form (YouTube ads live in Google Ads)
  const youtube = sp.platform === "youtube"
  // TikTok advertiser authorization redirects here with ?auth_code=…: open the TikTok "Đổi auth_code" form. Only
  // the flag goes to the client component; it reads the one-time code from the address bar and removes it.
  const authCodeRedirect = typeof sp.auth_code === "string" && sp.auth_code.length > 0
  // "Miễn trừ trách nhiệm" is shown once per user and version (also covers the return from TikTok with ?auth_code)
  const accepted = await hasAcceptedDisclaimer(session.user.id, "connection")
  const initial = platformSchema.safeParse(
    youtube ? "google_ads" : authCodeRedirect && !sp.platform ? "tiktok" : sp.platform
  )
  return (
    <div className="flex w-full flex-col">
      <PageHeader title={m.new.title} description={m.new.description} backHref="/connections" />
      {/* "Miễn trừ trách nhiệm" popup first (until accepted); the Telegram / Google Drive cards continue the same flow */}
      <DisclaimerGate
        kind="connection"
        cancelHref="/connections"
        accept={acceptDisclaimerAction}
        handoffTo={["/connections/telegram/new", "/connections/drive/new"]}
        alreadyAccepted={accepted}
      >
        <NewConnectionWizard specs={getPlatformFormSpecs()} initialPlatform={initial.success ? initial.data : null} authCodeRedirect={authCodeRedirect} />
      </DisclaimerGate>
    </div>
  )
}
