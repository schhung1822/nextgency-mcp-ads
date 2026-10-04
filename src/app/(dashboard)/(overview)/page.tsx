import type { Metadata } from "next"
import Link from "next/link"
import {
  Activity01Icon,
  Alert02Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  CircleArrowUp02Icon,
  McpServerIcon,
  Megaphone01Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  EmptyState,
  KpiCard,
  PageGuide,
  PageHeader,
  PlatformIcon,
  RelativeTime,
  StatusBadge,
} from "@/components/app"
import type { Platform } from "@/components/app/types"
import { StatusHint } from "@/components/mcp/status-hint"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PLATFORM_LABELS } from "@/lib/constants"
import { formatNumber, formatPercent } from "@/lib/format"
import { dashboard as td } from "@/lib/i18n/vi/dashboard"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { logs as tl } from "@/lib/i18n/vi/logs"
import { displayVersion } from "@/lib/version"
import { requireUser } from "@/server/auth/session"
import {
  getCallsChart,
  getDashboardAlerts,
  getOverviewKpis,
  getRecentActivity,
  type DashboardAlert,
  type RecentItem,
} from "@/server/services/dashboard"
import { getVersionBadge } from "@/server/services/updates"

import { alertText } from "./_overview/alert-text"
import { CallsChart } from "./_overview/calls-chart"

export const metadata: Metadata = { title: td.title }

function pctDelta(cur: number, prev: number): number | undefined {
  if (prev <= 0) return undefined
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

function isPlatform(p: string | null): p is Platform {
  return !!p && p in PLATFORM_LABELS
}

export default async function OverviewPage() {
  const { user } = await requireUser()
  const [kpis, chart, alerts, recent, version] = await Promise.all([
    getOverviewKpis(user),
    getCallsChart(user, 30),
    getDashboardAlerts(user),
    getRecentActivity(user, 10),
    getVersionBadge(user.role),
  ])
  const errorRate =
    kpis.calls24h > 0 ? (kpis.errors24h / kpis.calls24h) * 100 : 0
  const prevErrorRate =
    kpis.callsPrev24h > 0 ? (kpis.errorsPrev24h / kpis.callsPrev24h) * 100 : 0
  const callsDelta = pctDelta(kpis.calls24h, kpis.callsPrev24h)

  return (
    <div className="flex w-full flex-col">
      <PageGuide guide={tg.overview} />
      <PageHeader
        title={td.title}
        description={
          user.role === "admin" ? td.description : td.descriptionStaff
        }
        primaryAction={
          <Button variant="brand" asChild>
            <Link href="/mcp-servers/new">{td.createMcp}</Link>
          </Button>
        }
      />

      <div className="flex flex-col gap-4 sm:gap-6">
        {/* 5 tiles: 2 cols on phones (last one full width) · 3 + 2 equal rows on tablets · 5 across on desktop */}
        <section
          aria-label={td.title}
          className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-6 xl:grid-cols-5"
        >
          <KpiCard
            className="md:col-span-2 xl:col-span-1"
            label={td.kpi.connections}
            value={formatNumber(kpis.connections)}
            hint={
              kpis.connections === 0
                ? td.kpi.noConnections
                : td.kpi.connectionsWarn(kpis.connectionsNeedingAttention)
            }
            hintTone={
              kpis.connections === 0
                ? "default"
                : kpis.connectionsNeedingAttention > 0
                  ? "warning"
                  : "success"
            }
            icon={Plug01Icon}
            href="/connections"
          />
          <KpiCard
            className="md:col-span-2 xl:col-span-1"
            label={td.kpi.adAccounts}
            value={formatNumber(kpis.adAccounts)}
            hint={td.kpi.adAccountsHint}
            icon={Megaphone01Icon}
            href="/connections"
          />
          <KpiCard
            className="md:col-span-2 xl:col-span-1"
            label={td.kpi.activeMcp}
            value={formatNumber(kpis.activeMcp)}
            hint={td.kpi.activeMcpHint(kpis.totalMcp)}
            icon={McpServerIcon}
            href="/mcp-servers"
          />
          <KpiCard
            className="md:col-span-3 xl:col-span-1"
            label={td.kpi.calls24h}
            value={formatNumber(kpis.calls24h)}
            hint={td.kpi.callsHint}
            delta={
              callsDelta === undefined
                ? undefined
                : { value: callsDelta, label: td.kpi.vsPrev }
            }
            icon={Activity01Icon}
            href="/logs"
          />
          <KpiCard
            className="col-span-2 md:col-span-3 xl:col-span-1"
            label={td.kpi.errorRate24h}
            value={formatPercent(errorRate, 1)}
            hint={td.kpi.errorsHint(kpis.errors24h)}
            hintTone={kpis.errors24h > 0 ? "danger" : "default"}
            delta={
              kpis.callsPrev24h > 0 && kpis.calls24h > 0
                ? {
                    value: Math.round((errorRate - prevErrorRate) * 10) / 10,
                    label: td.kpi.vsPrev,
                    positiveIsGood: false,
                  }
                : undefined
            }
            icon={Alert02Icon}
            href="/logs?status=error,denied,rate_limited,invalid_request"
          />
        </section>

        {/* row 1: chart (2/3) + alerts (1/3), same height · row 2: recent activity across the full width */}
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2 [&>*]:h-full">
            <CallsChart
              data={chart}
              emptyAction={
                kpis.connections === 0 ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/connections/new">{td.chart.addConnection}</Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
          <div className="min-w-0 [&>*]:h-full">
            <AlertsCard
              alerts={alerts}
              update={
                // getVersionBadge only ever sets latestVersion for admins
                version.latestVersion
                  ? { latest: version.latestVersion, current: version.current }
                  : null
              }
            />
          </div>
          <div className="min-w-0 lg:col-span-3">
            <RecentCard items={recent} isAdmin={user.role === "admin"} />
          </div>
        </div>
      </div>
    </div>
  )
}

function AlertsCard({
  alerts,
  update,
}: {
  alerts: DashboardAlert[]
  /** admin only: a newer release is waiting */
  update: { latest: string; current: string } | null
}) {
  const total = alerts.length + (update ? 1 : 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{td.alerts.title}</CardTitle>
        {total > 0 && (
          <CardAction>
            <Badge variant="secondary" className="tabular-nums">
              {total}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        {total === 0 ? (
          <div className="flex items-start gap-3 rounded-xl bg-muted/50 p-3">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              className="mt-0.5 size-5 shrink-0 text-success-strong"
              aria-hidden
            />
            <div>
              <p className="text-sm font-medium">{td.alerts.none}</p>
              <p className="text-[13px] text-muted-foreground">
                {td.alerts.noneHint}
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {update && (
              <li>
                <Link
                  href="/settings/updates"
                  className="group flex items-start gap-3 rounded-xl p-2.5 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <HugeiconsIcon
                    icon={CircleArrowUp02Icon}
                    strokeWidth={2}
                    className="mt-0.5 size-5 shrink-0 text-info-strong"
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium">
                      {td.alerts.updateTitle(displayVersion(update.latest))}
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {td.alerts.updateHint(displayVersion(update.current))}
                    </span>
                    <span className="text-[13px] font-medium text-brand-ink group-hover:underline">
                      {td.alerts.updateCta}
                    </span>
                  </span>
                </Link>
              </li>
            )}
            {alerts.map((a) => {
              const text = alertText(a)
              return (
                <li key={a.connectionId}>
                  <Link
                    href={`/connections/${a.connectionId}`}
                    className="group flex items-start gap-3 rounded-xl p-2.5 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <HugeiconsIcon
                      icon={
                        a.kind === "invalid" ? AlertCircleIcon : Alert02Icon
                      }
                      strokeWidth={2}
                      className={
                        a.kind === "invalid"
                          ? "mt-0.5 size-5 shrink-0 text-destructive"
                          : "mt-0.5 size-5 shrink-0 text-warning-strong"
                      }
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {isPlatform(a.platform) && (
                          <PlatformIcon
                            platform={a.platform}
                            colored
                            className="size-4"
                          />
                        )}
                        <span className="truncate">{a.name}</span>
                      </span>
                      {/* what happened, then what to do (once - some messages already carry the instruction) */}
                      <span className="text-[13px] break-words text-muted-foreground">
                        {text.message}
                      </span>
                      <StatusHint message={text.message} hint={text.hint} />
                      <span className="text-[13px] font-medium text-brand-ink group-hover:underline">
                        {td.alerts.check}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter className="border-t pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 pointer-coarse:h-10"
          asChild
        >
          <Link href="/connections">
            {td.alerts.manage}
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              data-icon="inline-end"
              aria-hidden
            />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

function RecentCard({
  items,
  isAdmin,
}: {
  items: RecentItem[]
  isAdmin: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{td.recent.title}</CardTitle>
        <CardDescription className="max-sm:col-span-2">
          {isAdmin ? `${tl.tabs.mcp} + ${tl.tabs.staff}` : tl.tabs.mcp}
        </CardDescription>
        <CardAction className="max-sm:[grid-row:1]">
          <Button variant="ghost" size="sm" className="pointer-coarse:h-10" asChild>
            <Link href="/logs">
              {td.recent.viewAll}
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                data-icon="inline-end"
                aria-hidden
              />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState title={td.recent.empty} bordered className="py-8" />
        ) : (
          <ul className="flex flex-col divide-y">
            {items.map((it) => (
              <li key={`${it.kind}-${it.id}`}>
                <Link
                  href={
                    it.kind === "mcp"
                      ? it.mcpId
                        ? `/logs?mcp=${it.mcpId}`
                        : "/logs"
                      : "/logs?tab=staff"
                  }
                  className="flex items-center gap-3 rounded-lg px-1 py-2.5 outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-2"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    {it.kind === "mcp" && isPlatform(it.platform) ? (
                      <PlatformIcon
                        platform={it.platform}
                        colored
                        className="size-4"
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={
                          it.kind === "mcp" ? McpServerIcon : Activity01Icon
                        }
                        strokeWidth={2}
                        className="size-4"
                        aria-hidden
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">
                      {it.kind === "mcp" ? (
                        <code className="font-mono text-[13px]">{it.what}</code>
                      ) : (
                        (tl.actions[it.what as keyof typeof tl.actions] ??
                        it.what)
                      )}
                      {it.kind === "staff" && it.targetLabel ? (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {it.targetLabel}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {it.kind === "mcp"
                        ? `${td.recent.mcpCall} · ${it.who ?? tl.deletedMcp}`
                        : td.recent.by(it.who ?? tl.system)}
                    </span>
                    <RelativeTime
                      value={it.createdAt}
                      className="text-xs text-muted-foreground sm:hidden"
                    />
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {it.kind === "mcp" ? (
                      <StatusBadge kind="log" status={it.status} />
                    ) : (
                      <StatusBadge
                        kind="log"
                        status={it.status === "success" ? "success" : "error"}
                        label={
                          tl.result[it.status as keyof typeof tl.result] ??
                          it.status
                        }
                      />
                    )}
                    <RelativeTime
                      value={it.createdAt}
                      className="hidden text-xs text-muted-foreground sm:block"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
