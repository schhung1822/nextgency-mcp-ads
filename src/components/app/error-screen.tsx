"use client"

import * as React from "react"
import Link from "next/link"
import {
  Alert02Icon,
  Home01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

import { StatusScreen } from "./status-screen"

export interface ErrorScreenProps {
  error: Error & { digest?: string }
  retry: () => void
  inline?: boolean
}

/**
 * Body of error.tsx / global-error.tsx. Never shows error.message (server errors are already replaced by
 * a generic message + digest in production; client errors may contain internals) - only the digest,
 * which matches the server log entry.
 */
export function ErrorScreen({ error, retry, inline }: ErrorScreenProps) {
  const s = common.errorPage
  React.useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <StatusScreen
      inline={inline}
      icon={Alert02Icon}
      title={s.title}
      description={s.description}
      detail={error.digest ? s.digest(error.digest) : undefined}
      actions={
        <>
          <Button variant="outline" asChild>
            <Link href="/">
              <HugeiconsIcon
                icon={Home01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {s.home}
            </Link>
          </Button>
          <Button variant="brand" onClick={() => retry()}>
            <HugeiconsIcon
              icon={RefreshIcon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
            {s.retry}
          </Button>
        </>
      }
    />
  )
}
