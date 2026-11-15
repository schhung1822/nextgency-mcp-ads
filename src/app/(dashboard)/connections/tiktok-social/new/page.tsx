import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { DisclaimerGate } from "@/components/app/disclaimer-gate"
import { tiktokSocialVi as t } from "@/lib/i18n/vi/tiktok-social"
import { acceptDisclaimerAction } from "@/server/actions/legal"
import { requireUser } from "@/server/auth/session"
import { hasAcceptedDisclaimer } from "@/server/services/disclaimers"
import { getTiktokSocialAccount } from "@/server/services/tiktok-social-accounts"

import { TiktokSocialConnectCard } from "./_components/connect-card"

export const metadata: Metadata = { title: t.connectButton }

export default async function NewTiktokSocialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user } = await requireUser()
  const sp = await searchParams
  const reconnectId = typeof sp.reconnect === "string" ? sp.reconnect : undefined
  // reconnect: only a row the user may manage (else plain "connect a new account")
  const target = reconnectId ? await getTiktokSocialAccount(user, reconnectId) : null
  const accepted = await hasAcceptedDisclaimer(user.id, "connection")
  return (
    <div className="flex w-full flex-col">
      <PageHeader
        title={target ? `${t.reconnect}: @${target.username}` : t.connectButton}
        description={t.pageDescription}
        backHref="/connections?tab=tiktok-social"
      />
      <DisclaimerGate kind="connection" cancelHref="/connections?tab=tiktok-social" accept={acceptDisclaimerAction} alreadyAccepted={accepted}>
        <TiktokSocialConnectCard reconnectId={target?.canManage ? target.id : undefined} reconnectUsername={target?.username} />
      </DisclaimerGate>
    </div>
  )
}
