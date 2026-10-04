"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Note01Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import {
  createDataTableColumnHelper,
  DataTable,
  DateRangePicker,
  EmptyState,
  FilterBar,
  PageGuide,
  PlatformIcon,
  StatusBadge,
  type FilterDef,
  type FilterValues,
} from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PLATFORM_LABELS } from "@/lib/constants"
import { common } from "@/lib/i18n/vi/common"
import { formatDuration } from "@/lib/format"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { logs as tl } from "@/lib/i18n/vi/logs"
import {
  ACTIVITY_GROUPS,
  EMPTY_LOG_QUERY,
  LOG_MAX_RANGE_DAYS,
  LOG_PLATFORMS,
  logQueryToSearchParams,
  MCP_LOG_STATUSES,
  type LogQuery,
  type LogTab,
} from "@/lib/schemas/logs"
import {
  loadMoreActivityLogsAction,
  loadMoreMcpLogsAction,
} from "@/server/actions/logs"
import type {
  ActivityLogListRow,
  LogFilterOptions,
  LogPage,
  McpLogListRow,
} from "@/server/services/logs"

import { ActivityLogSheet, McpLogSheet } from "./log-detail-sheet"
import {
  actionLabel,
  formatLogTime,
  formatLogTimeParts,
  isPlatform,
  roleLabel,
  targetTypeLabel,
} from "./log-format"

export interface LogsViewProps {
  isAdmin: boolean
  query: LogQuery
  mcpPage: LogPage<McpLogListRow> | null
  staffPage: LogPage<ActivityLogListRow> | null
  options: LogFilterOptions
}

const STATUS_LABELS = common.status.log

/**
 * md+: the rows scroll inside the card (bounded to the viewport) so the sticky column header, the filter bar
 * and the "Tải thêm" footer stay on screen; phones use the card list and the normal page scroll.
 */
const TABLE_SCROLL =
  "md:[&_[data-slot=table-container]]:max-h-[max(28rem,calc(100svh-19rem))] md:[&_[data-slot=table-container]]:overflow-y-auto"

export function LogsView({ isAdmin, query, mcpPage, staffPage, options }: LogsViewProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = React.useTransition()
  const search = logQueryToSearchParams(query).toString()

  const navigate = React.useCallback(
    (next: LogQuery) => {
      const qs = logQueryToSearchParams(next).toString()
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
      })
    },
    [pathname, router]
  )

  const setTab = (tab: string) => {
    if (tab !== "mcp" && tab !== "staff") return
    navigate({ ...EMPTY_LOG_QUERY, tab: tab as LogTab, range: query.range })
  }

  const filterDefs: FilterDef[] =
    query.tab === "mcp"
      ? [
          {
            id: "mcp",
            label: tl.filters.mcp,
            options: options.mcps.map((m) => ({
              value: m.id,
              label: isAdmin && m.ownerEmail ? `${m.name} · ${m.ownerEmail}` : m.name,
            })),
          },
          ...(isAdmin
            ? [
                {
                  id: "owner",
                  label: tl.filters.owner,
                  options: options.users.map((u) => ({ value: u.id, label: u.email })),
                },
              ]
            : []),
          {
            id: "platform",
            label: tl.filters.platform,
            options: LOG_PLATFORMS.map((p) => ({
              value: p,
              label: PLATFORM_LABELS[p],
              icon: <PlatformIcon platform={p} colored className="size-4" />,
            })),
          },
          {
            id: "account",
            label: tl.filters.account,
            options: options.accounts.map((a) => ({
              value: a.externalId,
              label: `${a.name} (${a.externalId})`,
              icon: isPlatform(a.platform) ? <PlatformIcon platform={a.platform} colored className="size-4" /> : undefined,
            })),
          },
          {
            id: "tool",
            label: tl.filters.tool,
            options: options.tools.map((t) => ({ value: t, label: t })),
          },
          {
            id: "status",
            label: tl.filters.status,
            options: MCP_LOG_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
          },
        ]
      : [
          {
            id: "actor",
            label: tl.filters.actor,
            options: options.users.map((u) => ({ value: u.id, label: u.email })),
          },
          {
            id: "group",
            label: tl.filters.group,
            options: ACTIVITY_GROUPS.map((g) => ({ value: g, label: tl.actionGroups[g] })),
          },
          {
            id: "result",
            label: tl.filters.result,
            options: [
              { value: "success", label: tl.result.success },
              { value: "failure", label: tl.result.failure },
            ],
          },
        ]

  // keep filter values that are in the URL even when the option list does not contain them
  // (e.g. a deleted MCP from a deep link)
  const values: FilterValues =
    query.tab === "mcp"
      ? {
          mcp: query.mcp,
          owner: query.owner,
          platform: query.platform,
          account: query.account,
          tool: query.tool,
          status: query.status,
        }
      : { actor: query.actor, group: query.group, result: query.result }
  for (const def of filterDefs) {
    for (const v of values[def.id] ?? []) {
      if (!def.options.some((o) => o.value === v)) def.options.push({ value: v, label: v })
    }
  }

  const onValuesChange = (v: FilterValues) => {
    navigate({
      ...query,
      mcp: v.mcp ?? [],
      owner: v.owner ?? [],
      platform: v.platform ?? [],
      account: v.account ?? [],
      tool: v.tool ?? [],
      status: v.status ?? [],
      actor: v.actor ?? [],
      group: v.group ?? [],
      result: v.result ?? [],
    })
  }

  const hasFilters =
    !!query.q ||
    query.writes ||
    Object.values(values).some((v) => v.length > 0)
  const clearFilters = () => navigate({ ...EMPTY_LOG_QUERY, tab: query.tab, range: query.range })

  const filterBar = (
    <FilterBar
      search={{
        value: query.q,
        onChange: (q) => navigate({ ...query, q: q.trim().slice(0, 200) }),
        placeholder: query.tab === "mcp" ? tl.filters.searchMcp : tl.filters.searchStaff,
        label: query.tab === "mcp" ? tl.filters.searchMcpLabel : tl.filters.searchStaffLabel,
      }}
      filters={filterDefs}
      values={values}
      onValuesChange={onValuesChange}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={query.range ? "outline" : "secondary"}
          size="sm"
          className="pointer-coarse:h-10"
          aria-pressed={!query.range}
          onClick={() => navigate({ ...query, range: null })}
          title={tl.range.last24hHint}
        >
          {tl.range.last24h}
        </Button>
        <DateRangePicker
          value={query.range}
          onChange={(range) => navigate({ ...query, range })}
          includeToday
          maxDays={LOG_MAX_RANGE_DAYS}
          className="h-8 pointer-coarse:h-10"
        />
        {query.tab === "mcp" && (
          <Label
            htmlFor="logs-writes-only"
            className="flex min-h-8 cursor-pointer items-center gap-2 pl-1 text-sm font-normal pointer-coarse:min-h-10"
          >
            <Switch
              id="logs-writes-only"
              checked={query.writes}
              onCheckedChange={(writes) => navigate({ ...query, writes })}
            />
            {tl.filters.writesOnly}
          </Label>
        )}
      </div>
    </FilterBar>
  )

  return (
    <div className="flex flex-col gap-4">
      <PageGuide guide={query.tab === "staff" ? tg.logs.staff : tg.logs.mcp} />
      {/* staff only have the MCP log → no lone tab */}
      {isAdmin && (
        <Tabs value={query.tab} onValueChange={setTab}>
          <TabsList aria-label={tl.tabs.label} className="max-sm:w-full group-data-horizontal/tabs:h-10">
            <TabsTrigger value="mcp">{tl.tabs.mcp}</TabsTrigger>
            <TabsTrigger value="staff">{tl.tabs.staff}</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <Card className="gap-0 py-0" aria-busy={pending}>
        <div className="border-b p-3">{filterBar}</div>
        <div className={pending ? "pointer-events-none opacity-60 transition-opacity" : "transition-opacity"}>
          {query.tab === "mcp" && mcpPage && (
            <McpLogTable
              key={search}
              search={search}
              initial={mcpPage}
              isAdmin={isAdmin}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
              onFilterMcp={(id) => navigate({ ...EMPTY_LOG_QUERY, range: query.range, mcp: [id] })}
            />
          )}
          {query.tab === "staff" && staffPage && (
            <StaffLogTable
              key={search}
              search={search}
              initial={staffPage}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
            />
          )}
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared "load more" state
// ---------------------------------------------------------------------------

function usePagedRows<T>(
  initial: LogPage<T>,
  search: string,
  load: (input: { search: string; cursor: string }) => Promise<
    { ok: true; data: LogPage<T> } | { ok: false; error: string }
  >
) {
  const [rows, setRows] = React.useState<T[]>(initial.rows)
  const [cursor, setCursor] = React.useState<string | null>(initial.nextCursor)
  const [loading, setLoading] = React.useState(false)
  const loadMore = React.useCallback(async () => {
    if (!cursor || loading) return
    setLoading(true)
    try {
      const r = await load({ search, cursor })
      if (r.ok) {
        setRows((prev) => [...prev, ...r.data.rows])
        setCursor(r.data.nextCursor)
      } else {
        toast.error(r.error)
      }
    } catch {
      toast.error(tl.errors.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading, load, search])
  return { rows, hasMore: cursor !== null, loading, loadMore }
}

function RowsCount({ n, more }: { n: number; more: boolean }) {
  return (
    <p className="border-t px-4 py-2 text-[13px] text-muted-foreground tabular-nums" aria-live="polite">
      {tl.rowsShown(n, more)}
    </p>
  )
}

function TimeCell({ iso }: { iso: string }) {
  const { time, date } = formatLogTimeParts(iso)
  return (
    <span className="flex flex-col whitespace-nowrap tabular-nums">
      <span>{time}</span>
      <span className="text-xs text-muted-foreground">{date}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// MCP tab
// ---------------------------------------------------------------------------

const mcpCol = createDataTableColumnHelper<McpLogListRow>()

function mcpColumns(isAdmin: boolean) {
  return mcpCol.columns([
    mcpCol.accessor("createdAt", {
      header: `${tl.columns.time} ↓`,
      enableSorting: false,
      meta: { label: tl.columns.time },
      cell: ({ getValue }) => <TimeCell iso={getValue()} />,
    }),
    mcpCol.accessor("mcpName", {
      header: tl.columns.mcp,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="flex max-w-44 min-w-0 flex-col">
          <span className="truncate font-medium" title={row.original.mcpName ?? undefined}>{row.original.mcpName ?? tl.deletedMcp}</span>
          {isAdmin && row.original.ownerEmail ? (
            <span className="truncate text-xs text-muted-foreground" title={row.original.ownerEmail}>{row.original.ownerEmail}</span>
          ) : null}
        </span>
      ),
    }),
    mcpCol.accessor("clientName", {
      header: tl.columns.client,
      enableSorting: false,
      meta: { hideBelow: "5xl" },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {row.original.clientName ?? <span className="text-muted-foreground">{tl.noClient}</span>}
        </span>
      ),
    }),
    mcpCol.accessor("toolName", {
      header: tl.columns.tool,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <code className="block max-w-48 truncate font-mono text-xs" title={row.original.toolName ?? row.original.method}>
            {row.original.toolName ?? row.original.method}
          </code>
          {row.original.actionKind === "write" && (
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {tl.kind.write}
            </Badge>
          )}
        </span>
      ),
    }),
    mcpCol.accessor("platform", {
      header: tl.columns.platformAccount,
      enableSorting: false,
      meta: { hideBelow: "4xl" },
      cell: ({ row }) =>
        isPlatform(row.original.platform) ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <PlatformIcon platform={row.original.platform} colored className="size-4" />
            <span className="max-w-36 truncate font-mono text-xs text-muted-foreground">{row.original.adAccountId ?? "-"}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
    mcpCol.accessor("status", {
      header: tl.columns.status,
      enableSorting: false,
      cell: ({ row }) => (
        <span title={row.original.errorMessage ?? undefined}>
          <StatusBadge kind="log" status={row.original.status} />
        </span>
      ),
    }),
    mcpCol.accessor("durationMs", {
      header: tl.columns.duration,
      enableSorting: false,
      meta: { align: "end", className: "tabular-nums whitespace-nowrap" },
      cell: ({ getValue }) => formatDuration(getValue()),
    }),
  ])
}

function McpLogTable({
  initial,
  search,
  isAdmin,
  hasFilters,
  onClearFilters,
  onFilterMcp,
}: {
  initial: LogPage<McpLogListRow>
  search: string
  isAdmin: boolean
  hasFilters: boolean
  onClearFilters: () => void
  onFilterMcp: (mcpId: string) => void
}) {
  const { rows, hasMore, loading, loadMore } = usePagedRows(initial, search, loadMoreMcpLogsAction)
  const [selected, setSelected] = React.useState<McpLogListRow | null>(null)
  const columns = React.useMemo(() => mcpColumns(isAdmin), [isAdmin])
  return (
    <>
      <DataTable
        mode="server"
        stickyHeader
        className={TABLE_SCROLL}
        ariaLabel={tl.tabs.mcp}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        onRowClick={setSelected}
        activeRowId={selected?.id}
        serverPagination={{ hasNextPage: hasMore, loadingMore: loading, onLoadMore: loadMore }}
        empty={
          <EmptyState
            icon={Note01Icon}
            title={tl.empty.mcpTitle}
            description={tl.empty.mcpDescription}
            action={
              hasFilters ? (
                <Button variant="outline" onClick={onClearFilters}>
                  {tl.empty.clearFilters}
                </Button>
              ) : (
                <Button variant="outline" asChild>
                  <Link href="/mcp-servers/new">{tl.empty.createMcp}</Link>
                </Button>
              )
            }
          />
        }
        renderMobileCard={(r) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <code className="truncate font-mono text-xs font-medium">{r.toolName ?? r.method}</code>
                {r.actionKind === "write" && (
                  <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[11px]">
                    {tl.kind.write}
                  </Badge>
                )}
              </span>
              <StatusBadge kind="log" status={r.status} className="shrink-0" />
            </div>
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              {isPlatform(r.platform) && <PlatformIcon platform={r.platform} colored className="size-3.5" />}
              <span className="truncate">
                {r.mcpName ?? tl.deletedMcp}
                {r.clientName ? ` · ${r.clientName}` : ""}
              </span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatLogTime(r.createdAt)} · {formatDuration(r.durationMs)}
            </p>
          </div>
        )}
      />
      {rows.length > 0 && <RowsCount n={rows.length} more={hasMore} />}
      <McpLogSheet
        row={selected}
        isAdmin={isAdmin}
        onClose={() => setSelected(null)}
        onFilterMcp={(id) => {
          setSelected(null)
          onFilterMcp(id)
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Staff tab
// ---------------------------------------------------------------------------

const staffCol = createDataTableColumnHelper<ActivityLogListRow>()

const staffColumns = staffCol.columns([
  staffCol.accessor("createdAt", {
    header: `${tl.columns.time} ↓`,
    enableSorting: false,
    meta: { label: tl.columns.time },
    cell: ({ getValue }) => <TimeCell iso={getValue()} />,
  }),
  staffCol.accessor("actorEmail", {
    header: tl.columns.actor,
    enableSorting: false,
    cell: ({ row }) => (
      <span className="flex max-w-60 min-w-0 flex-col">
        <span className="truncate font-medium" title={row.original.actorEmail ?? undefined}>{row.original.actorEmail ?? tl.system}</span>
        {row.original.actorRole ? (
          <span className="text-xs text-muted-foreground">{roleLabel(row.original.actorRole)}</span>
        ) : null}
      </span>
    ),
  }),
  staffCol.accessor("action", {
    header: tl.columns.action,
    enableSorting: false,
    cell: ({ getValue }) => <span className="whitespace-nowrap">{actionLabel(getValue())}</span>,
  }),
  staffCol.accessor("targetLabel", {
    header: tl.columns.target,
    enableSorting: false,
    cell: ({ row }) =>
      row.original.targetType || row.original.targetLabel ? (
        <span className="flex max-w-52 min-w-0 flex-col">
          <span className="truncate" title={row.original.targetLabel ?? row.original.targetId ?? undefined}>{row.original.targetLabel ?? row.original.targetId ?? "-"}</span>
          <span className="text-xs text-muted-foreground">{targetTypeLabel(row.original.targetType)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">-</span>
      ),
  }),
  staffCol.accessor("ip", {
    header: tl.columns.ip,
    enableSorting: false,
    meta: { hideBelow: "5xl" },
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() ?? "-"}</span>,
  }),
  staffCol.accessor("status", {
    header: tl.columns.result,
    enableSorting: false,
    cell: ({ getValue }) => (
      <StatusBadge
        kind="log"
        status={getValue() === "success" ? "success" : "error"}
        label={tl.result[getValue() as keyof typeof tl.result] ?? getValue()}
      />
    ),
  }),
])

function StaffLogTable({
  initial,
  search,
  hasFilters,
  onClearFilters,
}: {
  initial: LogPage<ActivityLogListRow>
  search: string
  hasFilters: boolean
  onClearFilters: () => void
}) {
  const { rows, hasMore, loading, loadMore } = usePagedRows(initial, search, loadMoreActivityLogsAction)
  const [selected, setSelected] = React.useState<ActivityLogListRow | null>(null)
  return (
    <>
      <DataTable
        mode="server"
        stickyHeader
        className={TABLE_SCROLL}
        ariaLabel={tl.tabs.staff}
        columns={staffColumns}
        data={rows}
        getRowId={(r) => r.id}
        onRowClick={setSelected}
        activeRowId={selected?.id}
        serverPagination={{ hasNextPage: hasMore, loadingMore: loading, onLoadMore: loadMore }}
        empty={
          <EmptyState
            icon={Note01Icon}
            title={tl.empty.staffTitle}
            description={tl.empty.staffDescription}
            action={
              hasFilters ? (
                <Button variant="outline" onClick={onClearFilters}>
                  {tl.empty.clearFilters}
                </Button>
              ) : undefined
            }
          />
        }
        renderMobileCard={(r) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{actionLabel(r.action)}</span>
              <StatusBadge
                kind="log"
                status={r.status === "success" ? "success" : "error"}
                label={tl.result[r.status as keyof typeof tl.result] ?? r.status}
              />
            </div>
            <p className="truncate text-[13px] text-muted-foreground">
              {r.actorEmail ?? tl.system}
              {r.targetLabel ? ` · ${r.targetLabel}` : ""}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatLogTime(r.createdAt)}
              {r.ip ? ` · ${r.ip}` : ""}
            </p>
          </div>
        )}
      />
      {rows.length > 0 && <RowsCount n={rows.length} more={hasMore} />}
      <ActivityLogSheet row={selected} onClose={() => setSelected(null)} />
    </>
  )
}
