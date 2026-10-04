"use client"

import * as React from "react"
import {
  Add01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { common } from "@/lib/i18n/vi/common"

export interface FilterOption {
  value: string
  label: string
  icon?: React.ReactNode
  /** optional count shown on the right */
  count?: number
}

export interface FilterDef {
  id: string
  label: string
  options: FilterOption[]
  /** allow several values (default true); false = pick one */
  multiple?: boolean
}

export type FilterValues = Record<string, string[]>

export interface FilterBarProps {
  /** search box; omit to hide */
  search?: {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    /** debounce in ms before onChange fires (default 300) */
    debounceMs?: number
    label?: string
    /** input name (default "q") */
    name?: string
  }
  filters?: FilterDef[]
  values?: FilterValues
  onValuesChange?: (values: FilterValues) => void
  /** extra controls after the pills (e.g. DateRangePicker, Select sort) */
  children?: React.ReactNode
  /** right-aligned slot (e.g. export button) */
  end?: React.ReactNode
  className?: string
}

/** IndexFilters-style bar: search input + filter pills (Popover + checkboxes) + right slot. */
export function FilterBar({
  search,
  filters,
  values = {},
  onValuesChange,
  children,
  end,
  className,
}: FilterBarProps) {
  const activeCount = Object.values(values).filter(
    (v) => v && v.length > 0
  ).length
  return (
    <div
      className={cn(
        "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {search && <DebouncedSearch {...search} />}
        {/* phones: the pills form ONE swipeable row (a wrapped stack of 6+ pills pushes the data off
            screen); md+: `contents` puts them back into the wrapping flow next to the search box */}
        <div
          role="group"
          aria-label={common.filter.groupLabel}
          className="-my-1 flex w-full items-center gap-2 overflow-x-auto py-1 [scrollbar-width:none] md:contents [&::-webkit-scrollbar]:hidden"
        >
          {filters?.map((f) => (
            <FilterPill
              key={f.id}
              def={f}
              selected={values[f.id] ?? []}
              onChange={(next) => onValuesChange?.({ ...values, [f.id]: next })}
            />
          ))}
          {activeCount > 0 && onValuesChange && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onValuesChange({})}
              className="shrink-0 text-muted-foreground md:order-last"
            >
              {common.filter.clearAll}
            </Button>
          )}
        </div>
        {children}
      </div>
      {end && <div className="flex shrink-0 items-center gap-2">{end}</div>}
    </div>
  )
}

function DebouncedSearch({
  value,
  onChange,
  placeholder = common.filter.search,
  debounceMs = 300,
  label = common.filter.search,
  name = "q",
}: NonNullable<FilterBarProps["search"]>) {
  const [text, setText] = React.useState(value)
  const [lastExternal, setLastExternal] = React.useState(value)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  // Sync when the parent resets the value (adjust-state-during-render pattern).
  if (value !== lastExternal) {
    setLastExternal(value)
    setText(value)
  }
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const emit = (next: string, immediate = false) => {
    clearTimeout(timer.current)
    if (immediate || debounceMs <= 0) onChange(next)
    else timer.current = setTimeout(() => onChange(next), debounceMs)
  }
  return (
    <InputGroup className="w-full bg-card md:w-72">
      <InputGroupAddon>
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        // our own clear button replaces the browser's native one (otherwise two ✕ show in Chromium/Safari)
        className="[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none"
        name={name}
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value)
          emit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") emit(text, true)
        }}
      />
      {text && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={common.filter.clear}
            onClick={() => {
              setText("")
              emit("", true)
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}

function FilterPill({
  def,
  selected,
  onChange,
}: {
  def: FilterDef
  selected: string[]
  onChange: (values: string[]) => void
}) {
  const multiple = def.multiple ?? true
  const active = selected.length > 0
  const summary = !active
    ? null
    : selected.length === 1
      ? (def.options.find((o) => o.value === selected[0])?.label ?? selected[0])
      : common.filter.selectedCount(selected.length)
  const toggle = (v: string, checked: boolean) => {
    if (!multiple) return onChange(checked ? [v] : [])
    onChange(checked ? [...selected, v] : selected.filter((s) => s !== v))
  }
  return (
    <div className="flex shrink-0 items-center">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "rounded-full pointer-coarse:h-10",
              !active && "border-dashed bg-transparent",
              active &&
                "border-brand-red/30 bg-brand-red/8 pr-8 text-foreground"
            )}
          >
            {!active && (
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
            )}
            <span className={cn(active && "text-muted-foreground")}>
              {def.label}
            </span>
            {active && (
              <span className="max-w-40 truncate font-medium">{summary}</span>
            )}
            {!active && (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                data-icon="inline-end"
                aria-hidden
              />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 gap-1 p-1.5">
          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
            {def.label}
          </p>
          {def.options.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {common.filter.noOptions}
            </p>
          )}
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {def.options.map((o) => {
              const checked = selected.includes(o.value)
              const id = `filter-${def.id}-${o.value}`
              return (
                <li key={o.value}>
                  <label
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(v) => toggle(o.value, v === true)}
                    />
                    {o.icon}
                    <span className="flex-1 truncate">{o.label}</span>
                    {o.count !== undefined && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {o.count}
                      </span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
          {active && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 justify-start"
              onClick={() => onChange([])}
            >
              {common.filter.clear}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {active && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={common.filter.removeFilter(def.label)}
          onClick={() => onChange([])}
          className="-ml-7 rounded-full text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
        </Button>
      )}
    </div>
  )
}
