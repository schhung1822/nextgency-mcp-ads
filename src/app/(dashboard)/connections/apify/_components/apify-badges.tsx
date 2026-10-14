import { LockKeyIcon, UserGroupIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { STATUS_TONE_CLASSES, type StatusTone } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { apify } from "@/lib/i18n/vi/apify"
import type {
  ApifyTokenDto,
  ApifyTokenScope,
  ApifyTokenStatus,
} from "@/lib/schemas/apify"

import { exhaustedUntilLabel } from "./apify-format"

const u = apify.ui

const STATUS_TONE: Record<ApifyTokenStatus, StatusTone> = {
  active: "success",
  exhausted: "warning",
  invalid: "danger",
  error: "danger",
  disabled: "neutral",
}

/**
 * Apify token status (same look as the Telegram / Drive status badges): Hoạt động · Hết credit tới 01/11 ·
 * Token không hợp lệ · Lỗi · Đã tắt.
 */
export function ApifyStatusBadge({
  token,
  className,
}: {
  token: Pick<ApifyTokenDto, "status" | "exhaustedUntil">
  className?: string
}) {
  const tone = STATUS_TONE[token.status] ?? "neutral"
  const t = STATUS_TONE_CLASSES[tone]
  const until = exhaustedUntilLabel(token)
  return (
    <Badge
      data-tone={tone}
      className={cn(
        "rounded-full font-medium whitespace-nowrap ring-1 ring-inset",
        t.badge,
        className
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", t.dot)}
      />
      {until
        ? u.exhaustedUntil(until)
        : (u.status[token.status] ?? token.status)}
    </Badge>
  )
}

/** Công ty (shared by every MCP that enables Apify) / Cá nhân (only the owner's MCPs). */
export function ApifyScopeBadge({
  scope,
  className,
}: {
  scope: ApifyTokenScope
  className?: string
}) {
  return (
    <Badge
      variant={scope === "company" ? "secondary" : "outline"}
      className={cn("rounded-full whitespace-nowrap", className)}
    >
      <HugeiconsIcon
        icon={scope === "company" ? UserGroupIcon : LockKeyIcon}
        strokeWidth={2}
        className="size-3.5"
        aria-hidden
      />
      {u.scope[scope] ?? scope}
    </Badge>
  )
}
