import { BookOpen01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { common } from "@/lib/i18n/vi/common"
import type { ConnectionGuide, Platform } from "./types"

import { GuideBody } from "./guide-body"
import { PlatformIcon } from "./platform-icon"

export interface HelpPanelProps {
  guide: ConnectionGuide
  /** e.g. "Cách lấy token Meta" (default "Hướng dẫn") */
  title?: string
  platform?: Platform
  className?: string
}

/**
 * Inline "how to" card rendered from a ConnectionGuide. In the app, page guides live in the right-hand
 * Guide panel (`<PageGuide>`); this card is for places that need the same content inline (component gallery).
 */
export function HelpPanel({
  guide,
  title = common.helpPanel.title,
  platform,
  className,
}: HelpPanelProps) {
  const { summary, ...rest } = guide
  return (
    <Card
      className={cn("gap-4", className)}
      aria-label={title}
      role="complementary"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <span className="flex size-7 items-center justify-center rounded-lg bg-brand-red/10 text-brand-ink">
            {platform ? (
              <PlatformIcon platform={platform} className="size-4" />
            ) : (
              <HugeiconsIcon
                icon={BookOpen01Icon}
                strokeWidth={2}
                className="size-4"
                aria-hidden
              />
            )}
          </span>
          {title}
        </CardTitle>
        {summary && <CardDescription>{summary}</CardDescription>}
      </CardHeader>
      <CardContent>
        <GuideBody content={rest} />
      </CardContent>
    </Card>
  )
}
