"use client"

// Thêm kết nối → TikTok Ads (step 2): the "Dùng GMV Max (TikTok Shop)?" note above the form, with the caution
// (AI analyses GMV Max metrics by default; changes only when an admin turns on the MCP's GMV Max switch, always
// 2-step confirmed; create/copy run immediately) and a button opening the detailed GMV Max setup guide in a
// Dialog (bottom sheet on phones). GMV Max uses this same TikTok connection - there is no separate connection type.
// Static content only; strings in src/lib/i18n/vi/tiktok-gmv-max.ts.
import * as React from "react"
import {
  AiChat02Icon,
  Alert02Icon,
  ArrowUpRight01Icon,
  BookOpen01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  Key01Icon,
  LiveStreaming02Icon,
  Store01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { Rich } from "@/components/app/rich-text"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  tiktokGmvMax as g,
  type GmvGuideFlow,
  type GmvGuideStep,
} from "@/lib/i18n/vi/tiktok-gmv-max"

type Link = { label: string; url: string }

function ExternalLink({ label, url }: Link) {
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
      <span className="sr-only">{g.dialog.newTab}</span>
    </a>
  )
}

function Links({ links }: { links: readonly Link[] }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1">
      {links.map((l) => (
        <ExternalLink key={l.url} {...l} />
      ))}
    </p>
  )
}

function Steps({
  steps,
  label,
}: {
  steps: readonly GmvGuideStep[]
  label: string
}) {
  return (
    <ol aria-label={label} className="flex flex-col gap-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-red/10 text-xs font-semibold text-brand-ink tabular-nums"
          >
            {i + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
            <p className="text-pretty [overflow-wrap:anywhere] break-words text-muted-foreground">
              <Rich text={s.text} />
            </p>
            {s.see && (
              <p className="flex items-start gap-1.5 text-pretty text-foreground/90">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  strokeWidth={2}
                  className="mt-0.5 size-3.5 shrink-0 text-success"
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="font-medium">{g.dialog.seeLabel}</span>{" "}
                  <Rich text={s.see} />
                </span>
              </p>
            )}
            {s.links && s.links.length > 0 && <Links links={s.links} />}
          </div>
        </li>
      ))}
    </ol>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 text-pretty text-muted-foreground">
      <HugeiconsIcon
        icon={InformationCircleIcon}
        strokeWidth={2}
        className="mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground marker:text-brand-red/60">
      {items.map((p, i) => (
        <li key={i} className="text-pretty">
          <Rich text={p} />
        </li>
      ))}
    </ul>
  )
}

function Flows({ flows }: { flows: readonly GmvGuideFlow[] }) {
  return (
    <>
      {flows.map((f) => (
        <div key={f.title} className="flex flex-col gap-2.5">
          <p className="font-medium text-foreground">{f.title}</p>
          <Steps steps={f.steps} label={f.title} />
          {f.note && (
            <Note>
              <Rich text={f.note} />
            </Note>
          )}
        </div>
      ))}
    </>
  )
}

function SectionTrigger({
  icon,
  title,
  badge,
}: {
  icon: IconSvgElement
  title: string
  badge?: "required" | "optional"
}) {
  return (
    <AccordionTrigger className="items-center gap-3 px-4 py-3.5 hover:no-underline">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-red/10 text-brand-ink"
        >
          <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-semibold text-pretty underline-offset-4 group-hover/accordion-trigger:underline">
            {title}
          </span>
          {badge && (
            <Badge
              variant={badge === "optional" ? "outline" : "secondary"}
              className={cn(
                badge === "required" && "bg-brand-red/10 text-brand-ink"
              )}
            >
              {badge === "required" ? g.dialog.required : g.dialog.optional}
            </Badge>
          )}
        </span>
      </span>
    </AccordionTrigger>
  )
}

function SectionBody({ children }: { children: React.ReactNode }) {
  return (
    // h-auto: the panel keeps its natural height when the text reflows after opening
    <AccordionContent className="flex h-auto flex-col gap-3 pb-4 text-[13px] leading-5 [&_a]:no-underline [&_a]:hover:text-brand-ink [&_a]:hover:underline [&_p:not(:last-child)]:mb-0">
      {children}
    </AccordionContent>
  )
}

/** Warning box (same look as the guide panel's "Lưu ý" box). */
function WarningBox({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-warning/12 p-3 text-[13px] leading-5 ring-1 ring-warning/30 ring-inset">
      <p className="flex items-start gap-1.5 text-sm font-medium text-warning-strong">
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={2}
          className="mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <span className="min-w-0 text-pretty">{title}</span>
      </p>
      <div className="text-pretty text-foreground/90">{children}</div>
    </div>
  )
}

/** The detailed setup guide (Dialog body). */
function GmvMaxGuideBody() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WarningBox title={g.caution.title}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {g.caution.points.map((p, i) => (
            <li key={i}>
              <Rich text={p} />
            </li>
          ))}
        </ul>
      </WarningBox>

      {/* create / copy start running immediately (TikTok has no paused create for GMV Max) */}
      <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
        <AlertTitle>{g.caution.runsNowTitle}</AlertTitle>
        <AlertDescription className="text-[13px] leading-5 text-foreground/80!">
          <span>
            <Rich text={g.caution.runsNow} />
          </span>
        </AlertDescription>
      </Alert>

      <Accordion type="multiple" defaultValue={["about"]} className="bg-muted/30">
        <AccordionItem value="about">
          <SectionTrigger icon={InformationCircleIcon} title={g.about.title} />
          <SectionBody>
            <Bullets items={g.about.points} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="prereq">
          <SectionTrigger icon={CheckListIcon} title={g.prereq.title} />
          <SectionBody>
            <Bullets items={g.prereq.points} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="shop">
          <SectionTrigger icon={Store01Icon} title={g.shop.title} badge="required" />
          <SectionBody>
            <Flows flows={g.shop.flows} />
            <Links links={g.shop.links} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="account">
          <SectionTrigger
            icon={UserAccountIcon}
            title={g.account.title}
            badge="required"
          />
          <SectionBody>
            <p className="text-pretty text-muted-foreground">
              <Rich text={g.account.intro} />
            </p>
            <Flows flows={g.account.flows} />
            <WarningBox title={g.account.warningTitle}>
              <Rich text={g.account.warning} />
            </WarningBox>
            <Links links={g.account.links} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="live">
          <SectionTrigger
            icon={LiveStreaming02Icon}
            title={g.live.title}
            badge="optional"
          />
          <SectionBody>
            <p className="text-pretty text-muted-foreground">{g.live.intro}</p>
            <Steps steps={g.live.steps} label={g.live.title} />
            <Note>
              <Rich text={g.live.note} />
            </Note>
            <Links links={g.live.links} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="scope">
          <SectionTrigger icon={Key01Icon} title={g.scope.title} badge="required" />
          <SectionBody>
            <Steps steps={g.scope.steps} label={g.scope.title} />
            <Links links={g.scope.links} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="check">
          <SectionTrigger icon={CheckmarkCircle02Icon} title={g.check.title} />
          <SectionBody>
            <Steps steps={g.check.steps} label={g.check.title} />
            <p className="pt-1 font-medium text-foreground">
              {g.check.notReadyTitle}
            </p>
            <Bullets items={g.check.notReady} />
            <Links links={g.check.links} />
          </SectionBody>
        </AccordionItem>

        <AccordionItem value="prompts">
          <SectionTrigger icon={AiChat02Icon} title={g.prompts.title} />
          <SectionBody>
            <p className="text-pretty text-muted-foreground">{g.prompts.intro}</p>
            <ul className="flex flex-col gap-2">
              {g.prompts.items.map((t) => (
                <li
                  key={t}
                  className="rounded-xl bg-card px-3 py-2 text-pretty text-foreground/90 ring-1 ring-foreground/10"
                >
                  “{t}”
                </li>
              ))}
            </ul>
            <Links links={g.roiLinks} />
          </SectionBody>
        </AccordionItem>
      </Accordion>

      <Note>{g.dialog.labelsNote}</Note>
    </div>
  )
}

/**
 * TikTok credentials step: GMV Max note (Alert, same pattern as the Google Ads → YouTube note) + the detailed
 * setup guide in a Dialog.
 */
export function TikTokGmvMaxNote() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Alert>
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden />
        <AlertTitle>{g.note.title}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2.5">
          <span>{g.note.body}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto pointer-coarse:h-10"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            <HugeiconsIcon
              icon={BookOpen01Icon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
            {g.note.open}
          </Button>
        </AlertDescription>
      </Alert>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="pr-8">{g.dialog.title}</DialogTitle>
            <DialogDescription>{g.dialog.description}</DialogDescription>
          </DialogHeader>
          <GmvMaxGuideBody />
          <DialogFooter>
            <Button type="button" variant="brand" onClick={() => setOpen(false)}>
              {g.dialog.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
