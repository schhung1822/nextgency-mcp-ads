"use client"

// Small form pieces shared by the three prompt builders (/tips/*): number fields that read Vietnamese formats
// (src/lib/vi-amount.ts) and say what they understood, the currency field and the connector-name field.
// Invalid input is never replaced by a default: the field shows how to fix it and the builder blocks copying.
import * as React from "react"

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { tips as t } from "@/lib/i18n/vi/tips"
import {
  checkViNumber,
  type ViNumberResult,
  type ViNumberRule,
} from "@/lib/vi-amount"

const s = t.shared

/** Vietnamese message of an invalid number (null when valid). */
export function numberMessage(
  r: ViNumberResult,
  rule: ViNumberRule
): string | null {
  if (r.ok) return null
  switch (r.error) {
    case "empty":
      return s.numbers.empty
    case "format":
      return s.numbers.format
    case "integer":
      return rule.min !== undefined && rule.max !== undefined
        ? s.numbers.range(rule.min, rule.max)
        : s.numbers.format
    case "min":
      if (rule.integer && rule.max !== undefined && rule.min !== undefined)
        return s.numbers.range(rule.min, rule.max)
      return rule.minExclusive ? s.numbers.positive : s.numbers.notNegative
    case "max":
      if (rule.integer && rule.min !== undefined && rule.max !== undefined)
        return s.numbers.range(rule.min, rule.max)
      return s.numbers.max(String(rule.max ?? ""))
  }
}

/** checkViNumber + its message, memoised per raw value. */
export function useViNumber(raw: string, rule: ViNumberRule) {
  const { min, max, minExclusive, integer } = rule
  return React.useMemo(() => {
    const r = checkViNumber(raw, { min, max, minExclusive, integer })
    return {
      value: r.ok ? r.value : null,
      error: numberMessage(r, { min, max, minExclusive, integer }),
    }
  }, [raw, min, max, minExclusive, integer])
}

export function isCurrencyCode(raw: string): boolean {
  return /^[A-Za-z]{3}$/.test(raw.trim())
}

/** Text input for a number: help line, "= 200.000 ₫" once understood, or the error with how to fix it. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  error,
  understood,
  help,
  integer,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  error: string | null
  /** formatted value shown as "= …" when valid (omit for plain counts) */
  understood?: string | null
  help?: string
  integer?: boolean
}) {
  const helpId = `${id}-help`
  const msgId = `${id}-msg`
  return (
    <Field data-invalid={error ? true : undefined} className="gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[help ? helpId : null, msgId].filter(Boolean).join(" ")}
        className="tabular-nums"
      />
      <div id={msgId} aria-live="polite">
        {error ? (
          <FieldError>{error}</FieldError>
        ) : understood ? (
          <p className="text-[13px] font-medium text-brand-ink tabular-nums">
            {s.numbers.understood(understood)}
          </p>
        ) : null}
      </div>
      {help && <FieldDescription id={helpId}>{help}</FieldDescription>}
    </Field>
  )
}

/** 3-letter currency code (upper-cased while typing). */
export function CurrencyField({
  id,
  label,
  value,
  onChange,
  help,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  help?: string
}) {
  const invalid = !isCurrencyCode(value)
  const msgId = `${id}-msg`
  return (
    <Field data-invalid={invalid || undefined} className="gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        maxLength={3}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        aria-invalid={invalid || undefined}
        aria-describedby={msgId}
        className="uppercase"
      />
      <div id={msgId} aria-live="polite">
        {invalid && <FieldError>{s.currencyError}</FieldError>}
      </div>
      {help && <FieldDescription>{help}</FieldDescription>}
    </Field>
  )
}

/** "Tên connector / MCP bạn đã đặt" (empty = "Ads MCP"). */
export function ConnectorField({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id}>{s.connectorLabel}</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        maxLength={100}
        placeholder={s.connectorPlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldDescription>{s.connectorHelp}</FieldDescription>
    </Field>
  )
}
