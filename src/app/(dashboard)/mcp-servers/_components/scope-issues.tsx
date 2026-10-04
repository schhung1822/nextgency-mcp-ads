import Link from "next/link"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PlatformIcon } from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PLATFORM_LABELS } from "@/lib/constants"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  MCP_PLATFORMS,
  type McpScopeIssue,
  type ScopeAnalysis,
} from "@/lib/schemas/mcp-servers"

const s = t.config.scopeIssues

function issueText(i: McpScopeIssue): string {
  switch (i.kind) {
    case "connection_deleted":
      return s.connectionDeleted(i.connectionName)
    case "connection_unavailable":
      return i.disabled
        ? s.connectionDisabled(i.connectionName)
        : s.connectionUnavailable(i.connectionName)
    case "accounts_disabled": {
      const names = i.accounts.flatMap((a) => (a.name ? [a.name] : []))
      return s.accountsDisabled(
        i.connectionName,
        names,
        i.accounts.length - names.length
      )
    }
  }
}

/**
 * Non-alarming notice above the platform picker of the config editor: the stored config still points at
 * connections / ad accounts that were deleted or switched off. The editor has already dropped them from the form,
 * so they leave the MCP for good when the config is saved - this says which, per platform.
 */
export function ScopeIssuesAlert({ analysis }: { analysis: ScopeAnalysis }) {
  const { issues, droppedPlatforms } = analysis
  if (issues.length === 0 && droppedPlatforms.length === 0) return null
  const platforms = MCP_PLATFORMS.filter(
    (p) =>
      issues.some((i) => i.platform === p) || droppedPlatforms.includes(p)
  )
  return (
    <Alert className="border-warning/40 bg-warning/10">
      <HugeiconsIcon
        icon={Alert02Icon}
        strokeWidth={2}
        aria-hidden
        className="text-warning-strong"
      />
      <AlertTitle className="text-warning-strong">{s.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <div>{s.description}</div>
        <div className="flex flex-col gap-2.5">
          {platforms.map((p) => (
            <section
              key={p}
              aria-label={PLATFORM_LABELS[p]}
              className="flex flex-col gap-1"
            >
              <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <PlatformIcon platform={p} colored className="size-4" />
                {PLATFORM_LABELS[p]}
              </h4>
              <ul className="flex list-disc flex-col gap-1 pl-9 text-[13px] break-words">
                {issues
                  .filter((i) => i.platform === p)
                  .map((i) => (
                    <li key={`${i.kind}-${i.connectionId}`}>{issueText(i)}</li>
                  ))}
                {droppedPlatforms.includes(p) && (
                  <li>{s.platformDropped(PLATFORM_LABELS[p])}</li>
                )}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[13px]">{s.keepHint}</div>
          <Button
            variant="outline"
            size="sm"
            asChild
            className="w-full shrink-0 no-underline! sm:w-auto"
          >
            <Link href="/connections">{s.openConnections}</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
