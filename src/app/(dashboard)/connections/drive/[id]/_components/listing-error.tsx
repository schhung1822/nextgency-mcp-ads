"use client"

// Error state of the live listing (folder grid / sheet preview): the Google message, a note that the header badge
// is the LAST check, and ONE action - "Kiểm tra lại" for managers (re-checks the source, which also reloads the
// listing) or "Tải lại" for viewers (reloads the listing only).
import type * as React from "react"
import { Alert02Icon, Refresh01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { driveUi } from "@/lib/i18n/vi/drive-ui"

export interface ListingErrorOptions {
  /** "the badge above is from the last check …" */
  note?: React.ReactNode
  /** managers: re-check the source; null/undefined = reload the listing ("Tải lại") */
  action?: {
    label: string
    busyLabel: string
    busy: boolean
    run: () => void
  } | null
  /** role-aware rewrite of the message (staff + system credential) */
  formatError?: (message: string) => string
}

export function ListingErrorAlert({
  title,
  message,
  options,
  onReload,
}: {
  title: string
  message: string
  options?: ListingErrorOptions
  onReload: () => void
}) {
  const action = options?.action
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{options?.formatError ? options.formatError(message) : message}</span>
        {options?.note && (
          <span className="text-muted-foreground">{options.note}</span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-10"
          onClick={action ? action.run : onReload}
          disabled={action?.busy}
        >
          {action?.busy ? (
            <Spinner aria-hidden />
          ) : (
            <HugeiconsIcon
              icon={Refresh01Icon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
          )}
          {action
            ? action.busy
              ? action.busyLabel
              : action.label
            : driveUi.detail.reload}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
