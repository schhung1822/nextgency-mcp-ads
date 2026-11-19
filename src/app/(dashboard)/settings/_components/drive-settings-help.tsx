"use client"

// Settings → "Google Drive hệ thống": the setup explainer next to the form (what it is for, the service account JSON
// key, the optional API key for public links, what to do after saving) as an accordion. Wide card (container ≥ 56rem):
// right column; narrow card / phones: under the form, so the form stays near the top. Static content only.
import * as React from "react"
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  BookOpen01Icon,
  GoogleDriveIcon,
  InformationCircleIcon,
  Key01Icon,
  Link01Icon,
  SecurityLockIcon,
  Share08Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { Rich } from "@/components/app/rich-text"
import { Badge } from "@/components/ui/badge"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  driveSettingsHelp as h,
  type DriveHelpStep,
} from "@/lib/i18n/vi/drive-settings-help"

function ExternalLink({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md font-medium text-brand-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-9"
    >
      {label}
      <HugeiconsIcon
        icon={ArrowUpRight01Icon}
        strokeWidth={2}
        className="size-3.5"
        aria-hidden
      />
      <span className="sr-only">{h.newTab}</span>
    </a>
  )
}

function Steps({
  steps,
  label,
}: {
  steps: readonly DriveHelpStep[]
  label: string
}) {
  return (
    <ol aria-label={label} className="flex flex-col gap-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-ink tabular-nums"
          >
            {i + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
            <p className="text-pretty [overflow-wrap:anywhere] break-words text-muted-foreground">
              <Rich text={s.text} />
            </p>
            {s.links && s.links.length > 0 && (
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                {s.links.map((l) => (
                  <ExternalLink key={l.url} {...l} />
                ))}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function Note({
  icon,
  children,
}: {
  icon: IconSvgElement
  children: React.ReactNode
}) {
  return (
    <p className="flex gap-2 text-pretty text-muted-foreground">
      <HugeiconsIcon
        icon={icon}
        strokeWidth={2}
        className="mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

type SectionKey = "purpose" | "json" | "apiKey" | "after"

function SectionTrigger({
  icon,
  title,
  badge,
}: {
  icon: IconSvgElement
  title: string
  badge?: { label: string; optional?: boolean }
}) {
  return (
    <AccordionTrigger className="items-center gap-3 px-4 py-3.5 hover:no-underline">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-primary/10 text-brand-ink"
        >
          <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-semibold text-pretty underline-offset-4 group-hover/accordion-trigger:underline">
            {title}
          </span>
          {badge && (
            <Badge
              variant={badge.optional ? "outline" : "secondary"}
              className={cn(
                !badge.optional && "bg-brand-primary/10 text-brand-ink"
              )}
            >
              {badge.label}
            </Badge>
          )}
        </span>
      </span>
    </AccordionTrigger>
  )
}

function SectionBody({ children }: { children: React.ReactNode }) {
  return (
    // h-auto: the panel keeps its natural height when the text reflows (container query, fonts) after opening
    <AccordionContent className="flex h-auto flex-col gap-3 pb-4 text-[13px] leading-5 [&_a]:no-underline [&_a]:hover:text-brand-ink [&_a]:hover:underline [&_p:not(:last-child)]:mb-0">
      {children}
    </AccordionContent>
  )
}

/**
 * The setup explainer of the system Google Drive card: four collapsible sections. Open by default: the purpose, plus
 * the JSON key steps while nothing is configured yet.
 */
export function DriveSettingsHelp({ configured }: { configured: boolean }) {
  const defaultOpen: SectionKey[] = configured
    ? ["purpose"]
    : ["purpose", "json"]
  return (
    <section
      aria-labelledby="drive-settings-help-title"
      className="flex max-w-3xl min-w-0 flex-col gap-2.5 @4xl:max-w-none"
    >
      <h2
        id="drive-settings-help-title"
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground"
      >
        <HugeiconsIcon
          icon={BookOpen01Icon}
          strokeWidth={2}
          className="size-4"
          aria-hidden
        />
        {h.title}
      </h2>
      <Accordion
        type="multiple"
        defaultValue={defaultOpen}
        className="bg-muted/30"
      >
        <AccordionItem value="purpose">
          <SectionTrigger icon={GoogleDriveIcon} title={h.purpose.title} />
          <SectionBody>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground marker:text-brand-primary/60">
              {h.purpose.points.map((p, i) => (
                <li key={i} className="text-pretty">
                  <Rich text={p} />
                </li>
              ))}
            </ul>
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="json">
          <SectionTrigger
            icon={Key01Icon}
            title={h.json.title}
            badge={{ label: h.required }}
          />
          <SectionBody>
            <Steps steps={h.json.steps} label={h.json.title} />
            <Note icon={InformationCircleIcon}>{h.json.checkNote}</Note>
            <Note icon={SecurityLockIcon}>
              <Rich text={h.json.secretNote} />
            </Note>
            <div className="flex flex-col gap-1 rounded-xl bg-warning/12 p-3 ring-1 ring-warning/30 ring-inset">
              <p className="flex items-start gap-1.5 font-medium text-warning-strong">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  strokeWidth={2}
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden
                />
                <span className="min-w-0 text-pretty">
                  {h.json.blockedTitle}
                </span>
              </p>
              <p className="text-pretty text-foreground/90">
                <Rich text={h.json.blocked} />
              </p>
            </div>
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="apiKey">
          <SectionTrigger
            icon={Link01Icon}
            title={h.apiKey.title}
            badge={{ label: h.optional, optional: true }}
          />
          <SectionBody>
            <p className="text-pretty text-muted-foreground">
              <Rich text={h.apiKey.what} />
            </p>
            <ul className="flex flex-col gap-2">
              {[h.apiKey.without, h.apiKey.withKey].map((t) => (
                <li
                  key={t}
                  className="rounded-xl bg-card px-3 py-2 text-pretty text-muted-foreground ring-1 ring-foreground/10"
                >
                  <Rich text={t} />
                </li>
              ))}
            </ul>
            <p className="pt-1 font-medium text-foreground">
              {h.apiKey.stepsLabel}
            </p>
            <Steps steps={h.apiKey.steps} label={h.apiKey.stepsLabel} />
            <Note icon={InformationCircleIcon}>
              <Rich text={h.apiKey.checkNote} />
            </Note>
            <Note icon={SecurityLockIcon}>
              <Rich text={h.apiKey.security} />
            </Note>
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="after">
          <SectionTrigger icon={Share08Icon} title={h.after.title} />
          <SectionBody>
            <Steps steps={h.after.steps} label={h.after.title} />
          </SectionBody>
        </AccordionItem>
      </Accordion>
    </section>
  )
}
