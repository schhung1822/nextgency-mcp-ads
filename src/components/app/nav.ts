// Navigation config + pure helpers (no React, no icon imports - icons live in nav-icons.ts so tests stay light).

import { common } from "@/lib/i18n/vi/common"
import { notifications } from "@/lib/i18n/vi/notifications"

export type AppRole = "admin" | "staff"

export type NavIconKey =
  | "dashboard"
  | "connections"
  | "mcp"
  | "logs"
  | "tips"
  | "users"
  | "settings"
  | "account"
  | "menu"

export interface NavItem {
  title: string
  href: string
  /** key into NAV_ICONS (nav-icons.ts) */
  icon: NavIconKey
  /** visible only to admins */
  adminOnly?: boolean
  /** extra search terms for the command palette */
  keywords?: string[]
}

export const NAV_MAIN: NavItem[] = [
  {
    title: common.nav.dashboard,
    href: "/",
    icon: "dashboard",
    keywords: ["dashboard", "tong quan"],
  },
  {
    title: common.nav.connections,
    href: "/connections",
    icon: "connections",
    keywords: [
      "connections",
      "ket noi",
      "token",
      "meta",
      "tiktok",
      "google",
      "youtube",
      "openai",
      "telegram",
    ],
  },
  {
    title: common.nav.mcp,
    href: "/mcp-servers",
    icon: "mcp",
    keywords: ["mcp", "server", "ai", "claude", "chatgpt"],
  },
  {
    title: common.nav.logs,
    href: "/logs",
    icon: "logs",
    keywords: ["logs", "nhat ky", "lich su"],
  },
  {
    title: common.nav.automationTips,
    href: "/automation-tips",
    icon: "tips",
    keywords: [
      "meo",
      "tu dong",
      "lich",
      "schedule",
      "scheduled task",
      "skill",
      "cpa",
    ],
  },
]

export const NAV_ADMIN: NavItem[] = [
  {
    title: common.nav.users,
    href: "/users",
    icon: "users",
    adminOnly: true,
    keywords: ["users", "nguoi dung", "nhan vien"],
  },
  {
    title: common.nav.settings,
    href: "/settings",
    icon: "settings",
    adminOnly: true,
    keywords: ["settings", "cai dat"],
  },
]

export const NAV_ACCOUNT: NavItem = {
  title: common.nav.account,
  href: "/account",
  icon: "account",
  keywords: ["account", "tai khoan", "mat khau", "2fa"],
}

const NO_ITEMS: NavItem[] = []

export function navItemsForRole(role: AppRole): {
  main: NavItem[]
  admin: NavItem[]
} {
  return { main: NAV_MAIN, admin: role === "admin" ? NAV_ADMIN : NO_ITEMS }
}

/** One tab of the phone bottom bar (< 768px). */
export interface BottomNavItem {
  /** short label (11–12px under the icon) */
  label: string
  href: string
  icon: NavIconKey
}

/** Fixed bottom tabs on phones, in order; the 5th tab ("Menu") is not a link and is rendered by the shell. */
export const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { label: common.bottomNav.dashboard, href: "/", icon: "dashboard" },
  {
    label: common.bottomNav.connections,
    href: "/connections",
    icon: "connections",
  },
  { label: common.bottomNav.mcp, href: "/mcp-servers", icon: "mcp" },
  { label: common.bottomNav.logs, href: "/logs", icon: "logs" },
]

/** Main pages that do not fit the four bottom tabs - reachable from the "Menu" sheet on phones. */
const NAV_MAIN_OVERFLOW: NavItem[] = NAV_MAIN.filter(
  (i) => !BOTTOM_NAV_ITEMS.some((b) => b.href === i.href)
)

/**
 * Entries of the bottom bar's "Menu" sheet: main pages without a bottom tab, admin pages (admins only)
 * + the account page. Staff never receive admin items (the server still enforces the role on every route).
 */
export function bottomMenuItemsForRole(role: AppRole): {
  main: NavItem[]
  admin: NavItem[]
  account: NavItem
} {
  return {
    main: NAV_MAIN_OVERFLOW,
    admin: role === "admin" ? NAV_ADMIN : NO_ITEMS,
    account: NAV_ACCOUNT,
  }
}

/** The Menu tab is highlighted on pages that live inside the Menu sheet (not one of the 4 direct tabs). */
export function isBottomMenuActive(
  pathname: string | null | undefined
): boolean {
  if (!pathname) return false
  return [...NAV_MAIN_OVERFLOW, ...NAV_ADMIN, NAV_ACCOUNT].some((i) =>
    isNavActive(pathname, i.href)
  )
}

/** Active when the pathname equals the href or is nested under it ("/" only matches exactly). */
export function isNavActive(
  pathname: string | null | undefined,
  href: string
): boolean {
  if (!pathname) return false
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  if (href === "/") return clean === "/"
  return clean === href || clean.startsWith(`${href}/`)
}

export interface Crumb {
  label: string
  /** undefined for the current page */
  href?: string
}

const SEGMENT_LABELS: Record<string, string> = {
  new: common.nav.crumbNew,
  updates: common.nav.crumbUpdates,
  edit: common.nav.crumbEdit,
  dev: common.nav.crumbDev,
  ui: common.nav.crumbDevUi,
  telegram: notifications.ui.crumb,
}

/**
 * Derives top-bar breadcrumbs from a pathname using nav labels.
 * "/connections/new" → [Kết nối quảng cáo (link), Tạo mới]; unknown ids → "Chi tiết".
 */
export function buildBreadcrumbs(pathname: string | null | undefined): Crumb[] {
  if (!pathname || pathname === "/") return [{ label: common.nav.dashboard }]
  const segments = pathname.split("/").filter(Boolean)
  const all = [...NAV_MAIN, ...NAV_ADMIN, NAV_ACCOUNT]
  const crumbs: Crumb[] = []
  let acc = ""
  segments.forEach((seg, i) => {
    acc += `/${seg}`
    const nav = all.find((n) => n.href === acc)
    const label = nav?.title ?? SEGMENT_LABELS[seg] ?? common.nav.crumbDetail
    crumbs.push({ label, href: i < segments.length - 1 ? acc : undefined })
  })
  return crumbs
}
