"use client" // Error boundaries must be Client Components

import { ErrorScreen } from "@/components/app/error-screen"

/** Errors in dashboard pages: shown inside the shell so navigation stays usable. */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return <ErrorScreen error={error} retry={retry} inline />
}
