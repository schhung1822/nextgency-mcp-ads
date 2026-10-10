"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { InformationCircleIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import { ContextualSaveBar, ReauthDialog } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { ActionResult } from "@/lib/action-result"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import { tiktokGmvMaxMcp as tgm } from "@/lib/i18n/vi/tiktok-gmv-max"
import { REAUTH_REQUIRED_FIELD } from "@/lib/schemas/reauth"
import {
  analyzeScope,
  configToFormValues,
  formValuesToCreateInput,
  pruneChannelsToSelectable,
  pruneDriveSourcesToSelectable,
  pruneToSelectable,
  summarizeScopeIssues,
  validateNameStep,
  validatePlatformsStep,
  validateProtectionStep,
  type McpFormValues,
  type StepErrors,
} from "@/lib/schemas/mcp-servers"
import type { McpDriveSourceOption } from "@/lib/schemas/drive"
import type { McpChannelOption } from "@/lib/schemas/notifications"
import type {
  McpDetail,
  SelectableConnection,
} from "@/server/services/mcp-servers"

import {
  DrivePermissionsSection,
  DriveSourcesSection,
} from "./drive-sections"
import {
  CAPS_SECTION_ID,
  NameSection,
  PermissionsSection,
  PlatformsSection,
  ProtectionSection,
  moneyScopeCurrencies,
  SectionCard,
  type FormUpdater,
} from "./mcp-form-sections"
import { mapServerErrors } from "./mcp-wizard"
import { ScopeIssuesAlert } from "./scope-issues"
import {
  TelegramChannelsSection,
  TelegramPermissionsSection,
} from "./telegram-sections"
import {
  GMV_MAX_SWITCH_ID,
  TiktokGmvMaxBlock,
  type GmvMaxFormContext,
} from "./tiktok-gmv-max-section"

const NO_NAMES: Record<string, string> = {}
const NO_CHANNELS: McpChannelOption[] = []
const NO_DRIVE_SOURCES: McpDriveSourceOption[] = []
const NO_GMV_MAX: GmvMaxFormContext = { isAdmin: false, flags: {} }

/**
 * Scroll the per-currency caps section into view (smooth unless reduced motion) and focus the first
 * required daily cap that is still empty (else the first required one, else the section heading).
 */
function focusCapsSection() {
  const section = document.getElementById(CAPS_SECTION_ID)
  if (!section) return
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  section.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
  const required = [
    ...section.querySelectorAll<HTMLInputElement>(
      'input[id^="mcp-maxDailyBudget-"][aria-required="true"]'
    ),
  ]
  const target: HTMLElement | null =
    required.find((i) => i.value.trim() === "") ??
    required[0] ??
    section.querySelector<HTMLElement>("h3")
  target?.focus({ preventScroll: true })
}

/**
 * The server refused the save on the GMV Max switch (staff widening an admin-approved scope, admin-only switch):
 * bring the switch + its error into view (the save bar is usually far below it) and focus it.
 */
function focusGmvMaxSwitch() {
  const el = document.getElementById(GMV_MAX_SWITCH_ID)
  if (!el) return
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" })
  el.focus({ preventScroll: true })
}

export type UpdateMcpActionFn = (
  input: unknown
) => Promise<ActionResult<{ changed: boolean }>>

/**
 * The form as the user will save it: the stored config minus everything that is no longer usable (deleted
 * connections, switched-off connections / ad accounts). `analyzeScope` lists what was dropped.
 */
export function initialConfigValues(
  mcp: McpDetail,
  connections: SelectableConnection[],
  /** Telegram channels the MCP owner can pick; omitted = keep the stored ids as they are */
  channels?: readonly { id: string }[],
  /** Google Drive sources the MCP owner can pick; omitted = keep the stored ids as they are */
  driveSources?: readonly { id: string }[]
): McpFormValues {
  const values = pruneToSelectable(
    configToFormValues({
      name: mcp.name,
      description: mcp.description,
      platforms: mcp.config.map((p) => ({
        platform: p.platform,
        permissions: p.permissions,
        connections: p.connections.map((c) => ({
          connectionId: c.connectionId,
          accountIds: c.accountIds,
          // keep the Facebook Page scope (omitting it would drop every Page of the MCP on the next save)
          ...(c.pageIds !== undefined ? { pageIds: c.pageIds } : {}),
        })),
      })),
      settings: mcp.settings,
      expiresAt: mcp.expiresAt,
      notificationChannelIds: (mcp.notificationChannels ?? []).map((c) => c.id),
      driveSourceIds: (mcp.driveSources ?? []).map((d) => d.id),
    }),
    connections
  )
  // deleted channels (no longer offered) leave the scope on the next save
  const withChannels = channels
    ? pruneChannelsToSelectable(values, channels)
    : values
  return driveSources
    ? pruneDriveSourcesToSelectable(withChannels, driveSources)
    : withChannels
}

/** Edit name + steps 2–4 with a contextual save bar. Keyed by the parent on mcp.updatedAt so it resets after save. */
export function ConfigTab({
  mcp,
  connections,
  channels = NO_CHANNELS,
  driveSources = NO_DRIVE_SOURCES,
  drivePublicAvailable = true,
  accountNames = NO_NAMES,
  updateAction,
  onDirtyChange,
  capsFocusSignal = 0,
  gmvMax = NO_GMV_MAX,
  twoFactorEnabled = false,
}: {
  mcp: McpDetail
  connections: SelectableConnection[]
  /** Telegram channels of the MCP owner (staff MCP: the owner's; admin MCP: all) */
  channels?: McpChannelOption[]
  /** Google Drive sources the MCP owner can pick (company + the owner's; admin MCP: all) */
  driveSources?: McpDriveSourceOption[]
  /** a Drive API key is saved: public Drive links can be read */
  drivePublicAvailable?: boolean
  /** names of the ad accounts picked in this MCP that are switched off now (id → name), for the warning */
  accountNames?: Record<string, string>
  updateAction: UpdateMcpActionFn
  /** lets the page demote its own brand button while this form shows the save bar */
  onDirtyChange?: (dirty: boolean) => void
  /** > 0: the user asked to set the caps (overview banner) - land on the caps section */
  capsFocusSignal?: number
  /** viewer role + TikTok accounts with GMV Max (admin-only switch) */
  gmvMax?: GmvMaxFormContext
  /** viewer's 2FA state: the re-auth dialog (turning the GMV Max switch on) asks for the TOTP code too */
  twoFactorEnabled?: boolean
}) {
  const router = useRouter()
  const initial = React.useMemo(
    () => initialConfigValues(mcp, connections, channels, driveSources),
    [mcp, connections, channels, driveSources]
  )
  const analysis = React.useMemo(
    () => analyzeScope(mcp.config, connections, accountNames),
    [mcp.config, connections, accountNames]
  )
  const [values, setValues] = React.useState<McpFormValues>(initial)
  const [errors, setErrors] = React.useState<StepErrors>({})
  const [pending, startTransition] = React.useTransition()
  // the server asked to re-authenticate (turning the GMV Max switch on): the payload waits for the password
  const [reauthPayload, setReauthPayload] = React.useState<Record<
    string,
    unknown
  > | null>(null)
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

  // ?tab=config&focus=caps (link / reload) or the banner action: land on the caps section once
  React.useEffect(() => {
    const url = new URL(window.location.href)
    if (capsFocusSignal === 0 && url.searchParams.get("focus") !== "caps")
      return
    // the tab content was hidden until this render: wait for layout before scrolling
    const raf = requestAnimationFrame(focusCapsSection)
    url.searchParams.delete("focus")
    window.history.replaceState(window.history.state, "", url)
    return () => cancelAnimationFrame(raf)
  }, [capsFocusSignal])

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const errs = {
      ...validateNameStep(values),
      ...validatePlatformsStep(values),
      ...validateProtectionStep(values, {
        requireFutureExpiry: values.expiresOn !== initial.expiresOn,
        requiredCapCurrencies: moneyScopeCurrencies(values, connections),
      }),
    }
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      toast.error(t.wizard.fixErrors)
      return
    }
    startTransition(async () => {
      const payload = { id: mcp.id, ...formValuesToCreateInput(values) }
      const r = await updateAction(payload)
      if (r.ok) {
        toast.success(
          r.data.changed ? t.config.saved : (r.message ?? t.toast.noChanges)
        )
        router.refresh()
        return
      }
      // sensitive change (GMV Max switch on): ask for the password (+ 2FA code), then save with it
      if (r.fieldErrors?.[REAUTH_REQUIRED_FIELD]) {
        setReauthPayload(payload)
        return
      }
      const mapped = mapServerErrors(r.fieldErrors).errors
      setErrors(mapped)
      toast.error(r.error)
      if (mapped.tiktokGmvMaxWrite) requestAnimationFrame(focusGmvMaxSwitch)
    })
  }

  return (
    <>
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
            <TelegramChannelsSection
              values={values}
              update={update}
              errors={errors}
              channels={channels}
              ownerNote={
                !mcp.isMine
                  ? t.telegram.ownerOnlyNote(mcp.ownerEmail)
                  : undefined
              }
            />
            <DriveSourcesSection
              values={values}
              update={update}
              errors={errors}
              sources={driveSources}
              ownerEmail={!mcp.isMine ? mcp.ownerEmail : undefined}
            />
          </div>
        </SectionCard>
        <SectionCard
          title={t.permissionsStep.cardTitle}
          description={t.permissionsStep.cardDescription}
        >
          <div className="flex flex-col gap-4">
            <PermissionsSection
              values={values}
              update={update}
              platformExtra={{
                tiktok: (
                  <TiktokGmvMaxBlock
                    values={values}
                    update={update}
                    connections={connections}
                    gmv={gmvMax}
                    savedOn={initial.tiktokGmvMaxWrite}
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
      {reauthPayload && (
        <ReauthDialog
          open
          onOpenChange={(o) => !o && setReauthPayload(null)}
          twoFactorEnabled={twoFactorEnabled}
          idPrefix="mcp-config-reauth"
          hint={null}
          texts={tgm.reauth}
          onSubmit={(fields) =>
            updateAction({ ...reauthPayload, reauth: fields })
          }
          onSuccess={(data, message) => {
            toast.success(
              data.changed ? t.config.saved : (message ?? t.toast.noChanges)
            )
            router.refresh()
          }}
          onFailure={(r) => {
            // a form field is wrong (e.g. the staff GMV Max rule): close and show it on the form
            const mapped = mapServerErrors(r.fieldErrors)
            if (mapped.step === null) return false
            setErrors(mapped.errors)
            toast.error(r.error)
            if (mapped.errors.tiktokGmvMaxWrite)
              requestAnimationFrame(focusGmvMaxSwitch)
            return true
          }}
        />
      )}
    </>
  )
}
