"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  InformationCircleIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  createDataTableColumnHelper,
  DataTable,
  PageGuide,
  PlatformIcon,
  StatusBadge,
  Stepper,
} from "@/components/app"
import { StatusHint } from "@/components/mcp/status-hint"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { PLATFORM_LABELS } from "@/lib/constants"
import type { GuideDef } from "@/lib/guide-types"
import { UPCOMING_PLATFORMS } from "@/lib/platforms"
import { connections as m } from "@/lib/i18n/vi/connections"
import { guides } from "@/lib/i18n/vi/guides"
import {
  defaultOffSummary,
  enabledDiffFromDefaults,
  initialEnabledExternalIds,
  splitTrailingHint,
  visibleCredentialValues,
  type ConnectionPreview,
  type PlatformFormSpec,
  type PreviewAccount,
} from "@/lib/schemas/connections"
import {
  createConnectionAction,
  previewConnectionAction,
} from "@/server/actions/connections"
import type { Platform } from "@/server/providers/types"

import {
  CredentialFields,
  initialCredentialValues,
} from "../../_components/credential-fields"
import { TokenSummary } from "../../_components/token-summary"

interface FormValues {
  name: string
  credentials: Record<string, string>
}

interface Submission {
  platform: Platform
  name: string
  credentials: Record<string, string>
}

type Verify =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; preview: ConnectionPreview }

const STEPS = [
  { title: m.new.steps.platform, description: m.new.steps.platformDesc },
  { title: m.new.steps.credentials, description: m.new.steps.credentialsDesc },
  { title: m.new.steps.verify, description: m.new.steps.verifyDesc },
]

/** "Bước 2/3 · Nhập thông tin" - phones only (the stepper shows every title from md up). */
function StepOverline({ step }: { step: number }) {
  return (
    <p className="text-xs font-medium text-muted-foreground md:hidden">
      {m.new.stepProgress(step + 1, STEPS.length, STEPS[step]!.title)}
    </p>
  )
}

export function NewConnectionWizard({
  specs,
  initialPlatform,
}: {
  specs: PlatformFormSpec[]
  initialPlatform: Platform | null
}) {
  const router = useRouter()
  // ?platform=<released platform> (e.g. the MCP wizard's "add connection" link) preselects
  // the platform and opens the credentials step; a platform without a form spec falls back to the picker
  const preselected =
    initialPlatform && specs.some((s) => s.platform === initialPlatform)
      ? initialPlatform
      : null
  const [step, setStep] = React.useState(preselected ? 1 : 0)
  const [platform, setPlatform] = React.useState<Platform | null>(preselected)
  // upcoming platform whose "not ready yet" dialog is open
  const [notReady, setNotReady] = React.useState<Platform | null>(null)
  const [verify, setVerify] = React.useState<Verify>({ state: "idle" })
  // external ids of the accounts switched ON in step 3 (starts from each account's `defaultEnabled`)
  const [enabled, setEnabled] = React.useState<Set<string>>(new Set())
  const [saving, setSaving] = React.useState(false)
  // credentials pasted in step 2, kept in memory only until saved / the page is left
  const [submitted, setSubmitted] = React.useState<Submission | null>(null)

  const spec = specs.find((s) => s.platform === platform) ?? null
  // step 2 shows the provider's own "how to get the token" guide in the right-hand Guide panel
  const credentialsGuide = React.useMemo<GuideDef | null>(
    () =>
      spec
        ? {
            title: m.new.guideTitle(PLATFORM_LABELS[spec.platform]),
            ...spec.guide,
          }
        : null,
    [spec]
  )
  const form = useForm<FormValues>({
    defaultValues: {
      name: "",
      credentials: spec ? initialCredentialValues(spec.fields) : {},
    },
    mode: "onTouched",
  })

  const choosePlatform = (p: Platform) => {
    if (p !== platform) {
      const next = specs.find((s) => s.platform === p)
      // never carry secrets across platforms
      form.reset({
        name: form.getValues("name"),
        credentials: next ? initialCredentialValues(next.fields) : {},
      })
      setPlatform(p)
    }
    setStep(1)
  }

  const runPreview = async (s: Submission) => {
    setVerify({ state: "loading" })
    const res = await previewConnectionAction({
      platform: s.platform,
      credentials: s.credentials,
    })
    if (!res.ok) {
      setVerify({ state: "error", message: res.error })
      return
    }
    setEnabled(initialEnabledExternalIds(res.data.accounts))
    setVerify({ state: "ok", preview: res.data })
  }

  const onSubmitCredentials = form.handleSubmit(async (values) => {
    if (!spec) return
    const s: Submission = {
      platform: spec.platform,
      name: values.name,
      credentials: visibleCredentialValues(spec.fields, values.credentials),
    }
    setSubmitted(s)
    setStep(2)
    void runPreview(s)
  })

  const save = async () => {
    const s = submitted
    if (!s || verify.state !== "ok") return
    setSaving(true)
    // only the differences from the server's defaults travel (closed / disabled / pending / MCC start OFF)
    const res = await createConnectionAction({
      ...s,
      ...enabledDiffFromDefaults(verify.preview.accounts, enabled),
    })
    setSaving(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(res.message ?? m.new.saved)
    setSubmitted(null)
    form.reset()
    router.push(`/connections/${res.data.id}`)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* step-aware guide: updates in the right-hand panel / sheet as the step changes */}
      {step === 0 && <PageGuide guide={guides.connectionNew.platform} />}
      {step === 1 && credentialsGuide && (
        <PageGuide guide={credentialsGuide} platform={spec?.platform} />
      )}
      {step === 2 && <PageGuide guide={guides.connectionNew.verify} />}
      <Stepper
        steps={STEPS}
        current={step}
        onStepClick={(i) => i < step && setStep(i)}
      />

      {step === 0 && (
        <section
          aria-labelledby="choose-platform"
          className="flex flex-col gap-4"
        >
          <div>
            <StepOverline step={0} />
            <h2 id="choose-platform" className="text-base font-semibold">
              {m.new.choosePlatform}
            </h2>
            <p className="text-sm text-muted-foreground">
              {m.new.choosePlatformHint}
            </p>
          </div>
          {/* released platforms on the first row, upcoming ones (disabled, "Sắp ra mắt") on the second */}
          <div className="grid gap-4 sm:grid-cols-2">
            {specs.map((s) => (
              <button
                key={s.platform}
                type="button"
                aria-label={m.new.selectPlatform(PLATFORM_LABELS[s.platform])}
                aria-pressed={platform === s.platform}
                onClick={() => choosePlatform(s.platform)}
                className="group rounded-2xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Card className="h-full transition-colors group-hover:border-brand-red/40 group-aria-pressed:border-brand-red/60">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-3 text-base">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                        <PlatformIcon
                          platform={s.platform}
                          colored
                          className="size-5"
                        />
                      </span>
                      <span className="flex-1">
                        {PLATFORM_LABELS[s.platform]}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        strokeWidth={2}
                        className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </CardTitle>
                    <CardDescription className="text-pretty">
                      {s.guide.summary}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </button>
            ))}
            {UPCOMING_PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                aria-label={m.new.comingSoonAria(PLATFORM_LABELS[p])}
                aria-haspopup="dialog"
                onClick={() => setNotReady(p)}
                className="group rounded-2xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Card className="h-full border-dashed bg-muted/30 opacity-70 transition-opacity group-hover:opacity-90">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-3 text-base">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted grayscale-[35%]">
                        <PlatformIcon platform={p} colored className="size-5" />
                      </span>
                      <span className="flex-1">{PLATFORM_LABELS[p]}</span>
                      <Badge variant="secondary" className="rounded-full">
                        {m.new.comingSoon}
                      </Badge>
                    </CardTitle>
                    <CardDescription className="text-pretty">
                      {m.new.comingSoonCard}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </button>
            ))}
          </div>
          <Dialog
            open={notReady !== null}
            onOpenChange={(open) => !open && setNotReady(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {notReady && m.new.comingSoonTitle(PLATFORM_LABELS[notReady])}
                </DialogTitle>
                <DialogDescription>
                  {notReady && m.new.comingSoonBody(PLATFORM_LABELS[notReady])}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="brand" onClick={() => setNotReady(null)}>
                  {m.new.comingSoonClose}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      )}

      {step === 1 && spec && (
          <Card>
            <form
              onSubmit={onSubmitCredentials}
              noValidate
              className="flex flex-col gap-6"
            >
              <CardHeader>
                <StepOverline step={1} />
                <CardTitle className="flex items-center gap-2">
                  <PlatformIcon platform={spec.platform} colored />
                  {m.new.formTitle(PLATFORM_LABELS[spec.platform])}
                </CardTitle>
                <CardDescription>{m.new.formDescription}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <FieldGroup>
                  <Field
                    data-invalid={!!form.formState.errors.name || undefined}
                  >
                    <FieldLabel htmlFor="connection-name">
                      {m.new.nameLabel}
                    </FieldLabel>
                    <Input
                      id="connection-name"
                      placeholder={m.new.namePlaceholder}
                      autoComplete="off"
                      aria-invalid={!!form.formState.errors.name || undefined}
                      {...form.register("name", {
                        validate: (v) =>
                          v.trim() === ""
                            ? m.errors.nameRequired
                            : v.trim().length > 100
                              ? m.errors.nameTooLong
                              : true,
                      })}
                    />
                    <FieldDescription>{m.new.nameHelp}</FieldDescription>
                    <FieldError errors={[form.formState.errors.name]} />
                  </Field>
                </FieldGroup>

                <CredentialFields
                  fields={spec.fields}
                  control={form.control}
                  prefix="credentials"
                />
              </CardContent>
              <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={() => setStep(0)}
                >
                  <HugeiconsIcon
                    icon={ArrowLeft01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  {m.new.steps.platform}
                </Button>
                <Button
                  type="submit"
                  variant="brand"
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={form.formState.isSubmitting}
                >
                  {form.formState.isSubmitting && <Spinner aria-hidden />}
                  {m.new.verifyNow}
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    data-icon="inline-end"
                    aria-hidden
                  />
                </Button>
              </CardFooter>
            </form>
          </Card>

      )}

      {step === 2 && spec && (
        <VerifyStep
          verify={verify}
          enabled={enabled}
          onEnabledChange={setEnabled}
          saving={saving}
          onBack={() => setStep(1)}
          onRetry={() => submitted && void runPreview(submitted)}
          onSave={() => void save()}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

const accCol = createDataTableColumnHelper<PreviewAccount>()

function VerifyStep({
  verify,
  enabled,
  onEnabledChange,
  saving,
  onBack,
  onRetry,
  onSave,
}: {
  verify: Verify
  enabled: Set<string>
  onEnabledChange: (s: Set<string>) => void
  saving: boolean
  onBack: () => void
  onRetry: () => void
  onSave: () => void
}) {
  const toggle = React.useCallback(
    (externalId: string, on: boolean) => {
      const next = new Set(enabled)
      if (on) next.add(externalId)
      else next.delete(externalId)
      onEnabledChange(next)
    },
    [enabled, onEnabledChange]
  )

  const columns = React.useMemo(
    () =>
      accCol.columns([
        accCol.display({
          id: "enabled",
          header: () => <span className="sr-only">{m.detail.colEnabled}</span>,
          meta: { className: "w-14" },
          cell: ({ row }) => (
            <Switch
              checked={enabled.has(row.original.externalId)}
              aria-label={m.detail.toggleAccount(row.original.name)}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(on) => toggle(row.original.externalId, on)}
            />
          ),
        }),
        accCol.accessor("name", {
          header: m.detail.colAccount,
          meta: { className: "w-full min-w-44 max-w-0" },
          cell: ({ row }) => (
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium">
                <span className="truncate" title={row.original.name}>
                  {row.original.name}
                </span>
                {row.original.isManager && (
                  <Badge
                    variant="outline"
                    className="shrink-0 rounded-full text-[11px]"
                  >
                    {m.detail.managerBadge}
                  </Badge>
                )}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {row.original.externalId}
              </span>
            </div>
          ),
        }),
        accCol.accessor("currency", {
          header: m.detail.colCurrency,
          meta: { className: "font-mono text-xs" },
        }),
        accCol.accessor("timezone", {
          header: m.detail.colTimezone,
          meta: {
            className: "hidden text-muted-foreground @2xl:table-cell",
            headerClassName: "hidden @2xl:table-cell",
          },
        }),
        accCol.accessor("status", {
          header: m.detail.colStatus,
          cell: ({ getValue }) => (
            <StatusBadge kind="account" status={getValue()} />
          ),
        }),
      ]),
    [enabled, toggle]
  )

  if (verify.state === "loading" || verify.state === "idle") {
    return (
      <Card>
        <CardContent
          className="flex flex-col gap-4 py-8"
          role="status"
          aria-live="polite"
        >
          <StepOverline step={2} />
          <div className="flex items-center gap-3">
            <Spinner className="size-5" aria-hidden />
            <div className="flex flex-col">
              <span className="text-sm font-medium">{m.new.verifying}</span>
              <span className="text-[13px] text-muted-foreground">
                {m.new.verifyingHint}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (verify.state === "error") {
    // the server sends one string "<what happened> <next step>" - show the next step as its own muted line
    const failure = splitTrailingHint(verify.message)
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <StepOverline step={2} />
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertTitle>{m.new.verifyFailedTitle}</AlertTitle>
            <AlertDescription>
              {failure.message}
              <StatusHint
                message={failure.message}
                hint={failure.hint}
                className="mt-1.5"
              />
            </AlertDescription>
          </Alert>
          <div className="rounded-xl border p-4">
            <p className="text-sm font-medium">
              {m.new.verifyFailedHintsTitle}
            </p>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted-foreground">
              {m.new.verifyFailedHints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={onRetry}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.new.retry}
            </Button>
            <Button
              variant="brand"
              size="lg"
              className="w-full sm:w-auto"
              onClick={onBack}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.new.editCredentials}
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { preview } = verify
  const enabledCount = preview.accounts.filter((a) =>
    enabled.has(a.externalId)
  ).length
  const defaultOff = defaultOffSummary(preview.accounts)
  const diff = enabledDiffFromDefaults(preview.accounts, enabled)
  const atDefaults =
    diff.disabledExternalIds.length === 0 &&
    diff.enabledExternalIds.length === 0
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <StepOverline step={2} />
          <TokenSummary
            status={preview.status}
            statusMessage={preview.statusMessage}
            statusHint={preview.statusHint}
            tokenExpiresAt={preview.tokenExpiresAt}
            scopes={preview.scopes}
            warnings={preview.warnings}
          />
        </CardContent>
      </Card>
      <Card className="@container gap-0 pb-0">
        <CardHeader className="border-b pb-4">
          <CardTitle>{m.new.accountsTitle}</CardTitle>
          <CardDescription>{m.new.accountsDescription}</CardDescription>
          <div className="col-span-full flex flex-wrap items-center gap-2 pt-2">
            <Badge variant="secondary" className="rounded-full tabular-nums">
              {m.new.accountsPicked(enabledCount, preview.accounts.length)}
            </Badge>
            <Button
              size="sm"
              className="pointer-coarse:h-10"
              variant="ghost"
              onClick={() =>
                onEnabledChange(
                  new Set(preview.accounts.map((a) => a.externalId))
                )
              }
            >
              {m.new.enableAll}
            </Button>
            <Button
              size="sm"
              className="pointer-coarse:h-10"
              variant="ghost"
              onClick={() => onEnabledChange(new Set())}
            >
              {m.new.disableAll}
            </Button>
            {defaultOff.total > 0 && (
              <Button
                size="sm"
                className="pointer-coarse:h-10"
                variant="ghost"
                aria-label={m.new.resetDefaultsLabel}
                disabled={atDefaults}
                onClick={() =>
                  onEnabledChange(initialEnabledExternalIds(preview.accounts))
                }
              >
                {m.new.resetDefaults}
              </Button>
            )}
          </div>
          {defaultOff.total > 0 && (
            <p className="col-span-full flex items-start gap-1.5 text-[13px] text-muted-foreground">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="mt-px size-3.5 shrink-0"
                aria-hidden
              />
              <span>
                {defaultOff.manager > 0 && defaultOff.inactive > 0
                  ? m.new.defaultOffNote.both
                  : defaultOff.manager > 0
                    ? m.new.defaultOffNote.manager
                    : m.new.defaultOffNote.inactive}
              </span>
            </p>
          )}
        </CardHeader>
        {preview.accounts.length === 0 ? (
          <CardContent className="py-8 text-sm text-muted-foreground">
            {m.new.noAccounts}
          </CardContent>
        ) : (
          <DataTable
            ariaLabel={m.new.accountsTitle}
            columns={columns}
            data={preview.accounts}
            getRowId={(r) => r.externalId}
            pageSize={10}
            renderMobileCard={(r) => (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="line-clamp-2 break-words">{r.name}</span>
                    {r.isManager && (
                      <Badge
                        variant="outline"
                        className="shrink-0 rounded-full text-[11px]"
                      >
                        {m.detail.managerBadge}
                      </Badge>
                    )}
                  </span>
                  <span className="font-mono text-xs break-all text-muted-foreground">
                    {r.externalId} · {r.currency}
                  </span>
                  <StatusBadge
                    kind="account"
                    status={r.status}
                    className="w-fit"
                  />
                </div>
                <Switch
                  checked={enabled.has(r.externalId)}
                  aria-label={m.detail.toggleAccount(r.name)}
                  onCheckedChange={(on) => toggle(r.externalId, on)}
                />
              </div>
            )}
          />
        )}
      </Card>
      {/* floating action bar: Save stays reachable while scrolling a long account list */}
      {/* phones: flush bar stacked right above the fixed bottom nav (full width, square) */}
      <div data-bottom-action-bar="" className="glass-strong sticky bottom-(--app-bottom-offset,0px) z-20 -mx-4 flex items-center justify-between gap-2 rounded-none border-x-0 p-2 px-4 md:bottom-3 md:mx-0 md:rounded-2xl md:border-x md:p-2">
        <Button variant="ghost" size="lg" onClick={onBack} disabled={saving}>
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            strokeWidth={2}
            data-icon="inline-start"
            aria-hidden
          />
          {m.new.editCredentials}
        </Button>
        <Button
          variant="brand"
          size="lg"
          className="flex-1 sm:flex-none"
          onClick={onSave}
          disabled={saving}
        >
          {saving && <Spinner aria-hidden />}
          {m.new.save}
        </Button>
      </div>
    </div>
  )
}
