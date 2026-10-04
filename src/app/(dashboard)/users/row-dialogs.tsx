"use client"

import * as React from "react"
import { Alert02Icon, ComputerIcon, Copy01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import {
  CopyField,
  EMPTY_REAUTH,
  ReauthFields,
  reauthComplete,
  reauthPayload,
  RelativeTime,
  useCopy,
  type ReauthValues,
} from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { common } from "@/lib/i18n/vi/common"
import { formatIp } from "@/lib/format-ip"
import { users as tUsers } from "@/lib/i18n/vi/users"
import { changeRoleSchema, generateTempPassword, resetPasswordSchema } from "@/lib/schemas/users"

import { RolePicker } from "./role-picker"
import { TempPasswordField } from "./temp-password-field"
import type { Role, SessionRow, UserActions, UserRow } from "./types"

/** Dialogs can be taller than a phone screen (re-auth block, OTP) → the dialog itself scrolls. */
const CONTENT_CLASS = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

interface RowDialogProps {
  user: UserRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

// ---------------------------------------------------------------------------

/** {password, code} errors from the server: "reauth.password" (users actions) or "password"/"code". */
function reauthErrorsFrom(fieldErrors: Record<string, string> | undefined) {
  if (!fieldErrors) return {}
  return {
    password: fieldErrors["reauth.password"] ?? fieldErrors.password,
    code: fieldErrors["reauth.code"] ?? fieldErrors.code,
  }
}

export function ChangeRoleDialog({
  user,
  open,
  onOpenChange,
  onDone,
  action,
  actorTwoFactor,
}: RowDialogProps & { action: UserActions["changeRole"]; actorTwoFactor: boolean }) {
  const t = tUsers.changeRole
  const [role, setRole] = React.useState<Role>(user.role === "admin" ? "staff" : "admin")
  const [reauth, setReauth] = React.useState<ReauthValues>(EMPTY_REAUTH)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = changeRoleSchema.safeParse({ userId: user.id, role, ...reauthPayload(reauth, actorTwoFactor) })
    if (!parsed.success || !reauthComplete(reauth, actorTwoFactor)) {
      setErrors(
        parsed.success
          ? { code: tUsers.changeRole.codeRequired }
          : Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]))
      )
      return
    }
    setErrors({})
    setPending(true)
    try {
      const res = await action(parsed.data)
      if (!res.ok) {
        setReauth(EMPTY_REAUTH)
        setErrors(reauthErrorsFrom(res.fieldErrors) as Record<string, string>)
        return setError(res.error)
      }
      toast.success(res.message ?? tUsers.toast.roleChanged)
      onOpenChange(false)
      onDone()
    } catch {
      setError(tAuth.errors.NETWORK)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className={CONTENT_CLASS}>
        <form onSubmit={submit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t.title(user.name || user.email)}</DialogTitle>
            <DialogDescription>{t.description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel id="role-label">{t.role}</FieldLabel>
              <RolePicker id="role-select" value={role} onChange={setRole} ariaLabel={t.role} />
            </Field>
            <ReauthFields
              idPrefix="role"
              twoFactorEnabled={actorTwoFactor}
              value={reauth}
              onChange={setReauth}
              errors={errors}
              passwordLabel={t.password}
              hint={t.passwordHint}
            />
          </FieldGroup>
          {error && <ErrorAlert message={error} />}
          <DialogFooter className="[&>button]:h-10 sm:[&>button]:h-9">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {common.cancel}
            </Button>
            <Button type="submit" disabled={pending || role === user.role}>
              {pending && <Spinner aria-hidden />}
              {pending ? t.submitting : t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------

export function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
  onDone,
  action,
  actorTwoFactor,
}: RowDialogProps & { action: UserActions["resetPassword"]; actorTwoFactor: boolean }) {
  const t = tUsers.resetPassword
  const { copy } = useCopy({ toastMessage: tUsers.toast.credentialsCopied })
  // resetting ANOTHER ADMIN's password requires re-authentication (password + TOTP)
  const needsReauth = user.role === "admin"
  const [reauth, setReauth] = React.useState<ReauthValues>(EMPTY_REAUTH)
  const [reauthErrors, setReauthErrors] = React.useState<{ password?: string; code?: string }>({})
  const [password, setPassword] = React.useState(() => generateTempPassword())
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [done, setDone] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = resetPasswordSchema.safeParse({
      userId: user.id,
      password,
      ...(needsReauth ? { reauth: reauthPayload(reauth, actorTwoFactor) } : {}),
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      if (issue?.path[0] === "reauth") return setReauthErrors({ [String(issue.path[1])]: issue.message })
      return setFieldError(issue?.message ?? null)
    }
    if (needsReauth && !reauthComplete(reauth, actorTwoFactor)) return setReauthErrors({ code: tUsers.changeRole.codeRequired })
    setFieldError(null)
    setReauthErrors({})
    setPending(true)
    try {
      const res = await action(parsed.data)
      if (!res.ok) {
        setReauth(EMPTY_REAUTH)
        setReauthErrors(reauthErrorsFrom(res.fieldErrors))
        return setError(res.error)
      }
      toast.success(res.message ?? tUsers.toast.passwordReset)
      setDone(true)
      onDone()
    } catch {
      setError(tAuth.errors.NETWORK)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className={CONTENT_CLASS}>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>{t.doneTitle}</DialogTitle>
              <DialogDescription>{t.doneDescription}</DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="reset-done-email">{tUsers.create.doneEmail}</FieldLabel>
                <CopyField id="reset-done-email" value={user.email} label={tUsers.create.doneEmail} />
              </Field>
              <Field>
                <FieldLabel htmlFor="reset-done-password">{tUsers.create.donePassword}</FieldLabel>
                <CopyField id="reset-done-password" value={password} label={tUsers.create.donePassword} />
              </Field>
            </FieldGroup>
            <DialogFooter className="[&>button]:h-10 sm:[&>button]:h-9">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tUsers.create.close}
              </Button>
              <Button
                type="button"
                onClick={() =>
                  void copy(tUsers.create.copyText(user.email, password, `${window.location.origin}/login`))
                }
              >
                <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
                {tUsers.create.copyAll}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>{t.title(user.name || user.email)}</DialogTitle>
              <DialogDescription>{t.description}</DialogDescription>
            </DialogHeader>
            <Field data-invalid={fieldError ? true : undefined}>
              <FieldLabel htmlFor="reset-password">{t.password}</FieldLabel>
              <TempPasswordField id="reset-password" value={password} onChange={setPassword} invalid={!!fieldError} />
              <FieldDescription>{tUsers.create.passwordHint}</FieldDescription>
              <FieldError>{fieldError}</FieldError>
            </Field>
            {needsReauth && (
              <div className="flex flex-col gap-4 rounded-2xl border bg-muted/40 p-4">
                <p className="text-sm font-medium">{tUsers.create.adminReauthTitle}</p>
                <FieldGroup className="gap-4">
                  <ReauthFields
                    idPrefix="reset-reauth"
                    twoFactorEnabled={actorTwoFactor}
                    value={reauth}
                    onChange={setReauth}
                    errors={reauthErrors}
                    hint={tUsers.resetPassword.adminReauthHint}
                  />
                </FieldGroup>
              </div>
            )}
            {error && <ErrorAlert message={error} />}
            <DialogFooter className="[&>button]:h-10 sm:[&>button]:h-9">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                {common.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner aria-hidden />}
                {pending ? t.submitting : t.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------

export function SessionsSheet({
  user,
  open,
  onOpenChange,
  onDone,
  list,
  revoke,
}: RowDialogProps & { list: UserActions["listSessions"]; revoke: UserActions["revokeSessions"] }) {
  const t = tUsers.sessions
  const [sessions, setSessions] = React.useState<SessionRow[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const apply = React.useCallback(
    (res: Awaited<ReturnType<typeof list>> | null) => {
      if (!res || !res.ok) {
        setError(res && !res.ok ? res.error : t.loadFailed)
        return
      }
      setError(null)
      setSessions(res.data)
    },
    [t.loadFailed]
  )

  const load = async () => apply(await list({ userId: user.id }).catch(() => null))

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    list({ userId: user.id })
      .catch(() => null)
      .then((res) => {
        if (!cancelled) apply(res)
      })
    return () => {
      cancelled = true
    }
  }, [open, list, user.id, apply])

  async function doRevoke(sessionId?: string) {
    setBusy(sessionId ?? "all")
    try {
      const res = await revoke(sessionId ? { userId: user.id, sessionId } : { userId: user.id })
      if (!res.ok) return toast.error(res.error)
      toast.success(res.message)
      onDone()
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* `data-[side=right]:` variants: the base Sheet sets `w-3/4` with the same specificity, plain `w-full` would lose */}
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="pr-14">
          <SheetTitle className="text-balance">{t.title(user.name || user.email)}</SheetTitle>
          <SheetDescription>{t.description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6 sm:px-6">
          {error && <ErrorAlert message={error} />}
          {!sessions && !error && (
            <div className="flex flex-col gap-2" role="status" aria-label={t.loading}>
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
            </div>
          )}
          {sessions && sessions.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <HugeiconsIcon icon={ComputerIcon} strokeWidth={1.75} className="size-5" aria-hidden />
              </span>
              <p className="text-sm text-pretty text-muted-foreground">{t.empty}</p>
            </div>
          )}
          {sessions && sessions.length > 0 && (
            <>
              <ul className="flex flex-col gap-2">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-2xl border bg-card p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <HugeiconsIcon
                        icon={/iOS|Android/.test(s.device) ? SmartPhone01Icon : ComputerIcon}
                        strokeWidth={1.75}
                        className="size-5"
                        aria-hidden
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.device}</p>
                      <p className="text-[13px] break-words text-muted-foreground">
                        <span className="font-mono">{formatIp(s.ip) ?? t.unknownIp}</span>
                        <span aria-hidden> · </span>
                        <RelativeTime value={s.lastActiveAt} />
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      className="h-10 shrink-0 px-3"
                      disabled={busy !== null}
                      aria-label={t.revokeLabel(s.device)}
                      onClick={() => void doRevoke(s.id)}
                    >
                      {busy === s.id && <Spinner aria-hidden />}
                      {t.revoke}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button variant="outline" className="h-10" disabled={busy !== null} onClick={() => void doRevoke()}>
                {busy === "all" && <Spinner aria-hidden />}
                {t.revokeAll}
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
