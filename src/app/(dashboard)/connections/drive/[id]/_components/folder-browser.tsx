"use client"

// Read-only file grid of a folder source: sub-folders, image / video tiles with thumbnails (session route
// /api/drive/thumb/<sourceId>/<fileId>, same permission checks as the page), image/video filter, "Tải thêm".
import * as React from "react"
import Image from "next/image"
import {
  Folder01Icon,
  Image01Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { PlatformIcon } from "@/components/app"
import { SegmentedControl } from "@/components/mcp/segmented-control"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PLATFORM_LABELS } from "@/lib/constants"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import type {
  DriveFileDto,
  DriveFileFamilyDto,
  DriveFilesPage,
  DriveFolderDto,
} from "@/lib/schemas/drive"
import { listDriveSourceFilesAction } from "@/server/actions/drive"

import { formatBytes, formatClock } from "../../_components/drive-format"
import { ListingErrorAlert, type ListingErrorOptions } from "./listing-error"

const m = driveUi.detail

type Crumb = { id: string; name: string }

type State =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready"
      folders: DriveFolderDto[]
      files: DriveFileDto[]
      skipped: number
      nextPageToken: string | null
    }

export function FolderBrowser({
  sourceId,
  rootName,
  reloadKey = 0,
  listingError,
}: {
  sourceId: string
  rootName: string
  /** bumped by the page after "Kiểm tra lại" → the grid loads again */
  reloadKey?: number
  /** error state: note about the last check + the one action (see ListingErrorAlert) */
  listingError?: ListingErrorOptions
}) {
  const [family, setFamily] = React.useState<DriveFileFamilyDto>("all")
  // sub-folder path below the source root (root = empty)
  const [path, setPath] = React.useState<Crumb[]>([])
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [reload, setReload] = React.useState(0)
  const folderId = path.at(-1)?.id
  // the result belongs to one request (folder + filter + retry); anything else reads as "loading"
  const reqKey = `${folderId ?? ""}|${family}|${reload}|${reloadKey}`
  const [result, setResult] = React.useState<{
    key: string
    value: Exclude<State, { state: "loading" }>
  } | null>(null)
  const data: State =
    result && result.key === reqKey ? result.value : { state: "loading" }
  const setData = (value: Exclude<State, { state: "loading" }>) =>
    setResult({ key: reqKey, value })

  React.useEffect(() => {
    let cancelled = false
    const key = reqKey
    void listDriveSourceFilesAction({ sourceId, folderId, family }).then(
      (res) => {
        if (cancelled) return
        if (!res.ok) {
          setResult({ key, value: { state: "error", message: res.error } })
          return
        }
        setResult({
          key,
          value: {
            state: "ready",
            folders: res.data.folders,
            files: res.data.files,
            skipped: res.data.skipped,
            nextPageToken: res.data.nextPageToken,
          },
        })
      },
      () =>
        !cancelled &&
        setResult({
          key,
          value: { state: "error", message: driveUi.service.generic },
        })
    )
    return () => {
      cancelled = true
    }
  }, [sourceId, folderId, family, reqKey])

  const loadMore = async () => {
    if (data.state !== "ready" || !data.nextPageToken) return
    setLoadingMore(true)
    const res = await listDriveSourceFilesAction({
      sourceId,
      folderId,
      family,
      pageToken: data.nextPageToken,
    })
    setLoadingMore(false)
    if (!res.ok) {
      setData({ state: "error", message: res.error })
      return
    }
    const page: DriveFilesPage = res.data
    setData({
      state: "ready",
      folders: [...data.folders, ...page.folders],
      files: [...data.files, ...page.files],
      skipped: data.skipped + page.skipped,
      nextPageToken: page.nextPageToken,
    })
  }

  return (
    <Card className="@container gap-4">
      <CardHeader>
        <CardTitle>{m.filesTitle}</CardTitle>
        <CardDescription>{m.filesDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SegmentedControl<DriveFileFamilyDto>
          value={family}
          onValueChange={setFamily}
          ariaLabel={m.filterLabel}
          fill="mobile"
          className="sm:self-start"
          options={[
            { value: "all", label: m.filterAll },
            { value: "image", label: m.filterImage },
            { value: "video", label: m.filterVideo },
          ]}
        />
        {path.length > 0 && (
          <Breadcrumb aria-label={m.breadcrumbLabel}>
            <BreadcrumbList>
              {[{ id: "", name: rootName }, ...path].map((c, i, all) => (
                <React.Fragment key={`${c.id}-${i}`}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className="min-w-0">
                    {i < all.length - 1 ? (
                      <button
                        type="button"
                        className="max-w-48 truncate rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-10"
                        onClick={() => setPath(path.slice(0, i))}
                      >
                        {c.name}
                      </button>
                    ) : (
                      <BreadcrumbPage className="max-w-48 truncate">
                        {c.name}
                      </BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </React.Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}

        {data.state === "loading" && <GridSkeleton />}

        {data.state === "error" && (
          <ListingErrorAlert
            title={m.filesErrorTitle}
            message={data.message}
            options={listingError}
            onReload={() => setReload((n) => n + 1)}
          />
        )}

        {data.state === "ready" && (
          <>
            {data.folders.length === 0 && data.files.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center">
                <HugeiconsIcon
                  icon={Folder01Icon}
                  strokeWidth={1.75}
                  className="size-6 text-muted-foreground"
                  aria-hidden
                />
                <p className="text-sm text-muted-foreground">
                  {family === "all" ? m.filesEmpty : m.filesEmptyFiltered}
                </p>
              </div>
            ) : (
              <>
                {data.folders.length > 0 && (
                  <ul className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-4">
                    {data.folders.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() =>
                            setPath([...path, { id: f.id, name: f.name }])
                          }
                          aria-label={m.openFolder(f.name)}
                          className="flex h-full min-h-11 w-full min-w-0 items-center gap-2.5 rounded-xl border bg-card px-3 py-2 text-left text-sm font-medium transition-colors outline-none hover:border-brand-primary/40 hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <HugeiconsIcon
                            icon={Folder01Icon}
                            strokeWidth={2}
                            className="size-5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="line-clamp-2 min-w-0 break-words">
                            {f.name}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {data.files.length > 0 && (
                  <ul className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-4">
                    {data.files.map((f) => (
                      <li key={f.id}>
                        <FileTile sourceId={sourceId} file={f} />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {(data.skipped > 0 || data.nextPageToken) && (
              <div className="flex flex-col items-center gap-2">
                {data.nextPageToken && (
                  <Button
                    variant="outline"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    className="pointer-coarse:h-10"
                  >
                    {loadingMore && <Spinner aria-hidden />}
                    {loadingMore ? m.loadingMore : m.loadMore}
                  </Button>
                )}
                {data.skipped > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    {m.skipped(data.skipped)}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function GridSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-4"
      aria-busy="true"
      aria-label={driveUi.detail.loadingMore}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

function FileTile({
  sourceId,
  file,
}: {
  sourceId: string
  file: DriveFileDto
}) {
  const [broken, setBroken] = React.useState(false)
  const isVideo = file.family === "video"
  const size = formatBytes(file.sizeBytes)
  const dims = file.width && file.height ? `${file.width}×${file.height}` : null
  const clock = isVideo ? formatClock(file.durationMs) : null
  const meta = [size, dims].filter(Boolean).join(" · ")
  const platforms = [...new Set(file.usedIn.map((u) => u.platform))].filter(
    (p): p is keyof typeof PLATFORM_LABELS => p in PLATFORM_LABELS
  )
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card">
      <div className="relative aspect-video bg-muted">
        {!broken ? (
          <Image
            src={`/api/drive/thumb/${encodeURIComponent(sourceId)}/${encodeURIComponent(file.id)}`}
            alt=""
            fill
            unoptimized
            loading="lazy"
            sizes="(min-width: 1024px) 220px, 45vw"
            className="object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <HugeiconsIcon
              icon={isVideo ? Video01Icon : Image01Icon}
              strokeWidth={1.75}
              className="size-7"
              aria-hidden
            />
          </span>
        )}
        <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium text-foreground shadow-sm">
          <HugeiconsIcon
            icon={isVideo ? Video01Icon : Image01Icon}
            strokeWidth={2}
            className="size-3.5"
            aria-hidden
          />
          {isVideo ? driveUi.detail.filterVideo : driveUi.detail.filterImage}
          {clock && <span className="tabular-nums">· {clock}</span>}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <span
          className="line-clamp-2 text-sm leading-5 font-medium break-words"
          title={file.name}
        >
          {file.name}
        </span>
        {meta && (
          <span
            className="truncate text-xs text-muted-foreground tabular-nums"
            title={meta}
          >
            {meta}
          </span>
        )}
        <span className="mt-auto pt-1">
          {file.usedIn.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-xs font-medium text-success-strong ring-1 ring-success/25 outline-none ring-inset",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  )}
                >
                  {platforms.slice(0, 3).map((p) => (
                    <PlatformIcon key={p} platform={p} className="size-3" />
                  ))}
                  <span aria-hidden className="truncate">
                    {m.usedInShort(file.usedIn.length)}
                  </span>
                  <span className="sr-only">
                    {m.usedIn(file.usedIn.length)}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                <ul className="flex flex-col gap-0.5">
                  {file.usedIn.map((u) => (
                    <li key={`${u.adAccountId}-${u.mediaId}`}>
                      {(PLATFORM_LABELS as Record<string, string>)[
                        u.platform
                      ] ?? u.platform}
                      {" · "}
                      {u.adAccountName}
                    </li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-xs text-muted-foreground">{m.notUsed}</span>
          )}
        </span>
      </div>
    </div>
  )
}
