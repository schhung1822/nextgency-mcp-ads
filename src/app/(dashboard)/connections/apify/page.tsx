import { redirect } from "next/navigation"

import { requireUser } from "@/server/auth/session"

/** /connections/apify (breadcrumb link) → the "Apify" view of the connections list. */
export default async function ApifyTokensIndexPage() {
  await requireUser()
  redirect("/connections?tab=apify")
}
