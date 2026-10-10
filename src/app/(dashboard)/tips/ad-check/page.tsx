import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  CloudServerIcon,
  CodeIcon,
  ComputerIcon,
  PuzzleIcon,
  RepeatIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { PageGuide } from "@/components/app"
import { Rich } from "@/components/app/rich-text"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { tips as t } from "@/lib/i18n/vi/tips"
import { tipHref } from "@/lib/tips-routes"
import { requireUser } from "@/server/auth/session"

import { PrepareChecklist } from "../_components/prepare-checklist"
import {
  FaqList,
  ResultChecks,
  SafetyNotes,
  StepList,
  TipAlert,
  TipIntro,
  TipToc,
} from "../_components/tip-blocks"
import { AdCheckBuilder } from "./_components/ad-check-builder"

export const metadata: Metadata = { title: t.pages["ad-check"].metaTitle }

const c = t.adCheck
const WHY_ICONS = [CloudServerIcon, ComputerIcon, RepeatIcon] as const
const POS_ICONS = [PuzzleIcon, CodeIcon] as const
const toc = t.shared.toc

/** Section anchors of this tip ("Trên trang này"). */
const IDS = {
  why: "vi-sao-web",
  pos: "mcp-ban-hang",
  prepare: "chuan-bi",
  steps: "tung-buoc",
  builder: "soan-cau-lenh",
  faq: "loi-thuong-gap",
  safety: "an-toan",
} as const

/** badge + left accent per verdict of the app comparison */
const TONE: Record<string, { badge: string; ring: string }> = {
  good: {
    badge: "bg-success/12 text-success-strong ring-1 ring-success/25 ring-inset",
    ring: "border-success/40",
  },
  try: {
    badge: "bg-warning/12 text-warning-strong ring-1 ring-warning/30 ring-inset",
    ring: "",
  },
  no: {
    badge: "bg-muted text-muted-foreground",
    ring: "",
  },
  alt: {
    badge: "bg-info/12 text-info-strong ring-1 ring-info/25 ring-inset",
    ring: "",
  },
}

/** Tip "Tự động kiểm tra quảng cáo": scheduled web task, Ads MCP + POS MCP + skill → Telegram (every role, static). */
export default async function AdCheckTipPage() {
  await requireUser()

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageGuide guide={tg.tipsAdCheck} />
      <TipToc
        items={[
          { id: IDS.prepare, label: toc.prepare },
          { id: IDS.pos, label: toc.pos },
          { id: IDS.steps, label: toc.steps },
          { id: IDS.builder, label: toc.builder },
          { id: IDS.why, label: toc.why },
          { id: IDS.faq, label: toc.faq },
          { id: IDS.safety, label: toc.safety },
        ]}
      />
      <TipIntro
        title={c.title}
        description={c.description}
        who={c.who}
        result={c.result}
        flowLabel={c.flowLabel}
        flow={c.flow}
      >
        <TipAlert
          tone="warning"
          title={c.posAlertTitle}
          text={c.posAlert}
          action={{ href: `#${IDS.pos}`, label: c.posAlertLink }}
        />
      </TipIntro>

      <Card id={IDS.why} className="scroll-mt-24">
        <CardHeader>
          <CardTitle>{c.why.title}</CardTitle>
          <CardDescription>{c.why.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {c.why.points.map((p, i) => (
              <li
                key={p.title}
                className="flex gap-2.5 rounded-2xl bg-muted/50 p-3.5"
              >
                <HugeiconsIcon
                  icon={WHY_ICONS[i] ?? RepeatIcon}
                  strokeWidth={2}
                  className="mt-0.5 size-4 shrink-0 text-brand-ink"
                  aria-hidden
                />
                <span className="grid content-start gap-0.5">
                  <span className="text-sm leading-5 font-medium">
                    {p.title}
                  </span>
                  <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                    {p.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{c.why.appsTitle}</h3>
            <ul
              aria-label={c.why.appsLabel}
              className="grid grid-cols-1 gap-3 xl:grid-cols-2"
            >
              {c.why.apps.map((app) => {
                const tone = TONE[app.tone] ?? TONE.no!
                return (
                  <li
                    key={app.name}
                    className={cn(
                      "flex flex-col gap-2.5 rounded-2xl border p-4",
                      tone.ring
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-semibold">{app.name}</h4>
                      <Badge className={tone.badge}>{app.badge}</Badge>
                    </div>
                    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted-foreground">
                      {app.points.map((pt) => (
                        <li key={pt} className="text-pretty">
                          {pt}
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
            <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-pretty text-muted-foreground">
              {c.why.appsNote}
            </p>
            <div>
              <Button variant="outline" asChild className="max-sm:w-full">
                <Link href={`${tipHref("automation")}#dat-lich`}>
                  {c.why.stepsLink}
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    data-icon="inline-end"
                    aria-hidden
                  />
                </Link>
              </Button>
            </div>
          </section>
        </CardContent>
      </Card>

      <PrepareChecklist
        id={IDS.prepare}
        storageKey="ad-check"
        items={c.prepare}
      />

      <Card id={IDS.pos} className="scroll-mt-24">
        <CardHeader>
          <CardTitle>{c.pos.title}</CardTitle>
          <CardDescription>{c.pos.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{c.pos.needTitle}</h3>
            <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
              {c.pos.needs.map((n) => (
                <li
                  key={n}
                  className="flex gap-2.5 rounded-2xl bg-muted/50 p-3.5 text-[13px] leading-5"
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    strokeWidth={2}
                    className="mt-0.5 size-4 shrink-0 text-success"
                    aria-hidden
                  />
                  <span className="text-pretty">
                    <Rich text={n} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <TipAlert
            tone="warning"
            title={c.pos.statusTitle}
            text={c.pos.statusNote}
          />
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{c.pos.optionsTitle}</h3>
            <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {c.pos.options.map((o, i) => (
                <li
                  key={o.title}
                  className="flex flex-col gap-2 rounded-2xl border p-4"
                >
                  <h4 className="flex items-center gap-2 text-sm font-semibold">
                    <HugeiconsIcon
                      icon={POS_ICONS[i] ?? PuzzleIcon}
                      strokeWidth={2}
                      className="size-4 shrink-0 text-brand-ink"
                      aria-hidden
                    />
                    {o.title}
                  </h4>
                  <p className="text-[13px] leading-5 text-pretty">
                    <Rich text={o.detail} />
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-pretty">
            <Rich text={c.pos.nextNote} />
          </p>
        </CardContent>
      </Card>

      <StepList id={IDS.steps} steps={c.steps} />

      <Card id={IDS.builder} className="scroll-mt-24">
        <CardHeader>
          <CardTitle>{c.builder.title}</CardTitle>
          <CardDescription>{c.builder.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdCheckBuilder />
        </CardContent>
      </Card>

      <ResultChecks
        items={c.check}
        links={[
          { label: c.openLogs, href: "/logs" },
          { label: c.openTelegram, href: "/connections?tab=telegram" },
        ]}
      />
      <FaqList id={IDS.faq} items={c.faq} />
      <SafetyNotes id={IDS.safety} items={c.safety} />
    </div>
  )
}
