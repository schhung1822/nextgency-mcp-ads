"use client"

// Settings → "Google Drive hệ thống" (admin): the company service account (JSON key, write-only) + optional API key
// for public "Anyone with the link" files. Saving / deleting re-authenticates (password + TOTP). Never prefilled:
// only the client email (not a secret), the project id and the last 4 chars of the key id / API key are shown.
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Alert02Icon,
  Delete02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  CopyField,
  ReauthDialog,
  RelativeTime,
  SecretInput,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  GOOGLE_API_KEY_RE,
  type SystemDriveCredentialDto,
} from "@/lib/schemas/drive"
import {
  deleteSystemDriveCredentialAction,
  saveSystemDriveCredentialAction,
  testSystemDriveCredentialAction,
} from "@/server/actions/drive"

import { DriveStatusBadge } from "../../connections/drive/_components/drive-badges"

const m = driveUi.settings

type Pending = {
  serviceAccountJson?: string
  apiKey?: string
  clearApiKey: boolean
}

export function DriveSettingsCard({
  credential: c,
  actorTwoFactor,
}: {
  credential: SystemDriveCredentialDto
  actorTwoFactor: boolean
}) {
  const router = useRouter()
  const [json, setJson] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [clearApiKey, setClearApiKey] = React.useState(false)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  // something typed: "Lưu" becomes the card's brand action (like the contextual save bar of the other cards)
  const dirty = !!json.trim() || !!apiKey.trim() || clearApiKey

  const save = () => {
    const errs: Record<string, string> = {}
    const j = json.trim()
    const k = apiKey.trim()
    if (!c.configured && !j) errs.serviceAccountJson = driveUi.service.serviceAccountRequired
    if (k && !GOOGLE_API_KEY_RE.test(k)) errs.apiKey = driveUi.service.invalidApiKey
    setErrors(errs)
    if (Object.keys(errs).length) return
    if (!j && !k && !clearApiKey) {
      toast.error(m.nothingToSave)
      return
    }
    setPending({
      serviceAccountJson: j || undefined,
      apiKey: k || undefined,
      clearApiKey: clearApiKey && !k,
    })
  }

  const test = async () => {
    setTesting(true)
    const res = await testSystemDriveCredentialAction()
    setTesting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.ok)
      toast.success(res.message ?? driveUi.service.done.credentialTested)
    else
      toast.error(m.testFailed, {
        description: res.data.statusMessage ?? undefined,
      })
    router.refresh()
  }

  return (
    <Card id="google-drive" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
        <CardAction>
          <DriveStatusBadge status={c.status} />
        </CardAction>
      </CardHeader>
      {/* one column (the "how to create a service account" steps live in the page's Guide panel) */}
      <CardContent>
        <div className="flex max-w-3xl min-w-0 flex-col gap-5">
          {c.configured && c.status === "error" && (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
              <AlertTitle>{m.statusErrorTitle}</AlertTitle>
              {c.statusMessage && (
                <AlertDescription>{c.statusMessage}</AlertDescription>
              )}
            </Alert>
          )}
          {c.configured && c.clientEmail ? (
            <div className="flex flex-col gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="drive-system-email">{m.email}</FieldLabel>
                <CopyField
                  id="drive-system-email"
                  value={c.clientEmail}
                  label={m.emailCopyLabel}
                  wrap
                />
              </Field>
              <dl className="grid grid-cols-2 items-start gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                <InfoItem label={m.project}>
                  <span
                    className="block truncate font-mono text-xs leading-5"
                    title={c.projectId ?? undefined}
                  >
                    {c.projectId ?? "—"}
                  </span>
                </InfoItem>
                <InfoItem label={m.keyId}>
                  <span className="font-mono text-xs leading-5">
                    {c.credentialHint ? `…${c.credentialHint}` : "—"}
                  </span>
                </InfoItem>
                <InfoItem label={m.apiKey}>
                  {c.apiKeyHint ? (
                    <span className="font-mono text-xs leading-5">
                      …{c.apiKeyHint}
                    </span>
                  ) : (
                    <span className="text-[13px] leading-5 text-warning-strong">
                      {m.apiKeyNone}
                    </span>
                  )}
                </InfoItem>
                <InfoItem label={m.lastChecked}>
                  {c.lastCheckedAt ? (
                    <RelativeTime value={c.lastCheckedAt} />
                  ) : (
                    <span className="text-muted-foreground">{m.never}</span>
                  )}
                </InfoItem>
                <InfoItem label={m.sources}>
                  <span className="tabular-nums">{c.sourceCount}</span>
                </InfoItem>
              </dl>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed p-3 text-sm text-pretty text-muted-foreground">
              {m.notConfiguredHint}
            </p>
          )}

          <FieldGroup className="border-t pt-5">
            <Field data-invalid={errors.serviceAccountJson ? true : undefined}>
              <FieldLabel htmlFor="drive-system-json">
                {c.configured ? m.jsonLabelReplace : m.jsonLabel}
              </FieldLabel>
              <SecretInput
                id="drive-system-json"
                multiline
                rows={5}
                value={json}
                onChange={(e) => {
                  setJson(e.target.value)
                  setErrors(({ serviceAccountJson: _d, ...r }) => r)
                }}
                placeholder={m.jsonPlaceholder}
                aria-invalid={errors.serviceAccountJson ? true : undefined}
                aria-describedby="drive-system-json-help"
              />
              <FieldDescription id="drive-system-json-help">
                {c.configured ? m.jsonHelpKeep : m.jsonHelpNew}
              </FieldDescription>
              {errors.serviceAccountJson && (
                <FieldError>{errors.serviceAccountJson}</FieldError>
              )}
            </Field>
            <Field data-invalid={errors.apiKey ? true : undefined}>
              <FieldLabel htmlFor="drive-system-apikey">{m.apiKeyLabel}</FieldLabel>
              <SecretInput
                id="drive-system-apikey"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setErrors(({ apiKey: _d, ...r }) => r)
                }}
                placeholder={m.apiKeyPlaceholder}
                maxLength={64}
                disabled={clearApiKey}
                aria-invalid={errors.apiKey ? true : undefined}
                aria-describedby="drive-system-apikey-help"
              />
              <FieldDescription id="drive-system-apikey-help">
                {c.apiKeyHint ? m.apiKeyKeep(c.apiKeyHint) : m.apiKeyHelp}
              </FieldDescription>
              {errors.apiKey && <FieldError>{errors.apiKey}</FieldError>}
            </Field>
            {c.hasApiKey && (
              <Field orientation="horizontal" className="items-center">
                <Checkbox
                  id="drive-system-clear-key"
                  checked={clearApiKey}
                  onCheckedChange={(v) => {
                    setClearApiKey(v === true)
                    if (v === true) setApiKey("")
                  }}
                />
                <FieldLabel
                  htmlFor="drive-system-clear-key"
                  className="font-normal"
                >
                  {m.clearApiKey}
                </FieldLabel>
              </Field>
            )}
          </FieldGroup>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {c.configured ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive max-sm:w-full"
                onClick={() => setDeleteOpen(true)}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden
                />
                {m.delete}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {c.configured && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void test()}
                  disabled={testing}
                  className="max-sm:w-full"
                >
                  {testing ? (
                    <Spinner aria-hidden />
                  ) : (
                    <HugeiconsIcon
                      icon={Refresh01Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                      aria-hidden
                    />
                  )}
                  {testing ? m.checking : m.check}
                </Button>
              )}
              <Button
                type="button"
                // the settings page has no header button: like the save bar of the other cards, "Lưu" turns into
                // the brand action once something was typed here
                variant={dirty ? "brand" : "outline"}
                onClick={save}
                disabled={testing}
                className="max-sm:w-full"
              >
                {m.save}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>

      {pending && (
        <ReauthDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          twoFactorEnabled={actorTwoFactor}
          idPrefix="drive-save-reauth"
          texts={m.reauthSave}
          onSubmit={(fields) =>
            saveSystemDriveCredentialAction({ ...pending, ...fields })
          }
          onSuccess={(_data, message) => {
            setPending(null)
            setJson("")
            setApiKey("")
            setClearApiKey(false)
            setErrors({})
            toast.success(message ?? driveUi.service.done.credentialSaved)
            router.refresh()
          }}
          onFailure={(r) => {
            // a problem with the key itself: close the dialog and show it on the field
            const fe = r.fieldErrors ?? {}
            const own = Object.fromEntries(
              Object.entries(fe).filter(([k]) =>
                ["serviceAccountJson", "apiKey"].includes(k)
              )
            )
            if (Object.keys(own).length === 0) return false
            setErrors(own)
            setPending(null)
            toast.error(r.error)
            return true
          }}
        />
      )}
      <ReauthDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        twoFactorEnabled={actorTwoFactor}
        idPrefix="drive-delete-reauth"
        destructive
        texts={m.reauthDelete}
        canSubmit={c.sourceCount === 0}
        onSubmit={(fields) => deleteSystemDriveCredentialAction(fields)}
        onSuccess={(_d, message) => {
          toast.success(message ?? driveUi.service.done.credentialDeleted)
          router.refresh()
        }}
      >
        {c.sourceCount > 0 && (
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertDescription>{m.deleteInUse(c.sourceCount)}</AlertDescription>
          </Alert>
        )}
      </ReauthDialog>
    </Card>
  )
}

function InfoItem({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[13px] leading-5 text-muted-foreground">{label}</dt>
      <dd className="flex min-h-5 min-w-0 items-center leading-5">{children}</dd>
    </div>
  )
}
