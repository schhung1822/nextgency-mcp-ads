"use client"

import * as React from "react"
import Link from "next/link"
import {
  Activity01Icon,
  Alert02Icon,
  AlertCircleIcon,
  Clock01Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  KpiCard,
  PermissionBadges,
  PlatformIcon,
  RelativeTime,
  StatusBadge,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { PLATFORM_LABELS } from "@/lib/constants"
import {
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
} from "@/lib/format"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type { McpApifyPoolSummary } from "@/lib/schemas/apify"
import { tiktokGmvMaxMcp as gmv } from "@/lib/i18n/vi/tiktok-gmv-max"
import {
  analyzeScope,
  type PlatformUsability,
} from "@/lib/schemas/mcp-servers"
import type {
  McpDetail,
  SelectableConnection,
} from "@/server/services/mcp-servers"

import { ApifyScopeBlock, ApifySummaryRows } from "./apify-sections"
import { DriveSummaryRows } from "./drive-sections"

const o = t.overview

const chartConfig = {
  calls: { label: o.chartCalls, color: "var(--chart-1)" },
  errors: { label: o.chartErrors, color: "var(--destructive)" },
} satisfies ChartConfig

function CallsChart({ daily }: { daily: McpDetail["stats"]["daily"] }) {
  const data = daily.map((d) => ({
    ...d,
    label: d.date.slice(8, 10) + "/" + d.date.slice(5, 7),
  }))
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-56 w-full"
      initialDimension={{ width: 640, height: 224 }}
    >
      <BarChart
        data={data}
        margin={{ top: 8, right: 4, bottom: 0, left: -12 }}
        barCategoryGap={2}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar
          dataKey="calls"
          fill="var(--color-calls)"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
      </BarChart>
    </ChartContainer>
  )
}

function SummaryRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm sm:text-right">{children}</dd>
    </div>
  )
}

/** Platforms with permissions but no ad account the MCP can actually use (connection deleted / off, no TKQC on). */
function NoUsableAccountsAlert({
  platforms,
  total,
}: {
  platforms: PlatformUsability[]
  /** how many platforms the MCP has permissions on */
  total: number
}) {
  const n = o.noUsable
  const all = platforms.length === total
  return (
    <Alert className="border-warning/40 bg-warning/10">
      <HugeiconsIcon
        icon={Alert02Icon}
        strokeWidth={2}
        aria-hidden
        className="text-warning-strong"
      />
      <AlertTitle className="text-warning-strong">
        {all ? n.titleAll : n.titleSome}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2.5">
        <div>{all ? n.descriptionAll : n.descriptionSome}</div>
        <ul className="flex flex-col gap-1 text-[13px]">
          {platforms.map((p) => (
            <li key={p.platform} className="flex items-start gap-1.5">
              <PlatformIcon
                platform={p.platform}
                colored
                className="mt-0.5 size-4 shrink-0"
              />
              <span className="min-w-0 break-words">
                <span className="font-medium text-foreground">
                  {PLATFORM_LABELS[p.platform]}
                </span>
                {" - "}
                {n.reason[p.reason ?? "no_accounts"]}
              </span>
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          asChild
          className="w-full no-underline! sm:w-fit"
        >
          <Link href="/connections">{n.openConnections}</Link>
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/** Money-write scope without a daily cap for some currencies (legacy MCP, or an account synced later). */
function CapsMissingAlert({
  currencies,
  required,
  onOpenConfig,
}: {
  currencies: string[]
  /** the MCP already requires caps (writes in these currencies are refused) */
  required: boolean
  onOpenConfig?: () => void
}) {
  const list = currencies.join(", ")
  return (
    <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertTitle>{o.capsMissingTitle}</AlertTitle>
      {/* only the title is red: body text in the foreground colour for AA contrast */}
      <AlertDescription className="flex flex-col gap-2.5 text-foreground/80!">
        <div>
          {required ? o.capsMissingBodyRequired(list) : o.capsMissingBody(list)}
        </div>
        {onOpenConfig && (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-foreground sm:w-fit"
            onClick={onOpenConfig}
          >
            {o.capsMissingAction}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function OverviewTab({
  mcp,
  connections,
  onOpenConfig,
  apifyPool = null,
}: {
  mcp: McpDetail
  /** connections the owner can use now (enabled accounts only) - what the MCP can really reach */
  connections: SelectableConnection[]
  /** switch to the Config tab (caps warning action) */
  onOpenConfig?: () => void
  /** Apify token pool of the MCP OWNER (Apify platform block of "Phạm vi MCP") */
  apifyPool?: McpApifyPoolSummary | null
}) {
  const s = mcp.stats
  const noUsable = analyzeScope(mcp.config, connections).platforms.filter(
    (p) => p.usableAccounts === 0
  )
  const hasCalls = s.daily.some((d) => d.calls > 0)
  const errorRate = s.calls7d > 0 ? (s.errors7d / s.calls7d) * 100 : null
  const caps = Object.entries(mcp.settings.maxDailyBudget)
  const lifetimeCaps = Object.entries(mcp.settings.maxLifetimeBudget)
  const bidCaps = Object.entries(mcp.settings.maxBid)
  const hasTiktok = mcp.config.some((p) => p.platform === "tiktok")
  const gmvWrite = hasTiktok && mcp.settings.tiktokGmvMaxWrite === true
  // basic mode: only the expiry applies - the stored advanced values are kept but not enforced, so show what applies
  const basic = mcp.settings.protectionMode === "basic"
  return (
    <div className="flex flex-col gap-5">
      {mcp.status === "expired" && (
        <Alert className="border-warning/40 bg-warning/10">
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            aria-hidden
            className="text-warning-strong"
          />
          <AlertDescription className="text-warning-strong">
            {o.expiredNotice}
          </AlertDescription>
        </Alert>
      )}
      {mcp.status === "disabled" && (
        <Alert>
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden />
          <AlertDescription>{o.disabledNotice}</AlertDescription>
        </Alert>
      )}
      {!basic && mcp.capsMissing.length > 0 && (
        <CapsMissingAlert
          currencies={mcp.capsMissing}
          required={mcp.settings.moneyCapsRequired}
          onOpenConfig={onOpenConfig}
        />
      )}
      {noUsable.length > 0 && (
        <NoUsableAccountsAlert
          platforms={noUsable}
          total={mcp.config.length}
        />
      )}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard
          className="max-sm:p-4"
          label={o.calls7d}
          value={formatNumber(s.calls7d)}
          icon={Activity01Icon}
          hint={
            s.avgDurationMs !== null
              ? o.avgDuration(formatDuration(s.avgDurationMs))
              : undefined
          }
          sparkline={
            hasCalls ? s.daily.slice(-7).map((d) => d.calls) : undefined
          }
        />
        <KpiCard
          className="max-sm:p-4"
          label={o.errors7d}
          value={formatNumber(s.errors7d)}
          icon={AlertCircleIcon}
          hint={
            errorRate !== null
              ? o.errorRate(formatPercent(errorRate, 1))
              : undefined
          }
          hintTone={s.errors7d > 0 ? "danger" : "default"}
        />
        <KpiCard
          className="max-sm:p-4"
          label={o.writes7d}
          value={formatNumber(s.writes7d)}
          icon={PencilEdit02Icon}
        />
        <KpiCard
          className="max-sm:p-4"
          label={o.lastUsed}
          value={
            // "khoảng 2 giờ trước" wraps inside a narrow 4-up KPI tile instead of running out of the card
            <span className="block text-base text-balance break-words sm:text-xl">
              {mcp.lastUsedAt ? (
                <RelativeTime
                  value={mcp.lastUsedAt}
                  className="whitespace-normal"
                />
              ) : (
                o.neverUsed
              )}
            </span>
          }
          icon={Clock01Icon}
          hint={mcp.lastClient ? o.lastClient(mcp.lastClient) : undefined}
        />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{o.chartTitle}</CardTitle>
            <CardDescription>{o.chartDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {hasCalls ? (
              <CallsChart daily={s.daily} />
            ) : (
              <p className="flex h-40 items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm text-muted-foreground">
                {o.chartEmpty}
              </p>
            )}
            {s.byPlatform.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">{o.byPlatformTitle}</p>
                <ul className="flex flex-wrap gap-3 text-sm">
                  {s.byPlatform.map((p) => (
                    <li
                      key={p.platform || "none"}
                      className="flex items-center gap-1.5"
                    >
                      {p.platform in PLATFORM_LABELS ? (
                        <>
                          <PlatformIcon
                            platform={
                              p.platform as keyof typeof PLATFORM_LABELS
                            }
                            colored
                          />
                          {
                            PLATFORM_LABELS[
                              p.platform as keyof typeof PLATFORM_LABELS
                            ]
                          }
                        </>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                      <span className="font-medium tabular-nums">
                        {formatNumber(p.calls)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{o.summaryTitle}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {mcp.config.map((p) => (
              <div
                key={p.platform}
                className="flex flex-col gap-2 rounded-xl border p-3"
              >
                <div className="flex items-center gap-2 font-medium">
                  <PlatformIcon platform={p.platform} colored />
                  {PLATFORM_LABELS[p.platform]}
                </div>
                <PermissionBadges
                  permissions={p.permissions}
                  withDescriptions
                />
                {p.platform === "tiktok" && gmvWrite && (
                  <p className="flex items-start gap-1.5 text-[13px] font-medium text-warning-strong">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      strokeWidth={2}
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0">{gmv.summaryBadge}</span>
                  </p>
                )}
                <ul className="flex flex-col gap-1 text-[13px] text-muted-foreground">
                  {p.connections.map((c) => (
                    <li
                      key={c.connectionId}
                      className="flex flex-col gap-0.5 border-l-2 pl-2.5"
                    >
                      <span className="font-medium break-words text-foreground">
                        {c.connectionName}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {c.accountIds === null
                          ? t.platformsStep.accountsAll
                          : t.platformsStep.nAccounts(c.accountIds.length)}
                        {c.connectionDeleted ? (
                          <span className="text-destructive-strong">
                            {o.deletedConnection}
                          </span>
                        ) : (
                          c.connectionStatus !== "active" && (
                            <StatusBadge
                              kind="connection"
                              status={c.connectionStatus}
                            />
                          )
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {/* Apify counts as a platform of the MCP (decision A5) */}
            <ApifyScopeBlock settings={mcp.settings} pool={apifyPool} />
            <dl className="divide-y">
              <SummaryRow label={o.summaryMode}>
                {basic ? o.modeBasic : o.modeAdvanced}
              </SummaryRow>
              <SummaryRow label={o.summaryTwoStep}>
                {!basic && mcp.settings.twoStepConfirm ? o.on : o.off}
              </SummaryRow>
              {hasTiktok && (
                <SummaryRow label={gmv.summaryLabel}>
                  <span className={gmvWrite ? "font-medium text-warning-strong" : undefined}>
                    {gmvWrite ? gmv.summaryOn : gmv.summaryOff}
                  </span>
                </SummaryRow>
              )}
              <SummaryRow label={o.summaryBudgetPct}>
                {basic ? o.unlimited : `±${mcp.settings.budgetChangeMaxPct}%`}
              </SummaryRow>
              {basic && (
                <SummaryRow label={o.summaryMaxBudget}>{o.unlimited}</SummaryRow>
              )}
              {!basic && caps.length > 0 && (
                <SummaryRow label={o.summaryMaxBudget}>
                  {caps.map(([cur, n]) => (
                    <span key={cur} className="block tabular-nums">
                      {formatNumber(n)} {cur}
                    </span>
                  ))}
                </SummaryRow>
              )}
              {!basic && lifetimeCaps.length > 0 && (
                <SummaryRow label={o.summaryMaxLifetime}>
                  {lifetimeCaps.map(([cur, n]) => (
                    <span key={cur} className="block tabular-nums">
                      {formatNumber(n)} {cur}
                    </span>
                  ))}
                </SummaryRow>
              )}
              {!basic && bidCaps.length > 0 && (
                <SummaryRow label={o.summaryMaxBid}>
                  {bidCaps.map(([cur, n]) => (
                    <span key={cur} className="block tabular-nums">
                      {formatNumber(n)} {cur}
                    </span>
                  ))}
                </SummaryRow>
              )}
              <SummaryRow label={o.summaryRateLimit}>
                {basic ? o.unlimited : mcp.settings.rateLimitPerMin}
              </SummaryRow>
              <SummaryRow label={o.summaryWriteRate}>
                {basic ? o.unlimited : mcp.settings.writeRateLimitPer10Min}
              </SummaryRow>
              <SummaryRow label={o.summaryWriteDelay}>
                {!basic && (mcp.settings.writeDelaySeconds ?? 0) > 0
                  ? o.nSeconds(mcp.settings.writeDelaySeconds ?? 0)
                  : o.off}
              </SummaryRow>
              <SummaryRow label={o.summaryExpires}>
                {mcp.expiresAt ? formatDate(mcp.expiresAt) : o.noExpiry}
              </SummaryRow>
              <SummaryRow label={o.summaryAllowedIps}>
                {!basic && mcp.settings.allowedIps.length
                  ? o.nIps(mcp.settings.allowedIps.length)
                  : o.anyIp}
              </SummaryRow>
              <SummaryRow label={t.telegram.summaryChannels}>
                {mcp.notificationChannels.length === 0
                  ? t.telegram.summaryNone
                  : mcp.notificationChannels.map((c) => (
                      <span key={c.id} className="block break-words">
                        {c.name}
                        {c.deleted ? (
                          <span className="text-destructive-strong">
                            {" "}
                            {t.telegram.deletedChannel}
                          </span>
                        ) : c.status === "error" || c.status === "disabled" ? (
                          <>
                            {" "}
                            <StatusBadge
                              kind="connection"
                              status={c.status === "error" ? "invalid" : "disabled"}
                              label={
                                c.status === "error"
                                  ? t.telegram.statusError
                                  : t.telegram.statusDisabled
                              }
                            />
                          </>
                        ) : null}
                      </span>
                    ))}
              </SummaryRow>
              {mcp.notificationChannels.length > 0 && (
                <>
                  <SummaryRow label={t.telegram.summaryTool}>
                    {mcp.settings.telegramTool ? o.on : o.off}
                  </SummaryRow>
                  <SummaryRow label={t.telegram.summaryNotify}>
                    {mcp.settings.telegramNotifyWrites ? o.on : o.off}
                  </SummaryRow>
                  {mcp.settings.telegramTool && (
                    <SummaryRow label={t.telegram.summaryPerHour}>
                      {basic
                        ? o.unlimited
                        : mcp.settings.telegramMessagesPerHour}
                    </SummaryRow>
                  )}
                </>
              )}
              <DriveSummaryRows
                sources={mcp.driveSources ?? []}
                drivePublicLinks={mcp.settings.drivePublicLinks}
                driveSheetWriteback={mcp.settings.driveSheetWriteback}
                Row={SummaryRow}
                on={o.on}
                off={o.off}
              />
              <ApifySummaryRows
                settings={mcp.settings}
                basic={basic}
                Row={SummaryRow}
                on={o.on}
                off={o.off}
              />
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
