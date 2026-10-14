import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { formatDate } from "@/lib/format"
import { apify } from "@/lib/i18n/vi/apify"
import type { ApifyAccountPreview } from "@/lib/schemas/apify"

import {
  creditLabel,
  creditRemaining,
  formatUsd,
  planLabel,
} from "./apify-format"

const m = apify.check

export const APIFY_CONSOLE_URL =
  "https://console.apify.com/settings/integrations"

/** External link with the ↗ icon and a screen-reader "(mở tab mới)". */
export function ApifyExternalLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded-md font-medium text-brand-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-9",
        className
      )}
    >
      {children}
      <HugeiconsIcon
        icon={ArrowUpRight01Icon}
        strokeWidth={2}
        className="size-3.5"
        aria-hidden
      />
      <span className="sr-only">{apify.ui.newTab}</span>
    </a>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

/** Result of "Kiểm tra" (GET /users/me + /users/me/limits): account, plan, credit, reset + non-blocking notes. */
export function ApifyCheckSummary({
  preview,
  outdated,
}: {
  preview: ApifyAccountPreview
  /** the user edited the token after this check */
  outdated?: boolean
}) {
  const plan = planLabel(preview.planId)
  const credit = creditLabel(preview)
  const remaining = creditRemaining(preview)
  return (
    // announced by the form's always-mounted live region (a region mounted with its content is often missed)
    <div className="flex flex-col gap-3 rounded-xl border border-success/30 bg-success/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-success-strong">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
          aria-hidden
        />
        {m.okTitle}
      </p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Row label={m.account}>
          <span className="font-medium">
            {preview.username ?? apify.ui.noUsername}
          </span>
          {plan && (
            <span className="block text-[13px] text-muted-foreground">
              {m.plan}: {plan}
            </span>
          )}
        </Row>
        <Row label={m.credit}>
          {credit ? (
            <>
              <span className="font-medium tabular-nums">{credit}</span>
              {remaining !== null && (
                <span className="block text-[13px] text-muted-foreground tabular-nums">
                  {m.remaining}: {formatUsd(remaining)}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">{apify.ui.unknown}</span>
          )}
        </Row>
        <Row label={m.reset}>
          {preview.cycleEndAt ? (
            <span className="tabular-nums">
              {formatDate(preview.cycleEndAt)}
            </span>
          ) : (
            <span className="text-muted-foreground">{apify.ui.unknown}</span>
          )}
        </Row>
      </dl>
      {(!preview.actorsEnabled || preview.sameAccountTokens > 0) && (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {!preview.actorsEnabled && (
            <li className="flex items-start gap-1.5 text-warning-strong">
              <HugeiconsIcon
                icon={Alert02Icon}
                strokeWidth={2}
                className="mt-px size-3.5 shrink-0"
                aria-hidden
              />
              <span>{m.actorsDisabled}</span>
            </li>
          )}
          {preview.sameAccountTokens > 0 && (
            <li className="flex items-start gap-1.5 text-muted-foreground">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="mt-px size-3.5 shrink-0"
                aria-hidden
              />
              <span>{m.sameAccount(preview.sameAccountTokens)}</span>
            </li>
          )}
        </ul>
      )}
      {outdated && (
        <p className="flex items-start gap-1.5 text-[13px] text-warning-strong">
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            className="mt-px size-3.5 shrink-0"
            aria-hidden
          />
          {m.outdated}
        </p>
      )}
    </div>
  )
}

/** Apify refused the token (the message already says how to fix it). */
export function ApifyCheckError({
  title = m.failTitle,
  message,
}: {
  title?: string
  message: string
}) {
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
