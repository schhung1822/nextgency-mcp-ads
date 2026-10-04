"use client"

// "Thay token": re-enter every credential field (never prefilled) + current password.
import * as React from "react"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"

import { SecretInput } from "@/components/app"
import { StatusHint } from "@/components/mcp/status-hint"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { reauth as tReauth } from "@/lib/i18n/vi/reauth"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { common } from "@/lib/i18n/vi/common"
import { connections as m } from "@/lib/i18n/vi/connections"
import {
  splitTrailingHint,
  visibleCredentialValues,
  type PlatformFormSpec,
} from "@/lib/schemas/connections"
import { replaceCredentialsAction } from "@/server/actions/connections"

import {
  CredentialFields,
  initialCredentialValues,
} from "../../_components/credential-fields"

interface Values {
  credentials: Record<string, string>
  password: string
  code: string
}

export function ReplaceCredentialsDialog({
  open,
  onOpenChange,
  connectionId,
  spec,
  credentialHint,
  twoFactorEnabled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  spec: PlatformFormSpec
  credentialHint: string
  /** current user's 2FA state: re-auth also asks for the TOTP code */
  twoFactorEnabled: boolean
}) {
  const [error, setError] = React.useState<string | null>(null)
  const defaults = React.useMemo<Values>(
    () => ({
      credentials: initialCredentialValues(spec.fields),
      password: "",
      code: "",
    }),
    [spec.fields]
  )
  const form = useForm<Values>({ defaultValues: defaults })
  const pwError = form.formState.errors.password
  const codeError = form.formState.errors.code
  // the server sends "<what happened> <next step>" in one string - show the next step on its own line
  const errorParts = error ? splitTrailingHint(error) : null

  const close = (next: boolean) => {
    if (!next) {
      // drop every typed secret when the dialog closes
      form.reset(defaults)
      setError(null)
    }
    onOpenChange(next)
  }

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null)
    const code = twoFactorEnabled ? v.code : undefined
    const res = await replaceCredentialsAction({
      connectionId,
      password: v.password,
      code,
      credentials: visibleCredentialValues(spec.fields, v.credentials),
    })
    if (!res.ok) {
      // re-auth fields are never kept after a failed attempt
      form.setValue("password", "")
      form.setValue("code", "")
      if (res.fieldErrors?.password)
        form.setError("password", { message: res.fieldErrors.password })
      else if (res.fieldErrors?.code)
        form.setError("code", { message: res.fieldErrors.code })
      else setError(res.error)
      return
    }
    toast.success(res.message ?? m.replace.done)
    close(false)
  })

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{m.replace.title}</DialogTitle>
            <DialogDescription>
              {m.replace.description}{" "}
              <span className="font-mono">
                {m.replace.currentHint(credentialHint)}
              </span>
            </DialogDescription>
          </DialogHeader>

          <CredentialFields
            fields={spec.fields}
            control={form.control}
            prefix="credentials"
            idPrefix="rcred"
          />

          <Separator />

          <Field data-invalid={!!pwError || undefined}>
            <FieldLabel htmlFor="replace-password">
              {m.replace.passwordLabel}
            </FieldLabel>
            <SecretInput
              id="replace-password"
              aria-invalid={!!pwError || undefined}
              {...form.register("password", {
                validate: (val) =>
                  val.trim() === "" ? m.errors.passwordRequired : true,
              })}
            />
            <FieldDescription>{m.replace.passwordHelp}</FieldDescription>
            <FieldError errors={[pwError]} />
          </Field>

          {twoFactorEnabled && (
            <Field data-invalid={!!codeError || undefined}>
              <FieldLabel htmlFor="replace-code">
                {tReauth.codeLabel}
              </FieldLabel>
              <Controller
                control={form.control}
                name="code"
                rules={{
                  validate: (val) =>
                    /^\d{6}$/.test(val) ? true : tReauth.codeInvalid,
                }}
                render={({ field }) => (
                  <InputOTP
                    id="replace-code"
                    maxLength={6}
                    inputMode="numeric"
                    value={field.value}
                    onChange={field.onChange}
                  >
                    <InputOTPGroup>
                      {Array.from({ length: 6 }, (_, i) => (
                        <InputOTPSlot key={i} index={i} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                )}
              />
              <FieldDescription>{tReauth.codeHelp}</FieldDescription>
              <FieldError errors={[codeError]} />
            </Field>
          )}

          {error && (
            <div
              role="alert"
              className="flex flex-col gap-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <p>{errorParts?.message}</p>
              <StatusHint message={errorParts?.message} hint={errorParts?.hint} />
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
            >
              {common.cancel}
            </Button>
            <Button
              type="submit"
              variant="brand"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting && <Spinner aria-hidden />}
              {m.replace.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
