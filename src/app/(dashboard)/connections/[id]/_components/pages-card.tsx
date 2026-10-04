"use client"

// Facebook Pages of a Meta connection: enable/disable each Page for MCP use (read-only Pages tools).
import * as React from "react"
import { toast } from "sonner"
import { Alert02Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  createDataTableColumnHelper,
  DataTable,
  RelativeTime,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { formatNumber } from "@/lib/format"
import { connections as m } from "@/lib/i18n/vi/connections"
import type { ConnectionDetail, MetaPageDto } from "@/lib/schemas/connections"
import { toggleMetaPagesAction } from "@/server/actions/connections"

import { WarningsAlert } from "../../_components/token-summary"

const t = m.pages
const col = createDataTableColumnHelper<MetaPageDto>()

/** Scopes the read-only Pages tools need (providers/meta.md §10.1). */
const PAGE_READ_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "pages_read_user_content",
]

function SourceBadge({ page }: { page: MetaPageDto }) {
  const viaBm = page.sources.some(
    (s) => s === "owned_pages" || s === "client_pages"
  )
  const direct = page.sources.includes("me_accounts")
  return (
    <span className="flex flex-wrap gap-1 @3xl:flex-nowrap">
      {direct && (
        <Badge variant="outline" className="rounded-full text-[11px]">
          {t.sourceDirect}
        </Badge>
      )}
      {viaBm && page.businessName && (
        <Badge
          variant="outline"
          className="max-w-48 truncate rounded-full text-[11px]"
          title={page.businessName}
        >
          {t.sourceBm(page.businessName)}
        </Badge>
      )}
    </span>
  )
}

function Abilities({ page }: { page: MetaPageDto }) {
  const c = page.capabilities
  if (!c.posts && !c.insights && !c.adsPosts)
    return (
      <Badge
        variant="secondary"
        className="rounded-full text-[11px]"
        title={t.listOnlyHelp}
      >
        {t.listOnly}
      </Badge>
    )
  return (
    <span className="flex flex-wrap gap-1 @3xl:flex-nowrap">
      {c.posts && (
        <Badge variant="secondary" className="rounded-full text-[11px]">
          {t.abilityPosts}
        </Badge>
      )}
      {c.insights && (
        <Badge variant="secondary" className="rounded-full text-[11px]">
          {t.abilityInsights}
        </Badge>
      )}
      {c.adsPosts && (
        <Badge variant="secondary" className="rounded-full text-[11px]">
          {t.abilityAds}
        </Badge>
      )}
    </span>
  )
}

function PageName({ page }: { page: MetaPageDto }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2 font-medium">
        <span className="truncate" title={page.name}>
          {page.name}
        </span>
        {page.isMissing && (
          <Badge
            variant="outline"
            className="shrink-0 rounded-full border-warning-strong/40 text-[11px] text-warning-strong"
            title={t.missingHelp}
          >
            {t.missingBadge}
          </Badge>
        )}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {page.externalId}
        {page.category ? ` · ${page.category}` : ""}
      </span>
    </div>
  )
}

export function PagesCard({
  detail,
  busy,
  onSync,
}: {
  detail: ConnectionDetail
  busy: boolean
  onSync: () => void
}) {
  // remounted (key) when the server data changes, so local optimistic state starts fresh
  const [pages, setPages] = React.useState(detail.pages)
  const [pending, setPending] = React.useState<Set<string>>(new Set())
  const sync = detail.pagesSync
  // only when the platform reported the token scopes (null = unknown)
  const missingScopes = detail.scopes
    ? PAGE_READ_SCOPES.filter((s) => !detail.scopes!.includes(s))
    : []

  const toggle = React.useCallback(
    async (p: MetaPageDto, enabled: boolean) => {
      setPending((s) => new Set(s).add(p.id))
      setPages((list) =>
        list.map((x) => (x.id === p.id ? { ...x, isEnabled: enabled } : x))
      )
      const res = await toggleMetaPagesAction({
        connectionId: detail.id,
        changes: [{ pageId: p.id, enabled }],
      })
      setPending((s) => {
        const n = new Set(s)
        n.delete(p.id)
        return n
      })
      if (!res.ok) {
        setPages((list) =>
          list.map((x) => (x.id === p.id ? { ...x, isEnabled: !enabled } : x))
        )
        toast.error(res.error)
        return
      }
      toast.success(t.toggled(enabled))
    },
    [detail.id]
  )

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor("isEnabled", {
          header: () => <span className="sr-only">{t.colEnabled}</span>,
          enableSorting: false,
          meta: { className: "w-14", label: t.colEnabled },
          cell: ({ row }) => (
            <Switch
              checked={row.original.isEnabled}
              disabled={pending.has(row.original.id)}
              aria-label={t.toggle(row.original.name)}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(on) => void toggle(row.original, on)}
            />
          ),
        }),
        col.accessor("name", {
          header: t.colPage,
          meta: { className: "w-full min-w-44 max-w-0" },
          cell: ({ row }) => <PageName page={row.original} />,
        }),
        col.accessor("followersCount", {
          header: t.colFollowers,
          meta: { className: "text-right tabular-nums", headerClassName: "text-right" },
          cell: ({ getValue }) => formatNumber(getValue() ?? null),
        }),
        col.display({
          id: "source",
          header: t.colSource,
          meta: {
            className: "hidden @2xl:table-cell @3xl:whitespace-nowrap",
            headerClassName: "hidden @2xl:table-cell",
          },
          cell: ({ row }) => <SourceBadge page={row.original} />,
        }),
        col.display({
          id: "abilities",
          header: t.colAbilities,
          meta: { className: "@3xl:whitespace-nowrap" },
          cell: ({ row }) => <Abilities page={row.original} />,
        }),
      ]),
    [pending, toggle]
  )

  const enabled = pages.filter((p) => p.isEnabled).length
  return (
    <Card className="@container gap-0 pb-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>
          {t.description}{" "}
          {pages.length > 0 && (
            <span className="tabular-nums">({t.count(enabled, pages.length)})</span>
          )}
        </CardDescription>
        {sync && (
          <p className="text-[13px] text-muted-foreground">
            {t.lastSync}: <RelativeTime value={sync.at} />
          </p>
        )}
      </CardHeader>
      {sync && !sync.ok && (
        <div className="border-b p-4">
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertTitle>{t.syncFailedTitle}</AlertTitle>
            <AlertDescription>
              {sync.warnings[0] ? <p>{sync.warnings[0]}</p> : null}
              <p>{t.syncFailedHelp}</p>
            </AlertDescription>
          </Alert>
        </div>
      )}
      {missingScopes.length > 0 && !(sync && !sync.ok) && (
        <div className="border-b p-4">
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertDescription>
              {t.missingScopes(missingScopes.join(", "))}
            </AlertDescription>
          </Alert>
        </div>
      )}
      {sync?.ok && sync.warnings.length > 0 && (
        <div className="border-b p-4">
          <WarningsAlert title={t.syncWarnings} warnings={sync.warnings} />
        </div>
      )}
      {pages.length === 0 ? (
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <p className="text-sm text-muted-foreground">
            {sync ? t.empty : t.neverSynced}
          </p>
          <Button variant="outline" onClick={onSync} disabled={busy}>
            {busy ? (
              <Spinner aria-hidden />
            ) : (
              <HugeiconsIcon
                icon={RefreshIcon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
            )}
            {m.detail.sync}
          </Button>
        </CardContent>
      ) : (
        <>
          <DataTable
            ariaLabel={t.table}
            columns={columns}
            data={pages}
            getRowId={(r) => r.id}
            defaultSorting={[{ id: "name", desc: false }]}
            pageSize={20}
            renderMobileCard={(r) => (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <PageName page={r} />
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t.colFollowers}: {formatNumber(r.followersCount ?? null)}
                  </span>
                  <Abilities page={r} />
                </div>
                <Switch
                  checked={r.isEnabled}
                  disabled={pending.has(r.id)}
                  aria-label={t.toggle(r.name)}
                  onCheckedChange={(on) => void toggle(r, on)}
                />
              </div>
            )}
          />
          <p className="border-t px-4 py-3 text-[13px] text-muted-foreground">
            {t.newDisabledNote}
          </p>
        </>
      )}
    </Card>
  )
}
