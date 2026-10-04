import {
  Alert02Icon,
  Clock01Icon,
  FileExportIcon,
  Key01Icon,
  Login01Icon,
  Logout01Icon,
  McpServerIcon,
  Plug01Icon,
  SecurityCheckIcon,
  Settings01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { RelativeTime, StatusBadge } from "@/components/app"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatIp } from "@/lib/format-ip"
import { account as tAccount } from "@/lib/i18n/vi/account"

export interface ActivityItem {
  id: string
  createdAt: string
  /** activity_logs.action (e.g. "auth.login.success") */
  action: string
  status: "success" | "failure"
  ip: string | null
  device: string | null
}

/** Icon per action family so the list scans like a timeline. */
function iconFor(action: string, failure: boolean): IconSvgElement {
  if (failure) return Alert02Icon
  if (action === "auth.login.success") return Login01Icon
  if (action === "auth.logout") return Logout01Icon
  if (action.startsWith("auth.password") || action === "mcp.key.reveal" || action === "mcp.key.rotate") return Key01Icon
  if (action.startsWith("auth.") || action.startsWith("setup.")) return SecurityCheckIcon
  if (action.startsWith("user.")) return UserGroupIcon
  if (action.startsWith("connection.")) return Plug01Icon
  if (action.startsWith("mcp.")) return McpServerIcon
  if (action.startsWith("settings.")) return Settings01Icon
  if (action.startsWith("logs.")) return FileExportIcon
  return Clock01Icon
}

/** "Hoạt động của tôi": last N actions as a timeline-style list (label · failure badge / device · IP / relative time). */
export function ActivityCard({ items }: { items: ActivityItem[] }) {
  const t = tAccount.activity
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <ol className="divide-y" data-testid="my-activity">
            {items.map((a) => {
              const failure = a.status === "failure"
              const meta = [a.device, formatIp(a.ip)].filter(Boolean).join(" · ")
              return (
                <li key={a.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl",
                      failure ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
                    )}
                  >
                    <HugeiconsIcon icon={iconFor(a.action, failure)} strokeWidth={1.75} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-5 font-medium">
                      <span title={a.action}>{tAccount.actionLabels[a.action] ?? t.unknownAction}</span>
                      {failure && <StatusBadge kind="log" status="error" label={t.failure} />}
                    </p>
                    {meta && <p className="text-[13px] leading-5 break-words text-muted-foreground">{meta}</p>}
                  </div>
                  <RelativeTime value={a.createdAt} className="mt-0.5 shrink-0 text-[13px] text-muted-foreground" />
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
