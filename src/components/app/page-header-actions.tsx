"use client"

import Link from "next/link"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { common } from "@/lib/i18n/vi/common"

export interface PageHeaderAction {
  label: string
  /** navigate on select */
  href?: string
  /** client-side handler (only when PageHeader is rendered from a client component) */
  onSelect?: () => void
  icon?: IconSvgElement
  /** red text + separated at the bottom of the menu */
  destructive?: boolean
  disabled?: boolean
}

/** "Thêm ▾" dropdown holding the secondary page actions. */
export function PageHeaderMoreActions({
  actions,
  label = common.pageHeader.moreActions,
}: {
  actions: PageHeaderAction[]
  label?: string
}) {
  const normal = actions.filter((a) => !a.destructive)
  const danger = actions.filter((a) => a.destructive)
  const renderItem = (a: PageHeaderAction) => {
    const content = (
      <>
        {a.icon && <HugeiconsIcon icon={a.icon} strokeWidth={2} aria-hidden />}
        {a.label}
      </>
    )
    return (
      <DropdownMenuItem
        key={a.label}
        disabled={a.disabled}
        variant={a.destructive ? "destructive" : "default"}
        onSelect={a.onSelect}
        asChild={!!a.href && !a.disabled}
      >
        {a.href && !a.disabled ? <Link href={a.href}>{content}</Link> : content}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {label}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            data-icon="inline-end"
            aria-hidden
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        {normal.map(renderItem)}
        {normal.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
        {danger.map(renderItem)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
