"use client"

// "Sửa cài đặt": name; folder: sub-folder depth; sheet: header row, column mapping, write-back.
// Only what changed is sent; sheet changes are validated by the service against the live header row.
// Mounted only while open (the caller renders it conditionally), so every opening starts from the saved values.
import * as React from "react"
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { common } from "@/lib/i18n/vi/common"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  DRIVE_FORM_LIMITS,
  SHEET_COLUMN_KEYS,
  type DriveSourceDetail,
} from "@/lib/schemas/drive"
import { updateDriveSourceAction } from "@/server/actions/drive"

import {
  SheetColumnsFields,
  type SheetColumnsValue,
} from "../../_components/sheet-columns-fields"

const m = driveUi.detail
const w = driveUi.wizard

export function EditSourceDialog({
  open,
  onOpenChange,
  detail,
  sheetHeader,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: DriveSourceDetail
  /** header row read by the sheet preview (null = unknown → free text column names) */
  sheetHeader: string[] | null
  onSaved: () => void
}) {
  const initialColumns = React.useMemo<SheetColumnsValue>(
    () =>
      Object.fromEntries(
        SHEET_COLUMN_KEYS.map((k) => [k, detail.sheet?.columns[k] ?? null])
      ) as SheetColumnsValue,
    [detail.sheet]
  )
  const [name, setName] = React.useState(detail.name)
  const [depth, setDepth] = React.useState(detail.folder?.recursiveDepth ?? 0)
  const [headerRow, setHeaderRow] = React.useState(
    String(detail.sheet?.headerRow ?? 1)
  )
  const [columns, setColumns] = React.useState<SheetColumnsValue>(initialColumns)
  const [writeback, setWriteback] = React.useState(!!detail.sheet?.writeback)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const headerRowNum = Number(headerRow)
  // the header read by the preview belongs to the saved header row only
  const header =
    detail.sheet && headerRowNum === detail.sheet.headerRow ? sheetHeader : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setError(null)
    const patch: Record<string, unknown> = {}
    if (name.trim() !== detail.name) patch.name = name.trim()
    if (detail.folder && depth !== detail.folder.recursiveDepth)
      patch.recursiveDepth = depth
    if (detail.sheet) {
      if (headerRowNum !== detail.sheet.headerRow) patch.headerRow = headerRowNum
      if (
        SHEET_COLUMN_KEYS.some((k) => (columns[k] ?? null) !== initialColumns[k])
      )
        patch.columns = columns
      if (writeback !== detail.sheet.writeback) patch.writeback = writeback
    }
    if (Object.keys(patch).length === 0) {
      onOpenChange(false)
      return
    }
    if (detail.sheet && writeback && !columns.status) {
      setErrors({ "columns.status": driveUi.service.writebackNeedsStatusColumn })
      return
    }
    setSaving(true)
    const res = await updateDriveSourceAction({ sourceId: detail.id, ...patch })
    setSaving(false)
    if (!res.ok) {
      const fe = res.fieldErrors ?? {}
      setErrors(fe)
      if (Object.keys(fe).length === 0) setError(res.error)
      return
    }
    toast.success(res.message ?? driveUi.service.done.sourceUpdated)
    onOpenChange(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className={detail.sheet ? "sm:max-w-2xl" : "sm:max-w-lg"}>
        <form onSubmit={submit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{m.editTitle}</DialogTitle>
            <DialogDescription>{m.editDescription}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="drive-edit-name">{w.nameLabel}</FieldLabel>
              <Input
                id="drive-edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={DRIVE_FORM_LIMITS.nameMax}
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
              />
              {errors.name && <FieldError>{errors.name}</FieldError>}
            </Field>
            {detail.folder && (
              <Field data-invalid={errors.recursiveDepth ? true : undefined}>
                <FieldLabel htmlFor="drive-edit-depth">{w.depthLabel}</FieldLabel>
                <Select
                  value={String(depth)}
                  onValueChange={(v) => setDepth(Number(v))}
                >
                  <SelectTrigger id="drive-edit-depth" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {w.depthOptions.map((label, i) => (
                      <SelectItem key={label} value={String(i)}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{w.depthHelp}</FieldDescription>
                {errors.recursiveDepth && (
                  <FieldError>{errors.recursiveDepth}</FieldError>
                )}
              </Field>
            )}
            {detail.sheet && (
              <>
                <Field data-invalid={errors.headerRow ? true : undefined}>
                  <FieldLabel htmlFor="drive-edit-header">
                    {w.headerRowLabel}
                  </FieldLabel>
                  <Input
                    id="drive-edit-header"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={DRIVE_FORM_LIMITS.headerRowMax}
                    value={headerRow}
                    onChange={(e) => setHeaderRow(e.target.value)}
                    className="w-28 tabular-nums"
                    aria-invalid={errors.headerRow ? true : undefined}
                  />
                  <FieldDescription>{w.headerRowHelp}</FieldDescription>
                  {errors.headerRow && <FieldError>{errors.headerRow}</FieldError>}
                </Field>
                <div className="flex flex-col gap-3 border-t pt-5">
                  <div>
                    <h3 className="text-sm font-semibold">{w.columnsTitle}</h3>
                    {!header && (
                      <p className="text-[13px] text-muted-foreground">
                        {m.editHeaderUnknown}
                      </p>
                    )}
                  </div>
                  <SheetColumnsFields
                    idPrefix="drive-edit"
                    header={header}
                    value={columns}
                    onChange={(k, v) => setColumns((c) => ({ ...c, [k]: v }))}
                    writeback={writeback}
                    errors={errors}
                    disabled={saving}
                    writebackControl={
                      <Field
                        orientation="horizontal"
                        data-invalid={errors.writeback ? true : undefined}
                      >
                        <FieldContent>
                          <FieldLabel htmlFor="drive-edit-writeback">
                            {w.writebackLabel}
                          </FieldLabel>
                          <FieldDescription>{w.writebackHelp}</FieldDescription>
                          {errors.writeback && (
                            <FieldError>{errors.writeback}</FieldError>
                          )}
                        </FieldContent>
                        <Switch
                          id="drive-edit-writeback"
                          checked={writeback}
                          onCheckedChange={setWriteback}
                          disabled={saving}
                        />
                      </Field>
                    }
                  />
                </div>
              </>
            )}
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
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {common.cancel}
            </Button>
            <Button type="submit" variant="brand" disabled={saving}>
              {saving && <Spinner aria-hidden />}
              {saving ? m.editSaving : m.editSave}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
