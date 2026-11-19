"use client"

// Google Drive blocks of the MCP form (15-google-drive-media.md §7.5, §11), shared by the create wizard and the
// config editor: step 2 source picker (grouped company / mine / staff), step 3 switches (public Drive links, sheet
// status write-back) and the overview summary rows. Options come from the server (listDriveSourcesForMcpScope) -
// never a credential, link or resource key.
import Link from "next/link"
import {
  Add01Icon,
  Alert02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { BrandIcon, StatusBadge } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type {
  McpDriveSourceOption,
  McpDriveSourceRef,
} from "@/lib/schemas/drive"
import type { McpFormValues, StepErrors } from "@/lib/schemas/mcp-servers"

import type { FormUpdater } from "./mcp-form-sections"

const s = t.drive

const GROUP_ORDER = ["company", "mine", "staff"] as const

type DriveStatus = McpDriveSourceOption["status"]

/** Error / disabled badge of a source (nothing for an active one). */
function SourceStatusBadge({ status }: { status: DriveStatus }) {
  if (status === "active") return null
  return (
    <StatusBadge
      kind="connection"
      status={status === "error" ? "invalid" : "disabled"}
      label={status === "error" ? s.statusError : s.statusDisabled}
    />
  )
}

function kindLabel(src: {
  kind: McpDriveSourceOption["kind"]
  writeback: boolean
}) {
  if (src.kind === "folder") return s.kindFolder
  return src.writeback ? `${s.kindSheet} · ${s.writeback}` : s.kindSheet
}

/** "Ảnh, video quảng cáo (không bắt buộc)": separates the Drive block from the blocks above it. */
function OptionalGroupHeading() {
  return (
    <h3 className="text-sm font-semibold text-muted-foreground">
      {s.optionalGroup}
    </h3>
  )
}

/** Card header in the style of the platform / Telegram cards (icon tile + title + optional right-hand meta). */
function DriveCardHeader({
  id,
  title,
  description,
  aside,
}: {
  id: string
  title: string
  description?: string
  aside?: React.ReactNode
}) {
  return (
    <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3 [.border-b]:pb-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <BrandIcon brand="drive" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h4 id={id} className="text-base font-semibold">
          {title}
        </h4>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      {aside}
    </CardHeader>
  )
}

/** Step 2: which Google Drive folders / sheets the MCP may read. */
export function DriveSourcesSection({
  values,
  update,
  errors,
  sources,
  ownerEmail,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  sources: McpDriveSourceOption[]
  /** set when the MCP belongs to somebody other than the viewer (only company + that person's sources are listed) */
  ownerEmail?: string
}) {
  const selected = new Set(values.driveSourceIds)
  const toggle = (id: string, on: boolean) =>
    update((v) => ({
      ...v,
      driveSourceIds: on
        ? [...new Set([...v.driveSourceIds, id])]
        : v.driveSourceIds.filter((x) => x !== id),
    }))
  const anyBroken = sources.some(
    (o) => selected.has(o.id) && o.status !== "active"
  )
  const groups = GROUP_ORDER.map((g) => ({
    key: g,
    label:
      g === "company"
        ? s.groups.company
        : g === "mine"
          ? ownerEmail
            ? s.groups.owner(ownerEmail)
            : s.groups.mine
          : s.groups.staff,
    items: sources.filter((o) => o.group === g),
  })).filter((g) => g.items.length > 0)

  return (
    <section
      aria-labelledby="mcp-drive-sources"
      className="flex flex-col gap-3"
    >
      <OptionalGroupHeading />
      <Card
        className={cn(
          "gap-0 py-0 transition-shadow",
          selected.size > 0 && "ring-1 ring-brand-primary/30"
        )}
      >
        <DriveCardHeader
          id="mcp-drive-sources"
          title={s.title}
          aside={
            selected.size > 0 ? (
              <span className="shrink-0 text-[13px] text-muted-foreground">
                {s.selectedCount(selected.size)}
              </span>
            ) : undefined
          }
        />
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          <p className="text-[13px] text-muted-foreground">{s.description}</p>
          {ownerEmail && (
            <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden
              />
              {s.ownerOnlyNote(ownerEmail)}
            </p>
          )}
          {sources.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">{s.emptyTitle}</p>
                <p className="text-[13px] text-muted-foreground">
                  {s.emptyDescription}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/connections/drive/new">
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                  {s.addSource}
                </Link>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <div
                  key={g.key}
                  role="group"
                  aria-labelledby={`mcp-drive-group-${g.key}`}
                  className="flex flex-col gap-2"
                >
                  <p
                    id={`mcp-drive-group-${g.key}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {g.label}
                  </p>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {g.items.map((o) => {
                      const id = `mcp-drive-${o.id}`
                      const on = selected.has(o.id)
                      // a source switched off cannot be newly picked (L10); an already selected one can still be removed
                      const locked = o.status === "disabled" && !on
                      const meta = [
                        kindLabel(o),
                        g.key === "staff" ? s.ownerSuffix(o.owner.email) : null,
                        locked ? s.disabledLocked : null,
                      ].filter(Boolean)
                      return (
                        // the whole row is the label: a tap anywhere toggles the checkbox
                        <FieldLabel
                          key={o.id}
                          htmlFor={id}
                          className={cn(
                            "*:data-[slot=field]:px-3 *:data-[slot=field]:py-2.5",
                            locked
                              ? "cursor-not-allowed opacity-60"
                              : "cursor-pointer",
                            on &&
                              "border-brand-primary/30 bg-brand-primary/5 dark:border-brand-primary/30 dark:bg-brand-primary/10"
                          )}
                        >
                          <Field
                            orientation="horizontal"
                            data-disabled={locked ? true : undefined}
                          >
                            <Checkbox
                              id={id}
                              checked={on}
                              disabled={locked}
                              onCheckedChange={(v) => toggle(o.id, v === true)}
                            />
                            <FieldContent className="min-w-0 gap-0.5">
                              <FieldTitle className="flex flex-wrap items-center gap-1.5">
                                <span className="break-words">{o.name}</span>
                                <SourceStatusBadge status={o.status} />
                              </FieldTitle>
                              <FieldDescription className="text-[13px] leading-snug break-words">
                                {meta.join(" · ")}
                              </FieldDescription>
                            </FieldContent>
                          </Field>
                        </FieldLabel>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          {anyBroken && (
            <p className="text-[13px] text-warning-strong">{s.statusHint}</p>
          )}
          {errors.driveSourceIds && (
            <p role="alert" className="text-[13px] text-destructive">
              {errors.driveSourceIds}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

/** Step 3: public Drive links + status write-back into sheets. */
export function DrivePermissionsSection({
  values,
  update,
  sources,
  publicLinksAvailable = true,
}: {
  values: McpFormValues
  update: FormUpdater
  sources: McpDriveSourceOption[]
  /** false when the admin has not saved a Drive API key (public links cannot be read yet) */
  publicLinksAvailable?: boolean
}) {
  const n = values.driveSourceIds.length
  const selected = new Set(values.driveSourceIds)
  const writebackSheet = sources.some((o) => selected.has(o.id) && o.writeback)
  const anyCreate = Object.values(values.platforms).some(
    (p) => p.enabled && p.permissions.includes("create")
  )
  // public links default ON (owner decision): the description is shown prominently instead of a muted hint
  const rows = [
    {
      id: "mcp-drive-public",
      label: s.publicLabel,
      help: s.publicHelp,
      helpProminent: true,
      note: publicLinksAvailable ? null : s.publicUnavailable,
      warn: true,
      checked: values.drivePublicLinks,
      set: (on: boolean) => update((v) => ({ ...v, drivePublicLinks: on })),
    },
    {
      id: "mcp-drive-writeback",
      label: s.writebackLabel,
      help: s.writebackHelp,
      helpProminent: false,
      note: writebackSheet ? null : s.writebackNoSheet,
      warn: false,
      checked: values.driveSheetWriteback,
      set: (on: boolean) => update((v) => ({ ...v, driveSheetWriteback: on })),
    },
  ]
  return (
    <section aria-labelledby="mcp-drive-perms" className="flex flex-col gap-3">
      <OptionalGroupHeading />
      <Card className="gap-0 py-0">
        <DriveCardHeader
          id="mcp-drive-perms"
          title={s.permissionsTitle}
          description={s.permissionsDescription(n)}
        />
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          <div className="grid gap-2 lg:grid-cols-2">
            {rows.map((r) => (
              // the whole row is the label: a tap anywhere toggles the switch
              <FieldLabel
                key={r.id}
                htmlFor={r.id}
                className="cursor-pointer *:data-[slot=field]:p-3"
              >
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{r.label}</FieldTitle>
                    <FieldDescription
                      className={cn(
                        "text-[13px] leading-snug",
                        r.helpProminent && "font-medium text-warning-strong"
                      )}
                    >
                      {r.help}
                    </FieldDescription>
                    {r.note && (
                      <FieldDescription
                        className={cn(
                          "text-[13px] leading-snug",
                          r.warn && "text-warning-strong"
                        )}
                      >
                        {r.note}
                      </FieldDescription>
                    )}
                  </FieldContent>
                  <Switch
                    id={r.id}
                    checked={r.checked}
                    onCheckedChange={r.set}
                  />
                </Field>
              </FieldLabel>
            ))}
          </div>
          {/* Drive sources picked but no platform may create: the AI could read them but never upload (M6) */}
          {!anyCreate && n > 0 ? (
            <Alert className="border-warning/40 bg-warning/10">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
              <AlertDescription className="text-warning-strong">
                {s.needsCreateSelected(n)}
              </AlertDescription>
            </Alert>
          ) : (
            !anyCreate && (
              <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
                <HugeiconsIcon
                  icon={InformationCircleIcon}
                  strokeWidth={2}
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
                {s.needsCreate}
              </p>
            )
          )}
        </CardContent>
      </Card>
    </section>
  )
}

/** Overview summary rows (rendered inside the overview's <dl>, with its own row component). */
export function DriveSummaryRows({
  sources,
  drivePublicLinks,
  driveSheetWriteback,
  Row,
  on,
  off,
}: {
  sources: McpDriveSourceRef[]
  drivePublicLinks: boolean
  driveSheetWriteback: boolean
  Row: React.ComponentType<{ label: string; children: React.ReactNode }>
  on: string
  off: string
}) {
  const writebackSheet = sources.some((x) => x.writeback)
  return (
    <>
      <Row label={s.summarySources}>
        {sources.length === 0
          ? s.summaryNone
          : sources.map((x) => (
              <span key={x.id} className="block break-words not-first:mt-1.5">
                <span className="block">{x.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground sm:justify-end">
                  {kindLabel(x)}
                  <SourceStatusBadge status={x.status} />
                </span>
              </span>
            ))}
      </Row>
      <Row label={s.summaryPublic}>{drivePublicLinks ? on : off}</Row>
      {writebackSheet && (
        <Row label={s.summaryWriteback}>{driveSheetWriteback ? on : off}</Row>
      )}
    </>
  )
}
