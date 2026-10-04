"use client"

// Form sections shared by the create wizard (steps 1–4) and the config editor on the detail page.
// State is a plain McpFormValues object; validation uses the shared zod-based validators in
// src/lib/schemas/mcp-servers.ts (the same rules the server enforces).
import * as React from "react"
import Link from "next/link"
import {
  Add01Icon,
  Alert02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { PlatformIcon, StatusBadge } from "@/components/app"
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/mcp/segmented-control"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  PLATFORM_LABELS,
} from "@/lib/constants"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  MCP_CAP_FIELDS,
  MCP_LIMITS,
  MCP_PERMISSIONS,
  MCP_PLATFORMS,
  isoToExpiryDate,
  matchPermissionPreset,
  normalizePermissions,
  PERMISSION_PRESETS,
  parseIpList,
  type ConnectionDraft,
  type McpCapField,
  type McpFormValues,
  type PermissionPreset,
  type PlatformDraft,
  type StepErrors,
} from "@/lib/schemas/mcp-servers"
import type { Permission } from "@/server/mcp/types"
// the MCP form only ever deals with the platforms shipped in this build
import type { ReleasedPlatform as Platform } from "@/lib/platforms"
import type { SelectableConnection } from "@/server/services/mcp-servers"

export type FormUpdater = (fn: (prev: McpFormValues) => McpFormValues) => void

function setPlatform(
  update: FormUpdater,
  platform: Platform,
  fn: (d: PlatformDraft) => PlatformDraft
) {
  update((v) => ({
    ...v,
    platforms: { ...v.platforms, [platform]: fn(v.platforms[platform]) },
  }))
}

/** Platforms the user can pick (has ≥1 connection), in canonical order. */
export function availablePlatforms(
  connections: SelectableConnection[]
): Platform[] {
  return MCP_PLATFORMS.filter((p) => connections.some((c) => c.platform === p))
}

/** Currencies of the accounts currently in scope (for the per-currency daily budget cap). */
export function scopeCurrencies(
  values: McpFormValues,
  connections: SelectableConnection[]
): string[] {
  const byId = new Map(connections.map((c) => [c.id, c]))
  const out = new Set<string>()
  for (const p of MCP_PLATFORMS) {
    const d = values.platforms[p]
    if (!d.enabled) continue
    for (const c of d.connections) {
      const conn = byId.get(c.connectionId)
      if (!conn) continue
      for (const a of conn.accounts) {
        if (c.mode === "all" || c.accountIds.includes(a.id))
          out.add(a.currency.toUpperCase())
      }
    }
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// Step 1 - name + description
// ---------------------------------------------------------------------------
export function NameSection({
  values,
  update,
  errors,
  autoFocus,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  autoFocus?: boolean
}) {
  const s = t.nameStep
  return (
    <FieldGroup>
      <Field data-invalid={!!errors.name || undefined}>
        <FieldLabel htmlFor="mcp-name">{s.nameLabel}</FieldLabel>
        <Input
          id="mcp-name"
          value={values.name}
          maxLength={MCP_LIMITS.nameMax}
          placeholder={s.namePlaceholder}
          autoFocus={autoFocus}
          autoComplete="off"
          aria-invalid={!!errors.name || undefined}
          onChange={(e) => {
            const name = e.target.value
            update((v) => ({ ...v, name }))
          }}
        />
        <FieldDescription>{s.nameHelp}</FieldDescription>
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <Field data-invalid={!!errors.description || undefined}>
        <FieldLabel htmlFor="mcp-description">{s.descriptionLabel}</FieldLabel>
        <Textarea
          id="mcp-description"
          value={values.description}
          maxLength={MCP_LIMITS.descriptionMax}
          placeholder={s.descriptionPlaceholder}
          rows={3}
          aria-invalid={!!errors.description || undefined}
          onChange={(e) => {
            const description = e.target.value
            update((v) => ({ ...v, description }))
          }}
        />
        {errors.description && <FieldError>{errors.description}</FieldError>}
      </Field>
    </FieldGroup>
  )
}

// ---------------------------------------------------------------------------
// Step 2 - platforms, connections, accounts
// ---------------------------------------------------------------------------
function ConnectionScope({
  platform,
  conn,
  draft,
  update,
  error,
  pagesError,
}: {
  platform: Platform
  conn: SelectableConnection
  draft: ConnectionDraft | undefined
  update: FormUpdater
  error?: string
  pagesError?: string
}) {
  const s = t.platformsStep
  const checked = !!draft
  const id = `conn-${conn.id}`
  const toggle = (on: boolean) =>
    setPlatform(update, platform, (d) => ({
      ...d,
      connections: on
        ? [...d.connections, newConnectionDraft(platform, conn)]
        : d.connections.filter((c) => c.connectionId !== conn.id),
    }))
  const patch = (fn: (c: ConnectionDraft) => ConnectionDraft) =>
    setPlatform(update, platform, (d) => ({
      ...d,
      connections: d.connections.map((c) =>
        c.connectionId === conn.id ? fn(c) : c
      ),
    }))
  const unhealthy = conn.status === "invalid" || conn.status === "disabled"
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        checked && "border-brand-red/30 bg-brand-red/[0.03]"
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(v) => toggle(v === true)}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <Label
            htmlFor={id}
            className="flex flex-wrap items-center gap-2 font-medium"
          >
            <span className="truncate">{conn.name}</span>
            <StatusBadge kind="connection" status={conn.status} />
          </Label>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {s.accountCount(conn.accounts.length)}
            {!conn.isMine && ` · ${s.ownerSuffix(conn.ownerEmail)}`}
          </p>
        </div>
      </div>
      {checked && unhealthy && (
        <p className="mt-2 flex items-start gap-1.5 pl-7 text-[13px] text-warning-strong">
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden
          />
          {s.connectionStatusWarning}
        </p>
      )}
      {checked && draft && (
        <div className="mt-3 pl-7">
          <RadioGroup
            value={draft.mode}
            onValueChange={(mode) =>
              patch((c) => ({ ...c, mode: mode as ConnectionDraft["mode"] }))
            }
            className="gap-2"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="all" id={`${id}-all`} className="mt-0.5" />
              <Label
                htmlFor={`${id}-all`}
                className="flex flex-col items-start gap-0.5 font-normal"
              >
                <span className="font-medium">{s.accountsAll}</span>
                <span className="text-[13px] text-muted-foreground">
                  {s.accountsAllHelp}
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem
                value="pick"
                id={`${id}-pick`}
                className="mt-0.5"
                disabled={conn.accounts.length === 0}
              />
              <Label htmlFor={`${id}-pick`} className="font-medium">
                {s.accountsPick}
              </Label>
            </div>
          </RadioGroup>
          {conn.accounts.length === 0 && (
            <p className="mt-2 text-[13px] text-muted-foreground">
              {s.noEnabledAccounts}
            </p>
          )}
          {draft.mode === "pick" && conn.accounts.length > 0 && (
            <ul
              aria-label={s.accountsListLabel(conn.name)}
              className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border bg-card p-1"
            >
              {conn.accounts.map((a) => {
                const aid = `${id}-acc-${a.id}`
                const on = draft.accountIds.includes(a.id)
                return (
                  <li key={a.id}>
                    <label
                      htmlFor={aid}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <Checkbox
                        id={aid}
                        checked={on}
                        onCheckedChange={(v) =>
                          patch((c) => ({
                            ...c,
                            accountIds:
                              v === true
                                ? [...c.accountIds, a.id]
                                : c.accountIds.filter((x) => x !== a.id),
                          }))
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{a.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {a.externalId}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                        {a.currency}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {error && (
            <p className="mt-2 text-[13px] text-destructive">{error}</p>
          )}
          {platform === "meta" && (
            <PagesScope
              id={id}
              conn={conn}
              draft={draft}
              patch={patch}
              error={pagesError}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** A freshly ticked connection: all accounts; Meta → all enabled Pages when it has some, otherwise none. */
function newConnectionDraft(
  platform: Platform,
  conn: SelectableConnection
): ConnectionDraft {
  return {
    connectionId: conn.id,
    mode: "all",
    accountIds: [],
    ...(platform === "meta"
      ? {
          pagesMode: conn.pages.length > 0 ? ("all" as const) : ("none" as const),
          pageIds: [],
        }
      : {}),
  }
}

function PagesScope({
  id,
  conn,
  draft,
  patch,
  error,
}: {
  id: string
  conn: SelectableConnection
  draft: ConnectionDraft
  patch: (fn: (c: ConnectionDraft) => ConnectionDraft) => void
  error?: string
}) {
  const s = t.platformsStep
  const mode = draft.pagesMode ?? "none"
  const picked = draft.pageIds ?? []
  return (
    <div className="mt-4 border-t pt-3">
      <p className="text-sm font-medium">{s.pagesTitle}</p>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        {s.pageCount(conn.pages.length)}
      </p>
      {conn.pages.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          {s.noEnabledPages}
        </p>
      ) : (
        <>
          <RadioGroup
            value={mode}
            onValueChange={(v) =>
              patch((c) => ({
                ...c,
                pagesMode: v as NonNullable<ConnectionDraft["pagesMode"]>,
              }))
            }
            className="mt-2 gap-2"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem
                value="none"
                id={`${id}-pages-none`}
                className="mt-0.5"
              />
              <Label htmlFor={`${id}-pages-none`} className="font-medium">
                {s.pagesNone}
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem
                value="all"
                id={`${id}-pages-all`}
                className="mt-0.5"
              />
              <Label
                htmlFor={`${id}-pages-all`}
                className="flex flex-col items-start gap-0.5 font-normal"
              >
                <span className="font-medium">{s.pagesAll}</span>
                <span className="text-[13px] text-muted-foreground">
                  {s.pagesAllHelp}
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem
                value="pick"
                id={`${id}-pages-pick`}
                className="mt-0.5"
              />
              <Label htmlFor={`${id}-pages-pick`} className="font-medium">
                {s.pagesPick}
              </Label>
            </div>
          </RadioGroup>
          {mode === "pick" && (
            <ul
              aria-label={s.pagesListLabel(conn.name)}
              className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border bg-card p-1"
            >
              {conn.pages.map((p) => {
                const pid = `${id}-page-${p.id}`
                const on = picked.includes(p.id)
                return (
                  <li key={p.id}>
                    <label
                      htmlFor={pid}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <Checkbox
                        id={pid}
                        checked={on}
                        onCheckedChange={(v) =>
                          patch((c) => {
                            const cur = c.pageIds ?? []
                            return {
                              ...c,
                              pageIds:
                                v === true
                                  ? [...cur, p.id]
                                  : cur.filter((x) => x !== p.id),
                            }
                          })
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{p.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {p.externalId}
                          {!p.insights && ` · ${s.pageNoInsights}`}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
      {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
    </div>
  )
}

export function PlatformsSection({
  values,
  update,
  errors,
  connections,
  showAddLinks = true,
  layout = "stack",
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  connections: SelectableConnection[]
  showAddLinks?: boolean
  /** "stack": one card per row (wizard, predictable when a card opens) · "grid": 2 columns from `lg` (wide editor) */
  layout?: "stack" | "grid"
}) {
  const s = t.platformsStep
  const available = availablePlatforms(connections)
  const missing = MCP_PLATFORMS.filter((p) => !available.includes(p))
  return (
    <div className="flex flex-col gap-4">
      {errors.platforms && (
        <p role="alert" className="text-sm text-destructive">
          {errors.platforms}
        </p>
      )}
      <div
        className={cn(
          "grid items-start gap-4",
          layout === "grid" && "lg:grid-cols-2"
        )}
      >
        {available.map((p) => {
          const d = values.platforms[p]
          const conns = connections.filter((c) => c.platform === p)
          const switchId = `platform-${p}`
          return (
            <Card
              key={p}
              className={cn(
                "gap-0 py-0 transition-shadow",
                d.enabled && "ring-1 ring-brand-red/30"
              )}
            >
              <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3 [.border-b]:pb-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
                  <PlatformIcon platform={p} className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <Label htmlFor={switchId} className="text-base font-semibold">
                    {PLATFORM_LABELS[p]}
                  </Label>
                  {d.enabled && d.connections.length > 0 && (
                    <p className="text-[13px] text-muted-foreground">
                      {s.selectedSummary(
                        d.connections.length,
                        d.connections.every((c) => c.mode === "all")
                          ? s.allAccounts
                          : s.nAccounts(
                              d.connections.reduce(
                                (n, c) =>
                                  n +
                                  (c.mode === "all"
                                    ? (conns.find(
                                        (x) => x.id === c.connectionId
                                      )?.accounts.length ?? 0)
                                    : c.accountIds.length),
                                0
                              )
                            )
                      )}
                    </p>
                  )}
                </div>
                <Switch
                  id={switchId}
                  checked={d.enabled}
                  aria-label={s.enablePlatform(PLATFORM_LABELS[p])}
                  onCheckedChange={(on) =>
                    setPlatform(update, p, (prev) => ({
                      ...prev,
                      enabled: on,
                      // first time on with a single connection → preselect it ("all accounts")
                      connections:
                        on &&
                        prev.connections.length === 0 &&
                        conns.length === 1
                          ? [newConnectionDraft(p, conns[0]!)]
                          : prev.connections,
                    }))
                  }
                />
              </CardHeader>
              {d.enabled && (
                <CardContent className="flex flex-col gap-2 px-4 py-4">
                  <p className="text-sm font-medium">{s.connectionsLabel}</p>
                  {conns.map((c) => (
                    <ConnectionScope
                      key={c.id}
                      platform={p}
                      conn={c}
                      draft={d.connections.find((x) => x.connectionId === c.id)}
                      update={update}
                      error={errors[`platforms.${p}.${c.id}`]}
                      pagesError={errors[`platforms.${p}.${c.id}.pages`]}
                    />
                  ))}
                  {errors[`platforms.${p}`] && (
                    <p className="text-[13px] text-destructive">
                      {errors[`platforms.${p}`]}
                    </p>
                  )}
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>
      {showAddLinks && missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
          <span>{s.unavailablePlatforms}</span>
          {missing.map((p) => (
            <Button key={p} variant="ghost" size="sm" asChild>
              <Link href={`/connections/new?platform=${p}`}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                <PlatformIcon platform={p} />
                {s.addConnectionFor(PLATFORM_LABELS[p])}
              </Link>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3 - permissions per platform
// ---------------------------------------------------------------------------
const PRESET_LABELS: Record<PermissionPreset, string> = {
  readOnly: t.permissionsStep.presetReadOnly,
  operate: t.permissionsStep.presetOperate,
  fullNoDelete: t.permissionsStep.presetFull,
}
const PRESET_SHORT: Record<PermissionPreset, string> = {
  readOnly: t.permissionsStep.presetShort.readOnly,
  operate: t.permissionsStep.presetShort.operate,
  fullNoDelete: t.permissionsStep.presetShort.full,
}
const PRESET_HINTS: Record<PermissionPreset | "custom", string> = {
  readOnly: t.permissionsStep.presetHint.readOnly,
  operate: t.permissionsStep.presetHint.operate,
  fullNoDelete: t.permissionsStep.presetHint.full,
  custom: t.permissionsStep.presetHint.custom,
}
const PRESET_KEYS = Object.keys(PERMISSION_PRESETS) as PermissionPreset[]

export function PermissionsSection({
  values,
  update,
}: {
  values: McpFormValues
  update: FormUpdater
}) {
  const s = t.permissionsStep
  const enabled = MCP_PLATFORMS.filter((p) => values.platforms[p].enabled)
  if (enabled.length === 0)
    return <p className="text-sm text-muted-foreground">{s.noPlatforms}</p>
  const applyAll = (preset: PermissionPreset) =>
    update((v) => {
      const platforms = { ...v.platforms }
      for (const p of enabled)
        platforms[p] = {
          ...platforms[p],
          permissions: [...PERMISSION_PRESETS[preset]],
        }
      return { ...v, platforms }
    })
  return (
    <div className="flex flex-col gap-4">
      {enabled.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 p-3">
          <span className="text-sm text-muted-foreground">
            {s.applyPresetAll}:
          </span>
          {PRESET_KEYS.map((k) => (
            <Button
              key={k}
              type="button"
              variant="outline"
              size="sm"
              className="max-sm:h-10"
              title={PRESET_HINTS[k]}
              aria-label={PRESET_LABELS[k]}
              onClick={() => applyAll(k)}
            >
              {PRESET_SHORT[k]}
            </Button>
          ))}
        </div>
      )}
      {enabled.map((p) => {
        const perms = new Set<Permission>(values.platforms[p].permissions)
        const setPerms = (next: Permission[]) =>
          setPlatform(update, p, (d) => ({
            ...d,
            permissions: normalizePermissions(next),
          }))
        const active = matchPermissionPreset([...perms])
        const presetOptions: SegmentedOption<PermissionPreset | "custom">[] = [
          ...PRESET_KEYS.map((k) => ({
            value: k,
            label: PRESET_SHORT[k],
            ariaLabel: PRESET_LABELS[k],
          })),
          // only shown while the permissions below don't match a preset
          ...(active === null
            ? [{ value: "custom" as const, label: s.presetShort.custom }]
            : []),
        ]
        return (
          <Card key={p} className="gap-4">
            <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <PlatformIcon platform={p} className="size-5" />
                {PLATFORM_LABELS[p]}
              </CardTitle>
              <SegmentedControl
                fill="mobile"
                ariaLabel={s.presetsLabel(PLATFORM_LABELS[p])}
                value={active ?? "custom"}
                options={presetOptions}
                onValueChange={(k) => {
                  if (k !== "custom") setPerms([...PERMISSION_PRESETS[k]])
                }}
              />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-[13px] text-muted-foreground">
                {PRESET_HINTS[active ?? "custom"]}
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {MCP_PERMISSIONS.map((perm) => {
                  const id = `perm-${p}-${perm}`
                  const isRead = perm === "read"
                  const on = isRead || perms.has(perm)
                  return (
                    <Field
                      key={perm}
                      orientation="horizontal"
                      className={cn(
                        "rounded-xl border px-3 py-2.5",
                        perm === "delete" &&
                          on &&
                          "border-destructive/40 bg-destructive/5"
                      )}
                    >
                      <Checkbox
                        id={id}
                        checked={on}
                        disabled={isRead}
                        onCheckedChange={(v) =>
                          setPerms(
                            v === true
                              ? [...perms, perm]
                              : [...perms].filter((x) => x !== perm)
                          )
                        }
                      />
                      <FieldContent className="gap-0.5">
                        <FieldLabel
                          htmlFor={id}
                          className={cn(
                            perm === "delete" && "text-destructive-strong"
                          )}
                        >
                          {PERMISSION_LABELS[perm]}
                          {isRead && (
                            <span className="text-xs font-normal text-muted-foreground">
                              ({s.alwaysOn})
                            </span>
                          )}
                        </FieldLabel>
                        <FieldDescription className="text-[13px] leading-snug">
                          {PERMISSION_DESCRIPTIONS[perm]}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  )
                })}
              </div>
              {perms.has("delete") && (
                <Alert variant="destructive">
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={2}
                    aria-hidden
                  />
                  <AlertDescription>{s.deleteWarning}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4 - protection (settings)
// ---------------------------------------------------------------------------

function GroupHeading({
  id,
  title,
  description,
}: {
  id: string
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {description && (
        <p className="text-[13px] text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

/** One bordered row per currency in scope, three aligned inputs (daily budget · lifetime budget · bid). */
function CurrencyCapsRow({
  cur,
  values,
  update,
  errors,
}: {
  cur: string
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
}) {
  const s = t.protectionStep
  const fields: {
    field: McpCapField
    label: string
    placeholder: string
  }[] = [
    {
      field: "maxDailyBudget",
      label: s.capDaily,
      placeholder: s.maxBudgetPlaceholder,
    },
    {
      field: "maxLifetimeBudget",
      label: s.capLifetime,
      placeholder: s.maxLifetimePlaceholder,
    },
    { field: "maxBid", label: s.capBid, placeholder: s.maxBudgetPlaceholder },
  ]
  return (
    <div
      role="group"
      aria-label={s.capCurrencyTitle(cur)}
      className="rounded-xl border p-4"
    >
      <p className="mb-3 flex items-center gap-2 text-sm font-medium">
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">
          {cur}
        </span>
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        {fields.map(({ field, label, placeholder }) => {
          const key = `${field}.${cur}`
          const inputId = `mcp-${field}-${cur}`
          return (
            <Field
              key={field}
              data-invalid={!!errors[key] || undefined}
              className="gap-1.5"
            >
              <FieldLabel htmlFor={inputId} className="text-[13px]">
                {label}
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={inputId}
                  inputMode="decimal"
                  aria-label={`${label} (${cur})`}
                  placeholder={placeholder}
                  value={values[field][cur] ?? ""}
                  aria-invalid={!!errors[key] || undefined}
                  onChange={(e) => {
                    const text = e.target.value
                    update((v) => ({
                      ...v,
                      [field]: { ...v[field], [cur]: text },
                    }))
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText className="font-mono">{cur}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              {errors[key] && <FieldError>{errors[key]}</FieldError>}
            </Field>
          )
        })}
      </div>
    </div>
  )
}

const EXPIRY_PRESET_DAYS = { d30: 30, d90: 90, y1: 365 } as const
type ExpiryPreset = "none" | keyof typeof EXPIRY_PRESET_DAYS

function ExpiryField({
  values,
  update,
  errors,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
}) {
  const s = t.protectionStep
  // the quick option the user clicked, valid only while the date still equals what it set
  const [quick, setQuick] = React.useState<{
    key: Exclude<ExpiryPreset, "none">
    date: string
  } | null>(null)
  const active: ExpiryPreset | "" =
    values.expiresOn === ""
      ? "none"
      : quick && quick.date === values.expiresOn
        ? quick.key
        : ""
  const options: SegmentedOption<ExpiryPreset>[] = [
    { value: "none", label: s.expiryPresets.none },
    { value: "d30", label: s.expiryPresets.d30 },
    { value: "d90", label: s.expiryPresets.d90 },
    { value: "y1", label: s.expiryPresets.y1 },
  ]
  return (
    <Field data-invalid={!!errors.expiresOn || undefined}>
      <FieldLabel htmlFor="mcp-expires">{s.expiresLabel}</FieldLabel>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SegmentedControl
          fill="mobile"
          ariaLabel={s.expiryPresetsLabel}
          value={active}
          options={options}
          onValueChange={(key) => {
            if (key === "none") {
              setQuick(null)
              update((v) => ({ ...v, expiresOn: "" }))
              return
            }
            const date = isoToExpiryDate(
              new Date(Date.now() + EXPIRY_PRESET_DAYS[key] * 86_400_000)
            )
            setQuick({ key, date })
            update((v) => ({ ...v, expiresOn: date }))
          }}
        />
        <Input
          id="mcp-expires"
          type="date"
          aria-label={s.expiryPickLabel}
          className="w-full sm:w-44"
          value={values.expiresOn}
          aria-invalid={!!errors.expiresOn || undefined}
          onChange={(e) => {
            const expiresOn = e.target.value
            update((v) => ({ ...v, expiresOn }))
          }}
        />
      </div>
      <FieldDescription>{s.expiresHelp}</FieldDescription>
      {errors.expiresOn && <FieldError>{errors.expiresOn}</FieldError>}
    </Field>
  )
}

export function ProtectionSection({
  values,
  update,
  errors,
  connections,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  connections: SelectableConnection[]
}) {
  const s = t.protectionStep
  const derived = scopeCurrencies(values, connections)
  // currencies in scope + any currency that already has a cap (so a saved cap never disappears)
  const currencies = [
    ...new Set([
      ...derived,
      ...MCP_CAP_FIELDS.flatMap((f) =>
        Object.entries(values[f])
          .filter(([, v]) => v.trim() !== "")
          .map(([k]) => k)
      ),
    ]),
  ].sort()
  const ipCount = parseIpList(values.allowedIpsText).length
  return (
    <div className="flex flex-col gap-8">
      {/* 1 · safety */}
      <section aria-labelledby="prot-safety" className="flex flex-col gap-5">
        <GroupHeading
          id="prot-safety"
          title={s.groupSafety}
          description={s.groupSafetyDesc}
        />
        <Field orientation="horizontal" className="rounded-xl border p-4">
          <FieldContent>
            <FieldLabel htmlFor="mcp-two-step">{s.twoStepLabel}</FieldLabel>
            <FieldDescription>{s.twoStepHelp}</FieldDescription>
            {!values.twoStepConfirm && (
              <p className="flex items-start gap-1.5 text-[13px] text-warning-strong">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  strokeWidth={2}
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
                {s.twoStepOffWarning}
              </p>
            )}
          </FieldContent>
          <Switch
            id="mcp-two-step"
            checked={values.twoStepConfirm}
            onCheckedChange={(on) =>
              update((v) => ({ ...v, twoStepConfirm: on }))
            }
          />
        </Field>

        <Field data-invalid={!!errors.budgetChangeMaxPct || undefined}>
          <FieldLabel htmlFor="mcp-budget-pct">{s.budgetPctLabel}</FieldLabel>
          <InputGroup className="max-w-48">
            <InputGroupInput
              id="mcp-budget-pct"
              inputMode="numeric"
              value={values.budgetChangeMaxPct}
              aria-invalid={!!errors.budgetChangeMaxPct || undefined}
              onChange={(e) => {
                const budgetChangeMaxPct = e.target.value.replace(/[^\d]/g, "")
                update((v) => ({ ...v, budgetChangeMaxPct }))
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{s.percentSuffix}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>{s.budgetPctHelp}</FieldDescription>
          {errors.budgetChangeMaxPct && (
            <FieldError>{errors.budgetChangeMaxPct}</FieldError>
          )}
        </Field>
      </section>

      <Separator />

      {/* 2 · money caps per currency */}
      <section aria-labelledby="prot-spend" className="flex flex-col gap-4">
        <GroupHeading
          id="prot-spend"
          title={s.groupSpend}
          description={s.groupSpendDesc}
        />
        {currencies.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            {s.maxBudgetNoCurrency}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {currencies.map((cur) => (
              <CurrencyCapsRow
                key={cur}
                cur={cur}
                values={values}
                update={update}
                errors={errors}
              />
            ))}
          </div>
        )}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="-ml-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                aria-hidden
              />
              {s.capsHelpToggle}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-2 flex flex-col gap-3 rounded-xl bg-muted/50 p-3 text-[13px] text-muted-foreground">
              <div>
                <dt className="font-medium text-foreground">{s.capDaily}</dt>
                <dd>{s.maxBudgetHelp}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">{s.capLifetime}</dt>
                <dd>{s.maxLifetimeHelp}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">{s.capBid}</dt>
                <dd>{s.maxBidHelp}</dd>
              </div>
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <Separator />

      {/* 3 · request rate */}
      <section aria-labelledby="prot-rate" className="flex flex-col gap-4">
        <GroupHeading
          id="prot-rate"
          title={s.groupRate}
          description={s.groupRateDesc}
        />
        <div className="grid gap-6 md:grid-cols-2">
          <Field data-invalid={!!errors.rateLimitPerMin || undefined}>
            <FieldLabel htmlFor="mcp-rate">{s.rateLimitLabel}</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="mcp-rate"
                inputMode="numeric"
                value={values.rateLimitPerMin}
                aria-invalid={!!errors.rateLimitPerMin || undefined}
                onChange={(e) => {
                  const rateLimitPerMin = e.target.value.replace(/[^\d]/g, "")
                  update((v) => ({ ...v, rateLimitPerMin }))
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>{s.perMinuteSuffix}</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>{s.rateLimitHelp}</FieldDescription>
            {errors.rateLimitPerMin && (
              <FieldError>{errors.rateLimitPerMin}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!errors.writeRateLimitPer10Min || undefined}>
            <FieldLabel htmlFor="mcp-write-rate">{s.writeRateLabel}</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="mcp-write-rate"
                inputMode="numeric"
                value={values.writeRateLimitPer10Min}
                aria-invalid={!!errors.writeRateLimitPer10Min || undefined}
                onChange={(e) => {
                  const writeRateLimitPer10Min = e.target.value.replace(
                    /[^\d]/g,
                    ""
                  )
                  update((v) => ({ ...v, writeRateLimitPer10Min }))
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>{s.perTenMinutesSuffix}</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>{s.writeRateHelp}</FieldDescription>
            {errors.writeRateLimitPer10Min && (
              <FieldError>{errors.writeRateLimitPer10Min}</FieldError>
            )}
          </Field>
        </div>
      </section>

      <Separator />

      {/* 4 · expiry + IP allowlist */}
      <section aria-labelledby="prot-access" className="flex flex-col gap-5">
        <GroupHeading
          id="prot-access"
          title={s.groupAccess}
          description={s.groupAccessDesc}
        />
        <ExpiryField values={values} update={update} errors={errors} />

        <Field data-invalid={!!errors.allowedIps || undefined}>
          <FieldLabel htmlFor="mcp-ips">
            {s.allowedIpsLabel}
            {ipCount > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                {s.ipCount(ipCount)}
              </span>
            )}
          </FieldLabel>
          <Textarea
            id="mcp-ips"
            rows={4}
            className="font-mono text-[13px]"
            placeholder={s.allowedIpsPlaceholder}
            value={values.allowedIpsText}
            aria-invalid={!!errors.allowedIps || undefined}
            onChange={(e) => {
              const allowedIpsText = e.target.value
              update((v) => ({ ...v, allowedIpsText }))
            }}
          />
          <FieldDescription>{s.allowedIpsHelp}</FieldDescription>
          {errors.allowedIps && <FieldError>{errors.allowedIps}</FieldError>}
          <Alert
            className={cn(ipCount > 0 && "border-warning/40 bg-warning/10")}
          >
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertDescription
              className={cn(ipCount > 0 && "text-warning-strong")}
            >
              {s.allowedIpsWarning}
            </AlertDescription>
          </Alert>
        </Field>
      </section>
    </div>
  )
}
export function SectionCard({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
