"use client"

// /connections/apify/new: name + API token (+ scope for admins) → "Kiểm tra" (account, plan, credit; nothing saved)
// → "Kiểm tra & lưu". After saving the token leaves the browser and the card offers the list or another token.
import * as React from "react"
import Link from "next/link"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"
import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  LockKeyIcon,
  SearchList01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { cn } from "cn"

import { BrandIcon, SecretInput } from "@/components/app"
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
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { apify as a } from "@/lib/i18n/vi/apify"
import {
  APIFY_LIMITS,
  createApifyTokenSchema,
  type ApifyAccountPreview,
  type CreateApifyTokenInput,
} from "@/lib/schemas/apify"
import {
  createApifyTokenAction,
  previewApifyTokenAction,
} from "@/server/actions/apify"

import {
  APIFY_CONSOLE_URL,
  ApifyCheckError,
  ApifyCheckSummary,
  ApifyExternalLink,
} from "../../_components/apify-check-result"

const m = a.form

type Check =
  | { state: "idle" }
  | { state: "ok"; result: ApifyAccountPreview; key: string }
  | { state: "error"; message: string }

const FIELD_KEYS = ["name", "token", "scope"] as const

/** what a check depends on: re-check needed when it changes */
const checkKey = (token: string | undefined) => (token ?? "").trim()

function ScopeChoice({
  id,
  value,
  icon,
  title,
  description,
}: {
  id: string
  value: string
  icon: IconSvgElement
  title: string
  description: string
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-2xl border bg-input/20 p-3.5 transition-colors",
        "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
        "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-brand-primary/5"
      )}
    >
      <RadioGroupItem
        value={value}
        id={id}
        aria-label={title}
        className="mt-0.5"
      />
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <HugeiconsIcon
          icon={icon}
          strokeWidth={2}
          className="size-5"
          aria-hidden
        />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm leading-5 font-medium">{title}</span>
        <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  )
}

export function ApifyNewForm({ isAdmin }: { isAdmin: boolean }) {
  const [check, setCheck] = React.useState<Check>({ state: "idle" })
  const [checking, setChecking] = React.useState(false)
  /** set after a successful save: the card turns into "what next" */
  const [saved, setSaved] = React.useState<{ id: string; name: string } | null>(
    null
  )
  // the result block (check summary / error box) is brought into view after each run
  const resultRef = React.useRef<HTMLDivElement>(null)
  const [resultRuns, setResultRuns] = React.useState(0)
  // always-mounted polite live region: a freshly mounted region is often not announced
  const [announcement, setAnnouncement] = React.useState("")
  React.useEffect(() => {
    if (resultRuns === 0) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    resultRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    })
  }, [resultRuns])

  // admins usually add the shared company pool; staff tokens are always personal (the service enforces it too)
  const defaults: CreateApifyTokenInput = {
    name: "",
    token: "",
    scope: isAdmin ? "company" : "personal",
  }
  const form = useForm<CreateApifyTokenInput>({
    resolver: zodResolver(createApifyTokenSchema),
    defaultValues: defaults,
    mode: "onTouched",
  })
  const watchedToken = useWatch({ control: form.control, name: "token" })
  const currentKey = checkKey(watchedToken)

  /** server field errors → the matching field; anything else → the error box */
  const applyFailure = (
    error: string,
    fieldErrors?: Record<string, string>
  ) => {
    let placed = false
    for (const k of FIELD_KEYS) {
      const msg = fieldErrors?.[k]
      if (msg) {
        form.setError(k, { message: msg })
        placed = true
      }
    }
    if (!placed) {
      setCheck({ state: "error", message: error })
      setResultRuns((n) => n + 1)
    }
  }

  const runCheck = async () => {
    const valid = await form.trigger("token")
    if (!valid) return
    const token = form.getValues("token")
    setChecking(true)
    setAnnouncement("")
    const res = await previewApifyTokenAction({ token })
    setChecking(false)
    if (!res.ok) {
      setCheck({ state: "idle" })
      applyFailure(res.error, res.fieldErrors)
      return
    }
    setCheck({ state: "ok", result: res.data, key: checkKey(token) })
    setResultRuns((n) => n + 1)
    setAnnouncement(a.check.announceOk(res.data.username ?? a.ui.noUsername))
    toast.success(a.check.okTitle)
  }

  const onSubmit = form.handleSubmit(async (v) => {
    setCheck((c) => (c.state === "error" ? { state: "idle" } : c))
    const res = await createApifyTokenAction({
      name: v.name,
      token: v.token,
      scope: isAdmin ? v.scope : "personal",
    })
    if (!res.ok) {
      applyFailure(res.error, res.fieldErrors)
      return
    }
    toast.success(res.message ?? a.server.created)
    // the token never stays in the browser after saving
    form.reset(defaults)
    setCheck({ state: "idle" })
    setSaved({ id: res.data.id, name: v.name.trim() })
  })

  const addAnother = () => {
    form.reset(defaults)
    setCheck({ state: "idle" })
    setAnnouncement("")
    setSaved(null)
  }

  if (saved) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              className="size-5 text-success"
              aria-hidden
            />
            {m.savedTitle}
          </CardTitle>
          <CardDescription>{m.savedBody(saved.name)}</CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            size="lg"
            className="w-full sm:w-auto"
            asChild
          >
            <Link href={`/connections/apify/${saved.id}`}>
              {m.viewToken}
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                data-icon="inline-end"
                aria-hidden
              />
            </Link>
          </Button>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={addAnother}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.addAnother}
            </Button>
            <Button
              variant="brand"
              size="lg"
              className="w-full sm:w-auto"
              asChild
            >
              <Link href="/connections?tab=apify">{m.goList}</Link>
            </Button>
          </div>
        </CardFooter>
      </Card>
    )
  }

  const submitting = form.formState.isSubmitting
  const busy = submitting || checking

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BrandIcon brand="apify" />
            {m.cardTitle}
          </CardTitle>
          <CardDescription>{m.cardDescription}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Alert>
            <HugeiconsIcon
              icon={InformationCircleIcon}
              strokeWidth={2}
              aria-hidden
            />
            <AlertTitle>{m.tosTitle}</AlertTitle>
            <AlertDescription className="flex flex-col gap-1.5">
              <span>{m.tosBody}</span>
              <span>{m.limitTip}</span>
            </AlertDescription>
          </Alert>

          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="apify-new-name">{m.nameLabel}</FieldLabel>
                <Input
                  id="apify-new-name"
                  {...field}
                  placeholder={m.namePlaceholder}
                  autoComplete="off"
                  maxLength={APIFY_LIMITS.nameMax}
                  aria-invalid={fieldState.invalid || undefined}
                  aria-describedby="apify-new-name-help"
                />
                <FieldDescription id="apify-new-name-help">
                  {m.nameHelp}
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="token"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="apify-new-token">
                  {m.tokenLabel}
                </FieldLabel>
                <SecretInput
                  id="apify-new-token"
                  name={field.name}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  ref={field.ref}
                  placeholder={m.tokenPlaceholder}
                  aria-invalid={fieldState.invalid || undefined}
                  aria-describedby="apify-new-token-help"
                />
                <FieldDescription id="apify-new-token-help">
                  {m.tokenHelp}{" "}
                  <ApifyExternalLink href={APIFY_CONSOLE_URL}>
                    {m.consoleLink}
                  </ApifyExternalLink>
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <div className="flex flex-col gap-3">
            <h3 id="apify-scope-title" className="text-sm font-medium">
              {m.scopeTitle}
            </h3>
            {isAdmin ? (
              <Controller
                control={form.control}
                name="scope"
                render={({ field, fieldState }) => (
                  <>
                    <RadioGroup
                      value={field.value}
                      onValueChange={(v) =>
                        field.onChange(v === "company" ? "company" : "personal")
                      }
                      aria-labelledby="apify-scope-title"
                      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                    >
                      <ScopeChoice
                        id="apify-scope-company"
                        value="company"
                        icon={UserGroupIcon}
                        title={m.scope.company!.label}
                        description={m.scope.company!.description}
                      />
                      <ScopeChoice
                        id="apify-scope-personal"
                        value="personal"
                        icon={LockKeyIcon}
                        title={m.scope.personal!.label}
                        description={m.scope.personal!.description}
                      />
                    </RadioGroup>
                    <FieldError errors={[fieldState.error]} />
                  </>
                )}
              />
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

          <div ref={resultRef} className="scroll-mt-24 empty:hidden">
            {check.state === "ok" && (
              <ApifyCheckSummary
                preview={check.result}
                outdated={check.key !== currentKey}
              />
            )}
            {check.state === "error" && (
              <ApifyCheckError message={check.message} />
            )}
          </div>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </CardContent>
        <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            size="lg"
            className={cn(
              "w-full sm:w-auto",
              busy && "pointer-events-none opacity-50"
            )}
            asChild
          >
            <Link
              href="/connections/new"
              aria-disabled={busy || undefined}
              tabIndex={busy ? -1 : undefined}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.back}
            </Link>
          </Button>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => void runCheck()}
              disabled={busy}
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
            <Button
              type="submit"
              variant="brand"
              size="lg"
              className="w-full sm:w-auto"
              disabled={busy}
            >
              {submitting && <Spinner aria-hidden />}
              {submitting ? m.saving : m.save}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  )
}
