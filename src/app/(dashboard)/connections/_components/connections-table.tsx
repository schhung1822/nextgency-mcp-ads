"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Add01Icon,
  ArrowRight01Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  BrandIcon,
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  FilterBar,
  getStatusMeta,
  PageGuide,
  PageHeader,
  PlatformBadge,
  PlatformIcon,
  RelativeTime,
  StatusBadge,
  statusValues,
  type FilterValues,
} from "@/components/app"
import { StatusHint } from "@/components/mcp/status-hint"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PLATFORM_LABELS } from "@/lib/constants"
import { formatDate } from "@/lib/format"
import { connections as m } from "@/lib/i18n/vi/connections"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { notifications as tn } from "@/lib/i18n/vi/notifications"
import {
  CONNECTION_PLATFORMS,
  statusTooltip,
  type ConnectionListItem,
} from "@/lib/schemas/connections"
import type { NotificationChannelDto } from "@/lib/schemas/notifications"

import { TelegramChannelsTable } from "./telegram-channels-table"

/** view tab of the Telegram notification channels (next to the platform tabs) */
export const TELEGRAM_TAB = "telegram"

const col = createDataTableColumnHelper<ConnectionListItem>()

// Columns appear as the card gets wider (container queries → right on a narrow tablet layout too).
const HIDE_BELOW_2XL = "hidden @2xl:table-cell"
const HIDE_BELOW_3XL = "hidden @3xl:table-cell"
const HIDE_BELOW_4XL = "hidden @4xl:table-cell"

function buildColumns(isAdmin: boolean) {
  return col.columns([
    col.accessor("name", {
      header: m.list.colName,
      // w-full + max-w-0: the name column takes the leftover width and truncates instead of stretching the table
      meta: { className: "w-full min-w-44 max-w-0" },
      cell: ({ row }) => (
        <Link
          href={`/connections/${row.original.id}`}
          title={row.original.name}
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <PlatformIcon platform={row.original.platform} colored />
          <span className="truncate">{row.original.name}</span>
        </Link>
      ),
    }),
    col.accessor("platform", {
      header: m.list.colPlatform,
      meta: { className: HIDE_BELOW_3XL, headerClassName: HIDE_BELOW_3XL },
      cell: ({ getValue }) => <PlatformBadge platform={getValue()} />,
    }),
    ...(isAdmin
      ? [
          col.accessor((r) => r.owner.name || r.owner.email, {
            id: "owner",
            header: m.list.colOwner,
            meta: {
              className: HIDE_BELOW_4XL,
              headerClassName: HIDE_BELOW_4XL,
            },
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
    col.accessor("accountCount", {
      header: m.list.colAccounts,
      meta: { align: "end", className: "tabular-nums" },
      cell: ({ row }) => (
        <span
          title={m.list.accountsOf(
            row.original.enabledAccountCount,
            row.original.accountCount
          )}
        >
          {row.original.accountCount}
        </span>
      ),
    }),
    col.accessor("status", {
      header: m.list.colStatus,
      cell: ({ row }) => (
        <span title={statusTooltip(row.original)}>
          <StatusBadge kind="connection" status={row.original.status} />
        </span>
      ),
    }),
    col.accessor("tokenExpiresAt", {
      header: m.list.colExpires,
      sortUndefined: "last",
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ getValue }) => {
        const v = getValue()
        return (
          <span className="tabular-nums">
            {v ? formatDate(v) : m.list.noExpiry}
          </span>
        )
      },
    }),
    col.accessor("lastCheckedAt", {
      header: m.list.colChecked,
      meta: { className: HIDE_BELOW_4XL, headerClassName: HIDE_BELOW_4XL },
      cell: ({ getValue }) => (
        <RelativeTime value={getValue()} className="text-muted-foreground" />
      ),
    }),
  ])
}

export function ConnectionsTable({
  items,
  channels = [],
  isAdmin,
  initialTab = "all",
}: {
  items: ConnectionListItem[]
  /** Telegram notification channels (tab "Telegram") */
  channels?: NotificationChannelDto[]
  isAdmin: boolean
  /** ?tab=… (e.g. "telegram" after deleting a channel) */
  initialTab?: string
}) {
  const router = useRouter()
  const [tab, setTab] = React.useState<string>(initialTab)
  // phones: the tab strip scrolls sideways - bring a preselected tab (?tab=telegram, the last one) into view
  const tabsScrollRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (initialTab === "all") return
    const el = tabsScrollRef.current?.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]'
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [initialTab])
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])

  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const st = filters.status ?? []
    return items.filter((c) => {
      if (tab !== "all" && c.platform !== tab) return false
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !(isAdmin && c.owner.email.toLowerCase().includes(q))
      )
        return false
      if (st.length && !st.includes(c.status)) return false
      return true
    })
  }, [items, tab, search, filters, isAdmin])

  const total = items.length + channels.length
  const onTelegram = tab === TELEGRAM_TAB
  const header = (
    <PageHeader
      title={m.list.title}
      description={m.list.description}
      // empty list: the empty state carries the one brand button instead;
      // the Telegram view adds a Telegram connection straight away (no platform picker)
      primaryAction={
        total > 0 ? (
          <Button variant="brand" asChild>
            <Link href={onTelegram ? "/connections/telegram/new" : "/connections/new"}>
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {onTelegram ? tn.list.add : m.list.add}
            </Link>
          </Button>
        ) : undefined
      }
    />
  )

  if (total === 0) {
    return (
      <>
      {header}
      <Card className="py-0">
        <PageGuide guide={tg.connections} />
        <EmptyState
          icon={Plug01Icon}
          title={m.list.emptyTitle}
          description={m.list.emptyDescription}
          action={
            <Button variant="brand" asChild>
              <Link href="/connections/new">
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
      </Card>
      </>
    )
  }

  const count = (p: string) =>
    p === "all" ? items.length : items.filter((c) => c.platform === p).length
  // no ad connection at all (only Telegram) / none on this platform tab: say so and offer to add one,
  // instead of the "no match for the filter" message
  const tabPlatform = tab === "all" || onTelegram ? null : tab
  const tabEmpty = !onTelegram && count(tab) === 0
  const tabPlatformLabel = tabPlatform
    ? (PLATFORM_LABELS as Record<string, string>)[tabPlatform] ?? tabPlatform
    : null

  return (
    <>
    {header}
    <Card className="@container gap-0 py-0">
      {/* tab-aware guide: the Telegram view explains notification channels */}
      <PageGuide
        guide={tab === TELEGRAM_TAB ? tg.telegramList : tg.connections}
      />
      <Tabs value={tab} onValueChange={setTab} className="gap-0">
        {/* scrolls sideways on phones; the right edge fades so a cut-off tab reads as "more →" */}
        <div ref={tabsScrollRef} className="[scrollbar-width:none] overflow-x-auto border-b px-3 pt-3 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [&::-webkit-scrollbar]:hidden">
          <TabsList
            variant="line"
            aria-label={m.list.tabsLabel}
            className="max-sm:h-11! max-sm:pr-6"
          >
            <TabsTrigger value="all">
              {m.list.tabAll}
              <TabCount n={count("all")} />
            </TabsTrigger>
            {CONNECTION_PLATFORMS.map((p) => (
              <TabsTrigger key={p} value={p}>
                <PlatformIcon platform={p} />
                {PLATFORM_LABELS[p]}
                <TabCount n={count(p)} />
              </TabsTrigger>
            ))}
            <TabsTrigger value={TELEGRAM_TAB}>
              <BrandIcon brand="telegram" />
              {tn.list.tab}
              <TabCount n={channels.length} />
            </TabsTrigger>
          </TabsList>
        </div>
        {tab === TELEGRAM_TAB ? (
          <TabsContent value={TELEGRAM_TAB} className="flex flex-col">
            <TelegramChannelsTable
              channels={channels}
              isAdmin={isAdmin}
              ctaVariant="outline"
            />
          </TabsContent>
        ) : tabEmpty ? (
          <TabsContent value={tab} className="flex flex-col">
            <EmptyState
              icon={Plug01Icon}
              title={
                tabPlatformLabel
                  ? m.list.emptyAdsPlatformTitle(tabPlatformLabel)
                  : m.list.emptyAdsTitle
              }
              description={m.list.emptyAdsDescription}
              action={
                <Button variant="outline" asChild>
                  <Link
                    href={
                      tabPlatform
                        ? `/connections/new?platform=${tabPlatform}`
                        : "/connections/new"
                    }
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                      aria-hidden
                    />
                    {tabPlatformLabel
                      ? m.list.addAdsPlatform(tabPlatformLabel)
                      : m.list.addAds}
                  </Link>
                </Button>
              }
            />
          </TabsContent>
        ) : (
        <TabsContent value={tab} className="flex flex-col">
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
                  options: statusValues("connection").map((s) => ({
                    value: s,
                    label: getStatusMeta("connection", s).label,
                    count: items.filter(
                      (c) =>
                        c.status === s && (tab === "all" || c.platform === tab)
                    ).length,
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
            onRowClick={(r) => router.push(`/connections/${r.id}`)}
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
                      <PlatformIcon platform={r.platform} colored />
                      <span className="line-clamp-2 break-words">{r.name}</span>
                    </span>
                    <StatusBadge
                      kind="connection"
                      status={r.status}
                      className="shrink-0"
                    />
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                    <span>
                      {m.list.colAccounts}:{" "}
                      <span className="tabular-nums">{r.accountCount}</span>
                    </span>
                    <span>
                      {m.list.colExpires}:{" "}
                      {r.tokenExpiresAt
                        ? formatDate(r.tokenExpiresAt)
                        : m.list.noExpiry}
                    </span>
                    {isAdmin && (
                      <span className="max-w-full truncate">
                        {r.owner.name || r.owner.email}
                      </span>
                    )}
                  </div>
                  {/* the next step (invalid / expiring / failed check), short on a phone card */}
                  <StatusHint
                    message={r.statusMessage}
                    hint={r.statusHint}
                    clamp={2}
                  />
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
        </TabsContent>
        )}
      </Tabs>
    </Card>
    </>
  )
}

function TabCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground tabular-nums">
      {n}
    </span>
  )
}
