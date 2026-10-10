"use client"

import * as React from "react"
import { cn } from "cn"

import {
  Field,
  FieldContent,
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
import { Switch } from "@/components/ui/switch"
import {
  BULK_PLATFORMS,
  BULK_SKILL_NAME,
  buildBulkAdsPrompt,
  buildBulkAdsSkillMd,
  buildBulkAdsSkillPrompt,
  DEFAULT_BULK_ADS,
  type BulkAdsInput,
  type BulkPlatform,
  type BulkStructure,
} from "@/lib/bulk-ads-prompt"
import { formatMoney } from "@/lib/format"
import { tips as t } from "@/lib/i18n/vi/tips"

import {
  ConnectorField,
  CurrencyField,
  isCurrencyCode,
  NumberField,
  useViNumber,
} from "../../_components/form-bits"
import { PromptOutputs } from "../../_components/prompt-outputs"

const b = t.bulk.builder
const s = t.shared
const STRUCTURES: BulkStructure[] = ["existing", "new"]
const BATCH_RULE = { min: 1, max: 20, integer: true } as const
const BUDGET_RULE = { min: 0, minExclusive: true } as const

/** Form → live prompt / SKILL.md for creating ads from the "Chờ lên" rows of a Google Sheet. */
export function BulkBuilder() {
  const id = React.useId()
  const [connector, setConnector] = React.useState("")
  const [sheetName, setSheetName] = React.useState("")
  const [batch, setBatch] = React.useState(String(DEFAULT_BULK_ADS.batchSize))
  const [platform, setPlatform] = React.useState<BulkPlatform>(
    DEFAULT_BULK_ADS.platform
  )
  const [account, setAccount] = React.useState("")
  const [structure, setStructure] = React.useState<BulkStructure>(
    DEFAULT_BULK_ADS.structure
  )
  const [campaign, setCampaign] = React.useState("")
  const [group, setGroup] = React.useState("")
  const [budget, setBudget] = React.useState(
    String(DEFAULT_BULK_ADS.dailyBudget)
  )
  const [currency, setCurrency] = React.useState(DEFAULT_BULK_ADS.currency)
  const [writeback, setWriteback] = React.useState(DEFAULT_BULK_ADS.writeback)

  const batchN = useViNumber(batch, BATCH_RULE)
  const budgetN = useViNumber(budget, BUDGET_RULE)
  const isNew = structure === "new"
  const currencyOk = isCurrencyCode(currency)
  const cur = currency.trim().toUpperCase()
  // budget / currency only matter when a new campaign is created
  const hasErrors =
    !!batchN.error || (isNew && (!!budgetN.error || !currencyOk))
  const blockedReason = hasErrors ? s.copyBlocked : null

  const input: BulkAdsInput = {
    connectorName: connector,
    sheetName,
    batchSize: batchN.value ?? DEFAULT_BULK_ADS.batchSize,
    platform,
    account,
    structure,
    campaignName: campaign,
    adGroupName: group,
    dailyBudget: budgetN.value ?? DEFAULT_BULK_ADS.dailyBudget,
    currency: currencyOk ? cur : DEFAULT_BULK_ADS.currency,
    writeback,
  }

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup className="gap-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <ConnectorField
            id={`${id}-connector`}
            value={connector}
            onChange={setConnector}
          />
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${id}-sheet`}>{b.sheetLabel}</FieldLabel>
            <Input
              id={`${id}-sheet`}
              autoComplete="off"
              maxLength={100}
              placeholder={b.sheetPlaceholder}
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
            />
            <FieldDescription>{b.sheetHelp}</FieldDescription>
          </Field>
          <NumberField
            id={`${id}-batch`}
            label={b.batchLabel}
            value={batch}
            onChange={setBatch}
            error={batchN.error}
            help={b.batchHelp}
            integer
          />
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${id}-platform`}>{b.platformLabel}</FieldLabel>
            <Select
              value={platform}
              onValueChange={(v) => setPlatform(v as BulkPlatform)}
            >
              <SelectTrigger id={`${id}-platform`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BULK_PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {b.platforms[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{b.platformHelp}</FieldDescription>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${id}-account`}>{b.accountLabel}</FieldLabel>
            <Input
              id={`${id}-account`}
              autoComplete="off"
              maxLength={100}
              placeholder={b.accountPlaceholder}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
            <FieldDescription>{b.accountHelp}</FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel id={`${id}-structure-label`}>{b.structureLabel}</FieldLabel>
          <RadioGroup
            value={structure}
            onValueChange={(v) => setStructure(v === "new" ? "new" : "existing")}
            aria-labelledby={`${id}-structure-label`}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {STRUCTURES.map((st) => (
              <label
                key={st}
                htmlFor={`${id}-${st}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-2xl border bg-input/20 p-3.5 transition-colors",
                  "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                  "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-red/5"
                )}
              >
                <RadioGroupItem
                  value={st}
                  id={`${id}-${st}`}
                  aria-label={b.structures[st].title}
                  className="mt-0.5"
                />
                <span className="grid content-start gap-0.5">
                  <span className="text-sm leading-5 font-medium">
                    {b.structures[st].title}
                  </span>
                  <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                    {b.structures[st].hint}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${id}-campaign`}>{b.campaignLabel}</FieldLabel>
            <Input
              id={`${id}-campaign`}
              autoComplete="off"
              maxLength={100}
              placeholder={
                isNew ? b.campaignPlaceholderNew : b.campaignPlaceholderExisting
              }
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
            />
            <FieldDescription>
              {isNew ? b.campaignHelpNew : b.campaignHelpExisting}
            </FieldDescription>
          </Field>
          {isNew ? (
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-3">
              <NumberField
                id={`${id}-budget`}
                label={b.budgetLabel}
                value={budget}
                onChange={setBudget}
                error={budgetN.error}
                understood={
                  budgetN.value !== null && currencyOk
                    ? formatMoney(budgetN.value, cur)
                    : null
                }
                help={b.budgetHelp}
              />
              <CurrencyField
                id={`${id}-currency`}
                label={b.currencyLabel}
                value={currency}
                onChange={setCurrency}
              />
            </div>
          ) : (
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${id}-group`}>{b.groupLabel}</FieldLabel>
              <Input
                id={`${id}-group`}
                autoComplete="off"
                maxLength={100}
                placeholder={b.groupPlaceholder}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              />
              <FieldDescription>{b.groupHelp}</FieldDescription>
            </Field>
          )}
        </div>

        <Field orientation="horizontal" className="rounded-2xl border p-3.5">
          <FieldContent>
            <FieldLabel htmlFor={`${id}-writeback`}>{b.writebackLabel}</FieldLabel>
            <FieldDescription>{b.writebackHelp}</FieldDescription>
          </FieldContent>
          <Switch
            id={`${id}-writeback`}
            checked={writeback}
            onCheckedChange={setWriteback}
          />
        </Field>

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
                input.batchSize,
                isNew
                  ? b.previewNew(formatMoney(input.dailyBudget, input.currency))
                  : b.previewExisting
              )}
        </p>
      </FieldGroup>

      <PromptOutputs
        prompt={buildBulkAdsPrompt(input)}
        promptHelp={b.promptHelp}
        promptLabel={b.promptLabel}
        skillName={BULK_SKILL_NAME}
        skillMd={buildBulkAdsSkillMd(input)}
        skillPrompt={buildBulkAdsSkillPrompt(input)}
        blockedReason={blockedReason}
      />
    </div>
  )
}
