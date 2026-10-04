"use client"

import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { StatusBadge } from "@/components/app"
import { StatusHint } from "@/components/mcp/status-hint"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { formatDateTime } from "@/lib/format"
import { connections as m } from "@/lib/i18n/vi/connections"
import type { ConnectionStatusValue } from "@/lib/schemas/connections"

export function TokenSummary({
  status,
  statusMessage,
  statusHint,
  tokenExpiresAt,
  scopes,
  warnings,
}: {
  status: ConnectionStatusValue
  statusMessage: string | null
  /** the concrete next step under the message (null → nothing to do) */
  statusHint?: string | null
  tokenExpiresAt: string | null
  scopes: string[] | null
  warnings: string[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 font-semibold">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-5 text-success" aria-hidden />
          {m.new.verifyOkTitle}
        </span>
        <StatusBadge kind="connection" status={status} />
        <span className="text-sm text-muted-foreground">
          {tokenExpiresAt ? m.new.tokenExpires(formatDateTime(tokenExpiresAt)) : m.new.tokenNoExpiry}
        </span>
      </div>
      {(statusMessage || statusHint) && (
        <div className="flex flex-col gap-1">
          {statusMessage && <p className="text-sm text-warning-strong">{statusMessage}</p>}
          <StatusHint message={statusMessage} hint={statusHint} />
        </div>
      )}
      {scopes && scopes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">{m.new.scopes}</span>
          <div className="flex flex-wrap gap-1.5">
            {scopes.map((s) => (
              <Badge key={s} variant="outline" className="rounded-full font-mono text-xs">
                {s}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {warnings.length > 0 && <WarningsAlert title={m.new.warnings} warnings={warnings} />}
    </div>
  )
}

export function WarningsAlert({ title, warnings }: { title: string; warnings: string[] }) {
  return (
    <Alert>
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="ml-4 list-disc space-y-1">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
