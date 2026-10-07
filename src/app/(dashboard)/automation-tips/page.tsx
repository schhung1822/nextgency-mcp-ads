import type { Metadata } from "next"
import Link from "next/link"
import {
  Add01Icon,
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PageGuide, PageHeader } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { automation as t } from "@/lib/i18n/vi/automation"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { requireUser } from "@/server/auth/session"

import { PlatformTabs } from "./_components/platform-tabs"
import { RuleBuilder } from "./_components/rule-builder"

export const metadata: Metadata = { title: t.metaTitle }

const MODES = ["report", "pause"] as const

/** Static how-to: let Claude / ChatGPT / Gemini run an ads check on a schedule through an MCP (every role). */
export default async function AutomationTipsPage() {
  await requireUser()

  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.automationTips} />
      <PageHeader
        title={t.title}
        description={t.description}
        primaryAction={
          <Button variant="brand" asChild>
            <Link href="/mcp-servers/new">
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
              {t.createMcp}
            </Link>
          </Button>
        }
      />

      <div className="flex flex-col gap-4 sm:gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t.how.title}</CardTitle>
            <CardDescription>{t.how.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol
              aria-label={t.how.stepsLabel}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4"
            >
              {t.how.steps.map((s, i) => (
                <li
                  key={s.title}
                  className="flex gap-3 rounded-2xl bg-muted/50 p-3.5"
                >
                  <span
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-red/10 text-xs font-semibold text-brand-ink tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <span className="grid gap-0.5">
                    <span className="text-sm leading-5 font-medium">
                      {s.title}
                    </span>
                    <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                      {s.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.mcpSetup.title}</CardTitle>
            <CardDescription>{t.mcpSetup.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul
              aria-label={t.mcpSetup.modesLabel}
              className="grid grid-cols-1 gap-3 xl:grid-cols-2"
            >
              {MODES.map((m) => {
                const mode = t.mcpSetup.modes[m]
                return (
                  <li
                    key={m}
                    className="flex flex-col gap-3 rounded-2xl border p-4"
                  >
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{mode.title}</h3>
                        <Badge
                          variant={m === "report" ? "secondary" : "outline"}
                        >
                          {mode.badge}
                        </Badge>
                      </div>
                      <p className="text-[13px] text-pretty text-muted-foreground">
                        {mode.summary}
                      </p>
                    </div>
                    <ul className="flex flex-col gap-2">
                      {mode.items.map((item) => (
                        <li key={item} className="flex gap-2 text-sm">
                          <HugeiconsIcon
                            icon={CheckmarkCircle02Icon}
                            strokeWidth={2}
                            className="mt-0.5 size-4 shrink-0 text-success"
                            aria-hidden
                          />
                          <span className="text-pretty">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
            <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-pretty text-muted-foreground">
              {t.mcpSetup.note}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.builder.title}</CardTitle>
            <CardDescription>{t.builder.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <RuleBuilder />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.platforms.title}</CardTitle>
            <CardDescription>{t.platforms.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <PlatformTabs />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.monitor.title}</CardTitle>
            <CardDescription>{t.monitor.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              {t.monitor.items.map((item) => (
                <li
                  key={item.title}
                  className="grid gap-0.5 rounded-2xl bg-muted/50 p-3.5"
                >
                  <span className="text-sm leading-5 font-medium">
                    {item.title}
                  </span>
                  <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                    {item.detail}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" asChild>
                <Link href="/logs?writes=1">
                  {t.monitor.openLogs}
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    aria-hidden
                  />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/mcp-servers">
                  {t.monitor.openMcp}
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    aria-hidden
                  />
                </Link>
              </Button>
            </div>
            <div className="flex flex-col gap-2 rounded-xl bg-warning/12 p-3 text-sm ring-1 ring-warning/30 ring-inset">
              <p className="flex items-center gap-1.5 font-medium text-warning-strong">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  strokeWidth={2}
                  className="size-4"
                  aria-hidden
                />
                {t.warnings.title}
              </p>
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px]">
                {t.warnings.items.map((w) => (
                  <li key={w} className="text-pretty">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
