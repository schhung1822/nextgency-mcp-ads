"use client"

// /connections/drive/new — 3 steps: ① kind + scope ② share with the email + paste the link + "Kiểm tra" (preview,
// nothing saved) ③ name / folder depth / sheet column mapping + write-back → "Lưu" (all checks run again server-side).
import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Add01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  Folder01Icon,
  GoogleSheetIcon,
  InformationCircleIcon,
  LockKeyIcon,
  SearchList01Icon,
  Settings02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { BrandIcon, CopyField, PageGuide, Stepper } from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  DRIVE_FORM_LIMITS,
  SHEET_COLUMN_KEYS,
  type DriveSourceKindDto,
  type DriveSourcePreview,
  type DriveSourceScopeDto,
  type DriveSystemInfo,
  type PersonalDriveCredentialDto,
} from "@/lib/schemas/drive"
import {
  createDriveSourceAction,
  previewDriveSourceAction,
} from "@/server/actions/drive"

import { DriveStatusBadge } from "../../_components/drive-badges"
import { driveStatusText } from "../../_components/drive-format"
import { AddPersonalCredentialDialog } from "../../_components/personal-credentials"
import {
  SheetColumnsFields,
  type SheetColumnsValue,
} from "../../_components/sheet-columns-fields"

const m = driveUi.wizard
const SYSTEM = "system"
/** server field errors that belong to step 2 (link / credential) - the rest stay on step 3 */
const STEP2_FIELDS = ["link", "credentialId", "scope", "headerRow", "kind"]

const EMPTY_COLUMNS = Object.fromEntries(
  SHEET_COLUMN_KEYS.map((k) => [k, null])
) as SheetColumnsValue

type Check =
  | { state: "idle" }
  | { state: "ok"; preview: DriveSourcePreview; key: string }
  | { state: "error"; message: string }

/** Radio "card" (same look as the automation rule builder): radio + title + one-line description. */
function ChoiceRadio({
  id,
  value,
  icon,
  title,
  description,
  disabled,
}: {
  id: string
  value: string
  icon?: IconSvgElement
  title: string
  description: string
  disabled?: boolean
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-2xl border bg-input/20 p-3.5 transition-colors",
        "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
        "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-primary/5",
        disabled && "pointer-events-none opacity-60"
      )}
    >
      <RadioGroupItem
        value={value}
        id={id}
        disabled={disabled}
        aria-label={title}
        className="mt-0.5"
      />
      {icon && (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" aria-hidden />
        </span>
      )}
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm leading-5 font-medium">{title}</span>
        <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  )
}

function StepOverline({ step }: { step: number }) {
  return (
    <p className="text-xs font-medium text-muted-foreground md:hidden">
      {m.stepProgress(step + 1, m.steps.length, m.steps[step]!.title)}
    </p>
  )
}

function PreviewRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

/** Result of "Kiểm tra": real name, counts / tab + header, permission (like the Telegram check summary). */
function PreviewSummary({
  preview,
  outdated,
}: {
  preview: DriveSourcePreview
  outdated: boolean
}) {
  const f = preview.folder
  const s = preview.sheet
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-success/30 bg-success/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-success-strong">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
          aria-hidden
        />
        {m.checkOkTitle}
      </p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <PreviewRow label={m.previewName}>
          <span className="font-medium">{preview.googleName}</span>
          {preview.sharedDrive && (
            <span className="block text-[13px] text-muted-foreground">
              {m.previewSharedDrive}
            </span>
          )}
        </PreviewRow>
        {f && (
          <PreviewRow label={m.previewContent}>
            <span className="tabular-nums">
              {m.previewFolderCounts(f.images, f.videos, f.folders, f.more)}
            </span>
          </PreviewRow>
        )}
        {s && (
          <>
            <PreviewRow label={m.previewTab}>
              <span className="font-medium">{s.title}</span>
              {s.rowCount !== null && (
                <span className="block text-[13px] text-muted-foreground tabular-nums">
                  {m.previewRows(s.rowCount)}
                </span>
              )}
            </PreviewRow>
            <PreviewRow label={m.previewPermission}>
              {s.canEdit ? m.previewCanEdit : m.previewViewOnly}
            </PreviewRow>
          </>
        )}
      </dl>
      {s && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">
            {m.previewHeader} ({s.headerRow})
          </span>
          <div className="flex flex-wrap gap-1">
            {s.header.filter((h) => h.trim()).length === 0 ? (
              <span className="text-[13px] text-muted-foreground">
                {m.previewHeaderEmpty}
              </span>
            ) : (
              s.header
                .filter((h) => h.trim())
                .slice(0, 20)
                .map((h, i) => (
                  <span
                    key={`${h}-${i}`}
                    className="max-w-48 truncate rounded-md bg-muted px-1.5 py-0.5 text-xs"
                    title={h}
                  >
                    {h}
                  </span>
                ))
            )}
          </div>
        </div>
      )}
      {f && f.images + f.videos === 0 && (
        <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <HugeiconsIcon
            icon={InformationCircleIcon}
            strokeWidth={2}
            className="mt-px size-3.5 shrink-0"
            aria-hidden
          />
          {m.previewEmptyFolder}
        </p>
      )}
      {outdated && (
        <p className="flex items-start gap-1.5 text-[13px] text-warning-strong">
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            className="mt-px size-3.5 shrink-0"
            aria-hidden
          />
          {m.outdated}
        </p>
      )}
    </div>
  )
}

export function DriveSourceWizard({
  isAdmin,
  system,
  ownCredentials,
}: {
  isAdmin: boolean
  system: DriveSystemInfo
  /** the viewer's OWN service accounts (never a key) */
  ownCredentials: PersonalDriveCredentialDto[]
}) {
  const router = useRouter()
  const systemUsable =
    system.configured && !!system.clientEmail && system.status !== "disabled"
  const usableOwn = ownCredentials.filter((c) => c.status !== "disabled")

  const [step, setStep] = React.useState(0)
  const [kind, setKind] = React.useState<DriveSourceKindDto>("folder")
  // staff only register personal sources (company = admin)
  const [scope, setScope] = React.useState<DriveSourceScopeDto>(
    isAdmin && systemUsable ? "company" : "personal"
  )
  const [credential, setCredential] = React.useState<string>(
    systemUsable || usableOwn.length === 0 ? SYSTEM : usableOwn[0]!.id
  )
  const [link, setLink] = React.useState("")
  const [headerRow, setHeaderRow] = React.useState("1")
  const [name, setName] = React.useState("")
  const [depth, setDepth] = React.useState(1)
  const [columns, setColumns] = React.useState<SheetColumnsValue>(EMPTY_COLUMNS)
  const [writeback, setWriteback] = React.useState(false)
  const [check, setCheck] = React.useState<Check>({ state: "idle" })
  const [checking, setChecking] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [addOpen, setAddOpen] = React.useState(false)
  const [announcement, setAnnouncement] = React.useState("")
  const resultRef = React.useRef<HTMLDivElement>(null)
  const [resultRuns, setResultRuns] = React.useState(0)
  React.useEffect(() => {
    if (resultRuns === 0) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    resultRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    })
  }, [resultRuns])
  // each step starts at the top (long step 3 on a phone)
  const topRef = React.useRef<HTMLDivElement>(null)
  const goto = (s: number) => {
    setStep(s)
    requestAnimationFrame(() =>
      topRef.current?.scrollIntoView({ block: "nearest" })
    )
  }

  const effectiveCredential = scope === "company" ? SYSTEM : credential
  const credentialId =
    effectiveCredential === SYSTEM ? null : effectiveCredential
  const ownCred = ownCredentials.find((c) => c.id === credentialId) ?? null
  const shareEmail = credentialId
    ? (ownCred?.clientEmail ?? null)
    : systemUsable
      ? system.clientEmail
      : null
  const headerRowNum = Number(headerRow)
  const key = JSON.stringify([
    kind,
    scope,
    credentialId,
    link.trim(),
    kind === "sheet" ? headerRowNum : null,
  ])
  const checkedOk = check.state === "ok" && check.key === key
  const preview = check.state === "ok" ? check.preview : null
  const busy = checking || saving

  const clearError = (k: string) =>
    setErrors((e) => {
      if (!(k in e)) return e
      const { [k]: _drop, ...rest } = e
      return rest
    })

  const runCheck = async () => {
    const errs: Record<string, string> = {}
    if (!link.trim()) errs.link = driveUi.service.linkRequired
    if (
      kind === "sheet" &&
      (!Number.isInteger(headerRowNum) ||
        headerRowNum < 1 ||
        headerRowNum > DRIVE_FORM_LIMITS.headerRowMax)
    )
      errs.headerRow = driveUi.service.headerRowRange
    if (Object.keys(errs).length) {
      setErrors(errs)
      return
    }
    setErrors({})
    setChecking(true)
    setAnnouncement("")
    const res = await previewDriveSourceAction({
      kind,
      scope,
      link: link.trim(),
      credentialId,
      headerRow: kind === "sheet" ? headerRowNum : undefined,
    })
    setChecking(false)
    if (!res.ok) {
      // only link-FORMAT errors arrive on fieldErrors.link (the action keeps credential / permission / Google
      // errors off the field): those stay under the link input, everything else is the Alert below it
      const fe = res.fieldErrors ?? {}
      const placed = Object.fromEntries(
        Object.entries(fe).filter(([k]) => STEP2_FIELDS.includes(k))
      )
      setErrors(placed)
      if (fe.link) {
        setCheck({ state: "idle" })
      } else {
        setCheck({
          state: "error",
          // staff + system email: "ask the administrator" instead of "create a new JSON key"
          message:
            driveStatusText(res.error, {
              isAdmin,
              credentialKind: credentialId ? "personal" : "system",
            }) ?? res.error,
        })
        setResultRuns((n) => n + 1)
      }
      return
    }
    const p = res.data
    setCheck({ state: "ok", preview: p, key })
    if (p.sheet) {
      setColumns({ ...EMPTY_COLUMNS, ...p.sheet.suggestedColumns })
      setWriteback(p.sheet.canEdit && !!p.sheet.suggestedColumns.status)
    }
    setResultRuns((n) => n + 1)
    setAnnouncement(m.announceOk(p.googleName))
    toast.success(m.checkOkTitle, { description: p.googleName })
  }

  const save = async () => {
    if (!checkedOk || !preview) return
    if (kind === "sheet" && writeback && !columns.status) {
      setErrors({ "columns.status": driveUi.service.writebackNeedsStatusColumn })
      return
    }
    setSaving(true)
    setSaveError(null)
    setErrors({})
    const res = await createDriveSourceAction({
      kind,
      scope,
      link: link.trim(),
      credentialId,
      headerRow: kind === "sheet" ? headerRowNum : undefined,
      name: name.trim(),
      recursiveDepth: kind === "folder" ? depth : undefined,
      columns: kind === "sheet" ? columns : undefined,
      writeback: kind === "sheet" ? writeback : undefined,
    })
    if (!res.ok) {
      setSaving(false)
      const fe = res.fieldErrors ?? {}
      setErrors(fe)
      if (Object.keys(fe).some((k) => STEP2_FIELDS.includes(k))) {
        setCheck({ state: "idle" })
        goto(1)
        toast.error(res.error)
        return
      }
      if (Object.keys(fe).length === 0)
        setSaveError(
          driveStatusText(res.error, {
            isAdmin,
            credentialKind: credentialId ? "personal" : "system",
          }) ?? res.error
        )
      else toast.error(res.error)
      return
    }
    toast.success(res.message ?? driveUi.service.done.sourceCreated)
    router.push(`/connections/drive/${res.data.id}?created=1`)
  }

  const canEditSheet = !!preview?.sheet?.canEdit

  return (
    <div ref={topRef} className="flex scroll-mt-24 flex-col gap-6">
      {/* step-aware guide (right-hand panel / sheet), like /connections/new */}
      <PageGuide guide={driveUi.guides.newSteps[step] ?? driveUi.guides.new} />
      <Stepper
        steps={m.steps as unknown as { title: string }[]}
        current={step}
        onStepClick={(i) => i < step && !busy && goto(i)}
      />
      <Card>
        {step === 0 && (
          <>
            <CardHeader>
              <StepOverline step={0} />
              <CardTitle id="drive-kind-title">{m.kindTitle}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <RadioGroup
                value={kind}
                onValueChange={(v) => {
                  setKind(v === "sheet" ? "sheet" : "folder")
                  setCheck({ state: "idle" })
                }}
                aria-labelledby="drive-kind-title"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <ChoiceRadio
                  id="drive-kind-folder"
                  value="folder"
                  icon={Folder01Icon}
                  title={m.kind.folder!.label}
                  description={m.kind.folder!.description}
                />
                <ChoiceRadio
                  id="drive-kind-sheet"
                  value="sheet"
                  icon={GoogleSheetIcon}
                  title={m.kind.sheet!.label}
                  description={m.kind.sheet!.description}
                />
              </RadioGroup>
              <div className="flex flex-col gap-3">
                <h3 id="drive-scope-title" className="text-base font-semibold">
                  {m.scopeTitle}
                </h3>
                {isAdmin ? (
                  <RadioGroup
                    value={scope}
                    onValueChange={(v) => {
                      setScope(v === "company" ? "company" : "personal")
                      setCheck({ state: "idle" })
                    }}
                    aria-labelledby="drive-scope-title"
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <ChoiceRadio
                      id="drive-scope-company"
                      value="company"
                      icon={UserGroupIcon}
                      title={m.scope.company!.label}
                      description={m.scope.company!.description}
                    />
                    <ChoiceRadio
                      id="drive-scope-personal"
                      value="personal"
                      icon={LockKeyIcon}
                      title={m.scope.personal!.label}
                      description={m.scope.personal!.description}
                    />
                  </RadioGroup>
                ) : (
                  <div className="flex items-start gap-3 rounded-2xl border bg-muted/40 p-3.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                      <HugeiconsIcon
                        icon={LockKeyIcon}
                        strokeWidth={2}
                        className="size-5"
                        aria-hidden
                      />
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-sm font-medium">
                        {m.scope.personal!.label}
                      </span>
                      <span className="text-[13px] text-pretty text-muted-foreground">
                        {m.scopeStaffNote}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </>
        )}

        {step === 1 && (
          <>
            <CardHeader>
              <StepOverline step={1} />
              <CardTitle id="drive-cred-title">{m.credentialTitle}</CardTitle>
              {scope === "company" && (
                <CardDescription>{m.credentialCompanyNote}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {scope === "personal" && (
                <div className="flex flex-col gap-3">
                  <RadioGroup
                    value={credential === SYSTEM ? SYSTEM : "own"}
                    onValueChange={(v) => {
                      setCheck({ state: "idle" })
                      setCredential(
                        v === SYSTEM ? SYSTEM : (usableOwn[0]?.id ?? "own")
                      )
                    }}
                    aria-labelledby="drive-cred-title"
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <ChoiceRadio
                      id="drive-cred-system"
                      value={SYSTEM}
                      title={m.credentialSystem}
                      description={m.credentialSystemHint}
                      disabled={!systemUsable}
                    />
                    <ChoiceRadio
                      id="drive-cred-own"
                      value="own"
                      title={m.credentialOwn}
                      description={m.credentialOwnHint}
                    />
                  </RadioGroup>
                  {credential !== SYSTEM && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      {usableOwn.length > 0 ? (
                        <Field className="min-w-0 flex-1 gap-1.5">
                          <FieldLabel htmlFor="drive-cred-pick">
                            {m.credentialPick}
                          </FieldLabel>
                          <Select
                            value={ownCred ? credential : undefined}
                            onValueChange={(v) => {
                              setCredential(v)
                              setCheck({ state: "idle" })
                            }}
                          >
                            <SelectTrigger id="drive-cred-pick" className="w-full">
                              <SelectValue placeholder={m.credentialPick} />
                            </SelectTrigger>
                            <SelectContent>
                              {usableOwn.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name} · {c.clientEmail}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : (
                        <p className="flex-1 text-[13px] text-muted-foreground">
                          {m.noOwnCredentials}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 pointer-coarse:h-10"
                        onClick={() => setAddOpen(true)}
                      >
                        <HugeiconsIcon
                          icon={Add01Icon}
                          strokeWidth={2}
                          data-icon="inline-start"
                          aria-hidden
                        />
                        {m.addOwn}
                      </Button>
                    </div>
                  )}
                  {errors.credentialId && (
                    <FieldError>{errors.credentialId}</FieldError>
                  )}
                </div>
              )}

              {shareEmail ? (
                <section
                  aria-labelledby="drive-share-title"
                  className="flex flex-col gap-3 rounded-2xl border p-4"
                >
                  <h3
                    id="drive-share-title"
                    className="flex items-center gap-2 text-sm font-semibold"
                  >
                    <BrandIcon brand="drive" />
                    {m.shareTitle}
                  </h3>
                  <CopyField value={shareEmail} label={m.emailCopyLabel} wrap />
                  {ownCred && ownCred.status === "error" && (
                    <span className="flex items-center gap-2 text-[13px] text-destructive">
                      <DriveStatusBadge status="error" />
                      {ownCred.statusMessage}
                    </span>
                  )}
                  <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-pretty marker:text-muted-foreground">
                    {(m.shareSteps[kind] ?? []).map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </section>
              ) : (
                credential === SYSTEM && (
                  <Alert>
                    <HugeiconsIcon
                      icon={InformationCircleIcon}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <AlertTitle>{driveUi.list.notConfiguredTitle}</AlertTitle>
                    <AlertDescription className="flex flex-col items-start gap-3">
                      <span>
                        {isAdmin ? m.systemMissingAdmin : m.systemMissing}
                      </span>
                      {isAdmin && (
                        <Button variant="outline" size="sm" asChild>
                          <Link href="/settings#google-drive" className="no-underline!">
                            <HugeiconsIcon
                              icon={Settings02Icon}
                              strokeWidth={2}
                              data-icon="inline-start"
                              aria-hidden
                            />
                            {driveUi.list.openSettings}
                          </Link>
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )
              )}

              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <Field
                  data-invalid={errors.link ? true : undefined}
                  className="min-w-0 flex-1"
                >
                  <FieldLabel htmlFor="drive-link">{m.linkLabel[kind]}</FieldLabel>
                  <Input
                    id="drive-link"
                    value={link}
                    onChange={(e) => {
                      setLink(e.target.value)
                      clearError("link")
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        if (!busy && shareEmail) void runCheck()
                      }
                    }}
                    placeholder={m.linkPlaceholder[kind]}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={DRIVE_FORM_LIMITS.linkMax}
                    aria-invalid={errors.link ? true : undefined}
                    aria-describedby="drive-link-help"
                    className="font-mono text-[13px]"
                  />
                  <FieldDescription id="drive-link-help">
                    {m.linkHelp[kind]}
                  </FieldDescription>
                  {errors.link && <FieldError>{errors.link}</FieldError>}
                </Field>
                {kind === "sheet" && (
                  <Field
                    data-invalid={errors.headerRow ? true : undefined}
                    className="sm:w-36"
                  >
                    <FieldLabel htmlFor="drive-header-row">
                      {m.headerRowLabel}
                    </FieldLabel>
                    <Input
                      id="drive-header-row"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={DRIVE_FORM_LIMITS.headerRowMax}
                      step={1}
                      value={headerRow}
                      onChange={(e) => {
                        setHeaderRow(e.target.value)
                        clearError("headerRow")
                      }}
                      className="w-28 tabular-nums"
                      aria-invalid={errors.headerRow ? true : undefined}
                      aria-describedby="drive-header-row-help"
                    />
                    <FieldDescription id="drive-header-row-help">
                      {m.headerRowHelp}
                    </FieldDescription>
                    {errors.headerRow && (
                      <FieldError>{errors.headerRow}</FieldError>
                    )}
                  </Field>
                )}
              </div>

              <div ref={resultRef} className="scroll-mt-24 empty:hidden">
                {check.state === "ok" && (
                  <PreviewSummary
                    preview={check.preview}
                    outdated={check.key !== key}
                  />
                )}
                {check.state === "error" && (
                  <Alert variant="destructive" role="alert">
                    <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
                    <AlertTitle>{m.checkFailTitle}</AlertTitle>
                    <AlertDescription>{check.message}</AlertDescription>
                  </Alert>
                )}
              </div>
              <p aria-live="polite" className="sr-only">
                {announcement}
              </p>
            </CardContent>
          </>
        )}

        {step === 2 && preview && (
          <>
            <CardHeader>
              <StepOverline step={2} />
              <CardTitle>{m.settingsTitle}</CardTitle>
              <CardDescription>{preview.googleName}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor="drive-name">{m.nameLabel}</FieldLabel>
                  <Input
                    id="drive-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      clearError("name")
                    }}
                    placeholder={preview.googleName}
                    maxLength={DRIVE_FORM_LIMITS.nameMax}
                    autoComplete="off"
                    aria-invalid={errors.name ? true : undefined}
                    aria-describedby="drive-name-help"
                  />
                  <FieldDescription id="drive-name-help">
                    {m.nameHelp}
                  </FieldDescription>
                  {errors.name && <FieldError>{errors.name}</FieldError>}
                </Field>
                {kind === "folder" && (
                  <Field>
                    <FieldLabel htmlFor="drive-depth">{m.depthLabel}</FieldLabel>
                    <Select
                      value={String(depth)}
                      onValueChange={(v) => setDepth(Number(v))}
                    >
                      <SelectTrigger id="drive-depth" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {m.depthOptions.map((label, i) => (
                          <SelectItem key={label} value={String(i)}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>{m.depthHelp}</FieldDescription>
                  </Field>
                )}
              </div>

              {kind === "sheet" && preview.sheet && (
                <>
                  <section
                    aria-labelledby="drive-columns-title"
                    className="flex flex-col gap-4 border-t pt-5"
                  >
                    <div>
                      <h3
                        id="drive-columns-title"
                        className="text-base font-semibold"
                      >
                        {m.columnsTitle}
                      </h3>
                      <p className="text-[13px] text-pretty text-muted-foreground">
                        {m.columnsDescription}
                      </p>
                    </div>
                    <SheetColumnsFields
                      idPrefix="drive-new"
                      header={preview.sheet.header}
                      value={columns}
                      onChange={(k, v) => {
                        setColumns((c) => ({ ...c, [k]: v }))
                        clearError(`columns.${k}`)
                      }}
                      writeback={writeback}
                      errors={errors}
                      disabled={saving}
                      writebackControl={
                        <Field
                          orientation="horizontal"
                          data-invalid={errors.writeback ? true : undefined}
                        >
                          <FieldContent>
                            <FieldLabel htmlFor="drive-writeback">
                              {m.writebackLabel}
                            </FieldLabel>
                            <FieldDescription>
                              {!canEditSheet && !writeback
                                ? m.writebackNeedsEdit
                                : m.writebackHelp}
                            </FieldDescription>
                            {errors.writeback && (
                              <FieldError>{errors.writeback}</FieldError>
                            )}
                          </FieldContent>
                          <Switch
                            id="drive-writeback"
                            checked={writeback}
                            onCheckedChange={(v) => {
                              setWriteback(v)
                              clearError("writeback")
                              clearError("columns.status")
                            }}
                            disabled={saving || (!writeback && !canEditSheet)}
                          />
                        </Field>
                      }
                    />
                    <p className="text-[13px] text-pretty text-muted-foreground">
                      {m.templateHint}
                    </p>
                  </section>
                </>
              )}

              {saveError && (
                <Alert variant="destructive" role="alert">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
                  <AlertTitle>{m.checkFailTitle}</AlertTitle>
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </>
        )}

        <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-between">
          {step === 0 ? (
            <Button variant="ghost" size="lg" className="w-full sm:w-auto" asChild>
              <Link href="/connections?tab=drive">
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden
                />
                {m.back}
              </Link>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => goto(step - 1)}
              disabled={busy}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.back}
            </Button>
          )}
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:items-center">
            {step === 1 && !checkedOk && (
              <span className="text-center text-[13px] text-muted-foreground sm:text-right">
                {m.needCheck}
              </span>
            )}
            {step === 1 && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => void runCheck()}
                disabled={busy || !shareEmail}
              >
                {checking ? (
                  <Spinner aria-hidden />
                ) : (
                  <HugeiconsIcon
                    icon={SearchList01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                )}
                {checking ? m.checking : m.check}
              </Button>
            )}
            {step < 2 ? (
              <Button
                type="button"
                variant="brand"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => goto(step + 1)}
                disabled={busy || (step === 1 && !checkedOk)}
              >
                {m.next}
              </Button>
            ) : (
              <Button
                type="button"
                variant="brand"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => void save()}
                disabled={busy || !checkedOk}
              >
                {saving && <Spinner aria-hidden />}
                {saving ? m.saving : m.save}
              </Button>
            )}
          </div>
        </CardFooter>
      </Card>
      <AddPersonalCredentialDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(c) => {
          setCredential(c.id)
          setCheck({ state: "idle" })
        }}
      />
    </div>
  )
}
