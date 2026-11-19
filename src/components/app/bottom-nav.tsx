"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { CircleArrowUp02Icon, Logout01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"
import { useTheme } from "next-themes"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { common } from "@/lib/i18n/vi/common"

import {
  UpdateDot,
  UpdateLink,
  useHasUpdate,
  VersionLine,
} from "./app-version"
import {
  BOTTOM_NAV_ITEMS,
  bottomMenuItemsForRole,
  isBottomMenuActive,
  isNavActive,
  type NavItem,
} from "./nav"
import { MenuLegalLinks } from "./legal-links"
import { NAV_ICONS } from "./nav-icons"
import { THEME_OPTIONS } from "./theme-toggle"
import { TransparencyToggle } from "./transparency-toggle"
import {
  UserAvatar,
  UserIdentity,
  useSignOut,
  type AppUser,
  type SignOutProps,
} from "./user-menu"

/**
 * Marks <html data-kb-open> while a text field is focused and the on-screen keyboard has shrunk the viewport,
 * so the fixed bar (and the --app-bottom-offset it reserves) steps out of the way of the form.
 */
function useKeyboardOpenFlag() {
  React.useEffect(() => {
    const root = document.documentElement
    const vv = window.visualViewport
    let baseline = window.innerHeight
    let baselineWidth = window.innerWidth
    const isTextField = (el: Element | null) =>
      !!el &&
      el.matches(
        "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]), textarea, select, [contenteditable=true], [contenteditable='']"
      )
    const check = () => {
      if (window.innerWidth !== baselineWidth) {
        baselineWidth = window.innerWidth
        baseline = window.innerHeight
      }
      baseline = Math.max(baseline, window.innerHeight)
      const visible = Math.min(vv?.height ?? Infinity, window.innerHeight)
      const shrunk = baseline - visible > 120
      const open = isTextField(document.activeElement) && shrunk
      if (open) root.setAttribute("data-kb-open", "")
      else root.removeAttribute("data-kb-open")
    }
    const onFocusOut = () => window.setTimeout(check, 50)
    vv?.addEventListener("resize", check)
    window.addEventListener("resize", check)
    document.addEventListener("focusin", check)
    document.addEventListener("focusout", onFocusOut)
    return () => {
      vv?.removeEventListener("resize", check)
      window.removeEventListener("resize", check)
      document.removeEventListener("focusin", check)
      document.removeEventListener("focusout", onFocusOut)
      root.removeAttribute("data-kb-open")
    }
  }, [])
}

const TAB_CLASS =
  "group relative flex h-15 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-none font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 aria-[current=page]:font-semibold aria-[current=page]:text-brand-ink data-[active=true]:font-semibold data-[active=true]:text-brand-ink"

const PILL_CLASS =
  "flex h-8 w-14 items-center justify-center rounded-full transition-colors group-aria-[current=page]:bg-brand-primary/12 group-data-[active=true]:bg-brand-primary/12 dark:group-aria-[current=page]:bg-brand-primary/20 dark:group-data-[active=true]:bg-brand-primary/20"

function TabIcon({
  icon,
  active,
}: {
  icon: NavItem["icon"]
  active: boolean
}) {
  return (
    <span className={PILL_CLASS}>
      <HugeiconsIcon
        icon={NAV_ICONS[icon]}
        strokeWidth={active ? 2.5 : 2}
        className="size-5.5"
        aria-hidden
      />
    </span>
  )
}

/**
 * Fixed bottom tab bar for phones (< md): Tổng quan · Kết nối · MCP · Nhật ký · Menu. The Menu tab opens a bottom
 * sheet with the admin pages (admins only), Tài khoản, appearance and sign-out. Safe-area aware; hides while the
 * on-screen keyboard is open. Everything else that sticks to the bottom uses `--app-bottom-offset` (globals.css).
 */
export function BottomNav({
  user,
  appBaseUrl,
  signOutAction,
  onSignOut,
}: { user: AppUser; appBaseUrl?: string } & SignOutProps) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = React.useState(false)
  useKeyboardOpenFlag()

  // close the sheet after navigating from it
  const [lastPath, setLastPath] = React.useState(pathname)
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setMenuOpen(false)
  }

  const menuActive = isBottomMenuActive(pathname)
  const hasUpdate = useHasUpdate()
  return (
    <>
      <nav
        aria-label={common.bottomNav.label}
        data-slot="bottom-nav"
        className="glass-strong fixed inset-x-0 bottom-0 z-40 flex rounded-none border-x-0 border-b-0 px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {BOTTOM_NAV_ITEMS.map((item) => {
          const active = isNavActive(pathname, item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={TAB_CLASS}
            >
              <TabIcon icon={item.icon} active={active} />
              <span className="max-w-full truncate">{item.label}</span>
            </Link>
          )
        })}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          data-active={menuActive || menuOpen ? "true" : undefined}
          onClick={() => setMenuOpen(true)}
          className={TAB_CLASS}
        >
          <span className="relative">
            <TabIcon icon="menu" active={menuActive || menuOpen} />
            {hasUpdate && (
              <UpdateDot className="top-0.5 right-3.5 ring-background" />
            )}
          </span>
          <span className="max-w-full truncate">{common.bottomNav.menu}</span>
        </button>
      </nav>
      <BottomMenuSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        user={user}
        appBaseUrl={appBaseUrl}
        signOutAction={signOutAction}
        onSignOut={onSignOut}
        pathname={pathname}
      />
    </>
  )
}

function MenuLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? "bg-brand-primary/10 font-semibold text-brand-ink dark:bg-brand-primary/15"
          : "text-foreground hover:bg-accent"
      )}
    >
      <HugeiconsIcon
        icon={NAV_ICONS[item.icon]}
        strokeWidth={2}
        className="size-5"
        aria-hidden
      />
      {item.title}
    </Link>
  )
}

function BottomMenuSheet({
  open,
  onOpenChange,
  user,
  pathname,
  appBaseUrl,
  ...signOutProps
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: AppUser
  pathname: string | null
  appBaseUrl?: string
} & SignOutProps) {
  const signOut = useSignOut(signOutProps)
  const { theme, setTheme } = useTheme()
  const menu = bottomMenuItemsForRole(user.role)
  const hasUpdate = useHasUpdate()
  return (
    <>
      {signOut.form}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          data-slot="bottom-menu"
          className="max-h-[85dvh] gap-0 rounded-t-3xl pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="p-4 pr-14 pb-3">
            <SheetTitle className="sr-only">
              {common.bottomNav.menuTitle}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {common.bottomNav.menuDescription}
            </SheetDescription>
            <div className="flex items-center gap-3">
              <UserAvatar user={user} className="size-10" />
              <UserIdentity user={user} />
            </div>
            <span className="text-xs text-brand-ink">
              {user.role === "admin"
                ? common.user.roleAdmin
                : common.user.roleStaff}
            </span>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 pb-4">
            <div className="flex flex-col gap-0.5">
              {menu.main.map((item) => (
                <MenuLink
                  key={item.href}
                  item={item}
                  active={isNavActive(pathname, item.href)}
                />
              ))}
              {menu.admin.length > 0 && (
                <p className="px-3 pt-1 pb-1 text-xs font-medium text-muted-foreground">
                  {common.bottomNav.adminGroup}
                </p>
              )}
              {menu.admin.map((item) => (
                <MenuLink
                  key={item.href}
                  item={item}
                  active={isNavActive(pathname, item.href)}
                />
              ))}
              <MenuLink
                item={menu.account}
                active={isNavActive(pathname, menu.account.href)}
              />
              {hasUpdate && (
                <UpdateLink className="flex h-12 items-center gap-3 rounded-xl px-3 text-sm font-semibold text-brand-ink outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  <HugeiconsIcon
                    icon={CircleArrowUp02Icon}
                    strokeWidth={2}
                    className="size-5"
                    aria-hidden
                  />
                </UpdateLink>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-2xl bg-muted/60 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {common.bottomNav.appearance}
              </p>
              <div
                role="radiogroup"
                aria-label={common.theme.label}
                className="grid grid-cols-3 gap-1.5"
              >
                {THEME_OPTIONS.map((o) => {
                  const on = (theme ?? "system") === o.value
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setTheme(o.value)}
                      className={cn(
                        "flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        on
                          ? "bg-card text-brand-ink shadow-xs ring-1 ring-foreground/10"
                          : "text-muted-foreground"
                      )}
                    >
                      <HugeiconsIcon
                        icon={o.icon}
                        strokeWidth={2}
                        className="size-4"
                        aria-hidden
                      />
                      {o.label}
                    </button>
                  )
                })}
              </div>
              <TransparencyToggle />
            </div>

            <MenuLegalLinks appBaseUrl={appBaseUrl} />

            {signOut.enabled && (
              <button
                type="button"
                onClick={signOut.trigger}
                className="flex h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium text-destructive-strong outline-none hover:bg-destructive/10 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <HugeiconsIcon
                  icon={Logout01Icon}
                  strokeWidth={2}
                  className="size-5"
                  aria-hidden
                />
                {common.user.signOut}
              </button>
            )}
            <VersionLine className="px-3 pb-1 text-center" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
