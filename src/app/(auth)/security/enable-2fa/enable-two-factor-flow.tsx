"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Alert02Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { QRCodeSVG } from "qrcode.react"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"

import { Stepper, useCopy } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { authErrorMessage, passwordConfirmSchema, totpCodeSchema, type PasswordConfirmInput } from "@/lib/schemas/auth"

import { authClient } from "../../auth-client"
import { OtpInput } from "../../otp-input"
import { PasswordInput } from "../../password-input"
import { BackupCodes } from "./backup-codes"

const t = tAuth.enable2fa

export interface TwoFactorSetupData {
  totpURI: string
  secret: string
  backupCodes: string[]
}

export interface EnableTwoFactorFlowProps {
  email: string
  /** where to go after finishing */
  doneHref: string
  begin: (input: unknown) => Promise<ActionResult<TwoFactorSetupData>>
}

/** password → QR + first TOTP code → 10 backup codes (shown once). */
export function EnableTwoFactorFlow({ email, doneHref, begin }: EnableTwoFactorFlowProps) {
  const [step, setStep] = React.useState(0)
  const [setup, setSetup] = React.useState<TwoFactorSetupData | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [code, setCode] = React.useState("")
  const [verifying, setVerifying] = React.useState(false)
  const [saved, setSaved] = React.useState(false)

  const pwForm = useForm<PasswordConfirmInput>({
    resolver: zodResolver(passwordConfirmSchema),
    defaultValues: { password: "" },
  })

  const onPassword = pwForm.handleSubmit(async (values) => {
    setError(null)
    const res = await begin(values).catch(() => null)
    if (!res) return setError(tAuth.errors.NETWORK)
    if (!res.ok) {
      setError(res.error)
      pwForm.resetField("password")
      pwForm.setFocus("password")
      return
    }
    setSetup(res.data)
    pwForm.reset({ password: "" })
    setStep(1)
  })

  async function onVerify(value: string) {
    if (verifying) return
    setError(null)
    const parsed = totpCodeSchema.safeParse(value)
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? tAuth.errors.GENERIC)
    setVerifying(true)
    try {
      // Verified over HTTP (/api/auth/two-factor/verify-totp, rate-limited) rather than a server action:
      // Better Auth rotates the session cookie here, and a cookie-setting server action makes Next refresh
      // this page - which would redirect away before the one-time backup codes are shown.
      const { error: err } = await authClient.twoFactor.verifyTotp({ code: parsed.data })
      if (err) {
        setError(authErrorMessage(err.code, err.status))
        setCode("")
        return
      }
      toast.success(t.enabledToast)
      setStep(2)
    } catch {
      setError(tAuth.errors.NETWORK)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Stepper
        steps={[{ title: t.steps.password }, { title: t.steps.scan }, { title: t.steps.backup }]}
        current={step}
      />

      {step === 0 && (
        <form method="post" onSubmit={onPassword} noValidate className="flex flex-col gap-5">
          <Controller
            control={pwForm.control}
            name="password"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="enable2fa-password">{t.passwordLabel}</FieldLabel>
                <PasswordInput
                  {...field}
                  id="enable2fa-password"
                  autoComplete="current-password"
                  autoFocus
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldDescription>{t.passwordHint}</FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          {error && <ErrorAlert message={error} />}
          <Button type="submit" variant="brand" size="lg" className="w-full" disabled={pwForm.formState.isSubmitting}>
            {pwForm.formState.isSubmitting && <Spinner aria-hidden />}
            {pwForm.formState.isSubmitting ? t.starting : t.start}
          </Button>
        </form>
      )}

      {step === 1 && setup && (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            void onVerify(code)
          }}
        >
          <div className="space-y-1 text-center">
            <h2 className="text-base font-semibold">{t.scanTitle}</h2>
            <p className="text-sm text-pretty text-muted-foreground">{t.scanDescription}</p>
          </div>
          <div className="flex justify-center">
            {/* White plate keeps the QR scannable in dark mode. Rendered locally - the URI never leaves the browser. */}
            <div className="rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-black/5">
              <QRCodeSVG
                value={setup.totpURI}
                size={184}
                level="M"
                title={t.qrAlt}
                data-testid="totp-qr"
                className="size-[184px]"
              />
            </div>
          </div>
          <Field>
            <span id="totp-secret-label" className="text-[13px] text-muted-foreground">
              {t.manualLabel}
            </span>
            <SecretKey id="totp-secret" labelId="totp-secret-label" value={setup.secret} label={t.manualLabel} />
          </Field>
          <Field className="items-center">
            <FieldLabel htmlFor="enable2fa-code" className="text-center">
              {t.codeLabel}
            </FieldLabel>
            <OtpInput
              id="enable2fa-code"
              value={code}
              onChange={setCode}
              onComplete={(v) => void onVerify(v)}
              disabled={verifying}
            />
          </Field>
          {error && <ErrorAlert message={error} />}
          <Button type="submit" variant="brand" size="lg" className="w-full" disabled={verifying}>
            {verifying && <Spinner aria-hidden />}
            {verifying ? t.verifying : t.verify}
          </Button>
        </form>
      )}

      {step === 2 && setup && (
        <div className="flex flex-col gap-5">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">{t.backupTitle}</h2>
            <p className="text-sm text-pretty text-muted-foreground">{t.backupDescription}</p>
          </div>
          <BackupCodes codes={setup.backupCodes} email={email} />
          <Field orientation="horizontal">
            <Checkbox id="backup-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
            <FieldLabel htmlFor="backup-saved" className="font-normal">
              {t.savedConfirm}
            </FieldLabel>
          </Field>
          <Button
            type="button"
            variant="brand"
            size="lg"
            className="w-full"
            disabled={!saved}
            onClick={() => window.location.assign(doneHref)}
          >
            {t.finish}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The TOTP secret for manual entry: grouped in blocks of 4, wraps instead of truncating, one-tap copy. */
function SecretKey({ id, labelId, value, label }: { id: string; labelId: string; value: string; label: string }) {
  const { copied, copy } = useCopy()
  const compact = value.replace(/\s+/g, "")
  const grouped = compact.match(/.{1,4}/g)?.join(" ") ?? compact
  return (
    <div role="group" aria-labelledby={labelId} className="flex items-center gap-1 rounded-2xl border bg-card p-1.5 pl-3.5">
      <code
        id={id}
        data-testid="totp-secret"
        className="min-w-0 flex-1 py-1 font-mono text-[13px] leading-5 tracking-wide break-words select-all"
      >
        {grouped}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        aria-label={`${common.copy}: ${label}`}
        onClick={() => void copy(compact)}
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={2}
          className={copied ? "text-success" : undefined}
          aria-hidden
        />
      </Button>
    </div>
  )
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
