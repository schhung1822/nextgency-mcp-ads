"use client"

// Sheet source: first rows mapped to the configured columns (read-only) + status counts.
import * as React from "react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  createDataTableColumnHelper,
  DataTable,
  STATUS_TONE_CLASSES,
  type StatusTone,
} from "@/components/app"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { sheetStatusLabel } from "@/lib/drive-sheet-status"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import type {
  DriveSheetPreview,
  DriveSheetPreviewRow,
  SheetColumnKey,
} from "@/lib/schemas/drive"
import { previewDriveSheetRowsAction } from "@/server/actions/drive"

import { ListingErrorAlert, type ListingErrorOptions } from "./listing-error"

const m = driveUi.detail
const cols = driveUi.wizard.columns

/**
 * Status chip: the values the system writes get their colour (Chờ lên / Đang xử lý / Đã lên / Lỗi) - their aliases
 * too ("Chưa tạo ads", "Đã tạo"…), others neutral.
 */
function SheetStatusChip({
  status,
  count,
  className,
}: {
  status: string
  count?: number
  className?: string
}) {
  const tone: StatusTone = status
    ? (m.sheetStatusTone[sheetStatusLabel(status).toLowerCase()] ?? "neutral")
    : "neutral"
  const t = STATUS_TONE_CLASSES[tone]
  return (
    <Badge
      data-tone={tone}
      className={cn(
        "rounded-full font-medium whitespace-nowrap ring-1 ring-inset",
        t.badge,
        className
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      {status || m.emptyStatus}
      {count !== undefined && <span className="tabular-nums opacity-80">{count}</span>}
    </Badge>
  )
}

/** Columns worth a table column (the long text ones - content / headline - stay out of the preview). */
const SHOWN: SheetColumnKey[] = ["link", "name", "platform", "account", "status"]

const col = createDataTableColumnHelper<DriveSheetPreviewRow>()

type State =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; preview: DriveSheetPreview }

export function SheetPreview({
  sourceId,
  configured,
  onHeader,
  reloadKey = 0,
  listingError,
}: {
  sourceId: string
  /** logical columns mapped in the source config */
  configured: SheetColumnKey[]
  /** the header row read from the sheet (edit dialog uses it for the column pickers) */
  onHeader?: (header: string[] | null) => void
  /** bumped by the page after "Kiểm tra lại" → the preview loads again */
  reloadKey?: number
  /** error state: note about the last check + the one action (see ListingErrorAlert) */
  listingError?: ListingErrorOptions
}) {
  const [reload, setReload] = React.useState(0)
  const reqKey = `${reload}|${reloadKey}`
  // the result belongs to one request (retry = new request); anything else reads as "loading"
  const [result, setResult] = React.useState<{
    key: string
    value: Exclude<State, { state: "loading" }>
  } | null>(null)
  const data: State =
    result && result.key === reqKey ? result.value : { state: "loading" }

  React.useEffect(() => {
    let cancelled = false
    const key = reqKey
    void previewDriveSheetRowsAction({ sourceId }).then(
      (res) => {
        if (cancelled) return
        if (!res.ok) {
          setResult({ key, value: { state: "error", message: res.error } })
          onHeader?.(null)
          return
        }
        setResult({ key, value: { state: "ready", preview: res.data } })
        onHeader?.(res.data.header)
      },
      () =>
        !cancelled &&
        setResult({
          key,
          value: { state: "error", message: driveUi.service.generic },
        })
    )
    return () => {
      cancelled = true
    }
  }, [sourceId, reqKey, onHeader])

  const columns = React.useMemo(() => {
    const keys = SHOWN.filter((k) => configured.includes(k))
    return col.columns([
      col.accessor("rowNumber", {
        header: m.colRow,
        meta: { className: "w-14 tabular-nums text-muted-foreground" },
        cell: ({ getValue }) => getValue(),
      }),
      ...keys.map((k) =>
        col.accessor((r) => r.values[k] ?? "", {
          id: k,
          header: cols[k] ?? k,
          meta:
            k === "link"
              ? { className: "w-full min-w-48 max-w-0" }
              : k === "status"
                ? undefined
                : {
                    className: "hidden @2xl:table-cell",
                    headerClassName: "hidden @2xl:table-cell",
                  },
          cell: ({ getValue }) => {
            const v = String(getValue() ?? "")
            if (!v)
              return (
                <span aria-hidden className="text-muted-foreground">
                  —
                </span>
              )
            return k === "status" ? (
              <SheetStatusChip status={v} />
            ) : (
              <span
                title={v}
                className={
                  k === "link"
                    ? "block truncate font-mono text-xs"
                    : "block max-w-48 truncate"
                }
              >
                {v}
              </span>
            )
          },
        })
      ),
    ])
  }, [configured])

  return (
    <Card className="@container gap-0 pb-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>{m.sheetTitle}</CardTitle>
        <CardDescription>{m.sheetDescription}</CardDescription>
      </CardHeader>

      {data.state === "loading" && (
        <CardContent className="flex flex-col gap-3 py-5" aria-busy="true">
          <div className="flex gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-6 w-24 rounded-full" />
            ))}
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </CardContent>
      )}

      {data.state === "error" && (
        <CardContent className="py-5">
          <ListingErrorAlert
            title={m.sheetErrorTitle}
            message={data.message}
            options={listingError}
            onReload={() => setReload((n) => n + 1)}
          />
        </CardContent>
      )}

      {data.state === "ready" && (
        <>
          <div className="flex flex-col gap-3 border-b px-5 py-4">
            {Object.keys(data.preview.statusCounts).length > 0 && (
              <div
                role="group"
                aria-label={m.statusCountsLabel}
                className="flex flex-wrap gap-1.5"
              >
                {Object.entries(data.preview.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, n]) => (
                    <SheetStatusChip
                      key={status || "__empty"}
                      status={status}
                      count={n}
                    />
                  ))}
              </div>
            )}
            <p className="text-[13px] text-muted-foreground">
              {m.rowsRead(data.preview.rowsRead, data.preview.more)}
            </p>
            {data.preview.missingColumns.length > 0 && (
              <p className="flex items-start gap-1.5 text-[13px] text-warning-strong">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  strokeWidth={2}
                  className="mt-px size-3.5 shrink-0"
                  aria-hidden
                />
                {m.missingColumns(
                  data.preview.missingColumns
                    .map((k) => cols[k] ?? k)
                    .join(", ")
                )}
              </p>
            )}
          </div>
          {data.preview.rows.length === 0 ? (
            <CardContent className="py-8 text-sm text-muted-foreground">
              {m.sheetEmpty}
            </CardContent>
          ) : (
            <DataTable
              ariaLabel={m.sheetTableLabel}
              columns={columns}
              data={data.preview.rows}
              getRowId={(r) => String(r.rowNumber)}
              pageSize={20}
              renderMobileCard={(r) => (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-medium break-words">
                      <span className="text-muted-foreground tabular-nums">
                        #{r.rowNumber}
                      </span>{" "}
                      {r.values.name || r.values.link || "—"}
                    </span>
                    {r.values.status && (
                      <SheetStatusChip
                        status={r.values.status}
                        className="shrink-0"
                      />
                    )}
                  </div>
                  {r.values.link && (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {r.values.link}
                    </span>
                  )}
                  {(r.values.platform || r.values.account) && (
                    <span className="text-[13px] text-muted-foreground">
                      {[r.values.platform, r.values.account]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </div>
              )}
            />
          )}
        </>
      )}
    </Card>
  )
}
