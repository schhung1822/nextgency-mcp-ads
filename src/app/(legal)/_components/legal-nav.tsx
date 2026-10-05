"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "cn"

import { legal as tl } from "@/lib/i18n/vi/legal"
import { LEGAL_PAGES } from "@/lib/legal"

/** Links between the 3 public legal pages; the current one is marked (aria-current). */
export function LegalNav({ variant = "tabs" }: { variant?: "tabs" | "footer" }) {
  const pathname = usePathname()
  if (variant === "footer") {
    return (
      <nav aria-label={tl.nav.footerLabel}>
        <ul className="flex flex-wrap items-center justify-center gap-x-4 sm:gap-y-2">
          {LEGAL_PAGES.map((pg) => (
            <li key={pg.path}>
              <Link
                href={pg.path}
                aria-current={pathname === pg.path ? "page" : undefined}
                className="inline-flex min-h-11 items-center rounded-sm underline-offset-4 outline-none hover:text-foreground sm:min-h-0 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:font-medium aria-[current=page]:text-foreground"
              >
                {tl.nav[pg.key]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    )
  }
  return (
    <nav aria-label={tl.nav.label}>
      <ul className="flex gap-1 overflow-x-auto rounded-2xl bg-muted/60 p-1 [scrollbar-width:none]">
        {LEGAL_PAGES.map((pg) => {
          const active = pathname === pg.path
          return (
            <li key={pg.path} className="flex-1">
              <Link
                href={pg.path}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center justify-center rounded-xl px-3 text-[13px] font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "bg-card text-brand-ink shadow-xs ring-1 ring-foreground/10"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tl.nav[pg.key]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
