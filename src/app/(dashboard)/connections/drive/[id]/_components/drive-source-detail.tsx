"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  InformationCircleIcon,
  LinkSquare02Icon,
  PauseIcon,
  PencilEdit02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  ConfirmDialog,
  PageGuide,
  PageHeader,
  RelativeTime,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { formatDate } from "@/lib/format"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  AUTO_DETECT_COLUMN_KEYS,
  detectAutoHeader,
  headerIndex,
  SHEET_COLUMN_KEYS,
  SHEET_WRITABLE_COLUMN_KEYS,
  type DriveSourceDetail,
  type AutoDetectColumnKey,
  type SheetColumnKey,
} from "@/lib/schemas/drive"
import {
  deleteDriveSourceAction,
  recheckDriveSourceAction,
} from "@/server/actions/drive"

import {
  DriveKindBadge,
  DriveScopeBadge,
  DriveStatusBadge,
} from "../../_components/drive-badges"
import { driveStatusText, googleOpenUrl } from "../../_components/drive-format"
import { EditSourceDialog } from "./edit-source-dialog"
import { FolderBrowser } from "./folder-browser"
import { SheetPreview } from "./sheet-preview"

const m = driveUi.detail
const u = driveUi.ui

export function DriveSourceDetailView({
  detail,
  isAdmin,
  justCreated,
}: {
  detail: DriveSourceDetail
  isAdmin: boolean
  /** arrived from the wizard: suggest assigning it to an MCP */
  justCreated: boolean
}) {
  const router = useRouter()
  const [rechecking, setRechecking] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [sheetHeader, setSheetHeader] = React.useState<string[] | null>(null)
  // bumped after "Kiểm tra lại": the file grid / sheet preview reload together with the status badge
  const [listingKey, setListingKey] = React.useState(0)
  const viewer = { isAdmin, credentialKind: detail.credential.kind }
  const statusText = driveStatusText(detail.statusMessage, viewer)
  const onHeader = React.useCallback(
    (h: string[] | null) => setSheetHeader(h),
    []
  )
  const configuredColumns = React.useMemo(
    () =>
      detail.sheet
        ? SHEET_COLUMN_KEYS.filter((k) => !!detail.sheet!.columns[k])
        : [],
    [detail.sheet]
  )

  const recheck = async () => {
    setRechecking(true)
    const res = await recheckDriveSourceAction({ sourceId: detail.id })
    setRechecking(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    if (res.data.ok)
      toast.success(res.message ?? driveUi.service.done.sourceRechecked)
    else
      toast.error(m.recheckFailed, {
        description: driveStatusText(res.data.statusMessage, viewer) ?? undefined,
      })
    setListingKey((n) => n + 1)
    router.refresh()
  }

  // live listing failed (M4): the header badge is the LAST check - say so, and offer one action: managers re-check
  // the source (badge + listing), viewers reload the listing
  const listingError = {
    note: (
      <span className="text-[13px] text-pretty">
        {detail.lastCheckedAt ? (
          <>
            {m.staleStatus} (<RelativeTime value={detail.lastCheckedAt} />
            ).{" "}
          </>
        ) : (
          <>{m.staleStatusNever} </>
        )}
        {detail.canManage ? m.staleStatusManage : m.staleStatusView}
      </span>
    ),
    action: detail.canManage
      ? {
          label: m.recheck,
          busyLabel: m.rechecking,
          busy: rechecking,
          run: () => void recheck(),
        }
      : null,
    formatError: (msg: string) => driveStatusText(msg, viewer) ?? msg,
  }

  const openLink = (
    <Button variant="outline" asChild>
      <a href={googleOpenUrl(detail)} target="_blank" rel="noopener noreferrer">
        <HugeiconsIcon
          icon={LinkSquare02Icon}
          strokeWidth={2}
          data-icon="inline-start"
          aria-hidden
        />
        {m.openInDrive}
      </a>
    </Button>
  )

  return (
    <>
      <PageGuide guide={driveUi.guides.detail} />
      <PageHeader
        title={detail.name}
        titleMeta={
          <>
            <DriveKindBadge kind={detail.kind} />
            <DriveScopeBadge scope={detail.scope} />
            <DriveStatusBadge status={detail.status} />
          </>
        }
        backHref="/connections?tab=drive"
        // managers: the Google link joins the "Thêm" menu (one brand + one menu); viewers only get the link
        actionsExtra={detail.canManage ? undefined : openLink}
        primaryAction={
          detail.canManage ? (
            <Button
              variant="brand"
              onClick={() => void recheck()}
              disabled={rechecking}
            >
              {rechecking ? (
                <Spinner aria-hidden />
              ) : (
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden
                />
              )}
              {rechecking ? m.rechecking : m.recheck}
            </Button>
          ) : undefined
        }
        secondaryActions={
          detail.canManage
            ? [
                {
                  label: m.openInDrive,
                  icon: LinkSquare02Icon,
                  onSelect: () =>
                    window.open(
                      googleOpenUrl(detail),
                      "_blank",
                      "noopener,noreferrer"
                    ),
                },
                {
                  label: m.edit,
                  icon: PencilEdit02Icon,
                  onSelect: () => setEditOpen(true),
                },
                {
                  label: m.delete,
                  icon: Delete02Icon,
                  destructive: true,
                  onSelect: () => setDeleteOpen(true),
                },
              ]
            : undefined
        }
      />

      <div className="flex flex-col gap-5">
        {justCreated && detail.mcpCount === 0 && (
          <Alert>
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              aria-hidden
            />
            <AlertTitle>{m.createdTitle}</AlertTitle>
            <AlertDescription>{m.createdHint}</AlertDescription>
          </Alert>
        )}
        {detail.status === "error" && (
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
            <AlertTitle>{m.errorTitle}</AlertTitle>
            {statusText && <AlertDescription>{statusText}</AlertDescription>}
          </Alert>
        )}
        {detail.status === "disabled" && (
          <Alert>
            <HugeiconsIcon icon={PauseIcon} strokeWidth={2} aria-hidden />
            <AlertTitle>{m.disabledTitle}</AlertTitle>
            <AlertDescription>{m.disabledHint}</AlertDescription>
          </Alert>
        )}
        {!detail.canManage && (
          <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
            <HugeiconsIcon
              icon={InformationCircleIcon}
              strokeWidth={2}
              className="mt-px size-3.5 shrink-0"
              aria-hidden
            />
            {m.readOnlyNote}
          </p>
        )}

        <div className="grid items-start gap-5 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-5 xl:col-span-2">
            {detail.kind === "folder" ? (
              <FolderBrowser
                sourceId={detail.id}
                rootName={detail.googleName ?? detail.name}
                reloadKey={listingKey}
                listingError={listingError}
              />
            ) : (
              <SheetPreview
                sourceId={detail.id}
                configured={configuredColumns}
                onHeader={onHeader}
                reloadKey={listingKey}
                listingError={listingError}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <InfoCard
              detail={detail}
              isAdmin={isAdmin}
              sheetHeader={sheetHeader}
              onEdit={detail.canManage ? () => setEditOpen(true) : undefined}
            />
            <UsageCard detail={detail} />
          </div>
        </div>
      </div>

      {editOpen && (
        <EditSourceDialog
          open
          onOpenChange={setEditOpen}
          detail={detail}
          sheetHeader={sheetHeader}
          onSaved={() => router.refresh()}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        destructive
        title={m.remove.title}
        description={m.remove.description(detail.name)}
        confirmText={detail.name}
        confirmLabel={m.remove.confirm}
        onConfirm={async () => {
          const res = await deleteDriveSourceAction({ sourceId: detail.id })
          if (!res.ok) {
            toast.error(res.error)
            return false
          }
          toast.success(res.message ?? driveUi.service.done.sourceDeleted)
          router.push("/connections?tab=drive")
        }}
      >
        {detail.usedBy.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl border p-3 text-sm">
            <span className="font-medium">{m.remove.affected}</span>
            <UsageList detail={detail} />
          </div>
        )}
      </ConfirmDialog>
    </>
  )
}

// ---------------------------------------------------------------------------

function InfoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

/** the two optional link columns added in v1.0.8 - older sheets often have them unmapped */
const LINK_COLUMNS = ["postLink", "campaignLink"] as const satisfies readonly SheetColumnKey[]

/**
 * The read-only auto-detected columns ("Ảnh bìa", "Lời chào tin nhắn") when they are not mapped: drive_sheet_read then
 * takes a header named like them (detectAutoHeader, same order + taken cells as mapColumns). Per key: null = mapped or
 * header unknown, "" = no such header, else the header cell.
 */
function autoHeaders(
  sheet: NonNullable<DriveSourceDetail["sheet"]>,
  header: readonly string[] | null
): Record<AutoDetectColumnKey, string | null> {
  const out = { cover: null, welcomeMessage: null } as Record<AutoDetectColumnKey, string | null>
  if (!header) return out
  const taken = new Set<number>()
  for (const k of SHEET_COLUMN_KEYS) {
    const name = sheet.columns[k]
    const i = name ? headerIndex(header, name) : -1
    if (i >= 0) taken.add(i)
  }
  for (const k of AUTO_DETECT_COLUMN_KEYS) {
    if (sheet.columns[k]) continue
    const i = detectAutoHeader(k, header, taken)
    if (i >= 0) taken.add(i)
    out[k] = i >= 0 ? String(header[i] ?? "").trim() : ""
  }
  return out
}

function InfoCard({
  detail,
  isAdmin,
  sheetHeader,
  onEdit,
}: {
  detail: DriveSourceDetail
  isAdmin: boolean
  /** header row read by the sheet preview (null until loaded / on error) */
  sheetHeader: string[] | null
  /** managers: opens the "Sửa cài đặt" dialog (map the missing columns) */
  onEdit?: () => void
}) {
  const cred = detail.credential
  const sheet = detail.sheet
  const unusedLinks = sheet ? LINK_COLUMNS.filter((k) => !sheet.columns[k]) : []
  const auto = sheet ? autoHeaders(sheet, sheetHeader) : null
  const autoFound = auto ? AUTO_DETECT_COLUMN_KEYS.filter((k) => !!auto[k]) : []
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.infoTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3">
          <InfoRow label={m.credential}>
            <span className="font-medium">
              {cred.kind === "system"
                ? u.systemEmail
                : u.personalCredential(cred.name ?? "")}
            </span>
            <span className="block font-mono text-xs break-all text-muted-foreground">
              {cred.clientEmail}
            </span>
          </InfoRow>
          {detail.googleName && detail.googleName !== detail.name && (
            <InfoRow label={m.googleName}>{detail.googleName}</InfoRow>
          )}
          <InfoRow label={m.googleId}>
            <span className="font-mono text-xs break-all">
              {detail.googleId}
              {detail.sheetGid !== null && ` · gid=${detail.sheetGid}`}
            </span>
            {detail.sharedDrive && (
              <span className="block text-[13px] text-muted-foreground">
                {m.sharedDrive}
              </span>
            )}
          </InfoRow>
          {detail.folder && (
            <InfoRow label={m.depth}>
              {driveUi.wizard.depthOptions[detail.folder.recursiveDepth] ??
                detail.folder.recursiveDepth}
            </InfoRow>
          )}
          {sheet && (
            <>
              <InfoRow label={m.headerRow}>
                <span className="tabular-nums">{sheet.headerRow}</span>
              </InfoRow>
              <InfoRow label={m.writeback}>
                {sheet.writeback ? m.writebackOn : m.writebackOff}
              </InfoRow>
              <InfoRow label={m.columnsTitle}>
                {/* two groups (AI đọc / AI ghi); header names as chips, the logical column is spelled out only
                    when the sheet names it differently */}
                {(
                  [
                    [m.columnsRead, SHEET_COLUMN_KEYS.filter((k) => !SHEET_WRITABLE_COLUMN_KEYS.includes(k))],
                    [m.columnsWrite, SHEET_WRITABLE_COLUMN_KEYS],
                  ] as const
                ).map(([groupLabel, keys]) => {
                  const shown = keys.filter((k) => !!sheet.columns[k])
                  const writeGroup = groupLabel === m.columnsWrite
                  // write-back off: the "AI ghi" columns are kept but not written - shown dimmed
                  const off = writeGroup && !sheet.writeback
                  if (
                    shown.length === 0 &&
                    !(writeGroup && unusedLinks.length > 0) &&
                    !(!writeGroup && autoFound.length > 0)
                  )
                    return null
                  return (
                    <div key={groupLabel} className="mt-1.5 flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {groupLabel}
                        {off && <> {m.columnsWriteOff}</>}
                      </span>
                      {(shown.length > 0 || (!writeGroup && autoFound.length > 0)) && (
                      <ul className={cn("flex flex-wrap gap-1", off && "opacity-55")}>
                        {shown.map((k: SheetColumnKey) => {
                          const label = driveUi.wizard.columns[k] ?? k
                          const name = sheet.columns[k]!
                          return (
                            <li
                              key={k}
                              title={label}
                              className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-xs"
                            >
                              {name === label ? name : `${label}: ${name}`}
                            </li>
                          )
                        })}
                        {!writeGroup &&
                          autoFound.map((k) => (
                            <li
                              key={`auto-${k}`}
                              title={m.autoColumnTitle[k]}
                              className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-xs"
                            >
                              {m.autoColumn(driveUi.wizard.columns[k] ?? k, auto![k]!)}
                            </li>
                          ))}
                      </ul>
                      )}
                      {!writeGroup && auto?.cover === "" && (
                        <span className="mt-0.5 text-xs text-pretty text-muted-foreground">
                          {m.coverMissing}
                        </span>
                      )}
                      {writeGroup && unusedLinks.length > 0 && (
                        <div className="mt-0.5 flex flex-col items-start gap-1.5">
                          <span className="text-xs text-pretty text-muted-foreground">
                            {m.columnsUnused(
                              unusedLinks
                                .map((k) => driveUi.wizard.columns[k] ?? k)
                                .join(", ")
                            )}
                          </span>
                          {onEdit && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={onEdit}
                              className="max-sm:h-10"
                            >
                              <HugeiconsIcon
                                icon={PencilEdit02Icon}
                                strokeWidth={2}
                                data-icon="inline-start"
                                aria-hidden
                              />
                              {m.edit}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </InfoRow>
            </>
          )}
          {(isAdmin || !detail.isMine) && (
            <InfoRow label={m.owner}>
              <span className="break-all">
                {detail.owner.name || detail.owner.email}
              </span>
              {detail.owner.name && (
                <span className="block text-[13px] break-all text-muted-foreground">
                  {detail.owner.email}
                </span>
              )}
            </InfoRow>
          )}
          <InfoRow label={m.lastChecked}>
            {detail.lastCheckedAt ? (
              <RelativeTime value={detail.lastCheckedAt} />
            ) : (
              <span className="text-muted-foreground">{m.never}</span>
            )}
          </InfoRow>
          <InfoRow label={m.createdAt}>
            <span className="tabular-nums">{formatDate(detail.createdAt)}</span>
          </InfoRow>
        </dl>
      </CardContent>
    </Card>
  )
}

function UsageList({ detail }: { detail: DriveSourceDetail }) {
  const visible = detail.usedBy.filter((x) => x.id !== null && x.name !== null)
  const hidden = detail.usedBy.length - visible.length
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {visible.map((x) => (
        <li key={x.id}>
          <Link
            href={`/mcp-servers/${x.id}`}
            className="flex min-h-9 items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-muted"
          >
            <span className="min-w-0 break-words">{x.name}</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </Link>
        </li>
      ))}
      {hidden > 0 && (
        <li className="px-2 text-muted-foreground">{m.usedByOther(hidden)}</li>
      )}
    </ul>
  )
}

function UsageCard({ detail }: { detail: DriveSourceDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.usedByTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {detail.usedBy.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.usedByNone}</p>
        ) : (
          <UsageList detail={detail} />
        )}
      </CardContent>
    </Card>
  )
}
