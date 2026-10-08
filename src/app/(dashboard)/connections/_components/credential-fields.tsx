"use client"

// Dynamic credential form generated from a provider's CredentialFieldSpec[] (react-hook-form).
// Secrets use SecretInput and are NEVER prefilled from stored values.
import { Controller, useWatch, type Control, type FieldValues, type Path } from "react-hook-form"

import { SecretInput } from "@/components/app"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { connections as m } from "@/lib/i18n/vi/connections"
import { isFieldVisible, type PlatformFormSpec } from "@/lib/schemas/connections"

export type CredentialField = PlatformFormSpec["fields"][number]

/** Initial values: selects default to their first option, everything else empty. */
export function initialCredentialValues(fields: CredentialField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) out[f.key] = f.type === "select" ? (f.options?.[0]?.value ?? "") : ""
  return out
}

export interface CredentialFieldsProps<T extends FieldValues> {
  fields: CredentialField[]
  control: Control<T>
  /** form path prefix holding the credential record, e.g. "credentials" */
  prefix: string
  idPrefix?: string
  disabled?: boolean
}

export function CredentialFields<T extends FieldValues>({
  fields,
  control,
  prefix,
  idPrefix = "cred",
  disabled,
}: CredentialFieldsProps<T>) {
  const values = (useWatch({ control, name: prefix as Path<T> }) ?? {}) as Record<string, string | undefined>
  return (
    <FieldGroup className="gap-5">
      {fields.filter((f) => isFieldVisible(f, values)).map((f) => (
        <Controller
          key={f.key}
          control={control}
          name={`${prefix}.${f.key}` as Path<T>}
          shouldUnregister={false}
          rules={{
            validate: (v: unknown, all: T) => {
              const current = ((all as Record<string, unknown>)[prefix] ?? {}) as Record<string, string | undefined>
              if (!f.required || !isFieldVisible(f, current)) return true
              return (typeof v === "string" && v.trim() !== "") || m.new.requiredField(f.label)
            },
          }}
          render={({ field, fieldState }) => {
            const id = `${idPrefix}-${f.key}`
            const descId = f.help ? `${id}-help` : undefined
            const invalid = fieldState.invalid || undefined
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={id}>
                  {f.label}
                  {/* provider labels carry no "(tuỳ chọn)" suffix: the form adds it from `required` */}
                  {!f.required && <span className="font-normal text-muted-foreground">{m.new.optional}</span>}
                </FieldLabel>
                {f.type === "select" ? (
                  <Select
                    value={(field.value as string) ?? ""}
                    onValueChange={field.onChange}
                    disabled={disabled}
                  >
                    <SelectTrigger id={id} className="w-full" aria-invalid={invalid} aria-describedby={descId}>
                      <SelectValue placeholder={f.placeholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options?.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : f.type === "secret" || f.type === "textarea" ? (
                  <SecretInput
                    id={id}
                    name={field.name}
                    value={(field.value as string) ?? ""}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    ref={field.ref}
                    multiline={f.type === "textarea"}
                    rows={f.type === "textarea" ? 6 : undefined}
                    placeholder={f.placeholder}
                    disabled={disabled}
                    aria-invalid={invalid}
                    aria-describedby={descId}
                  />
                ) : (
                  <Input
                    id={id}
                    {...field}
                    value={(field.value as string) ?? ""}
                    placeholder={f.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    aria-invalid={invalid}
                    aria-describedby={descId}
                  />
                )}
                {f.help && <FieldDescription id={descId}>{f.help}</FieldDescription>}
                <FieldError errors={[fieldState.error]} />
              </Field>
            )
          }}
        />
      ))}
    </FieldGroup>
  )
}

/** TikTok "Đổi auth_code" fields (App ID, secret, auth_code) - the values go straight to the server. */
export const AUTH_CODE_FIELDS: CredentialField[] = [
  { key: "appId", label: m.new.appIdLabel, type: "text", required: true, placeholder: m.new.appIdPlaceholder },
  { key: "secret", label: m.new.appSecretLabel, type: "secret", required: true },
  {
    key: "authCode",
    label: m.new.authCodeLabel,
    type: "secret",
    required: true,
    placeholder: m.new.authCodePlaceholder,
    help: m.new.authCodeHelp,
  },
]
