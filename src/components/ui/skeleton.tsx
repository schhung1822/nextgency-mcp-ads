import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-xl bg-foreground/[0.07] dark:bg-foreground/[0.09]", className)}
      {...props}
    />
  )
}

export { Skeleton }
