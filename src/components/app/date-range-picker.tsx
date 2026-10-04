"use client"

import * as React from "react"
import { ArrowDown01Icon, Calendar03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"
import type { DateRange } from "react-day-picker"
import { vi } from "react-day-picker/locale"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"
import { common } from "@/lib/i18n/vi/common"

import {
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  detectDatePreset,
  formatDateRangeLabel,
  isoToLocalDate,
  localDateToIso,
  resolveDatePreset,
  todayIn,
  type DatePreset,
  type DatePresetOrCustom,
  type DateRangeValue,
  type PresetOptions,
} from "./date-range"

export type { DateRangeValue, DatePreset }

export interface DateRangePickerProps {
  value: DateRangeValue | null
  onChange: (value: DateRangeValue, preset: DatePresetOrCustom) => void
  /** presets to offer (default: all) */
  presets?: readonly DatePreset[]
  /** IANA zone deciding "today" (default Asia/Ho_Chi_Minh) */
  timeZone?: string
  /** "7/30 ngày qua" end today (true, e.g. logs) or yesterday (default false, Ads Manager convention) */
  includeToday?: boolean
  /** disallow picking days after today (default true) */
  disableFuture?: boolean
  /** maximum span in days for custom ranges */
  maxDays?: number
  /** accessible label (default "Khoảng thời gian") */
  label?: string
  align?: "start" | "center" | "end"
  className?: string
  disabled?: boolean
}

/** Button + popover with presets (Hôm nay … Tháng trước) and a 2-month range calendar for "Tuỳ chọn". */
export function DateRangePicker({
  value,
  onChange,
  presets = DATE_PRESETS,
  timeZone,
  includeToday,
  disableFuture = true,
  maxDays,
  label = common.dateRange.label,
  align = "start",
  className,
  disabled,
}: DateRangePickerProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = React.useState(false)
  const opts: PresetOptions = { timeZone, includeToday }
  const current = detectDatePreset(value, opts)
  const [draft, setDraft] = React.useState<DateRange | undefined>(undefined)

  const handleOpenChange = (next: boolean) => {
    if (next)
      setDraft(
        value
          ? { from: isoToLocalDate(value.from), to: isoToLocalDate(value.to) }
          : undefined
      )
    setOpen(next)
  }

  const today = isoToLocalDate(todayIn(timeZone))
  const pickPreset = (p: DatePreset) => {
    onChange(resolveDatePreset(p, opts), p)
    setOpen(false)
  }
  const applyCustom = () => {
    if (!draft?.from) return
    const from = localDateToIso(draft.from)
    const to = localDateToIso(draft.to ?? draft.from)
    onChange({ from, to }, detectDatePreset({ from, to }, opts))
    setOpen(false)
  }

  const disabledDays = (date: Date) => {
    if (disableFuture && date > today) return true
    if (maxDays && draft?.from && !draft.to) {
      const diff = Math.abs(date.getTime() - draft.from.getTime()) / 86_400_000
      if (diff >= maxDays) return true
    }
    return false
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          aria-label={`${label}: ${formatDateRangeLabel(value, opts)}`}
          className={cn("justify-start font-normal tabular-nums", className)}
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            strokeWidth={2}
            data-icon="inline-start"
            aria-hidden
          />
          <span className="truncate">{formatDateRangeLabel(value, opts)}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            data-icon="inline-end"
            className="ml-auto"
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        // phones: full width minus a 16px margin on both sides (never flush against the screen edge)
        collisionPadding={16}
        className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] p-0 sm:w-auto"
      >
        <div className="flex flex-col sm:flex-row">
          <div
            role="group"
            aria-label={label}
            className="flex flex-wrap gap-1 border-b p-2 sm:w-40 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0"
          >
            {presets.map((p) => (
              <Button
                key={p}
                aria-pressed={current === p}
                variant="ghost"
                size="sm"
                onClick={() => pickPreset(p)}
                className={cn(
                  "shrink-0 justify-start rounded-xl pointer-coarse:h-10",
                  current === p &&
                    "bg-brand-red/10 font-medium text-brand-ink hover:bg-brand-red/15"
                )}
              >
                {DATE_PRESET_LABELS[p]}
              </Button>
            ))}
            <Button
              aria-pressed={current === "custom"}
              variant="ghost"
              size="sm"
              className={cn(
                "shrink-0 justify-start rounded-xl pointer-coarse:h-10",
                current === "custom" &&
                  "bg-brand-red/10 font-medium text-brand-ink hover:bg-brand-red/15"
              )}
              onClick={() => setDraft(undefined)}
            >
              {DATE_PRESET_LABELS.custom}
            </Button>
          </div>
          <div className="flex flex-col">
            <Calendar
              mode="range"
              locale={vi}
              numberOfMonths={isMobile ? 1 : 2}
              selected={draft}
              onSelect={setDraft}
              defaultMonth={
                draft?.from ??
                (isMobile
                  ? today
                  : new Date(today.getFullYear(), today.getMonth() - 1, 1))
              }
              disabled={disabledDays}
              className="mx-auto bg-transparent [--cell-size:--spacing(10)] sm:mx-0 sm:[--cell-size:--spacing(8)]"
            />
            <div className="flex items-center justify-between gap-2 border-t p-3">
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {draft?.from
                  ? formatDateRangeLabel(
                      {
                        from: localDateToIso(draft.from),
                        to: localDateToIso(draft.to ?? draft.from),
                      },
                      opts
                    )
                  : common.dateRange.placeholder}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  {common.cancel}
                </Button>
                <Button size="sm" disabled={!draft?.from} onClick={applyCustom}>
                  {common.dateRange.apply}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
