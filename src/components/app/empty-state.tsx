import type * as React from "react"
import { InboxIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export interface EmptyStateProps {
  title: string
  description?: React.ReactNode
  /** Hugeicons icon (default: inbox) */
  icon?: IconSvgElement
  /** main call-to-action, usually `<Button variant="brand">` */
  action?: React.ReactNode
  /** secondary link/button under the action */
  secondaryAction?: React.ReactNode
  /** dashed outline (use inside a Card); default false */
  bordered?: boolean
  className?: string
}

/** Empty state: icon, one-sentence explanation and the main action. */
export function EmptyState({
  title,
  description,
  icon = InboxIcon,
  action,
  secondaryAction,
  bordered,
  className,
}: EmptyStateProps) {
  return (
    <Empty
      className={cn(
        "gap-5 p-8 md:p-12",
        bordered && "border border-dashed",
        className
      )}
    >
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className="size-12 rounded-2xl bg-brand-primary/10 text-brand-ink"
        >
          <HugeiconsIcon
            icon={icon}
            strokeWidth={1.75}
            className="size-6"
            aria-hidden
          />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {(action || secondaryAction) && (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {action}
          {secondaryAction}
        </EmptyContent>
      )}
    </Empty>
  )
}
