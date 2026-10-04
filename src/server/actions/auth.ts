"use server"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { getAuth } from "@/server/auth/auth"
import { getSession, ROUTES } from "@/server/auth/session"

export async function signOutAction(): Promise<void> {
  const s = await getSession()
  const h = await headers()
  await getAuth().api.signOut({ headers: h })
  if (s) await logActivity({ actor: actorOf(s.user), action: "auth.logout" }).catch(() => {})
  redirect(ROUTES.login)
}
