"use client"

import * as React from "react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { EMPTY_REAUTH, ReauthFields, reauthPayload, type ReauthValues } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { reauthFieldsSchema } from "@/lib/schemas/reauth"

export interface PasswordDialogProps {
  trigger: React.ReactNode
  title: string
  description: string
  submitLabel: string
  passwordLabel: string
  destructive?: boolean
  /** also ask for the 6-digit TOTP code (user has 2FA enabled) */
  withCode?: boolean
  /** return an error message to keep the dialog open, or null on success */
  onSubmit: (fields: { password: string; code?: string }) => Promise<string | null>
  /** content shown after success instead of the form (e.g. new backup codes); dialog stays open */
  successContent?: React.ReactNode
}

/** Re-enter password (+ TOTP) to confirm a sensitive self-service action (2FA disable, new backup codes…). */
export function PasswordDialog({
  trigger,
  title,
  description,
  submitLabel,
  passwordLabel,
  destructive,
  withCode = false,
  onSubmit,
  successContent,
}: PasswordDialogProps) {
  const [open, setOpen] = React.useState(false)
  const [values, setValues] = React.useState<ReauthValues>(EMPTY_REAUTH)
  const [error, setError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<{ password?: string; code?: string }>({})
  const [pending, setPending] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const id = React.useId()

  function reset() {
    setValues(EMPTY_REAUTH)
    setError(null)
    setFieldErrors({})
    setDone(false)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const payload = reauthPayload(values, withCode)
    const parsed = reauthFieldsSchema.safeParse(payload)
    if (!parsed.success || (withCode && !parsed.data.code)) {
      const issue = parsed.success ? null : parsed.error.issues[0]
      const key = issue ? String(issue.path[0]) : "code"
      return setFieldErrors({ [key]: issue?.message ?? tAuth.validation.codeInvalid })
    }
    setFieldErrors({})
    setPending(true)
    try {
      const err = await onSubmit(parsed.data)
      if (err) {
        setValues(EMPTY_REAUTH)
        return setError(err)
      }
      setValues(EMPTY_REAUTH)
      if (successContent) setDone(true)
      else setOpen(false)
    } catch {
      setError(tAuth.errors.NETWORK)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {!done && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {done ? (
          <>
            {successContent}
            <DialogFooter className="[&>button]:h-10 sm:[&>button]:h-9">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {common.close}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <FieldGroup>
              <ReauthFields
                idPrefix={id}
                twoFactorEnabled={withCode}
                value={values}
                onChange={setValues}
                errors={fieldErrors}
                passwordLabel={passwordLabel}
                hint={null}
                autoFocus
              />
            </FieldGroup>
            {error && (
              <Alert variant="destructive" role="alert">
                <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="[&>button]:h-10 sm:[&>button]:h-9">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                {common.cancel}
              </Button>
              <Button
                type="submit"
                variant={destructive ? "destructive" : "default"}
                disabled={pending}
              >
                {pending && <Spinner aria-hidden />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
