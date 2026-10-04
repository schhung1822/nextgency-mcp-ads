"use client"

import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { common } from "@/lib/i18n/vi/common"

export interface ContextualSaveBarProps {
  /** render only when there are unsaved changes */
  open: boolean
  onDiscard: () => void
  /** omit when the Save button submits a form via `formId` */
  onSave?: () => void
  /** id of the <form> the Save button submits */
  formId?: string
  saving?: boolean
  message?: string
  saveLabel?: string
  discardLabel?: string
  className?: string
}

/** Sticky glass bar "Có thay đổi chưa lưu" with Huỷ / Lưu (Shopify contextual save bar). */
export function ContextualSaveBar({
  open,
  onDiscard,
  onSave,
  formId,
  saving,
  message = common.saveBar.unsaved,
  saveLabel = common.saveBar.save,
  discardLabel = common.saveBar.discard,
  className,
}: ContextualSaveBarProps) {
  if (!open) return null
  return (
    <div
      role="region"
      aria-label={message}
      className={cn(
        "glass-strong sticky top-[calc(var(--app-topbar-offset,0px)+0.5rem)] z-30 mb-4 flex animate-in flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-2.5 fade-in-0 slide-in-from-top-2",
        // phones: flush bar stuck right under the top bar (full width, square)
        "max-md:top-(--app-topbar-offset,0px) max-md:-mx-4 max-md:rounded-none max-md:border-x-0",
        className
      )}
    >
      <p
        className="flex items-center gap-2 text-sm font-medium"
        aria-live="polite"
      >
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={2}
          className="size-4 text-warning-strong"
          aria-hidden
        />
        {message}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-10"
          onClick={onDiscard}
          disabled={saving}
        >
          {discardLabel}
        </Button>
        <Button
          variant="brand"
          size="sm"
          className="pointer-coarse:h-10"
          type={formId ? "submit" : "button"}
          form={formId}
          onClick={onSave}
          disabled={saving}
        >
          {saving && <Spinner aria-hidden />}
          {saving ? common.saveBar.saving : saveLabel}
        </Button>
      </div>
    </div>
  )
}
