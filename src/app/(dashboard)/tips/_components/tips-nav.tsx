"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  AnalyticsUpIcon,
  Layers01Icon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { tips as t } from "@/lib/i18n/vi/tips"
import { TIP_SLUGS, tipHref, type TipSlug } from "@/lib/tips-routes"

const ICONS: Record<TipSlug, typeof TimeScheduleIcon> = {
  automation: TimeScheduleIcon,
  "bulk-ads": Layers01Icon,
  "ad-check": AnalyticsUpIcon,
}

/**
 * Sub-menu between the tips (links, not ARIA tabs: each tip is its own page). Segmented control like the legal
 * pages; wider than the column (phones, narrow desktop with the guide panel) → scrolls sideways inside its own box,
 * the active item scrolled into view.
 */
export function TipsNav() {
  const pathname = usePathname()
  const scroller = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const box = scroller.current
    const active = box?.querySelector<HTMLElement>("[aria-current=page]")
    if (!box || !active) return
    // horizontal only: never scroll the page itself
    const left = active.offsetLeft - (box.clientWidth - active.offsetWidth) / 2
    box.scrollLeft = Math.max(0, left)
  }, [pathname])

  return (
    <nav aria-label={t.navLabel} className="pb-4 sm:pb-6">
      <div
        ref={scroller}
        className="[scrollbar-width:none] overflow-x-auto rounded-2xl bg-muted/60 [&::-webkit-scrollbar]:hidden"
      >
        <ul className="flex w-full gap-1 p-1 sm:min-w-max">
          {TIP_SLUGS.map((slug) => {
            const href = tipHref(slug)
            const active =
              pathname === href || !!pathname?.startsWith(`${href}/`)
            return (
              <li key={slug} className="min-w-0 flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-11 items-center justify-center gap-2 rounded-xl px-2 text-center text-[12px] leading-4 font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:h-10 sm:px-3.5 sm:text-[13px] sm:whitespace-nowrap",
                    active
                      ? "bg-card text-brand-ink shadow-xs ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:bg-card/50 hover:text-foreground"
                  )}
                >
                  <HugeiconsIcon
                    icon={ICONS[slug]}
                    strokeWidth={2}
                    className="size-4 shrink-0 max-sm:hidden"
                    aria-hidden
                  />
                  {/* phones: short label (may wrap to 2 lines) so the three tips fit 360px without scrolling */}
                  <span className="sm:hidden">{t.pages[slug].short}</span>
                  <span className="max-sm:hidden">{t.pages[slug].label}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
