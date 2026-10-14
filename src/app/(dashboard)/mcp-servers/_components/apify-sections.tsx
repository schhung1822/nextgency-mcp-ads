"use client"

// Apify blocks of the MCP form (16-apify.md §8), shared by the create wizard and the config editor: step "Chọn quyền"
// card (switch "Cho phép AI lấy dữ liệu qua Apify" with the owner's token pool summary, per-run cap - always enforced,
// admin-only switch "Cho phép Actor ngoài danh mục"), protection step daily cap (advanced) / basic-mode note, and the
// overview rows. The pool summary comes from the server (getMcpApifyPoolSummary for the MCP OWNER) - never a token.
// The server enforces the admin-only switch and the caps on save - the locks here are UI only.
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
import { Card, CardContent, CardHeader } from "@/components/ui/card"
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

function ApifyCardHeader({ id, aside }: { id: string; aside?: React.ReactNode }) {
  return (
    <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3 [.border-b]:pb-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <BrandIcon brand="apify" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h4 id={id} className="text-base font-semibold">
          {s.title}
        </h4>
        <p className="text-[13px] text-muted-foreground">{s.description}</p>
      </div>
      {aside}
    </CardHeader>
  )
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

/** Step "Chọn quyền": Apify switch + per-run cap + admin-only "Actor ngoài danh mục". */
export function ApifyPermissionsSection({
  values,
  update,
  errors,
  pool,
  isAdmin,
  savedStoreOn = false,
  ownerEmail,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  /** token pool of the MCP OWNER (company + the owner's personal tokens); null = unknown */
  pool: McpApifyPoolSummary | null
  /** the viewer is an admin: may turn "Actor ngoài danh mục" on */
  isAdmin: boolean
  /** "Actor ngoài danh mục" saved on the MCP being edited (create wizard: false) */
  savedStoreOn?: boolean
  /** set when the MCP belongs to somebody other than the viewer */
  ownerEmail?: string
}) {
  const enabled = values.apifyEnabled
  const tokens = pool?.tokens ?? 0
  const usable = pool?.usableNow ?? 0
  // no usable token: cannot be newly switched on (an MCP that already uses Apify can still switch it off)
  const enableDisabled = pool !== null && !enabled && usable === 0
  const store = gmvMaxSwitchState({
    isAdmin,
    savedOn: savedStoreOn,
    checked: values.apifyStoreActors,
  })
  const enableHelpId = `${APIFY_ENABLE_SWITCH_ID}-help`
  const storeHelpId = `${APIFY_STORE_SWITCH_ID}-help`

  return (
    <section aria-labelledby="mcp-apify-perms" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-muted-foreground">
        {s.optionalGroup}
      </h3>
      <Card
        className={cn(
          "gap-0 py-0 transition-shadow",
          enabled && "ring-1 ring-brand-red/30"
        )}
      >
        <ApifyCardHeader id="mcp-apify-perms" />
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          {/* the whole row is the label: a tap anywhere toggles the switch (unless locked) */}
          <FieldLabel
            htmlFor={APIFY_ENABLE_SWITCH_ID}
            className={cn(
              "*:data-[slot=field]:p-3",
              enableDisabled ? "cursor-not-allowed" : "cursor-pointer"
            )}
          >
            <Field
              orientation="horizontal"
              data-disabled={enableDisabled ? true : undefined}
            >
              <FieldContent>
                <FieldTitle>{s.enableLabel}</FieldTitle>
                <FieldDescription
                  id={enableHelpId}
                  className="text-[13px] leading-snug"
                >
                  {s.enableHelp}
                </FieldDescription>
                {pool && tokens > 0 && (
                  <FieldDescription className="text-[13px] leading-snug font-medium text-foreground/80">
                    {s.pool(pool)} ({s.poolScopes(pool.company, pool.personal)})
                  </FieldDescription>
                )}
                {errors.apifyEnabled && (
                  <FieldError>{errors.apifyEnabled}</FieldError>
                )}
              </FieldContent>
              <Switch
                id={APIFY_ENABLE_SWITCH_ID}
                checked={enabled}
                disabled={enableDisabled}
                aria-describedby={enableHelpId}
                onCheckedChange={(on) =>
                  update((v) => ({ ...v, apifyEnabled: on }))
                }
              />
            </Field>
          </FieldLabel>

          {pool !== null && usable === 0 && (
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

          {enabled ? (
            <div className="flex flex-col gap-3">
              <Field
                data-invalid={!!errors.apifyRunMaxUsd || undefined}
                className="md:max-w-[calc(50%-0.75rem)]"
              >
                <FieldLabel htmlFor={APIFY_RUN_MAX_ID}>
                  {s.runMaxLabel}
                </FieldLabel>
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
            </div>
          ) : (
            usable > 0 && <Note>{s.disabledNote}</Note>
          )}
        </CardContent>
      </Card>
    </section>
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
