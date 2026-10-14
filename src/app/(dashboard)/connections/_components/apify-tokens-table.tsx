"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Add01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  LockKeyIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  BrandIcon,
  ConfirmDialog,
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  FilterBar,
  RelativeTime,
  type FilterValues,
} from "@/components/app"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apify as a } from "@/lib/i18n/vi/apify"
import {
  APIFY_TOKEN_SCOPES,
  APIFY_TOKEN_STATUSES,
  type ApifyTokenDto,
} from "@/lib/schemas/apify"
import {
  deleteApifyTokenAction,
  recheckApifyTokenAction,
  setApifyTokenEnabledAction,
} from "@/server/actions/apify"

import {
  ApifyScopeBadge,
  ApifyStatusBadge,
} from "../apify/_components/apify-badges"
import {
  accountLabel,
  apifyStatusText,
  creditLabel,
  formatDayMonth,
} from "../apify/_components/apify-format"

const m = a.list

const col = createDataTableColumnHelper<ApifyTokenDto>()

const HIDE_BELOW_2XL = "hidden @2xl:table-cell"
const HIDE_BELOW_3XL = "hidden @3xl:table-cell"
const HIDE_BELOW_5XL = "hidden @5xl:table-cell"
const HIDE_BELOW_6XL = "hidden @6xl:table-cell"

const detailHref = (id: string) => `/connections/apify/${id}`

type RowAction = "recheck" | "enable" | "disable" | "delete"

function CreditCell({ token }: { token: ApifyTokenDto }) {
  const credit = creditLabel(token)
  const reset = formatDayMonth(token.cycleEndAt)
  if (!credit)
    return <span className="text-muted-foreground">{m.noCredit}</span>
  return (
    <span className="flex min-w-0 flex-col">
      <span className="whitespace-nowrap tabular-nums">{credit}</span>
      {reset && (
        <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {a.ui.resetOn(reset)}
        </span>
      )}
    </span>
  )
}

function RowMenu({
  token,
  busy,
  onAction,
}: {
  token: ApifyTokenDto
  busy: boolean
  onAction: (action: RowAction, token: ApifyTokenDto) => void
}) {
  const disabled = token.status === "disabled"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-10 md:size-8"
          aria-label={m.rowMenu(token.name)}
          disabled={busy}
        >
          <HugeiconsIcon
            icon={MoreHorizontalIcon}
            strokeWidth={2}
            aria-hidden
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem asChild>
          <Link href={detailHref(token.id)}>
            <HugeiconsIcon icon={ViewIcon} strokeWidth={2} aria-hidden />
            {m.open}
          </Link>
        </DropdownMenuItem>
        {token.canManage ? (
          <>
            <DropdownMenuItem onSelect={() => onAction("recheck", token)}>
              <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} aria-hidden />
              {m.recheck}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onAction(disabled ? "enable" : "disable", token)}
            >
              <HugeiconsIcon
                icon={disabled ? PlayIcon : PauseIcon}
                strokeWidth={2}
                aria-hidden
              />
              {disabled ? m.enable : m.disable}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onAction("delete", token)}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
              {m.delete}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex max-w-64 items-start gap-2 text-xs font-normal text-muted-foreground">
              <HugeiconsIcon
                icon={LockKeyIcon}
                strokeWidth={2}
                className="mt-px size-3.5 shrink-0"
                aria-hidden
              />
              {m.readOnlyHint}
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function buildColumns(
  isAdmin: boolean,
  busyId: string | null,
  onAction: (action: RowAction, token: ApifyTokenDto) => void
) {
  return col.columns([
    col.accessor("name", {
      header: m.colName,
      meta: { className: "w-full min-w-44 max-w-0" },
      cell: ({ row }) => (
        <Link
          href={detailHref(row.original.id)}
          title={row.original.name}
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <BrandIcon brand="apify" />
          <span className="line-clamp-2 break-words whitespace-normal">
            {row.original.name}
          </span>
        </Link>
      ),
    }),
    col.accessor("scope", {
      header: m.colScope,
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ row }) => (
        <span
          className="inline-flex items-center gap-1.5"
          title={row.original.canManage ? undefined : m.readOnlyHint}
        >
          <ApifyScopeBadge scope={row.original.scope} />
          {!row.original.canManage && (
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {m.readOnly}
            </span>
          )}
        </span>
      ),
    }),
    ...(isAdmin
      ? [
          col.accessor((r) => r.ownerName ?? "", {
            id: "owner",
            header: m.colOwner,
            meta: {
              className: HIDE_BELOW_5XL,
              headerClassName: HIDE_BELOW_5XL,
            },
            cell: ({ row }) => (
              <span className="block max-w-40 truncate text-muted-foreground">
                {row.original.ownerName ?? <span aria-hidden>—</span>}
              </span>
            ),
          }),
        ]
      : []),
    col.accessor((r) => accountLabel(r), {
      id: "account",
      header: m.colAccount,
      meta: { className: HIDE_BELOW_3XL, headerClassName: HIDE_BELOW_3XL },
      cell: ({ row }) => (
        <span
          className="block max-w-48 truncate"
          title={accountLabel(row.original)}
        >
          {accountLabel(row.original)}
        </span>
      ),
    }),
    col.accessor((r) => r.usageUsd ?? -1, {
      id: "credit",
      header: m.colCredit,
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ row }) => <CreditCell token={row.original} />,
    }),
    col.accessor("status", {
      header: m.colStatus,
      cell: ({ row }) => {
        const msg = apifyStatusText(row.original)
        return (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <ApifyStatusBadge token={row.original} />
            {/* the reason in two lines at most (full text in the tooltip and on the detail page) */}
            {msg && (
              <span
                className="line-clamp-2 max-w-60 text-[13px] break-words whitespace-normal text-destructive"
                title={msg}
              >
                {msg}
              </span>
            )}
          </span>
        )
      },
    }),
    col.accessor("lastCheckedAt", {
      header: m.colChecked,
      sortUndefined: "last",
      // the widest cards only (admins also get the creator column first): the table never scrolls sideways
      meta: isAdmin
        ? { className: HIDE_BELOW_6XL, headerClassName: HIDE_BELOW_6XL }
        : { className: HIDE_BELOW_5XL, headerClassName: HIDE_BELOW_5XL },
      cell: ({ getValue }) =>
        getValue() ? (
          <RelativeTime value={getValue()} className="text-muted-foreground" />
        ) : (
          <span className="text-muted-foreground">{m.never}</span>
        ),
    }),
    col.display({
      id: "actions",
      header: () => <span className="sr-only">{m.colActions}</span>,
      enableSorting: false,
      meta: { align: "end", className: "w-12 pl-0", label: m.colActions },
      cell: ({ row }) => (
        <RowMenu
          token={row.original}
          busy={busyId === row.original.id}
          onAction={onAction}
        />
      ),
    }),
  ])
}

/**
 * "Apify" view of /connections: the tokens the viewer may see (admin: all, with the creator; staff: company tokens
 * read-only + own personal tokens). Never carries a secret - only the 4-char hint lives on the DTO.
 */
export function ApifyTokensTable({
  tokens,
  isAdmin,
  /** the page header already shows the one brand button → the empty-state CTA is outline */
  ctaVariant = "brand",
}: {
  tokens: ApifyTokenDto[]
  isAdmin: boolean
  ctaVariant?: "brand" | "outline"
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<ApifyTokenDto | null>(null)

  const onAction = React.useCallback(
    async (action: RowAction, token: ApifyTokenDto) => {
      if (action === "delete") {
        setDeleting(token)
        return
      }
      setBusyId(token.id)
      try {
        if (action === "recheck") {
          const res = await recheckApifyTokenAction({ id: token.id })
          if (!res.ok) {
            toast.error(res.error)
            return
          }
          // invalid / error = Apify refused the token or the check failed: show why (the row shows it too)
          if (res.data.status === "invalid" || res.data.status === "error")
            toast.error(m.recheckFailed, {
              description: res.data.statusMessage ?? undefined,
            })
          else toast.success(res.message ?? a.server.rechecked)
        } else {
          const enabled = action === "enable"
          const res = await setApifyTokenEnabledAction({
            id: token.id,
            enabled,
          })
          if (!res.ok) {
            toast.error(res.error)
            return
          }
          toast.success(
            res.message ?? (enabled ? a.server.enabled : a.server.disabled)
          )
        }
        router.refresh()
      } finally {
        setBusyId(null)
      }
    },
    [router]
  )

  const columns = React.useMemo(
    () => buildColumns(isAdmin, busyId, (act, t) => void onAction(act, t)),
    [isAdmin, busyId, onAction]
  )
  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const scope = filters.scope ?? []
    const st = filters.status ?? []
    return tokens.filter(
      (t) =>
        (scope.length === 0 || scope.includes(t.scope)) &&
        (st.length === 0 || st.includes(t.status)) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          (t.apifyUsername ?? "").toLowerCase().includes(q) ||
          (isAdmin && (t.ownerName ?? "").toLowerCase().includes(q)))
    )
  }, [tokens, search, filters, isAdmin])

  const deleteDialog = (
    <ConfirmDialog
      open={deleting !== null}
      onOpenChange={(o) => !o && setDeleting(null)}
      destructive
      title={a.remove.title}
      description={deleting ? a.remove.description(deleting.name) : undefined}
      confirmText={deleting?.name}
      confirmLabel={a.remove.confirm}
      onConfirm={async () => {
        if (!deleting) return false
        const res = await deleteApifyTokenAction({
          id: deleting.id,
          confirmName: deleting.name,
        })
        if (!res.ok) {
          toast.error(res.error)
          return false
        }
        toast.success(res.message ?? a.server.deleted)
        setDeleting(null)
        router.refresh()
      }}
    >
      <p className="text-[13px] text-pretty text-muted-foreground">
        {a.remove.revokeTip}
      </p>
    </ConfirmDialog>
  )

  if (tokens.length === 0) {
    return (
      <EmptyState
        icon={Add01Icon}
        title={m.emptyTitle}
        description={m.emptyDescription}
        action={
          <Button variant={ctaVariant} asChild>
            <Link href="/connections/apify/new">
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.add}
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
            placeholder: m.searchPlaceholder,
            label: m.searchLabel,
          }}
          filters={[
            {
              id: "scope",
              label: m.filterScope,
              options: APIFY_TOKEN_SCOPES.map((s) => ({
                value: s,
                label: a.ui.scope[s] ?? s,
                count: tokens.filter((t) => t.scope === s).length,
              })),
            },
            {
              id: "status",
              label: m.filterStatus,
              options: APIFY_TOKEN_STATUSES.map((s) => ({
                value: s,
                label: a.ui.status[s] ?? s,
                count: tokens.filter((t) => t.status === s).length,
              })),
            },
          ]}
          values={filters}
          onValuesChange={setFilters}
        />
      </div>
      <DataTable
        ariaLabel={m.tableLabel}
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        defaultSorting={[{ id: "name", desc: false }]}
        pageSize={20}
        onRowClick={(r) => router.push(detailHref(r.id))}
        empty={
          <EmptyState
            title={m.emptyFilteredTitle}
            description={m.emptyFilteredDescription}
          />
        }
        renderMobileCard={(r) => {
          const credit = creditLabel(r)
          const msg = apifyStatusText(r)
          return (
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <BrandIcon brand="apify" />
                    <span className="line-clamp-2 break-words">{r.name}</span>
                  </span>
                  <ApifyStatusBadge token={r} className="shrink-0" />
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                  <ApifyScopeBadge scope={r.scope} />
                  {!r.canManage && <span>{m.readOnly}</span>}
                  <span className="max-w-full truncate">{accountLabel(r)}</span>
                  {credit && (
                    <span className="tabular-nums">
                      {m.colCredit}: {credit}
                    </span>
                  )}
                  {isAdmin && r.ownerName && (
                    <span className="max-w-full truncate">{r.ownerName}</span>
                  )}
                </div>
                {msg && (
                  <p className="line-clamp-2 text-[13px] break-words text-destructive">
                    {msg}
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
          )
        }}
      />
      {deleteDialog}
    </>
  )
}
