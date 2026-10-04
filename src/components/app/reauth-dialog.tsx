"use client"

// Dialog asking for password (+ TOTP when 2FA is on) before a sensitive action. `onSubmit` receives the
// re-auth fields and calls the server action; on success the dialog closes and `onSuccess` gets the data.
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { reauth as t } from "@/lib/i18n/vi/reauth"

import {
  EMPTY_REAUTH,
  ReauthFields,
  reauthComplete,
  reauthPayload,
  type ReauthValues,
} from "./reauth-fields"

export interface ReauthDialogTexts {
  title: string
  description: string
  submit: string
  submitting?: string
}

export function ReauthDialog<T>({
  open,
  onOpenChange,
  twoFactorEnabled,
  texts,
  onSubmit,
  onSuccess,
  onFailure,
  idPrefix = "reauth",
  passwordLabel,
  hint,
  destructive,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  twoFactorEnabled: boolean
  texts: ReauthDialogTexts
  onSubmit: (fields: { password: string; code?: string }) => Promise<ActionResult<T>>
  onSuccess: (data: T, message?: string) => void
  /** return true when the failure was handled elsewhere (dialog closes, no inline error) */
  onFailure?: (result: Extract<ActionResult<T>, { ok: false }>) => boolean | void
  idPrefix?: string
  passwordLabel?: string
  hint?: string | null
  destructive?: boolean
  children?: React.ReactNode
}) {
  const [values, setValues] = React.useState<ReauthValues>(EMPTY_REAUTH)
  const [error, setError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [pending, startTransition] = React.useTransition()

  const reset = () => {
    setValues(EMPTY_REAUTH)
    setError(null)
    setFieldErrors({})
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pending || !reauthComplete(values, twoFactorEnabled)) return
    startTransition(async () => {
      let r: ActionResult<T>
      try {
        r = await onSubmit(reauthPayload(values, twoFactorEnabled))
      } catch {
        setError(tAuth.errors.NETWORK)
        return
      }
      if (r.ok) {
        reset()
        onSuccess(r.data, r.message)
        onOpenChange(false)
        return
      }
      if (onFailure?.(r) === true) {
        reset()
        onOpenChange(false)
        return
      }
      setError(r.error)
      setFieldErrors(r.fieldErrors ?? {})
      setValues(EMPTY_REAUTH)
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{texts.title}</DialogTitle>
            <DialogDescription>{texts.description}</DialogDescription>
          </DialogHeader>
          {children}
          <FieldGroup>
            <ReauthFields
              idPrefix={idPrefix}
              twoFactorEnabled={twoFactorEnabled}
              value={values}
              onChange={setValues}
              errors={fieldErrors}
              autoFocus
              passwordLabel={passwordLabel}
              hint={hint}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {common.cancel}
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "brand"}
              disabled={pending || !reauthComplete(values, twoFactorEnabled)}
            >
              {pending && <Spinner aria-hidden />}
              {pending ? (texts.submitting ?? t.submitting) : texts.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
