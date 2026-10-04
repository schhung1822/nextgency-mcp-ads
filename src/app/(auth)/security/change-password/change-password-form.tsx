"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter } from "next/navigation"
import { Controller, useForm, type Path } from "react-hook-form"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/schemas/auth"

import { PasswordInput } from "../../password-input"

const t = tAuth.changePassword

export interface ChangePasswordFormProps {
  action: (input: unknown) => Promise<ActionResult>
  /** forced first-login change: full-width brand button + hint, navigates to `doneHref` afterwards */
  forced?: boolean
  doneHref?: string
  idPrefix?: string
}

export function ChangePasswordForm({ action, forced, doneHref, idPrefix = "pw" }: ChangePasswordFormProps) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null)
    const res = await action(values).catch(() => null)
    if (!res) return setError(tAuth.errors.NETWORK)
    if (!res.ok) {
      setError(res.error)
      for (const [k, msg] of Object.entries(res.fieldErrors ?? {})) {
        form.setError(k as Path<ChangePasswordInput>, { message: msg })
      }
      return
    }
    toast.success(res.message ?? t.changedToast)
    form.reset()
    if (doneHref) window.location.assign(doneHref)
    else router.refresh() // other sessions were revoked → refresh the sessions list
  })

  const pending = form.formState.isSubmitting
  const fields: { name: Path<ChangePasswordInput>; label: string; hint?: string; autoComplete: string }[] = [
    {
      name: "currentPassword",
      label: t.current,
      hint: forced ? t.currentForcedHint : undefined,
      autoComplete: "current-password",
    },
    { name: "newPassword", label: t.next, hint: t.nextHint, autoComplete: "new-password" },
    { name: "confirmPassword", label: t.confirm, autoComplete: "new-password" },
  ]

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        {fields.map((f, i) => (
          <Controller
            key={f.name}
            control={form.control}
            name={f.name}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={`${idPrefix}-${f.name}`}>{f.label}</FieldLabel>
                <PasswordInput
                  {...field}
                  id={`${idPrefix}-${f.name}`}
                  autoComplete={f.autoComplete}
                  autoFocus={forced && i === 0}
                  aria-invalid={fieldState.invalid || undefined}
                />
                {f.hint && !fieldState.error && <FieldDescription>{f.hint}</FieldDescription>}
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        ))}
      </FieldGroup>
      {error && (
        <Alert variant="destructive" role="alert">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className={forced ? "" : "flex justify-end"}>
        <Button
          type="submit"
          variant={forced ? "brand" : "outline"}
          size={forced ? "lg" : "default"}
          disabled={pending}
          className={forced ? "w-full" : undefined}
        >
          {pending && <Spinner aria-hidden />}
          {pending ? t.submitting : t.submit}
        </Button>
      </div>
    </form>
  )
}
