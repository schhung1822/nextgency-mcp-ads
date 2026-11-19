"use client"

import * as React from "react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { CodeSnippet } from "@/components/mcp/client-setup-guide"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AD_CHECK_FREQUENCIES,
  AD_CHECK_MATCHES,
  AD_CHECK_PERIODS,
  AD_CHECK_POS,
  AD_CHECK_SKILL_NAME,
  buildAdCheckPrompt,
  buildAdCheckSkillMd,
  buildAdCheckSkillPrompt,
  buildScheduleRequest,
  DEFAULT_AD_CHECK,
  scheduleLabel,
  type AdCheckFrequency,
  type AdCheckInput,
  type AdCheckMatch,
  type AdCheckPeriod,
  type AdCheckPos,
  type AdCheckTarget,
} from "@/lib/ad-check-prompt"
import { formatMoney, formatNumber } from "@/lib/format"
import { tips as t } from "@/lib/i18n/vi/tips"

import {
  ConnectorField,
  CurrencyField,
  isCurrencyCode,
  NumberField,
  useViNumber,
} from "../../_components/form-bits"
import { PromptOutputs, WRAP } from "../../_components/prompt-outputs"

const b = t.adCheck.builder
const s = t.shared
const TARGETS: AdCheckTarget[] = ["roas", "cpa"]
const DEFAULT_CPA = 80000
const ROAS_RULE = { min: 0, minExclusive: true, max: 1000 } as const
const CPA_RULE = { min: 0, minExclusive: true } as const
const MIN_SPEND_RULE = { min: 0 } as const
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Form → live prompt / SKILL.md of the scheduled "ads vs real orders" report delivered to Telegram.
 * "Cơ bản" holds what everyone sets; "Nâng cao" (collapsed, opened when one of its fields has an error) the rest.
 */
export function AdCheckBuilder() {
  const id = React.useId()
  const [connector, setConnector] = React.useState("")
  const [period, setPeriod] = React.useState<AdCheckPeriod>(
    DEFAULT_AD_CHECK.period
  )
  const [accounts, setAccounts] = React.useState("")
  const [target, setTarget] = React.useState<AdCheckTarget>(
    DEFAULT_AD_CHECK.target
  )
  const [roas, setRoas] = React.useState(String(DEFAULT_AD_CHECK.targetValue))
  const [cpa, setCpa] = React.useState(String(DEFAULT_CPA))
  const [currency, setCurrency] = React.useState(DEFAULT_AD_CHECK.currency)
  const [minSpend, setMinSpend] = React.useState(
    String(DEFAULT_AD_CHECK.minSpend)
  )
  const [match, setMatch] = React.useState<AdCheckMatch>(DEFAULT_AD_CHECK.match)
  const [pos, setPos] = React.useState<AdCheckPos>(DEFAULT_AD_CHECK.pos)
  const [frequency, setFrequency] = React.useState<AdCheckFrequency>(
    DEFAULT_AD_CHECK.frequency
  )
  const [time, setTime] = React.useState(DEFAULT_AD_CHECK.time)
  const [channel, setChannel] = React.useState("")
  const [advancedOpen, setAdvancedOpen] = React.useState(false)

  const roasN = useViNumber(roas, ROAS_RULE)
  const cpaN = useViNumber(cpa, CPA_RULE)
  const minSpendN = useViNumber(minSpend, MIN_SPEND_RULE)
  const targetN = target === "roas" ? roasN : cpaN
  const currencyOk = isCurrencyCode(currency)
  const cur = currencyOk ? currency.trim().toUpperCase() : DEFAULT_AD_CHECK.currency
  const timeOk = frequency !== "daily" || TIME_RE.test(time)
  const advancedError = !!minSpendN.error
  const hasErrors =
    !!targetN.error || !currencyOk || !timeOk || advancedError
  const blockedReason = hasErrors ? s.copyBlocked : null
  // an error inside "Nâng cao" keeps it open so the message is visible
  const showAdvanced = advancedOpen || advancedError

  const input: AdCheckInput = {
    connectorName: connector,
    period,
    accounts,
    target,
    targetValue:
      targetN.value ?? (target === "roas" ? DEFAULT_AD_CHECK.targetValue : DEFAULT_CPA),
    currency: cur,
    minSpend: minSpendN.value ?? DEFAULT_AD_CHECK.minSpend,
    match,
    pos,
    frequency,
    time,
    telegramChannel: channel,
  }
  const targetLabel =
    target === "roas"
      ? `ROAS ≥ ${formatNumber(input.targetValue)}`
      : `${b.targets.cpa.title.toLowerCase()} ${formatMoney(input.targetValue, cur)}`

  const selectField = <V extends string>(
    key: string,
    label: string,
    value: V,
    onChange: (v: V) => void,
    options: readonly V[],
    names: Record<V, string>,
    help?: string
  ) => (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
      <Select value={value} onValueChange={(v) => onChange(v as V)}>
        <SelectTrigger id={`${id}-${key}`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {names[o]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help && <FieldDescription>{help}</FieldDescription>}
    </Field>
  )

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup className="gap-6">
        <FieldSet className="gap-5">
          <FieldLegend variant="label">{s.basicGroup}</FieldLegend>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <ConnectorField
              id={`${id}-connector`}
              value={connector}
              onChange={setConnector}
            />
            {selectField(
              "pos",
              b.posLabel,
              pos,
              setPos,
              AD_CHECK_POS,
              b.pos,
              b.posHelp
            )}
            {selectField(
              "period",
              b.periodLabel,
              period,
              setPeriod,
              AD_CHECK_PERIODS,
              b.periods,
              b.periodHelp
            )}
            <CurrencyField
              id={`${id}-currency`}
              label={b.currencyLabel}
              value={currency}
              onChange={setCurrency}
              help={b.currencyHelp}
            />
          </div>

          <Field>
            <FieldLabel id={`${id}-target-label`}>{b.targetLabel}</FieldLabel>
            <RadioGroup
              value={target}
              onValueChange={(v) => setTarget(v === "cpa" ? "cpa" : "roas")}
              aria-labelledby={`${id}-target-label`}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {TARGETS.map((tg) => (
                <label
                  key={tg}
                  htmlFor={`${id}-${tg}`}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-2xl border bg-input/20 p-3.5 transition-colors",
                    "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                    "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-primary/5"
                  )}
                >
                  <RadioGroupItem
                    value={tg}
                    id={`${id}-${tg}`}
                    aria-label={b.targets[tg].title}
                    className="mt-0.5"
                  />
                  <span className="grid content-start gap-0.5">
                    <span className="text-sm leading-5 font-medium">
                      {b.targets[tg].title}
                    </span>
                    <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                      {b.targets[tg].hint}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </Field>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {target === "roas" ? (
              <NumberField
                id={`${id}-roas-value`}
                label={b.roasValueLabel}
                value={roas}
                onChange={setRoas}
                error={roasN.error}
                understood={
                  roasN.value !== null ? `ROAS ${formatNumber(roasN.value)}` : null
                }
                help={b.roasValueHelp}
              />
            ) : (
              <NumberField
                id={`${id}-cpa-value`}
                label={b.cpaValueLabel}
                value={cpa}
                onChange={setCpa}
                error={cpaN.error}
                understood={
                  cpaN.value !== null && currencyOk
                    ? formatMoney(cpaN.value, cur)
                    : null
                }
                help={b.cpaValueHelp}
              />
            )}
            {selectField(
              "frequency",
              b.frequencyLabel,
              frequency,
              setFrequency,
              AD_CHECK_FREQUENCIES,
              b.frequencies
            )}
            {frequency === "daily" && (
              <Field data-invalid={!timeOk || undefined} className="gap-1.5">
                <FieldLabel htmlFor={`${id}-time`}>{b.timeLabel}</FieldLabel>
                <Input
                  id={`${id}-time`}
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  aria-invalid={!timeOk || undefined}
                  className="tabular-nums"
                />
                {!timeOk && <FieldError>{s.timeError}</FieldError>}
                <FieldDescription>{b.timeHelp}</FieldDescription>
              </Field>
            )}
          </div>
        </FieldSet>

        <Collapsible
          open={showAdvanced}
          onOpenChange={setAdvancedOpen}
          className="rounded-2xl border"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{s.advancedGroup}</span>
                <span className="text-[13px] text-muted-foreground">
                  {s.advancedHint}
                </span>
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                  showAdvanced && "rotate-180"
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid grid-cols-1 gap-5 border-t px-4 pt-4 pb-4 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-accounts`}>
                  {b.accountsLabel}
                </FieldLabel>
                <Input
                  id={`${id}-accounts`}
                  autoComplete="off"
                  maxLength={500}
                  placeholder={b.accountsPlaceholder}
                  value={accounts}
                  onChange={(e) => setAccounts(e.target.value)}
                />
                <FieldDescription>{b.accountsHelp}</FieldDescription>
              </Field>
              <NumberField
                id={`${id}-min`}
                label={b.minSpendLabel}
                value={minSpend}
                onChange={setMinSpend}
                error={minSpendN.error}
                understood={
                  minSpendN.value !== null && currencyOk
                    ? formatMoney(minSpendN.value, cur)
                    : null
                }
                help={b.minSpendHelp}
              />
              {selectField(
                "match",
                b.matchLabel,
                match,
                setMatch,
                AD_CHECK_MATCHES,
                b.matches,
                b.matchHelp
              )}
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-telegram`}>
                  {b.telegramLabel}
                </FieldLabel>
                <Input
                  id={`${id}-telegram`}
                  autoComplete="off"
                  maxLength={100}
                  placeholder={b.telegramPlaceholder}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                />
                <FieldDescription>{b.telegramHelp}</FieldDescription>
              </Field>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <p
          aria-live="polite"
          className={cn(
            "rounded-xl px-3 py-2.5 text-[13px] text-pretty",
            hasErrors ? "bg-destructive/8 text-destructive" : "bg-muted/60"
          )}
        >
          {hasErrors
            ? s.previewBlocked
            : b.preview(targetLabel, scheduleLabel(input))}
        </p>
      </FieldGroup>

      <PromptOutputs
        prompt={buildAdCheckPrompt(input)}
        promptHelp={b.promptHelp}
        promptLabel={b.promptLabel}
        skillName={AD_CHECK_SKILL_NAME}
        skillMd={buildAdCheckSkillMd(input)}
        skillPrompt={buildAdCheckSkillPrompt(input)}
        blockedReason={blockedReason}
        extra={
          <div className="flex flex-col gap-1.5 pt-1">
            <p className="text-sm font-medium">{b.scheduleTitle}</p>
            <p className="text-[13px] text-pretty text-muted-foreground">
              {b.scheduleHelp}
            </p>
            <CodeSnippet
              className={WRAP}
              code={buildScheduleRequest(input)}
              label={b.scheduleLabel}
              collapsible
              copyLabel={s.copySchedule}
              disabledReason={blockedReason}
            />
          </div>
        }
      />
    </div>
  )
}
