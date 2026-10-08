import { cn } from "cn"

import { STATUS_TONE_CLASSES, type StatusTone } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import type {
  DeliveryStatus,
  NotificationChannelStatus,
  NotificationEvent,
} from "@/lib/schemas/notifications"

const CHANNEL_TONE: Record<NotificationChannelStatus, StatusTone> = {
  active: "success",
  error: "danger",
  disabled: "neutral",
}

const DELIVERY_TONE: Record<DeliveryStatus, StatusTone> = {
  sent: "success",
  pending: "info",
  failed: "danger",
}

function ToneBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone
  label: string
  className?: string
}) {
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
      {label}
    </Badge>
  )
}

/** Telegram channel status: Hoạt động / Lỗi / Đã tắt. */
export function ChannelStatusBadge({
  status,
  className,
}: {
  status: NotificationChannelStatus
  className?: string
}) {
  return (
    <ToneBadge
      tone={CHANNEL_TONE[status] ?? "neutral"}
      label={m.ui.status[status] ?? status}
      className={className}
    />
  )
}

/** Delivery status: Đã gửi / Đang chờ / Thất bại. */
export function DeliveryStatusBadge({
  status,
  className,
}: {
  status: DeliveryStatus
  className?: string
}) {
  return (
    <ToneBadge
      tone={DELIVERY_TONE[status] ?? "neutral"}
      label={m.ui.deliveryStatus[status] ?? status}
      className={className}
    />
  )
}

/**
 * Subscribed system events as small outline pills ("Cảnh báo kết nối", "Cập nhật hệ thống", "Mọi kết nối").
 * `max`: one line (table cell) - the first `max` pills, the rest folded into "+N" (listed in its tooltip).
 */
export function ChannelEventBadges({
  events,
  allConnections,
  max,
  className,
}: {
  events: NotificationEvent[]
  allConnections: boolean
  max?: number
  className?: string
}) {
  if (events.length === 0 && !allConnections) {
    return (
      <span
        className={cn(
          "text-[13px] text-muted-foreground",
          max !== undefined && "whitespace-nowrap",
          className
        )}
      >
        {m.list.noEvents}
      </span>
    )
  }
  const chips = [
    ...events.map((e) => ({
      key: e,
      short: m.ui.events[e].short,
      label: m.ui.events[e].label,
    })),
    ...(allConnections
      ? [
          {
            key: "all",
            short: m.ui.allConnectionsShort,
            label: m.form.allConnectionsLabel,
          },
        ]
      : []),
  ]
  const shown = max === undefined ? chips : chips.slice(0, max)
  const hidden = chips.slice(shown.length)
  return (
    <span
      className={cn(
        "flex gap-1",
        max === undefined ? "flex-wrap" : "flex-nowrap whitespace-nowrap",
        className
      )}
    >
      {shown.map((c) => (
        <Badge
          key={c.key}
          variant="outline"
          className="rounded-full text-xs"
          title={c.label}
        >
          {c.short}
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Badge
          variant="secondary"
          className="rounded-full text-xs tabular-nums"
          title={hidden.map((c) => c.label).join(", ")}
        >
          {m.list.moreEvents(hidden.length)}
        </Badge>
      )}
    </span>
  )
}

/** "Nhóm Marketing" / "@channel" + chat type. */
export function chatLabel(c: { chatTitle: string | null; chatId: string }): string {
  return c.chatTitle || c.chatId
}
