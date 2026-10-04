import {
  DashboardSquare01Icon,
  McpServerIcon,
  MoreHorizontalIcon,
  Note01Icon,
  Plug01Icon,
  Settings01Icon,
  UserCircleIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"

import type { NavIconKey } from "./nav"

export const NAV_ICONS: Record<NavIconKey, IconSvgElement> = {
  dashboard: DashboardSquare01Icon,
  connections: Plug01Icon,
  mcp: McpServerIcon,
  logs: Note01Icon,
  users: UserGroupIcon,
  settings: Settings01Icon,
  account: UserCircleIcon,
  menu: MoreHorizontalIcon,
}
