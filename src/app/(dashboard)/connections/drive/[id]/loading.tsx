import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

/** Same structure as the page: header → file grid (2/3) + info / usage cards (1/3). */
export default function Loading() {
  return (
    <div
      className="flex w-full flex-col gap-6"
      aria-busy="true"
      aria-label={common.loading}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72 max-w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-9 w-36 rounded-xl" />
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-3">
        <Card className="gap-4 p-5 xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-9 w-48 rounded-2xl" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="aspect-video w-full rounded-xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        </Card>
        <div className="flex flex-col gap-5">
          <Card className="gap-3 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </Card>
          <Card className="gap-3 p-5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-8 w-full" />
          </Card>
        </div>
      </div>
    </div>
  )
}
