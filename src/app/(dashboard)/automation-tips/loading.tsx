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

export default function AutomationTipsLoading() {
  return (
    <div className="flex w-full flex-col" aria-busy="true">
      <div className="space-y-2 pb-6">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-[28rem] max-w-full" />
      </div>
      <div className="flex flex-col gap-4 sm:gap-6">
        <CardSkeleton rows={2} />
        <CardSkeleton rows={3} />
        <CardSkeleton rows={4} />
      </div>
    </div>
  )
}
