"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Add01Icon,
  Delete02Icon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  ConfirmDialog,
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  PlatformIcon,
  RelativeTime,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { tiktokSocialVi as t } from "@/lib/i18n/vi/tiktok-social"
import type { TiktokSocialAccountDto } from "@/lib/schemas/tiktok-social"
import { deleteTiktokSocialAction, setTiktokSocialEnabledAction } from "@/server/actions/tiktok-social"

const col = createDataTableColumnHelper<TiktokSocialAccountDto>()
const HIDE_BELOW_2XL = "hidden @2xl:table-cell"
const HIDE_BELOW_3XL = "hidden @3xl:table-cell"
const HIDE_BELOW_5XL = "hidden @5xl:table-cell"

export const TIKTOK_SOCIAL_NEW = "/connections/tiktok-social/new"
const reconnectHref = (id: string) => `${TIKTOK_SOCIAL_NEW}?reconnect=${id}`

/** result of the OAuth callback (?status=ok&u= | ?status=error&reason=) shown above the table */
export interface TiktokSocialCallbackResult {
  status: "ok" | "error"
  username?: string
  reconnected?: boolean
  reason?: string
  expected?: string
  got?: string
}

function callbackMessage(r: TiktokSocialCallbackResult): { title: string; body: string | null; error: boolean } {
  const e = t.errors
  if (r.status === "ok") {
    const u = r.username ?? ""
    return { title: r.reconnected ? t.callback.reconnected(u) : t.callback.ok(u), body: null, error: false }
  }
  const body =
    r.reason === "denied"
      ? e.denied
      : r.reason === "auth"
        ? e.tiktokAuth
        : r.reason === "profile"
          ? e.noProfile
          : r.reason === "duplicate"
            ? e.duplicateOther
            : r.reason === "wrong" && r.expected && r.got
              ? e.wrongAccount(r.expected, r.got)
              : r.reason === "not_found"
                ? e.notFound
                : r.reason === "register"
                  ? e.registerFailed
                  : r.reason === "state"
                    ? e.stateInvalid
                    : e.tiktokDown
  return { title: t.callback.title, body, error: true }
}

function StatusBadge({ a }: { a: TiktokSocialAccountDto }) {
  const variant = a.status === "invalid" ? "destructive" : a.status === "active" ? "secondary" : "outline"
  return <Badge variant={variant}>{t.status[a.status]}</Badge>
}

const typeLabel = (a: TiktokSocialAccountDto) =>
  a.isBusinessAccount === true ? t.type.business : a.isBusinessAccount === false ? t.type.personal : t.type.unknown

const dayMonthYear = (iso: string) => new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })

type RowAction = "enable" | "disable" | "delete"

function RowMenu({ a, busy, onAction }: { a: TiktokSocialAccountDto; busy: boolean; onAction: (act: RowAction, a: TiktokSocialAccountDto) => void }) {
  if (!a.canManage) return null
  const disabled = a.status === "disabled"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-10 md:size-8" aria-label={`Thao tác: ${a.name}`} disabled={busy}>
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem asChild>
          <Link href={reconnectHref(a.id)}>
            <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} aria-hidden />
            {t.reconnect}
          </Link>
        </DropdownMenuItem>
        {a.profileUrl && (
          <DropdownMenuItem asChild>
            <a href={a.profileUrl} target="_blank" rel="noopener noreferrer">
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} aria-hidden />
              {t.detail.profile}
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onAction(disabled ? "enable" : "disable", a)}>
          <HugeiconsIcon icon={disabled ? PlayIcon : PauseIcon} strokeWidth={2} aria-hidden />
          {disabled ? t.enable : t.disable}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete", a)}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
          {t.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "TikTok Social" view of /connections: connected TikTok accounts (admin: all, with who connected them; staff: own).
 * Never carries a token.
 */
export function TiktokSocialTable({
  accounts,
  isAdmin,
  callback,
  ctaVariant = "brand",
}: {
  accounts: TiktokSocialAccountDto[]
  isAdmin: boolean
  callback?: TiktokSocialCallbackResult | null
  ctaVariant?: "brand" | "outline"
}) {
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<TiktokSocialAccountDto | null>(null)

  const onAction = React.useCallback(
    async (act: RowAction, a: TiktokSocialAccountDto) => {
      if (act === "delete") return setDeleting(a)
      setBusyId(a.id)
      try {
        const res = await setTiktokSocialEnabledAction({ id: a.id, enabled: act === "enable" })
        if (!res.ok) return void toast.error(res.error)
        toast.success(res.message ?? "")
        router.refresh()
      } finally {
        setBusyId(null)
      }
    },
    [router]
  )

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor("name", {
          header: t.columns.account,
          meta: { className: "w-full min-w-44 max-w-0" },
          cell: ({ row }) => (
            <span className="flex min-w-0 items-center gap-2">
              <PlatformIcon platform="tiktok" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{row.original.name}</span>
                <span className="truncate text-xs text-muted-foreground">@{row.original.username}</span>
              </span>
            </span>
          ),
        }),
        col.accessor((r) => typeLabel(r), {
          id: "type",
          header: t.columns.type,
          meta: { className: HIDE_BELOW_3XL, headerClassName: HIDE_BELOW_3XL },
          cell: ({ getValue }) => <span className="whitespace-nowrap text-muted-foreground">{getValue()}</span>,
        }),
        ...(isAdmin
          ? [
              col.accessor((r) => r.ownerEmail ?? "", {
                id: "owner",
                header: t.columns.owner,
                meta: { className: HIDE_BELOW_5XL, headerClassName: HIDE_BELOW_5XL },
                cell: ({ getValue }) => <span className="block max-w-48 truncate text-muted-foreground">{getValue()}</span>,
              }),
            ]
          : []),
        col.accessor("status", {
          header: t.columns.status,
          cell: ({ row }) => (
            <span className="flex min-w-0 flex-col items-start gap-1">
              <StatusBadge a={row.original} />
              {row.original.statusMessage && (
                <span className="line-clamp-2 max-w-60 text-[13px] break-words whitespace-normal text-destructive" title={row.original.statusMessage}>
                  {row.original.statusMessage}
                </span>
              )}
            </span>
          ),
        }),
        col.accessor("refreshExpiresAt", {
          header: t.columns.expires,
          meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
          cell: ({ getValue }) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{dayMonthYear(getValue())}</span>,
        }),
        col.accessor("lastUsedAt", {
          header: t.columns.lastUsed,
          sortUndefined: "last",
          meta: { className: HIDE_BELOW_5XL, headerClassName: HIDE_BELOW_5XL },
          cell: ({ getValue }) => (getValue() ? <RelativeTime value={getValue()!} className="text-muted-foreground" /> : <span className="text-muted-foreground">-</span>),
        }),
        col.display({
          id: "actions",
          header: () => <span className="sr-only">Thao tác</span>,
          enableSorting: false,
          meta: { align: "end", className: "w-12 pl-0", label: "Thao tác" },
          cell: ({ row }) => <RowMenu a={row.original} busy={busyId === row.original.id} onAction={(x, y) => void onAction(x, y)} />,
        }),
      ]),
    [isAdmin, busyId, onAction]
  )

  const cb = callback ? callbackMessage(callback) : null
  const banner = cb && (
    <div className="border-b p-3">
      <Alert variant={cb.error ? "destructive" : "default"}>
        <AlertTitle>{cb.title}</AlertTitle>
        {cb.body && <AlertDescription>{cb.body}</AlertDescription>}
      </Alert>
    </div>
  )

  const connectButton = (variant: "brand" | "outline") => (
    <Button variant={variant} asChild>
      <Link href={TIKTOK_SOCIAL_NEW}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" aria-hidden />
        {t.connectButton}
      </Link>
    </Button>
  )

  return (
    <>
      {banner}
      {accounts.length === 0 ? (
        <EmptyState icon={Add01Icon} title={t.empty} description={t.emptyHint} action={connectButton(ctaVariant)} />
      ) : (
        <DataTable
          ariaLabel={t.pageTitle}
          columns={columns}
          data={accounts}
          getRowId={(r) => r.id}
          defaultSorting={[{ id: "name", desc: false }]}
          pageSize={20}
          empty={<EmptyState title={t.empty} />}
          renderMobileCard={(r) => (
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <PlatformIcon platform="tiktok" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{r.name}</span>
                      <span className="truncate text-xs font-normal text-muted-foreground">@{r.username}</span>
                    </span>
                  </span>
                  <StatusBadge a={r} />
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                  <span>{typeLabel(r)}</span>
                  <span className="tabular-nums">
                    {t.columns.expires}: {dayMonthYear(r.refreshExpiresAt)}
                  </span>
                  {isAdmin && r.ownerEmail && <span className="max-w-full truncate">{r.ownerEmail}</span>}
                </div>
                {r.statusMessage && <p className="line-clamp-2 text-[13px] break-words text-destructive">{r.statusMessage}</p>}
              </div>
              <RowMenu a={r} busy={busyId === r.id} onAction={(x, y) => void onAction(x, y)} />
            </div>
          )}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={t.deleteConfirm.title}
        description={t.deleteConfirm.body}
        confirmText={deleting?.name}
        confirmLabel={t.delete}
        onConfirm={async () => {
          if (!deleting) return false
          const res = await deleteTiktokSocialAction({ id: deleting.id, confirmName: deleting.name })
          if (!res.ok) {
            toast.error(res.error)
            return false
          }
          toast.success(res.message ?? t.server.deleted)
          setDeleting(null)
          router.refresh()
        }}
      />
    </>
  )
}
