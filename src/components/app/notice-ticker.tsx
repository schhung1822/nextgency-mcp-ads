"use client"

import * as React from "react"
import { Megaphone01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { common } from "@/lib/i18n/vi/common"
import type { SystemNotice } from "@/lib/system-notices"

/** Scroll speed of the ticker, in CSS pixels per second (readable, not distracting). */
const SPEED_PX_PER_S = 45
const MIN_DURATION_S = 8

/**
 * System notices as an endless right-to-left ticker (top bar, .claude/docs/13-system-notices.md §3).
 * The track holds two identical copies of the notice sequence, each at least as wide as the viewport; the track
 * slides by exactly one copy -> seamless loop: notices follow each other, a short single notice crosses the bar
 * alone (no wall of repeats), at a constant speed whatever the text length. Pauses on hover/focus; static under prefers-reduced-motion (globals.css).
 * Screen readers get the plain list once (the moving copy is aria-hidden).
 */
export function NoticeTicker({
  notices,
  className,
}: {
  notices: readonly SystemNotice[]
  className?: string
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const sequenceRef = React.useRef<HTMLDivElement>(null)
  const [layout, setLayout] = React.useState({ minWidth: 0, half: 0 })

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const sequence = sequenceRef.current
    if (!viewport || !sequence) return
    const measure = () => {
      const minWidth = viewport.clientWidth
      const half = sequence.offsetWidth
      if (!half) return
      setLayout((prev) =>
        prev.minWidth === minWidth && prev.half === half
          ? prev
          : { minWidth, half }
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(viewport)
    ro.observe(sequence)
    return () => ro.disconnect()
  }, [notices])

  if (!notices.length) return null

  const duration = Math.max(MIN_DURATION_S, layout.half / SPEED_PX_PER_S)
  const sequence = (key: string, ref?: React.Ref<HTMLDivElement>) => (
    <div
      key={key}
      ref={ref}
      className="flex shrink-0 items-center"
      style={{ minWidth: layout.minWidth || undefined }}
    >
      {notices.map((n) => (
        <span key={n.id} className="flex items-center whitespace-nowrap">
          {n.content}
          <span className="mx-5 size-1 shrink-0 rounded-full bg-brand-red/45" />
        </span>
      ))}
    </div>
  )

  return (
    <div
      data-slot="notice-ticker"
      role="region"
      aria-label={common.notices.label}
      title={notices.map((n) => n.content).join("\n")}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-full bg-brand-red/[0.06] pr-1 pl-2.5 ring-1 ring-brand-red/10 dark:bg-brand-red/10 dark:ring-brand-red/15",
        className
      )}
    >
      <HugeiconsIcon
        icon={Megaphone01Icon}
        strokeWidth={2}
        className="size-4 shrink-0 text-brand-red"
        aria-hidden
      />
      <ul className="sr-only">
        {notices.map((n) => (
          <li key={n.id}>{n.content}</li>
        ))}
      </ul>
      <div
        ref={viewportRef}
        aria-hidden
        className="min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)] text-[13px] font-medium text-foreground/80"
      >
        <div
          data-slot="notice-ticker-track"
          className="flex w-max"
          style={
            {
              "--notice-duration": `${duration.toFixed(2)}s`,
            } as React.CSSProperties
          }
        >
          {sequence("a", sequenceRef)}
          {sequence("b")}
        </div>
      </div>
    </div>
  )
}
