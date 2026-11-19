"use client"

import * as React from "react"
import {
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  columnVisibilityFeature,
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  functionalUpdate,
  metaHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnVisibilityState,
  type PaginationState,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { common } from "@/lib/i18n/vi/common"

// ---------------------------------------------------------------------------
// Features & column helpers (TanStack Table v9)
// ---------------------------------------------------------------------------

export interface DataTableColumnMeta {
  /** cell + header alignment (numbers → "end") */
  align?: "start" | "center" | "end"
  /** extra classes for <td> */
  className?: string
  /** extra classes for <th> */
  headerClassName?: string
  /** plain-text column name (sort aria-labels, column menus) when `header` is not a string */
  label?: string
  /**
   * hide the column while the TABLE's container is narrower than this Tailwind container size
   * (2xl=672px · 3xl=768 · 4xl=896 · 5xl=1024 · 6xl=1152). Keeps the status/value columns on screen on
   * tablets and desktops with an open sidebar instead of scrolling sideways; move the info to the detail view.
   */
  hideBelow?: "2xl" | "3xl" | "4xl" | "5xl" | "6xl"
}

// full class names (not interpolated) so Tailwind can see them
const HIDE_BELOW_CLASS = {
  "2xl": "hidden @2xl/dt:table-cell",
  "3xl": "hidden @3xl/dt:table-cell",
  "4xl": "hidden @4xl/dt:table-cell",
  "5xl": "hidden @5xl/dt:table-cell",
  "6xl": "hidden @6xl/dt:table-cell",
} as const

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    datetime: sortFn_datetime,
  },
  columnMeta: metaHelper<DataTableColumnMeta>(),
})

export type DataTableFeatures = typeof dataTableFeatures
export type DataTableColumnDef<TData extends RowData> = ColumnDef<
  DataTableFeatures,
  TData,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- per-column value types differ (helper.columns returns any)
  any
>
export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>

/** Typed column helper bound to the DataTable feature set: `const col = createDataTableColumnHelper<Conn>()`. */
export function createDataTableColumnHelper<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>()
}

export type { SortingState, RowSelectionState }

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DataTableServerPagination {
  /** keyset: more rows after the current page */
  hasNextPage: boolean
  hasPreviousPage?: boolean
  /** "Tải thêm" (append) mode */
  onLoadMore?: () => void
  /** cursor next/prev mode */
  onNextPage?: () => void
  onPreviousPage?: () => void
  /** spinner on the load-more / next button */
  loadingMore?: boolean
}

export interface DataTableProps<TData extends RowData> {
  columns: DataTableColumnDef<TData>[]
  data: TData[]
  /** stable id per row (used for selection) */
  getRowId: (row: TData, index: number) => string
  /** "client": sort/paginate in the browser · "server": data already sorted/paged by the server (keyset) */
  mode?: "client" | "server"

  /** controlled sorting (required in server mode to refetch) */
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void
  defaultSorting?: SortingState

  /** client mode: rows per page (omit = no pagination) */
  pageSize?: number
  /** server mode: keyset controls */
  serverPagination?: DataTableServerPagination

  /** adds a checkbox column */
  enableRowSelection?: boolean | ((row: TData) => boolean)
  rowSelection?: RowSelectionState
  onRowSelectionChange?: (selection: RowSelectionState) => void
  /** content of the floating glass bulk-action bar (shown when ≥1 row selected) */
  bulkActions?: (
    selectedRows: TData[],
    clearSelection: () => void
  ) => React.ReactNode

  columnVisibility?: ColumnVisibilityState

  /** click/Enter on a row (e.g. open a detail Sheet) */
  onRowClick?: (row: TData) => void
  /** highlights a row (e.g. the one open in a Sheet) */
  activeRowId?: string

  loading?: boolean
  /** skeleton rows while loading with no data (default 5) */
  loadingRows?: number
  /** rendered when there are no rows (e.g. <EmptyState/>); default text "Không có dữ liệu phù hợp." */
  empty?: React.ReactNode

  /** accessible name of the table */
  ariaLabel?: string
  /** below ~768px of TABLE width (container query, so a collapsed/open sidebar counts): render rows as cards instead of the scrolling table */
  renderMobileCard?: (row: TData) => React.ReactNode
  /** sticky header inside the scroll container */
  stickyHeader?: boolean
  className?: string
}

const EMPTY_SORTING: SortingState = []
const ALIGN_CLASS = {
  start: "text-left",
  center: "text-center",
  end: "text-right",
} as const
const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, label, [role=checkbox], [role=menuitem], [data-row-click-ignore]"

function useControllable<T>(
  prop: T | undefined,
  onChange: ((v: T) => void) | undefined,
  initial: T
) {
  const [inner, setInner] = React.useState<T>(initial)
  const value = prop ?? inner
  // Latest value, also advanced synchronously by setValue so several updates in one tick compose.
  const latest = React.useRef(value)
  React.useEffect(() => {
    latest.current = value
  })
  const controlled = prop !== undefined
  const setValue = React.useCallback(
    (updater: Updater<T>) => {
      const next = functionalUpdate(updater, latest.current)
      latest.current = next
      if (!controlled) setInner(next)
      onChange?.(next)
    },
    [controlled, onChange]
  )
  return [value, setValue] as const
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Admin index table (TanStack Table v9 + shadcn Table): client or server (keyset) mode, controlled
 * sorting, row click, row selection with a floating glass bulk-action bar, loading/empty states,
 * horizontal scroll on small screens (or `renderMobileCard`).
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  mode = "client",
  sorting: sortingProp,
  onSortingChange,
  defaultSorting = EMPTY_SORTING,
  pageSize,
  serverPagination,
  enableRowSelection,
  rowSelection: rowSelectionProp,
  onRowSelectionChange,
  bulkActions,
  columnVisibility,
  onRowClick,
  activeRowId,
  loading,
  loadingRows = 5,
  empty,
  ariaLabel,
  renderMobileCard,
  stickyHeader,
  className,
}: DataTableProps<TData>) {
  const server = mode === "server"
  const [sorting, setSorting] = useControllable(
    sortingProp,
    onSortingChange,
    defaultSorting
  )
  const [rowSelection, setRowSelection] = useControllable<RowSelectionState>(
    rowSelectionProp,
    onRowSelectionChange,
    {}
  )
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: pageSize ?? 10,
  })

  const allColumns = React.useMemo<DataTableColumnDef<TData>[]>(() => {
    if (!enableRowSelection) return columns
    const helper = createDataTableColumnHelper<TData>()
    const select = helper.display({
      id: "__select",
      enableSorting: false,
      enableHiding: false,
      meta: { className: "w-10", headerClassName: "w-10" },
      header: ({ table }) => (
        <Checkbox
          aria-label={common.table.selectAll}
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={common.table.selectRow}
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onCheckedChange={(v) => row.toggleSelected(v === true)}
        />
      ),
    })
    return [select, ...columns]
  }, [columns, enableRowSelection])

  const selectionFn = React.useMemo(
    () =>
      typeof enableRowSelection === "function"
        ? (row: DataTableRow<TData>) =>
            (enableRowSelection as (r: TData) => boolean)(row.original)
        : !!enableRowSelection,
    [enableRowSelection]
  )

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns: allColumns,
    getRowId,
    state: {
      sorting,
      rowSelection,
      pagination,
      columnVisibility: columnVisibility ?? {},
    },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    enableRowSelection: selectionFn,
    enableSortingRemoval: false,
    manualSorting: server,
    // no pageSize in client mode = show every row
    manualPagination: server || !pageSize,
    autoResetPageIndex: true,
  })

  const rows = table.getRowModel().rows
  const visibleColumnCount = table.getVisibleLeafColumns().length
  const selectedRows = enableRowSelection
    ? table.getSelectedRowModel().rows.map((r) => r.original)
    : []
  const clearSelection = () => table.resetRowSelection(true)
  const showSkeleton = loading && data.length === 0
  const isEmpty = !loading && rows.length === 0

  const handleRowClick = (
    e: React.MouseEvent | React.KeyboardEvent,
    row: TData
  ) => {
    if (!onRowClick) return
    const target = e.target as HTMLElement
    // ignore events bubbling from portals (menus/dialogs opened from a cell) and from interactive cell content
    if (!(e.currentTarget as HTMLElement).contains(target)) return
    if (target.closest(INTERACTIVE_SELECTOR)) return
    onRowClick(row)
  }

  return (
    <div
      className={cn("@container/dt flex flex-col", className)}
      data-slot="data-table"
    >
      {/* Table (all widths, or once its own container is ≥ 768px when renderMobileCard is set) */}
      <div
        className={cn(
          renderMobileCard && "hidden @3xl/dt:block",
          loading && data.length > 0 && "opacity-60 transition-opacity"
        )}
      >
        <Table aria-label={ariaLabel} aria-busy={loading || undefined}>
          <TableHeader
            className={cn(
              stickyHeader &&
                "sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)]"
            )}
          >
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta
                  const align = meta?.align ?? "start"
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  const label =
                    meta?.label ??
                    (typeof header.column.columnDef.header === "string"
                      ? header.column.columnDef.header
                      : header.column.id)
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : canSort
                              ? "none"
                              : undefined
                      }
                      className={cn(
                        "h-10 text-[13px] text-muted-foreground",
                        ALIGN_CLASS[align],
                        meta?.hideBelow && HIDE_BELOW_CLASS[meta.hideBelow],
                        meta?.headerClassName
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          aria-label={common.table.sortBy(label)}
                          className={cn(
                            "-mx-1.5 inline-flex items-center gap-1 rounded-lg px-1.5 py-1 font-medium outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                            sorted && "text-foreground",
                            align === "end" && "flex-row-reverse"
                          )}
                        >
                          <table.FlexRender header={header} />
                          <HugeiconsIcon
                            icon={
                              sorted === "asc"
                                ? ArrowUp02Icon
                                : sorted === "desc"
                                  ? ArrowDown02Icon
                                  : ArrowUpDownIcon
                            }
                            strokeWidth={2}
                            className={cn("size-3.5", !sorted && "opacity-50")}
                            aria-hidden
                          />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {showSkeleton &&
              Array.from({ length: loadingRows }).map((_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  {Array.from({ length: visibleColumnCount }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton
                        className={cn("h-4", j === 0 ? "w-32" : "w-20")}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {isEmpty && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={visibleColumnCount}
                  className={cn("h-32 text-center whitespace-normal", empty ? "text-foreground" : "text-muted-foreground")}
                >
                  {empty ?? common.table.empty}
                </TableCell>
              </TableRow>
            )}
            {!showSkeleton &&
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  data-active={activeRowId === row.id || undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={
                    onRowClick
                      ? (e) => handleRowClick(e, row.original)
                      : undefined
                  }
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (
                            (e.key === "Enter" || e.key === " ") &&
                            e.target === e.currentTarget
                          ) {
                            e.preventDefault()
                            onRowClick(row.original)
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    onRowClick &&
                      "cursor-pointer outline-none focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                    "data-[active=true]:bg-brand-primary/5"
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          ALIGN_CLASS[meta?.align ?? "start"],
                          meta?.hideBelow && HIDE_BELOW_CLASS[meta.hideBelow],
                          meta?.className
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card list */}
      {renderMobileCard && (
        <ul
          className="flex flex-col divide-y @3xl/dt:hidden"
          aria-label={ariaLabel}
          aria-busy={loading || undefined}
        >
          {showSkeleton &&
            Array.from({ length: Math.min(loadingRows, 3) }).map((_, i) => (
              <li key={`msk-${i}`} className="flex flex-col gap-2 p-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
              </li>
            ))}
          {isEmpty && (
            <li className={cn("p-6 text-center text-sm", empty ? "text-foreground" : "text-muted-foreground")}>
              {empty ?? common.table.empty}
            </li>
          )}
          {!showSkeleton &&
            rows.map((row) => (
              <li key={row.id} className="flex items-start gap-3 p-4">
                {enableRowSelection && (
                  <Checkbox
                    aria-label={common.table.selectRow}
                    checked={row.getIsSelected()}
                    disabled={!row.getCanSelect()}
                    onCheckedChange={(v) => row.toggleSelected(v === true)}
                    className="mt-0.5"
                  />
                )}
                {onRowClick ? (
                  <button
                    type="button"
                    onClick={() => onRowClick(row.original)}
                    className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {renderMobileCard(row.original)}
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">
                    {renderMobileCard(row.original)}
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}

      {/* Footer: client pagination / server keyset */}
      {!server && pageSize && table.getPageCount() > 1 && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2.5 text-[13px] text-muted-foreground">
          <span className="tabular-nums">
            {common.table.rowsTotal(data.length)}
          </span>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">
              {common.table.pageOf(
                table.state.pagination.pageIndex + 1,
                table.getPageCount()
              )}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={common.table.previous}
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                strokeWidth={2}
                aria-hidden
              />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={common.table.nextPage}
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                aria-hidden
              />
            </Button>
          </div>
        </div>
      )}
      {server &&
        serverPagination &&
        (serverPagination.hasNextPage || serverPagination.hasPreviousPage) && (
          <div className="flex items-center justify-center gap-2 border-t px-3 py-2.5">
            {serverPagination.onLoadMore ? (
              serverPagination.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={serverPagination.onLoadMore}
                  disabled={serverPagination.loadingMore}
                >
                  {serverPagination.loadingMore && <Spinner aria-hidden />}
                  {serverPagination.loadingMore
                    ? common.table.loadingMore
                    : common.table.loadMore}
                </Button>
              )
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={serverPagination.onPreviousPage}
                  disabled={
                    !serverPagination.hasPreviousPage ||
                    serverPagination.loadingMore
                  }
                >
                  <HugeiconsIcon
                    icon={ArrowLeft01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  {common.table.previous}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={serverPagination.onNextPage}
                  disabled={
                    !serverPagination.hasNextPage ||
                    serverPagination.loadingMore
                  }
                >
                  {common.table.nextPage}
                  {serverPagination.loadingMore ? (
                    <Spinner aria-hidden />
                  ) : (
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={2}
                      data-icon="inline-end"
                      aria-hidden
                    />
                  )}
                </Button>
              </>
            )}
          </div>
        )}

      {/* Floating glass bulk-action bar */}
      {bulkActions && selectedRows.length > 0 && (
        <div
          role="toolbar"
          aria-label={common.table.bulkActions}
          data-bottom-action-bar=""
          className="glass-strong fixed inset-x-4 bottom-[calc(var(--app-bottom-offset,0px)+0.75rem)] z-40 md:bottom-[max(1rem,env(safe-area-inset-bottom))] mx-auto flex max-w-fit animate-in flex-wrap items-center gap-2 rounded-2xl px-3 py-2 fade-in-0 slide-in-from-bottom-4 sm:gap-3"
        >
          <span
            className="px-1 text-sm font-medium tabular-nums"
            aria-live="polite"
          >
            {common.table.selected(selectedRows.length)}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions(selectedRows, clearSelection)}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={common.table.clearSelection}
            onClick={clearSelection}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )
}
