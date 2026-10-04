import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { beginTwoFactorSetupAction } from "@/server/actions/account"
import { signOutAction } from "@/server/actions/auth"
import { readTwoFactorPolicy, twoFactorRequiredFor } from "@/server/auth/two-factor-policy"
import { requireUser, ROUTES } from "@/server/auth/session"

import { AuthCard } from "../../auth-card"
import { EnableTwoFactorFlow } from "./enable-two-factor-flow"

export const metadata: Metadata = { title: tAuth.enable2fa.metaTitle }

/** Forced only when the 2FA policy requires it for this role (Cài đặt); otherwise optional. */
export default async function EnableTwoFactorPage() {
  const { user } = await requireUser({ allowPendingSetup: true })
  if (user.mustChangePassword) redirect(ROUTES.changePassword)
  if (user.twoFactorEnabled) redirect("/account")
  const policy = await readTwoFactorPolicy()
  const requiredAll = user.role !== "admin" && policy.all
  const forced = twoFactorRequiredFor(user.role, policy)
  const t = tAuth.enable2fa
  return (
    <AuthCard
      wide
      title={t.title}
      description={user.role === "admin" && forced ? t.descriptionForced : requiredAll ? t.descriptionForcedAll : t.description}
    >
      <EnableTwoFactorFlow
        email={user.email}
        doneHref={forced ? "/" : "/account"}
        begin={beginTwoFactorSetupAction}
      />
      <div className="mt-6 flex justify-center">
        {forced ? (
          <form action={signOutAction}>
            <Button type="submit" variant="link" className="h-10 text-muted-foreground">
              {common.user.signOut}
            </Button>
          </form>
        ) : (
          <Button asChild variant="link" className="h-10 text-muted-foreground">
            <Link href="/account">{t.backToAccount}</Link>
          </Button>
        )}
      </div>
    </AuthCard>
  )
}
