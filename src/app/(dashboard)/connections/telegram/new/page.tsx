import type { Metadata } from "next"

import { PageGuide, PageHeader } from "@/components/app"
import { DisclaimerGate } from "@/components/app/disclaimer-gate"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import { acceptDisclaimerAction } from "@/server/actions/legal"
import { requireUser } from "@/server/auth/session"
import { hasAcceptedDisclaimer } from "@/server/services/disclaimers"

import { TelegramNewForm } from "./_components/telegram-new-form"

export const metadata: Metadata = { title: m.form.metaTitle }

export default async function NewTelegramChannelPage() {
  const { user } = await requireUser()
  const accepted = await hasAcceptedDisclaimer(user.id, "connection")
  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.telegramNew} />
      <PageHeader
        title={m.form.title}
        description={m.form.description}
        backHref="/connections/new"
      />
      <DisclaimerGate
        kind="connection"
        cancelHref="/connections?tab=telegram"
        accept={acceptDisclaimerAction}
        alreadyAccepted={accepted}
      >
        <TelegramNewForm isAdmin={user.role === "admin"} />
      </DisclaimerGate>
    </div>
  )
}
