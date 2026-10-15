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
import { Textarea } from "@/components/ui/textarea"
import {
  BULK_META_AD_TYPES,
  BULK_PLATFORMS,
  BULK_TASKS,
  buildBulkAdsPrompt,
  buildBulkAdsSkillMd,
  buildBulkAdsSkillPrompt,
  bulkSkillName,
  bulkTask,
  DEFAULT_BULK_ADS,
  metaMessagingType,
  WELCOME_MESSAGE_MAX,
  type BulkAdsInput,
  type BulkMetaAdType,
  type BulkPlatform,
  type BulkStructure,
  type BulkTask,
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

/**
 * Form → live prompt / SKILL.md for creating ads from the "Chờ lên" rows of a Google Sheet, or (task update_welcome,
 * Meta only - v1.1.4) for adding / changing the Messenger welcome message of the ads already created from the sheet.
 */
export function BulkBuilder() {
  const id = React.useId()
  const [task, setTask] = React.useState<BulkTask>(DEFAULT_BULK_ADS.task)
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
  const [metaAdType, setMetaAdType] = React.useState<BulkMetaAdType>(
    DEFAULT_BULK_ADS.metaAdType
  )
  const [welcome, setWelcome] = React.useState(DEFAULT_BULK_ADS.welcomeMessage)

  const batchN = useViNumber(batch, BATCH_RULE)
  const budgetN = useViNumber(budget, BUDGET_RULE)
  const isNew = structure === "new"
  const currencyOk = isCurrencyCode(currency)
  const cur = currency.trim().toUpperCase()

  const input: BulkAdsInput = {
    task,
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
    metaAdType,
    welcomeMessage: welcome,
  }
  // the task + Meta ad type only matter when Meta rows can be in the run (platform Meta or "Theo cột Nền tảng")
  const showMetaType = platform === "meta" || platform === "sheet"
  // update_welcome: no structure / campaign / budget / ad type - only the welcome message (bulkTask: Meta only)
  const isUpdate = bulkTask(input) === "update_welcome"
  const messaging = isUpdate ? null : metaMessagingType(input)
  const showWelcome = isUpdate || messaging !== null
  // budget / currency only matter when a new campaign is created
  const hasErrors =
    !!batchN.error ||
    (!isUpdate && isNew && (!!budgetN.error || !currencyOk))
  const blockedReason = hasErrors ? s.copyBlocked : null

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
          {showMetaType && (
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${id}-task`}>{b.taskLabel}</FieldLabel>
              <Select
                value={task}
                onValueChange={(v) =>
                  setTask(v === "update_welcome" ? "update_welcome" : "create")
                }
              >
                <SelectTrigger
                  id={`${id}-task`}
                  className="w-full"
                  aria-describedby={`${id}-task-help`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BULK_TASKS.map((tk) => (
                    <SelectItem key={tk} value={tk}>
                      {b.tasks[tk]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id={`${id}-task-help`}>
                {b.taskHelp[task]}
              </FieldDescription>
            </Field>
          )}
          {showMetaType && !isUpdate && (
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${id}-meta-type`}>{b.metaTypeLabel}</FieldLabel>
              <Select
                value={metaAdType}
                onValueChange={(v) => setMetaAdType(v as BulkMetaAdType)}
              >
                <SelectTrigger
                  id={`${id}-meta-type`}
                  className="w-full"
                  aria-describedby={`${id}-meta-type-help`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BULK_META_AD_TYPES.map((mt) => (
                    <SelectItem key={mt} value={mt}>
                      {b.metaTypes[mt]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id={`${id}-meta-type-help`}>
                {b.metaTypeHelp[metaAdType]}
              </FieldDescription>
            </Field>
          )}
        </div>

        {showWelcome && (
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${id}-welcome`}>
              {isUpdate ? b.welcomeLabelUpdate : b.welcomeLabel}
            </FieldLabel>
            <Textarea
              id={`${id}-welcome`}
              rows={2}
              maxLength={WELCOME_MESSAGE_MAX}
              placeholder={b.welcomePlaceholder}
              value={welcome}
              onChange={(e) => setWelcome(e.target.value)}
              aria-describedby={`${id}-welcome-help ${id}-welcome-count`}
            />
            <div className="flex items-start justify-between gap-3">
              <FieldDescription id={`${id}-welcome-help`}>
                {isUpdate ? b.welcomeHelpUpdate : b.welcomeHelp}
              </FieldDescription>
              <span
                id={`${id}-welcome-count`}
                className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
              >
                {b.welcomeCount(welcome.length, WELCOME_MESSAGE_MAX)}
              </span>
            </div>
          </Field>
        )}

        {!isUpdate && (
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
        )}

        {!isUpdate && (
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
        )}

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
            : isUpdate
              ? b.previewUpdateWelcome(input.batchSize)
              : b.preview(
                  input.batchSize,
                  isNew
                    ? b.previewNew(formatMoney(input.dailyBudget, input.currency))
                    : b.previewExisting
                )}
          {!hasErrors && messaging && <> {b.previewMessaging[messaging]}</>}
        </p>
      </FieldGroup>

      <PromptOutputs
        prompt={buildBulkAdsPrompt(input)}
        promptHelp={b.promptHelp}
        promptLabel={b.promptLabel}
        skillName={bulkSkillName(input)}
        skillMd={buildBulkAdsSkillMd(input)}
        skillPrompt={buildBulkAdsSkillPrompt(input)}
        blockedReason={blockedReason}
      />
    </div>
  )
}
