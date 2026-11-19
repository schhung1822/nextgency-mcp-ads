import Image from "next/image"
import { cn } from "cn"

import { common } from "@/lib/i18n/vi/common"

/** Intrinsic size of the shipped artwork (public/brand/logo-*.png: logo/nextgency-*.png resized to 960x158). */
const LOGO_RATIO = 960 / 158

export interface BrandLogoProps {
  /** rendered height in px (width follows the artwork ratio, about 6.08:1). Default 28. */
  height?: number
  className?: string
  priority?: boolean
}

/**
 * Full Nextgency logo. Two artworks swap by theme with pure CSS (`dark:` follows next-themes' `.dark` class), so
 * nothing flashes on load: "duong ban" (dark text) on light, "am ban" (white text) on dark. The files are 960px
 * wide, i.e. at least 3x for every size used in the app, so they stay sharp on 2x/3x screens.
 */
export function BrandLogo({
  height = 28,
  className,
  priority,
}: BrandLogoProps) {
  const width = Math.round(height * LOGO_RATIO)
  return (
    <span
      data-slot="brand-logo"
      className={cn("inline-flex shrink-0", className)}
      style={{ height, width }}
    >
      <Image
        src="/brand/logo-duong-ban.png"
        alt={common.brand.logoAlt}
        width={width}
        height={height}
        priority={priority}
        className="h-full w-full dark:hidden"
      />
      <Image
        src="/brand/logo-am-ban.png"
        alt={common.brand.logoAlt}
        width={width}
        height={height}
        priority={priority}
        className="hidden h-full w-full dark:block"
      />
    </span>
  )
}

export interface BrandMarkProps {
  /** square size in px. Default 32. */
  size?: number
  className?: string
  /** decorative by default (alt=""); pass a label when the mark stands alone */
  label?: string
  priority?: boolean
}

/** Compact square ">|" symbol mark (white on black) (favicon artwork; served from the 192px copy since images are unoptimized). */
export function BrandMark({
  size = 32,
  className,
  label,
  priority,
}: BrandMarkProps) {
  return (
    <Image
      src={size > 96 ? "/brand/favicon.png" : "/brand/icon-192.png"}
      alt={label ?? ""}
      width={size}
      height={size}
      priority={priority}
      className={cn("shrink-0 rounded-[22%]", className)}
    />
  )
}

export interface BrandWordmarkProps {
  withByline?: boolean
  /** red→orange gradient text - only for large display sizes (≥ 24px) to keep contrast */
  gradient?: boolean
  className?: string
}

/** "Ads MCP" wordmark + optional "by Nextgency" byline. */
export function BrandWordmark({
  withByline = true,
  gradient,
  className,
}: BrandWordmarkProps) {
  return (
    <span className={cn("grid leading-tight", className)}>
      <span
        className={cn(
          "truncate font-semibold tracking-tight",
          gradient &&
            "bg-linear-135 from-brand-primary to-brand-accent bg-clip-text text-transparent"
        )}
      >
        {common.appName}
      </span>
      {withByline && (
        <span className="truncate text-xs text-muted-foreground">
          {common.brand.byline}
        </span>
      )}
    </span>
  )
}
