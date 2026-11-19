"use client"

import * as React from "react"
import { cn } from "cn"

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
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
  BULK_TIKTOK_AD_TYPES,
  BULK_TIKTOK_MESSAGING_APPS,
  buildBulkAdsPrompt,
  buildBulkAdsSkillMd,
  buildBulkAdsSkillPrompt,
  bulkSkillName,
  bulkTask,
  checkTiktokMessagingAccount,
  cleanWelcome,
  DEFAULT_BULK_ADS,
  metaMessagingType,
  TIKTOK_WELCOME_MESSAGE_MAX,
  tiktokMessagingType,
  WELCOME_MESSAGE_MAX,
  type BulkAdsInput,
  type BulkMetaAdType,
  type BulkPlatform,
  type BulkStructure,
  type BulkTask,
  type BulkTiktokAdType,
  type BulkTiktokMessagingApp,
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
import { TipAlert } from "../../_components/tip-blocks"

const b = t.bulk.builder
const s = t.shared
const STRUCTURES: BulkStructure[] = ["existing", "new"]
const BATCH_RULE = { min: 1, max: 20, integer: true } as const
const BUDGET_RULE = { min: 0, minExclusive: true } as const

/** Zalo / WhatsApp take a phone number; Messenger / LINE an id (switching between the two clears the field). */
const isPhoneApp = (app: BulkTiktokMessagingApp) =>
  app === "ZALO" || app === "WHATSAPP"

/**
 * Form → live prompt / SKILL.md for creating ads from the "Chờ lên" rows of a Google Sheet, or (task update_welcome,
 * Meta only - v1.1.4) for adding / changing the Messenger welcome message of the ads already created from the sheet.
 * TikTok rows can be messaging ads (v1.1.5): TikTok direct message (welcome message ≤ 200) or Zalo / Messenger /
 * WhatsApp / LINE (app + receiving account).
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
  const [tiktokAdType, setTiktokAdType] = React.useState<BulkTiktokAdType>(
    DEFAULT_BULK_ADS.tiktokAdType
  )
  const [tiktokApp, setTiktokApp] = React.useState<BulkTiktokMessagingApp>(
    DEFAULT_BULK_ADS.tiktokMessagingApp
  )
  const [tiktokAccount, setTiktokAccount] = React.useState(
    DEFAULT_BULK_ADS.tiktokMessagingAccount
  )

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
    tiktokAdType,
    tiktokMessagingApp: tiktokApp,
    tiktokMessagingAccount: tiktokAccount,
  }
  // the task + Meta ad type only matter when Meta rows can be in the run (platform Meta or "Theo cột Nền tảng")
  const showMetaType = platform === "meta" || platform === "sheet"
  // update_welcome: no structure / campaign / budget / ad type - only the welcome message (bulkTask: Meta only)
  const isUpdate = bulkTask(input) === "update_welcome"
  const messaging = isUpdate ? null : metaMessagingType(input)
  // the TikTok ad type only matters when TikTok rows can be in the run (platform TikTok or "Theo cột Nền tảng")
  const showTiktokType = !isUpdate && (platform === "tiktok" || platform === "sheet")
  const tiktokMsg = isUpdate ? null : tiktokMessagingType(input)
  const tiktokDm = tiktokMsg === "messaging_dm"
  const accountCheck = checkTiktokMessagingAccount(tiktokApp, tiktokAccount)
  const accountError =
    tiktokMsg === "messaging_app" && !accountCheck.ok
      ? b.tiktokAccountError[accountCheck.error]
      : null
  const phoneUnderstood =
    tiktokMsg === "messaging_app" &&
    isPhoneApp(tiktokApp) &&
    accountCheck.ok &&
    accountCheck.value
      ? b.tiktokPhoneUnderstood(accountCheck.value)
      : null
  // welcome message: Meta (Messenger, ≤ 300) and / or TikTok DM (≤ 200); both in "Theo cột Nền tảng" mode → 300, and
  // a text over 200 only warns (TikTok rows without their own welcome message get an error note)
  const metaWelcome = isUpdate || messaging !== null
  const showWelcome = metaWelcome || tiktokDm
  const welcomeMax = metaWelcome ? WELCOME_MESSAGE_MAX : TIKTOK_WELCOME_MESSAGE_MAX
  const welcomeLen = cleanWelcome(welcome).length
  const tiktokWelcomeLong = tiktokDm && welcomeLen > TIKTOK_WELCOME_MESSAGE_MAX
  const welcomeError =
    tiktokWelcomeLong && !metaWelcome
      ? b.welcomeTooLongTiktok(welcomeLen, TIKTOK_WELCOME_MESSAGE_MAX)
      : null
  const welcomeWarning =
    tiktokWelcomeLong && metaWelcome
      ? b.welcomeTooLongTiktokRows(welcomeLen, TIKTOK_WELCOME_MESSAGE_MAX)
      : null
  const welcomeLabel = isUpdate
    ? b.welcomeLabelUpdate
    : messaging && tiktokDm
      ? b.welcomeLabelBoth
      : tiktokDm
        ? b.welcomeLabelTiktok
        : b.welcomeLabel
  const welcomeHelp = isUpdate
    ? b.welcomeHelpUpdate
    : messaging && tiktokDm
      ? b.welcomeHelpBoth
      : tiktokDm
        ? b.welcomeHelpTiktok
        : b.welcomeHelp
  // budget / currency only matter when a new campaign is created
  const hasErrors =
    !!batchN.error ||
    !!accountError ||
    !!welcomeError ||
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
          {showTiktokType && (
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${id}-tiktok-type`}>
                {b.tiktokTypeLabel}
              </FieldLabel>
              <Select
                value={tiktokAdType}
                onValueChange={(v) => setTiktokAdType(v as BulkTiktokAdType)}
              >
                <SelectTrigger
                  id={`${id}-tiktok-type`}
                  className="w-full"
                  aria-describedby={`${id}-tiktok-type-help`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BULK_TIKTOK_AD_TYPES.map((tt) => (
                    <SelectItem key={tt} value={tt}>
                      {b.tiktokTypes[tt]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id={`${id}-tiktok-type-help`}>
                {b.tiktokTypeHelp[tiktokAdType]}
              </FieldDescription>
            </Field>
          )}
          {tiktokMsg === "messaging_app" && (
            <>
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-tiktok-app`}>
                  {b.tiktokAppLabel}
                </FieldLabel>
                <Select
                  value={tiktokApp}
                  onValueChange={(v) => {
                    const next = v as BulkTiktokMessagingApp
                    if (isPhoneApp(next) !== isPhoneApp(tiktokApp))
                      setTiktokAccount("")
                    setTiktokApp(next)
                  }}
                >
                  <SelectTrigger
                    id={`${id}-tiktok-app`}
                    className="w-full"
                    aria-describedby={`${id}-tiktok-app-help`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BULK_TIKTOK_MESSAGING_APPS.map((app) => (
                      <SelectItem key={app} value={app}>
                        {b.tiktokApps[app]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription id={`${id}-tiktok-app-help`}>
                  {b.tiktokAppHelp[tiktokApp]}
                </FieldDescription>
              </Field>
              <Field
                data-invalid={accountError ? true : undefined}
                className="gap-1.5"
              >
                <FieldLabel htmlFor={`${id}-tiktok-account`}>
                  {b.tiktokAccountLabel[tiktokApp]}
                </FieldLabel>
                <Input
                  id={`${id}-tiktok-account`}
                  autoComplete="off"
                  maxLength={60}
                  inputMode={
                    isPhoneApp(tiktokApp)
                      ? "tel"
                      : tiktokApp === "MESSENGER"
                        ? "numeric"
                        : "text"
                  }
                  placeholder={b.tiktokAccountPlaceholder[tiktokApp]}
                  value={tiktokAccount}
                  onChange={(e) => setTiktokAccount(e.target.value)}
                  aria-invalid={accountError ? true : undefined}
                  aria-describedby={`${id}-tiktok-account-msg ${id}-tiktok-account-help`}
                  className="tabular-nums"
                />
                <div id={`${id}-tiktok-account-msg`} aria-live="polite">
                  {accountError ? (
                    <FieldError>{accountError}</FieldError>
                  ) : phoneUnderstood ? (
                    <p className="text-[13px] font-medium text-foreground tabular-nums">
                      {phoneUnderstood}
                    </p>
                  ) : null}
                </div>
                <FieldDescription id={`${id}-tiktok-account-help`}>
                  {b.tiktokAccountHelp[tiktokApp]}
                </FieldDescription>
              </Field>
            </>
          )}
        </div>

        {showWelcome && (
          <Field
            data-invalid={welcomeError ? true : undefined}
            className="gap-1.5"
          >
            <FieldLabel htmlFor={`${id}-welcome`}>{welcomeLabel}</FieldLabel>
            <Textarea
              id={`${id}-welcome`}
              rows={2}
              maxLength={welcomeMax}
              placeholder={b.welcomePlaceholder}
              value={welcome}
              onChange={(e) => setWelcome(e.target.value)}
              aria-invalid={welcomeError ? true : undefined}
              aria-describedby={`${id}-welcome-help ${id}-welcome-count ${id}-welcome-msg`}
            />
            <div className="flex items-start justify-between gap-3">
              <FieldDescription id={`${id}-welcome-help`}>
                {welcomeHelp}
              </FieldDescription>
              <span
                id={`${id}-welcome-count`}
                className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
              >
                {b.welcomeCount(welcome.length, welcomeMax)}
              </span>
            </div>
            <div id={`${id}-welcome-msg`} aria-live="polite">
              {welcomeError ? (
                <FieldError>{welcomeError}</FieldError>
              ) : welcomeWarning ? (
                <p className="text-[13px] font-medium text-pretty text-warning-strong">
                  {welcomeWarning}
                </p>
              ) : null}
            </div>
          </Field>
        )}

        {tiktokMsg && (
          <TipAlert
            tone="warning"
            title={b.tiktokNoteTitle}
            items={b.tiktokNotes[tiktokMsg]}
          />
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
                    "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-primary/5"
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
          {!hasErrors && tiktokMsg && (
            <>
              {" "}
              {tiktokDm
                ? b.previewTiktokDm
                : b.previewTiktokApp(b.tiktokApps[tiktokApp])}
            </>
          )}
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
