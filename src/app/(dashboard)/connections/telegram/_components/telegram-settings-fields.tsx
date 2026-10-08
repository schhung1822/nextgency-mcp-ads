"use client"

// Shared fields of the Telegram channel form (new page + detail "Cài đặt" card): name, chat id, thread id,
// system events, admin-only "all connections". The bot token field lives in the new page only.
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
} from "react-hook-form"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
} from "@/lib/schemas/notifications"

export interface TelegramSettingsValues {
  name: string
  chatId: string
  messageThreadId: string
  events: NotificationEvent[]
  allConnections: boolean
}

export function TelegramSettingsFields<T extends FieldValues & TelegramSettingsValues>({
  control,
  isAdmin,
  idPrefix = "tg",
  /** rendered between the name and the chat id (the bot token on the new page) */
  afterName,
}: {
  control: Control<T>
  isAdmin: boolean
  idPrefix?: string
  afterName?: React.ReactNode
}) {
  const p = (k: keyof TelegramSettingsValues) => k as Path<T>
  // staff never see the admin-only event (the server refuses it anyway)
  const events = NOTIFICATION_EVENTS.filter(
    (e) => isAdmin || e !== "system_update"
  )
  return (
    <FieldGroup className="gap-5">
      <Controller
        control={control}
        name={p("name")}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={`${idPrefix}-name`}>{m.form.nameLabel}</FieldLabel>
            <Input
              {...field}
              id={`${idPrefix}-name`}
              value={(field.value as string) ?? ""}
              placeholder={m.form.namePlaceholder}
              autoComplete="off"
              aria-invalid={fieldState.invalid || undefined}
            />
            <FieldDescription>{m.form.nameHelp}</FieldDescription>
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />

      {afterName}

      <Controller
        control={control}
        name={p("chatId")}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={`${idPrefix}-chat`}>{m.form.chatIdLabel}</FieldLabel>
            <Input
              {...field}
              id={`${idPrefix}-chat`}
              value={(field.value as string) ?? ""}
              placeholder={m.form.chatIdPlaceholder}
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              className="font-mono"
              aria-invalid={fieldState.invalid || undefined}
            />
            <FieldDescription>{m.form.chatIdHelp}</FieldDescription>
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />

      <Controller
        control={control}
        name={p("messageThreadId")}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={`${idPrefix}-thread`}>
              {m.form.threadLabel}
              <span className="font-normal text-muted-foreground">
                {m.form.optional}
              </span>
            </FieldLabel>
            <Input
              {...field}
              id={`${idPrefix}-thread`}
              value={(field.value as string) ?? ""}
              placeholder={m.form.threadPlaceholder}
              autoComplete="off"
              inputMode="numeric"
              className="font-mono sm:max-w-60"
              aria-invalid={fieldState.invalid || undefined}
            />
            <FieldDescription>{m.form.threadHelp}</FieldDescription>
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />

      <Controller
        control={control}
        name={p("events")}
        render={({ field, fieldState }) => {
          const value = (field.value as NotificationEvent[]) ?? []
          return (
            <FieldSet data-invalid={fieldState.invalid || undefined}>
              <FieldLegend variant="label">{m.form.eventsLabel}</FieldLegend>
              <FieldDescription>{m.form.eventsHelp}</FieldDescription>
              <FieldGroup data-slot="checkbox-group" className="gap-3">
                {events.map((e) => (
                  <Field key={e} orientation="horizontal">
                    <Checkbox
                      id={`${idPrefix}-ev-${e}`}
                      checked={value.includes(e)}
                      onCheckedChange={(on) =>
                        field.onChange(
                          on === true
                            ? [...value.filter((x) => x !== e), e]
                            : value.filter((x) => x !== e)
                        )
                      }
                    />
                    <FieldContent>
                      <FieldLabel
                        htmlFor={`${idPrefix}-ev-${e}`}
                        className="font-normal"
                      >
                        {m.ui.events[e].label}
                        {e === "system_update" && (
                          <Badge
                            variant="secondary"
                            className="rounded-full text-xs"
                          >
                            {m.ui.adminOnly}
                          </Badge>
                        )}
                      </FieldLabel>
                      <FieldDescription>{m.ui.events[e].help}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </FieldGroup>
              <FieldError errors={[fieldState.error]} />
            </FieldSet>
          )
        }}
      />

      {isAdmin && (
        <Controller
          control={control}
          name={p("allConnections")}
          render={({ field, fieldState }) => (
            <Field
              orientation="horizontal"
              data-invalid={fieldState.invalid || undefined}
            >
              <FieldContent>
                <FieldLabel htmlFor={`${idPrefix}-all`}>
                  {m.form.allConnectionsLabel}
                  <Badge variant="secondary" className="rounded-full text-xs">
                    {m.ui.adminOnly}
                  </Badge>
                </FieldLabel>
                <FieldDescription>{m.form.allConnectionsHelp}</FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </FieldContent>
              <Switch
                id={`${idPrefix}-all`}
                checked={field.value === true}
                onCheckedChange={(on) => field.onChange(on)}
              />
            </Field>
          )}
        />
      )}
    </FieldGroup>
  )
}
