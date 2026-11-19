"use client"

// Apify blocks of the MCP form (16-apify.md §8, decision A5: Apify is a platform like the ad platforms), shared by the
// create wizard and the config editor: platform card of step "Nền tảng & tài khoản" (enable switch + the owner's token
// pool summary), permission card of step "Quyền" (per-run cap - always enforced, admin-only switch "Cho phép Actor
// ngoài danh mục"), protection step daily cap (advanced) / basic-mode note, and the overview block + rows. The pool
// summary comes from the server (getMcpApifyPoolSummary for the MCP OWNER) - never a token. The server enforces the
// admin-only switch, the caps and "an Apify-only MCP needs a token" on save - the locks here are UI only.
import Link from "next/link"
import {
  Add01Icon,
  Alert02Icon,
  InformationCircleIcon,
  SquareLock01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { BrandIcon } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { formatNumber } from "@/lib/format"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type { McpApifyPoolSummary } from "@/lib/schemas/apify"
import type { McpFormValues, StepErrors } from "@/lib/schemas/mcp-servers"
import { gmvMaxSwitchState } from "@/lib/tiktok-gmv-max"

import type { FormUpdater } from "./mcp-form-sections"

const s = t.apify

/** ids the config tab scrolls to when the server refuses a save on an Apify field */
export const APIFY_ENABLE_SWITCH_ID = "mcp-apify-enabled"
export const APIFY_RUN_MAX_ID = "mcp-apify-run-max"
export const APIFY_STORE_SWITCH_ID = "mcp-apify-store-actors"
export const APIFY_DAILY_MAX_ID = "mcp-apify-daily-max"

/** USD text typed by the user: digits, one "," or "." */
function usdInput(raw: string): string {
  return raw.replace(/[^\d.,]/g, "").slice(0, 12)
}

function Note({
  children,
  warn = false,
}: {
  children: React.ReactNode
  warn?: boolean
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-[13px]",
        warn ? "text-warning-strong" : "text-muted-foreground"
      )}
    >
      <HugeiconsIcon
        icon={warn ? Alert02Icon : InformationCircleIcon}
        strokeWidth={2}
        className="mt-0.5 size-3.5 shrink-0"
        aria-hidden
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** Pool line "Kho token: … (… công ty, … cá nhân)", or null when the pool is unknown / empty. */
function poolLine(pool: McpApifyPoolSummary | null): string | null {
  if (!pool || pool.tokens === 0) return null
  return `${s.pool(pool)} (${s.poolScopes(pool.company, pool.personal)})`
}

/**
 * Step "Nền tảng & tài khoản": Apify as a platform card, same look as the ad platform cards (decision A5). Shown even
 * without any ad connection; no usable token in the owner's pool → switch locked (unless already on) + "Thêm token".
 */
export function ApifyPlatformCard({
  values,
  update,
  errors,
  pool,
  ownerEmail,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  /** token pool of the MCP OWNER (company + the owner's personal tokens); null = unknown */
  pool: McpApifyPoolSummary | null
  /** set when the MCP belongs to somebody other than the viewer */
  ownerEmail?: string
}) {
  const enabled = values.apifyEnabled
  const tokens = pool?.tokens ?? 0
  const usable = pool?.usableNow ?? 0
  // no usable token: cannot be newly switched on (an MCP that already uses Apify can still switch it off)
  const enableDisabled = pool !== null && !enabled && usable === 0
  const noUsable = pool !== null && usable === 0
  const line = poolLine(pool)
  const descId = `${APIFY_ENABLE_SWITCH_ID}-desc`
  const showBody = enabled || noUsable || !!errors.apifyEnabled
  return (
    <Card
      className={cn(
        "gap-0 py-0 transition-shadow",
        enabled && "ring-1 ring-brand-primary/30"
      )}
    >
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3 [.border-b]:pb-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <BrandIcon brand="apify" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Label
            htmlFor={APIFY_ENABLE_SWITCH_ID}
            className="text-base font-semibold"
          >
            {s.title}
          </Label>
          <p id={descId} className="text-[13px] text-muted-foreground">
            {s.platformDescription}
          </p>
        </div>
        <Switch
          id={APIFY_ENABLE_SWITCH_ID}
          checked={enabled}
          disabled={enableDisabled}
          aria-label={t.platformsStep.enablePlatform(s.title)}
          aria-describedby={descId}
          aria-invalid={errors.apifyEnabled ? true : undefined}
          onCheckedChange={(on) => update((v) => ({ ...v, apifyEnabled: on }))}
        />
      </CardHeader>
      {showBody && (
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          {enabled && (
            <>
              {line && <p className="text-sm font-medium">{line}</p>}
              <p className="text-[13px] text-muted-foreground">
                {s.enableHelp}
              </p>
              <Note>{s.permissionsHint}</Note>
            </>
          )}
          {noUsable && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
              <p className="text-[13px] text-muted-foreground">
                {tokens > 0
                  ? s.notUsableNow
                  : ownerEmail
                    ? s.noTokenOwner(ownerEmail)
                    : s.noToken}
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link href="/connections/apify/new">
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                  {s.addToken}
                </Link>
              </Button>
            </div>
          )}
          {errors.apifyEnabled && (
            <p className="text-[13px] text-destructive">
              {errors.apifyEnabled}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  )
}

/**
 * Step "Quyền": the Apify card next to the per-platform permission cards (only while Apify is on): per-run cap
 * (always enforced, basic mode too) + admin-only "Actor ngoài danh mục" + the Apify ToS note.
 */
export function ApifyPermissionsCard({
  values,
  update,
  errors,
  isAdmin,
  savedStoreOn = false,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  /** the viewer is an admin: may turn "Actor ngoài danh mục" on */
  isAdmin: boolean
  /** "Actor ngoài danh mục" saved on the MCP being edited (create wizard: false) */
  savedStoreOn?: boolean
}) {
  if (!values.apifyEnabled) return null
  const store = gmvMaxSwitchState({
    isAdmin,
    savedOn: savedStoreOn,
    checked: values.apifyStoreActors,
  })
  const storeHelpId = `${APIFY_STORE_SWITCH_ID}-help`
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle
          id="mcp-apify-perms"
          className="flex items-center gap-2 text-base"
        >
          <BrandIcon brand="apify" className="size-5" />
          {s.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-[13px] text-muted-foreground">{s.enableHelp}</p>
        <Field
          data-invalid={!!errors.apifyRunMaxUsd || undefined}
          className="md:max-w-[calc(50%-0.75rem)]"
        >
          <FieldLabel htmlFor={APIFY_RUN_MAX_ID}>{s.runMaxLabel}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={APIFY_RUN_MAX_ID}
              inputMode="decimal"
              value={values.apifyRunMaxUsd}
              aria-invalid={!!errors.apifyRunMaxUsd || undefined}
              onChange={(e) => {
                const apifyRunMaxUsd = usdInput(e.target.value)
                update((v) => ({ ...v, apifyRunMaxUsd }))
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{s.usdSuffix}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>{s.runMaxHelp}</FieldDescription>
          {errors.apifyRunMaxUsd && (
            <FieldError>{errors.apifyRunMaxUsd}</FieldError>
          )}
        </Field>

        <FieldLabel
          htmlFor={APIFY_STORE_SWITCH_ID}
          className={cn(
            "*:data-[slot=field]:p-3",
            store.disabled ? "cursor-not-allowed" : "cursor-pointer",
            "has-data-checked:border-warning/50 has-data-checked:bg-warning/8 dark:has-data-checked:border-warning/40 dark:has-data-checked:bg-warning/10"
          )}
        >
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {s.storeLabel}
                <Badge variant="outline" className="font-normal">
                  <HugeiconsIcon
                    icon={SquareLock01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  {s.adminBadge}
                </Badge>
              </FieldTitle>
              <FieldDescription
                id={storeHelpId}
                className="text-[13px] leading-snug"
              >
                {values.apifyStoreActors ? s.storeHelpOn : s.storeHelpOff}
              </FieldDescription>
              {store.locked && (
                <FieldDescription className="text-[13px] leading-snug font-medium text-foreground/80">
                  {s.staffLocked}
                </FieldDescription>
              )}
              {!isAdmin && savedStoreOn && (
                <FieldDescription className="text-[13px] leading-snug">
                  {s.staffCanTurnOff}
                </FieldDescription>
              )}
              {errors.apifyStoreActors && (
                <FieldError>{errors.apifyStoreActors}</FieldError>
              )}
            </FieldContent>
            <Switch
              id={APIFY_STORE_SWITCH_ID}
              checked={values.apifyStoreActors}
              disabled={store.disabled}
              aria-describedby={storeHelpId}
              aria-invalid={errors.apifyStoreActors ? true : undefined}
              onCheckedChange={(on) =>
                update((v) => ({ ...v, apifyStoreActors: on }))
              }
            />
          </Field>
        </FieldLabel>

        <Note>{s.tosNote}</Note>
      </CardContent>
    </Card>
  )
}

/** Protection step (advanced, Apify on): daily cap of the money Apify runs may commit. */
export function ApifyLimitSection({
  values,
  update,
  errors,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
}) {
  return (
    <section aria-labelledby="prot-apify" className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 id="prot-apify" className="text-sm font-semibold">
          {s.groupTitle}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {s.groupDescription}
        </p>
      </div>
      <Field
        data-invalid={!!errors.apifyDailyMaxUsd || undefined}
        className="md:max-w-[calc(50%-0.75rem)]"
      >
        <FieldLabel htmlFor={APIFY_DAILY_MAX_ID}>{s.dailyLabel}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={APIFY_DAILY_MAX_ID}
            inputMode="decimal"
            value={values.apifyDailyMaxUsd}
            aria-invalid={!!errors.apifyDailyMaxUsd || undefined}
            onChange={(e) => {
              const apifyDailyMaxUsd = usdInput(e.target.value)
              update((v) => ({ ...v, apifyDailyMaxUsd }))
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{s.usdSuffix}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>{s.dailyHelp}</FieldDescription>
        {errors.apifyDailyMaxUsd && (
          <FieldError>{errors.apifyDailyMaxUsd}</FieldError>
        )}
      </Field>
    </section>
  )
}

/** Basic mode, Apify on: no daily cap, the per-run cap still applies. */
export function ApifyBasicNote({ values }: { values: McpFormValues }) {
  return <Note>{s.basicNote(values.apifyRunMaxUsd.trim() || "1")}</Note>
}

/** Overview "Phạm vi MCP": Apify block next to the ad platform blocks (only while Apify is on). */
export function ApifyScopeBlock({
  settings,
  pool,
}: {
  settings: { apifyEnabled: boolean; apifyRunMaxUsd: number }
  /** token pool of the MCP OWNER; null = unknown */
  pool: McpApifyPoolSummary | null
}) {
  if (!settings.apifyEnabled) return null
  const line = poolLine(pool)
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center gap-2 font-medium">
        <BrandIcon brand="apify" />
        {s.title}
      </div>
      <ul className="flex flex-col gap-1 border-l-2 pl-2.5 text-[13px] text-muted-foreground">
        <li className="font-medium text-foreground">{s.enableLabel}</li>
        {line && <li>{line}</li>}
        <li className="tabular-nums">
          {s.runMaxLine(s.usd(formatNumber(settings.apifyRunMaxUsd)))}
        </li>
      </ul>
      {pool && pool.usableNow === 0 && (
        <Note warn>{pool.tokens === 0 ? s.overviewNoToken : s.notUsableNow}</Note>
      )}
    </div>
  )
}

/** Overview summary rows (rendered inside the overview's <dl>, with its own row component). */
export function ApifySummaryRows({
  settings,
  basic,
  Row,
  on,
  off,
}: {
  settings: {
    apifyEnabled: boolean
    apifyRunMaxUsd: number
    apifyDailyMaxUsd: number
    apifyStoreActors: boolean
  }
  /** basic protection mode: no daily cap */
  basic: boolean
  Row: React.ComponentType<{ label: string; children: React.ReactNode }>
  on: string
  off: string
}) {
  if (!settings.apifyEnabled) {
    return <Row label={s.summaryEnabled}>{off}</Row>
  }
  const daily = settings.apifyDailyMaxUsd
  return (
    <>
      <Row label={s.summaryEnabled}>{on}</Row>
      <Row label={s.summaryRunMax}>
        <span className="tabular-nums">
          {s.usd(formatNumber(settings.apifyRunMaxUsd))}
        </span>
      </Row>
      <Row label={s.summaryDaily}>
        {basic || !(daily > 0) ? (
          s.noDailyCap
        ) : (
          <span className="tabular-nums">{s.usd(formatNumber(daily))}</span>
        )}
      </Row>
      <Row label={s.summaryStore}>
        <span
          className={
            settings.apifyStoreActors
              ? "font-medium text-warning-strong"
              : undefined
          }
        >
          {settings.apifyStoreActors ? on : off}
        </span>
      </Row>
    </>
  )
}
