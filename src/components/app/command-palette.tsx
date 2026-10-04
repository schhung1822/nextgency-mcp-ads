"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { common } from "@/lib/i18n/vi/common"

export interface CommandPaletteItem {
  label: string
  href: string
  icon?: IconSvgElement
  /** muted text on the right, e.g. platform name */
  hint?: string
  keywords?: string[]
}

export interface CommandPaletteGroup {
  heading: string
  items: CommandPaletteItem[]
}

export interface CommandPaletteProps {
  groups: CommandPaletteGroup[]
  /** hide the trigger button (palette still opens with ⌘K / Ctrl+K) */
  hideTrigger?: boolean
  className?: string
}

/** Same breakpoint as the guide panel: from lg up the palette is a centred dialog, below it a bottom sheet. */
const DESKTOP_QUERY = "(min-width: 1024px)"

function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function useIsDesktop() {
  return React.useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true
  )
}

/**
 * While the on-screen keyboard is up (it shrinks the *visual* viewport, not the layout one, on iOS and modern
 * Android) a `bottom: 0` sheet would sit behind it. Returns the inline style that lifts the sheet above the
 * keyboard and caps its height to what is actually visible; `undefined` when no keyboard (the 80dvh classes rule).
 */
function useKeyboardAwareSheetStyle(active: boolean): React.CSSProperties | undefined {
  const [style, setStyle] = React.useState<React.CSSProperties>()
  React.useEffect(() => {
    if (!active) return
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop
      // ignore pinch-zoom (scale != 1) and tiny browser-chrome changes; the keyboard is > 120px
      if (vv.scale !== 1 || window.innerHeight - vv.height < 120) {
        setStyle(undefined)
        return
      }
      const lift = Math.max(0, covered)
      const maxHeight = Math.min(window.innerHeight * 0.8, vv.height - 8)
      setStyle({ bottom: lift, height: maxHeight, maxHeight })
    }
    update()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
      setStyle(undefined)
    }
  }, [active])
  return style
}

/** The result groups; items are 44px+ tall on the sheet (touch) and 40px in the desktop dialog. */
function PaletteGroups({
  groups,
  onSelect,
  sheet,
}: {
  groups: CommandPaletteGroup[]
  onSelect: (href: string) => void
  sheet?: boolean
}) {
  return (
    <>
      <CommandEmpty className="py-10 text-muted-foreground">
        {common.commandPalette.empty}
      </CommandEmpty>
      {groups.map((g, gi) => (
        <React.Fragment key={g.heading}>
          {gi > 0 && <CommandSeparator className="mx-2 my-2" />}
          <CommandGroup
            heading={g.heading}
            className="p-0 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pt-1 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:tracking-wide **:[[cmdk-group-heading]]:uppercase [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-0.5"
          >
            {g.items.map((item) => (
              <CommandItem
                key={`${g.heading}-${item.href}`}
                value={`${item.label} ${item.href}`}
                keywords={item.keywords}
                onSelect={() => onSelect(item.href)}
                className={cn(
                  "gap-3 rounded-xl! px-3 data-selected:bg-foreground/[0.06] dark:data-selected:bg-white/10",
                  sheet ? "min-h-12 text-[15px]" : "h-10 text-[14px]"
                )}
              >
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground group-data-selected/command-item:bg-background group-data-selected/command-item:text-foreground",
                    sheet ? "size-8" : "size-7"
                  )}
                >
                  <HugeiconsIcon
                    icon={item.icon ?? ArrowRight01Icon}
                    strokeWidth={2}
                    className="size-4"
                    aria-hidden
                  />
                </span>
                <span className="truncate">{item.label}</span>
                {item.hint && (
                  // data-slot hides CommandItem's own (invisible) tick so the hint sits flush right
                  <span
                    data-slot="command-shortcut"
                    className="ml-auto text-xs text-muted-foreground"
                  >
                    {item.hint}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </React.Fragment>
      ))}
    </>
  )
}

/** ⌘K / Ctrl+K quick navigation (pages + optional MCP/connection items). */
export function CommandPalette({
  groups,
  hideTrigger,
  className,
}: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const isDesktop = useIsDesktop()
  const sheetStyle = useKeyboardAwareSheetStyle(open && !isDesktop)

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <>
      {!hideTrigger && (
        <>
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            className={cn(
              "hidden h-9 w-56 justify-start gap-2 rounded-xl bg-card/50 px-3 font-normal text-muted-foreground shadow-none md:inline-flex lg:w-72",
              className
            )}
          >
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden />
            <span className="flex-1 text-left">
              {common.commandPalette.placeholder}
            </span>
            <KbdGroup aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(true)}
            aria-label={common.commandPalette.open}
            title={common.commandPalette.open}
            className="size-10 md:hidden"
          >
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden />
          </Button>
        </>
      )}

      {isDesktop ? (
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          title={common.commandPalette.title}
          description={common.commandPalette.description}
          // Concentric radii: dialog 20px = inner 12px + 8px padding. Fixed width keeps it calm on desktop.
          className="top-[18%] w-[calc(100%-2rem)] max-w-xl rounded-[20px]! sm:max-w-xl"
        >
          <Command
            className={cn(
              "rounded-none bg-transparent p-2",
              // search field: full width, 44px tall, same 12px radius as the items
              "[&_[data-slot=command-input-wrapper]]:p-0",
              "[&_[data-slot=input-group]]:h-11 [&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:border-transparent [&_[data-slot=input-group]]:bg-muted/60 [&_[data-slot=input-group]]:px-1",
              "[&_[data-slot=command-input]]:text-[15px]"
            )}
          >
            <CommandInput
              placeholder={common.commandPalette.placeholder}
              aria-label={common.commandPalette.title}
            />
            <CommandList className="mt-2 max-h-[min(60vh,26rem)] scroll-py-2">
              <PaletteGroups groups={groups} onSelect={go} />
            </CommandList>
            <div
              className="mt-2 flex items-center justify-end gap-4 border-t border-border/60 px-2 pt-2 text-[11px] text-muted-foreground"
              aria-hidden
            >
              <span className="flex items-center gap-1.5">
                <KbdGroup>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </KbdGroup>
                {common.commandPalette.footerNavigate}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                {common.commandPalette.footerOpen}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd>
                {common.commandPalette.footerClose}
              </span>
            </div>
          </Command>
        </CommandDialog>
      ) : (
        // Phones/tablets: bottom sheet, 80% of the screen like the guide sheet (solid surface, grab handle).
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            data-slot="search-sheet"
            style={sheetStyle}
            className="gap-0 overflow-hidden rounded-t-3xl bg-popover! backdrop-blur-none! data-[side=bottom]:h-[80dvh] data-[side=bottom]:max-h-[80dvh] data-[side=bottom]:overflow-hidden"
          >
            <div
              aria-hidden
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-foreground/15"
            />
            <SheetTitle className="sr-only">
              {common.commandPalette.title}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {common.commandPalette.description}
            </SheetDescription>
            <Command
              className={cn(
                "h-auto min-h-0 flex-1 rounded-none bg-transparent p-0",
                // 48px field, 12px radius; 16px text so iOS Safari does not zoom the page on focus
                "[&_[data-slot=command-input-wrapper]]:p-0",
                "[&_[data-slot=input-group]]:h-12 [&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:border-transparent [&_[data-slot=input-group]]:bg-muted/60 [&_[data-slot=input-group]]:px-1",
                "[&_[data-slot=command-input]]:text-base"
              )}
            >
              <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
                <div className="min-w-0 flex-1">
                  <CommandInput
                    placeholder={common.commandPalette.placeholder}
                    aria-label={common.commandPalette.title}
                    enterKeyHint="go"
                    autoComplete="off"
                    autoCorrect="off"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  className="h-12 shrink-0 rounded-xl px-3 text-[15px] font-medium text-muted-foreground"
                >
                  {common.commandPalette.close}
                </Button>
              </div>
              <CommandList className="max-h-none min-h-0 flex-1 scroll-py-2 overscroll-contain border-t border-border/60 px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                <PaletteGroups groups={groups} onSelect={go} sheet />
              </CommandList>
            </Command>
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
