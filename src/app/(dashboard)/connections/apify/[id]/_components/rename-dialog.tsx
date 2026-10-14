"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
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
import { apify as a } from "@/lib/i18n/vi/apify"
import { APIFY_LIMITS, renameApifyTokenSchema } from "@/lib/schemas/apify"
import { renameApifyTokenAction } from "@/server/actions/apify"

const nameOnlySchema = renameApifyTokenSchema.pick({ name: true })

/** "Đổi tên": only the display name (the token itself is untouched). */
export function RenameApifyTokenDialog({
  open,
  onOpenChange,
  tokenId,
  currentName,
  onRenamed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tokenId: string
  currentName: string
  onRenamed: () => void
}) {
  const form = useForm<{ name: string }>({
    resolver: zodResolver(nameOnlySchema),
    values: { name: currentName },
    mode: "onTouched",
  })
  const submitting = form.formState.isSubmitting

  const onSubmit = form.handleSubmit(async ({ name }) => {
    if (name.trim() === currentName) {
      onOpenChange(false)
      return
    }
    const res = await renameApifyTokenAction({ id: tokenId, name })
    if (!res.ok) {
      form.setError("name", { message: res.fieldErrors?.name ?? res.error })
      return
    }
    toast.success(res.message ?? a.server.renamed)
    onOpenChange(false)
    onRenamed()
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting) return
        if (!o) form.reset({ name: currentName })
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{a.rename.title}</DialogTitle>
            <DialogDescription>{a.rename.description}</DialogDescription>
          </DialogHeader>
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="apify-rename">{a.rename.label}</FieldLabel>
                <Input
                  id="apify-rename"
                  {...field}
                  autoComplete="off"
                  maxLength={APIFY_LIMITS.nameMax}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {common.cancel}
            </Button>
            <Button type="submit" variant="brand" disabled={submitting}>
              {submitting && <Spinner aria-hidden />}
              {a.rename.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
