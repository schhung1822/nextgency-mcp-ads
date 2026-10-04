import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { connections as m } from "@/lib/i18n/vi/connections"
import { platformSchema } from "@/lib/schemas/connections"
import { requireUser } from "@/server/auth/session"
import { getPlatformFormSpecs } from "@/server/services/connections"

import { NewConnectionWizard } from "./_components/new-connection-wizard"

export const metadata: Metadata = { title: m.new.metaTitle }

export default async function NewConnectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const sp = await searchParams
  const initial = platformSchema.safeParse(sp.platform)
  return (
    <div className="flex w-full flex-col">
      <PageHeader title={m.new.title} description={m.new.description} backHref="/connections" />
      <NewConnectionWizard specs={getPlatformFormSpecs()} initialPlatform={initial.success ? initial.data : null} />
    </div>
  )
}
