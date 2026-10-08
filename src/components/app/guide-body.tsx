import {
  Alert02Icon,
  ArrowUpRight01Icon,
  BulbIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import type { GuideContent } from "@/lib/guide-types"
import { guides } from "@/lib/i18n/vi/guides"

const ui = guides.ui

function ExternalLink({ label, url }: { label: string; url: string }) {
  if (!/^https?:\/\//i.test(url)) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md font-medium text-brand-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {label}
      <HugeiconsIcon
        icon={ArrowUpRight01Icon}
        strokeWidth={2}
        className="size-3.5"
        aria-hidden
      />
      <span className="sr-only">{ui.newTab}</span>
    </a>
  )
}

/**
 * Body of a guide: lead sentence, numbered steps, tips, warning box, scope chips and links.
 * Used by the docked panel, the mobile sheet and the `HelpPanel` card.
 */
export function GuideBody({
  content,
  className,
}: {
  content: GuideContent
  className?: string
}) {
  const { summary, steps, tips, warnings, requiredScopes, links } = content
  return (
    <div
      data-slot="guide-body"
      className={cn("flex flex-col gap-5 text-sm", className)}
    >
      {summary && (
        <p className="text-pretty text-muted-foreground">{summary}</p>
      )}

      {steps && steps.length > 0 && (
        <ol className="flex flex-col gap-4" aria-label={ui.stepsLabel}>
          {steps.map((step, i) => (
            <li key={`${i}-${step.title}`} className="flex gap-3">
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-red/10 text-xs font-semibold text-brand-ink tabular-nums"
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-pretty">{step.title}</p>
                {step.detail && (
                  <p className="mt-0.5 text-[13px] leading-5 text-pretty break-words whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
                    {step.detail}
                  </p>
                )}
                {step.link && (
                  <div className="mt-1.5 text-[13px]">
                    <ExternalLink {...step.link} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {requiredScopes && requiredScopes.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">{ui.scopes}</p>
          <ul className="flex flex-wrap gap-1.5">
            {requiredScopes.map((s) => (
              <li key={s}>
                <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {s}
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings && warnings.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl bg-warning/12 p-3 ring-1 ring-warning/30 ring-inset">
          <p className="flex items-center gap-1.5 font-medium text-warning-strong">
            <HugeiconsIcon
              icon={Alert02Icon}
              strokeWidth={2}
              className="size-4"
              aria-hidden
            />
            {ui.warnings}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 break-words text-foreground/90 [overflow-wrap:anywhere]">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {tips && tips.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl bg-muted/70 p-3">
          <p className="flex items-center gap-1.5 font-medium">
            <HugeiconsIcon
              icon={BulbIcon}
              strokeWidth={2}
              className="size-4 text-brand-ink"
              aria-hidden
            />
            {ui.tips}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 break-words text-muted-foreground [overflow-wrap:anywhere]">
            {tips.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </div>
      )}

      {links && links.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="font-medium">{ui.links}</p>
          <ul className="flex flex-col gap-1 text-[13px]">
            {links.map((l) => (
              <li key={l.url}>
                <ExternalLink {...l} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
