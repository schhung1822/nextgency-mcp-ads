import * as React from "react"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { common } from "@/lib/i18n/vi/common"

export interface StepperStep {
  title: string
  description?: string
}

export interface StepperProps {
  steps: StepperStep[]
  /** 0-based index of the current step; steps before it are complete */
  current: number
  /** makes completed steps clickable (go back). Requires a client component parent. */
  onStepClick?: (index: number) => void
  className?: string
}

/** Horizontal wizard progress: numbered circles + titles, current/complete states. */
export function Stepper({
  steps,
  current,
  onStepClick,
  className,
}: StepperProps) {
  return (
    <nav aria-label={common.stepper.label} className={className}>
      <ol className="flex items-start gap-2 sm:gap-3">
        {steps.map((step, i) => {
          const state =
            i < current ? "complete" : i === current ? "current" : "upcoming"
          const clickable = state === "complete" && !!onStepClick
          const inner = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums ring-1 transition-colors",
                  state === "complete" &&
                    "bg-brand-primary/10 text-brand-ink ring-brand-primary/25",
                  state === "current" &&
                    "bg-linear-135 from-primary-from to-primary-to text-white shadow-[0_6px_16px_-6px_color-mix(in_oklab,var(--brand-primary)_60%,transparent)] ring-transparent",
                  state === "upcoming" &&
                    "bg-card text-muted-foreground ring-border"
                )}
              >
                {state === "complete" ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2.5}
                    className="size-4"
                  />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 text-left",
                  state !== "current" && "hidden md:block"
                )}
              >
                <span className="sr-only">
                  {common.stepper.step(i + 1)}
                  {state === "complete"
                    ? ` (${common.stepper.completed})`
                    : state === "current"
                      ? ` (${common.stepper.current})`
                      : ""}
                  :{" "}
                </span>
                <span
                  className={cn(
                    "block truncate text-sm font-medium",
                    state === "upcoming"
                      ? "text-muted-foreground"
                      : "text-foreground"
                  )}
                >
                  {step.title}
                </span>
                {step.description && (
                  <span className="hidden truncate text-[13px] text-muted-foreground lg:block">
                    {step.description}
                  </span>
                )}
              </span>
            </>
          )
          return (
            <React.Fragment key={`${step.title}-${i}`}>
              {i > 0 && (
                <li
                  aria-hidden
                  className="mt-4 h-px min-w-4 flex-1 rounded-full bg-border"
                >
                  <span
                    className={cn(
                      "block h-full rounded-full bg-linear-90 from-brand-primary to-brand-accent transition-[width]",
                      i <= current ? "w-full" : "w-0"
                    )}
                  />
                </li>
              )}
              <li
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "flex min-w-0 items-start",
                  state === "current" ? "shrink-0" : "shrink"
                )}
              >
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => onStepClick?.(i)}
                    className="flex min-w-0 items-center gap-2 rounded-xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {inner}
                  </button>
                ) : (
                  <div className="flex min-w-0 items-center gap-2">{inner}</div>
                )}
              </li>
            </React.Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
