"use client"

// Running version + "a newer release exists" flag for the user menus (desktop dropdown, phone Menu sheet).
// Provided once by the dashboard layout (server): it reads one small DB row, never calls GitHub. Admins only get
// `latestVersion`; staff only ever see the number.
import * as React from "react"
import Link from "next/link"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { updates as t } from "@/lib/i18n/vi/updates"
import type { VersionBadge } from "@/lib/update-types"
import { displayVersion } from "@/lib/version"

const AppVersionContext = React.createContext<VersionBadge | null>(null)

export function AppVersionProvider({ value, children }: { value: VersionBadge; children: React.ReactNode }) {
  return <AppVersionContext.Provider value={value}>{children}</AppVersionContext.Provider>
}

/** null when no provider is mounted (e.g. isolated component demos). */
export function useAppVersion(): VersionBadge | null {
  return React.useContext(AppVersionContext)
}

export const UPDATES_HREF = "/settings/updates"

/** Small red dot (with a screen-reader label) shown on the avatar / Menu tab when an admin has an update waiting. */
export function UpdateDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("pointer-events-none absolute size-2.5 rounded-full bg-brand-red ring-2", className)}
      data-slot="update-dot"
    >
      <span className="sr-only">{t.menu.dotLabel}</span>
    </span>
  )
}

/** True when the signed-in admin has a newer release to install. */
export function useHasUpdate(): boolean {
  return !!useAppVersion()?.latestVersion
}

/** "Phiên bản v1.2.0" line (every user). */
export function VersionLine({ className }: { className?: string }) {
  const v = useAppVersion()
  if (!v) return null
  return (
    <p className={cn("text-xs text-muted-foreground tabular-nums", className)} data-slot="app-version">
      {t.menu.version(displayVersion(v.current))}
    </p>
  )
}

/** "Có bản mới v1.3.0" link to the update page (admins only: `latestVersion` is null for staff). */
export function UpdateLink({ children, ...props }: Omit<React.ComponentProps<typeof Link>, "href">) {
  const v = useAppVersion()
  if (!v?.latestVersion) return null
  // forwards every prop: inside <DropdownMenuItem asChild> Radix injects role / handlers / ref here
  return (
    <Link href={UPDATES_HREF} data-update-link="" {...props}>
      {children}
      {t.menu.newVersion(displayVersion(v.latestVersion))}
    </Link>
  )
}

/**
 * Sidebar footer block above the user button: running version for everyone; admins also see the latest release
 * known from GitHub and the whole block links to the update page. Hidden on the collapsed icon rail.
 */
export function SidebarVersion({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  const v = useAppVersion()
  if (!v) return null
  const current = displayVersion(v.current)
  const latest = isAdmin && v.latestKnown ? displayVersion(v.latestKnown) : null
  const hasUpdate = isAdmin && !!v.latestVersion
  const upToDate = isAdmin && !hasUpdate && !!v.latestKnown && v.latestKnown === v.current

  const body = (
    <>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground/70">{t.menu.sidebarLabel}</span>
        {hasUpdate && (
          <span className="shrink-0 rounded-full bg-brand-red/12 px-2 py-0.5 text-[11px] leading-4 font-semibold text-brand-ink">
            {t.menu.badgeNew}
          </span>
        )}
        {upToDate && (
          <span className="shrink-0 rounded-full bg-success/12 px-2 py-0.5 text-[11px] leading-4 font-medium text-success-strong">
            {t.menu.badgeUpToDate}
          </span>
        )}
        {isAdmin && (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-sidebar-foreground/50 transition-transform group-hover/version:translate-x-0.5"
            aria-hidden
          />
        )}
      </span>
      <span className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs tabular-nums">
        <span className="text-sidebar-foreground/60">{t.menu.current}</span>
        <span className="text-right font-medium">{current}</span>
        {isAdmin && (
          <>
            <span className="text-sidebar-foreground/60">{t.menu.latest}</span>
            <span className={cn("text-right", hasUpdate ? "font-semibold text-brand-ink" : "font-medium", !latest && "font-normal text-sidebar-foreground/60")}>
              {latest ?? t.menu.notChecked}
            </span>
          </>
        )}
      </span>
    </>
  )

  const base = cn(
    "flex flex-col gap-1.5 rounded-xl border border-sidebar-border/70 px-3 py-2.5 group-data-[collapsible=icon]:hidden",
    className
  )
  if (!isAdmin) {
    return (
      <div className={base} data-slot="sidebar-version">
        {body}
      </div>
    )
  }
  return (
    <Link
      href={UPDATES_HREF}
      data-slot="sidebar-version"
      aria-label={t.menu.openDetails(current, latest)}
      className={cn(
        base,
        "group/version outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        hasUpdate && "border-brand-red/30 bg-brand-red/5"
      )}
    >
      {body}
    </Link>
  )
}
