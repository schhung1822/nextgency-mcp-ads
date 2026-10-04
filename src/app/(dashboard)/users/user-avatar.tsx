import { cn } from "cn"

import { initials } from "@/components/app"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

/** Rounded-square initials avatar: brand gradient for admins, neutral for staff. Decorative (the name sits next to it). */
export function UserAvatar({
  name,
  email,
  admin,
  className,
}: {
  name: string
  email: string
  admin?: boolean
  className?: string
}) {
  return (
    <Avatar aria-hidden className={cn("size-9 rounded-xl after:rounded-xl", className)}>
      <AvatarFallback
        className={cn(
          "rounded-xl text-xs font-semibold",
          admin ? "bg-linear-135 from-primary-from to-primary-to text-white" : "bg-muted text-foreground/70"
        )}
      >
        {initials(name || email)}
      </AvatarFallback>
    </Avatar>
  )
}
