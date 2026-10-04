"use client"

import * as React from "react"
import { RefreshIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import { PageGuide, PageHeader, ReauthDialog } from "@/components/app"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { updates as t } from "@/lib/i18n/vi/updates"
import type { UpdateStatus } from "@/lib/update-types"
import { displayVersion } from "@/lib/version"
import { checkUpdatesAction, startUpdateAction } from "@/server/actions/updates"

import { HistoryCard, ProgressCard, ReleaseNotesCard, UpdaterCard, VersionCard } from "./update-cards"
import { useUpdateStatus } from "./use-update-status"

export function UpdatesView({ initial, twoFactorEnabled }: { initial: UpdateStatus; twoFactorEnabled: boolean }) {
  const { status, link, versionChanged, watchedId, setWatchedId, refresh, apply } = useUpdateStatus(initial)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [checking, startCheck] = React.useTransition()

  const latest = status.latest
  // progress of the open request, or of the one this page watched until it finished
  const progress = status.active ?? (watchedId ? (status.history.find((h) => h.id === watchedId) ?? null) : null)
  const watching = !!progress && (!!status.active || progress.id === watchedId)

  // the new build answers (different version) or the watched request reports success: reload to load the new UI
  const done = (watching && progress?.status === "succeeded") || (watching && versionChanged)
  React.useEffect(() => {
    if (!done) return
    const id = setTimeout(() => window.location.reload(), 1500)
    return () => clearTimeout(id)
  }, [done])

  const check = () =>
    startCheck(async () => {
      const r = await checkUpdatesAction()
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      apply(r.data.status)
      if (r.data.error) toast.error(r.data.error)
      else if (r.data.status.hasUpdate && r.data.status.latest)
        toast.success(t.toast.checkedNew(displayVersion(r.data.status.latest.version)))
      else toast.success(t.toast.checkedLatest)
    })

  const canUpdate = status.hasUpdate && !!latest && status.blockReason === null
  const checkButton = (variant: "brand" | "outline") => (
    <Button variant={variant} onClick={check} disabled={checking}>
      {checking ? <Spinner data-icon="inline-start" aria-hidden /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" aria-hidden />}
      {checking ? t.actions.checking : t.actions.check}
    </Button>
  )

  return (
    <>
      <PageGuide guide={tg.updates} />
      <PageHeader
        title={t.title}
        description={t.description}
        backHref="/settings"
        backLabel={t.backToSettings}
        // the one brand button: "Cập nhật lên vX" when there is something to install, else "Kiểm tra ngay"
        primaryAction={
          status.hasUpdate && latest ? (
            <Button
              variant="brand"
              disabled={!canUpdate}
              aria-describedby={status.blockReason ? "update-block-reason" : undefined}
              onClick={() => setConfirmOpen(true)}
            >
              {status.active ? t.actions.updating : t.actions.update(displayVersion(latest.version))}
            </Button>
          ) : (
            checkButton("brand")
          )
        }
        actionsExtra={status.hasUpdate ? checkButton("outline") : undefined}
      />
      {status.hasUpdate && status.blockReason && (
        <p id="update-block-reason" className="sr-only">
          {t.block[status.blockReason]}
        </p>
      )}

      <div className="flex flex-col gap-4 sm:gap-6">
        {progress && watching && <ProgressCard req={progress} link={link} onReload={() => window.location.reload()} />}
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-3 lg:items-start">
          <div className="flex min-w-0 flex-col gap-4 sm:gap-6 lg:col-span-2">
            <VersionCard status={status} />
            {latest && <ReleaseNotesCard latest={latest} />}
            <HistoryCard history={status.history} />
          </div>
          <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
            <UpdaterCard updater={status.updater} />
          </div>
        </div>
      </div>

      {latest && (
        <ReauthDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          twoFactorEnabled={twoFactorEnabled}
          idPrefix="update-reauth"
          hint={t.confirm.hint}
          texts={{
            title: t.confirm.title(displayVersion(latest.version)),
            description: t.confirm.description(displayVersion(status.current), displayVersion(latest.version)),
            submit: t.confirm.submit,
            submitting: t.confirm.submitting,
          }}
          onSubmit={(fields) => startUpdateAction({ targetVersion: latest.version, ...fields })}
          onSuccess={(data, message) => {
            toast.success(message ?? t.toast.started)
            setWatchedId(data.id)
            void refresh()
          }}
          onFailure={() => {
            void refresh() // e.g. someone else started an update, or the latest release changed
          }}
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
            {t.confirm.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </ReauthDialog>
      )}
    </>
  )
}
