import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

/** Same structure as the page: PageHeader (pb-6) → tabs + filter card (gap-4). */
export default function LogsLoading() {
  return (
    <div
      className="flex w-full flex-col"
      aria-busy="true"
      aria-label={common.loading}
    >
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 rounded-xl" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64 rounded-full" />
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap gap-2 border-b p-3">
            <Skeleton className="h-9 w-full md:w-72" />
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-28 rounded-full" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
          <div className="flex flex-col divide-y">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-40 max-md:hidden" />
                <Skeleton className="ml-auto h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
