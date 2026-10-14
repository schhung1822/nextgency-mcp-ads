import type { Metadata } from "next"

import { PageGuide, PageHeader } from "@/components/app"
import { DisclaimerGate } from "@/components/app/disclaimer-gate"
import { apify as a } from "@/lib/i18n/vi/apify"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { acceptDisclaimerAction } from "@/server/actions/legal"
import { requireUser } from "@/server/auth/session"
import { hasAcceptedDisclaimer } from "@/server/services/disclaimers"

import { ApifyNewForm } from "./_components/apify-new-form"

export const metadata: Metadata = { title: a.form.metaTitle }

export default async function NewApifyTokenPage() {
  const { user } = await requireUser()
  const accepted = await hasAcceptedDisclaimer(user.id, "connection")
  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.apifyNew} />
      <PageHeader
        title={a.form.title}
        description={a.form.description}
        backHref="/connections/new"
      />
      <DisclaimerGate
        kind="connection"
        cancelHref="/connections?tab=apify"
        accept={acceptDisclaimerAction}
        alreadyAccepted={accepted}
      >
        {/* the scope selector is shown to admins only (staff tokens are always personal; the service enforces it) */}
        <ApifyNewForm isAdmin={user.role === "admin"} />
      </DisclaimerGate>
    </div>
  )
}
