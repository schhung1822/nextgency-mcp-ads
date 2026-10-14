"use client"

// /connections/apify/[id]: alerts (status / read-only) · credit (2/3) + info and MCP usage (1/3) · recent runs.
// Managers (admin: every token; staff: own personal tokens) get Kiểm tra lại / Đổi tên / Thay token / Tắt-Bật / Xoá;
// staff looking at a company token get a read-only page. Never shows the token itself (4-char hint only).
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
  LockKeyIcon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  BrandIcon,
  ConfirmDialog,
  createDataTableColumnHelper,
  DataTable,
  PageGuide,
  PageHeader,
  RelativeTime,
  STATUS_TONE_CLASSES,
  type PageHeaderAction,
  type StatusTone,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { formatDate, formatDateTime } from "@/lib/format"
import { apify as a } from "@/lib/i18n/vi/apify"
import { guides as tg } from "@/lib/i18n/vi/guides"
import type { ApifyTokenDetail } from "@/lib/schemas/apify"
import {
  deleteApifyTokenAction,
  recheckApifyTokenAction,
  setApifyTokenEnabledAction,
} from "@/server/actions/apify"

import {
  ApifyScopeBadge,
  ApifyStatusBadge,
} from "../../_components/apify-badges"
import {
  creditPercent,
  creditRemaining,
  exhaustedUntilLabel,
  formatUsd,
  planLabel,
  tierLabel,
} from "../../_components/apify-format"
import { RenameApifyTokenDialog } from "./rename-dialog"
import { ReplaceApifyTokenDialog } from "./replace-token-dialog"

const m = a.detail

type Busy = null | "recheck" | "toggle"
type Run = ApifyTokenDetail["recentRuns"][number]

export function ApifyTokenDetailView({
  detail,
  twoFactorEnabled,
}: {
  detail: ApifyTokenDetail
  twoFactorEnabled: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<Busy>(null)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [replaceOpen, setReplaceOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [refreshing, startRefresh] = React.useTransition()
  const disabled = detail.status === "disabled"
  const manage = detail.canManage

  const recheck = async () => {
    setBusy("recheck")
    const res = await recheckApifyTokenAction({ id: detail.id })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.status === "invalid" || res.data.status === "error")
      toast.error(m.recheckFailed, {
        description: res.data.statusMessage ?? undefined,
      })
    else toast.success(res.message ?? a.server.rechecked)
    router.refresh()
  }

  const toggle = async (enabled: boolean) => {
    setBusy("toggle")
    const res = await setApifyTokenEnabledAction({ id: detail.id, enabled })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(
      res.message ?? (enabled ? a.server.enabled : a.server.disabled)
    )
    router.refresh()
  }

  // one brand action: a disabled token is turned back on, otherwise re-checked against Apify (credit, status)
  const primary = !manage ? undefined : disabled ? (
    <Button
      variant="brand"
      onClick={() => void toggle(true)}
      disabled={busy !== null}
    >
      {busy === "toggle" ? (
        <Spinner aria-hidden />
      ) : (
        <HugeiconsIcon
          icon={PlayIcon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
      )}
      {m.enable}
    </Button>
  ) : (
    <Button
      variant="brand"
      onClick={() => void recheck()}
      disabled={busy !== null}
    >
      {busy === "recheck" ? (
        <Spinner aria-hidden />
      ) : (
        <HugeiconsIcon
          icon={Refresh01Icon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
      )}
      {busy === "recheck" ? m.rechecking : m.recheck}
    </Button>
  )

  const secondary: PageHeaderAction[] = !manage
    ? []
    : [
        ...(disabled
          ? [
              {
                label: m.recheck,
                icon: Refresh01Icon,
                onSelect: () => void recheck(),
                disabled: busy !== null,
              },
            ]
          : []),
        {
          label: m.rename,
          icon: Edit02Icon,
          onSelect: () => setRenameOpen(true),
        },
        {
          label: m.replaceToken,
          icon: Key01Icon,
          onSelect: () => setReplaceOpen(true),
        },
        ...(disabled
          ? []
          : [
              {
                label: m.disable,
                icon: PauseIcon,
                onSelect: () => void toggle(false),
                disabled: busy !== null,
              },
            ]),
        {
          label: m.delete,
          icon: Delete02Icon,
          destructive: true,
          onSelect: () => setDeleteOpen(true),
        },
      ]

  return (
    <>
      <PageGuide guide={tg.apifyDetail} />
      <PageHeader
        title={detail.name}
        titleMeta={
          <>
            <Badge variant="outline" className="rounded-full">
              <BrandIcon brand="apify" className="size-3.5" />
              {a.ui.brand}
            </Badge>
            <ApifyScopeBadge scope={detail.scope} />
            <ApifyStatusBadge token={detail} />
          </>
        }
        backHref="/connections?tab=apify"
        primaryAction={primary}
        secondaryActions={secondary}
      />

      <div className="flex flex-col gap-5">
        <StatusAlerts detail={detail} />
        <div className="grid items-start gap-5 xl:grid-cols-3">
          <CreditCard detail={detail} className="xl:col-span-2" />
          <div className="flex flex-col gap-5">
            <InfoCard detail={detail} />
            <UsageCard detail={detail} />
          </div>
        </div>
      </div>

      <RunsCard
        runs={detail.recentRuns}
        refreshing={refreshing}
        onRefresh={() => startRefresh(() => router.refresh())}
      />

      {manage && (
        <>
          <RenameApifyTokenDialog
            open={renameOpen}
            onOpenChange={setRenameOpen}
            tokenId={detail.id}
            currentName={detail.name}
            onRenamed={() => router.refresh()}
          />
          <ReplaceApifyTokenDialog
            open={replaceOpen}
            onOpenChange={setReplaceOpen}
            tokenId={detail.id}
            credentialHint={detail.credentialHint}
            twoFactorEnabled={twoFactorEnabled}
            onReplaced={() => router.refresh()}
          />
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            destructive
            title={a.remove.title}
            description={a.remove.description(detail.name)}
            confirmText={detail.name}
            confirmLabel={a.remove.confirm}
            onConfirm={async () => {
              const res = await deleteApifyTokenAction({
                id: detail.id,
                confirmName: detail.name,
              })
              if (!res.ok) {
                toast.error(res.error)
                return false
              }
              toast.success(res.message ?? a.server.deleted)
              router.push("/connections?tab=apify")
            }}
          >
            {detail.mcpUsage.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-xl border p-3 text-sm">
                <span className="font-medium">{a.remove.affected}</span>
                <UsageList detail={detail} />
              </div>
            )}
            <p className="text-[13px] text-pretty text-muted-foreground">
              {a.remove.revokeTip}
            </p>
          </ConfirmDialog>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

function StatusAlerts({ detail }: { detail: ApifyTokenDetail }) {
  const until = exhaustedUntilLabel(detail)
  return (
    <>
      {!detail.canManage && (
        <Alert>
          <HugeiconsIcon icon={LockKeyIcon} strokeWidth={2} aria-hidden />
          <AlertTitle>{m.readOnlyTitle}</AlertTitle>
          <AlertDescription>{m.readOnlyHint}</AlertDescription>
        </Alert>
      )}
      {(detail.status === "invalid" || detail.status === "error") && (
        <Alert variant="destructive">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertTitle>{m.statusAlert[detail.status]}</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            {/* the stored message already says how to fix it; the generic hint only fills in when it is missing */}
            {detail.statusMessage ? (
              <span>{detail.statusMessage}</span>
            ) : (
              detail.canManage && (
                <span>
                  {detail.status === "invalid" ? m.invalidHint : m.errorHint}
                </span>
              )
            )}
          </AlertDescription>
        </Alert>
      )}
      {detail.status === "exhausted" && (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertTitle>{m.statusAlert.exhausted}</AlertTitle>
          <AlertDescription>
            {m.exhaustedHint(
              until && detail.exhaustedUntil
                ? formatDate(detail.exhaustedUntil)
                : null
            )}
          </AlertDescription>
        </Alert>
      )}
      {detail.status === "disabled" && (
        <Alert>
          <HugeiconsIcon icon={PauseIcon} strokeWidth={2} aria-hidden />
          <AlertTitle>{m.statusAlert.disabled}</AlertTitle>
          <AlertDescription>{m.disabledHint}</AlertDescription>
        </Alert>
      )}
    </>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-xl leading-7 font-semibold tabular-nums",
          className
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function CreditCard({
  detail,
  className,
}: {
  detail: ApifyTokenDetail
  className?: string
}) {
  const known = detail.usageUsd !== null || detail.limitUsd !== null
  const remaining = creditRemaining(detail)
  const percent = creditPercent(detail)
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{m.creditTitle}</CardTitle>
        <CardDescription>{m.creditDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!known ? (
          <p className="text-sm text-muted-foreground">{m.creditUnknown}</p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Stat label={m.used} value={formatUsd(detail.usageUsd)} />
              <Stat label={m.limit} value={formatUsd(detail.limitUsd)} />
              <Stat
                label={m.remaining}
                value={formatUsd(remaining)}
                className={
                  remaining !== null && remaining <= 0
                    ? "text-warning-strong"
                    : undefined
                }
              />
            </dl>
            {percent !== null && (
              <div className="flex flex-col gap-1.5">
                {/* the text below carries the value (the shared Progress does not expose aria-valuenow) */}
                <Progress value={percent} className="h-2" aria-hidden />
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  {m.usagePercent(percent)}
                </span>
              </div>
            )}
          </>
        )}
        <dl className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:gap-8">
          <InfoRow label={m.resetAt}>
            {detail.cycleEndAt ? (
              <span className="tabular-nums">
                {formatDate(detail.cycleEndAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">{a.ui.unknown}</span>
            )}
          </InfoRow>
          <InfoRow label={m.lastChecked}>
            {detail.lastCheckedAt ? (
              <RelativeTime value={detail.lastCheckedAt} />
            ) : (
              <span className="text-muted-foreground">{m.never}</span>
            )}
          </InfoRow>
        </dl>
        <p className="text-[13px] text-pretty text-muted-foreground">
          {m.sharedNote}
        </p>
      </CardContent>
    </Card>
  )
}

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
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

function InfoCard({ detail }: { detail: ApifyTokenDetail }) {
  const plan = planLabel(detail.planId)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.infoTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3">
          <InfoRow label={m.account}>
            <span className="font-medium">
              {detail.apifyUsername ?? a.ui.noUsername}
            </span>
            {plan && (
              <span className="block text-[13px] text-muted-foreground">
                {m.plan}: {plan}
                {detail.planTier && detail.planTier !== detail.planId
                  ? ` · ${tierLabel(detail.planTier)}`
                  : ""}
              </span>
            )}
          </InfoRow>
          {/* the 4-char hint only for people who can replace the token */}
          {detail.canManage && (
            <InfoRow label={m.token}>
              <span className="font-mono text-[13px]">
                {a.ui.tokenHint(detail.credentialHint)}
              </span>
            </InfoRow>
          )}
          <InfoRow label={m.scope}>
            <ApifyScopeBadge scope={detail.scope} />
          </InfoRow>
          {/* staff looking at a company token: name / status / credit only */}
          {detail.canManage && detail.ownerName && (
            <InfoRow label={m.owner}>
              <span className="break-all">{detail.ownerName}</span>
            </InfoRow>
          )}
          <InfoRow label={m.lastUsed}>
            {detail.lastUsedAt ? (
              <RelativeTime value={detail.lastUsedAt} />
            ) : (
              <span className="text-muted-foreground">{m.never}</span>
            )}
          </InfoRow>
          <InfoRow label={m.createdAt}>
            <span className="tabular-nums">{formatDate(detail.createdAt)}</span>
          </InfoRow>
        </dl>
      </CardContent>
    </Card>
  )
}

function UsageList({ detail }: { detail: ApifyTokenDetail }) {
  const visible = detail.mcpUsage.filter(
    (u): u is typeof u & { mcpId: string } => u.mcpId !== null
  )
  const hidden = detail.mcpUsage.length - visible.length
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {visible.map((u) => (
        <li key={u.mcpId}>
          <Link
            href={`/mcp-servers/${u.mcpId}`}
            className="flex min-h-9 items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-muted"
          >
            <span className="flex min-w-0 flex-col">
              <span className="break-words">{u.mcpName}</span>
              {u.ownerName && (
                <span className="text-[13px] break-words text-muted-foreground">
                  {u.ownerName}
                </span>
              )}
            </span>
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
        <li className="px-2 text-muted-foreground">{m.usageOther(hidden)}</li>
      )}
    </ul>
  )
}

function UsageCard({ detail }: { detail: ApifyTokenDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.usageTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {detail.mcpUsage.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.usageNone}</p>
        ) : (
          <UsageList detail={detail} />
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

const RUN_TONE: Record<string, StatusTone> = {
  READY: "info",
  RUNNING: "info",
  SUCCEEDED: "success",
  FAILED: "danger",
  "TIMING-OUT": "warning",
  "TIMED-OUT": "danger",
  ABORTING: "warning",
  ABORTED: "neutral",
}

function RunStatusBadge({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  const tone = RUN_TONE[status] ?? "neutral"
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
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", t.dot)}
      />
      {m.runStatus[status] ?? status}
    </Badge>
  )
}

function RunTask({ run }: { run: Run }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span
        className="truncate font-mono text-[13px]"
        title={run.taskKey ?? undefined}
      >
        {run.taskKey ?? m.storeActor}
      </span>
      <span
        className="truncate font-mono text-xs text-muted-foreground"
        title={run.actorId}
      >
        {run.actorId}
      </span>
    </span>
  )
}

const rcol = createDataTableColumnHelper<Run>()

function RunsCard({
  runs,
  refreshing,
  onRefresh,
}: {
  runs: Run[]
  refreshing: boolean
  onRefresh: () => void
}) {
  const columns = React.useMemo(
    () =>
      rcol.columns([
        rcol.accessor("startedAt", {
          header: m.colTime,
          meta: { className: "whitespace-nowrap tabular-nums" },
          cell: ({ getValue }) => formatDateTime(getValue()),
        }),
        rcol.accessor("mcpName", {
          header: m.colMcp,
          meta: {
            className: "hidden @2xl:table-cell",
            headerClassName: "hidden @2xl:table-cell",
          },
          cell: ({ getValue }) => (
            <span className="block max-w-48 truncate" title={getValue()}>
              {getValue()}
            </span>
          ),
        }),
        rcol.display({
          id: "task",
          header: m.colTask,
          meta: { className: "w-full max-w-0 min-w-48" },
          cell: ({ row }) => <RunTask run={row.original} />,
        }),
        rcol.accessor("status", {
          header: m.colStatus,
          cell: ({ getValue }) => <RunStatusBadge status={getValue()} />,
        }),
        rcol.accessor((r) => r.usageUsd ?? -1, {
          id: "cost",
          header: m.colCost,
          meta: { align: "end", className: "whitespace-nowrap tabular-nums" },
          cell: ({ row }) =>
            row.original.usageUsd === null ? (
              <span className="text-muted-foreground">{m.costPending}</span>
            ) : (
              formatUsd(row.original.usageUsd)
            ),
        }),
      ]),
    []
  )

  return (
    <Card className="@container mt-5 gap-0 pb-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>{m.runsTitle}</CardTitle>
        <CardDescription>{m.runsDescription}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-10"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing || undefined}
          >
            {refreshing ? (
              <Spinner aria-hidden />
            ) : (
              <HugeiconsIcon
                icon={Refresh01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
            )}
            {m.refresh}
          </Button>
        </CardAction>
      </CardHeader>
      {runs.length === 0 ? (
        <CardContent className="py-8 text-sm text-muted-foreground">
          {m.noRuns}
        </CardContent>
      ) : (
        <DataTable
          ariaLabel={m.runsTable}
          columns={columns}
          data={runs}
          getRowId={(r) => r.id}
          pageSize={10}
          renderMobileCard={(r) => (
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <RunTask run={r} />
                <RunStatusBadge status={r.status} className="shrink-0" />
              </div>
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {formatDateTime(r.startedAt)} · {r.mcpName} ·{" "}
                {r.usageUsd === null ? m.costPending : formatUsd(r.usageUsd)}
              </span>
            </div>
          )}
        />
      )}
    </Card>
  )
}
