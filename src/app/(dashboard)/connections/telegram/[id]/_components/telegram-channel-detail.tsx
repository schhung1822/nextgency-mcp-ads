"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import {
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Key01Icon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
  SentIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  BrandIcon,
  ConfirmDialog,
  ContextualSaveBar,
  createDataTableColumnHelper,
  DataTable,
  PageGuide,
  PageHeader,
  RelativeTime,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatDate, formatDateTime } from "@/lib/format"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import {
  telegramChannelSettingsFormSchema,
  type NotificationChannelDetail,
  type NotificationDeliveryDto,
  type TelegramChannelSettingsFormValues,
} from "@/lib/schemas/notifications"
import {
  deleteTelegramChannelAction,
  recheckTelegramChannelAction,
  sendTelegramTestAction,
  setTelegramChannelEnabledAction,
  updateTelegramChannelAction,
} from "@/server/actions/notification-channels"

import {
  ChannelStatusBadge,
  DeliveryStatusBadge,
} from "../../_components/telegram-badges"
import { TelegramSettingsFields } from "../../_components/telegram-settings-fields"
import { ReplaceTokenDialog } from "./replace-token-dialog"

type Busy = null | "test" | "recheck" | "toggle"

const SETTINGS_FORM_ID = "telegram-settings-form"

function settingsDefaults(
  d: NotificationChannelDetail
): TelegramChannelSettingsFormValues {
  return {
    name: d.name,
    chatId: d.chatId,
    messageThreadId:
      d.messageThreadId === null ? "" : String(d.messageThreadId),
    events: [...d.events],
    allConnections: d.allConnections,
  }
}

export function TelegramChannelDetailView({
  detail,
  deliveries,
  isAdmin,
  twoFactorEnabled,
  justCreated,
}: {
  detail: NotificationChannelDetail
  deliveries: NotificationDeliveryDto[]
  isAdmin: boolean
  twoFactorEnabled: boolean
  /** arrived from "Kiểm tra & lưu": suggest a test message */
  justCreated: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<Busy>(null)
  const [replaceOpen, setReplaceOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  // unsaved settings: the save bar holds the one brand button; the header action waits (outline + disabled)
  const [settingsDirty, setSettingsDirty] = React.useState(false)
  const [refreshing, startRefresh] = React.useTransition()
  const disabled = detail.status === "disabled"

  const sendTest = async () => {
    setBusy("test")
    const res = await sendTelegramTestAction({ channelId: detail.id })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.ok) toast.success(res.message ?? m.server.testSent)
    else
      toast.error(m.detail.testFailed, {
        description: res.data.error ?? undefined,
      })
    router.refresh()
  }

  const recheck = async () => {
    setBusy("recheck")
    const res = await recheckTelegramChannelAction({ channelId: detail.id })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.ok) toast.success(res.message ?? m.server.rechecked)
    else
      toast.error(m.detail.recheckFailed, {
        description: res.data.statusMessage ?? undefined,
      })
    router.refresh()
  }

  const toggle = async (enabled: boolean) => {
    setBusy("toggle")
    const res = await setTelegramChannelEnabledAction({
      channelId: detail.id,
      enabled,
    })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(
      res.message ?? (enabled ? m.server.enabled : m.server.disabled)
    )
    router.refresh()
  }

  const primaryVariant = settingsDirty ? "outline" : "brand"
  const primaryButton = disabled ? (
    <Button
      variant={primaryVariant}
      onClick={() => void toggle(true)}
      disabled={busy !== null || settingsDirty}
    >
      {busy === "toggle" ? (
        <Spinner aria-hidden />
      ) : (
        <HugeiconsIcon
          icon={PlayIcon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
      )}
      {m.detail.enable}
    </Button>
  ) : (
    <Button
      variant={primaryVariant}
      onClick={() => void sendTest()}
      disabled={busy !== null || settingsDirty}
    >
      {busy === "test" ? (
        <Spinner aria-hidden />
      ) : (
        <HugeiconsIcon
          icon={SentIcon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
      )}
      {busy === "test" ? m.detail.sending : m.detail.sendTest}
    </Button>
  )
  // a disabled button gets no hover/focus: the focusable wrapper carries the "save first" tooltip
  const primary = settingsDirty ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-4xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {primaryButton}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? m.detail.saveFirstEnable : m.detail.saveFirstTest}
      </TooltipContent>
    </Tooltip>
  ) : (
    primaryButton
  )

  return (
    <>
      <PageGuide guide={tg.telegramDetail} />
      <PageHeader
        title={detail.name}
        titleMeta={
          <>
            <Badge variant="outline" className="rounded-full">
              <BrandIcon brand="telegram" className="size-3.5" />
              {m.ui.typeLabel}
            </Badge>
            <ChannelStatusBadge status={detail.status} />
          </>
        }
        backHref="/connections?tab=telegram"
        primaryAction={primary}
        secondaryActions={[
          {
            label: m.detail.recheck,
            icon: Refresh01Icon,
            onSelect: () => void recheck(),
            disabled: busy !== null,
          },
          {
            label: m.detail.replaceToken,
            icon: Key01Icon,
            onSelect: () => setReplaceOpen(true),
          },
          ...(disabled
            ? []
            : [
                {
                  label: m.detail.disable,
                  icon: PauseIcon,
                  onSelect: () => void toggle(false),
                  disabled: busy !== null,
                },
              ]),
          {
            label: m.detail.delete,
            icon: Delete02Icon,
            destructive: true,
            onSelect: () => setDeleteOpen(true),
          },
        ]}
      />

      <SettingsForm
        key={detail.updatedAt}
        detail={detail}
        isAdmin={isAdmin}
        onSaved={() => router.refresh()}
        onDirtyChange={setSettingsDirty}
      >
        {justCreated && deliveries.length === 0 && !disabled && (
          <Alert>
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              aria-hidden
            />
            <AlertTitle>{m.detail.createdTitle}</AlertTitle>
            <AlertDescription>{m.detail.createdHint}</AlertDescription>
          </Alert>
        )}
        {detail.status === "error" && detail.statusMessage && (
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertTitle>{m.detail.statusAlert.error}</AlertTitle>
            <AlertDescription>{detail.statusMessage}</AlertDescription>
          </Alert>
        )}
        {disabled && (
          <Alert>
            <HugeiconsIcon icon={PauseIcon} strokeWidth={2} aria-hidden />
            <AlertTitle>{m.detail.statusAlert.disabled}</AlertTitle>
            <AlertDescription>{m.detail.disabledHint}</AlertDescription>
          </Alert>
        )}
      </SettingsForm>

      <DeliveriesCard
        deliveries={deliveries}
        refreshing={refreshing}
        onRefresh={() => startRefresh(() => router.refresh())}
      />

      <ReplaceTokenDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        channelId={detail.id}
        credentialHint={detail.credentialHint}
        twoFactorEnabled={twoFactorEnabled}
        onReplaced={() => router.refresh()}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        destructive
        title={m.remove.title}
        description={m.remove.description(detail.name)}
        confirmText={detail.name}
        confirmLabel={m.remove.confirm}
        onConfirm={async () => {
          const res = await deleteTelegramChannelAction({
            channelId: detail.id,
          })
          if (!res.ok) {
            toast.error(res.error)
            return false
          }
          toast.success(res.message ?? m.server.deleted)
          router.push("/connections?tab=telegram")
        }}
      >
        {detail.usedBy.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl border p-3 text-sm">
            <span className="font-medium">{m.remove.affected}</span>
            <UsageList detail={detail} />
          </div>
        )}
      </ConfirmDialog>
    </>
  )
}

// ---------------------------------------------------------------------------

/** Contextual save bar + alerts + "Cài đặt" form (2/3) and the info / usage cards (1/3). */
function SettingsForm({
  detail,
  isAdmin,
  onSaved,
  onDirtyChange,
  children,
}: {
  detail: NotificationChannelDetail
  isAdmin: boolean
  onSaved: () => void
  /** the page header turns its brand action into a disabled outline while there are unsaved changes */
  onDirtyChange: (dirty: boolean) => void
  /** status alerts rendered above the cards */
  children?: React.ReactNode
}) {
  const defaults = React.useMemo(() => settingsDefaults(detail), [detail])
  const form = useForm<TelegramChannelSettingsFormValues>({
    resolver: zodResolver(telegramChannelSettingsFormSchema),
    defaultValues: defaults,
    mode: "onTouched",
  })
  const [error, setError] = React.useState<string | null>(null)
  const dirty = form.formState.isDirty
  React.useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  // remounted (key = updatedAt) or left: the header action is usable again
  React.useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null)
    // only what changed travels (a chat / thread change is re-checked with Telegram)
    const patch: Record<string, unknown> = {}
    if (v.name.trim() !== defaults.name) patch.name = v.name
    if (v.chatId.trim() !== defaults.chatId) patch.chatId = v.chatId
    if (v.messageThreadId.trim() !== defaults.messageThreadId)
      patch.messageThreadId = v.messageThreadId
    const sortedNew = [...v.events].sort().join(",")
    if (sortedNew !== [...defaults.events].sort().join(","))
      patch.events = v.events
    if (isAdmin && v.allConnections !== defaults.allConnections)
      patch.allConnections = v.allConnections
    if (Object.keys(patch).length === 0) {
      form.reset(v)
      return
    }
    const res = await updateTelegramChannelAction({
      channelId: detail.id,
      ...patch,
    })
    if (!res.ok) {
      let placed = false
      for (const k of [
        "name",
        "chatId",
        "messageThreadId",
        "events",
        "allConnections",
      ] as const) {
        const msg = res.fieldErrors?.[k]
        if (msg) {
          form.setError(k, { message: msg })
          placed = true
        }
      }
      if (!placed) setError(res.error)
      return
    }
    toast.success(res.message ?? m.detail.saved)
    form.reset(v)
    onSaved()
  })

  return (
    <div className="flex flex-col gap-5">
      {/* top of the content column, right under the page header (06-ui-design-system.md §10) */}
      <ContextualSaveBar
        open={dirty}
        formId={SETTINGS_FORM_ID}
        saving={form.formState.isSubmitting}
        onDiscard={() => {
          setError(null)
          form.reset(defaults)
        }}
        className="mb-0"
      />
      {children}
      <div className="grid items-start gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{m.detail.editTitle}</CardTitle>
            <CardDescription>{m.detail.editDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              id={SETTINGS_FORM_ID}
              onSubmit={onSubmit}
              noValidate
              className="flex flex-col gap-5"
            >
              <TelegramSettingsFields
                control={form.control}
                isAdmin={isAdmin}
                idPrefix="tg-edit"
              />
              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  {error}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-5">
          <InfoCard detail={detail} />
          <UsageCard detail={detail} />
        </div>
      </div>
    </div>
  )
}

function InfoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

function InfoCard({ detail }: { detail: NotificationChannelDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.detail.infoTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3">
          <InfoRow label={m.detail.bot}>
            <span className="font-medium">@{detail.botUsername}</span>
            <span className="block font-mono text-xs text-muted-foreground">
              {m.detail.botId}: {detail.botId}
            </span>
          </InfoRow>
          <InfoRow label={m.detail.chat}>
            <span className="font-medium">
              {detail.chatTitle ?? detail.chatId}
            </span>
            <span className="block text-[13px] text-muted-foreground">
              {m.ui.chatTypes[detail.chatType] ?? detail.chatType} ·{" "}
              <span className="font-mono text-xs">{detail.chatId}</span>
            </span>
          </InfoRow>
          <InfoRow label={m.detail.thread}>
            {detail.messageThreadId !== null ? (
              <span className="font-mono">#{detail.messageThreadId}</span>
            ) : (
              <span className="text-muted-foreground">{m.ui.noThread}</span>
            )}
          </InfoRow>
          <InfoRow label={m.detail.token}>
            <span className="font-mono text-[13px]">
              {m.ui.tokenHint(detail.credentialHint)}
            </span>
          </InfoRow>
          <InfoRow label={m.detail.owner}>
            <span className="break-all">
              {detail.owner.name || detail.owner.email}
            </span>
            {detail.owner.name && (
              <span className="block text-[13px] break-all text-muted-foreground">
                {detail.owner.email}
              </span>
            )}
          </InfoRow>
          <InfoRow label={m.detail.lastSent}>
            {detail.lastSentAt ? (
              <RelativeTime value={detail.lastSentAt} />
            ) : (
              <span className="text-muted-foreground">{m.detail.never}</span>
            )}
          </InfoRow>
          {detail.lastErrorAt && (
            <InfoRow label={m.detail.lastError}>
              <RelativeTime value={detail.lastErrorAt} />
            </InfoRow>
          )}
          <InfoRow label={m.detail.createdAt}>
            <span className="tabular-nums">{formatDate(detail.createdAt)}</span>
          </InfoRow>
        </dl>
      </CardContent>
    </Card>
  )
}

function UsageList({ detail }: { detail: NotificationChannelDetail }) {
  const visible = detail.usedBy.filter((u) => u.id !== null && u.name !== null)
  const hidden = detail.usedBy.length - visible.length
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {visible.map((u) => (
        <li key={u.id}>
          <Link
            href={`/mcp-servers/${u.id}`}
            className="flex min-h-9 items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-muted"
          >
            <span className="min-w-0 break-words">{u.name}</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </Link>
        </li>
      ))}
      {hidden > 0 && (
        <li className="px-2 text-muted-foreground">
          {m.detail.usedByOther(hidden)}
        </li>
      )}
    </ul>
  )
}

function UsageCard({ detail }: { detail: NotificationChannelDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.detail.usedByTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {detail.usedBy.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.detail.usedByNone}</p>
        ) : (
          <UsageList detail={detail} />
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

const dcol = createDataTableColumnHelper<NotificationDeliveryDto>()

function deliveryDetail(d: NotificationDeliveryDto): string {
  return d.status === "failed" && d.errorMessage ? d.errorMessage : d.preview
}

function DeliveriesCard({
  deliveries,
  refreshing,
  onRefresh,
}: {
  deliveries: NotificationDeliveryDto[]
  refreshing: boolean
  onRefresh: () => void
}) {
  const columns = React.useMemo(
    () =>
      dcol.columns([
        dcol.accessor("createdAt", {
          header: m.detail.colTime,
          meta: { className: "whitespace-nowrap tabular-nums" },
          cell: ({ getValue }) => formatDateTime(getValue()),
        }),
        dcol.accessor("source", {
          header: m.detail.colSource,
          meta: {
            className: "hidden whitespace-nowrap @2xl:table-cell",
            headerClassName: "hidden @2xl:table-cell",
          },
          cell: ({ getValue }) => m.ui.sources[getValue()] ?? getValue(),
        }),
        dcol.accessor("eventType", {
          header: m.detail.colEvent,
          meta: { className: "whitespace-nowrap" },
          cell: ({ getValue }) => m.ui.eventTypes[getValue()] ?? getValue(),
        }),
        dcol.accessor("status", {
          header: m.detail.colStatus,
          cell: ({ row }) => (
            <span
              title={
                row.original.attempts > 1
                  ? m.detail.attempts(row.original.attempts)
                  : undefined
              }
            >
              <DeliveryStatusBadge status={row.original.status} />
            </span>
          ),
        }),
        dcol.display({
          id: "detail",
          header: m.detail.colDetail,
          meta: {
            className:
              "hidden w-full max-w-0 min-w-56 whitespace-normal @3xl:table-cell",
            headerClassName: "hidden @3xl:table-cell",
          },
          cell: ({ row }) => {
            const text = deliveryDetail(row.original)
            return (
              <span
                title={text}
                className={
                  row.original.status === "failed"
                    ? "line-clamp-2 text-destructive"
                    : "line-clamp-2 text-muted-foreground"
                }
              >
                {text}
              </span>
            )
          },
        }),
        dcol.display({
          id: "mcp",
          header: m.detail.colMcp,
          meta: {
            className: "hidden @4xl:table-cell",
            headerClassName: "hidden @4xl:table-cell",
          },
          cell: ({ row }) =>
            row.original.mcp ? (
              <Link
                href={`/mcp-servers/${row.original.mcp.id}`}
                className="block max-w-40 truncate hover:underline"
                title={row.original.mcp.name}
              >
                {row.original.mcp.name}
              </Link>
            ) : (
              <span aria-hidden className="text-muted-foreground">
                —
              </span>
            ),
        }),
      ]),
    []
  )

  return (
    <Card className="@container mt-5 gap-0 pb-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>{m.detail.deliveriesTitle}</CardTitle>
        <CardDescription>{m.detail.deliveriesDescription}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-10"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing || undefined}
          >
            {refreshing ? (
              <Spinner aria-hidden />
            ) : (
              <HugeiconsIcon
                icon={Refresh01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
            )}
            {m.detail.refresh}
          </Button>
        </CardAction>
      </CardHeader>
      {deliveries.length === 0 ? (
        <CardContent className="py-8 text-sm text-muted-foreground">
          {m.detail.noDeliveries}
        </CardContent>
      ) : (
        <DataTable
          ariaLabel={m.detail.deliveriesTable}
          columns={columns}
          data={deliveries}
          getRowId={(r) => r.id}
          pageSize={10}
          renderMobileCard={(d) => (
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-medium">
                  {m.ui.eventTypes[d.eventType] ?? d.eventType}
                </span>
                <DeliveryStatusBadge status={d.status} className="shrink-0" />
              </div>
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {formatDateTime(d.createdAt)} ·{" "}
                {m.ui.sources[d.source] ?? d.source}
                {d.mcp && ` · ${d.mcp.name}`}
              </span>
              <span
                className={
                  d.status === "failed"
                    ? "line-clamp-2 text-[13px] break-words text-destructive"
                    : "line-clamp-2 text-[13px] break-words text-muted-foreground"
                }
              >
                {deliveryDetail(d)}
              </span>
            </div>
          )}
        />
      )}
    </Card>
  )
}
