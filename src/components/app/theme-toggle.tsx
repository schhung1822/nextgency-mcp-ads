"use client"

import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { common } from "@/lib/i18n/vi/common"

export const THEME_OPTIONS: {
  value: "light" | "dark" | "system"
  label: string
  icon: IconSvgElement
}[] = [
  { value: "light", label: common.theme.light, icon: Sun03Icon },
  { value: "dark", label: common.theme.dark, icon: Moon02Icon },
  { value: "system", label: common.theme.system, icon: ComputerIcon },
]

/** Radio items Sáng / Tối / Hệ thống - drop inside any DropdownMenuContent. */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
      {THEME_OPTIONS.map((o) => (
        <DropdownMenuRadioItem
          key={o.value}
          value={o.value}
          onSelect={(e) => e.preventDefault()}
        >
          <HugeiconsIcon icon={o.icon} strokeWidth={2} aria-hidden />
          {o.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** Icon button (sun/moon) opening the theme menu. */
export function ThemeToggle({ className }: { className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={common.theme.toggle}
          title={common.theme.label}
          className={className}
        >
          <HugeiconsIcon
            icon={Sun03Icon}
            strokeWidth={2}
            className="dark:hidden"
            aria-hidden
          />
          <HugeiconsIcon
            icon={Moon02Icon}
            strokeWidth={2}
            className="hidden dark:block"
            aria-hidden
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 min-w-0">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {common.theme.label}
        </DropdownMenuLabel>
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
