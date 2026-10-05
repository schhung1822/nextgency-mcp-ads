"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"

import { ContextualSaveBar, PageGuide, PageHeader, ReauthDialog } from "@/components/app"
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
import type { ActionResult } from "@/lib/action-result"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { legal as tl } from "@/lib/i18n/vi/legal"
import { settings as ts } from "@/lib/i18n/vi/settings"
import { LEGAL_CONTACT_EMAIL_MAX, LEGAL_ORG_NAME_MAX, LEGAL_PAGES } from "@/lib/legal"
import { REAUTH_REQUIRED_FIELD } from "@/lib/schemas/reauth"
import {
  isRelaxingSettingsChange,
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

type SaveResult = ActionResult<{ changed: string[]; values: SettingsFormValues }>

export function SettingsForm({
  initial,
  actorTwoFactor,
  legalDomain,
  children,
  after,
}: {
  initial: SettingsFormValues
  /** the admin has 2FA → the re-auth dialog also asks for the TOTP code */
  actorTwoFactor: boolean
  /** public domain: fallback operator name shown in the "Thông tin pháp lý" help text */
  legalDomain: string
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

  /** values waiting for the re-auth dialog (the change relaxes security or shortens log retention) */
  const [pendingValues, setPendingValues] =
    React.useState<SettingsFormValues | null>(null)

  /** form-field errors of a failed save, applied to the form; returns whether there were any */
  const applyFieldErrors = (r: Extract<SaveResult, { ok: false }>) => {
    const own = Object.entries(r.fieldErrors ?? {}).filter(
      ([k]) => k in initial
    )
    for (const [k, msg] of own) {
      form.setError(k as keyof SettingsFormInput, { message: msg })
    }
    return own.length > 0
  }

  const onSubmit = form.handleSubmit(async (values) => {
    const savedNow = settingsFormSchema.safeParse(
      form.formState.defaultValues ?? initial
    )
    const before = savedNow.success ? savedNow.data : initial
    if (isRelaxingSettingsChange(before, values)) {
      setPendingValues(values)
      return
    }
    const r = await updateSettingsAction(values)
    if (!r.ok) {
      // the server saw a relaxing change (e.g. another admin saved meanwhile): ask for the password
      if (r.fieldErrors?.[REAUTH_REQUIRED_FIELD]) {
        setPendingValues(values)
        return
      }
      applyFieldErrors(r)
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

  const textField = (
    name: "legal_org_name" | "legal_contact_email",
    label: string,
    help: React.ReactNode,
    input: React.ComponentProps<typeof Input>
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`settings-${name}`}>{label}</FieldLabel>
          <Input
            id={`settings-${name}`}
            aria-invalid={fieldState.invalid}
            name={field.name}
            ref={field.ref}
            onBlur={field.onBlur}
            value={typeof field.value === "string" ? field.value : ""}
            onChange={(e) => field.onChange(e.target.value)}
            {...input}
          />
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

            <Card>
              <CardHeader>
                <CardTitle>{ts.legal.title}</CardTitle>
                <CardDescription>{ts.legal.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  {textField(
                    "legal_org_name",
                    ts.legal.orgName,
                    ts.legal.orgNameHelp(legalDomain),
                    {
                      maxLength: LEGAL_ORG_NAME_MAX,
                      autoComplete: "organization",
                      placeholder: ts.legal.orgNamePlaceholder,
                    }
                  )}
                  {textField(
                    "legal_contact_email",
                    ts.legal.contactEmail,
                    ts.legal.contactEmailHelp,
                    {
                      type: "email",
                      inputMode: "email",
                      maxLength: LEGAL_CONTACT_EMAIL_MAX,
                      autoComplete: "email",
                      spellCheck: false,
                      placeholder: ts.legal.contactEmailPlaceholder,
                    }
                  )}
                </FieldGroup>
                <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                  <span>{ts.legal.pages}</span>
                  {LEGAL_PAGES.map((pg) => (
                    <a
                      key={pg.path}
                      href={pg.path}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex min-h-11 items-center rounded-sm font-medium text-brand-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-0"
                    >
                      {tl.nav[pg.key]}
                    </a>
                  ))}
                </p>
              </CardContent>
            </Card>
          </form>
          <div className="flex min-w-0 flex-col gap-4 sm:gap-6">{children}</div>
        </div>
        {after}
      </div>
      {pendingValues && (
        <ReauthDialog
          open
          onOpenChange={(o) => !o && setPendingValues(null)}
          twoFactorEnabled={actorTwoFactor}
          idPrefix="settings-reauth"
          texts={ts.reauth}
          onSubmit={(reauth) =>
            updateSettingsAction({ ...pendingValues, reauth })
          }
          onSuccess={(data, message) => {
            form.reset(data.values)
            toast.success(message ?? ts.saved)
          }}
          onFailure={(r) => {
            // invalid form values: close the dialog and show them on the form
            if (!applyFieldErrors(r)) return false
            toast.error(r.error)
            return true
          }}
        />
      )}
    </>
  )
}
