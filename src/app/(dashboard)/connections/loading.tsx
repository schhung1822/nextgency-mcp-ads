import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-6" aria-busy="true" aria-label={common.loading}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-xl" />
      </div>
      <Card className="gap-3 p-4">
        <Skeleton className="h-8 w-full max-w-md" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  )
}
