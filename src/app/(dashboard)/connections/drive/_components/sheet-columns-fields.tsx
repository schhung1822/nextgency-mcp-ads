"use client"

// Sheet column mapping (wizard step 3 + "Sửa cài đặt"): each logical column → a header cell of the sheet.
// With the header row known the user picks from it; otherwise (sheet unreadable right now) free text inputs.
// Layout: the columns AI reads (Link Drive required) → the write-back switch (slot) → a collapsible
// "Cột ghi trạng thái (nâng cao)" with the system-written columns, opened while write-back is on.
import * as React from "react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldDescription,
  FieldError,
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
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  normalizeHeader,
  SHEET_COLUMN_KEYS,
  SHEET_WRITABLE_COLUMN_KEYS,
  type SheetColumnKey,
} from "@/lib/schemas/drive"

const w = driveUi.wizard
const NONE = "__none__"

export type SheetColumnsValue = Record<SheetColumnKey, string | null>

/** Link Drive, Tên creative, Nền tảng, TKQC, Nội dung, Tiêu đề, Link đích */
const READ_KEYS = SHEET_COLUMN_KEYS.filter(
  (k) => !SHEET_WRITABLE_COLUMN_KEYS.includes(k)
)

/** System-written columns in the order of the recommended sheet template (tips/bulk-ads); every one but Trạng thái
 *  has a "Tuỳ chọn. …" help line. */
const WRITE_KEYS: readonly SheetColumnKey[] = [
  "status",
  "mediaId",
  "adIds",
  "postLink",
  "campaignLink",
  "note",
  "updatedAt",
]

/** Unique, non-empty header cells (first spelling wins), in sheet order. */
function headerOptions(header: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of header) {
    const v = String(raw ?? "").trim()
    const key = normalizeHeader(v)
    if (!v || seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

export function SheetColumnsFields({
  idPrefix,
  header,
  value,
  onChange,
  writeback,
  writebackControl,
  errors,
  disabled,
}: {
  idPrefix: string
  /** header row of the sheet; null = unknown (free text) */
  header: readonly string[] | null
  value: SheetColumnsValue
  onChange: (key: SheetColumnKey, v: string | null) => void
  /** write-back on: the status column becomes required and the advanced group stays open */
  writeback: boolean
  /** the "Cho phép AI ghi trạng thái" switch, rendered between the read columns and the advanced group */
  writebackControl?: React.ReactNode
  /** server field errors keyed "columns.<key>" or "<key>" */
  errors?: Record<string, string | undefined>
  disabled?: boolean
}) {
  const options = React.useMemo(
    () => (header ? headerOptions(header) : null),
    [header]
  )
  const writeErrors = SHEET_WRITABLE_COLUMN_KEYS.some(
    (k) => !!(errors?.[`columns.${k}`] ?? errors?.[k])
  )
  // open while write-back is on (or a write column has an error); otherwise the user's choice
  const [manualOpen, setManualOpen] = React.useState(false)
  const forcedOpen = writeback || writeErrors
  const open = forcedOpen || manualOpen

  const row = (k: SheetColumnKey) => {
    const id = `${idPrefix}-col-${k}`
    const label = w.columns[k] ?? k
    const help = w.columnHelp[k]
    const helpId = help ? `${id}-help` : undefined
    const required = k === "link" || (k === "status" && writeback)
    const err = errors?.[`columns.${k}`] ?? errors?.[k]
    const current = value[k]
    // a configured column that is not in the header any more stays selectable (shown as is)
    const opts =
      options && current && !options.some((o) => o === current)
        ? [current, ...options]
        : options
    return (
      <Field key={k} data-invalid={err ? true : undefined} className="gap-1.5">
        <FieldLabel htmlFor={id} className="flex flex-wrap items-center gap-1.5">
          {label}
          {required && (
            <Badge variant="secondary" className="rounded-full text-xs">
              {w.required}
            </Badge>
          )}
        </FieldLabel>
        {opts ? (
          <Select
            value={current ?? NONE}
            onValueChange={(v) => onChange(k, v === NONE ? null : v)}
            disabled={disabled}
          >
            <SelectTrigger
              id={id}
              className="w-full"
              aria-label={w.columnSelectLabel(label)}
              aria-describedby={helpId}
              aria-invalid={err ? true : undefined}
            >
              <SelectValue placeholder={w.notUsed} />
            </SelectTrigger>
            <SelectContent>
              {k !== "link" && <SelectItem value={NONE}>{w.notUsed}</SelectItem>}
              {opts.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={id}
            value={current ?? ""}
            onChange={(e) => onChange(k, e.target.value || null)}
            placeholder={w.columnPlaceholder}
            maxLength={100}
            disabled={disabled}
            autoComplete="off"
            aria-describedby={helpId}
            aria-invalid={err ? true : undefined}
          />
        )}
        {help && <FieldDescription id={helpId}>{help}</FieldDescription>}
        {err && <FieldError>{err}</FieldError>}
      </Field>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-[13px] font-medium text-muted-foreground">
          {w.columnsReadGroup}
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">{READ_KEYS.map(row)}</div>
      </fieldset>
      {writebackControl && <div className="border-t pt-5">{writebackControl}</div>}
      <Collapsible
        open={open}
        onOpenChange={setManualOpen}
        disabled={forcedOpen}
        className="rounded-2xl border"
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span>{w.columnsAdvanced}</span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                open && "rotate-180",
                forcedOpen && "opacity-40"
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-4 border-t px-4 pt-3 pb-4">
            <p className="text-[13px] text-pretty text-muted-foreground">
              {w.columnsAdvancedHint}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {WRITE_KEYS.map(row)}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
