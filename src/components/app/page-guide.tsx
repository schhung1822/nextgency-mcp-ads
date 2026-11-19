"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { BookOpen01Icon, SidebarRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { GuideDef } from "@/lib/guide-types"
import { guides } from "@/lib/i18n/vi/guides"

import { GuideBody } from "./guide-body"
import {
  createGuideStore,
  guideInitScript,
  guideStorageKey,
  setGuideCollapsed,
  type GuideStore,
} from "./guide-state"
import { InlineScript } from "./inline-script"
import { PlatformIcon } from "./platform-icon"
import type { Platform } from "./types"

const ui = guides.ui

interface GuideContextValue {
  store: GuideStore
  storageKey: string
  sheetOpen: boolean
  setSheetOpen: (open: boolean) => void
}

const GuideContext = React.createContext<GuideContextValue | null>(null)

function useGuideContext(): GuideContextValue {
  const ctx = React.useContext(GuideContext)
  if (!ctx) throw new Error("Guide components must be inside <GuideProvider>")
  return ctx
}

/** Owned by AppShell. `userId` scopes the remembered "Thu gọn" preference per person. */
export function GuideProvider({
  userId,
  children,
}: {
  userId?: string | null
  children: React.ReactNode
}) {
  const [store] = React.useState(() => createGuideStore())
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const storageKey = guideStorageKey(userId)
  // the docked panel is open by default on every page / step / tab: a new guide re-opens a collapsed panel
  React.useEffect(() => {
    let last = store.getSnapshot()?.guide ?? null
    return store.subscribe(() => {
      const next = store.getSnapshot()?.guide ?? null
      if (next && next !== last) setGuideCollapsed(false)
      last = next
    })
  }, [store])
  const value = React.useMemo(
    () => ({ store, storageKey, sheetOpen, setSheetOpen }),
    [store, storageKey, sheetOpen]
  )
  return (
    <GuideContext.Provider value={value}>
      {/* before-paint: collapsed users never see the docked panel flash open */}
      <InlineScript html={guideInitScript(storageKey)} />
      {children}
    </GuideContext.Provider>
  )
}

/**
 * Publishes a page's guide to the right-hand Guide panel (desktop) / guide sheet (phones and tablets).
 * Renders nothing. Mount it in any page or step component; when the content changes (wizard step, active tab)
 * pass the new `guide` and the panel updates. `guide` must be referentially stable between renders
 * (module constant from `t.guides`, or `useMemo`) - a new object each render re-publishes each time.
 *
 *   <PageGuide guide={t.guides.overview} />
 *   <PageGuide guide={{ title, ...provider.guide }} platform="meta" />
 */
export function PageGuide({
  guide,
  platform,
}: {
  guide: GuideDef
  platform?: Platform
}) {
  const { store } = useGuideContext()
  React.useEffect(() => {
    const token = store.register({ guide, platform })
    return () => store.unregister(token)
  }, [store, guide, platform])
  return null
}

function useRegisteredGuide() {
  const { store } = useGuideContext()
  return React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => null
  )
}

function useMounted() {
  return React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

function GuideIcon({
  platform,
  className,
}: {
  platform?: Platform
  className?: string
}) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-primary/10 text-brand-ink">
      {platform ? (
        <PlatformIcon platform={platform} className={className ?? "size-4"} />
      ) : (
        <HugeiconsIcon
          icon={BookOpen01Icon}
          strokeWidth={2}
          className={className ?? "size-4"}
          aria-hidden
        />
      )}
    </span>
  )
}

/**
 * Docked right panel (≥ lg). Visible by default; "Thu gọn" hides it (remembered per user) and the top bar
 * shows a "Hướng dẫn" button to bring it back. Server HTML renders the empty frame so the content column does
 * not jump when the page registers its guide after hydration.
 */
export function GuidePanel() {
  const entry = useRegisteredGuide()
  const mounted = useMounted()
  if (mounted && !entry) return null
  return (
    <aside
      data-slot="guide-panel"
      aria-label={ui.panelLabel}
      className="hidden shrink-0 pr-2 pb-2 lg:block lg:w-80 2xl:w-[22.5rem]"
    >
      <div className="sticky top-(--app-topbar-offset,0px) flex max-h-[calc(100dvh-var(--app-topbar-offset,0px)-4.75rem)] animate-in flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 duration-200 fade-in-0">
        <div className="flex items-center gap-2.5 border-b px-4 py-3">
          {entry ? (
            <>
              <GuideIcon platform={entry.platform} />
              <h2 className="min-w-0 flex-1 text-sm leading-5 font-semibold text-balance">
                {entry.guide.title}
              </h2>
            </>
          ) : (
            <>
              <GuideIcon />
              <Skeleton className="h-4 flex-1" />
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-mr-1.5 shrink-0 text-muted-foreground"
            onClick={() => setGuideCollapsed(true)}
          >
            <HugeiconsIcon
              icon={SidebarRight01Icon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
            {ui.collapse}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {entry ? (
            <GuideBody content={entry.guide} />
          ) : (
            <div className="flex flex-col gap-3" aria-hidden>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

/**
 * Top bar button, only when the current page has a guide. Phones/tablets (< lg): book icon + "Hướng dẫn" label that opens the
 * bottom sheet. Desktop: a labelled "Hướng dẫn" button that appears only while the panel is collapsed
 * (visibility is driven by html[data-guide-collapsed] in globals.css, so it is correct before hydration).
 */
export function GuideTopBarButton() {
  const { setSheetOpen } = useGuideContext()
  const entry = useRegisteredGuide()
  if (!entry) return null
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-slot="guide-sheet-trigger"
        aria-label={ui.open}
        className="max-md:h-10 pointer-coarse:h-10 lg:hidden"
        onClick={() => setSheetOpen(true)}
      >
        <HugeiconsIcon
          icon={BookOpen01Icon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
        {ui.expandTab}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-slot="guide-reopen"
        className="hidden"
        onClick={() => setGuideCollapsed(false)}
      >
        <HugeiconsIcon
          icon={BookOpen01Icon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
        {ui.expandTab}
      </Button>
    </>
  )
}

/** Bottom sheet used below lg: slides up from the bottom and covers ~80% of the screen. */
export function GuideSheet() {
  const { sheetOpen, setSheetOpen } = useGuideContext()
  const entry = useRegisteredGuide()
  const pathname = usePathname()

  // navigating away or growing into the docked layout closes the sheet
  React.useEffect(() => {
    setSheetOpen(false)
  }, [pathname, setSheetOpen])
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const onChange = () => {
      if (mq.matches) setSheetOpen(false)
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [setSheetOpen])

  if (!entry) return null
  return (
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
      <SheetContent
        side="bottom"
        data-slot="guide-sheet"
        className="gap-0 overflow-hidden rounded-t-3xl bg-popover! backdrop-blur-none! data-[side=bottom]:h-[80dvh] data-[side=bottom]:max-h-[80dvh] data-[side=bottom]:overflow-hidden lg:hidden"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-foreground/15" />
        <SheetHeader className="flex-row items-center gap-2.5 border-b p-4 pr-14">
          <GuideIcon platform={entry.platform} />
          <SheetTitle className="min-w-0 flex-1 text-sm leading-5 font-semibold text-balance">
            {entry.guide.title}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {ui.sheetDescription}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <GuideBody content={entry.guide} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
