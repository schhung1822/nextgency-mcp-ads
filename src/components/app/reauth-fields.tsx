"use client"

// Password (+ 6-digit TOTP when the user has 2FA) for sensitive actions. Controlled; the server verifies
// them through the shared re-auth gate (src/server/auth/reauth.ts).
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { reauth as t } from "@/lib/i18n/vi/reauth"

export interface ReauthValues {
  password: string
  code: string
}

export const EMPTY_REAUTH: ReauthValues = { password: "", code: "" }

/** Client-side completeness check (the server re-validates). */
export function reauthComplete(v: ReauthValues, twoFactorEnabled: boolean): boolean {
  return v.password.length > 0 && (!twoFactorEnabled || /^\d{6}$/.test(v.code))
}

/** Payload fields for a server action: `{ password, code? }`. */
export function reauthPayload(v: ReauthValues, twoFactorEnabled: boolean): { password: string; code?: string } {
  return twoFactorEnabled ? { password: v.password, code: v.code } : { password: v.password }
}

export function ReauthFields({
  idPrefix = "reauth",
  twoFactorEnabled,
  value,
  onChange,
  errors,
  autoFocus,
  passwordLabel = t.passwordLabel,
  hint,
}: {
  idPrefix?: string
  twoFactorEnabled: boolean
  value: ReauthValues
  onChange: (next: ReauthValues) => void
  errors?: { password?: string; code?: string }
  autoFocus?: boolean
  passwordLabel?: string
  /** description under the password field (default: generic "sensitive action" hint; null = none) */
  hint?: string | null
}) {
  const hintText = hint === undefined ? t.hint : hint
  return (
    <>
      <Field data-invalid={!!errors?.password || undefined}>
        <FieldLabel htmlFor={`${idPrefix}-password`}>{passwordLabel}</FieldLabel>
        <Input
          id={`${idPrefix}-password`}
          type="password"
          autoComplete="current-password"
          autoFocus={autoFocus}
          className="h-10"
          required
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
          aria-invalid={!!errors?.password || undefined}
        />
        {hintText && <FieldDescription>{hintText}</FieldDescription>}
        {errors?.password && <FieldError>{errors.password}</FieldError>}
      </Field>
      {twoFactorEnabled && (
        <Field data-invalid={!!errors?.code || undefined}>
          <FieldLabel htmlFor={`${idPrefix}-code`}>{t.codeLabel}</FieldLabel>
          <InputOTP
            id={`${idPrefix}-code`}
            maxLength={6}
            value={value.code}
            onChange={(code) => onChange({ ...value, code })}
            inputMode="numeric"
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }, (_, i) => (
                <InputOTPSlot key={i} index={i} className="size-10 text-base" />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <FieldDescription>{t.codeHelp}</FieldDescription>
          {errors?.code && <FieldError>{errors.code}</FieldError>}
        </Field>
      )}
    </>
  )
}
