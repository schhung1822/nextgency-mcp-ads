import type { Metadata } from "next"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { safeNextPath } from "@/lib/schemas/auth"
import { getSession } from "@/server/auth/session"
import { pendingTwoFactorRole } from "@/server/services/users"

import { TwoFactorForm } from "./two-factor-form"

export const metadata: Metadata = { title: tAuth.twoFactor.metaTitle }

export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const sp = await searchParams
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : null)
  if (await getSession()) redirect(next ?? "/")
  const jar = await cookies()
  const challenge = jar.get("__Secure-better-auth.two_factor")?.value ?? jar.get("better-auth.two_factor")?.value
  const role = await pendingTwoFactorRole(challenge)
  // No (or expired) 2FA challenge → start over.
  if (!role) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login")
  return <TwoFactorForm next={next} allowTrustDevice={role !== "admin"} />
}
