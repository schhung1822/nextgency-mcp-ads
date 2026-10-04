import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export default function UsersLoading() {
  return (
    <div className="flex w-full flex-col" aria-busy="true">
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-4xl" />
      </div>
      <Card className="gap-0 py-0">
        <div className="flex gap-4 border-b px-4 py-3">
          {[20, 28, 24, 20].map((w, i) => (
            <Skeleton key={i} className="h-5" style={{ width: `${w * 4}px` }} />
          ))}
        </div>
        <div className="border-b p-3">
          <Skeleton className="h-9 w-full max-w-sm rounded-4xl" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <Skeleton className="size-9 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3.5 w-56 max-w-full" />
            </div>
            <Skeleton className="hidden h-5 w-20 rounded-full sm:block" />
            <Skeleton className="hidden h-5 w-16 rounded-full md:block" />
          </div>
        ))}
      </Card>
    </div>
  )
}
