import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { driveSourceIdSchema } from "@/lib/schemas/drive"
import { requireUser } from "@/server/auth/session"
import { DriveServiceError, getDriveSource } from "@/server/services/drive-sources"

import { DriveSourceDetailView } from "./_components/drive-source-detail"

export const metadata: Metadata = { title: driveUi.detail.metaTitle }

export default async function DriveSourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user } = await requireUser()
  const [{ id }, sp] = await Promise.all([params, searchParams])
  if (!driveSourceIdSchema.safeParse({ sourceId: id }).success) notFound()

  // the service checks visibility (staff: company + own; another staff member's source reads as "not found")
  // and never returns a key / resource key
  let detail
  try {
    detail = await getDriveSource(user, id)
  } catch (e) {
    if (e instanceof DriveServiceError) notFound()
    throw e
  }

  return (
    <div className="flex w-full flex-col">
      <DriveSourceDetailView
        detail={detail}
        isAdmin={user.role === "admin"}
        justCreated={sp.created === "1"}
      />
    </div>
  )
}
