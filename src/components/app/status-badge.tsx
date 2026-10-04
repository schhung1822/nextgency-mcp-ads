import { cn } from "cn"

import { Badge } from "@/components/ui/badge"

import {
  getStatusMeta,
  type StatusKind,
  type StatusKindMap,
  type StatusTone,
} from "./status"

export const STATUS_TONE_CLASSES: Record<
  StatusTone,
  { badge: string; dot: string }
> = {
  success: {
    badge: "bg-success/12 text-success-strong ring-success/25",
    dot: "bg-success",
  },
  warning: {
    badge: "bg-warning/15 text-warning-strong ring-warning/30",
    dot: "bg-warning",
  },
  danger: {
    badge: "bg-destructive/10 text-destructive-strong ring-destructive/25",
    dot: "bg-destructive",
  },
  info: { badge: "bg-info/12 text-info-strong ring-info/25", dot: "bg-info" },
  neutral: {
    badge: "bg-muted text-muted-foreground ring-foreground/10",
    dot: "bg-muted-foreground/60",
  },
}

export interface StatusBadgeProps<K extends StatusKind> {
  kind: K
  status: StatusKindMap[K] | (string & {})
  /** override the Vietnamese label */
  label?: string
  /** hide the leading dot */
  hideDot?: boolean
  className?: string
}

/** Coloured status pill with Vietnamese label, e.g. `<StatusBadge kind="connection" status="expiring" />`. */
export function StatusBadge<K extends StatusKind>({
  kind,
  status,
  label,
  hideDot,
  className,
}: StatusBadgeProps<K>) {
  const meta = getStatusMeta(kind, status)
  const tone = STATUS_TONE_CLASSES[meta.tone]
  return (
    <Badge
      data-tone={meta.tone}
      className={cn(
        "rounded-full font-medium ring-1 ring-inset",
        tone.badge,
        className
      )}
    >
      {!hideDot && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", tone.dot)}
        />
      )}
      {label ?? meta.label}
    </Badge>
  )
}
