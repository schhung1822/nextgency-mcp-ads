"use client"

// "Service account riêng" (advanced): a user's own service account, used only for that user's sources.
// The JSON key is write-only (never prefilled, never returned); the list shows the email + last 4 chars of the key id.
import * as React from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import {
  Add01Icon,
  Delete02Icon,
  Key01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { ConfirmDialog, RelativeTime, SecretInput } from "@/components/app"
import { Badge } from "@/components/ui/badge"
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
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { common } from "@/lib/i18n/vi/common"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  createPersonalDriveCredentialSchema,
  type CreatePersonalDriveCredentialInput,
  type PersonalDriveCredentialDto,
} from "@/lib/schemas/drive"
import {
  createPersonalDriveCredentialAction,
  deletePersonalDriveCredentialAction,
  testPersonalDriveCredentialAction,
} from "@/server/actions/drive"

import { DriveStatusBadge } from "./drive-badges"

const m = driveUi.personal

/** Dialog "Thêm service account riêng": name + JSON key, checked with Google by the action. */
export function AddPersonalCredentialDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (created: { id: string; clientEmail: string }) => void
}) {
  const router = useRouter()
  const form = useForm<CreatePersonalDriveCredentialInput>({
    resolver: zodResolver(createPersonalDriveCredentialSchema),
    defaultValues: { name: "", serviceAccountJson: "" },
    mode: "onTouched",
  })
  const [error, setError] = React.useState<string | null>(null)
  const submitting = form.formState.isSubmitting

  const close = (o: boolean) => {
    if (submitting) return
    if (!o) {
      // the key never stays in the browser after the dialog closes
      form.reset({ name: "", serviceAccountJson: "" })
      setError(null)
    }
    onOpenChange(o)
  }

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null)
    const res = await createPersonalDriveCredentialAction(v)
    if (!res.ok) {
      let placed = false
      for (const k of ["name", "serviceAccountJson"] as const) {
        const msg = res.fieldErrors?.[k]
        if (msg) {
          form.setError(k, { message: msg })
          placed = true
        }
      }
      if (!placed) setError(res.error)
      return
    }
    toast.success(res.message ?? driveUi.service.done.personalCreated)
    form.reset({ name: "", serviceAccountJson: "" })
    onOpenChange(false)
    onCreated?.(res.data)
    router.refresh()
  })

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{m.dialogTitle}</DialogTitle>
            <DialogDescription>{m.dialogDescription}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="drive-sa-name">{m.nameLabel}</FieldLabel>
                  <Input
                    id="drive-sa-name"
                    {...field}
                    placeholder={m.namePlaceholder}
                    autoComplete="off"
                    maxLength={120}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="serviceAccountJson"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="drive-sa-json">{m.jsonLabel}</FieldLabel>
                  <SecretInput
                    id="drive-sa-json"
                    multiline
                    rows={6}
                    name={field.name}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    ref={field.ref}
                    placeholder={m.jsonPlaceholder}
                    aria-invalid={fieldState.invalid || undefined}
                    aria-describedby="drive-sa-json-help"
                  />
                  <FieldDescription id="drive-sa-json-help">
                    {m.jsonHelp}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
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
              disabled={submitting}
              onClick={() => close(false)}
            >
              {common.cancel}
            </Button>
            <Button type="submit" variant="brand" disabled={submitting}>
              {submitting && <Spinner aria-hidden />}
              {submitting ? m.saving : m.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Section under the sources table: the viewer's own service accounts (admin: everybody's, with owner). */
export function PersonalCredentialsSection({
  credentials,
  isAdmin,
}: {
  credentials: PersonalDriveCredentialDto[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [addOpen, setAddOpen] = React.useState(false)
  const [testing, setTesting] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<PersonalDriveCredentialDto | null>(
    null
  )

  const test = async (c: PersonalDriveCredentialDto) => {
    setTesting(c.id)
    const res = await testPersonalDriveCredentialAction({ credentialId: c.id })
    setTesting(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.ok)
      toast.success(res.message ?? driveUi.service.done.credentialTested)
    else
      toast.error(m.testFailed, {
        description: res.data.statusMessage ?? undefined,
      })
    router.refresh()
  }

  return (
    <section
      aria-labelledby="drive-personal-title"
      className="flex flex-col gap-3 border-t p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id="drive-personal-title"
            className="flex flex-wrap items-center gap-2 text-sm font-semibold"
          >
            <HugeiconsIcon
              icon={Key01Icon}
              strokeWidth={2}
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            {m.title}
            <Badge variant="secondary" className="rounded-full text-xs">
              {m.badge}
            </Badge>
          </h2>
          <p className="mt-1 text-[13px] text-pretty text-muted-foreground">
            {m.description}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 pointer-coarse:h-10 max-sm:w-full"
          onClick={() => setAddOpen(true)}
        >
          <HugeiconsIcon
            icon={Add01Icon}
            strokeWidth={2}
            data-icon="inline-start"
            aria-hidden
          />
          {m.add}
        </Button>
      </div>
      {credentials.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{m.empty}</p>
      ) : (
        <ul aria-label={m.listLabel} className="flex flex-col divide-y rounded-xl border">
          {credentials.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 font-medium break-words">{c.name}</span>
                  <DriveStatusBadge status={c.status} />
                </span>
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {c.clientEmail} · {driveUi.ui.keyHint(c.credentialHint)}
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
                  <span>{m.sources(c.sourceCount)}</span>
                  {c.lastCheckedAt && (
                    <RelativeTime value={c.lastCheckedAt} />
                  )}
                  {isAdmin && !c.isMine && (
                    <span className="max-w-full truncate" title={c.owner.email}>
                      {c.owner.name || c.owner.email}
                    </span>
                  )}
                </span>
                {c.status === "error" && c.statusMessage && (
                  <span className="text-[13px] break-words text-destructive">
                    {c.statusMessage}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-coarse:h-10"
                  onClick={() => void test(c)}
                  disabled={testing !== null}
                >
                  {testing === c.id ? (
                    <Spinner aria-hidden />
                  ) : (
                    <HugeiconsIcon
                      icon={Refresh01Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                      aria-hidden
                    />
                  )}
                  {m.test}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive pointer-coarse:h-10"
                  onClick={() => setDeleting(c)}
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  {m.delete}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <AddPersonalCredentialDialog open={addOpen} onOpenChange={setAddOpen} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={m.deleteTitle}
        description={deleting ? m.deleteDescription(deleting.name) : undefined}
        confirmText={deleting?.name}
        confirmLabel={m.deleteConfirm}
        onConfirm={async () => {
          if (!deleting) return false
          const res = await deletePersonalDriveCredentialAction({
            credentialId: deleting.id,
          })
          if (!res.ok) {
            toast.error(res.error)
            return false
          }
          toast.success(res.message ?? driveUi.service.done.personalDeleted)
          setDeleting(null)
          router.refresh()
        }}
      />
    </section>
  )
}
