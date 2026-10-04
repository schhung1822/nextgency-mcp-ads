import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

function CardSkeleton({ rows = 2, avatar }: { rows?: number; avatar?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        {avatar && <Skeleton className="h-[72px] w-full rounded-2xl" />}
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-4xl" />
        ))}
      </CardContent>
    </Card>
  )
}

export default function AccountLoading() {
  return (
    <div className="flex w-full flex-col" aria-busy="true">
      <div className="space-y-2 pb-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-5 lg:col-span-2">
          <CardSkeleton rows={1} avatar />
          <CardSkeleton rows={3} />
          <CardSkeleton rows={4} />
        </div>
        <div className="flex flex-col gap-5">
          <CardSkeleton rows={2} />
          <CardSkeleton rows={3} />
        </div>
      </div>
    </div>
  )
}
