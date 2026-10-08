import type { Metadata } from "next"

import { PageGuide, PageHeader } from "@/components/app"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import { requireUser } from "@/server/auth/session"

import { TelegramNewForm } from "./_components/telegram-new-form"

export const metadata: Metadata = { title: m.form.metaTitle }

export default async function NewTelegramChannelPage() {
  const { user } = await requireUser()
  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.telegramNew} />
      <PageHeader
        title={m.form.title}
        description={m.form.description}
        backHref="/connections/new"
      />
      <TelegramNewForm isAdmin={user.role === "admin"} />
    </div>
  )
}
