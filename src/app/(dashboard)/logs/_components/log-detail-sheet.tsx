"use client"

import * as React from "react"
import Link from "next/link"

import { JsonViewer, PlatformBadge, StatusBadge } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDuration } from "@/lib/format"
import { logs as tl } from "@/lib/i18n/vi/logs"
import {
  getActivityLogDetailAction,
  getMcpLogDetailAction,
} from "@/server/actions/logs"
import type {
  ActivityLogDetail,
  ActivityLogListRow,
  McpLogDetail,
  McpLogListRow,
} from "@/server/services/logs"

import {
  actionLabel,
  displayValue,
  formatLogTime,
  isPlatform,
  metadataDiff,
  normalizeChanges,
  roleLabel,
  targetTypeLabel,
  type ChangeRow,
} from "./log-format"

type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T }

function useDetail<T>(
  row: { id: string; createdAt: string } | null,
  load: (input: { id: string; createdAt: string }) => Promise<{ ok: true; data: T } | { ok: false; error: string }>
): Loaded<T> {
  const [result, setResult] = React.useState<{ key: string; value: Loaded<T> } | null>(null)
  const key = row ? `${row.id}@${row.createdAt}` : ""
  React.useEffect(() => {
    if (!row) return
    let alive = true
    load({ id: row.id, createdAt: row.createdAt })
      .then((r) => {
        if (!alive) return
        setResult({ key, value: r.ok ? { state: "ok", data: r.data } : { state: "error", message: r.error } })
      })
      .catch(() => alive && setResult({ key, value: { state: "error", message: tl.errors.detailFailed } }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the row changes
  }, [key])
  return result && result.key === key ? result.value : { state: "loading" }
}

function Summary({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[9rem_1fr] sm:gap-y-2">
      {items
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="pt-1.5 text-[13px] text-muted-foreground first:pt-0 sm:pt-0 sm:text-sm">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </React.Fragment>
        ))}
    </dl>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function ChangesTable({ rows, showObject }: { rows: ChangeRow[]; showObject: boolean }) {
  if (rows.length === 0) return <p className="text-[13px] text-muted-foreground">{tl.detail.noChanges}</p>
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            {showObject && <TableHead>{tl.detail.changeObject}</TableHead>}
            <TableHead>{tl.detail.changeField}</TableHead>
            <TableHead>{tl.detail.changeBefore}</TableHead>
            <TableHead>{tl.detail.changeAfter}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c, i) => (
            <TableRow key={`${c.objectId}-${c.field}-${i}`}>
              {showObject && <TableCell className="font-mono text-xs">{c.objectId ?? "-"}</TableCell>}
              <TableCell className="font-mono text-xs">{c.field}</TableCell>
              <TableCell className="max-w-48 font-mono text-xs break-all text-muted-foreground line-through decoration-muted-foreground/40">
                {displayValue(c.before)}
              </TableCell>
              <TableCell className="max-w-48 font-mono text-xs font-medium break-all">
                {displayValue(c.after)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function LoadingBody() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label={tl.detail.loading}>
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>
}

// ---------------------------------------------------------------------------

export function McpLogSheet({
  row,
  isAdmin,
  onClose,
  onFilterMcp,
}: {
  row: McpLogListRow | null
  isAdmin: boolean
  onClose: () => void
  onFilterMcp?: (mcpId: string) => void
}) {
  const detail = useDetail<McpLogDetail>(row, getMcpLogDetailAction)
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {row && (
          <>
            <SheetHeader className="gap-1 p-5 pr-14 pb-4">
              <SheetTitle className="font-mono text-base break-all">{row.toolName ?? row.method}</SheetTitle>
              <SheetDescription>
                {tl.detail.mcpTitle} · {row.mcpName ?? tl.deletedMcp}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <StatusBadge kind="log" status={row.status} />
                <Badge variant={row.actionKind === "write" ? "default" : "secondary"}>
                  {tl.kind[row.actionKind as keyof typeof tl.kind] ?? row.actionKind}
                </Badge>
                {isPlatform(row.platform) && <PlatformBadge platform={row.platform} />}
              </div>
            </SheetHeader>
            <div className="flex flex-col gap-5 overflow-y-auto px-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
              {detail.state === "loading" && <LoadingBody />}
              {detail.state === "error" && (
                <Alert variant="destructive">
                  <AlertDescription>{detail.message}</AlertDescription>
                </Alert>
              )}
              {detail.state === "ok" && (
                <McpDetailBody d={detail.data} isAdmin={isAdmin} onFilterMcp={onFilterMcp} />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function McpDetailBody({
  d,
  isAdmin,
  onFilterMcp,
}: {
  d: McpLogDetail
  isAdmin: boolean
  onFilterMcp?: (mcpId: string) => void
}) {
  const changes = normalizeChanges(d.changes)
  return (
    <>
      <Section title={tl.detail.summary}>
        <Summary
          items={[
            [tl.detail.time, <span key="t" className="tabular-nums">{formatLogTime(d.createdAt)}</span>],
            [tl.detail.mcp, d.mcpName ?? tl.deletedMcp],
            [tl.detail.owner, isAdmin ? d.ownerEmail : null],
            [tl.detail.client, [d.clientName, d.clientVersion].filter(Boolean).join(" ") || tl.noClient],
            [tl.detail.ip, d.ip ? <Mono key="ip">{d.ip}</Mono> : null],
            [tl.detail.userAgent, d.userAgent ? <span key="ua" className="text-[13px] text-muted-foreground">{d.userAgent}</span> : null],
            [tl.detail.method, <Mono key="m">{d.method}</Mono>],
            [tl.detail.tool, d.toolName ? <Mono key="tool">{d.toolName}</Mono> : null],
            [tl.detail.account, d.adAccountId ? <Mono key="acc">{d.adAccountId}</Mono> : null],
            [tl.detail.objects, d.objectIds?.length ? <Mono key="obj">{d.objectIds.join(", ")}</Mono> : null],
            [tl.detail.duration, <span key="dur" className="tabular-nums">{formatDuration(d.durationMs)}</span>],
            [
              tl.detail.error,
              d.errorCode || d.errorMessage ? (
                <span key="err" className="text-destructive">
                  {d.errorCode ? <Mono>{d.errorCode}</Mono> : null}
                  {d.errorCode && d.errorMessage ? " - " : null}
                  {d.errorMessage}
                </span>
              ) : null,
            ],
            [
              tl.detail.upstream,
              d.upstreamRequestIds?.length ? (
                <ul key="up" className="flex flex-col gap-0.5">
                  {d.upstreamRequestIds.map((u) => (
                    <li key={u}>
                      <Mono>{u}</Mono>
                    </li>
                  ))}
                </ul>
              ) : null,
            ],
            [tl.detail.pending, d.pendingActionId ? <Mono key="p">{d.pendingActionId}</Mono> : null],
          ]}
        />
        {d.mcpId && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" className="pointer-coarse:h-10" asChild>
              <Link href={`/mcp-servers/${d.mcpId}`}>{tl.detail.viewMcp}</Link>
            </Button>
            {onFilterMcp && (
              <Button variant="ghost" size="sm" className="pointer-coarse:h-10" onClick={() => onFilterMcp(d.mcpId!)}>
                {tl.detail.filterThisMcp}
              </Button>
            )}
          </div>
        )}
      </Section>

      {d.truncated && (
        <Alert>
          <AlertDescription>{tl.detail.truncated}</AlertDescription>
        </Alert>
      )}

      {(d.actionKind === "write" || changes.length > 0) && (
        <Section title={tl.detail.changes}>
          <ChangesTable rows={changes} showObject={changes.some((c) => c.objectId)} />
        </Section>
      )}

      {d.request !== null && d.request !== undefined && (
        <JsonViewer label={tl.detail.request} data={d.request} defaultExpandDepth={2} maxHeight="20rem" />
      )}
      {d.response !== null && d.response !== undefined && (
        <JsonViewer label={tl.detail.response} data={d.response} defaultExpandDepth={1} maxHeight="20rem" />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

export function ActivityLogSheet({ row, onClose }: { row: ActivityLogListRow | null; onClose: () => void }) {
  const detail = useDetail<ActivityLogDetail>(row, getActivityLogDetailAction)
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {row && (
          <>
            <SheetHeader className="gap-1 p-5 pr-14 pb-4">
              <SheetTitle>{actionLabel(row.action)}</SheetTitle>
              <SheetDescription>
                {tl.detail.staffTitle} · <span className="font-mono text-xs">{row.action}</span>
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <StatusBadge
                  kind="log"
                  status={row.status === "success" ? "success" : "error"}
                  label={tl.result[row.status as keyof typeof tl.result] ?? row.status}
                />
              </div>
            </SheetHeader>
            <div className="flex flex-col gap-5 overflow-y-auto px-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
              <Section title={tl.detail.summary}>
                <Summary
                  items={[
                    [tl.detail.time, <span key="t" className="tabular-nums">{formatLogTime(row.createdAt)}</span>],
                    [tl.detail.actor, row.actorEmail ?? tl.system],
                    [tl.detail.role, row.actorRole ? roleLabel(row.actorRole) : null],
                    [
                      tl.detail.target,
                      row.targetType || row.targetLabel || row.targetId ? (
                        <span key="tg">
                          {targetTypeLabel(row.targetType)}
                          {row.targetLabel ? ` · ${row.targetLabel}` : ""}
                          {row.targetId && row.targetId !== row.targetLabel ? (
                            <span className="block font-mono text-xs text-muted-foreground">{row.targetId}</span>
                          ) : null}
                        </span>
                      ) : null,
                    ],
                    [tl.detail.ip, row.ip ? <Mono key="ip">{row.ip}</Mono> : null],
                    [tl.detail.userAgent, row.userAgent ? <span key="ua" className="text-[13px] text-muted-foreground">{row.userAgent}</span> : null],
                  ]}
                />
              </Section>
              {detail.state === "loading" && <LoadingBody />}
              {detail.state === "error" && (
                <Alert variant="destructive">
                  <AlertDescription>{detail.message}</AlertDescription>
                </Alert>
              )}
              {detail.state === "ok" && <ActivityMetadata metadata={detail.data.metadata} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ActivityMetadata({ metadata }: { metadata: unknown }) {
  const diff = metadataDiff(metadata)
  const empty = !metadata || (typeof metadata === "object" && Object.keys(metadata as object).length === 0)
  return (
    <>
      {diff.length > 0 && (
        <Section title={tl.detail.changes}>
          <ChangesTable rows={diff} showObject={false} />
        </Section>
      )}
      {!empty && <JsonViewer label={tl.detail.metadata} data={metadata} defaultExpandDepth={2} maxHeight="20rem" />}
    </>
  )
}
