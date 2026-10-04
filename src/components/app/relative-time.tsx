"use client"

import * as React from "react"
import { cn } from "cn"

import { formatDateTime, formatRelative } from "@/lib/format"

export interface RelativeTimeProps {
  /** Date, ISO string or epoch ms; null/undefined renders "-" */
  value: Date | string | number | null | undefined
  /** re-render interval in ms (default 60s; 0 disables) */
  refreshMs?: number
  className?: string
}

function subscribeClock(refreshMs: number) {
  return (onChange: () => void) => {
    if (!refreshMs) return () => {}
    const id = setInterval(onChange, refreshMs)
    return () => clearInterval(id)
  }
}

/** "5 phút trước" with the absolute time (dd/MM/yyyy HH:mm, Asia/Ho_Chi_Minh) as tooltip + <time dateTime>. */
export function RelativeTime({
  value,
  refreshMs = 60_000,
  className,
}: RelativeTimeProps) {
  const subscribe = React.useMemo(() => subscribeClock(refreshMs), [refreshMs])
  // Snapshot = current minute bucket so the text refreshes without setState-in-effect.
  const tick = React.useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / Math.max(refreshMs, 1000)),
    () => 0
  )
  if (value === null || value === undefined || value === "")
    return <span className={className}>-</span>
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return <span className={className}>-</span>
  return (
    <time
      dateTime={date.toISOString()}
      title={formatDateTime(date)}
      data-tick={tick}
      suppressHydrationWarning
      className={cn("whitespace-nowrap", className)}
    >
      {formatRelative(date)}
    </time>
  )
}
