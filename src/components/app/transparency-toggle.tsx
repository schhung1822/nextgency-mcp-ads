"use client"

import * as React from "react"
import { BlurIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { common } from "@/lib/i18n/vi/common"

import {
  applyStoredTransparency,
  readReducedTransparency,
  setReducedTransparency,
  subscribeTransparency,
} from "./transparency"

/** Current "reduced transparency" preference + setter (synced across tabs). */
export function useReducedTransparency(): [
  boolean,
  (reduced: boolean) => void,
] {
  const reduced = React.useSyncExternalStore(
    subscribeTransparency,
    readReducedTransparency,
    () => false
  )
  return [reduced, setReducedTransparency]
}

/**
 * Re-applies the stored preference on mount, before paint (fallback when TransparencyScript did not run:
 * client-rendered root, dev Strict Mode remount resetting <html> attributes).
 */
export function useTransparencySync(): void {
  React.useLayoutEffect(() => {
    applyStoredTransparency()
  }, [])
}

export interface TransparencyToggleProps {
  /** show the helper sentence under the label (default true) */
  withDescription?: boolean
  className?: string
}

/** Switch "Giảm hiệu ứng trong suốt" - for settings/account pages. */
export function TransparencyToggle({
  withDescription = true,
  className,
}: TransparencyToggleProps) {
  const [reduced, setReduced] = useReducedTransparency()
  const id = React.useId()
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {common.transparency.label}
        </Label>
        {withDescription && (
          <p className="text-[13px] text-muted-foreground">
            {common.transparency.description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={reduced}
        onCheckedChange={(v) => setReduced(v === true)}
      />
    </div>
  )
}

/** Same preference as a checkbox item inside a DropdownMenu (user menu). */
export function TransparencyMenuItem() {
  const [reduced, setReduced] = useReducedTransparency()
  return (
    <DropdownMenuCheckboxItem
      checked={reduced}
      onCheckedChange={(v) => setReduced(v === true)}
      onSelect={(e) => e.preventDefault()}
    >
      <HugeiconsIcon icon={BlurIcon} strokeWidth={2} aria-hidden />
      {common.transparency.label}
    </DropdownMenuCheckboxItem>
  )
}
