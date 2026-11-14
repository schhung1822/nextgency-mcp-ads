"use client"

// MCP form, step "Chọn quyền", Meta card: the admin-only switch "Cho phép AI đọc tin nhắn Messenger của Trang"
// (settings.metaPageMessages, default off, 11-meta-pages.md §13). Shown when a Meta connection of step 2 grants Pages.
// Staff see it locked unless an admin already turned it on (they may turn it off). The server enforces the admin rule,
// the re-authentication and the "no wider Page scope" rule on save - this is UI only.
import { InformationCircleIcon, SquareLock01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Rich } from "@/components/app/rich-text"
import { Badge } from "@/components/ui/badge"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type { McpFormValues } from "@/lib/schemas/mcp-servers"
import { gmvMaxSwitchState } from "@/lib/tiktok-gmv-max"

import type { FormUpdater } from "./mcp-form-sections"

const s = t.metaMessages

/** id of the switch: the config tab scrolls to it when the server refuses a save on it */
export const META_MESSAGES_SWITCH_ID = "mcp-meta-page-messages"

/** At least one Meta connection of the form grants Pages (all or a non-empty pick). */
export function formHasPages(values: McpFormValues): boolean {
  const meta = values.platforms.meta
  return (
    meta.enabled &&
    meta.connections.some((c) => c.pagesMode === "all" || (c.pagesMode === "pick" && (c.pageIds?.length ?? 0) > 0))
  )
}

export function MetaMessagesBlock({
  values,
  update,
  isAdmin,
  savedOn = false,
  error,
}: {
  values: McpFormValues
  update: FormUpdater
  /** the viewer is an admin: may turn the switch on */
  isAdmin: boolean
  /** value saved on the MCP being edited (create wizard: false) */
  savedOn?: boolean
  /** server refusal mapped onto the switch (settings.metaPageMessages) */
  error?: string
}) {
  const checked = values.metaPageMessages
  const hasPages = formHasPages(values)
  // nothing to show: no Page picked and the switch is off
  if (!hasPages && !checked && !error) return null
  const { disabled, locked } = gmvMaxSwitchState({ isAdmin, savedOn, checked })
  const helpId = `${META_MESSAGES_SWITCH_ID}-help`
  return (
    <section aria-label={s.groupLabel} className="flex flex-col gap-3 border-t pt-4">
      {/* the whole row is the label: a tap anywhere toggles the switch (unless locked) */}
      <FieldLabel
        htmlFor={META_MESSAGES_SWITCH_ID}
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
                <HugeiconsIcon icon={SquareLock01Icon} strokeWidth={2} data-icon="inline-start" aria-hidden />
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
            {!isAdmin && savedOn && (
              <FieldDescription className="text-[13px] leading-snug">{s.staffCanTurnOff}</FieldDescription>
            )}
            {checked && !hasPages && (
              <FieldDescription className="text-[13px] leading-snug">{s.noPages}</FieldDescription>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldContent>
          <Switch
            id={META_MESSAGES_SWITCH_ID}
            checked={checked}
            disabled={disabled}
            aria-describedby={helpId}
            aria-invalid={error ? true : undefined}
            onCheckedChange={(on) => update((v) => ({ ...v, metaPageMessages: on }))}
          />
        </Field>
      </FieldLabel>
      {checked && (
        <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{s.tokenNote}</span>
        </p>
      )}
    </section>
  )
}
