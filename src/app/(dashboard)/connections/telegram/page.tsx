import { redirect } from "next/navigation"

import { requireUser } from "@/server/auth/session"

/** /connections/telegram (breadcrumb link) → the "Telegram" view of the connections list. */
export default async function TelegramChannelsIndexPage() {
  await requireUser()
  redirect("/connections?tab=telegram")
}
