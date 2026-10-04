import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { safeNextPath } from "@/lib/schemas/auth"
import { getSession } from "@/server/auth/session"
import { countUsers } from "@/server/services/users"

import { AuthCard } from "../auth-card"
import { LoginForm } from "./login-form"

export const metadata: Metadata = { title: tAuth.login.metaTitle }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const sp = await searchParams
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : null)
  if (await getSession()) redirect(next ?? "/")
  // First run: no account exists yet → guide to /setup.
  if ((await countUsers()) === 0) redirect("/setup")
  return (
    <AuthCard title={tAuth.login.title} description={tAuth.login.description}>
      <LoginForm next={next} />
    </AuthCard>
  )
}
