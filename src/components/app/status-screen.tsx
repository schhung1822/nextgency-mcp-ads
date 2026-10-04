import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { BrandLogo } from "./brand-logo"

export interface StatusScreenProps {
  /** big muted code above the title, e.g. "404" */
  code?: string
  title: string
  description: string
  /** small monospace line under the description (e.g. an error digest) */
  detail?: string
  /** buttons; exactly one should be `variant="brand"` */
  actions: React.ReactNode
  /** inside the dashboard shell (which already owns <main>): no full-screen height, no <main>, no logo */
  inline?: boolean
  /** icon chip shown above the title in the `inline` variant (the standalone variant shows the logo) */
  icon?: IconSvgElement
  className?: string
}

/**
 * Full-screen glass card for not-found / error pages that render outside the dashboard shell.
 * Works in server and client components (no server-only imports).
 */
export function StatusScreen({
  code,
  title,
  description,
  detail,
  actions,
  inline,
  icon,
  className,
}: StatusScreenProps) {
  const Wrapper = inline ? "div" : "main"
  return (
    <Wrapper
      className={cn(
        "flex items-center justify-center px-4 py-10",
        inline ? "min-h-[60svh]" : "min-h-svh",
        className
      )}
    >
      <section
        aria-labelledby="status-screen-title"
        className={cn(
          "flex w-full max-w-md flex-col items-center gap-5 rounded-3xl px-6 py-8 text-center sm:px-10 sm:py-10",
          // standalone page: glass frame; inside the shell: solid card (glass only for chrome)
          inline
            ? "border bg-card text-card-foreground shadow-sm"
            : "glass-strong"
        )}
      >
        {/* standalone: brand logo · inside the shell the sidebar already carries the brand → optional icon only */}
        {inline ? (
          icon && (
            <span
              className="flex size-12 items-center justify-center rounded-2xl bg-brand-red/10 text-brand-ink"
              aria-hidden
            >
              <HugeiconsIcon icon={icon} strokeWidth={1.75} className="size-6" />
            </span>
          )
        ) : (
          <BrandLogo height={30} priority />
        )}
        <div className="flex flex-col items-center gap-2">
          {code && (
            <p
              className="bg-linear-135 from-brand-red to-brand-orange bg-clip-text text-5xl font-semibold tracking-tight text-transparent tabular-nums"
              aria-hidden
            >
              {code}
            </p>
          )}
          <h1
            id="status-screen-title"
            className="text-xl font-semibold tracking-tight text-balance"
          >
            {title}
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            {description}
          </p>
          {detail && (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-center">
          {actions}
        </div>
      </section>
    </Wrapper>
  )
}
