import * as React from "react"
import Link from "next/link"
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

import type { Crumb } from "./nav"
import {
  PageHeaderMoreActions,
  type PageHeaderAction,
} from "./page-header-actions"

export type { PageHeaderAction }

export interface PageHeaderProps {
  title: string
  /** one sentence explaining the page */
  description?: React.ReactNode
  /** exactly ONE `<Button variant="brand">` (Shopify-style primary action, top right) */
  primaryAction?: React.ReactNode
  /** secondary actions rendered inside the "Thêm" dropdown */
  secondaryActions?: PageHeaderAction[]
  /** extra inline content next to the actions (e.g. a status badge or outline button) */
  actionsExtra?: React.ReactNode
  /** shows a back button before the title */
  backHref?: string
  backLabel?: string
  breadcrumbs?: Crumb[]
  /** badges etc. rendered next to the title */
  titleMeta?: React.ReactNode
  className?: string
}

/** Page title block: breadcrumbs/back · title + description · primary `brand` action + "Thêm" menu. */
export function PageHeader({
  title,
  description,
  primaryAction,
  secondaryActions,
  actionsExtra,
  backHref,
  backLabel = common.pageHeader.back,
  breadcrumbs,
  titleMeta,
  className,
}: PageHeaderProps) {
  const hasActions =
    !!primaryAction ||
    !!actionsExtra ||
    (secondaryActions && secondaryActions.length > 0)
  return (
    <header
      data-slot="page-header"
      className={cn("flex flex-col gap-3 pb-6", className)}
    >
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb aria-label={common.nav.breadcrumb}>
          <BreadcrumbList>
            {breadcrumbs.map((c, i) => (
              <React.Fragment key={`${c.label}-${i}`}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {c.href ? (
                    <BreadcrumbLink asChild>
                      <Link href={c.href}>{c.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{c.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          {backHref && (
            <Button
              variant="ghost"
              size="icon-sm"
              asChild
              className="mt-0.5 -ml-1 shrink-0"
            >
              <Link href={backHref} aria-label={backLabel}>
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  strokeWidth={2}
                  aria-hidden
                />
              </Link>
            </Button>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl leading-8 font-semibold tracking-tight text-balance">
                {title}
              </h1>
              {titleMeta}
            </div>
            {description && (
              <p className="mt-1 text-sm text-pretty text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        {hasActions && (
          // phones: the action row spans the width and the brand CTA takes a full row in the thumb zone
          // (matched by data-variant so it also works when the button comes from a dialog trigger)
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:[&_[data-variant=brand]]:w-full sm:justify-end">
            {actionsExtra}
            {secondaryActions && secondaryActions.length > 0 && (
              <PageHeaderMoreActions actions={secondaryActions} />
            )}
            {primaryAction}
          </div>
        )}
      </div>
    </header>
  )
}
