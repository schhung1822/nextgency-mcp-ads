"use client"

import * as React from "react"
import { cn } from "cn"

import { CodeSnippet } from "@/components/mcp/client-setup-guide"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AUTOMATION_WINDOWS,
  buildSchedulePrompt,
  buildSkillMd,
  buildSkillPrompt,
  DEFAULT_CPA_RULE,
  normalizeCurrency,
  type AutomationMode,
  type AutomationWindow,
  type CpaRuleInput,
} from "@/lib/automation-prompt"
import { formatMoney } from "@/lib/format"
import { automation as t } from "@/lib/i18n/vi/automation"

const b = t.builder
const MODES: AutomationMode[] = ["report", "pause"]

/** Number typed by the user → value used in the texts (empty / invalid → fallback). */
function parseAmount(raw: string, fallback: number): number {
  const n = Number(raw.replace(",", "."))
  return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback
}

function isInvalidAmount(raw: string): boolean {
  const n = Number(raw.replace(",", "."))
  return raw.trim() === "" || !Number.isFinite(n) || n < 0
}

/** Inputs of the CPA rule + live copy-paste texts (full prompt / Claude skill / project & Gem instructions). */
export function RuleBuilder() {
  const id = React.useId()
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

  const rule: CpaRuleInput = {
    mode,
    cpaMax: parseAmount(cpa, DEFAULT_CPA_RULE.cpaMax),
    currency: normalizeCurrency(currency),
    minSpend: parseAmount(minSpend, DEFAULT_CPA_RULE.minSpend),
    window: dateWindow,
    maxPerRun: parseAmount(perRun, DEFAULT_CPA_RULE.maxPerRun),
  }
  const currencyInvalid = !/^[A-Za-z]{3}$/.test(currency.trim())
  const perRunValue = Number(perRun)
  const perRunInvalid =
    !Number.isInteger(perRunValue) || perRunValue < 1 || perRunValue > 50

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
                  "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-red/5"
                )}
              >
                <RadioGroupItem
                  value={m}
                  id={`${id}-${m}`}
                  aria-label={b.modes[m].title}
                  className="mt-0.5"
                />
                <span className="grid gap-0.5">
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
          <Field data-invalid={isInvalidAmount(cpa) || undefined}>
            <FieldLabel htmlFor={`${id}-cpa`}>{b.cpaLabel}</FieldLabel>
            <Input
              id={`${id}-cpa`}
              inputMode="decimal"
              autoComplete="off"
              value={cpa}
              onChange={(e) => setCpa(e.target.value)}
              aria-invalid={isInvalidAmount(cpa) || undefined}
              className="tabular-nums"
            />
            <FieldDescription>{b.cpaHelp}</FieldDescription>
          </Field>
          <Field data-invalid={currencyInvalid || undefined}>
            <FieldLabel htmlFor={`${id}-currency`}>
              {b.currencyLabel}
            </FieldLabel>
            <Input
              id={`${id}-currency`}
              autoComplete="off"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              aria-invalid={currencyInvalid || undefined}
              className="uppercase"
            />
            <FieldDescription>{b.currencyHelp}</FieldDescription>
          </Field>
          <Field data-invalid={isInvalidAmount(minSpend) || undefined}>
            <FieldLabel htmlFor={`${id}-min`}>{b.minSpendLabel}</FieldLabel>
            <Input
              id={`${id}-min`}
              inputMode="decimal"
              autoComplete="off"
              value={minSpend}
              onChange={(e) => setMinSpend(e.target.value)}
              aria-invalid={isInvalidAmount(minSpend) || undefined}
              className="tabular-nums"
            />
            <FieldDescription>{b.minSpendHelp}</FieldDescription>
          </Field>
          <Field>
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
            <Field data-invalid={perRunInvalid || undefined}>
              <FieldLabel htmlFor={`${id}-per-run`}>
                {b.maxPerRunLabel}
              </FieldLabel>
              <Input
                id={`${id}-per-run`}
                inputMode="numeric"
                autoComplete="off"
                value={perRun}
                onChange={(e) => setPerRun(e.target.value)}
                aria-invalid={perRunInvalid || undefined}
                className="tabular-nums"
              />
              <FieldDescription>{b.maxPerRunHelp}</FieldDescription>
            </Field>
          )}
        </div>

        <p
          aria-live="polite"
          className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-pretty"
        >
          {b.preview(
            formatMoney(rule.cpaMax, rule.currency),
            formatMoney(rule.minSpend, rule.currency)
          )}
        </p>
      </FieldGroup>

      <Tabs defaultValue="prompt" className="gap-4">
        <div className="-mx-1 [scrollbar-width:none] overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] px-1 pb-1 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden">
          <TabsList
            aria-label={b.outputsLabel}
            className="w-max max-sm:h-11! max-sm:pr-6"
          >
            <TabsTrigger value="prompt">{b.outputs.prompt.tab}</TabsTrigger>
            <TabsTrigger value="skill">{b.outputs.skill.tab}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="prompt" className="flex flex-col gap-3">
          <p className="text-[13px] text-pretty text-muted-foreground">
            {b.outputs.prompt.help}
          </p>
          <CodeSnippet
            code={buildSchedulePrompt(rule)}
            label={b.outputs.prompt.label}
          />
        </TabsContent>
        <TabsContent value="skill" className="flex flex-col gap-3">
          <p className="text-[13px] text-pretty text-muted-foreground">
            {b.outputs.skill.help}
          </p>
          <CodeSnippet
            code={buildSkillMd(rule)}
            label={b.outputs.skill.label}
          />
          <p className="pt-1 text-sm font-medium">
            {b.outputs.skill.shortTitle}
          </p>
          <CodeSnippet
            code={buildSkillPrompt(rule)}
            label={b.outputs.skill.shortLabel}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
