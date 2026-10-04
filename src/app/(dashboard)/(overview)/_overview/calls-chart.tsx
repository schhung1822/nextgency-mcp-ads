"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PLATFORM_LABELS } from "@/lib/constants"
import { formatNumber } from "@/lib/format"
import { dashboard as td } from "@/lib/i18n/vi/dashboard"
import type { ChartPoint } from "@/server/services/dashboard"

type SeriesKey = "meta" | "openai_ads" | "other"
const SERIES: SeriesKey[] = ["meta", "openai_ads", "other"]

// Categorical per-platform palette lives in globals.css (--chart-platform-*, light + dark variants).
const chartConfig = {
  meta: { label: PLATFORM_LABELS.meta, color: "var(--chart-platform-meta)" },
  openai_ads: { label: PLATFORM_LABELS.openai_ads, color: "var(--chart-platform-openai)" },
  other: { label: td.chart.other, color: "var(--chart-platform-other)" },
} satisfies ChartConfig

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** Recharts animates in JS, so the global CSS reduced-motion rule does not reach it. */
function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(REDUCED_MOTION_QUERY)
      mq.addEventListener("change", notify)
      return () => mq.removeEventListener("change", notify)
    },
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false
  )
}

function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-")
  return `${d}/${m}`
}

export function CallsChart({
  data,
  emptyAction,
}: {
  data: ChartPoint[]
  /** secondary button under the "no calls yet" message (e.g. "Thêm kết nối" on a fresh install) */
  emptyAction?: React.ReactNode
}) {
  const [days, setDays] = React.useState<"7" | "30">("7")
  const [asTable, setAsTable] = React.useState(false)
  const reducedMotion = useReducedMotion()
  const points = React.useMemo(() => data.slice(-Number(days)), [data, days])
  // only draw series that have data in the window (colour stays bound to the platform)
  const visible = React.useMemo(
    () => SERIES.filter((k) => points.some((p) => p[k] > 0)),
    [points]
  )
  const total = points.reduce((s, p) => s + SERIES.reduce((a, k) => a + p[k], 0), 0)

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{td.chart.title}</CardTitle>
        {/* phones: toggle shares the title row, the description spans the full width */}
        <CardDescription className="max-sm:col-span-2">
          {td.chart.description(Number(days))} · {td.chart.total}{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatNumber(total)}
          </span>
        </CardDescription>
        <CardAction className="max-sm:[grid-row:1]">
          <ToggleGroup
            type="single"
            value={days}
            onValueChange={(v) => v && setDays(v as "7" | "30")}
            variant="outline"
            size="sm"
            aria-label={td.chart.range}
          >
            <ToggleGroupItem value="7" className="px-3 pointer-coarse:h-10">
              {td.chart.days7}
            </ToggleGroupItem>
            <ToggleGroupItem value="30" className="px-3 pointer-coarse:h-10">
              {td.chart.days30}
            </ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-2 sm:px-(--card-spacing)">
        {total === 0 ? (
          <div className="flex h-[240px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-6 text-center">
            <p className="text-sm font-medium">{td.chart.empty}</p>
            <p className="max-w-md text-[13px] text-pretty text-muted-foreground">{td.chart.emptyHint}</p>
            {emptyAction && <div className="pt-3">{emptyAction}</div>}
          </div>
        ) : asTable ? (
          <div className="max-h-[260px] overflow-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{td.chart.date}</TableHead>
                  {visible.map((k) => (
                    <TableHead key={k} className="text-right">
                      {chartConfig[k].label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {points.map((p) => (
                  <TableRow key={p.date}>
                    <TableCell className="tabular-nums">{dayLabel(p.date)}</TableCell>
                    {visible.map((k) => (
                      <TableCell key={k} className="text-right tabular-nums">
                        {formatNumber(p[k])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full sm:h-[260px]">
            <AreaChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
              <defs>
                {visible.map((k) => (
                  <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.45} />
                    <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={dayLabel}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={40}
                allowDecimals={false}
                tickFormatter={(v: number) => formatNumber(v)}
              />
              <ChartTooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(v) => dayLabel(String(v))}
                  />
                }
              />
              {visible.map((k) => (
                <Area
                  key={k}
                  dataKey={k}
                  type="monotone"
                  stackId="calls"
                  fill={`url(#fill-${k})`}
                  stroke={`var(--color-${k})`}
                  strokeWidth={2}
                  isAnimationActive={!reducedMotion}
                />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
        {total > 0 && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" className="pointer-coarse:h-10" onClick={() => setAsTable((v) => !v)}>
              {asTable ? td.chart.chartToggle : td.chart.tableToggle}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
