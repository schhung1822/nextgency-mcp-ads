"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { InformationCircleIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import { ContextualSaveBar } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { ActionResult } from "@/lib/action-result"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  analyzeScope,
  configToFormValues,
  formValuesToCreateInput,
  pruneToSelectable,
  summarizeScopeIssues,
  validateNameStep,
  validatePlatformsStep,
  validateProtectionStep,
  type McpFormValues,
  type StepErrors,
} from "@/lib/schemas/mcp-servers"
import type {
  McpDetail,
  SelectableConnection,
} from "@/server/services/mcp-servers"

import {
  NameSection,
  PermissionsSection,
  PlatformsSection,
  ProtectionSection,
  SectionCard,
  type FormUpdater,
} from "./mcp-form-sections"
import { mapServerErrors } from "./mcp-wizard"
import { ScopeIssuesAlert } from "./scope-issues"

const NO_NAMES: Record<string, string> = {}

export type UpdateMcpActionFn = (
  input: unknown
) => Promise<ActionResult<{ changed: boolean }>>

/**
 * The form as the user will save it: the stored config minus everything that is no longer usable (deleted
 * connections, switched-off connections / ad accounts). `analyzeScope` lists what was dropped.
 */
export function initialConfigValues(
  mcp: McpDetail,
  connections: SelectableConnection[]
): McpFormValues {
  return pruneToSelectable(
    configToFormValues({
      name: mcp.name,
      description: mcp.description,
      platforms: mcp.config.map((p) => ({
        platform: p.platform,
        permissions: p.permissions,
        connections: p.connections.map((c) => ({
          connectionId: c.connectionId,
          accountIds: c.accountIds,
        })),
      })),
      settings: mcp.settings,
      expiresAt: mcp.expiresAt,
    }),
    connections
  )
}

/** Edit name + steps 2–4 with a contextual save bar. Keyed by the parent on mcp.updatedAt so it resets after save. */
export function ConfigTab({
  mcp,
  connections,
  accountNames = NO_NAMES,
  updateAction,
  onDirtyChange,
}: {
  mcp: McpDetail
  connections: SelectableConnection[]
  /** names of the ad accounts picked in this MCP that are switched off now (id → name), for the warning */
  accountNames?: Record<string, string>
  updateAction: UpdateMcpActionFn
  /** lets the page demote its own brand button while this form shows the save bar */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const router = useRouter()
  const initial = React.useMemo(
    () => initialConfigValues(mcp, connections),
    [mcp, connections]
  )
  const analysis = React.useMemo(
    () => analyzeScope(mcp.config, connections, accountNames),
    [mcp.config, connections, accountNames]
  )
  const [values, setValues] = React.useState<McpFormValues>(initial)
  const [errors, setErrors] = React.useState<StepErrors>({})
  const [pending, startTransition] = React.useTransition()
  // "Huỷ" on the bar: leave the config as it is for now (the warning above the platforms stays)
  const [pruneDismissed, setPruneDismissed] = React.useState(false)
  const update: FormUpdater = React.useCallback(
    (fn) => setValues((v) => fn(v)),
    []
  )
  const edited = JSON.stringify(values) !== JSON.stringify(initial)
  // saving writes the pruned form, so stored references that are gone ARE an unsaved change even before any edit
  const pruning =
    analysis.issues.length > 0 || analysis.droppedPlatforms.length > 0
  const dirty = edited || (pruning && !pruneDismissed)
  const formId = t.config.formId
  const barMessage = pruning
    ? (edited ? t.config.prune.barWithEdits : t.config.prune.barOnly)(
        t.config.prune.summary(summarizeScopeIssues(analysis))
      )
    : undefined

  React.useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const errs = {
      ...validateNameStep(values),
      ...validatePlatformsStep(values),
      ...validateProtectionStep(values, {
        requireFutureExpiry: values.expiresOn !== initial.expiresOn,
      }),
    }
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      toast.error(t.wizard.fixErrors)
      return
    }
    startTransition(async () => {
      const r = await updateAction({
        id: mcp.id,
        ...formValuesToCreateInput(values),
      })
      if (r.ok) {
        toast.success(
          r.data.changed ? t.config.saved : (r.message ?? t.toast.noChanges)
        )
        router.refresh()
        return
      }
      setErrors(mapServerErrors(r.fieldErrors).errors)
      toast.error(r.error)
    })
  }

  return (
    <form
      id={formId}
      noValidate
      onSubmit={save}
      className="flex flex-col gap-5"
    >
      <ContextualSaveBar
        open={dirty}
        formId={formId}
        saving={pending}
        message={barMessage}
        onDiscard={() => {
          setValues(initial)
          setErrors({})
          setPruneDismissed(true)
        }}
      />
      {!mcp.isMine && (
        <Alert>
          <HugeiconsIcon
            icon={InformationCircleIcon}
            strokeWidth={2}
            aria-hidden
          />
          <AlertDescription>
            {t.config.ownerNote(mcp.ownerEmail)}
          </AlertDescription>
        </Alert>
      )}
      <SectionCard title={t.config.infoTitle}>
        <NameSection values={values} update={update} errors={errors} />
      </SectionCard>
      <SectionCard
        title={t.platformsStep.cardTitle}
        description={t.platformsStep.cardDescription}
      >
        <div className="flex flex-col gap-4">
          <ScopeIssuesAlert analysis={analysis} />
          <PlatformsSection
            values={values}
            update={update}
            errors={errors}
            connections={connections}
            layout="grid"
          />
        </div>
      </SectionCard>
      <SectionCard
        title={t.permissionsStep.cardTitle}
        description={t.permissionsStep.cardDescription}
      >
        <div className="flex flex-col gap-4">
          <PermissionsSection values={values} update={update} />
          <Alert>
            <HugeiconsIcon
              icon={InformationCircleIcon}
              strokeWidth={2}
              aria-hidden
            />
            <AlertDescription>{t.config.chatgptNote}</AlertDescription>
          </Alert>
        </div>
      </SectionCard>
      <SectionCard title={t.protectionStep.cardTitle}>
        <ProtectionSection
          values={values}
          update={update}
          errors={errors}
          connections={connections}
        />
      </SectionCard>
    </form>
  )
}
