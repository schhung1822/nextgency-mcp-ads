"use client"

import * as React from "react"
import { cn } from "cn"

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AUTOMATION_WINDOWS,
  buildSchedulePrompt,
  buildSkillMd,
  buildSkillPrompt,
  DEFAULT_CPA_RULE,
  SKILL_NAME,
  type AutomationMode,
  type AutomationWindow,
  type CpaRuleInput,
} from "@/lib/automation-prompt"
import { formatMoney } from "@/lib/format"
import { automation as t } from "@/lib/i18n/vi/automation"
import { tips } from "@/lib/i18n/vi/tips"

import {
  ConnectorField,
  CurrencyField,
  isCurrencyCode,
  NumberField,
  useViNumber,
} from "../../_components/form-bits"
import { PromptOutputs } from "../../_components/prompt-outputs"

const b = t.builder
const s = tips.shared
const MODES: AutomationMode[] = ["report", "pause"]
const CPA_RULE = { min: 0, minExclusive: true } as const
const MIN_SPEND_RULE = { min: 0 } as const
const PER_RUN_RULE = { min: 1, max: 50, integer: true } as const

/** Inputs of the CPA rule + live copy-paste texts (full prompt / Claude skill + the short prompt calling it). */
export function RuleBuilder() {
  const id = React.useId()
  const [connector, setConnector] = React.useState("")
  const [mode, setMode] = React.useState<AutomationMode>(DEFAULT_CPA_RULE.mode)
  const [cpa, setCpa] = React.useState(String(DEFAULT_CPA_RULE.cpaMax))
  const [currency, setCurrency] = React.useState(DEFAULT_CPA_RULE.currency)
  const [minSpend, setMinSpend] = React.useState(
    String(DEFAULT_CPA_RULE.minSpend)
  )
  const [dateWindow, setDateWindow] = React.useState<AutomationWindow>(
    DEFAULT_CPA_RULE.window
  )
  const [perRun, setPerRun] = React.useState(String(DEFAULT_CPA_RULE.maxPerRun))

  const cpaN = useViNumber(cpa, CPA_RULE)
  const minSpendN = useViNumber(minSpend, MIN_SPEND_RULE)
  const perRunN = useViNumber(perRun, PER_RUN_RULE)
  const currencyOk = isCurrencyCode(currency)
  const cur = currencyOk ? currency.trim().toUpperCase() : DEFAULT_CPA_RULE.currency
  const hasErrors =
    !!cpaN.error ||
    !!minSpendN.error ||
    !currencyOk ||
    (mode === "pause" && !!perRunN.error)
  const blockedReason = hasErrors ? s.copyBlocked : null

  const rule: CpaRuleInput = {
    connectorName: connector,
    mode,
    cpaMax: cpaN.value ?? DEFAULT_CPA_RULE.cpaMax,
    currency: cur,
    minSpend: minSpendN.value ?? DEFAULT_CPA_RULE.minSpend,
    window: dateWindow,
    maxPerRun: perRunN.value ?? DEFAULT_CPA_RULE.maxPerRun,
  }
  const money = (v: number | null) =>
    v !== null && currencyOk ? formatMoney(v, cur) : null

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel id={`${id}-mode-label`}>{b.modeLabel}</FieldLabel>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v === "pause" ? "pause" : "report")}
            aria-labelledby={`${id}-mode-label`}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {MODES.map((m) => (
              <label
                key={m}
                htmlFor={`${id}-${m}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-2xl border bg-input/20 p-3.5 transition-colors",
                  "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                  "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-primary/5"
                )}
              >
                <RadioGroupItem
                  value={m}
                  id={`${id}-${m}`}
                  aria-label={b.modes[m].title}
                  className="mt-0.5"
                />
                <span className="grid content-start gap-0.5">
                  <span className="text-sm leading-5 font-medium">
                    {b.modes[m].title}
                  </span>
                  <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                    {b.modes[m].hint}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <ConnectorField
            id={`${id}-connector`}
            value={connector}
            onChange={setConnector}
          />
          <CurrencyField
            id={`${id}-currency`}
            label={b.currencyLabel}
            value={currency}
            onChange={setCurrency}
            help={b.currencyHelp}
          />
          <NumberField
            id={`${id}-cpa`}
            label={b.cpaLabel}
            value={cpa}
            onChange={setCpa}
            error={cpaN.error}
            understood={money(cpaN.value)}
            help={b.cpaHelp}
          />
          <NumberField
            id={`${id}-min`}
            label={b.minSpendLabel}
            value={minSpend}
            onChange={setMinSpend}
            error={minSpendN.error}
            understood={money(minSpendN.value)}
            help={b.minSpendHelp}
          />
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${id}-window`}>{b.windowLabel}</FieldLabel>
            <Select
              value={dateWindow}
              onValueChange={(v) => setDateWindow(v as AutomationWindow)}
            >
              <SelectTrigger id={`${id}-window`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_WINDOWS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {b.windows[w]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{b.windowHelp}</FieldDescription>
          </Field>
          {mode === "pause" && (
            <NumberField
              id={`${id}-per-run`}
              label={b.maxPerRunLabel}
              value={perRun}
              onChange={setPerRun}
              error={perRunN.error}
              help={b.maxPerRunHelp}
              integer
            />
          )}
        </div>

        <p
          aria-live="polite"
          className={cn(
            "rounded-xl px-3 py-2.5 text-[13px] text-pretty",
            hasErrors ? "bg-destructive/8 text-destructive" : "bg-muted/60"
          )}
        >
          {hasErrors
            ? s.previewBlocked
            : b.preview(
                formatMoney(rule.cpaMax, rule.currency),
                formatMoney(rule.minSpend, rule.currency)
              )}
        </p>
      </FieldGroup>

      <PromptOutputs
        prompt={buildSchedulePrompt(rule)}
        promptHelp={b.outputs.prompt.help}
        promptLabel={b.outputs.prompt.label}
        skillName={SKILL_NAME}
        skillMd={buildSkillMd(rule)}
        skillPrompt={buildSkillPrompt(rule)}
        blockedReason={blockedReason}
        labels={{
          promptTab: b.outputs.prompt.tab,
          skillTab: b.outputs.skill.tab,
          skillHelp: b.outputs.skill.help,
          skillLabel: b.outputs.skill.label,
          skillShortTitle: b.outputs.skill.shortTitle,
          skillShortLabel: b.outputs.skill.shortLabel,
          outputsLabel: b.outputsLabel,
        }}
      />
    </div>
  )
}
