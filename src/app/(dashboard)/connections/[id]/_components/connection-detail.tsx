"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Alert02Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Edit02Icon,
  Key01Icon,
  Refresh01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  ConfirmDialog,
  createDataTableColumnHelper,
  DataTable,
  PageGuide,
  PageHeader,
  PlatformBadge,
  RelativeTime,
  StatusBadge,
} from "@/components/app"
import { StatusHint } from "@/components/mcp/status-hint"
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
import { formatDate, formatDateTime } from "@/lib/format"
import { connections as m } from "@/lib/i18n/vi/connections"
import { guides as tg } from "@/lib/i18n/vi/guides"
import {
  visibleStatusHint,
  type AdAccountDto,
  type ConnectionDetail,
  type PlatformFormSpec,
} from "@/lib/schemas/connections"
import {
  deleteConnectionAction,
  dismissActionRequiredAction,
  syncConnectionAccountsAction,
  testConnectionAction,
  toggleAdAccountsAction,
} from "@/server/actions/connections"

import { WarningsAlert } from "../../_components/token-summary"
import { PagesCard } from "./pages-card"
import { RenameDialog } from "./rename-dialog"
import { ReplaceCredentialsDialog } from "./replace-credentials-dialog"

type Busy = null | "test" | "sync"

export function ConnectionDetailView({
  detail,
  spec,
  twoFactorEnabled,
}: {
  detail: ConnectionDetail
  spec: PlatformFormSpec
  /** current user's 2FA state (re-auth before replacing credentials) */
  twoFactorEnabled: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<Busy>(null)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [replaceOpen, setReplaceOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const run = async (kind: Exclude<Busy, null>) => {
    setBusy(kind)
    const action =
      kind === "test" ? testConnectionAction : syncConnectionAccountsAction
    const res = await action({ connectionId: detail.id })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    const { statusMessage, statusHint, status } = res.data
    const next = visibleStatusHint(statusMessage, statusHint) ?? undefined
    if (status === "invalid")
      toast.error(statusMessage ?? m.errors.tokenInvalid, { description: next })
    else if (status === "active" && statusMessage)
      // the check itself failed for a transient reason: do not report it as a success
      toast.warning(statusMessage, { description: next })
    else if (kind === "sync")
      toast.success(m.detail.synced(res.data.accountCount ?? 0))
    else toast.success(res.message ?? m.detail.rechecked)
    router.refresh()
  }

  const needsNewToken =
    detail.status === "invalid" || detail.status === "expiring"
  const primary = needsNewToken ? (
    <Button variant="brand" onClick={() => setReplaceOpen(true)}>
      <HugeiconsIcon
        icon={Key01Icon}
        strokeWidth={2}
        data-icon="inline-start"
        aria-hidden
      />
      {m.detail.replace}
    </Button>
  ) : (
    <Button
      variant="brand"
      onClick={() => void run("test")}
      disabled={busy !== null}
    >
      {busy === "test" ? (
        <Spinner aria-hidden />
      ) : (
        <HugeiconsIcon
          icon={Refresh01Icon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
      )}
      {m.detail.recheck}
    </Button>
  )

  return (
    <>
      <PageGuide guide={tg.connectionDetail} />
      <PageHeader
        title={detail.name}
        titleMeta={
          <>
            <PlatformBadge platform={detail.platform} />
            <StatusBadge kind="connection" status={detail.status} />
            {detail.actionRequired && (
              <StatusBadge
                kind="connection"
                status="expiring"
                label={m.actionRequired.badge}
              />
            )}
          </>
        }
        backHref="/connections"
        primaryAction={primary}
        secondaryActions={[
          ...(needsNewToken
            ? [
                {
                  label: m.detail.recheck,
                  icon: Refresh01Icon,
                  onSelect: () => void run("test"),
                  disabled: busy !== null,
                },
              ]
            : [
                {
                  label: m.detail.replace,
                  icon: Key01Icon,
                  onSelect: () => setReplaceOpen(true),
                },
              ]),
          {
            label: m.detail.sync,
            icon: RefreshIcon,
            onSelect: () => void run("sync"),
            disabled: busy !== null,
          },
          {
            label: m.detail.rename,
            icon: Edit02Icon,
            onSelect: () => setRenameOpen(true),
          },
          {
            label: m.detail.delete,
            icon: Delete02Icon,
            destructive: true,
            onSelect: () => setDeleteOpen(true),
          },
        ]}
      />

      <div className="flex flex-col gap-5">
        {(detail.statusMessage || detail.statusHint) && (
          <Alert
            variant={detail.status === "invalid" ? "destructive" : "default"}
          >
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertTitle>{m.detail.statusAlert[detail.status]}</AlertTitle>
            <AlertDescription>
              {detail.statusMessage}
              {/* what to do next, right under what happened (skipped when the message already says it) */}
              <StatusHint
                message={detail.statusMessage}
                hint={detail.statusHint}
                className={detail.statusMessage ? "mt-1.5" : undefined}
              />
            </AlertDescription>
          </Alert>
        )}

        {detail.actionRequired && <ActionRequiredAlert detail={detail} />}

        <div className="grid items-start gap-5 xl:grid-cols-3">
          <AccountsCard
            key={`${detail.updatedAt}-${detail.accounts.length}`}
            detail={detail}
            busy={busy}
            onSync={() => void run("sync")}
          />
          <div className="flex flex-col gap-5">
            <OverviewCard detail={detail} />
            <UsageCard detail={detail} />
          </div>
        </div>

        {detail.platform === "meta" && (
          <PagesCard
            key={`${detail.updatedAt}-${detail.pages.length}`}
            detail={detail}
            busy={busy !== null}
            onSync={() => void run("sync")}
          />
        )}
      </div>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        connectionId={detail.id}
        currentName={detail.name}
      />
      <ReplaceCredentialsDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        connectionId={detail.id}
        twoFactorEnabled={twoFactorEnabled}
        spec={spec}
        credentialHint={detail.credentialHint}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        destructive
        title={m.remove.title}
        description={m.remove.description(detail.name)}
        confirmText={detail.name}
        confirmLabel={m.remove.confirm}
        onConfirm={async () => {
          const res = await deleteConnectionAction({ connectionId: detail.id })
          if (!res.ok) {
            toast.error(res.error)
            return false
          }
          toast.success(res.message ?? m.remove.done)
          router.push("/connections")
        }}
      >
        {detail.usedBy.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl border p-3 text-sm">
            <span className="font-medium">{m.remove.affected}</span>
            <UsageList detail={detail} />
          </div>
        )}
      </ConfirmDialog>
    </>
  )
}

// ---------------------------------------------------------------------------

function InfoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function OverviewCard({ detail }: { detail: ConnectionDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.detail.overview}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-3">
          <InfoRow label={m.detail.status}>
            <StatusBadge kind="connection" status={detail.status} />
          </InfoRow>
          <InfoRow label={m.detail.credential}>
            <span className="font-mono text-[13px]">
              ••••{detail.credentialHint.replace(/^…/, "")}
            </span>
          </InfoRow>
          <InfoRow label={m.detail.expires}>
            <span className="tabular-nums">
              {detail.tokenExpiresAt
                ? formatDateTime(detail.tokenExpiresAt)
                : m.list.noExpiry}
            </span>
          </InfoRow>
          <InfoRow label={m.detail.scopes}>
            {detail.scopes && detail.scopes.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {detail.scopes.map((s) => (
                  <Badge
                    key={s}
                    variant="outline"
                    className="rounded-full font-mono text-xs"
                  >
                    {s}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">{m.detail.noScopes}</span>
            )}
          </InfoRow>
          <InfoRow label={m.detail.owner}>
            <span className="break-all">
              {detail.owner.name || detail.owner.email}
            </span>
            {detail.owner.name && (
              <span className="block text-[13px] text-muted-foreground">
                {detail.owner.email}
              </span>
            )}
          </InfoRow>
          <InfoRow label={m.detail.lastChecked}>
            <RelativeTime value={detail.lastCheckedAt} />
          </InfoRow>
          <InfoRow label={m.detail.createdAt}>
            <span className="tabular-nums">{formatDate(detail.createdAt)}</span>
          </InfoRow>
        </dl>
        {detail.warnings.length > 0 && (
          <WarningsAlert title={m.detail.warnings} warnings={detail.warnings} />
        )}
      </CardContent>
    </Card>
  )
}

/** D6 "Cần xác thực": what Meta asked, which ad accounts, how to fix it + "Bỏ cảnh báo" (owner / admin). */
function ActionRequiredAlert({ detail }: { detail: ConnectionDetail }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const flag = detail.actionRequired
  if (!flag) return null
  const names = new Map(detail.accounts.map((a) => [a.externalId, a.name]))

  const dismiss = async () => {
    setPending(true)
    const res = await dismissActionRequiredAction({ connectionId: detail.id })
    setPending(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(res.message ?? m.actionRequired.dismissed)
    router.refresh()
  }

  return (
    <Alert className="border-warning/40">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertTitle>{m.actionRequired.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>{m.actionRequired.body}</p>
        {flag.message && (
          <p className="border-l-2 pl-3 break-words">
            <span className="font-medium text-foreground">
              {m.actionRequired.platformMessage}:
            </span>{" "}
            {flag.message}
          </p>
        )}
        {flag.accounts.length > 0 && (
          <div>
            <span className="font-medium text-foreground">
              {m.actionRequired.accounts}
            </span>
            <ul className="mt-1 ml-4 list-disc space-y-0.5">
              {flag.accounts.map((id) => (
                <li key={id} className="break-words">
                  {names.get(id) ?? id}{" "}
                  <span className="font-mono text-xs">({id})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="tabular-nums">
          {m.actionRequired.since(formatDateTime(flag.since))}
          {flag.lastAt !== flag.since &&
            ` · ${m.actionRequired.lastAt(formatDateTime(flag.lastAt))}`}
        </p>
        <p>{m.actionRequired.howTo}</p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void dismiss()}
            disabled={pending}
          >
            {pending && <Spinner aria-hidden />}
            {m.actionRequired.dismiss}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

function UsageList({ detail }: { detail: ConnectionDetail }) {
  const visible = detail.usedBy.filter((u) => u.name !== null)
  const hidden = detail.usedBy.length - visible.length
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {visible.map((u) => (
        <li key={u.id}>
          <Link
            href={`/mcp-servers/${u.id}`}
            className="flex min-h-9 items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-muted"
          >
            <span className="min-w-0 break-words">{u.name}</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </Link>
        </li>
      ))}
      {hidden > 0 && (
        <li className="px-2 text-muted-foreground">
          {m.detail.usedByOther(hidden)}
        </li>
      )}
    </ul>
  )
}

function UsageCard({ detail }: { detail: ConnectionDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.detail.usedBy}</CardTitle>
      </CardHeader>
      <CardContent>
        {detail.usedBy.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.detail.usedByNone}</p>
        ) : (
          <UsageList detail={detail} />
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

const col = createDataTableColumnHelper<AdAccountDto>()

function AccountsCard({
  detail,
  busy,
  onSync,
}: {
  detail: ConnectionDetail
  busy: Busy
  onSync: () => void
}) {
  // remounted (key) when the server data changes, so local optimistic state starts fresh
  const [accounts, setAccounts] = React.useState(detail.accounts)
  const [pending, setPending] = React.useState<Set<string>>(new Set())

  const toggle = React.useCallback(
    async (a: AdAccountDto, enabled: boolean) => {
      setPending((p) => new Set(p).add(a.id))
      setAccounts((list) =>
        list.map((x) => (x.id === a.id ? { ...x, isEnabled: enabled } : x))
      )
      const res = await toggleAdAccountsAction({
        connectionId: detail.id,
        changes: [{ adAccountId: a.id, enabled }],
      })
      setPending((p) => {
        const n = new Set(p)
        n.delete(a.id)
        return n
      })
      if (!res.ok) {
        setAccounts((list) =>
          list.map((x) => (x.id === a.id ? { ...x, isEnabled: !enabled } : x))
        )
        toast.error(res.error)
        return
      }
      toast.success(m.detail.accountToggled(enabled))
    },
    [detail.id]
  )

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor("isEnabled", {
          header: () => <span className="sr-only">{m.detail.colEnabled}</span>,
          enableSorting: false,
          meta: { className: "w-14", label: m.detail.colEnabled },
          cell: ({ row }) => (
            <Switch
              checked={row.original.isEnabled}
              disabled={pending.has(row.original.id)}
              aria-label={m.detail.toggleAccount(row.original.name)}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(on) => void toggle(row.original, on)}
            />
          ),
        }),
        col.accessor("name", {
          header: m.detail.colAccount,
          // w-full + max-w-0: take the leftover width and truncate long names instead of widening the table
          meta: { className: "w-full min-w-44 max-w-0" },
          cell: ({ row }) => (
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium">
                <span className="truncate" title={row.original.name}>
                  {row.original.name}
                </span>
                {row.original.isManager && (
                  <Badge
                    variant="outline"
                    className="shrink-0 rounded-full text-[11px]"
                  >
                    {m.detail.managerBadge}
                  </Badge>
                )}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {row.original.externalId}
              </span>
            </div>
          ),
        }),
        col.accessor("currency", {
          header: m.detail.colCurrency,
          meta: { className: "font-mono text-xs" },
        }),
        col.accessor("timezone", {
          header: m.detail.colTimezone,
          meta: {
            className: "hidden text-muted-foreground @2xl:table-cell",
            headerClassName: "hidden @2xl:table-cell",
          },
        }),
        col.accessor("status", {
          header: m.detail.colStatus,
          cell: ({ getValue }) => (
            <StatusBadge kind="account" status={getValue()} />
          ),
        }),
      ]),
    [pending, toggle]
  )

  return (
    <Card className="@container gap-0 pb-0 xl:col-span-2">
      <CardHeader className="border-b pb-4">
        <CardTitle>{m.detail.accountsTitle}</CardTitle>
        <CardDescription>
          {m.detail.accountsDescription}{" "}
          <span className="tabular-nums">
            (
            {m.list.accountsOf(
              accounts.filter((a) => a.isEnabled).length,
              accounts.length
            )}
            )
          </span>
        </CardDescription>
      </CardHeader>
      {accounts.length === 0 ? (
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <p className="text-sm text-muted-foreground">{m.detail.noAccounts}</p>
          <Button variant="outline" onClick={onSync} disabled={busy !== null}>
            {busy === "sync" ? (
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
        <DataTable
          ariaLabel={m.detail.accountsTable}
          columns={columns}
          data={accounts}
          getRowId={(r) => r.id}
          defaultSorting={[{ id: "name", desc: false }]}
          pageSize={20}
          renderMobileCard={(r) => (
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="line-clamp-2 font-medium break-words">
                  {r.name}
                </span>
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {r.externalId} · {r.currency}
                </span>
                <StatusBadge
                  kind="account"
                  status={r.status}
                  className="w-fit"
                />
              </div>
              <Switch
                checked={r.isEnabled}
                disabled={pending.has(r.id)}
                aria-label={m.detail.toggleAccount(r.name)}
                onCheckedChange={(on) => void toggle(r, on)}
              />
            </div>
          )}
        />
      )}
    </Card>
  )
}
