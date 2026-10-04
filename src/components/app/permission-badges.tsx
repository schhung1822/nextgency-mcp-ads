import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { PERMISSION_DESCRIPTIONS, PERMISSION_LABELS } from "@/lib/constants"
import type { Permission } from "./types"

// Canonical order = key order of PERMISSION_LABELS (read, status, update, copy, create, delete).
const PERMISSIONS = Object.keys(PERMISSION_LABELS) as Permission[]

export interface PermissionBadgesProps {
  permissions: readonly Permission[]
  /** show the long description as a native tooltip (title) */
  withDescriptions?: boolean
  className?: string
}

/** Badges for MCP permissions in canonical order; "Xoá/Lưu trữ" is highlighted as dangerous. */
export function PermissionBadges({
  permissions,
  withDescriptions,
  className,
}: PermissionBadgesProps) {
  const set = new Set(permissions)
  const ordered = PERMISSIONS.filter((p) => set.has(p))
  return (
    <ul className={cn("flex flex-wrap gap-1", className)}>
      {ordered.map((p) => (
        <li key={p}>
          <Badge
            variant="outline"
            title={withDescriptions ? PERMISSION_DESCRIPTIONS[p] : undefined}
            className={cn(
              "rounded-full font-medium",
              p === "delete" &&
                "border-destructive/30 bg-destructive/10 text-destructive-strong"
            )}
          >
            {PERMISSION_LABELS[p]}
          </Badge>
        </li>
      ))}
    </ul>
  )
}
