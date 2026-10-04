"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Controller, useForm, type Path } from "react-hook-form"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import type { ActionResult } from "@/lib/action-result"
import { setupSchema, type SetupInput } from "@/lib/schemas/auth"
import { common } from "@/lib/i18n/vi/common"

import { PasswordInput } from "../password-input"

const s = tAuth.setup

export function SetupForm({ action }: { action: (input: unknown) => Promise<ActionResult<{ next: string }>> }) {
  const [error, setError] = React.useState<string | null>(null)
  const form = useForm<SetupInput>({
    resolver: zodResolver(setupSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "", setupToken: "" },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null)
    const res = await action(values).catch(() => null)
    if (!res) return setError(tAuth.errors.NETWORK)
    if (!res.ok) {
      setError(res.error)
      for (const [k, msg] of Object.entries(res.fieldErrors ?? {})) {
        form.setError(k as Path<SetupInput>, { message: msg })
      }
      return
    }
    // Signed in now (session cookie set by the action) → forced 2FA enrollment.
    window.location.assign(res.data.next)
    // keep the button in its pending state while the browser navigates
    await new Promise(() => {})
  })

  const pending = form.formState.isSubmitting

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="setup-name">{s.name}</FieldLabel>
              <Input {...field} id="setup-name" className="h-10" autoComplete="name" placeholder={s.namePlaceholder} autoFocus aria-invalid={fieldState.invalid || undefined} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="setup-email">{s.email}</FieldLabel>
              <Input {...field} id="setup-email" className="h-10" type="email" inputMode="email" autoComplete="username" autoCapitalize="off" spellCheck={false} placeholder={s.emailPlaceholder} aria-invalid={fieldState.invalid || undefined} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="setup-password">{s.password}</FieldLabel>
              <PasswordInput {...field} id="setup-password" autoComplete="new-password" aria-invalid={fieldState.invalid || undefined} />
              {!fieldState.error && <FieldDescription>{s.passwordHint}</FieldDescription>}
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="setup-confirm">{s.confirmPassword}</FieldLabel>
              <PasswordInput {...field} id="setup-confirm" autoComplete="new-password" aria-invalid={fieldState.invalid || undefined} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="setupToken"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="setup-token">{s.token}</FieldLabel>
              <PasswordInput
                {...field}
                id="setup-token"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                className="font-mono text-[13px]"
                toggleLabels={{ show: common.secret.showLabel, hide: common.secret.hideLabel }}
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldDescription>{s.tokenHint}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      {error && (
        <Alert variant="destructive" role="alert">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" variant="brand" size="lg" disabled={pending} className="w-full">
        {pending && <Spinner aria-hidden />}
        {pending ? s.submitting : s.submit}
      </Button>
      <p className="text-center text-[13px] text-pretty text-muted-foreground">{s.nextStepHint}</p>
    </form>
  )
}
