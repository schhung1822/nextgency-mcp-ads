import type { Metadata } from "next"

import { PageGuide, PageHeader } from "@/components/app"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { users as tUsers } from "@/lib/i18n/vi/users"
import {
  changeUserRoleAction,
  createUserAction,
  deleteUserAction,
  listUserSessionsAction,
  resetUserPasswordAction,
  resetUserTwoFactorAction,
  revokeUserSessionsAction,
  setUserBannedAction,
} from "@/server/actions/users"
import { sessionFreshUntil } from "@/server/auth/reauth"
import { requireAdmin } from "@/server/auth/session"
import { listUsers } from "@/server/services/users"

import { CreateUserDialog } from "./create-user-dialog"
import { UsersTable } from "./users-table"

export const metadata: Metadata = { title: tUsers.metaTitle }

/** Admin only (staff get 404 from requireAdmin). Every action re-checks the role server-side. */
export default async function UsersPage() {
  const s = await requireAdmin()
  const { user } = s
  // freshness only spares the password prompt in the UI; every action re-checks it server-side
  const [users, reauthFreshUntil] = await Promise.all([listUsers(s), sessionFreshUntil(s)])
  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.users} />
      <PageHeader
        title={tUsers.title}
        description={tUsers.description}
        primaryAction={<CreateUserDialog action={createUserAction} actorTwoFactor={user.twoFactorEnabled} />}
      />
      <UsersTable
        users={users}
        currentUserId={user.id}
        actorTwoFactor={user.twoFactorEnabled}
        reauthFreshUntil={reauthFreshUntil}
        actions={{
          create: createUserAction,
          changeRole: changeUserRoleAction,
          resetPassword: resetUserPasswordAction,
          reset2fa: resetUserTwoFactorAction,
          setBanned: setUserBannedAction,
          listSessions: listUserSessionsAction,
          revokeSessions: revokeUserSessionsAction,
          remove: deleteUserAction,
        }}
      />
    </div>
  )
}
