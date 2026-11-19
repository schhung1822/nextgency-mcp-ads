"use client"

import { cn } from "cn"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { users as tUsers } from "@/lib/i18n/vi/users"

import type { Role } from "./types"

const ROLES: Role[] = ["staff", "admin"]

/** Segmented choice of the two roles: radio cards with a one-line explanation each (create + change role). */
export function RolePicker({
  id,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  id: string
  value: Role
  onChange: (role: Role) => void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v === "admin" ? "admin" : "staff")}
      aria-label={ariaLabel}
      disabled={disabled}
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {ROLES.map((r) => (
        <label
          key={r}
          htmlFor={`${id}-${r}`}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-2xl border bg-input/20 p-3.5 transition-colors",
            "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
            "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-primary/5",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <RadioGroupItem value={r} id={`${id}-${r}`} className="mt-0.5" />
          <span className="grid gap-0.5">
            <span className="text-sm leading-5 font-medium">{tUsers.roles[r]}</span>
            <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">{tUsers.roleShort[r]}</span>
          </span>
        </label>
      ))}
    </RadioGroup>
  )
}
