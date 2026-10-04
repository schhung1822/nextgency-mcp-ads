import { cookies } from "next/headers"
import { AppShell, AppVersionProvider } from "@/components/app"
import { signOutAction } from "@/server/actions/auth"
import { requireUser } from "@/server/auth/session"
import { getVersionBadge } from "@/server/services/updates"

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser()
  const sidebarState = (await cookies()).get("sidebar_state")?.value
  // running version for everybody; admins also learn whether a newer release is waiting (1 PK query, no GitHub call)
  const version = await getVersionBadge(user.role)
  return (
    <AppVersionProvider value={version}>
      <AppShell
        user={{ id: user.id, name: user.name || user.email, email: user.email, role: user.role, image: user.image ?? undefined }}
        signOutAction={signOutAction}
        defaultSidebarOpen={sidebarState !== "false"}
      >
        {children}
      </AppShell>
    </AppVersionProvider>
  )
}
