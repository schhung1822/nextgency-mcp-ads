"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Add01Icon,
  AiNetworkIcon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  FilterBar,
  getStatusMeta,
  PlatformBadge,
  PlatformIcon,
  RelativeTime,
  StatusBadge,
  statusValues,
  type FilterValues,
} from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PERMISSION_LABELS, PLATFORM_LABELS } from "@/lib/constants"
import { formatNumber } from "@/lib/format"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  matchPermissionPreset,
  MCP_PLATFORMS,
  type PermissionPreset,
} from "@/lib/schemas/mcp-servers"
import type { Permission } from "@/server/mcp/types"
import type { McpListItem } from "@/server/services/mcp-servers"

const c = t.list.col
const col = createDataTableColumnHelper<McpListItem>()

// Columns appear as the card gets wider (container queries, so it also works in a narrow tablet layout).
const HIDE_BELOW_2XL = "hidden @2xl:table-cell"
const HIDE_BELOW_3XL = "hidden @3xl:table-cell"
const HIDE_BELOW_4XL = "hidden @4xl:table-cell"

const PERM_SHORT: Record<PermissionPreset, string> = {
  readOnly: t.list.permSummary.readOnly,
  operate: t.list.permSummary.operate,
  fullNoDelete: t.list.permSummary.full,
}

/** One short badge for the usual presets (+ a red one when deleting is allowed); other sets list a few. */
function PermissionSummary({
  permissions,
}: {
  permissions: readonly Permission[]
}) {
  const hasDelete = permissions.includes("delete")
  const rest = permissions.filter((p) => p !== "delete")
  const preset = matchPermissionPreset(rest)
  const shown = preset ? [] : rest.slice(0, 3)
  const hidden = preset ? 0 : rest.length - shown.length
  return (
    <ul
      className="flex flex-wrap items-center gap-1"
      title={permissions.map((p) => PERMISSION_LABELS[p]).join(", ")}
    >
      {preset && (
        <li>
          <Badge variant="outline" className="rounded-full font-medium">
            {PERM_SHORT[preset]}
          </Badge>
        </li>
      )}
      {shown.map((p) => (
        <li key={p}>
          <Badge variant="outline" className="rounded-full font-medium">
            {PERMISSION_LABELS[p]}
          </Badge>
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <Badge variant="outline" className="rounded-full font-medium">
            {t.list.permSummary.more(hidden)}
          </Badge>
        </li>
      )}
      {hasDelete && (
        <li>
          <Badge
            variant="outline"
            className="rounded-full border-destructive/30 bg-destructive/10 font-medium text-destructive-strong"
          >
            {PERMISSION_LABELS.delete}
          </Badge>
        </li>
      )}
    </ul>
  )
}

function buildColumns(isAdmin: boolean) {
  return col.columns([
    col.accessor("name", {
      header: c.name,
      meta: { className: "w-full min-w-44 max-w-0" },
      cell: ({ row }) => (
        <div className="min-w-0">
          <Link
            href={`/mcp-servers/${row.original.id}`}
            title={row.original.name}
            className="block truncate font-medium hover:underline focus-visible:underline"
            aria-label={t.list.openDetail(row.original.name)}
          >
            {row.original.name}
          </Link>
          {row.original.description && (
            <p
              className="truncate text-[13px] text-muted-foreground"
              title={row.original.description}
            >
              {row.original.description}
            </p>
          )}
        </div>
      ),
    }),
    ...(isAdmin
      ? [
          col.accessor("ownerEmail", {
            header: c.owner,
            meta: {
              className: HIDE_BELOW_4XL,
              headerClassName: HIDE_BELOW_4XL,
            },
            cell: ({ row }) => (
              <span
                className="block max-w-40 truncate text-[13px] text-muted-foreground"
                title={row.original.ownerEmail}
              >
                {row.original.ownerName || row.original.ownerEmail}
              </span>
            ),
          }),
        ]
      : []),
    col.accessor("platforms", {
      header: c.platforms,
      enableSorting: false,
      cell: ({ getValue }) => (
        <div className="flex items-center gap-1">
          {getValue().map((p) => (
            <PlatformBadge key={p} platform={p} iconOnly />
          ))}
        </div>
      ),
    }),
    col.accessor("allPermissions", {
      header: c.permissions,
      enableSorting: false,
      meta: { className: HIDE_BELOW_3XL, headerClassName: HIDE_BELOW_3XL },
      cell: ({ getValue }) => <PermissionSummary permissions={getValue()} />,
    }),
    col.accessor("status", {
      header: c.status,
      cell: ({ getValue }) => <StatusBadge kind="mcp" status={getValue()} />,
    }),
    col.accessor("lastUsedAt", {
      header: c.lastUsed,
      sortUndefined: "last",
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ getValue }) =>
        getValue() ? (
          <RelativeTime
            value={getValue()}
            className="text-[13px] text-muted-foreground"
          />
        ) : (
          <span className="text-[13px] text-muted-foreground">
            {t.list.neverUsed}
          </span>
        ),
    }),
    col.accessor("calls7d", {
      header: c.calls7d,
      meta: {
        align: "end",
        className: `tabular-nums ${HIDE_BELOW_3XL}`,
        headerClassName: HIDE_BELOW_3XL,
      },
      cell: ({ row }) => (
        <div className="flex flex-col items-end">
          <span>{formatNumber(row.original.calls7d)}</span>
          {row.original.errors7d > 0 && (
            <span className="text-xs text-destructive-strong">
              {t.list.errorsHint(row.original.errors7d)}
            </span>
          )}
        </div>
      ),
    }),
  ])
}

/** Phone layout of a row (the whole card is already one button in DataTable, so no nested links here). */
function MobileCard({
  item,
  isAdmin,
}: {
  item: McpListItem
  isAdmin: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 min-w-0 font-medium break-words">
            {item.name}
          </span>
          <StatusBadge kind="mcp" status={item.status} className="shrink-0" />
        </div>
        {isAdmin && (
          <span className="truncate text-[13px] text-muted-foreground">
            {item.ownerName || item.ownerEmail}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {item.platforms.map((p) => (
            <PlatformBadge key={p} platform={p} iconOnly />
          ))}
          <PermissionSummary permissions={item.allPermissions} />
        </div>
        <div className="flex justify-between gap-2 text-[13px] text-muted-foreground">
          {item.lastUsedAt ? (
            <RelativeTime value={item.lastUsedAt} />
          ) : (
            <span>{t.list.neverUsed}</span>
          )}
          <span className="tabular-nums">
            {c.calls7d}: {formatNumber(item.calls7d)}
          </span>
        </div>
      </div>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
    </div>
  )
}
export function McpList({
  items,
  isAdmin,
}: {
  items: McpListItem[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [view, setView] = React.useState<"all" | "mine">("all")
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])

  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((m) => {
      if (view === "mine" && !m.isMine) return false
      if (
        q &&
        !m.name.toLowerCase().includes(q) &&
        !(m.description ?? "").toLowerCase().includes(q)
      )
        return false
      const st = filters.status ?? []
      if (st.length && !st.includes(m.status)) return false
      const pl = filters.platform ?? []
      if (pl.length && !m.platforms.some((p) => pl.includes(p))) return false
      const ow = filters.owner ?? []
      if (ow.length && !ow.includes(m.ownerEmail)) return false
      return true
    })
  }, [items, search, filters, view])

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={AiNetworkIcon}
          title={t.list.emptyTitle}
          description={t.list.emptyDescription}
          action={
            <Button variant="brand" asChild>
              <Link href="/mcp-servers/new">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                {t.list.create}
              </Link>
            </Button>
          }
        />
      </Card>
    )
  }

  const owners = [...new Set(items.map((m) => m.ownerEmail))].sort()

  return (
    <Card className="@container gap-0 py-0">
      {isAdmin && (
        <Tabs
          value={view}
          onValueChange={(v) => setView(v as "all" | "mine")}
          className="gap-0"
        >
          <div className="overflow-x-auto border-b px-3 pt-3">
            <TabsList variant="line" className="max-sm:h-11!">
              <TabsTrigger value="all">{t.list.viewAll}</TabsTrigger>
              <TabsTrigger value="mine">{t.list.viewMine}</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      )}
      <div className="border-b p-3">
        <FilterBar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t.list.searchPlaceholder,
            label: t.list.searchLabel,
          }}
          filters={[
            {
              id: "status",
              label: t.list.filterStatus,
              options: statusValues("mcp").map((s) => ({
                value: s,
                label: getStatusMeta("mcp", s).label,
                count: items.filter((m) => m.status === s).length,
              })),
            },
            {
              id: "platform",
              label: t.list.filterPlatform,
              options: MCP_PLATFORMS.map((p) => ({
                value: p,
                label: PLATFORM_LABELS[p],
                icon: <PlatformIcon platform={p} colored />,
              })),
            },
            ...(isAdmin
              ? [
                  {
                    id: "owner",
                    label: t.list.filterOwner,
                    options: owners.map((o) => ({ value: o, label: o })),
                  },
                ]
              : []),
          ]}
          values={filters}
          onValuesChange={setFilters}
        />
      </div>
      <DataTable
        ariaLabel={t.list.tableLabel}
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        defaultSorting={[]}
        pageSize={20}
        onRowClick={(r) => router.push(`/mcp-servers/${r.id}`)}
        renderMobileCard={(r) => <MobileCard item={r} isAdmin={isAdmin} />}
        empty={
          <EmptyState title={t.list.emptyNoMatch} className="p-6 md:p-8" />
        }
      />
    </Card>
  )
}
