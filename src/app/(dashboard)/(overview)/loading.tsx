import { KpiCard } from "@/components/app"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"
import { dashboard as td } from "@/lib/i18n/vi/dashboard"

/**
 * Skeleton of the Overview page (the only dashboard route without its own loading.tsx): same grid, same
 * paddings and the real KPI labels, so nothing jumps when the data arrives.
 */
export default function DashboardLoading() {
  const kpis = [
    { label: td.kpi.connections, span: "md:col-span-2 xl:col-span-1" },
    { label: td.kpi.adAccounts, span: "md:col-span-2 xl:col-span-1" },
    { label: td.kpi.activeMcp, span: "md:col-span-2 xl:col-span-1" },
    { label: td.kpi.calls24h, span: "md:col-span-3 xl:col-span-1" },
    {
      label: td.kpi.errorRate24h,
      span: "col-span-2 md:col-span-3 xl:col-span-1",
    },
  ]
  return (
    <div
      className="flex w-full flex-col"
      aria-busy="true"
      aria-label={common.loading}
    >
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 rounded-xl" />
      </div>
      <div className="flex flex-col gap-4 sm:gap-6">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-6 xl:grid-cols-5">
          {kpis.map((k) => (
            <KpiCard
              key={k.label}
              label={k.label}
              value=""
              loading
              className={k.span}
            />
          ))}
        </div>
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-6 w-36" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[220px] w-full sm:h-[260px]" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-24" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </CardContent>
          </Card>
          <Card className="lg:col-span-3">
            <CardHeader>
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-4 w-48" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
