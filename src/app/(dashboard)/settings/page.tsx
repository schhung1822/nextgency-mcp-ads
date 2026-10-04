import type { ReleasedPlatform } from "@/lib/platforms"
import type { Metadata } from "next"
import Link from "next/link"

import { PlatformIcon, StatusBadge } from "@/components/app"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PLATFORM_LABELS } from "@/lib/constants"
import { formatNumber } from "@/lib/format"
import { settings as ts } from "@/lib/i18n/vi/settings"
import { updates as tu } from "@/lib/i18n/vi/updates"
import { displayVersion } from "@/lib/version"
import { requireAdmin } from "@/server/auth/session"
import { env } from "@/server/env"
import { getLogStorageInfo, type LogTableInfo } from "@/server/services/logs"
import { getAllSettings } from "@/server/services/settings"
import { getVersionBadge } from "@/server/services/updates"

import { SettingsForm } from "./_components/settings-form"

export const metadata: Metadata = { title: ts.title }

type ApiPlatform = ReleasedPlatform

/** Known sunset dates of API versions (from .claude/docs/providers/*.md, checked 2026-10-02). */
const KNOWN_EXPIRY: Partial<Record<ApiPlatform, Record<string, string>>> = {
  meta: { "v24.0": "2026-10-06" },
}
/** versions already past their sunset (exact date not tracked) */
const KNOWN_EXPIRED: Partial<Record<ApiPlatform, string[]>> = {
  meta: ["v22.0", "v23.0"],
}

function versionState(
  platform: ApiPlatform,
  version: string,
  now: Date
): "ok" | "soon" | "expired" {
  if (KNOWN_EXPIRED[platform]?.includes(version)) return "expired"
  const exp = KNOWN_EXPIRY[platform]?.[version]
  if (!exp) return "ok"
  const days = (Date.parse(`${exp}T00:00:00Z`) - now.getTime()) / 86_400_000
  if (days < 0) return "expired"
  return days <= 30 ? "soon" : "ok"
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${formatNumber(v, 1)} ${units[i]}`
}

/** "FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')" → "10/2026" */
function partitionLabel(name: string): string {
  const m = /_p(\d{4})(\d{2})$/.exec(name)
  if (m) return `${m[2]}/${m[1]}`
  return name.endsWith("_default") ? ts.system.defaultPartition : name
}

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, storage, version] = await Promise.all([
    getAllSettings(),
    getLogStorageInfo(),
    getVersionBadge("admin"),
  ])
  const e = env()
  const now = new Date()
  const versions: { platform: ApiPlatform; envVar: string; version: string }[] =
    [
      {
        platform: "meta",
        envVar: "META_API_VERSION",
        version: e.META_API_VERSION,
      },
      {
        platform: "openai_ads",
        envVar: "OPENAI_ADS_API_VERSION",
        version: e.OPENAI_ADS_API_VERSION,
      },
    ]

  return (
    <div className="flex w-full flex-col">
      <SettingsForm
        initial={{
          log_retention_months_mcp: settings.log_retention_months_mcp,
          log_retention_months_staff: settings.log_retention_months_staff,
          require_2fa_admin: settings.require_2fa_admin,
          require_2fa_all: settings.require_2fa_all,
          session_max_hours: settings.session_max_hours,
        }}
        after={
          <SystemCard
            storage={storage}
            timezone={e.APP_TIMEZONE}
            appVersion={version.current}
          />
        }
      >
        <Card>
          <CardHeader>
            <CardTitle>{tu.settingsCard.title}</CardTitle>
            <CardDescription>{tu.settingsCard.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {tu.settingsCard.current}
              </span>
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                {displayVersion(version.current)}
              </code>
            </div>
            {version.latestVersion && (
              <p className="text-sm font-medium text-brand-ink">
                {tu.settingsCard.newAvailable(
                  displayVersion(version.latestVersion)
                )}
              </p>
            )}
            <Button variant="outline" asChild>
              <Link href="/settings/updates">{tu.settingsCard.open}</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{ts.apiVersions.title}</CardTitle>
            <CardDescription>{ts.apiVersions.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {versions.map((v) => {
                const state = versionState(v.platform, v.version, now)
                return (
                  <li
                    key={v.platform}
                    className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <PlatformIcon
                          platform={v.platform}
                          colored
                          className="size-4"
                        />
                        {PLATFORM_LABELS[v.platform]}
                      </span>
                      <span className="flex items-center gap-2">
                        {state !== "ok" && (
                          <StatusBadge
                            kind="connection"
                            status={
                              state === "expired" ? "invalid" : "expiring"
                            }
                            label={
                              state === "expired"
                                ? ts.apiVersions.expired
                                : ts.apiVersions.warnSoon
                            }
                          />
                        )}
                        <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {v.version}
                        </code>
                      </span>
                    </div>
                    <p className="text-[13px] text-muted-foreground">
                      {ts.apiVersions.notes[v.platform]}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {v.envVar}
                    </p>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      </SettingsForm>
    </div>
  )
}

/** Read-only system info: app facts + stats (col 1), one block per log table (cols 2–3) on desktop. */
function SystemCard({
  storage,
  timezone,
  appVersion,
}: {
  storage: Awaited<ReturnType<typeof getLogStorageInfo>>
  timezone: string
  appVersion: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ts.system.title}</CardTitle>
        <CardDescription>{ts.system.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-3 lg:gap-0">
        <div className="flex flex-col gap-4 lg:pr-6">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{ts.system.appVersion}</dt>
            <dd className="font-mono text-xs leading-5">
              {displayVersion(appVersion)}
            </dd>
            <dt className="text-muted-foreground">{ts.system.timezone}</dt>
            <dd className="font-mono text-xs leading-5">{timezone}</dd>
          </dl>
          <div className="flex items-center justify-between gap-2 border-t pt-3 text-sm">
            <span className="text-muted-foreground">{ts.system.stats}</span>
            <span className="tabular-nums">
              {formatBytes(storage.stats.bytes)} ·{" "}
              {formatNumber(storage.stats.rowsEstimate)}
            </span>
          </div>
        </div>
        {storage.tables.map((t) => (
          <LogTableBlock key={t.table} info={t} />
        ))}
      </CardContent>
    </Card>
  )
}

function LogTableBlock({ info }: { info: LogTableInfo }) {
  const monthly = info.partitions.filter((p) => /_p\d{6}$/.test(p.name))
  const first = monthly[0]
  const last = monthly[monthly.length - 1]
  return (
    <div className="flex flex-col gap-2 border-t pt-4 lg:border-t-0 lg:border-l lg:px-6 lg:pt-0 lg:last:pr-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {info.table === "mcp_call_logs"
            ? ts.system.mcpLogs
            : ts.system.staffLogs}
        </span>
        <span className="text-sm tabular-nums">
          {formatBytes(info.totalBytes)}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {ts.system.partitionCount(monthly.length)}
        {first && last
          ? ` · ${partitionLabel(first.name)} → ${partitionLabel(last.name)}`
          : ""}{" "}
        · {ts.system.rows}: {formatNumber(info.rowsEstimate)}
      </p>
      {info.defaultRows > 0 ? (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertDescription className="text-warning-strong">
            {ts.system.defaultRowsWarning(
              info.defaultRows > 10_000
                ? "10.000+"
                : formatNumber(info.defaultRows)
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {ts.system.defaultPartition}: {ts.system.defaultEmpty}
        </p>
      )}
      <details className="group text-[13px]">
        <summary className="cursor-pointer text-brand-ink select-none hover:underline">
          {ts.system.showPartitions}
        </summary>
        <ul className="mt-2 flex flex-col gap-1">
          {info.partitions.map((p) => (
            <li
              key={p.name}
              className="flex items-center justify-between gap-2"
            >
              <span className="font-mono text-xs">{p.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {formatBytes(p.bytes)} · {formatNumber(p.rowsEstimate)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
