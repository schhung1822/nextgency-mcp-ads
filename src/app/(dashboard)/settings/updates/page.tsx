import type { Metadata } from "next"

import { updates as t } from "@/lib/i18n/vi/updates"
import { requireAdmin } from "@/server/auth/session"
import { getUpdateStatus } from "@/server/services/updates"

import { UpdatesView } from "./_components/updates-view"

export const metadata: Metadata = { title: t.title }

/**
 * Admin only. The settings layout already answers 404 for staff (outside the loading boundary); the page and the
 * actions / API re-check the role - layouts are not a security boundary.
 */
export default async function UpdatesPage() {
  const { user } = await requireAdmin()
  const status = await getUpdateStatus(user)
  return (
    <div className="flex w-full flex-col">
      <UpdatesView initial={status} twoFactorEnabled={user.twoFactorEnabled} />
    </div>
  )
}
