import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

/** Same structure as the wizard: header → stepper → card with choice tiles + footer. */
export default function Loading() {
  return (
    <div
      className="flex w-full flex-col gap-6"
      aria-busy="true"
      aria-label={common.loading}
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="hidden h-4 w-28 md:block" />
          </div>
        ))}
      </div>
      <Card className="gap-5 p-5">
        <Skeleton className="h-6 w-56" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
        <Skeleton className="h-6 w-40" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
        <div className="flex justify-end gap-2">
          <Skeleton className="h-10 w-28 rounded-xl" />
        </div>
      </Card>
    </div>
  )
}
