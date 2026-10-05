"use client"

import * as React from "react"
import {
  Delete02Icon,
  Key01Icon,
  ComputerIcon,
  MoreHorizontalIcon,
  ShieldKeyIcon,
  SquareLock01Icon,
  SquareUnlock01Icon,
  UserCircleIcon,
  UserGroupIcon,
  UserSwitchIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  ConfirmDialog,
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  FilterBar,
  ReauthDialog,
  RelativeTime,
  StatusBadge,
  type FilterValues,
} from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { users as tUsers } from "@/lib/i18n/vi/users"
import { REAUTH_REQUIRED_FIELD } from "@/lib/schemas/reauth"

import { RoleBadge } from "./role-badge"
import { ChangeRoleDialog, DeleteAdminDialog, ResetPasswordDialog, SessionsSheet } from "./row-dialogs"
import type { UserActions, UserRow } from "./types"
import { UserAvatar } from "./user-avatar"

type DialogKind = "role" | "password" | "reset2fa" | "ban" | "unban" | "sessions" | "delete"
type Tab = "all" | "admin" | "staff" | "banned"
/**
 * `fresh`: the acting admin's session was still fresh (signed in / re-authenticated ≤ 10 min ago) when the dialog
 * opened - staff password/2FA resets and revoking an admin's sessions then skip the password prompt. UI hint only:
 * the server decides and answers `fieldErrors._reauth` when it wants the password after all.
 */
type DialogState = { kind: DialogKind; user: UserRow; fresh: boolean }
/** margin so a dialog opened just before the window ends does not submit into an expired one */
const FRESH_MARGIN_MS = 30_000

const col = createDataTableColumnHelper<UserRow>()

function UserStatus({ u }: { u: UserRow }) {
  if (u.banned) return <StatusBadge kind="connection" status="invalid" label={tUsers.status.banned} />
  if (u.mustChangePassword)
    return <StatusBadge kind="connection" status="expiring" label={tUsers.status.mustChangePassword} />
  return <StatusBadge kind="connection" status="active" label={tUsers.status.active} />
}

function TwoFactorBadge({ on }: { on: boolean }) {
  return (
    <StatusBadge
      kind="mcp"
      status={on ? "active" : "disabled"}
      label={on ? tUsers.twoFactorOn : tUsers.twoFactorOff}
    />
  )
}

/** Avatar + name (+ "Bạn") over email; both lines truncate so a very long name/email never widens the table. */
function UserIdentity({ u, self }: { u: UserRow; self: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <UserAvatar name={u.name} email={u.email} admin={u.role === "admin"} className="shrink-0" />
      <div className="min-w-0">
        <p className="flex items-center gap-2 leading-5 font-medium">
          <span className="truncate">{u.name || tUsers.noName}</span>
          {self && (
            <Badge variant="outline" className="shrink-0 rounded-full">
              {tUsers.you}
            </Badge>
          )}
        </p>
        <p className="truncate text-[13px] leading-5 text-muted-foreground">{u.email}</p>
      </div>
    </div>
  )
}

function RowMenu({
  u,
  self,
  onOpen,
}: {
  u: UserRow
  self: boolean
  onOpen: (kind: DialogKind, u: UserRow) => void
}) {
  const open = (kind: DialogKind) => onOpen(kind, u)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-10 md:size-8"
          aria-label={tUsers.rowActions.menu(u.name || u.email)}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {self ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {tUsers.rowActions.selfHint}
            </DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href="/account">
                <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} aria-hidden />
                {tUsers.rowActions.openAccount}
              </Link>
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => open("role")}>
              <HugeiconsIcon icon={UserSwitchIcon} strokeWidth={2} aria-hidden />
              {tUsers.rowActions.changeRole}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open("sessions")}>
              <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} aria-hidden />
              {tUsers.rowActions.sessions}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => open("password")}>
              <HugeiconsIcon icon={Key01Icon} strokeWidth={2} aria-hidden />
              {tUsers.rowActions.resetPassword}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open("reset2fa")} disabled={!u.twoFactorEnabled}>
              <HugeiconsIcon icon={ShieldKeyIcon} strokeWidth={2} aria-hidden />
              {tUsers.rowActions.reset2fa}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {u.banned ? (
              <DropdownMenuItem onSelect={() => open("unban")}>
                <HugeiconsIcon icon={SquareUnlock01Icon} strokeWidth={2} aria-hidden />
                {tUsers.rowActions.unban}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem variant="destructive" onSelect={() => open("ban")}>
                <HugeiconsIcon icon={SquareLock01Icon} strokeWidth={2} aria-hidden />
                {tUsers.rowActions.ban}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => open("delete")}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
              {tUsers.rowActions.delete}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function UsersTable({
  users,
  currentUserId,
  actorTwoFactor,
  reauthFreshUntil,
  actions,
}: {
  users: UserRow[]
  currentUserId: string
  /** acting admin has 2FA → re-auth asks for the TOTP code */
  actorTwoFactor: boolean
  /** epoch ms until which the acting admin's session is fresh (null = not fresh) */
  reauthFreshUntil: number | null
  actions: UserActions
}) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<DialogState | null>(null)
  const [tab, setTab] = React.useState<Tab>("all")
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const refresh = React.useCallback(() => router.refresh(), [router])
  const close = () => setDialog(null)
  const openDialog = React.useCallback(
    (kind: DialogKind, user: UserRow) =>
      setDialog({ kind, user, fresh: reauthFreshUntil !== null && Date.now() < reauthFreshUntil - FRESH_MARGIN_MS }),
    [reauthFreshUntil]
  )

  const counts = React.useMemo(
    () => ({
      all: users.length,
      admin: users.filter((u) => u.role === "admin").length,
      staff: users.filter((u) => u.role === "staff").length,
      banned: users.filter((u) => u.banned).length,
    }),
    [users]
  )

  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const tfa = filters.twoFactor ?? []
    return users.filter((u) => {
      if (tab === "admin" && u.role !== "admin") return false
      if (tab === "staff" && u.role !== "staff") return false
      if (tab === "banned" && !u.banned) return false
      if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false
      if (tfa.length && !tfa.includes(u.twoFactorEnabled ? "on" : "off")) return false
      return true
    })
  }, [users, tab, search, filters])

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor((u) => u.name || u.email, {
          id: "name",
          header: tUsers.columns.user,
          // `max-w-0` + `w-full`: the user column takes the remaining width and truncates instead of stretching the table
          meta: { className: "w-full max-w-0 min-w-52", headerClassName: "w-full" },
          cell: ({ row }) => <UserIdentity u={row.original} self={row.original.id === currentUserId} />,
        }),
        col.accessor("role", {
          header: tUsers.columns.role,
          cell: ({ getValue }) => <RoleBadge role={getValue()} />,
        }),
        col.accessor("twoFactorEnabled", {
          header: tUsers.columns.twoFactor,
          cell: ({ getValue }) => <TwoFactorBadge on={getValue()} />,
        }),
        col.accessor("banned", {
          header: tUsers.columns.status,
          cell: ({ row }) => <UserStatus u={row.original} />,
        }),
        col.accessor("lastLoginAt", {
          header: tUsers.columns.lastLogin,
          sortUndefined: "last",
          meta: { className: "hidden xl:table-cell", headerClassName: "hidden xl:table-cell" },
          cell: ({ getValue }) => {
            const v = getValue()
            return v ? (
              <RelativeTime value={v} className="text-muted-foreground" />
            ) : (
              <span className="text-muted-foreground">{tUsers.neverLoggedIn}</span>
            )
          },
        }),
        col.display({
          id: "actions",
          header: () => <span className="sr-only">{tUsers.columns.actions}</span>,
          enableSorting: false,
          meta: { align: "end", className: "w-12 pl-0", label: tUsers.columns.actions },
          cell: ({ row }) => (
            <RowMenu u={row.original} self={row.original.id === currentUserId} onOpen={openDialog} />
          ),
        }),
      ]),
    [currentUserId, openDialog]
  )

  async function runConfirm(fn: () => Promise<{ ok: boolean; error?: string; message?: string } | null>) {
    const res = await fn().catch(() => null)
    if (!res) {
      toast.error(tUsers.errors.notFound)
      return false
    }
    if (!res.ok) {
      toast.error(res.error)
      return false
    }
    toast.success(res.message)
    refresh()
    return true
  }

  const target = dialog?.user
  const label = target ? target.name || target.email : ""
  const targetIsAdmin = target?.role === "admin"
  // reset password / 2FA: always for an admin target, for staff once the session is no longer fresh
  const resetNeedsReauth = !!dialog && (targetIsAdmin || !dialog.fresh)

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-0">
          <div className="overflow-x-auto border-b px-3 pt-3">
            <TabsList variant="line">
              {(["all", "admin", "staff", "banned"] as const).map((t) => (
                <TabsTrigger key={t} value={t}>
                  {tUsers.tabs[t]}
                  <span className="text-[13px] text-muted-foreground tabular-nums">{counts[t]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        <div className="border-b p-3">
          <FilterBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: tUsers.search.placeholder,
              label: tUsers.search.label,
            }}
            filters={[
              {
                id: "twoFactor",
                label: tUsers.filterTwoFactor,
                options: [
                  { value: "on", label: tUsers.twoFactorOn, count: users.filter((u) => u.twoFactorEnabled).length },
                  { value: "off", label: tUsers.twoFactorOff, count: users.filter((u) => !u.twoFactorEnabled).length },
                ],
              },
            ]}
            values={filters}
            onValuesChange={setFilters}
          />
        </div>
        <DataTable
          ariaLabel={tUsers.tableLabel}
          columns={columns}
          data={data}
          getRowId={(r) => r.id}
          defaultSorting={[{ id: "name", desc: false }]}
          pageSize={25}
          empty={
            users.length === 0 ? (
              <EmptyState icon={UserGroupIcon} title={tUsers.empty.title} description={tUsers.empty.description} />
            ) : (
              <EmptyState
                icon={UserGroupIcon}
                title={tUsers.emptyFiltered.title}
                description={tUsers.emptyFiltered.description}
              />
            )
          }
          renderMobileCard={(u) => {
            const self = u.id === currentUserId
            return (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-2.5">
                  <UserIdentity u={u} self={self} />
                  <div className="flex flex-wrap gap-1.5">
                    <RoleBadge role={u.role} />
                    <TwoFactorBadge on={u.twoFactorEnabled} />
                    <UserStatus u={u} />
                  </div>
                  <p className="text-[13px] text-muted-foreground">
                    {tUsers.columns.lastLogin}:{" "}
                    {u.lastLoginAt ? <RelativeTime value={u.lastLoginAt} /> : tUsers.neverLoggedIn}
                  </p>
                </div>
                <RowMenu u={u} self={self} onOpen={openDialog} />
              </div>
            )
          }}
        />
      </Card>

      {target && dialog?.kind === "role" && (
        <ChangeRoleDialog
          key={target.id}
          user={target}
          open
          onOpenChange={(o) => !o && close()}
          onDone={refresh}
          action={actions.changeRole}
          actorTwoFactor={actorTwoFactor}
        />
      )}
      {target && dialog?.kind === "password" && (
        <ResetPasswordDialog
          key={target.id}
          user={target}
          open
          onOpenChange={(o) => !o && close()}
          onDone={refresh}
          action={actions.resetPassword}
          actorTwoFactor={actorTwoFactor}
          needsReauth={resetNeedsReauth}
        />
      )}
      {target && dialog?.kind === "sessions" && (
        <SessionsSheet
          key={target.id}
          user={target}
          open
          onOpenChange={(o) => !o && close()}
          onDone={refresh}
          list={actions.listSessions}
          revoke={actions.revokeSessions}
          actorTwoFactor={actorTwoFactor}
          needsReauth={targetIsAdmin && !dialog.fresh}
        />
      )}
      {target && dialog?.kind === "reset2fa" && resetNeedsReauth && (
        // another ADMIN's 2FA, or a staff member's once the session is no longer fresh: password (+ TOTP)
        <ReauthDialog
          open
          onOpenChange={(o) => !o && close()}
          destructive
          twoFactorEnabled={actorTwoFactor}
          idPrefix="reset2fa"
          hint={targetIsAdmin ? undefined : tUsers.reauthFreshHint}
          texts={{
            title: tUsers.reset2fa.title(label),
            description: tUsers.reset2fa.description,
            submit: tUsers.reset2fa.confirm,
          }}
          onSubmit={(reauth) => actions.reset2fa({ userId: target.id, reauth })}
          onSuccess={(_, message) => {
            toast.success(message ?? tUsers.toast.twoFactorReset)
            refresh()
          }}
        />
      )}
      {target && dialog?.kind === "reset2fa" && !resetNeedsReauth && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && close()}
          destructive
          title={tUsers.reset2fa.title(label)}
          description={tUsers.reset2fa.description}
          confirmLabel={tUsers.reset2fa.confirm}
          onConfirm={async () => {
            const res = await actions.reset2fa({ userId: target.id }).catch(() => null)
            // the session stopped being fresh meanwhile: switch to the password dialog
            if (res && !res.ok && res.fieldErrors?.[REAUTH_REQUIRED_FIELD]) {
              setDialog({ ...dialog, fresh: false })
              return false
            }
            return runConfirm(async () => res)
          }}
        />
      )}
      {target && (dialog?.kind === "ban" || dialog?.kind === "unban") && targetIsAdmin && (
        // banning / unbanning ANOTHER ADMIN: re-authenticate (password + TOTP)
        <ReauthDialog
          open
          onOpenChange={(o) => !o && close()}
          destructive={dialog.kind === "ban"}
          twoFactorEnabled={actorTwoFactor}
          idPrefix="ban"
          hint={tUsers.adminTargetReauthHint}
          texts={{
            title: dialog.kind === "ban" ? tUsers.ban.title(label) : tUsers.unban.title(label),
            description: dialog.kind === "ban" ? tUsers.ban.description : tUsers.unban.description,
            submit: dialog.kind === "ban" ? tUsers.ban.confirm : tUsers.unban.confirm,
          }}
          onSubmit={(reauth) => actions.setBanned({ userId: target.id, banned: dialog.kind === "ban", reauth })}
          onSuccess={(_, message) => {
            toast.success(message ?? (dialog.kind === "ban" ? tUsers.toast.banned : tUsers.toast.unbanned))
            refresh()
          }}
        />
      )}
      {target && (dialog?.kind === "ban" || dialog?.kind === "unban") && !targetIsAdmin && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && close()}
          destructive={dialog.kind === "ban"}
          title={dialog.kind === "ban" ? tUsers.ban.title(label) : tUsers.unban.title(label)}
          description={dialog.kind === "ban" ? tUsers.ban.description : tUsers.unban.description}
          confirmLabel={dialog.kind === "ban" ? tUsers.ban.confirm : tUsers.unban.confirm}
          onConfirm={() => runConfirm(() => actions.setBanned({ userId: target.id, banned: dialog.kind === "ban" }))}
        />
      )}
      {target && dialog?.kind === "delete" && targetIsAdmin && (
        <DeleteAdminDialog
          key={target.id}
          user={target}
          open
          onOpenChange={(o) => !o && close()}
          onDone={refresh}
          action={actions.remove}
          actorTwoFactor={actorTwoFactor}
        />
      )}
      {target && dialog?.kind === "delete" && !targetIsAdmin && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && close()}
          destructive
          title={tUsers.delete.title(label)}
          description={tUsers.delete.description}
          confirmLabel={tUsers.delete.confirm}
          confirmText={target.email}
          onConfirm={() => runConfirm(() => actions.remove({ userId: target.id }))}
        />
      )}
    </>
  )
}
