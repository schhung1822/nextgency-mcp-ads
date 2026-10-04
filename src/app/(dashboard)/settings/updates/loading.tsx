import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

/** Same structure as the page: PageHeader (pb-6) -> version / notes / history (2/3) + updater (1/3). */
export default function UpdatesLoading() {
  return (
    <div className="flex w-full flex-col" aria-busy="true" aria-label={common.loading}>
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-xl" />
      </div>
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-4 sm:gap-6 lg:col-span-2">
          {[28, 40, 36].map((h, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-40" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="w-full" style={{ height: `${h * 4}px` }} />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-4 w-56 max-w-full" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
