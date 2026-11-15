import { redirect } from "next/navigation"

import { requireUser } from "@/server/auth/session"

/** /connections/tiktok-social (breadcrumb link) → the "TikTok Social" view of the connections list. */
export default async function TiktokSocialIndexPage() {
  await requireUser()
  redirect("/connections?tab=tiktok-social")
}
