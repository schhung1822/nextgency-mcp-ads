"use client"

// Running version + "a newer release exists" flag for the user menus (desktop dropdown, phone Menu sheet).
// Provided once by the dashboard layout (server): it reads one small DB row, never calls GitHub. Admins only get
// `latestVersion`; staff only ever see the number.
import * as React from "react"
import Link from "next/link"
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
