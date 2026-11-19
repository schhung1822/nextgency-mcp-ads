"use client"

import * as React from "react"
import { SecurityCheckIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { StatusBadge } from "@/components/app"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { ActionResult } from "@/lib/action-result"
import { account as tAccount } from "@/lib/i18n/vi/account"

import { BackupCodes } from "../../(auth)/security/enable-2fa/backup-codes"
import { PasswordDialog } from "./password-dialog"

const t = tAccount.twoFactor

export interface TwoFactorCardProps {
  email: string
  enabled: boolean
  /** policy forces 2FA for this user's role ("Bắt buộc 2FA cho quản trị viên") */
  isAdmin: boolean
  /** policy forces 2FA for everyone */
  requiredForAll: boolean
  regenerate: (input: unknown) => Promise<ActionResult<{ backupCodes: string[] }>>
  disable: (input: unknown) => Promise<ActionResult>
}

export function TwoFactorCard({ email, enabled, isAdmin, requiredForAll, regenerate, disable }: TwoFactorCardProps) {
  const router = useRouter()
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const canDisable = enabled && !isAdmin && !requiredForAll
  const note = isAdmin ? t.requiredAdmin : requiredForAll ? t.requiredAll : enabled ? null : t.optionalNote

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-ink">
            <HugeiconsIcon icon={SecurityCheckIcon} strokeWidth={2} className="size-[18px]" aria-hidden />
          </span>
          {t.title}
        </CardTitle>
        <CardDescription>{enabled ? t.descriptionOn : t.descriptionOff}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div>
            <StatusBadge
              kind="mcp"
              status={enabled ? "active" : "disabled"}
              label={enabled ? t.enabled : t.disabled}
            />
          </div>
          {note && <p className="text-[13px] text-pretty text-muted-foreground">{note}</p>}
        </div>
        {!enabled ? (
          <Button asChild className="h-10 w-full">
            <Link href="/security/enable-2fa">{t.enable}</Link>
          </Button>
        ) : (
          <div className="flex flex-col gap-2">
            <PasswordDialog
              trigger={
                <Button variant="outline" className="h-10 w-full">
                  {t.regenerate}
                </Button>
              }
              title={t.regenerateTitle}
              description={t.regenerateDescription}
              submitLabel={t.regenerateSubmit}
              passwordLabel={t.password}
              withCode
              onSubmit={async (fields) => {
                const res = await regenerate(fields)
                if (!res.ok) return res.error
                setCodes(res.data.backupCodes)
                toast.success(res.message ?? t.regenerateDone)
                return null
              }}
              successContent={
                codes ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-pretty text-muted-foreground">{t.regenerateSaved}</p>
                    <BackupCodes codes={codes} email={email} />
                  </div>
                ) : null
              }
            />
            {canDisable && (
              <PasswordDialog
                trigger={
                  <Button variant="ghost" className="h-10 w-full text-destructive hover:text-destructive">
                    {t.disable}
                  </Button>
                }
                title={t.disableTitle}
                description={t.disableDescription}
                submitLabel={t.disableSubmit}
                passwordLabel={t.password}
                destructive
                withCode
                onSubmit={async (fields) => {
                  const res = await disable(fields)
                  if (!res.ok) return res.error
                  toast.success(res.message ?? t.disabledToast)
                  router.refresh()
                  return null
                }}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
