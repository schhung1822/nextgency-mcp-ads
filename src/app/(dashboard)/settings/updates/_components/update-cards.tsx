import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowTurnBackwardIcon,
  CheckmarkCircle02Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { EmptyState, RelativeTime, StatusBadge } from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { formatDateTime } from "@/lib/format"
import { updates as t } from "@/lib/i18n/vi/updates"
import type { LatestRelease, UpdateRequestStatus, UpdateRequestView, UpdateStatus } from "@/lib/update-types"
import { displayVersion } from "@/lib/version"

import type { LinkState } from "./use-update-status"
import { isFinished, stepRows, type StepState } from "./update-steps"

/** Update request status -> StatusBadge (kind + status chosen for the tone, label from updates.history.status). */
export function RequestStatusBadge({ status }: { status: UpdateRequestStatus }) {
  const label = t.history.status[status]
  switch (status) {
    case "succeeded":
      return <StatusBadge kind="connection" status="active" label={label} />
    case "failed":
      return <StatusBadge kind="connection" status="invalid" label={label} />
    case "rolled_back":
      return <StatusBadge kind="connection" status="expiring" label={label} />
    default:
      return <StatusBadge kind="log" status="pending_confirmation" label={label} />
  }
}

// ---------------------------------------------------------------------------

export function VersionCard({ status, checking = false }: { status: UpdateStatus; checking?: boolean }) {
  const { latest, current } = status
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.versionCard.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t.versionCard.running}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{displayVersion(current)}</code>
            {status.currentIsRelease && latest && !status.hasUpdate && (
              <StatusBadge kind="connection" status="active" label={t.versionCard.badgeUpToDate} />
            )}
          </dd>
          <dt className="text-muted-foreground">{t.versionCard.latest}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {latest ? (
              <>
                <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{displayVersion(latest.version)}</code>
                {status.hasUpdate && <Badge variant="secondary">{t.versionCard.badgeNew}</Badge>}
                {latest.publishedAt && (
                  <span className="text-[13px] text-muted-foreground">
                    {t.versionCard.published}: {formatDateTime(latest.publishedAt)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{t.versionCard.neverChecked}</span>
            )}
          </dd>
          {latest && (
            <>
              <dt className="text-muted-foreground">{t.versionCard.lastChecked}</dt>
              <dd>
                <RelativeTime value={latest.checkedAt} />
              </dd>
            </>
          )}
        </dl>

        <p
          aria-live="polite"
          className={cn("flex items-center gap-2 text-[13px] text-muted-foreground", !checking && "sr-only")}
          data-slot="update-checking"
        >
          {checking && (
            <>
              <Spinner className="size-3.5" aria-hidden />
              {t.versionCard.checking}
            </>
          )}
        </p>

        {!status.currentIsRelease && (
          <Alert className="border-info/40 bg-info/10">
            <AlertDescription className="text-info-strong">{t.versionCard.devBuild}</AlertDescription>
          </Alert>
        )}
        {status.checkError && (
          <Alert variant="destructive">
            <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden />
            <AlertTitle>
              {t.versionCard.checkFailed} ({t.versionCard.checkFailedAt(formatDateTime(status.checkError.at))})
            </AlertTitle>
            <AlertDescription>{status.checkError.message}</AlertDescription>
          </Alert>
        )}
        {status.currentIsRelease && !latest && !status.checkError && (
          <p className="text-[13px] text-muted-foreground">{t.versionCard.noLatest}</p>
        )}
        {status.hasUpdate && status.blockReason && status.blockReason !== "no_update" && (
          <p className="text-[13px] text-muted-foreground" data-slot="update-block-reason">
            {t.block[status.blockReason]}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

/** Release notes are plain text from GitHub: rendered as an escaped text node (whitespace preserved), never as HTML. */
export function ReleaseNotesCard({ latest }: { latest: LatestRelease }) {
  const safeUrl = latest.url.startsWith("https://github.com/") ? latest.url : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.notes.title(displayVersion(latest.version))}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {latest.notes ? (
          <pre
            tabIndex={0}
            aria-label={t.notes.title(displayVersion(latest.version))}
            className="max-h-80 overflow-y-auto rounded-xl bg-muted/50 p-3 font-sans text-sm leading-6 break-words whitespace-pre-wrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {latest.notes}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">{t.notes.empty}</p>
        )}
        {safeUrl && (
          <div>
            <Button variant="outline" size="sm" asChild>
              <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                {t.notes.viewOnGithub}
                <span className="sr-only"> {t.notes.newTab}</span>
                <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} data-icon="inline-end" aria-hidden />
              </a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function StepIcon({ state }: { state: StepState }) {
  if (state === "current") return <Spinner className="size-5 text-brand-ink" aria-hidden />
  if (state === "done")
    return <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-5 text-success-strong" aria-hidden />
  if (state === "failed")
    return <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="size-5 text-destructive" aria-hidden />
  return <span aria-hidden className="size-5 rounded-full border-2 border-muted-foreground/30" />
}

export function ProgressCard({
  req,
  link,
  onReload,
}: {
  req: UpdateRequestView
  link: LinkState
  onReload: () => void
}) {
  const rows = stepRows(req)
  const finished = isFinished(req.status)
  return (
    <Card data-slot="update-progress">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t.progress.title}
          <RequestStatusBadge status={req.status} />
        </CardTitle>
        <CardDescription>
          {t.progress.description(displayVersion(req.fromVersion), displayVersion(req.targetVersion))}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* announced politely: screen readers hear the step changes */}
        <div aria-live="polite" className="flex flex-col gap-4">
          {req.status === "pending" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden />
              {t.progress.pending}
            </p>
          )}
          <ol className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <li
                key={r.step}
                aria-current={r.state === "current" ? "step" : undefined}
                className={cn(
                  "flex items-center gap-3 text-sm",
                  r.state === "todo" && "text-muted-foreground",
                  r.state === "current" && "font-medium",
                  r.state === "failed" && "font-medium text-destructive"
                )}
              >
                <StepIcon state={r.state} />
                <span className="flex-1">{t.progress.steps[r.step]}</span>
                <span className="text-xs text-muted-foreground">{t.progress.stepState[r.state]}</span>
              </li>
            ))}
          </ol>
        </div>

        {link === "reconnecting" && !finished && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner aria-hidden />
            {t.progress.restarting}
          </p>
        )}
        {link === "session_ended" && (
          <Alert className="border-warning/40 bg-warning/10">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertDescription className="flex flex-wrap items-center gap-3 text-warning-strong">
              {t.progress.sessionEnded}
              <Button variant="outline" size="sm" onClick={onReload}>
                {t.progress.reload}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {req.status === "succeeded" && (
          <Alert className="border-success/40 bg-success/10">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} aria-hidden />
            <AlertDescription className="text-success-strong">{t.progress.succeeded(displayVersion(req.targetVersion))}</AlertDescription>
          </Alert>
        )}
        {req.status === "failed" && (
          <Alert variant="destructive">
            <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden />
            <AlertTitle>{t.progress.failed}</AlertTitle>
            <AlertDescription>{req.message ?? t.progress.noMessage}</AlertDescription>
          </Alert>
        )}
        {req.status === "rolled_back" && (
          <Alert className="border-warning/40 bg-warning/10">
            <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={2} aria-hidden />
            <AlertTitle className="text-warning-strong">{t.progress.rolledBack}</AlertTitle>
            <AlertDescription className="text-warning-strong">{req.message ?? t.progress.noMessage}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

export function HistoryCard({ history }: { history: UpdateRequestView[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.history.title}</CardTitle>
        <CardDescription>{t.history.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <EmptyState title={t.history.empty} description={t.history.emptyHint} bordered className="py-8" />
        ) : (
          <ul className="flex flex-col divide-y">
            {history.map((h) => (
              <li key={h.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm">
                    {displayVersion(h.fromVersion)} → {displayVersion(h.targetVersion)}
                  </span>
                  <RequestStatusBadge status={h.status} />
                </div>
                <p className="text-[13px] text-muted-foreground">
                  <RelativeTime value={h.finishedAt ?? h.createdAt} />
                  {h.requestedBy ? ` · ${t.history.by(h.requestedBy)}` : ""}
                </p>
                {h.message && <p className="text-[13px] break-words text-muted-foreground">{h.message}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

export function UpdaterCard({ updater }: { updater: UpdateStatus["updater"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t.updater.title}
          <StatusBadge
            kind="connection"
            status={updater.online ? "active" : "disabled"}
            label={updater.online ? t.updater.online : t.updater.offline}
          />
        </CardTitle>
        <CardDescription>{updater.online ? t.updater.onlineHint : t.updater.offlineHint}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {updater.online ? (
          <p className="text-[13px] text-muted-foreground">
            {updater.version ? `${t.updater.onlineVersion(updater.version)} · ` : ""}
            {t.updater.lastSeen}: <RelativeTime value={updater.lastSeenAt} refreshMs={15_000} />
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">{t.updater.manualTitle}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                {t.updater.manualSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <pre
                tabIndex={0}
                className="rounded-xl bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t.updater.manualCommand}
              </pre>
            </div>
            <div className="flex flex-col gap-2 border-t pt-4">
              <h3 className="font-medium">{t.updater.enableTitle}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                {t.updater.enableSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          </>
        )}
        <p className="text-xs text-muted-foreground">{t.updater.note}</p>
      </CardContent>
    </Card>
  )
}
