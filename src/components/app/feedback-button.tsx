import { Bug01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { FEEDBACK_FORM_URL } from "@/lib/feedback"
import { common } from "@/lib/i18n/vi/common"

/**
 * Floating "Báo bug, yêu cầu tính năng" link pinned to the bottom-right corner of every dashboard page; opens the
 * Nextgency form in a new tab. Desktop: icon + label pill; phones (< md): round icon above the bottom bar.
 * `--feedback-lift` (globals.css) raises it while a bottom action bar (wizard nav, bulk actions) is on screen.
 */
export function FeedbackButton({ className }: { className?: string }) {
  if (!FEEDBACK_FORM_URL) return null
  return (
    <a
      href={FEEDBACK_FORM_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={common.feedback.aria}
      title={common.feedback.label}
      data-slot="feedback-button"
      className={cn(
        "glass-strong fixed right-4 z-30 flex items-center justify-center gap-2 rounded-full text-sm font-medium text-foreground outline-none",
        "transition-colors hover:text-brand-ink focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "bottom-[calc(var(--app-bottom-offset,0px)+var(--feedback-lift,0px)+0.75rem)] size-12",
        "md:right-6 md:bottom-[calc(var(--feedback-lift,0px)+max(1.25rem,env(safe-area-inset-bottom)))] md:size-auto md:h-11 md:pr-4 md:pl-3.5",
        className
      )}
    >
      <HugeiconsIcon
        icon={Bug01Icon}
        strokeWidth={2}
        className="size-5 shrink-0 text-brand-ink"
        aria-hidden
      />
      <span className="max-md:hidden">{common.feedback.label}</span>
    </a>
  )
}
