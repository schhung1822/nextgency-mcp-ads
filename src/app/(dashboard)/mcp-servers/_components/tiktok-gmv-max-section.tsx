"use client"

// MCP form, step "Chọn quyền", TikTok card: the admin-only switch "Cho phép AI thay đổi GMV Max (TikTok Shop)"
// (settings.tiktokGmvMaxWrite, default off) + what each permission does to a GMV Max campaign. The warning is
// prominent when the TikTok accounts picked in step 2 have TikTok Shop / GMV Max (connections.meta.gmvMax, passed
// by the page) or the switch is on, compact (collapsible) otherwise. Staff see the switch locked unless an admin
// already turned it on (they may turn it off). The server enforces the admin rule on save - this is UI only.
import * as React from "react"
import {
  Alert02Icon,
  ArrowDown01Icon,
  InformationCircleIcon,
  SquareLock01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Rich } from "@/components/app/rich-text"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { PERMISSION_LABELS } from "@/lib/constants"
import { tiktokGmvMaxMcp as s } from "@/lib/i18n/vi/tiktok-gmv-max"
import type { McpFormValues } from "@/lib/schemas/mcp-servers"
import {
  gmvMaxSwitchState,
  selectedGmvMaxAccounts,
  type GmvMaxAccountFlags,
} from "@/lib/tiktok-gmv-max"
import type { Permission } from "@/server/mcp/types"
import type { SelectableConnection } from "@/server/services/mcp-servers"

import type { FormUpdater } from "./mcp-form-sections"

/** What the page knows about the viewer and the TikTok accounts in reach (server loader). */
export interface GmvMaxFormContext {
  /** the viewer is an admin: may turn the switch on */
  isAdmin: boolean
  /** ad_accounts.id → TikTok Shop / GMV Max shops (connection check summary) */
  flags: GmvMaxAccountFlags
}

/** id of the switch: the config tab scrolls to it when the server refuses a save on it */
export const GMV_MAX_SWITCH_ID = "mcp-tiktok-gmv-max-write"
const SWITCH_ID = GMV_MAX_SWITCH_ID
const NAMES_SHOWN = 3

/** One impact row per permission group, with "Đã cấp / Chưa cấp" for the TikTok permissions picked above. */
function ImpactList({ perms }: { perms: ReadonlySet<Permission> }) {
  const rows: { key: string; label: string; text: string; on: boolean; danger?: boolean }[] = [
    {
      key: "status",
      label: PERMISSION_LABELS.status,
      text: s.impact.status,
      on: perms.has("status"),
    },
    {
      key: "update",
      label: PERMISSION_LABELS.update,
      text: s.impact.update,
      on: perms.has("update"),
    },
    {
      key: "copy-create",
      label: s.copyCreateLabel,
      text: s.impact.copyCreate,
      on: perms.has("copy") || perms.has("create"),
      danger: true,
    },
    {
      key: "delete",
      label: PERMISSION_LABELS.delete,
      text: s.impact.delete,
      on: perms.has("delete"),
      danger: true,
    },
  ]
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li
          key={r.key}
          className="flex flex-col gap-1 rounded-lg bg-background/70 px-3 py-2 ring-1 ring-foreground/8 ring-inset"
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "font-medium text-foreground",
                r.danger && "text-destructive-strong"
              )}
            >
              {r.label}
            </span>
            <Badge
              variant={r.on ? "secondary" : "outline"}
              className={cn(
                "font-normal",
                r.on ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {r.on ? s.granted : s.notGranted}
            </Badge>
          </span>
          <span className="text-pretty text-muted-foreground">
            <Rich text={r.text} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Impact list + the rules that always apply (2-step confirmation; advanced: daily cap, basic: no create / copy)
 * + what is never done via MCP.
 */
function ImpactBody({
  perms,
  basic,
}: {
  perms: ReadonlySet<Permission>
  /** protection mode Cơ bản: no money caps, GMV Max create / copy are refused */
  basic: boolean
}) {
  return (
    <div className="flex flex-col gap-2.5 text-[13px] leading-5">
      <p className="text-pretty text-foreground/90">{s.impactIntro}</p>
      <ImpactList perms={perms} />
      <p className="text-pretty text-foreground/90">
        <Rich text={basic ? s.alwaysBasic : s.always} />
      </p>
      <p className="flex items-start gap-1.5 text-pretty text-muted-foreground">
        <HugeiconsIcon
          icon={InformationCircleIcon}
          strokeWidth={2}
          className="mt-0.5 size-3.5 shrink-0"
          aria-hidden
        />
        <span className="min-w-0">{s.notOpened}</span>
      </p>
    </div>
  )
}

export function TiktokGmvMaxBlock({
  values,
  update,
  connections,
  gmv,
  savedOn = false,
  error,
}: {
  values: McpFormValues
  update: FormUpdater
  connections: SelectableConnection[]
  gmv: GmvMaxFormContext
  /** value saved on the MCP being edited (create wizard: false) */
  savedOn?: boolean
  /** server refusal mapped onto the switch (settings.tiktokGmvMaxWrite) */
  error?: string
}) {
  const [open, setOpen] = React.useState(false)
  const checked = values.tiktokGmvMaxWrite
  const perms = new Set<Permission>(values.platforms.tiktok.permissions)
  const writes = [...perms].some((p) => p !== "read")
  const basic = values.protectionMode === "basic"
  const detected = selectedGmvMaxAccounts(values, connections, gmv.flags)
  const { disabled, locked } = gmvMaxSwitchState({
    isAdmin: gmv.isAdmin,
    savedOn,
    checked,
  })
  const prominent = detected.length > 0 || checked
  const names = detected
    .slice(0, NAMES_SHOWN)
    .map((a) => a.name)
    .join(", ")
  const helpId = `${SWITCH_ID}-help`

  return (
    <section
      aria-label={s.groupLabel}
      className="flex flex-col gap-3 border-t pt-4"
    >
      {/* the whole row is the label: a tap anywhere toggles the switch (unless locked) */}
      <FieldLabel
        htmlFor={SWITCH_ID}
        className={cn(
          "*:data-[slot=field]:p-3",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
          "has-data-checked:border-warning/50 has-data-checked:bg-warning/8 dark:has-data-checked:border-warning/40 dark:has-data-checked:bg-warning/10"
        )}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {s.switchLabel}
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
            <FieldDescription id={helpId} className="text-[13px] leading-snug">
              <Rich text={checked ? s.helpOn : s.helpOff} />
            </FieldDescription>
            {locked && (
              <FieldDescription className="text-[13px] leading-snug font-medium text-foreground/80">
                {s.staffLocked}
              </FieldDescription>
            )}
            {!gmv.isAdmin && savedOn && (
              <FieldDescription className="text-[13px] leading-snug">
                {s.staffCanTurnOff}
              </FieldDescription>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldContent>
          <Switch
            id={SWITCH_ID}
            checked={checked}
            disabled={disabled}
            aria-describedby={helpId}
            aria-invalid={error ? true : undefined}
            onCheckedChange={(on) =>
              update((v) => ({ ...v, tiktokGmvMaxWrite: on }))
            }
          />
        </Field>
      </FieldLabel>

      {prominent ? (
        <div
          role="note"
          className="flex flex-col gap-2.5 rounded-xl bg-warning/10 p-3 ring-1 ring-warning/35 ring-inset"
        >
          <p className="flex items-start gap-1.5 text-sm font-medium text-warning-strong">
            <HugeiconsIcon
              icon={Alert02Icon}
              strokeWidth={2}
              className="mt-0.5 size-4 shrink-0"
              aria-hidden
            />
            <span className="min-w-0 text-pretty">
              {detected.length > 0 ? s.detectedTitle : s.impactTitle}
            </span>
          </p>
          {detected.length > 0 && (
            <p className="text-[13px] leading-5 text-pretty text-foreground/90">
              {gmv.isAdmin
                ? s.detectedBody(
                    names,
                    detected.length - NAMES_SHOWN,
                    savedOn && checked
                  )
                : s.detectedBodyStaff(names, detected.length - NAMES_SHOWN)}
            </p>
          )}
          <ImpactBody perms={perms} basic={basic} />
        </div>
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-auto min-h-8 text-left whitespace-normal text-muted-foreground"
            >
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                aria-hidden
              />
              {s.impactToggle}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className={cn("transition-transform", open && "rotate-180")}
                aria-hidden
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 rounded-xl bg-muted/50 p-3">
              <ImpactBody perms={perms} basic={basic} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {checked && !writes && (
        <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <HugeiconsIcon
            icon={InformationCircleIcon}
            strokeWidth={2}
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden
          />
          <span className="min-w-0">
            <Rich text={s.readOnlyNote} />
          </span>
        </p>
      )}

      {checked && (perms.has("copy") || perms.has("create")) && (
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertTitle>{s.runsNowTitle}</AlertTitle>
          <AlertDescription className="text-foreground/80!">
            <span>
              <Rich text={s.runsNow} />
            </span>
          </AlertDescription>
        </Alert>
      )}
    </section>
  )
}
