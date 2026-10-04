import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { setupFirstAdminAction } from "@/server/actions/setup"
import { countUsers } from "@/server/services/users"

import { AuthCard } from "../auth-card"
import { SetupForm } from "./setup-form"

export const dynamic = "force-dynamic"

/**
 * The tab title must not reveal that /setup exists once the system is set up: static `metadata` would leak
 * "Thiết lập lần đầu" into the 404 page, so it is resolved per state (404 title when a user already exists).
 */
export async function generateMetadata(): Promise<Metadata> {
  const open = (await countUsers().catch(() => 1)) === 0
  return { title: open ? tAuth.setup.metaTitle : common.notFound.metaTitle }
}

/** First run only: 404 as soon as any user exists (the action re-checks under a lock). */
export default async function SetupPage() {
  if ((await countUsers()) > 0) notFound()
  const configured = !!process.env.SETUP_TOKEN?.trim()
  return (
    <AuthCard title={tAuth.setup.title} description={tAuth.setup.description}>
      {configured ? (
        <SetupForm action={setupFirstAdminAction} />
      ) : (
        <Alert variant="destructive">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertTitle>{tAuth.setup.notConfiguredTitle}</AlertTitle>
          <AlertDescription>{tAuth.setup.notConfiguredDescription}</AlertDescription>
        </Alert>
      )}
    </AuthCard>
  )
}
