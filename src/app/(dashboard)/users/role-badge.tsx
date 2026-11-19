import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { users as tUsers } from "@/lib/i18n/vi/users"

import type { Role } from "./types"

/** Soft pill: brand tint for admins, neutral for staff (same look family as StatusBadge, without the dot). */
export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <Badge
      className={cn(
        "rounded-full font-medium ring-1 ring-inset",
        role === "admin"
          ? "bg-brand-primary/10 text-brand-ink ring-brand-primary/25"
          : "bg-muted text-muted-foreground ring-foreground/10",
        className
      )}
    >
      {tUsers.roles[role]}
    </Badge>
  )
}
