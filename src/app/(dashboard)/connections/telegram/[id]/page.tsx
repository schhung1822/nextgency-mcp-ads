import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import { channelIdSchema } from "@/lib/schemas/notifications"
import { requireUser } from "@/server/auth/session"
import {
  getNotificationChannel,
  listNotificationDeliveries,
  NotificationServiceError,
} from "@/server/services/notification-channels"

import { TelegramChannelDetailView } from "./_components/telegram-channel-detail"

export const metadata: Metadata = { title: m.detail.metaTitle }

export default async function TelegramChannelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user } = await requireUser()
  const [{ id }, sp] = await Promise.all([params, searchParams])
  if (!channelIdSchema.safeParse({ channelId: id }).success) notFound()

  // the service checks ownership (staff: own channels only) and never returns the bot token
  let detail
  let deliveries
  try {
    ;[detail, deliveries] = await Promise.all([
      getNotificationChannel(user, id),
      listNotificationDeliveries(user, id),
    ])
  } catch (e) {
    if (e instanceof NotificationServiceError) notFound()
    throw e
  }

  return (
    <div className="flex w-full flex-col">
      <TelegramChannelDetailView
        detail={detail}
        deliveries={deliveries}
        // admin-only settings are editable only on a channel owned by an admin (the service enforces it too)
        isAdmin={user.role === "admin" && detail.owner.role === "admin"}
        twoFactorEnabled={user.twoFactorEnabled}
        justCreated={sp.created === "1"}
      />
    </div>
  )
}
