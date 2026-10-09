import { redirect } from "next/navigation"

import { requireUser } from "@/server/auth/session"

/** /connections/drive (breadcrumb link) → the "Google Drive" view of the connections list. */
export default async function DriveSourcesIndexPage() {
  await requireUser()
  redirect("/connections?tab=drive")
}
