"use client"

// "Liên kết cho ứng dụng": the 3 public legal pages (/privacy, /terms, /data-deletion) whose ABSOLUTE URLs are pasted
// into developer apps (Meta App Dashboard, OpenAI). Each row opens the page in a new tab + copies its URL.
// Origin = the configured public app URL (passed from the server layout), else window.location.origin.
import * as React from "react"
import {
  Copy01Icon,
  Delete02Icon,
  LegalDocument01Icon,
  Shield01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { legal as tl } from "@/lib/i18n/vi/legal"
import { LEGAL_PAGES, legalPageUrl, type LegalPageKey } from "@/lib/legal"

import { useCopy } from "./use-copy"

export const LEGAL_ICONS: Record<LegalPageKey, IconSvgElement> = {
  privacy: Shield01Icon,
  terms: LegalDocument01Icon,
  dataDeletion: Delete02Icon,
}

/** Copies the absolute URL of a legal page; `copiedPath` flags the last copied row for a short tick. */
function useLegalCopy(appBaseUrl?: string) {
  const { copy, copied } = useCopy({ toastMessage: tl.links.copied })
  const [copiedPath, setCopiedPath] = React.useState<string | null>(null)
  const copyPath = React.useCallback(
    async (path: string) => {
      const ok = await copy(
        legalPageUrl(path, appBaseUrl, window.location.origin)
      )
      setCopiedPath(ok ? path : null)
    },
    [appBaseUrl, copy]
  )
  return { copyPath, copiedPath: copied ? copiedPath : null }
}

/** Sidebar footer block (desktop/tablet). Hidden while the sidebar is collapsed to the icon rail. */
export function SidebarLegalLinks({ appBaseUrl }: { appBaseUrl?: string }) {
  const { copyPath, copiedPath } = useLegalCopy(appBaseUrl)
  return (
    <SidebarGroup
      data-slot="sidebar-legal-links"
      className="p-0 group-data-[collapsible=icon]:hidden"
    >
      <SidebarGroupLabel className="h-7 px-2">
        {tl.links.title}
      </SidebarGroupLabel>
      <SidebarMenu className="gap-0.5">
        {LEGAL_PAGES.map((pg) => {
          const label = tl.nav[pg.key]
          const done = copiedPath === pg.path
          return (
            <SidebarMenuItem key={pg.path}>
              <SidebarMenuButton
                size="sm"
                asChild
                className="pr-8 text-sidebar-foreground/75"
              >
                <a
                  href={pg.path}
                  target="_blank"
                  rel="noopener"
                  aria-label={tl.links.open(label)}
                >
                  <HugeiconsIcon
                    icon={LEGAL_ICONS[pg.key]}
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span>{label}</span>
                </a>
              </SidebarMenuButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuAction
                    aria-label={tl.links.copy(label)}
                    onClick={() => void copyPath(pg.path)}
                  >
                    <HugeiconsIcon
                      icon={done ? Tick02Icon : Copy01Icon}
                      strokeWidth={2}
                      aria-hidden
                    />
                  </SidebarMenuAction>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {tl.links.copy(label)}
                </TooltipContent>
              </Tooltip>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

/** Same 3 links for the phone "Menu" bottom sheet (no sidebar below md). */
export function MenuLegalLinks({
  appBaseUrl,
  className,
}: {
  appBaseUrl?: string
  className?: string
}) {
  const { copyPath, copiedPath } = useLegalCopy(appBaseUrl)
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <p className="px-3 pt-1 pb-1 text-xs font-medium text-muted-foreground">
        {tl.links.title}
      </p>
      {LEGAL_PAGES.map((pg) => {
        const label = tl.nav[pg.key]
        const done = copiedPath === pg.path
        return (
          <div key={pg.path} className="flex items-center gap-1">
            <a
              href={pg.path}
              target="_blank"
              rel="noopener"
              aria-label={tl.links.open(label)}
              className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <HugeiconsIcon
                icon={LEGAL_ICONS[pg.key]}
                strokeWidth={2}
                className="size-5"
                aria-hidden
              />
              <span className="truncate">{label}</span>
            </a>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="size-12 rounded-xl"
              aria-label={tl.links.copy(label)}
              onClick={() => void copyPath(pg.path)}
            >
              <HugeiconsIcon
                icon={done ? Tick02Icon : Copy01Icon}
                strokeWidth={2}
                className="size-5"
                aria-hidden
              />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
