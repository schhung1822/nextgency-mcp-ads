"use client"

import * as React from "react"
import { cn } from "cn"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  /** accessible name when it should differ from the (short) visible label */
  ariaLabel?: string
}

/**
 * Segmented control (iOS / Shopify style) on Radix ToggleGroup (single): arrow-key navigation, the selected
 * segment is a raised card that is clearly different from the idle ones in both themes.
 * `fill`: "always" stretches it to the container with equal-width segments; "mobile" does that only below
 * `sm` (it hugs its content from `sm` up). `value=""` means "nothing selected" (a custom value).
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  fill,
  className,
}: {
  value: T | ""
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel: string
  fill?: "always" | "mobile"
  className?: string
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      // a single toggle group reports "" when the active item is pressed again - keep the selection
      onValueChange={(v) => v && onValueChange(v as T)}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex max-w-full items-stretch gap-1 rounded-2xl bg-muted p-1",
        fill === "always" && "flex w-full",
        fill === "mobile" && "flex w-full sm:inline-flex sm:w-auto",
        className
      )}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={cn(
            "inline-flex min-h-9 items-center justify-center rounded-xl px-2 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none sm:px-3 sm:text-sm",
            "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm data-[state=on]:ring-1 data-[state=on]:ring-border",
            "dark:data-[state=on]:bg-input/50",
            fill === "always" && "flex-auto",
            fill === "mobile" && "flex-auto sm:flex-none"
          )}
        >
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}
