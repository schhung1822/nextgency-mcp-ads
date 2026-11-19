// Presentational building blocks shared by the three tips (server components; FAQ uses the client Accordion).
// Strings may carry the tiny `**bold**` / `` `code` `` markup of <Rich> (UI labels to click in bold).
import Link from "next/link"
import {
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Idea01Icon,
  SecurityCheckIcon,
  Target01Icon,
  UserGroupIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { plainText, Rich } from "@/components/app/rich-text"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { tips as t } from "@/lib/i18n/vi/tips"

const s = t.shared

export interface TipItem {
  title: string
  detail: string
}

export interface TipStep extends TipItem {
  /** short sub-steps (nested list a, b, c…) - keeps `detail` to one sentence */
  substeps?: readonly string[]
  /** what the user should see after the step */
  see?: string
  /** page (or #anchor of this page) where the step is done */
  href?: string
  actionLabel?: string
}

/** One entry of the "Trên trang này" strip: the id of a Card on the page. */
export interface TocItem {
  id: string
  label: string
}

function NumberDot({ n, size = "md" }: { n: number; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={
        size === "sm"
          ? "mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-ink tabular-nums"
          : "flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-ink tabular-nums"
      }
    >
      {n}
    </span>
  )
}

/** Outline link button "Mở …" (internal route or #anchor of this page). */
export function TipAction({ href, label }: { href: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      asChild
      className="self-start max-sm:h-10 max-sm:w-full"
    >
      <Link href={href}>
        {label}
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          data-icon="inline-end"
          aria-hidden
        />
      </Link>
    </Button>
  )
}

/** "Bạn sẽ thấy: …" box under a step. */
export function YouSee({ text }: { text: string }) {
  return (
    <p className="flex gap-1.5 rounded-xl bg-muted/60 px-3 py-2 text-[13px] leading-5 text-pretty">
      <HugeiconsIcon
        icon={ViewIcon}
        strokeWidth={2}
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span>
        <span className="font-medium">{s.youSee}</span> <Rich text={text} />
      </span>
    </p>
  )
}

/** Yellow (needs attention) or green (safety) box with a title and short points. */
export function TipAlert({
  tone,
  title,
  items,
  text,
  action,
}: {
  tone: "warning" | "safety"
  title: string
  items?: readonly string[]
  text?: string
  action?: { href: string; label: string }
}) {
  const warning = tone === "warning"
  return (
    <div
      role="note"
      className={cn(
        "flex flex-col gap-2 rounded-xl p-3.5 text-sm ring-1 ring-inset",
        warning ? "bg-warning/12 ring-warning/30" : "bg-success/8 ring-success/25"
      )}
    >
      <p
        className={cn(
          "flex items-start gap-1.5 font-medium",
          warning ? "text-warning-strong" : "text-success-strong"
        )}
      >
        <HugeiconsIcon
          icon={warning ? Alert02Icon : SecurityCheckIcon}
          strokeWidth={2}
          className="mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <span className="text-pretty">{title}</span>
      </p>
      {text && (
        <p className="text-[13px] leading-5 text-pretty">
          <Rich text={text} />
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 pl-5 text-[13px] leading-5 marker:text-muted-foreground sm:grid-cols-2 [&>li]:list-disc">
          {items.map((item) => (
            <li key={item} className="text-pretty">
              <Rich text={item} />
            </li>
          ))}
        </ul>
      )}
      {action && <TipAction href={action.href} label={action.label} />}
    </div>
  )
}

/** "Trên trang này": chips jumping to the sections of a long tip (scrolls sideways on phones). */
export function TipToc({ items }: { items: readonly TocItem[] }) {
  return (
    <nav aria-label={s.tocLabel} className="-mt-1 sm:-mt-2">
      <div className="-mx-1 [scrollbar-width:none] overflow-x-auto px-1 pb-1 [&::-webkit-scrollbar]:hidden">
        <ul className="flex w-max items-center gap-1.5 sm:w-auto sm:flex-wrap">
          <li
            aria-hidden
            className="pr-1 text-[13px] font-medium whitespace-nowrap text-muted-foreground"
          >
            {s.tocLabel}
          </li>
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className="inline-flex h-9 items-center rounded-full border bg-card px-3 text-[13px] font-medium whitespace-nowrap outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:h-10"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}

/** Tip heading card: who it is for, what you get, the flow in a few numbered boxes (+ an alert under it). */
export function TipIntro({
  title,
  description,
  who,
  result,
  flowLabel,
  flow,
  flowCols = "2xl:grid-cols-5",
  children,
}: {
  title: string
  description: string
  who: string
  result: string
  flowLabel: string
  flow: readonly TipItem[]
  /** 2xl column class (4 or 5 boxes) */
  flowCols?: string
  /** under the flow (safety / requirement alert) */
  children?: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[
            { icon: UserGroupIcon, term: s.who, text: who },
            { icon: Target01Icon, term: s.result, text: result },
          ].map((row) => (
            <div
              key={row.term}
              className="flex flex-col gap-1 rounded-2xl border p-3.5"
            >
              <dt className="flex items-center gap-1.5 text-[13px] font-medium text-brand-ink">
                <HugeiconsIcon
                  icon={row.icon}
                  strokeWidth={2}
                  className="size-4"
                  aria-hidden
                />
                {row.term}
              </dt>
              <dd className="text-sm text-pretty">{row.text}</dd>
            </div>
          ))}
        </dl>
        <ol
          aria-label={flowLabel}
          className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", flowCols)}
        >
          {flow.map((f, i) => (
            <li key={f.title} className="flex gap-3 rounded-2xl bg-muted/50 p-3.5">
              <NumberDot n={i + 1} />
              <span className="grid content-start gap-0.5">
                <span className="text-sm leading-5 font-medium">{f.title}</span>
                <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                  {f.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
        {children}
      </CardContent>
    </Card>
  )
}

/** Numbered how-to: one short sentence, sub-steps with the exact labels, what you should see, a link to the page. */
export function StepList({
  id,
  title = s.stepsTitle,
  description,
  steps,
  children,
}: {
  /** anchor of the "Trên trang này" strip */
  id?: string
  title?: string
  description?: string
  steps: readonly TipStep[]
  /** extra content under the list (links…) */
  children?: React.ReactNode
}) {
  return (
    <Card id={id} className={cn(id && "scroll-mt-24")}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol aria-label={title} className="flex flex-col gap-5">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <NumberDot n={i + 1} />
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
                <p className="text-sm leading-5 font-medium">{step.title}</p>
                <p className="text-[13px] leading-5 text-pretty">
                  <Rich text={step.detail} />
                </p>
                {step.substeps && step.substeps.length > 0 && (
                  <ol
                    aria-label={plainText(step.title)}
                    className="flex list-[lower-alpha] flex-col gap-1.5 pl-5 text-[13px] leading-5 marker:font-medium marker:text-brand-ink"
                  >
                    {step.substeps.map((sub) => (
                      <li key={sub} className="pl-0.5 text-pretty">
                        <Rich text={sub} />
                      </li>
                    ))}
                  </ol>
                )}
                {step.see && <YouSee text={step.see} />}
                {step.href && step.actionLabel && (
                  <TipAction href={step.href} label={step.actionLabel} />
                )}
              </div>
            </li>
          ))}
        </ol>
        {children}
      </CardContent>
    </Card>
  )
}

/** Where to look once it ran (+ outline links to the matching pages). */
export function ResultChecks({
  items,
  links,
}: {
  items: readonly TipItem[]
  links: readonly { label: string; href: string }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{s.checkTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {items.map((item) => (
            <li
              key={item.title}
              className="flex gap-2.5 rounded-2xl bg-muted/50 p-3.5"
            >
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                strokeWidth={2}
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden
              />
              <span className="grid content-start gap-0.5">
                <span className="text-sm leading-5 font-medium">
                  {item.title}
                </span>
                <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                  <Rich text={item.detail} />
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          {links.map((l) => (
            <Button key={l.href} variant="outline" asChild>
              <Link href={l.href}>
                {l.label}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  data-icon="inline-end"
                  aria-hidden
                />
              </Link>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** Short practical tips (bulb bullets). */
export function TipBullets({
  title,
  items,
}: {
  title: string
  items: readonly string[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-3 xl:grid-cols-2">
          {items.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm">
              <HugeiconsIcon
                icon={Idea01Icon}
                strokeWidth={2}
                className="mt-0.5 size-4 shrink-0 text-brand-ink"
                aria-hidden
              />
              <span className="text-pretty">
                <Rich text={item} />
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** FAQ / common errors: question = the message the user sees, answer = the fix. */
export function FaqList({
  id,
  items,
}: {
  id?: string
  items: readonly { q: string; a: string }[]
}) {
  return (
    <Card id={id} className={cn(id && "scroll-mt-24")}>
      <CardHeader>
        <CardTitle>{s.faqTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple">
          {items.map((item) => (
            <AccordionItem key={item.q} value={item.q}>
              <AccordionTrigger>
                <span className="text-pretty">{item.q}</span>
              </AccordionTrigger>
              <AccordionContent className="text-pretty text-muted-foreground">
                <Rich text={item.a} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  )
}

/** Safety notes in a green box. */
export function SafetyNotes({
  id,
  items,
}: {
  id?: string
  items: readonly string[]
}) {
  return (
    <Card id={id} className={cn(id && "scroll-mt-24")}>
      <CardHeader>
        <CardTitle>{s.safetyTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2.5 rounded-xl bg-success/8 p-3.5 ring-1 ring-success/25 ring-inset">
          {items.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm">
              <HugeiconsIcon
                icon={SecurityCheckIcon}
                strokeWidth={2}
                className="mt-0.5 size-4 shrink-0 text-success-strong"
                aria-hidden
              />
              <span className="text-pretty">
                <Rich text={item} />
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
