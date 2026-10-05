import type { Metadata } from "next"

import { PageGuide, PageHeader } from "@/components/app"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { account as tAccount } from "@/lib/i18n/vi/account"
import {
  changePasswordAction,
  disableTwoFactorAction,
  regenerateBackupCodesAction,
  revokeMySessionAction,
  revokeOtherSessionsAction,
  updateProfileAction,
} from "@/server/actions/account"
import { readTwoFactorPolicy } from "@/server/auth/two-factor-policy"
import { requireUser } from "@/server/auth/session"
import { listMyActivity } from "@/server/services/logs"
import { describeUserAgent, listSessionsOf } from "@/server/services/users"

import { ChangePasswordForm } from "../../(auth)/security/change-password/change-password-form"
import { ActivityCard, type ActivityItem } from "./activity-card"
import { ProfileForm } from "./profile-form"
import { SessionsCard } from "./sessions-card"
import { TwoFactorCard } from "./two-factor-card"

export const metadata: Metadata = { title: tAccount.metaTitle }

export default async function AccountPage() {
  const s = await requireUser()
  const { user } = s
  const [sessions, activityPage, policy] = await Promise.all([
    listSessionsOf(s, user.id),
    listMyActivity({ id: user.id, role: user.role }, { limit: 20 }),
    readTwoFactorPolicy(),
  ])
  const activity: ActivityItem[] = activityPage.rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    action: r.action,
    status: r.status === "failure" ? "failure" : "success",
    ip: r.ip,
    device: r.userAgent ? describeUserAgent(r.userAgent) : null,
  }))

  // Phones: one column in this order (profile → 2FA → password → sessions → activity).
  // ≥ lg: main column (profile, sessions, activity) + side column (2FA, password) - the wrappers are
  // `display: contents` below lg so `order-*` can interleave their cards.
  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.account} />
      <PageHeader title={tAccount.title} description={tAccount.description} />
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3 lg:items-start">
        <div className="contents lg:col-span-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
          <Card className="order-1 lg:order-none">
            <CardHeader>
              <CardTitle>{tAccount.profile.title}</CardTitle>
              <CardDescription>{tAccount.profile.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm
                name={user.name}
                email={user.email}
                role={user.role === "admin" ? "admin" : "staff"}
                action={updateProfileAction}
              />
            </CardContent>
          </Card>
          <div className="order-4 min-w-0 lg:order-none">
            <SessionsCard
              sessions={sessions}
              revokeOne={revokeMySessionAction}
              revokeOthers={revokeOtherSessionsAction}
            />
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <ActivityCard items={activity} />
          </div>
        </div>

        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
          <div className="order-2 min-w-0 lg:order-none">
            <TwoFactorCard
              email={user.email}
              enabled={user.twoFactorEnabled}
              isAdmin={user.role === "admin" && policy.admin}
              requiredForAll={policy.all}
              regenerate={regenerateBackupCodesAction}
              disable={disableTwoFactorAction}
            />
          </div>
          <Card className="order-3 lg:order-none">
            <CardHeader>
              <CardTitle>{tAccount.password.title}</CardTitle>
              <CardDescription>{tAccount.password.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm action={changePasswordAction} idPrefix="account-pw" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
