import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-6" aria-busy="true" aria-label={common.loading}>
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-9 w-36 rounded-xl" />
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Card className="gap-3 p-5 lg:col-span-2">
          <Skeleton className="h-6 w-48" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </Card>
        <Card className="gap-3 p-5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </Card>
      </div>
    </div>
  )
}
