import { requireAdmin } from "@/server/auth/session"

/**
 * Admin gate OUTSIDE the segment's loading.tsx Suspense boundary, so staff get a real HTTP 404
 * (inside the boundary the 404 UI would stream with status 200). Not a security boundary on its own:
 * the page and every action re-check the role.
 */
export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin()
  return children
}
