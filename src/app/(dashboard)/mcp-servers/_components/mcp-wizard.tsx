"use client"

import * as React from "react"
import Link from "next/link"
import { Link04Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import { EmptyState, PageGuide, ReauthDialog, Stepper } from "@/components/app"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { ActionResult } from "@/lib/action-result"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  defaultMcpFormValues,
  MCP_CAP_FIELDS,
  formValuesToCreateInput,
  validateNameStep,
  validatePlatformsStep,
  validateProtectionStep,
  type McpFormValues,
  type StepErrors,
} from "@/lib/schemas/mcp-servers"
import type { SelectableConnection } from "@/server/services/mcp-servers"

import { McpCreated } from "./mcp-created"
import {
  moneyScopeCurrencies,
  NameSection,
  PermissionsSection,
  PlatformsSection,
  ProtectionSection,
  type FormUpdater,
} from "./mcp-form-sections"

export type CreateMcpActionFn = (
  input: unknown
) => Promise<ActionResult<{ id: string; name: string; url: string }>>

const STEPS = [
  t.wizard.steps.name,
  t.wizard.steps.platforms,
  t.wizard.steps.permissions,
  t.wizard.steps.protection,
]

const STEP_CARD = [
  { title: t.nameStep.cardTitle, description: undefined },
  {
    title: t.platformsStep.cardTitle,
    description: t.platformsStep.cardDescription,
  },
  {
    title: t.permissionsStep.cardTitle,
    description: t.permissionsStep.cardDescription,
  },
  {
    title: t.protectionStep.cardTitle,
    description: t.protectionStep.cardDescription,
  },
] as const

function validateStep(
  step: number,
  v: McpFormValues,
  connections: SelectableConnection[]
): StepErrors {
  if (step === 0) return validateNameStep(v)
  if (step === 1) return validatePlatformsStep(v)
  if (step === 3)
    return validateProtectionStep(v, {
      requiredCapCurrencies: moneyScopeCurrencies(v, connections),
    })
  return {}
}

/** Map server fieldErrors (zod paths) to wizard error keys + the step that owns them. */
export function mapServerErrors(
  fieldErrors: Record<string, string> | undefined
): { errors: StepErrors; step: number | null } {
  const errors: StepErrors = {}
  let step: number | null = null
  const at = (s: number) => {
    step = step === null ? s : Math.min(step, s)
  }
  for (const [k, msg] of Object.entries(fieldErrors ?? {})) {
    if (k === "name" || k === "description") {
      errors[k] = msg
      at(0)
    } else if (k.startsWith("platforms")) {
      errors[
        k.match(
          /^platforms\.(meta|openai_ads)(\.[0-9a-f-]{36})?$/
        )
          ? k
          : "platforms"
      ] = msg
      at(1)
    } else if (k.startsWith("settings.") || k === "expiresAt") {
      const key =
        k === "expiresAt"
          ? "expiresOn"
          : k.replace(/^settings\./, "").split(".")[0]!
      errors[
        (MCP_CAP_FIELDS as readonly string[]).includes(key)
          ? `${key}.${k.split(".")[2] ?? ""}`
          : key
      ] = msg
      at(3)
    }
  }
  return { errors, step }
}

export function McpWizard({
  connections,
  createAction,
  twoFactorEnabled,
}: {
  connections: SelectableConnection[]
  createAction: CreateMcpActionFn
  /** current user's 2FA state: the final re-auth asks for the TOTP code too */
  twoFactorEnabled: boolean
}) {
  const [values, setValues] =
    React.useState<McpFormValues>(defaultMcpFormValues)
  const [step, setStep] = React.useState(0)
  const [errors, setErrors] = React.useState<StepErrors>({})
  const [reauthOpen, setReauthOpen] = React.useState(false)
  const [created, setCreated] = React.useState<{
    id: string
    name: string
    url: string
  } | null>(null)
  const headingRef = React.useRef<HTMLHeadingElement>(null)

  const update: FormUpdater = React.useCallback(
    (fn) => setValues((v) => fn(v)),
    []
  )

  const goTo = (s: number) => {
    setStep(s)
    setErrors({})
    requestAnimationFrame(() => headingRef.current?.focus())
  }

  if (created)
    return (
      <McpCreated
        {...created}
        onCreateAnother={() => {
          setCreated(null)
          setValues(defaultMcpFormValues())
          setStep(0)
        }}
      />
    )

  if (connections.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Link04Icon}
          title={t.wizard.noConnectionsTitle}
          description={t.wizard.noConnectionsDescription}
          action={
            <Button variant="brand" asChild>
              <Link href="/connections/new">{t.wizard.addConnection}</Link>
            </Button>
          }
        />
      </Card>
    )
  }

  const next = () => {
    const e = validateStep(step, values, connections)
    if (Object.keys(e).length > 0) {
      setErrors(e)
      toast.error(t.wizard.fixErrors)
      return
    }
    goTo(step + 1)
  }

  const submit = () => {
    for (let s = 0; s < STEPS.length; s++) {
      const e = validateStep(s, values, connections)
      if (Object.keys(e).length > 0) {
        setStep(s)
        setErrors(e)
        toast.error(t.wizard.fixErrors)
        return
      }
    }
    // The link is handed out right away → re-authenticate (password + TOTP) before creating.
    setReauthOpen(true)
  }

  const last = step === STEPS.length - 1
  const card = STEP_CARD[step]!

  return (
    <div className="flex w-full flex-col gap-6">
      <PageGuide guide={tg.mcpNew.steps[step]!} />
      <Stepper steps={STEPS} current={step} onStepClick={(i) => goTo(i)} />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (last) submit()
          else next()
        }}
      >
        <Card>
          <CardHeader>
            <p className="text-xs font-medium text-muted-foreground md:hidden">
              {t.wizard.stepProgress(
                step + 1,
                STEPS.length,
                STEPS[step]!.title
              )}
            </p>
            <CardTitle>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="text-base font-semibold outline-none"
              >
                {card.title}
              </h2>
            </CardTitle>
            {card.description && (
              <CardDescription>{card.description}</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {step === 0 && (
              <NameSection
                values={values}
                update={update}
                errors={errors}
                autoFocus
              />
            )}
            {step === 1 && (
              <PlatformsSection
                values={values}
                update={update}
                errors={errors}
                connections={connections}
              />
            )}
            {step === 2 && (
              <PermissionsSection values={values} update={update} />
            )}
            {step === 3 && (
              <ProtectionSection
                values={values}
                update={update}
                errors={errors}
                connections={connections}
              />
            )}
          </CardContent>
          <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              disabled={step === 0 || reauthOpen}
              onClick={() => goTo(step - 1)}
            >
              {t.wizard.back}
            </Button>
            <Button
              type="submit"
              variant="brand"
              size="lg"
              className="w-full sm:w-auto"
              disabled={reauthOpen}
            >
              {last ? t.wizard.submit : t.wizard.next}
            </Button>
          </CardFooter>
        </Card>
      </form>
      <ReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        twoFactorEnabled={twoFactorEnabled}
        idPrefix="create-mcp"
        texts={{
          title: t.wizard.reauthTitle,
          description: t.wizard.reauthDescription,
          submit: t.wizard.reauthSubmit,
          submitting: t.wizard.submitting,
        }}
        onSubmit={(fields) =>
          createAction({ ...formValuesToCreateInput(values), ...fields })
        }
        onSuccess={(data) => {
          setCreated(data)
          window.scrollTo({ top: 0 })
        }}
        onFailure={(r) => {
          const mapped = mapServerErrors(r.fieldErrors)
          if (mapped.step === null) return false
          // a form field is wrong (not the password): back to the step that owns it
          setStep(mapped.step)
          setErrors(mapped.errors)
          toast.error(r.error)
          return true
        }}
      />
    </div>
  )
}
