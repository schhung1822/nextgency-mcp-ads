import type * as React from "react"
import Link from "next/link"
import {
  ArrowMoveDownRightIcon,
  ArrowMoveUpRightIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { Skeleton } from "@/components/ui/skeleton"
import { formatPercent } from "@/lib/format"
import { common } from "@/lib/i18n/vi/common"

import { GlassCard } from "./glass-card"
import { KpiSparkline } from "./kpi-sparkline"

export interface KpiDelta {
  /** percentage change, e.g. 12.5 or -3 */
  value: number
  /** extra context, e.g. "so với 7 ngày trước" */
  label?: string
  /** false when an increase is bad (e.g. error rate). Default true. */
  positiveIsGood?: boolean
}

export interface KpiCardProps {
  label: string
  value: React.ReactNode
  /** secondary line under the value, e.g. "2 cảnh báo" */
  hint?: React.ReactNode
  /** tone of the hint text */
  hintTone?: "default" | "warning" | "danger" | "success"
  delta?: KpiDelta
  icon?: IconSvgElement
  /** numbers for a tiny trend chart */
  sparkline?: readonly number[]
  sparklineColor?: string
  /** makes the whole card a link */
  href?: string
  loading?: boolean
  className?: string
}

const HINT_TONE: Record<NonNullable<KpiCardProps["hintTone"]>, string> = {
  default: "text-muted-foreground",
  warning: "text-warning-strong",
  danger: "text-destructive-strong",
  success: "text-success-strong",
}

/** Glass KPI tile for the dashboard: label, big tabular value, hint/delta, optional sparkline. */
export function KpiCard({
  label,
  value,
  hint,
  hintTone = "default",
  delta,
  icon,
  sparkline,
  sparklineColor,
  href,
  loading,
  className,
}: KpiCardProps) {
  const good = delta
    ? delta.value >= 0 === (delta.positiveIsGood ?? true)
    : true
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {icon && (
          <span className="hidden size-8 shrink-0 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-ink sm:flex">
            <HugeiconsIcon
              icon={icon}
              strokeWidth={2}
              className="size-4"
              aria-hidden
            />
          </span>
        )}
      </div>
      {loading ? (
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-32" />
        </div>
      ) : (
        <>
          <p className="mt-1 text-2xl leading-tight font-semibold tracking-tight tabular-nums sm:text-3xl">
            {value}
          </p>
          <div className="mt-1 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[18px]">
            {delta && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium tabular-nums",
                  good ? "text-success-strong" : "text-destructive-strong"
                )}
              >
                <HugeiconsIcon
                  icon={
                    delta.value >= 0
                      ? ArrowMoveUpRightIcon
                      : ArrowMoveDownRightIcon
                  }
                  strokeWidth={2}
                  className="size-3.5"
                  aria-hidden
                />
                <span className="sr-only">
                  {delta.value >= 0 ? common.kpi.increase : common.kpi.decrease}
                </span>
                {formatPercent(Math.abs(delta.value), 1)}
              </span>
            )}
            {delta?.label && (
              <span className="text-muted-foreground">{delta.label}</span>
            )}
            {hint && <span className={HINT_TONE[hintTone]}>{hint}</span>}
          </div>
          {sparkline && sparkline.length > 1 && (
            <KpiSparkline
              data={sparkline}
              color={sparklineColor}
              className="-mx-1 mt-2"
            />
          )}
        </>
      )}
    </>
  )

  if (href) {
    return (
      <GlassCard className={cn("p-0 hover:border-brand-primary/30", className)}>
        <Link
          href={href}
          className="block h-full rounded-2xl p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:p-5"
        >
          {body}
        </Link>
      </GlassCard>
    )
  }
  return <GlassCard className={cn("p-4 sm:p-5", className)}>{body}</GlassCard>
}
