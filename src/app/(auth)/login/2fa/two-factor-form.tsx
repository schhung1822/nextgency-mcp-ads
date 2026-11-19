"use client"

import * as React from "react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import Link from "next/link"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { authErrorMessage, backupCodeSchema, totpCodeSchema } from "@/lib/schemas/auth"

import { AuthCard } from "../../auth-card"
import { authClient } from "../../auth-client"
import { OtpInput } from "../../otp-input"

/** Error codes after which this 2FA challenge is dead and the user must sign in again. */
const RESTART_CODES = new Set(["TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE", "INVALID_TWO_FACTOR_COOKIE"])

/** The whole 2FA login screen (card + form): the description under the title depends on the code mode. */
export function TwoFactorForm({ next, allowTrustDevice }: { next: string | null; allowTrustDevice: boolean }) {
  const [mode, setMode] = React.useState<"totp" | "backup">("totp")
  const [code, setCode] = React.useState("")
  const [backup, setBackup] = React.useState("")
  const [trustDevice, setTrustDevice] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [mustRestart, setMustRestart] = React.useState(false)
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login"

  async function submit(value: string) {
    if (pending || mustRestart) return
    setError(null)
    setFieldError(null)
    const parsed = (mode === "totp" ? totpCodeSchema : backupCodeSchema).safeParse(value)
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? tAuth.errors.GENERIC)
      return
    }
    setPending(true)
    try {
      const body = { code: parsed.data, trustDevice: allowTrustDevice && trustDevice }
      const { error: err } =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp(body)
          : await authClient.twoFactor.verifyBackupCode(body)
      if (err) {
        setError(authErrorMessage(err.code, err.status))
        if (err.code && RESTART_CODES.has(err.code)) setMustRestart(true)
        if (mode === "totp") setCode("")
        return
      }
      window.location.assign(next ?? "/")
    } catch {
      setError(tAuth.errors.NETWORK)
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard
      title={tAuth.twoFactor.title}
      description={mode === "totp" ? tAuth.twoFactor.descriptionTotp : tAuth.twoFactor.descriptionBackup}
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(mode === "totp" ? code : backup)
        }}
      >
        {mode === "totp" ? (
          <Field data-invalid={fieldError ? true : undefined} className="items-center">
            <FieldLabel htmlFor="otp-code" className="sr-only">
              {tAuth.twoFactor.codeLabel}
            </FieldLabel>
            <OtpInput
              id="otp-code"
              autoFocus
              value={code}
              onChange={setCode}
              onComplete={(v) => void submit(v)}
              disabled={pending || mustRestart}
              invalid={!!fieldError}
              aria-label={tAuth.twoFactor.codeLabel}
            />
            <FieldError className="text-center">{fieldError}</FieldError>
          </Field>
        ) : (
          <Field data-invalid={fieldError ? true : undefined}>
            <FieldLabel htmlFor="backup-code">{tAuth.twoFactor.backupLabel}</FieldLabel>
            <Input
              id="backup-code"
              value={backup}
              onChange={(e) => setBackup(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder={tAuth.twoFactor.backupPlaceholder}
              className="h-10 font-mono"
              disabled={pending || mustRestart}
              aria-invalid={fieldError ? true : undefined}
            />
            <FieldError>{fieldError}</FieldError>
          </Field>
        )}

        {allowTrustDevice && (
          <Field orientation="horizontal">
            <Checkbox
              id="trust-device"
              checked={trustDevice}
              onCheckedChange={(v) => setTrustDevice(v === true)}
              disabled={pending || mustRestart}
            />
            <FieldContent>
              <FieldLabel htmlFor="trust-device" className="font-normal">
                {tAuth.twoFactor.trustDevice}
              </FieldLabel>
              <FieldDescription className="text-[13px]">{tAuth.twoFactor.trustDeviceHint}</FieldDescription>
            </FieldContent>
          </Field>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {mustRestart ? (
          <Button asChild variant="brand" size="lg" className="w-full">
            <Link href={loginHref}>{tAuth.twoFactor.backToLogin}</Link>
          </Button>
        ) : (
          <Button type="submit" variant="brand" size="lg" disabled={pending} className="w-full">
            {pending && <Spinner aria-hidden />}
            {pending ? tAuth.twoFactor.submitting : tAuth.twoFactor.submit}
          </Button>
        )}

        <div className="flex flex-col items-center gap-0.5 border-t pt-3">
          <Button
            type="button"
            variant="link"
            // text-brand-ink (not text-primary): primary-from on the dark card is low contrast, brand-ink passes AA in both themes
            className="h-10 text-brand-ink"
            onClick={() => {
              setMode((m) => (m === "totp" ? "backup" : "totp"))
              setError(null)
              setFieldError(null)
            }}
            disabled={pending}
          >
            {mode === "totp" ? tAuth.twoFactor.useBackup : tAuth.twoFactor.useTotp}
          </Button>
          {!mustRestart && (
            <Button asChild variant="link" className="h-10 text-muted-foreground">
              <Link href={loginHref}>{tAuth.twoFactor.backToLogin}</Link>
            </Button>
          )}
        </div>
      </form>
    </AuthCard>
  )
}
