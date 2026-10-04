"use client"

import * as React from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { common } from "@/lib/i18n/vi/common"
import { connections as m } from "@/lib/i18n/vi/connections"
import { renameConnectionAction } from "@/server/actions/connections"

export function RenameDialog({
  open,
  onOpenChange,
  connectionId,
  currentName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  currentName: string
}) {
  const form = useForm<{ name: string }>({ values: { name: currentName } })
  const error = form.formState.errors.name

  const onSubmit = form.handleSubmit(async ({ name }) => {
    const res = await renameConnectionAction({ connectionId, name })
    if (!res.ok) {
      form.setError("name", { message: res.fieldErrors?.name ?? res.error })
      return
    }
    toast.success(res.message ?? m.rename.done)
    onOpenChange(false)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{m.rename.title}</DialogTitle>
            <DialogDescription>{m.rename.description}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!error || undefined}>
            <FieldLabel htmlFor="rename-connection">{m.new.nameLabel}</FieldLabel>
            <Input
              id="rename-connection"
              autoComplete="off"
              aria-invalid={!!error || undefined}
              {...form.register("name", {
                validate: (v) =>
                  v.trim() === "" ? m.errors.nameRequired : v.trim().length > 100 ? m.errors.nameTooLong : true,
              })}
            />
            <FieldError errors={[error]} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {common.cancel}
            </Button>
            <Button type="submit" variant="brand" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner aria-hidden />}
              {m.rename.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
