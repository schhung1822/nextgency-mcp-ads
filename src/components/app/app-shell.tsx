"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { common } from "@/lib/i18n/vi/common"
import { legal as tl } from "@/lib/i18n/vi/legal"
import { LEGAL_PAGES } from "@/lib/legal"
import type { SystemNotice } from "@/lib/system-notices"

import { SidebarVersion } from "./app-version"
import { BottomNav } from "./bottom-nav"
import { BrandLogo, BrandMark } from "./brand-logo"
import { CommandPalette, type CommandPaletteGroup } from "./command-palette"
import { FeedbackButton } from "./feedback-button"
import { LEGAL_ICONS, SidebarLegalLinks } from "./legal-links"
import {
  buildBreadcrumbs,
  isNavActive,
  NAV_ACCOUNT,
  navItemsForRole,
  type NavItem,
} from "./nav"
import { NAV_ICONS } from "./nav-icons"
import { NoticeTicker } from "./notice-ticker"
import {
  GuidePanel,
  GuideProvider,
  GuideSheet,
  GuideTopBarButton,
} from "./page-guide"
import { ThemeToggle } from "./theme-toggle"
import { useTransparencySync } from "./transparency-toggle"
import {
  SidebarUserMenu,
  type AppUser,
  type SignOutProps,
} from "./user-menu"

export type { AppUser }

export interface AppShellProps extends SignOutProps {
  user: AppUser
  children: React.ReactNode
  /** replaces the auto breadcrumb (derived from the pathname) in the top bar */
  breadcrumb?: React.ReactNode
  /** right side of the top bar before the theme toggle - e.g. notification bell */
  topBarExtra?: React.ReactNode
  /** extra ⌘K groups (MCP servers, connections…) appended after the pages */
  commandGroups?: CommandPaletteGroup[]
  /** initial desktop sidebar state (read the `sidebar_state` cookie in the layout) */
  defaultSidebarOpen?: boolean
  /** system notices (Nextgency webhook) scrolled in the top bar; a second strip under the bar on phones */
  notices?: readonly SystemNotice[]
  /** public app URL (BETTER_AUTH_URL) for the "Liên kết cho ứng dụng" copy buttons; falls back to window.location */
  appBaseUrl?: string
}

/**
 * Dashboard frame: floating glass sidebar (collapsible to icons, Sheet on mobile) +
 * sticky glass top bar (breadcrumb, ⌘K search, slot, theme, user menu). Role-aware nav.
 */
export function AppShell({
  user,
  children,
  breadcrumb,
  topBarExtra,
  commandGroups,
  defaultSidebarOpen = true,
  notices = [],
  appBaseUrl,
  signOutAction,
  onSignOut,
}: AppShellProps) {
  const pathname = usePathname()
  useTransparencySync()
  const nav = navItemsForRole(user.role)
  const hasNotices = notices.length > 0

  const paletteGroups = React.useMemo<CommandPaletteGroup[]>(
    () => [
      {
        heading: common.commandPalette.pages,
        items: [...nav.main, ...nav.admin, NAV_ACCOUNT].map((n) => ({
          label: n.title,
          href: n.href,
          icon: NAV_ICONS[n.icon],
          keywords: n.keywords,
        })),
      },
      ...(commandGroups ?? []),
      {
        heading: tl.links.paletteGroup,
        items: LEGAL_PAGES.map((pg) => ({
          label: tl.metaTitle[pg.key],
          href: pg.path,
          icon: LEGAL_ICONS[pg.key],
          keywords: ["privacy", "terms", "policy", "chinh sach", "dieu khoan", "xoa du lieu", "data deletion"],
        })),
      },
    ],
    [nav.main, nav.admin, commandGroups]
  )

  return (
    <GuideProvider userId={user.id}>
    <SidebarProvider
      defaultOpen={defaultSidebarOpen}
      style={{ "--sidebar-width": "16.5rem" } as React.CSSProperties}
    >
      <TabletAutoCollapse />
      <Sidebar
        variant="floating"
        collapsible="icon"
        aria-label={common.nav.label}
      >
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                asChild
                tooltip={common.appName}
                className="hover:bg-transparent"
              >
                <Link href="/" aria-label={common.appName}>
                  {/* full logo when the sidebar is expanded; the square mark only in the icon rail */}
                  <BrandLogo
                    height={30}
                    priority
                    className="group-data-[collapsible=icon]:hidden"
                  />
                  <BrandMark
                    size={32}
                    priority
                    className="hidden group-data-[collapsible=icon]:block"
                  />
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <NavGroup items={nav.main} pathname={pathname} />
          {nav.admin.length > 0 && (
            <NavGroup
              label={common.nav.adminGroup}
              items={nav.admin}
              pathname={pathname}
            />
          )}
        </SidebarContent>
        <SidebarFooter>
          <SidebarVersion isAdmin={user.role === "admin"} />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarUserMenuWithContext
                user={user}
                signOutAction={signOutAction}
                onSignOut={onSignOut}
              />
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarLegalLinks appBaseUrl={appBaseUrl} />
        </SidebarFooter>
        <SidebarRail
          aria-label={common.nav.toggleSidebar}
          title={common.nav.toggleSidebar}
        />
      </Sidebar>
      {/*
        Frame rhythm (8px grid): from md the floating sidebar and the top bar sit 8px from the window edges and
        8px from each other; page content is inset from the top bar's edges (16px tablets, 24px desktop).
        Phones (< md) are full-bleed: the top bar is a flush full-width bar, there is no sidebar (the fixed
        bottom bar navigates) and cards run edge to edge (globals.css "phone full-bleed"). Deliberately not
        <SidebarInset> (a <main>) so the <header> banner stays outside the main landmark.
      */}
      <div
        data-slot="sidebar-inset"
        className={cn(
          "relative flex min-w-0 flex-1 flex-col md:[--app-topbar-offset:4.5rem]",
          // phones: the notice strip (h-11) sits under the 3.5rem bar inside the same sticky header
          hasNotices
            ? "[--app-topbar-offset:calc(6.25rem+env(safe-area-inset-top))]"
            : "[--app-topbar-offset:calc(3.5rem+env(safe-area-inset-top))]"
        )}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-popover focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-popover-foreground focus:shadow-lg focus:ring-1 focus:ring-foreground/10"
        >
          {common.nav.skipToContent}
        </a>
        <header className="sticky top-0 z-30 md:px-4 md:pt-2 md:pr-2 md:pl-0">
          <div
            data-slot="app-topbar"
            className="glass rounded-2xl max-md:pt-[env(safe-area-inset-top)]"
          >
            <div className="flex h-14 items-center gap-1 px-3 sm:gap-2">
              <SidebarTrigger
                aria-label={common.nav.toggleSidebar}
                title={common.nav.toggleSidebar}
                className="pointer-coarse:size-10 max-md:hidden"
              />
              <Separator
                orientation="vertical"
                className="mx-1 hidden data-[orientation=vertical]:h-5 md:block"
              />
              <Link
                href="/"
                className="relative shrink-0 rounded-lg outline-none after:absolute after:-inset-1.5 after:content-[''] focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
                aria-label={common.appName}
              >
                <BrandLogo height={26} priority />
              </Link>
              <div className="flex min-w-0 flex-1 items-center gap-4 pl-2 md:pl-0">
                <div
                  className={cn(
                    "min-w-0 flex-1",
                    // the ticker takes the free space between the breadcrumb and the search box
                    hasNotices && "md:max-w-[45%] md:flex-none"
                  )}
                >
                  {breadcrumb ?? <AutoBreadcrumb pathname={pathname} />}
                </div>
                {hasNotices && (
                  <NoticeTicker
                    notices={notices}
                    className="mr-1 flex-1 max-md:hidden"
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
                <GuideTopBarButton />
                <CommandPalette groups={paletteGroups} />
                {topBarExtra}
                {/* phones: appearance lives in the bottom bar's Menu sheet */}
                <ThemeToggle className="pointer-coarse:size-10 max-md:hidden" />
              </div>
            </div>
            {hasNotices && (
              <div className="flex h-11 items-center border-t border-foreground/5 px-3 md:hidden">
                <NoticeTicker notices={notices} className="flex-1" />
              </div>
            )}
          </div>
        </header>
        <div className="flex min-w-0 flex-1 items-stretch">
          <main
            id="main-content"
            tabIndex={-1}
            className="flex min-w-0 flex-1 flex-col pt-4 outline-none max-md:px-4 max-md:pb-[calc(var(--app-bottom-offset,0px)+1.5rem)] max-md:[--page-gutter:1rem] md:pt-6 md:pr-6 md:pb-[calc(3rem+env(safe-area-inset-bottom))] md:pl-4 lg:pr-5 lg:pl-6"
          >
            {children}
          </main>
          <GuidePanel />
        </div>
      </div>
      <GuideSheet />
      <FeedbackButton />
      <BottomNav
        user={user}
        appBaseUrl={appBaseUrl}
        signOutAction={signOutAction}
        onSignOut={onSignOut}
      />
    </SidebarProvider>
    </GuideProvider>
  )
}

function NavGroup({
  label,
  items,
  pathname,
}: {
  label?: string
  items: NavItem[]
  pathname: string | null
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <SidebarGroup>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = isNavActive(pathname, item.href)
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.title}
                  className={cn(
                    "font-medium text-sidebar-foreground/85 pointer-coarse:h-10",
                    "data-[active=true]:bg-brand-primary/10 data-[active=true]:font-semibold data-[active=true]:text-brand-ink",
                    "dark:data-[active=true]:bg-brand-primary/15"
                  )}
                >
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      if (isMobile) setOpenMobile(false)
                    }}
                  >
                    <HugeiconsIcon
                      icon={NAV_ICONS[item.icon]}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function SidebarUserMenuWithContext(props: { user: AppUser } & SignOutProps) {
  const { isMobile } = useSidebar()
  return <SidebarUserMenu {...props} isMobile={isMobile} />
}

function AutoBreadcrumb({ pathname }: { pathname: string | null }) {
  const crumbs = buildBreadcrumbs(pathname)
  return (
    <Breadcrumb aria-label={common.nav.breadcrumb}>
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 && <BreadcrumbSeparator className="hidden sm:block" />}
            <BreadcrumbItem
              className={cn(
                "min-w-0",
                i < crumbs.length - 1 && "hidden sm:inline-flex"
              )}
            >
              {c.href ? (
                <BreadcrumbLink asChild>
                  <Link href={c.href}>{c.label}</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage className="truncate font-medium">
                  {c.label}
                </BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

/**
 * 768–1279px: start with the sidebar collapsed to icons (spec §5) - up to 1279 because the docked Guide panel
 * (≥ 1024) needs the room; restore when growing to a wide desktop. The user can still expand it by hand.
 */
function TabletAutoCollapse() {
  const { setOpen } = useSidebar()
  const setOpenRef = React.useRef(setOpen)
  React.useEffect(() => {
    setOpenRef.current = setOpen
  })
  React.useEffect(() => {
    const tablet = window.matchMedia(
      "(min-width: 768px) and (max-width: 1279px)"
    )
    let auto = false
    const apply = () => {
      if (tablet.matches) {
        auto = true
        setOpenRef.current(false)
      } else if (auto && window.innerWidth >= 1280) {
        auto = false
        setOpenRef.current(true)
      }
    }
    apply()
    tablet.addEventListener("change", apply)
    return () => tablet.removeEventListener("change", apply)
  }, [])
  return null
}
