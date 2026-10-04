import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { connections as m } from "@/lib/i18n/vi/connections"
import { connectionIdSchema } from "@/lib/schemas/connections"
import { requireUser } from "@/server/auth/session"
import { ConnectionServiceError, getConnection, getPlatformFormSpecs } from "@/server/services/connections"

import { ConnectionDetailView } from "./_components/connection-detail"

export const metadata: Metadata = { title: m.detail.metaTitle }

export default async function ConnectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireUser()
  const { id } = await params
  if (!connectionIdSchema.safeParse({ connectionId: id }).success) notFound()

  let detail
  try {
    detail = await getConnection(user, id)
  } catch (e) {
    if (e instanceof ConnectionServiceError) notFound()
    throw e
  }
  const spec = getPlatformFormSpecs().find((s) => s.platform === detail.platform)
  if (!spec) notFound()

  return (
    <div className="flex w-full flex-col">
      <ConnectionDetailView detail={detail} spec={spec} twoFactorEnabled={user.twoFactorEnabled} />
    </div>
  )
}
