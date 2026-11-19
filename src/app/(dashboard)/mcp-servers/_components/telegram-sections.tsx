"use client"

// Telegram blocks of the MCP form (14-telegram-notifications.md §6), shared by the create wizard and the config
// editor: step 2 channel picker, step 3 switches ("AI được gửi tin" / "Tự báo khi AI thay đổi quảng cáo"),
// step 4 hourly limit. Options come from the server (listChannelsForMcpScope) - never a token or chat id.
import Link from "next/link"
import { Add01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { BrandIcon, StatusBadge } from "@/components/app"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
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
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type { McpFormValues, StepErrors } from "@/lib/schemas/mcp-servers"
import type { McpChannelOption } from "@/lib/schemas/notifications"

import type { FormUpdater } from "./mcp-form-sections"

const s = t.telegram

/** "Thông báo (không bắt buộc)": separates the Telegram block from the ad platforms above it. */
function OptionalGroupHeading() {
  return (
    <h3 className="text-sm font-semibold text-muted-foreground">
      {s.optionalGroup}
    </h3>
  )
}

/** Card header in the style of the platform cards (icon tile + title + optional right-hand meta). */
function TelegramCardHeader({
  id,
  title,
  description,
  aside,
}: {
  id: string
  title: string
  description?: string
  aside?: React.ReactNode
}) {
  return (
    <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3 [.border-b]:pb-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <BrandIcon brand="telegram" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h4 id={id} className="text-base font-semibold">
          {title}
        </h4>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      {aside}
    </CardHeader>
  )
}

/** Step 2: which Telegram connections the MCP may use. */
export function TelegramChannelsSection({
  values,
  update,
  errors,
  channels,
  ownerNote,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  channels: McpChannelOption[]
  /** shown when the MCP belongs to somebody other than the viewer (only that person's channels are listed) */
  ownerNote?: string
}) {
  const selected = new Set(values.notificationChannelIds)
  const owners = new Set(channels.map((c) => c.owner.id))
  const toggle = (id: string, on: boolean) =>
    update((v) => ({
      ...v,
      notificationChannelIds: on
        ? [...new Set([...v.notificationChannelIds, id])]
        : v.notificationChannelIds.filter((x) => x !== id),
    }))
  const anyBroken = channels.some(
    (c) => selected.has(c.id) && c.status !== "active"
  )
  return (
    <section
      aria-labelledby="mcp-telegram-channels"
      className="flex flex-col gap-3"
    >
      <OptionalGroupHeading />
      <Card
        className={cn(
          "gap-0 py-0 transition-shadow",
          selected.size > 0 && "ring-1 ring-brand-primary/30"
        )}
      >
        <TelegramCardHeader
          id="mcp-telegram-channels"
          title={s.title}
          aside={
            selected.size > 0 ? (
              <span className="shrink-0 text-[13px] text-muted-foreground">
                {s.selectedCount(selected.size)}
              </span>
            ) : undefined
          }
        />
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          <p className="text-[13px] text-muted-foreground">{s.description}</p>
          {ownerNote && (
            <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden
              />
              {ownerNote}
            </p>
          )}
          {channels.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">{s.emptyTitle}</p>
                <p className="text-[13px] text-muted-foreground">
                  {s.emptyDescription}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/connections/telegram/new">
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                  {s.addChannel}
                </Link>
              </Button>
            </div>
          ) : (
            <div
              role="group"
              aria-label={s.channelsLabel}
              className="grid gap-2 lg:grid-cols-2"
            >
              {channels.map((c) => {
                const id = `mcp-tg-${c.id}`
                const on = selected.has(c.id)
                const meta = [
                  c.chatTitle,
                  c.hasThread ? s.thread : null,
                  owners.size > 1 ? s.ownerSuffix(c.owner.email) : null,
                ].filter(Boolean)
                return (
                  // the whole row is the label: a tap anywhere toggles the checkbox
                  <FieldLabel
                    key={c.id}
                    htmlFor={id}
                    className={cn(
                      "cursor-pointer *:data-[slot=field]:px-3 *:data-[slot=field]:py-2.5",
                      on &&
                        "border-brand-primary/30 bg-brand-primary/5 dark:border-brand-primary/30 dark:bg-brand-primary/10"
                    )}
                  >
                    <Field orientation="horizontal">
                      <Checkbox
                        id={id}
                        checked={on}
                        onCheckedChange={(v) => toggle(c.id, v === true)}
                      />
                      <FieldContent className="min-w-0 gap-0.5">
                        <FieldTitle className="flex flex-wrap items-center gap-1.5">
                          <span className="break-words">{c.name}</span>
                          {c.status !== "active" && (
                            <StatusBadge
                              kind="connection"
                              status={
                                c.status === "error" ? "invalid" : "disabled"
                              }
                              label={
                                c.status === "error"
                                  ? s.statusError
                                  : s.statusDisabled
                              }
                            />
                          )}
                        </FieldTitle>
                        {meta.length > 0 && (
                          <FieldDescription className="text-[13px] leading-snug break-words">
                            {meta.join(" · ")}
                          </FieldDescription>
                        )}
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                )
              })}
            </div>
          )}
          {anyBroken && (
            <p className="text-[13px] text-warning-strong">{s.statusHint}</p>
          )}
          {errors.notificationChannelIds && (
            <p role="alert" className="text-[13px] text-destructive">
              {errors.notificationChannelIds}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

/** Step 3: what the AI may do with the selected Telegram connections. */
export function TelegramPermissionsSection({
  values,
  update,
}: {
  values: McpFormValues
  update: FormUpdater
}) {
  const n = values.notificationChannelIds.length
  const rows = [
    {
      id: "mcp-tg-tool",
      label: s.toolLabel,
      help: s.toolHelp,
      checked: values.telegramTool,
      set: (on: boolean) => update((v) => ({ ...v, telegramTool: on })),
    },
    {
      id: "mcp-tg-notify",
      label: s.notifyLabel,
      help: s.notifyHelp,
      checked: values.telegramNotifyWrites,
      set: (on: boolean) =>
        update((v) => ({ ...v, telegramNotifyWrites: on })),
    },
  ]
  return (
    <section
      aria-labelledby="mcp-telegram-perms"
      className="flex flex-col gap-3"
    >
      <OptionalGroupHeading />
      <Card className="gap-0 py-0">
        <TelegramCardHeader
          id="mcp-telegram-perms"
          title={s.permissionsTitle}
          description={n > 0 ? s.permissionsDescription(n) : undefined}
        />
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          {n === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {s.noChannelsSelected}
            </p>
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              {rows.map((r) => (
                // the whole row is the label: a tap anywhere toggles the switch
                <FieldLabel
                  key={r.id}
                  htmlFor={r.id}
                  className="cursor-pointer *:data-[slot=field]:p-3"
                >
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{r.label}</FieldTitle>
                      <FieldDescription className="text-[13px] leading-snug">
                        {r.help}
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id={r.id}
                      checked={r.checked}
                      onCheckedChange={r.set}
                    />
                  </Field>
                </FieldLabel>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

/** Step 4: hourly limit of the AI's own Telegram messages (shown once a Telegram connection is selected). */
export function TelegramLimitSection({
  values,
  update,
  errors,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
}) {
  return (
    <section
      aria-labelledby="prot-telegram"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id="prot-telegram" className="text-sm font-semibold">
          {s.groupTitle}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {s.groupDescription}
        </p>
      </div>
      <Field
        data-invalid={!!errors.telegramMessagesPerHour || undefined}
        className="md:max-w-[calc(50%-0.75rem)]"
      >
        <FieldLabel htmlFor="mcp-tg-per-hour">{s.perHourLabel}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="mcp-tg-per-hour"
            inputMode="numeric"
            value={values.telegramMessagesPerHour}
            aria-invalid={!!errors.telegramMessagesPerHour || undefined}
            onChange={(e) => {
              const telegramMessagesPerHour = e.target.value.replace(
                /[^\d]/g,
                ""
              )
              update((v) => ({ ...v, telegramMessagesPerHour }))
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{s.perHourSuffix}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>{s.perHourHelp}</FieldDescription>
        {errors.telegramMessagesPerHour && (
          <FieldError>{errors.telegramMessagesPerHour}</FieldError>
        )}
      </Field>
    </section>
  )
}
