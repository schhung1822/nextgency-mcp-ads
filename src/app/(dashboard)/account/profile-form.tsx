"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { account as tAccount } from "@/lib/i18n/vi/account"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { profileSchema, type ProfileInput } from "@/lib/schemas/auth"

import { RoleBadge } from "../users/role-badge"
import type { Role } from "../users/types"
import { UserAvatar } from "../users/user-avatar"

const t = tAccount.profile

export function ProfileForm({
  name,
  email,
  role,
  action,
}: {
  name: string
  email: string
  role: Role
  action: (input: unknown) => Promise<ActionResult>
}) {
  const router = useRouter()
  const form = useForm<ProfileInput>({ resolver: zodResolver(profileSchema), defaultValues: { name } })

  const onSubmit = form.handleSubmit(async (values) => {
    const res = await action(values).catch(() => null)
    if (!res) return toast.error(tAuth.errors.NETWORK)
    if (!res.ok) {
      form.setError("name", { message: res.fieldErrors?.name ?? res.error })
      return
    }
    toast.success(res.message ?? t.savedToast)
    form.reset({ name: values.name.trim() })
    router.refresh()
  })

  const pending = form.formState.isSubmitting

  return (
    <div className="flex flex-col gap-5">
      {/* identity: who you are signed in as (email + role are not editable) */}
      <div className="flex items-center gap-3 rounded-2xl bg-muted/50 p-3.5 sm:gap-4 sm:p-4">
        <UserAvatar name={name} email={email} admin={role === "admin"} className="size-12 text-sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate leading-5 font-medium">{name || email}</p>
          <p className="truncate text-[13px] leading-5 text-muted-foreground" data-testid="profile-email">
            {email}
          </p>
          <RoleBadge role={role} className="mt-1.5 sm:hidden" />
        </div>
        <RoleBadge role={role} className="hidden shrink-0 sm:inline-flex" />
      </div>
      <p className="-mt-2 text-[13px] text-pretty text-muted-foreground">{t.emailHint}</p>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <FieldGroup className="gap-4">
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="profile-name">{t.name}</FieldLabel>
                <Input
                  {...field}
                  id="profile-name"
                  className="h-10"
                  autoComplete="name"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </FieldGroup>
        <div className="flex sm:justify-end">
          <Button
            type="submit"
            variant="brand"
            className="h-10 w-full sm:w-auto"
            disabled={pending || !form.formState.isDirty}
          >
            {pending && <Spinner aria-hidden />}
            {pending ? t.saving : t.save}
          </Button>
        </div>
      </form>
    </div>
  )
}
