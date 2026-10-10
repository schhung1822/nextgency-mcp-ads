import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-56 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-2xl" />
        ))}
      </CardContent>
    </Card>
  )
}

/** Content of a tip while it loads - the "Mẹo sử dụng" header and the tip menu (layout) stay on screen. */
export default function TipsLoading() {
  return (
    <div className="flex flex-col gap-4 sm:gap-6" aria-busy="true">
      <CardSkeleton rows={2} />
      <CardSkeleton rows={3} />
      <CardSkeleton rows={4} />
    </div>
  )
}
