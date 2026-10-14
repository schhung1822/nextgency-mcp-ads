import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { apify as a } from "@/lib/i18n/vi/apify"
import { apifyTokenIdSchema } from "@/lib/schemas/apify"
import { requireUser } from "@/server/auth/session"
import {
  ApifyServiceError,
  getApifyTokenDetail,
} from "@/server/services/apify-tokens"

import { ApifyTokenDetailView } from "./_components/apify-token-detail"

export const metadata: Metadata = { title: a.detail.metaTitle }

export default async function ApifyTokenDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { user } = await requireUser()
  const { id } = await params
  if (!apifyTokenIdSchema.safeParse({ id }).success) notFound()

  // the service checks visibility (staff: company tokens read-only + own personal ones; another staff member's
  // token = not found) and never returns the token itself - only the 4-char hint
  let detail
  try {
    detail = await getApifyTokenDetail(user, id)
  } catch (e) {
    if (e instanceof ApifyServiceError) notFound()
    throw e
  }

  return (
    <div className="flex w-full flex-col">
      <ApifyTokenDetailView
        detail={detail}
        twoFactorEnabled={user.twoFactorEnabled}
      />
    </div>
  )
}
