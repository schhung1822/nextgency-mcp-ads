"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Add01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  BrandIcon,
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  FilterBar,
  RelativeTime,
  type FilterValues,
} from "@/components/app"
import { Button } from "@/components/ui/button"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import {
  NOTIFICATION_CHANNEL_STATUSES,
  type NotificationChannelDto,
} from "@/lib/schemas/notifications"

import {
  ChannelEventBadges,
  ChannelStatusBadge,
  chatLabel,
} from "../telegram/_components/telegram-badges"

const col = createDataTableColumnHelper<NotificationChannelDto>()

const HIDE_BELOW_2XL = "hidden @2xl:table-cell"
const HIDE_BELOW_3XL = "hidden @3xl:table-cell"
const HIDE_BELOW_4XL = "hidden @4xl:table-cell"

const detailHref = (id: string) => `/connections/telegram/${id}`

function buildColumns(isAdmin: boolean) {
  return col.columns([
    col.accessor("name", {
      header: m.list.colName,
      meta: { className: "w-full min-w-44 max-w-0" },
      cell: ({ row }) => (
        <Link
          href={detailHref(row.original.id)}
          title={row.original.name}
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <BrandIcon brand="telegram" />
          <span className="truncate">{row.original.name}</span>
        </Link>
      ),
    }),
    ...(isAdmin
      ? [
          col.accessor((r) => r.owner.name || r.owner.email, {
            id: "owner",
            header: m.list.colOwner,
            meta: { className: HIDE_BELOW_4XL, headerClassName: HIDE_BELOW_4XL },
            cell: ({ row }) => (
              <span
                className="block max-w-40 truncate text-muted-foreground"
                title={row.original.owner.email}
              >
                {row.original.owner.name || row.original.owner.email}
              </span>
            ),
          }),
        ]
      : []),
    col.accessor((r) => chatLabel(r), {
      id: "chat",
      header: m.list.colChat,
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ row }) => (
        <span className="flex max-w-56 min-w-0 flex-col">
          <span className="truncate" title={chatLabel(row.original)}>
            {chatLabel(row.original)}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {m.ui.chatTypes[row.original.chatType] ?? row.original.chatType}
          </span>
        </span>
      ),
    }),
    col.accessor("messageThreadId", {
      header: m.list.colThread,
      sortUndefined: "last",
      meta: {
        className: `${HIDE_BELOW_4XL} font-mono text-xs`,
        headerClassName: HIDE_BELOW_4XL,
      },
      cell: ({ getValue }) => getValue() ?? <span aria-hidden>—</span>,
    }),
    col.display({
      id: "events",
      header: m.list.colEvents,
      meta: { className: HIDE_BELOW_3XL, headerClassName: HIDE_BELOW_3XL },
      cell: ({ row }) => (
        <ChannelEventBadges
          events={row.original.events}
          allConnections={row.original.allConnections}
          max={2}
        />
      ),
    }),
    col.accessor("status", {
      header: m.list.colStatus,
      cell: ({ row }) => {
        const msg =
          row.original.status === "error" ? row.original.statusMessage : null
        return (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <ChannelStatusBadge status={row.original.status} />
            {/* the reason in one line (full text in the tooltip and on the detail page) */}
            {msg && (
              <span
                className="block max-w-56 truncate text-[13px] text-destructive"
                title={msg}
              >
                {msg}
              </span>
            )}
          </span>
        )
      },
    }),
    col.accessor("lastSentAt", {
      header: m.list.colLastSent,
      sortUndefined: "last",
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ getValue }) =>
        getValue() ? (
          <RelativeTime value={getValue()} className="text-muted-foreground" />
        ) : (
          <span className="text-muted-foreground">{m.list.neverSent}</span>
        ),
    }),
  ])
}

/** "Telegram" view of /connections: the notification channels the viewer may see (staff: own; admin: all). */
export function TelegramChannelsTable({
  channels,
  isAdmin,
  /** the page header already shows the one brand button → the empty-state CTA is outline */
  ctaVariant = "brand",
}: {
  channels: NotificationChannelDto[]
  isAdmin: boolean
  ctaVariant?: "brand" | "outline"
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])
  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const st = filters.status ?? []
    return channels.filter(
      (c) =>
        (st.length === 0 || st.includes(c.status)) &&
        (!q ||
          c.name.toLowerCase().includes(q) ||
          chatLabel(c).toLowerCase().includes(q) ||
          c.chatId.toLowerCase().includes(q) ||
          (isAdmin && c.owner.email.toLowerCase().includes(q)))
    )
  }, [channels, search, filters, isAdmin])

  if (channels.length === 0) {
    return (
      <EmptyState
        icon={Add01Icon}
        title={m.list.emptyTitle}
        description={m.list.emptyDescription}
        action={
          <Button variant={ctaVariant} asChild>
            <Link href="/connections/telegram/new">
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.list.add}
            </Link>
          </Button>
        }
      />
    )
  }

  return (
    <>
      <div className="border-b p-3">
        <FilterBar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: m.list.searchPlaceholder,
            label: m.list.searchLabel,
          }}
          filters={[
            {
              id: "status",
              label: m.list.filterStatus,
              options: NOTIFICATION_CHANNEL_STATUSES.map((s) => ({
                value: s,
                label: m.ui.status[s] ?? s,
                count: channels.filter((c) => c.status === s).length,
              })),
            },
          ]}
          values={filters}
          onValuesChange={setFilters}
        />
      </div>
      <DataTable
        ariaLabel={m.list.tableLabel}
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        defaultSorting={[{ id: "name", desc: false }]}
        pageSize={20}
        onRowClick={(r) => router.push(detailHref(r.id))}
        empty={
          <EmptyState
            title={m.list.emptyFilteredTitle}
            description={m.list.emptyFilteredDescription}
          />
        }
        renderMobileCard={(r) => (
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  <BrandIcon brand="telegram" />
                  <span className="line-clamp-2 break-words">{r.name}</span>
                </span>
                <ChannelStatusBadge status={r.status} className="shrink-0" />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                <span className="max-w-full truncate">
                  {m.list.colChat}: {chatLabel(r)}
                  {r.messageThreadId !== null && ` · #${r.messageThreadId}`}
                </span>
                <span>
                  {m.list.colLastSent}:{" "}
                  {r.lastSentAt ? (
                    <RelativeTime value={r.lastSentAt} />
                  ) : (
                    m.list.neverSent
                  )}
                </span>
                {isAdmin && (
                  <span className="max-w-full truncate">
                    {r.owner.name || r.owner.email}
                  </span>
                )}
              </div>
              <ChannelEventBadges
                events={r.events}
                allConnections={r.allConnections}
              />
              {r.status === "error" && r.statusMessage && (
                <p className="line-clamp-2 text-[13px] break-words text-destructive">
                  {r.statusMessage}
                </p>
              )}
            </div>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </div>
        )}
      />
    </>
  )
}
