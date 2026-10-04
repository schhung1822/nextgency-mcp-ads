import type * as React from "react"
import { cn } from "cn"

export interface GlassCardProps extends React.ComponentProps<"div"> {
  /** more opaque tint (`glass-strong`) - use over busy backgrounds */
  strong?: boolean
}

/**
 * Liquid Glass surface for "chrome" only (KPI cards, completion screens, login card).
 * Dense content (tables, forms, JSON) must use the solid shadcn `Card` instead. Never nest glass.
 */
export function GlassCard({ strong, className, ...props }: GlassCardProps) {
  return (
    <div
      data-slot="glass-card"
      className={cn(
        strong ? "glass-strong" : "glass",
        "rounded-2xl p-5 text-card-foreground",
        className
      )}
      {...props}
    />
  )
}

export function GlassCardHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="glass-card-header"
      className={cn("mb-3 flex flex-col gap-1", className)}
      {...props}
    />
  )
}

export function GlassCardTitle({
  className,
  ...props
}: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="glass-card-title"
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  )
}

export function GlassCardDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="glass-card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}
