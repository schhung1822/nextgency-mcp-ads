import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { changePasswordAction } from "@/server/actions/account"
import { signOutAction } from "@/server/actions/auth"
import { requireUser } from "@/server/auth/session"

import { AuthCard } from "../../auth-card"
import { ChangePasswordForm } from "./change-password-form"

export const metadata: Metadata = { title: tAuth.changePassword.metaTitle }

/** Forced step after an admin created the account / reset the password (mustChangePassword). */
export default async function ForcedChangePasswordPage() {
  const { user } = await requireUser({ allowPendingSetup: true })
  // Voluntary changes live on /account.
  if (!user.mustChangePassword) redirect("/account")
  return (
    <AuthCard title={tAuth.changePassword.title} description={tAuth.changePassword.descriptionForced}>
      {/* "/" re-runs requireUser(): admins without 2FA continue to /security/enable-2fa. */}
      <ChangePasswordForm action={changePasswordAction} forced doneHref="/" />
      <form action={signOutAction} className="mt-4 flex justify-center">
        <Button type="submit" variant="link" className="h-10 text-muted-foreground">
          {common.user.signOut}
        </Button>
      </form>
    </AuthCard>
  )
}
