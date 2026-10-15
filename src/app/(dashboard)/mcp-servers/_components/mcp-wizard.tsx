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
  validatePermissionsStep,
  validatePlatformsStep,
  validateProtectionStep,
  type McpFormValues,
  type StepErrors,
} from "@/lib/schemas/mcp-servers"
import {
  hasUsableApifyToken,
  type McpApifyPoolSummary,
} from "@/lib/schemas/apify"
import type { McpDriveSourceOption } from "@/lib/schemas/drive"
import type { McpChannelOption } from "@/lib/schemas/notifications"
import type { SelectableConnection } from "@/server/services/mcp-servers"

import { ApifyPermissionsCard, ApifyPlatformCard } from "./apify-sections"
import {
  DrivePermissionsSection,
  DriveSourcesSection,
} from "./drive-sections"
import { McpCreated } from "./mcp-created"
import {
  moneyScopeCurrencies,
  NameSection,
  PermissionsSection,
  PlatformsSection,
  ProtectionSection,
  type FormUpdater,
} from "./mcp-form-sections"
import {
  TelegramChannelsSection,
  TelegramPermissionsSection,
} from "./telegram-sections"
import {
  TiktokGmvMaxBlock,
  type GmvMaxFormContext,
} from "./tiktok-gmv-max-section"

const NO_GMV_MAX: GmvMaxFormContext = { isAdmin: false, flags: {} }

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
  if (step === 2) return validatePermissionsStep(v)
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
    } else if (k.startsWith("notificationChannelIds")) {
      errors.notificationChannelIds = msg
      at(1)
    } else if (k.startsWith("driveSourceIds")) {
      errors.driveSourceIds = msg
      at(1)
    } else if (k.startsWith("platforms")) {
      errors[
        k.match(
          /^platforms\.(meta|tiktok|google_ads|openai_ads)(\.[0-9a-f-]{36})?$/
        )
          ? k
          : "platforms"
      ] = msg
      at(1)
    } else if (k === "settings.tiktokGmvMaxWrite") {
      // admin-only GMV Max switch: lives in step 3 (Chọn quyền), TikTok card
      errors.tiktokGmvMaxWrite = msg
      at(2)
    } else if (k === "settings.apifyEnabled") {
      // Apify platform card of step 2 (Nền tảng & tài khoản), e.g. an Apify-only MCP without any token
      errors.apifyEnabled = msg
      at(1)
    } else if (
      k === "settings.apifyRunMaxUsd" ||
      k === "settings.apifyStoreActors"
    ) {
      // Apify card of step 3 (Quyền); the daily cap (settings.apifyDailyMaxUsd) lives in the protection step
      errors[k.replace(/^settings\./, "")] = msg
      at(2)
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
  channels = [],
  driveSources = [],
  drivePublicAvailable = true,
  createAction,
  twoFactorEnabled,
  gmvMax = NO_GMV_MAX,
  apifyPool = null,
}: {
  connections: SelectableConnection[]
  /** Telegram channels the user may give the MCP: the user's own channels (admins too) */
  channels?: McpChannelOption[]
  /** Google Drive sources the MCP may read: company + the user's own (admin: + staff sources) */
  driveSources?: McpDriveSourceOption[]
  /** a Drive API key is saved: public Drive links can be read */
  drivePublicAvailable?: boolean
  createAction: CreateMcpActionFn
  /** current user's 2FA state: the final re-auth asks for the TOTP code too */
  twoFactorEnabled: boolean
  /** viewer role + TikTok accounts with GMV Max (admin-only switch in step 3) */
  gmvMax?: GmvMaxFormContext
  /** Apify token pool of the creator (company + own personal tokens) - the Apify platform card of step 2 */
  apifyPool?: McpApifyPoolSummary | null
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

  // nothing to build an MCP on: no ad connection and no usable Apify token (Apify counts as a platform, A5)
  if (connections.length === 0 && !hasUsableApifyToken(apifyPool)) {
    return (
      <Card>
        <EmptyState
          icon={Link04Icon}
          title={t.wizard.noConnectionsTitle}
          description={t.wizard.noConnectionsDescription}
          action={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="brand" asChild>
                <Link href="/connections/new">{t.wizard.addConnection}</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/connections/apify/new">
                  {t.wizard.addApifyToken}
                </Link>
              </Button>
            </div>
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
              <div className="flex flex-col gap-6">
                <PlatformsSection
                  values={values}
                  update={update}
                  errors={errors}
                  connections={connections}
                  extraCards={
                    <ApifyPlatformCard
                      values={values}
                      update={update}
                      errors={errors}
                      pool={apifyPool}
                    />
                  }
                />
                <TelegramChannelsSection
                  values={values}
                  update={update}
                  errors={errors}
                  channels={channels}
                />
                <DriveSourcesSection
                  values={values}
                  update={update}
                  errors={errors}
                  sources={driveSources}
                />
              </div>
            )}
            {step === 2 && (
              <div className="flex flex-col gap-6">
                <PermissionsSection
                  values={values}
                  update={update}
                  extraCards={
                    values.apifyEnabled ? (
                      <ApifyPermissionsCard
                        values={values}
                        update={update}
                        errors={errors}
                        isAdmin={gmvMax.isAdmin}
                      />
                    ) : undefined
                  }
                  platformExtra={{
                    tiktok: (
                      <TiktokGmvMaxBlock
                        values={values}
                        update={update}
                        connections={connections}
                        gmv={gmvMax}
                        error={errors.tiktokGmvMaxWrite}
                      />
                    ),
                  }}
                />
                <TelegramPermissionsSection values={values} update={update} />
                <DrivePermissionsSection
                  values={values}
                  update={update}
                  sources={driveSources}
                  publicLinksAvailable={drivePublicAvailable}
                />
              </div>
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
