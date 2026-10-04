import { Idea01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { connections as m } from "@/lib/i18n/vi/connections"
import { visibleStatusHint } from "@/lib/schemas/connections"

/**
 * The concrete next step (`statusHint`) shown under a connection's `statusMessage`: muted, with a light-bulb icon.
 * Renders nothing when there is no hint, or when the message already says the same thing (some adapters embed
 * "Hãy tạo key mới…" in the message) - see `visibleStatusHint`.
 */
export function StatusHint({
  message,
  hint,
  className,
  clamp,
}: {
  message?: string | null
  hint?: string | null
  className?: string
  /** limit to N lines (compact rows / cards); the full text stays in the accessible name */
  clamp?: 1 | 2 | 3
}) {
  const text = visibleStatusHint(message, hint)
  if (!text) return null
  return (
    // a <span> (display:flex) so it is valid inside a link / paragraph as well as in a block
    <span
      className={cn(
        "flex items-start gap-1.5 text-[13px] leading-snug text-muted-foreground",
        className
      )}
    >
      <HugeiconsIcon
        icon={Idea01Icon}
        strokeWidth={2}
        className="mt-px size-3.5 shrink-0"
        aria-hidden
      />
      <span
        className={cn(
          "min-w-0 break-words",
          clamp === 1 && "line-clamp-1",
          clamp === 2 && "line-clamp-2",
          clamp === 3 && "line-clamp-3"
        )}
      >
        <span className="sr-only">{m.statusHintLabel} </span>
        {text}
      </span>
    </span>
  )
}
