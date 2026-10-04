"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"

import { ContextualSaveBar, PageGuide, PageHeader } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { settings as ts } from "@/lib/i18n/vi/settings"
import {
  settingsFormSchema,
  type SettingsFormInput,
  type SettingsFormValues,
} from "@/lib/schemas/settings"
import { updateSettingsAction } from "@/server/actions/settings"

const FORM_ID = "settings-form"
const MAX_RETENTION_MONTHS = 24

function validMonths(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= MAX_RETENTION_MONTHS
    ? n
    : fallback
}

export function SettingsForm({
  initial,
  children,
  after,
}: {
  initial: SettingsFormValues
  /** read-only card rendered on the server next to the form (API versions) */
  children?: React.ReactNode
  /** read-only full-width section under the form row (system info) */
  after?: React.ReactNode
}) {
  const form = useForm<SettingsFormInput, unknown, SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: initial,
    mode: "onChange",
  })
  const { isDirty, isSubmitting } = form.formState
  const [mcpMonths, staffMonths] = useWatch({
    control: form.control,
    name: ["log_retention_months_mcp", "log_retention_months_staff"],
  })
  const saved = form.formState.defaultValues ?? initial
  // while the field is empty / out of range the help text and the warning keep using the saved value
  const mcpValid = validMonths(mcpMonths, Number(saved.log_retention_months_mcp))
  const staffValid = validMonths(
    staffMonths,
    Number(saved.log_retention_months_staff)
  )
  const shrinking =
    mcpValid < Number(saved.log_retention_months_mcp) ||
    staffValid < Number(saved.log_retention_months_staff)

  const onSubmit = form.handleSubmit(async (values) => {
    const r = await updateSettingsAction(values)
    if (!r.ok) {
      for (const [k, msg] of Object.entries(r.fieldErrors ?? {})) {
        form.setError(k as keyof SettingsFormInput, { message: msg })
      }
      toast.error(r.error)
      return
    }
    form.reset(r.data.values)
    toast.success(r.message ?? ts.saved)
  })

  const numberField = (
    name:
      | "log_retention_months_mcp"
      | "log_retention_months_staff"
      | "session_max_hours",
    label: string,
    help: React.ReactNode,
    max: number
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`settings-${name}`}>{label}</FieldLabel>
          <div>
            <Input
              id={`settings-${name}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              step={1}
              className="w-32 tabular-nums"
              aria-invalid={fieldState.invalid}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={
                field.value === undefined || field.value === null
                  ? ""
                  : String(field.value)
              }
              onChange={(e) =>
                field.onChange(
                  e.target.value === "" ? "" : Number(e.target.value)
                )
              }
            />
          </div>
          <FieldDescription>{help}</FieldDescription>
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  )

  return (
    <>
      {/* no header button: the single `brand` action is the contextual save bar's "Lưu" (shown when dirty) */}
      <PageGuide guide={tg.settings} />
      <PageHeader title={ts.title} description={ts.description} />
      <div className="flex flex-col gap-4 sm:gap-6">
        {/* top of the column: it appears right under the header and then sticks under the top bar while scrolling */}
        <ContextualSaveBar
          open={isDirty}
          formId={FORM_ID}
          saving={isSubmitting}
          onDiscard={() => form.reset()}
          className="mb-0"
        />
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-3 lg:items-start">
          <form
            id={FORM_ID}
            onSubmit={onSubmit}
            className="flex min-w-0 flex-col gap-4 sm:gap-6 lg:col-span-2"
            noValidate
          >
            <Card>
              <CardHeader>
                <CardTitle>{ts.retention.title}</CardTitle>
                <CardDescription>{ts.retention.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-6 sm:grid-cols-2">
                  {numberField(
                    "log_retention_months_mcp",
                    ts.retention.mcp,
                    ts.retention.help(mcpValid),
                    24
                  )}
                  {numberField(
                    "log_retention_months_staff",
                    ts.retention.staff,
                    ts.retention.help(staffValid),
                    24
                  )}
                </FieldGroup>
                {shrinking && (
                  <Alert className="mt-4 border-warning/40 bg-warning/10">
                    <AlertDescription className="text-warning-strong">
                      {ts.retention.shrinkWarning}
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{ts.security.title}</CardTitle>
                <CardDescription>{ts.security.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Controller
                    name="require_2fa_admin"
                    control={form.control}
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="settings-require-2fa-admin">
                            {ts.security.require2faAdmin}
                          </FieldLabel>
                          <FieldDescription>
                            {ts.security.require2faAdminHelp}
                          </FieldDescription>
                        </FieldContent>
                        <Switch
                          id="settings-require-2fa-admin"
                          name={field.name}
                          checked={Boolean(field.value)}
                          onCheckedChange={field.onChange}
                        />
                      </Field>
                    )}
                  />
                  <Controller
                    name="require_2fa_all"
                    control={form.control}
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="settings-require-2fa">
                            {ts.security.require2fa}
                          </FieldLabel>
                          <FieldDescription>
                            {ts.security.require2faHelp}
                          </FieldDescription>
                        </FieldContent>
                        <Switch
                          id="settings-require-2fa"
                          name={field.name}
                          checked={Boolean(field.value)}
                          onCheckedChange={field.onChange}
                        />
                      </Field>
                    )}
                  />
                  {numberField(
                    "session_max_hours",
                    ts.security.sessionHours,
                    ts.security.sessionHoursHelp,
                    168
                  )}
                </FieldGroup>
              </CardContent>
            </Card>
          </form>
          <div className="flex min-w-0 flex-col gap-4 sm:gap-6">{children}</div>
        </div>
        {after}
      </div>
    </>
  )
}
