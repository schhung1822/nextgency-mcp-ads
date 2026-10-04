import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { PLATFORM_LABELS } from "@/lib/constants"
import type { Platform } from "./types"

import { PlatformIcon } from "./platform-icon"

export interface PlatformBadgeProps {
  platform: Platform
  /** show only the icon (label stays available to screen readers) */
  iconOnly?: boolean
  /** colour the icon with the platform brand colour (default true) */
  colored?: boolean
  className?: string
}

/** Outline pill: platform mark + name, e.g. "(f) Meta". */
export function PlatformBadge({
  platform,
  iconOnly,
  colored = true,
  className,
}: PlatformBadgeProps) {
  const label = PLATFORM_LABELS[platform]
  return (
    <Badge
      variant="outline"
      title={iconOnly ? label : undefined}
      className={cn(
        "gap-1.5 rounded-full bg-card/60 font-medium",
        iconOnly && "size-6 justify-center p-0",
        className
      )}
    >
      <PlatformIcon platform={platform} colored={colored} />
      {iconOnly ? <span className="sr-only">{label}</span> : label}
    </Badge>
  )
}
