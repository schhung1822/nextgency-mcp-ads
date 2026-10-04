"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Alert02Icon, Copy01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch, type Path } from "react-hook-form"
import { toast } from "sonner"

import {
  CopyField,
  EMPTY_REAUTH,
  ReauthFields,
  reauthComplete,
  reauthPayload,
  useCopy,
  type ReauthValues,
} from "@/components/app"
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { users as tUsers } from "@/lib/i18n/vi/users"
import { createUserSchema, generateTempPassword, type CreateUserInput } from "@/lib/schemas/users"

import { RolePicker } from "./role-picker"
import { TempPasswordField } from "./temp-password-field"
import type { UserActions } from "./types"

const t = tUsers.create

/** Taller than the phone screen once the admin re-auth block shows → the dialog itself scrolls. */
const CONTENT_CLASS = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"

export function CreateUserDialog({ action, actorTwoFactor }: { action: UserActions["create"]; actorTwoFactor: boolean }) {
  const router = useRouter()
  const { copy } = useCopy({ toastMessage: tUsers.toast.credentialsCopied })
  const [open, setOpen] = React.useState(false)
  // creating an ADMIN requires the acting admin's password + TOTP
  const [reauth, setReauth] = React.useState<ReauthValues>(EMPTY_REAUTH)
  const [reauthErrors, setReauthErrors] = React.useState<{ password?: string; code?: string }>({})
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<{ email: string; password: string } | null>(null)
  const form = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: "", email: "", role: "staff", password: "" },
  })

  function reset() {
    form.reset({ name: "", email: "", role: "staff", password: generateTempPassword() })
    setReauth(EMPTY_REAUTH)
    setReauthErrors({})
    setError(null)
    setCreated(null)
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null)
    const isAdmin = values.role === "admin"
    if (isAdmin && !reauthComplete(reauth, actorTwoFactor)) {
      return setReauthErrors(reauth.password ? { code: tUsers.changeRole.codeRequired } : { password: tUsers.create.reauthRequired })
    }
    setReauthErrors({})
    const { reauth: _ignored, ...base } = values
    const res = await action(isAdmin ? { ...base, reauth: reauthPayload(reauth, actorTwoFactor) } : base).catch(() => null)
    setReauth(EMPTY_REAUTH)
    if (!res) return setError(tAuth.errors.NETWORK)
    if (!res.ok) {
      setError(res.error)
      setReauthErrors({ password: res.fieldErrors?.["reauth.password"], code: res.fieldErrors?.["reauth.code"] })
      for (const [k, msg] of Object.entries(res.fieldErrors ?? {})) form.setError(k as Path<CreateUserInput>, { message: msg })
      return
    }
    toast.success(res.message ?? tUsers.toast.created)
    setCreated({ email: values.email.trim().toLowerCase(), password: values.password })
    router.refresh()
  })

  const pending = form.formState.isSubmitting
  const role = useWatch({ control: form.control, name: "role" })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        setOpen(o)
        if (o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="brand">
          <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={2} aria-hidden />
          {tUsers.add}
        </Button>
      </DialogTrigger>
      <DialogContent className={CONTENT_CLASS}>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t.doneTitle}</DialogTitle>
              <DialogDescription>{t.doneDescription}</DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="created-email">{t.doneEmail}</FieldLabel>
                <CopyField id="created-email" value={created.email} label={t.doneEmail} />
              </Field>
              <Field>
                <FieldLabel htmlFor="created-password">{t.donePassword}</FieldLabel>
                <CopyField id="created-password" value={created.password} label={t.donePassword} />
              </Field>
            </FieldGroup>
            <DialogFooter className="[&>button]:h-10 sm:[&>button]:h-9">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t.close}
              </Button>
              <Button
                type="button"
                onClick={() => void copy(t.copyText(created.email, created.password, `${window.location.origin}/login`))}
              >
                <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
                {t.copyAll}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>{t.title}</DialogTitle>
              <DialogDescription>{t.description}</DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-4">
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="new-user-name">{t.name}</FieldLabel>
                    <Input
                      {...field}
                      id="new-user-name"
                      className="h-10"
                      autoComplete="off"
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="email"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="new-user-email">{t.email}</FieldLabel>
                    <Input
                      {...field}
                      id="new-user-email"
                      className="h-10"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="role"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel id="new-user-role-label">{t.role}</FieldLabel>
                    <RolePicker id="new-user-role" value={field.value} onChange={field.onChange} ariaLabel={t.roleAria} />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="password"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="new-user-password">{t.password}</FieldLabel>
                    <TempPasswordField
                      id="new-user-password"
                      value={field.value}
                      onChange={field.onChange}
                      invalid={fieldState.invalid}
                      describedBy="new-user-password-hint"
                    />
                    <FieldDescription id="new-user-password-hint">{t.passwordHint}</FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              {role === "admin" && (
                <div className="flex flex-col gap-4 rounded-2xl border bg-muted/40 p-4">
                  <p className="text-sm font-medium">{t.adminReauthTitle}</p>
                  <FieldGroup className="gap-4">
                    <ReauthFields
                      idPrefix="new-user-reauth"
                      twoFactorEnabled={actorTwoFactor}
                      value={reauth}
                      onChange={setReauth}
                      errors={reauthErrors}
                      hint={t.adminReauthHint}
                    />
                  </FieldGroup>
                </div>
              )}
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
              <Button type="submit" disabled={pending}>
                {pending && <Spinner aria-hidden />}
                {pending ? t.submitting : t.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
