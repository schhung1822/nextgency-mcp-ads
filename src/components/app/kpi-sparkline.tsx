"use client"

import * as React from "react"
import { Area, AreaChart } from "recharts"

import { ChartContainer, type ChartConfig } from "@/components/ui/chart"

export interface KpiSparklineProps {
  data: readonly number[]
  /** CSS colour (token), default brand red */
  color?: string
  className?: string
}

/** Tiny decorative area chart for KPI cards (aria-hidden - the KPI value carries the meaning). */
export function KpiSparkline({
  data,
  color = "var(--brand-red)",
  className,
}: KpiSparklineProps) {
  const id = React.useId().replace(/:/g, "")
  const points = React.useMemo(() => data.map((v, i) => ({ i, v })), [data])
  const config = React.useMemo<ChartConfig>(
    () => ({ v: { label: "", color } }),
    [color]
  )
  if (points.length < 2) return null
  return (
    <div aria-hidden className={className}>
      <ChartContainer
        config={config}
        className="aspect-auto h-10 w-full"
        initialDimension={{ width: 160, height: 40 }}
      >
        <AreaChart
          data={points}
          margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
        >
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-v)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-v)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            dataKey="v"
            type="monotone"
            stroke="var(--color-v)"
            strokeWidth={1.75}
            fill={`url(#spark-${id})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
