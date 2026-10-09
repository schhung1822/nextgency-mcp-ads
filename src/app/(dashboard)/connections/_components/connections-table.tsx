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
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { notifications as tn } from "@/lib/i18n/vi/notifications"
import {
  CONNECTION_PLATFORMS,
  statusTooltip,
  type ConnectionListItem,
} from "@/lib/schemas/connections"
import type {
  DriveSourceDto,
  DriveSystemInfo,
  PersonalDriveCredentialDto,
} from "@/lib/schemas/drive"
import type { NotificationChannelDto } from "@/lib/schemas/notifications"

import { DriveSourcesTable } from "./drive-sources-table"
import { TelegramChannelsTable } from "./telegram-channels-table"

/** view tab of the ad connections (every platform; the platform is a filter inside it) */
export const ADS_TAB = "all"
/** view tab of the Telegram notification channels */
export const TELEGRAM_TAB = "telegram"
/** view tab of the Google Drive folders / sheets (creative sources) */
export const DRIVE_TAB = "drive"

const NO_DRIVE_SYSTEM: DriveSystemInfo = {
  configured: false,
  clientEmail: null,
  hasApiKey: false,
  status: null,
}

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

/**
 * /connections: three top tabs - "Quảng cáo" (every ad platform; the platform is a multi-select filter pill in the
 * FilterBar, so the tab strip never scrolls sideways) · "Telegram" · "Google Drive". `?tab=` (all|telegram|drive)
 * selects the tab, the old `?platform=meta` links preselect the platform filter.
 */
export function ConnectionsTable({
  items,
  channels = [],
  driveSources = [],
  driveSystem = NO_DRIVE_SYSTEM,
  drivePersonalCredentials = [],
  isAdmin,
  initialTab = ADS_TAB,
  initialPlatforms = [],
}: {
  items: ConnectionListItem[]
  /** Telegram notification channels (tab "Telegram") */
  channels?: NotificationChannelDto[]
  /** Google Drive folders / sheets (tab "Google Drive") */
  driveSources?: DriveSourceDto[]
  /** system service account email + configured flags (no secret) */
  driveSystem?: DriveSystemInfo
  /** "Service account riêng" (own; admin: all) */
  drivePersonalCredentials?: PersonalDriveCredentialDto[]
  isAdmin: boolean
  /** ?tab=… (e.g. "telegram" after deleting a channel) */
  initialTab?: string
  /** ?platform=… (old platform-tab links): preselected "Nền tảng" filter */
  initialPlatforms?: string[]
}) {
  const router = useRouter()
  const [tab, setTab] = React.useState<string>(initialTab)
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>(() =>
    initialPlatforms.length ? { platform: initialPlatforms } : ({} as FilterValues)
  )
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])
  const platformFilter = React.useMemo(() => filters.platform ?? [], [filters])
  const statusFilter = React.useMemo(() => filters.status ?? [], [filters])

  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((c) => {
      if (platformFilter.length && !platformFilter.includes(c.platform))
        return false
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !(isAdmin && c.owner.email.toLowerCase().includes(q))
      )
        return false
      if (statusFilter.length && !statusFilter.includes(c.status)) return false
      return true
    })
  }, [items, search, platformFilter, statusFilter, isAdmin])

  const total = items.length + channels.length + driveSources.length
  const onTelegram = tab === TELEGRAM_TAB
  const onDrive = tab === DRIVE_TAB
  const header = (
    <PageHeader
      title={m.list.title}
      // the description follows the tab (M8)
      description={
        total === 0 && !onDrive
          ? m.list.description
          : onTelegram
            ? m.list.descriptionTelegram
            : onDrive
              ? m.list.descriptionDrive
              : m.list.descriptionAds
      }
      // empty list: the empty state carries the one brand button instead;
      // the Telegram / Drive views add a channel / source straight away (no platform picker)
      primaryAction={
        total > 0 || onDrive ? (
          <Button variant="brand" asChild>
            <Link
              href={
                onTelegram
                  ? "/connections/telegram/new"
                  : onDrive
                    ? "/connections/drive/new"
                    : "/connections/new"
              }
            >
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {onTelegram
                ? tn.list.add
                : onDrive
                  ? driveUi.list.add
                  : m.list.add}
            </Link>
          </Button>
        ) : undefined
      }
    />
  )

  // ?tab=drive keeps the tabs: the Drive view explains the system email even before anything exists
  if (total === 0 && !onDrive) {
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

  const countOf = (p: string) => items.filter((c) => c.platform === p).length
  // the platform filter narrowed to one platform that has no connection: say so and offer to add one,
  // instead of the "no match for the filter" message
  const onlyPlatform =
    platformFilter.length === 1 && countOf(platformFilter[0]!) === 0
      ? platformFilter[0]!
      : null
  const onlyPlatformLabel = onlyPlatform
    ? ((PLATFORM_LABELS as Record<string, string>)[onlyPlatform] ??
      onlyPlatform)
    : null
  const addAdsButton = (platform: string | null, label: string | null) => (
    <Button variant="outline" asChild>
      <Link
        href={
          platform ? `/connections/new?platform=${platform}` : "/connections/new"
        }
      >
        <HugeiconsIcon
          icon={Add01Icon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
        {label ? m.list.addAdsPlatform(label) : m.list.addAds}
      </Link>
    </Button>
  )

  return (
    <>
      {header}
      <Card className="@container gap-0 py-0">
        {/* tab-aware guide: the Telegram / Drive views explain their own setup */}
        <PageGuide
          guide={
            onTelegram
              ? tg.telegramList
              : onDrive
                ? driveUi.guides.list
                : tg.connections
          }
        />
        <Tabs value={tab} onValueChange={setTab} className="gap-0">
          {/* three short tabs fit a 360px phone; the scroll is only a safety net (no mask / auto-reveal needed) */}
          <div className="[scrollbar-width:none] overflow-x-auto border-b px-3 pt-3 [&::-webkit-scrollbar]:hidden">
            <TabsList
              variant="line"
              aria-label={m.list.tabsLabel}
              className="max-sm:h-11!"
            >
              <TabsTrigger value={ADS_TAB}>
                <HugeiconsIcon
                  icon={Plug01Icon}
                  strokeWidth={2}
                  aria-hidden
                  className="max-sm:hidden"
                />
                {m.list.tabAds}
                <TabCount n={items.length} />
              </TabsTrigger>
              <TabsTrigger value={TELEGRAM_TAB}>
                <BrandIcon brand="telegram" className="max-sm:hidden" />
                {tn.list.tab}
                <TabCount n={channels.length} />
              </TabsTrigger>
              <TabsTrigger value={DRIVE_TAB}>
                <BrandIcon brand="drive" className="max-sm:hidden" />
                {driveUi.ui.tab}
                <TabCount n={driveSources.length} />
              </TabsTrigger>
            </TabsList>
          </div>
          {onTelegram ? (
            <TabsContent value={TELEGRAM_TAB} className="flex flex-col">
              <TelegramChannelsTable
                channels={channels}
                isAdmin={isAdmin}
                ctaVariant="outline"
              />
            </TabsContent>
          ) : onDrive ? (
            <TabsContent value={DRIVE_TAB} className="flex flex-col">
              <DriveSourcesTable
                sources={driveSources}
                system={driveSystem}
                personalCredentials={drivePersonalCredentials}
                isAdmin={isAdmin}
                ctaVariant="outline"
              />
            </TabsContent>
          ) : items.length === 0 ? (
            // only Telegram / Drive so far: no ad connection at all
            <TabsContent value={ADS_TAB} className="flex flex-col">
              <EmptyState
                icon={Plug01Icon}
                title={m.list.emptyAdsTitle}
                description={m.list.emptyAdsDescription}
                action={addAdsButton(null, null)}
              />
            </TabsContent>
          ) : (
            <TabsContent value={ADS_TAB} className="flex flex-col">
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
                      id: "platform",
                      label: m.list.filterPlatform,
                      options: CONNECTION_PLATFORMS.map((p) => ({
                        value: p,
                        label: PLATFORM_LABELS[p],
                        icon: <PlatformIcon platform={p} colored />,
                        count: countOf(p),
                      })),
                    },
                    {
                      id: "status",
                      label: m.list.filterStatus,
                      options: statusValues("connection").map((s) => ({
                        value: s,
                        label: getStatusMeta("connection", s).label,
                        count: items.filter(
                          (c) =>
                            c.status === s &&
                            (platformFilter.length === 0 ||
                              platformFilter.includes(c.platform))
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
                  onlyPlatform && !search.trim() ? (
                    <EmptyState
                      icon={Plug01Icon}
                      title={m.list.emptyAdsPlatformTitle(onlyPlatformLabel!)}
                      description={m.list.emptyAdsDescription}
                      action={addAdsButton(onlyPlatform, onlyPlatformLabel)}
                    />
                  ) : (
                    <EmptyState
                      title={m.list.emptyFilteredTitle}
                      description={m.list.emptyFilteredDescription}
                    />
                  )
                }
                renderMobileCard={(r) => (
                  <div className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2 font-medium">
                          <PlatformIcon platform={r.platform} colored />
                          <span className="line-clamp-2 break-words">
                            {r.name}
                          </span>
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
                          <span className="tabular-nums">
                            {r.accountCount}
                          </span>
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
