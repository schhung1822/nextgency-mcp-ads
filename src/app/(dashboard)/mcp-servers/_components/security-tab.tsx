"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Alert02Icon,
  Delete02Icon,
  Key01Icon,
  PowerIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/app"
import { UrlCopyBox } from "@/components/mcp/url-copy-box"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { common } from "@/lib/i18n/vi/common"
import { formatDateTime } from "@/lib/format"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type { McpDetail } from "@/server/services/mcp-servers"

import { RevealDialog } from "./reveal-dialog"

const s = t.security

export interface SecurityActions {
  setEnabled: (input: unknown) => Promise<ActionResult<{ changed: boolean }>>
  rotate: (input: unknown) => Promise<ActionResult<{ url: string }>>
  remove: (input: unknown) => Promise<ActionResult<undefined>>
}

function ActionCard({
  icon,
  title,
  description,
  children,
  danger,
}: {
  icon: IconSvgElement
  title: string
  description: React.ReactNode
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <Card
      className={
        danger ? "bg-destructive/[0.03] ring-1 ring-destructive/30" : undefined
      }
    >
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={
              danger
                ? "flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive-strong"
                : "flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-red/10 text-brand-ink"
            }
          >
            <HugeiconsIcon
              icon={icon}
              strokeWidth={2}
              className="size-5"
              aria-hidden
            />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="mt-1 text-pretty">
              {description}
            </CardDescription>
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-auto [&>button]:w-full sm:[&>button]:w-auto">
          {children}
        </div>
      </CardHeader>
    </Card>
  )
}

export function SecurityTab({
  mcp,
  actions,
  twoFactorEnabled,
  onKeyRotated,
}: {
  mcp: McpDetail
  actions: SecurityActions
  twoFactorEnabled: boolean
  onKeyRotated: (url: string) => void
}) {
  const router = useRouter()
  const [newUrl, setNewUrl] = React.useState<string | null>(null)
  const [rotateOpen, setRotateOpen] = React.useState(false)
  const [enabling, startEnable] = React.useTransition()
  const active = mcp.status !== "disabled"

  const onRotated = (url: string) => {
    toast.success(t.toast.rotated)
    setNewUrl(url)
    onKeyRotated(url)
    router.refresh()
  }

  const setEnabled = async (enabled: boolean) => {
    const r = await actions.setEnabled({ id: mcp.id, enabled })
    if (!r.ok) {
      toast.error(r.error)
      return false
    }
    toast.success(r.message ?? (enabled ? t.toast.enabled : t.toast.disabled))
    router.refresh()
  }

  const remove = async () => {
    const r = await actions.remove({ id: mcp.id, confirmName: mcp.name })
    if (!r.ok) {
      toast.error(r.error)
      return false
    }
    toast.success(r.message ?? t.toast.deleted)
    router.push("/mcp-servers")
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="sec-access" className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 id="sec-access" className="text-sm font-semibold">
            {s.groupAccess}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {s.groupAccessDesc}
          </p>
        </div>
        <ActionCard
          icon={Key01Icon}
          title={s.rotateTitle}
          description={
            <>
              {s.rotateDescription}{" "}
              <span className="mt-1 block text-[13px]">
                {mcp.keyRotatedAt
                  ? s.lastRotated(formatDateTime(mcp.keyRotatedAt))
                  : s.neverRotated}
              </span>
            </>
          }
        >
          <Button variant="outline" onClick={() => setRotateOpen(true)}>
            {s.rotateAction}
          </Button>
          <RevealDialog
            open={rotateOpen}
            onOpenChange={setRotateOpen}
            mcpId={mcp.id}
            twoFactorEnabled={twoFactorEnabled}
            revealAction={actions.rotate}
            onRevealed={onRotated}
            texts={{
              title: s.rotateReauthTitle,
              description: s.rotateReauthDescription,
              submit: s.rotateReauthSubmit,
            }}
          />
        </ActionCard>

        <ActionCard
          icon={PowerIcon}
          title={active ? s.toggleTitleOn : s.toggleTitleOff}
          description={
            <>
              {active ? s.toggleDescriptionOn : s.toggleDescriptionOff}
              {mcp.status === "expired" && (
                <span className="mt-1 block text-warning-strong">
                  {s.expiredHint}
                </span>
              )}
            </>
          }
        >
          {active ? (
            <ConfirmDialog
              trigger={<Button variant="outline">{s.disableAction}</Button>}
              title={s.disableConfirmTitle}
              description={s.disableConfirmDescription}
              confirmLabel={s.disableAction}
              onConfirm={() => setEnabled(false)}
            />
          ) : (
            <Button
              variant="outline"
              disabled={enabling}
              onClick={() =>
                startEnable(async () => void (await setEnabled(true)))
              }
            >
              {enabling && <Spinner aria-hidden />}
              {s.enableAction}
            </Button>
          )}
        </ActionCard>
      </section>

      <section aria-labelledby="sec-danger" className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2
            id="sec-danger"
            className="text-sm font-semibold text-destructive-strong"
          >
            {s.dangerZone}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {s.dangerZoneDesc}
          </p>
        </div>
        <ActionCard
          icon={Delete02Icon}
          title={s.deleteTitle}
          description={s.deleteDescription}
          danger
        >
          <ConfirmDialog
            trigger={<Button variant="destructive">{s.deleteAction}</Button>}
            title={s.deleteConfirmTitle(mcp.name)}
            description={s.deleteConfirmDescription}
            confirmLabel={s.deleteAction}
            destructive
            confirmText={mcp.name}
            onConfirm={remove}
          />
        </ActionCard>
      </section>

      <Dialog open={!!newUrl} onOpenChange={(o) => !o && setNewUrl(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{s.rotatedTitle}</DialogTitle>
            <DialogDescription>{s.rotatedDescription}</DialogDescription>
          </DialogHeader>
          {newUrl && <UrlCopyBox value={newUrl} label={t.success.urlLabel} />}
          <Alert className="border-warning/40 bg-warning/10">
            <HugeiconsIcon
              icon={Alert02Icon}
              strokeWidth={2}
              aria-hidden
              className="text-warning-strong"
            />
            <AlertTitle className="text-warning-strong">
              {t.success.warningTitle}
            </AlertTitle>
            <AlertDescription>{t.success.warning}</AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewUrl(null)}>
              {common.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
