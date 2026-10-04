import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { common } from "@/lib/i18n/vi/common"

/** Same structure as the page: PageHeader (pb-6) → form cards (2/3) + API versions (1/3) → system info. */
export default function SettingsLoading() {
  return (
    <div
      className="flex w-full flex-col"
      aria-busy="true"
      aria-label={common.loading}
    >
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>
      <div className="flex flex-col gap-4 sm:gap-6">
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-3 lg:items-start">
          <div className="flex flex-col gap-4 sm:gap-6 lg:col-span-2">
            {[0, 1].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-4 w-72 max-w-full" />
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <Skeleton className="h-9 w-32" />
                  <Skeleton className="h-9 w-32" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-4 w-56 max-w-full" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
