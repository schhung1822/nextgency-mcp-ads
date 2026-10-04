"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { authErrorMessage, loginSchema, type LoginInput } from "@/lib/schemas/auth"

import { authClient } from "../auth-client"
import { PasswordInput } from "../password-input"

export function LoginForm({ next }: { next: string | null }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null)
    try {
      const { data, error: err } = await authClient.signIn.email({
        email: values.email.trim().toLowerCase(),
        password: values.password,
      })
      if (err) {
        setError(authErrorMessage(err.code, err.status))
        form.resetField("password")
        form.setFocus("password")
        return
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        router.push(next ? `/login/2fa?next=${encodeURIComponent(next)}` : "/login/2fa")
        return
      }
      window.location.assign(next ?? "/")
    } catch {
      setError(tAuth.errors.NETWORK)
    }
  })

  const pending = form.formState.isSubmitting

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="login-email">{tAuth.login.email}</FieldLabel>
              <Input
                {...field}
                id="login-email"
                className="h-10"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                placeholder={tAuth.login.emailPlaceholder}
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="login-password">{tAuth.login.password}</FieldLabel>
              <PasswordInput
                {...field}
                id="login-password"
                autoComplete="current-password"
                aria-invalid={fieldState.invalid || undefined}
              />
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
        {pending ? tAuth.login.submitting : tAuth.login.submit}
      </Button>
      <p className="text-center text-[13px] text-pretty text-muted-foreground">{tAuth.login.noAccountHint}</p>
    </form>
  )
}
