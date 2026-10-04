"use client" // Error boundaries must be Client Components

import { ErrorScreen } from "@/components/app/error-screen"

/** Errors below the root layout that no nested error.tsx handled (e.g. in the dashboard layout). */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return <ErrorScreen error={error} retry={retry} />
}
