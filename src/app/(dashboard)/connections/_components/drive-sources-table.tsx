"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Add01Icon,
  Alert02Icon,
  ArrowRight01Icon,
  GoogleDriveIcon,
  InformationCircleIcon,
  Link01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  BrandIcon,
  CopyField,
  createDataTableColumnHelper,
  DataTable,
  EmptyState,
  FilterBar,
  RelativeTime,
  type FilterValues,
} from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  DRIVE_SOURCE_KINDS,
  DRIVE_SOURCE_SCOPES,
  DRIVE_STATUSES,
  type DriveSourceDto,
  type DriveSystemInfo,
  type PersonalDriveCredentialDto,
} from "@/lib/schemas/drive"

import {
  DriveKindIcon,
  DriveScopeBadge,
  DriveStatusBadge,
} from "../drive/_components/drive-badges"
import { driveStatusText } from "../drive/_components/drive-format"
import { PersonalCredentialsSection } from "../drive/_components/personal-credentials"

const m = driveUi.list
const u = driveUi.ui

const col = createDataTableColumnHelper<DriveSourceDto>()

const HIDE_BELOW_2XL = "hidden @2xl:table-cell"
const HIDE_BELOW_3XL = "hidden @3xl:table-cell"
const HIDE_BELOW_4XL = "hidden @4xl:table-cell"
const HIDE_BELOW_5XL = "hidden @5xl:table-cell"

const detailHref = (id: string) => `/connections/drive/${id}`

function buildColumns(isAdmin: boolean) {
  return col.columns([
    col.accessor("name", {
      header: m.colName,
      meta: { className: "w-full min-w-44 max-w-0" },
      cell: ({ row }) => (
        <Link
          href={detailHref(row.original.id)}
          title={row.original.name}
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <DriveKindIcon kind={row.original.kind} />
          {/* long names wrap onto a second line instead of being cut to a few letters (L1) */}
          <span className="line-clamp-2 break-words whitespace-normal">
            {row.original.name}
          </span>
        </Link>
      ),
    }),
    col.accessor("kind", {
      header: m.colKind,
      meta: { className: HIDE_BELOW_5XL, headerClassName: HIDE_BELOW_5XL },
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap">{u.kind[getValue()]}</span>
      ),
    }),
    col.accessor("scope", {
      header: m.colScope,
      meta: { className: HIDE_BELOW_2XL, headerClassName: HIDE_BELOW_2XL },
      cell: ({ getValue }) => <DriveScopeBadge scope={getValue()} />,
    }),
    ...(isAdmin
      ? [
          col.accessor((r) => r.owner.name || r.owner.email, {
            id: "owner",
            header: m.colOwner,
            meta: { className: HIDE_BELOW_4XL, headerClassName: HIDE_BELOW_4XL },
            cell: ({ row }) => (
              <span
                className="block max-w-40 truncate text-muted-foreground"
                title={row.original.owner.email}
              >
                {row.original.owner.name || row.original.owner.email}
              </span>
            ),
          }),
        ]
      : []),
    col.accessor("mcpCount", {
      header: m.colMcp,
      meta: {
        align: "end",
        className: `${HIDE_BELOW_3XL} tabular-nums`,
        headerClassName: HIDE_BELOW_3XL,
      },
      cell: ({ getValue }) => getValue(),
    }),
    col.accessor("status", {
      header: m.colStatus,
      cell: ({ row }) => {
        const msg =
          row.original.status === "error"
            ? driveStatusText(row.original.statusMessage, {
                isAdmin,
                credentialKind: row.original.credential.kind,
              })
            : null
        return (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <DriveStatusBadge status={row.original.status} />
            {msg && (
              <span
                className="line-clamp-2 max-w-60 text-[13px] break-words whitespace-normal text-destructive"
                title={msg}
              >
                {msg}
              </span>
            )}
          </span>
        )
      },
    }),
    col.accessor("lastCheckedAt", {
      header: m.colChecked,
      sortUndefined: "last",
      // hidden earlier than the other columns: the name needs the width more (L1)
      meta: { className: HIDE_BELOW_4XL, headerClassName: HIDE_BELOW_4XL },
      cell: ({ getValue }) =>
        getValue() ? (
          <RelativeTime value={getValue()} className="text-muted-foreground" />
        ) : (
          <span className="text-muted-foreground">{m.never}</span>
        ),
    }),
  ])
}

/** Top of the tab: the system email to share folders with (or why there is none). */
function SystemEmailBlock({
  system,
  isAdmin,
}: {
  system: DriveSystemInfo
  isAdmin: boolean
}) {
  if (!system.configured || !system.clientEmail) {
    return (
      <div className="border-b p-3">
        <Alert>
          <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden />
          <AlertTitle>{m.notConfiguredTitle}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{isAdmin ? m.notConfiguredAdmin : m.notConfiguredStaff}</span>
            {isAdmin && (
              <Button variant="outline" size="sm" asChild className="pointer-coarse:h-10">
                <Link href="/settings#google-drive" className="no-underline!">
                  <HugeiconsIcon
                    icon={Settings02Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  {m.openSettings}
                </Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 border-b p-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <BrandIcon brand="drive" />
            {m.systemTitle}
          </span>
          {/* admin only: staff cannot act on the API key (the MCP form tells them when public links are off) */}
          {isAdmin && (
            <span
              className={
                system.hasApiKey
                  ? "flex items-center gap-1.5 text-[13px] text-muted-foreground"
                  : "flex items-center gap-1.5 text-[13px] text-warning-strong"
              }
              title={system.hasApiKey ? undefined : m.publicLinksOffHint}
            >
              <HugeiconsIcon
                icon={Link01Icon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
                aria-hidden
              />
              {system.hasApiKey ? m.publicLinksOn : m.publicLinksOff}
            </span>
          )}
        </div>
        <CopyField
          value={system.clientEmail}
          label={m.systemCopyLabel}
          className="max-w-2xl"
          wrap
        />
        <p className="text-[13px] text-pretty text-muted-foreground">
          {m.systemHint}
        </p>
      </div>
      {system.status === "error" && (
        <Alert variant="destructive">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertTitle>{m.systemErrorTitle}</AlertTitle>
          <AlertDescription>
            {isAdmin ? m.systemErrorAdmin : m.systemErrorStaff}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/** "Google Drive" view of /connections: system email, registered folders / sheets, own service accounts. */
export function DriveSourcesTable({
  sources,
  system,
  personalCredentials,
  isAdmin,
  ctaVariant = "brand",
}: {
  sources: DriveSourceDto[]
  system: DriveSystemInfo
  personalCredentials: PersonalDriveCredentialDto[]
  isAdmin: boolean
  /** the page header already shows the one brand button → the empty-state CTA is outline */
  ctaVariant?: "brand" | "outline"
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])
  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const kind = filters.kind ?? []
    const scope = filters.scope ?? []
    const st = filters.status ?? []
    return sources.filter(
      (s) =>
        (kind.length === 0 || kind.includes(s.kind)) &&
        (scope.length === 0 || scope.includes(s.scope)) &&
        (st.length === 0 || st.includes(s.status)) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          (s.googleName ?? "").toLowerCase().includes(q) ||
          (isAdmin && s.owner.email.toLowerCase().includes(q)))
    )
  }, [sources, search, filters, isAdmin])

  return (
    <>
      <SystemEmailBlock system={system} isAdmin={isAdmin} />
      {sources.length === 0 ? (
        <EmptyState
          icon={GoogleDriveIcon}
          title={m.emptyTitle}
          description={m.emptyDescription}
          action={
            <Button variant={ctaVariant} asChild>
              <Link href="/connections/drive/new">
                <HugeiconsIcon
                  icon={Add01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden
                />
                {m.add}
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="border-b p-3">
            <FilterBar
              search={{
                value: search,
                onChange: setSearch,
                placeholder: m.searchPlaceholder,
                label: m.searchLabel,
              }}
              filters={[
                {
                  id: "kind",
                  label: m.filterKind,
                  options: DRIVE_SOURCE_KINDS.map((k) => ({
                    value: k,
                    label: u.kind[k] ?? k,
                    count: sources.filter((s) => s.kind === k).length,
                  })),
                },
                {
                  id: "scope",
                  label: m.filterScope,
                  options: DRIVE_SOURCE_SCOPES.map((k) => ({
                    value: k,
                    label: u.scope[k] ?? k,
                    count: sources.filter((s) => s.scope === k).length,
                  })),
                },
                {
                  id: "status",
                  label: m.filterStatus,
                  options: DRIVE_STATUSES.map((k) => ({
                    value: k,
                    label: u.status[k] ?? k,
                    count: sources.filter((s) => s.status === k).length,
                  })),
                },
              ]}
              values={filters}
              onValuesChange={setFilters}
            />
          </div>
          <DataTable
            ariaLabel={m.tableLabel}
            columns={columns}
            data={data}
            getRowId={(r) => r.id}
            defaultSorting={[{ id: "name", desc: false }]}
            pageSize={20}
            onRowClick={(r) => router.push(detailHref(r.id))}
            empty={
              <EmptyState
                title={m.emptyFilteredTitle}
                description={m.emptyFilteredDescription}
              />
            }
            renderMobileCard={(r) => (
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      <DriveKindIcon kind={r.kind} />
                      <span className="line-clamp-2 break-words">{r.name}</span>
                    </span>
                    <DriveStatusBadge status={r.status} className="shrink-0" />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                    <DriveScopeBadge scope={r.scope} />
                    <span>{u.kind[r.kind]}</span>
                    <span>{m.mcpCount(r.mcpCount)}</span>
                    {isAdmin && (
                      <span className="max-w-full truncate">
                        {r.owner.name || r.owner.email}
                      </span>
                    )}
                  </div>
                  {r.status === "error" && r.statusMessage && (
                    <p className="line-clamp-2 text-[13px] break-words text-destructive">
                      {driveStatusText(r.statusMessage, {
                        isAdmin,
                        credentialKind: r.credential.kind,
                      })}
                    </p>
                  )}
                </div>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </div>
            )}
          />
        </>
      )}
      <PersonalCredentialsSection
        credentials={personalCredentials}
        isAdmin={isAdmin}
      />
    </>
  )
}
