import {
  Folder01Icon,
  GoogleSheetIcon,
  LockKeyIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { STATUS_TONE_CLASSES, type StatusTone } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import type {
  DriveSourceKindDto,
  DriveSourceScopeDto,
  DriveStatusDto,
} from "@/lib/schemas/drive"

const m = driveUi.ui

const STATUS_TONE: Record<DriveStatusDto, StatusTone> = {
  active: "success",
  error: "danger",
  disabled: "neutral",
}

/** Drive source / credential status: Hoạt động / Lỗi / Đã tắt (same look as the Telegram status badge). */
export function DriveStatusBadge({
  status,
  label,
  className,
}: {
  /** null = not configured (system credential) */
  status: DriveStatusDto | null
  label?: string
  className?: string
}) {
  const tone: StatusTone = status ? (STATUS_TONE[status] ?? "neutral") : "neutral"
  const t = STATUS_TONE_CLASSES[tone]
  return (
    <Badge
      data-tone={tone}
      className={cn(
        "rounded-full font-medium ring-1 ring-inset",
        t.badge,
        className
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      {label ?? (status ? (m.status[status] ?? status) : m.notConfigured)}
    </Badge>
  )
}

/** Folder / Google Sheet icon (Google Sheet green, folder muted). */
export function DriveKindIcon({
  kind,
  className,
}: {
  kind: DriveSourceKindDto
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={kind === "sheet" ? GoogleSheetIcon : Folder01Icon}
      strokeWidth={2}
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        kind === "sheet" ? "text-success" : "text-muted-foreground",
        className
      )}
    />
  )
}

export function DriveKindBadge({
  kind,
  className,
}: {
  kind: DriveSourceKindDto
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn("rounded-full", className)}>
      <DriveKindIcon kind={kind} className="size-3.5" />
      {m.kind[kind] ?? kind}
    </Badge>
  )
}

/** Công ty (shared) / Riêng (personal). */
export function DriveScopeBadge({
  scope,
  className,
}: {
  scope: DriveSourceScopeDto
  className?: string
}) {
  return (
    <Badge
      variant={scope === "company" ? "secondary" : "outline"}
      className={cn("rounded-full", className)}
    >
      <HugeiconsIcon
        icon={scope === "company" ? UserGroupIcon : LockKeyIcon}
        strokeWidth={2}
        className="size-3.5"
        aria-hidden
      />
      {m.scope[scope] ?? scope}
    </Badge>
  )
}
