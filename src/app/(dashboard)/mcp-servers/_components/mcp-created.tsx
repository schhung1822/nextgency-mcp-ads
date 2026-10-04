"use client"

import * as React from "react"
import Link from "next/link"
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { GlassCard, PageGuide } from "@/components/app"
import { ClientSetupGuide } from "@/components/mcp/client-setup-guide"
import { UrlCopyBox } from "@/components/mcp/url-copy-box"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { mcp as t } from "@/lib/i18n/vi/mcp"

/** Success screen after creating an MCP: the full URL is shown ONCE here (kept only in component state). */
export function McpCreated({
  id,
  name,
  url,
  onCreateAnother,
}: {
  id: string
  name: string
  url: string
  onCreateAnother?: () => void
}) {
  const titleRef = React.useRef<HTMLHeadingElement>(null)
  React.useEffect(() => titleRef.current?.focus(), [])
  return (
    <div className="flex w-full flex-col gap-6">
      <PageGuide guide={tg.mcpCreated} />
      <GlassCard strong className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success-strong">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              className="size-6"
              aria-hidden
            />
          </span>
          <div className="min-w-0">
            <h2
              ref={titleRef}
              tabIndex={-1}
              className="text-xl font-semibold text-balance break-words outline-none"
            >
              {t.success.title(name)}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.success.description}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t.success.urlLabel}</span>
          <UrlCopyBox value={url} label={t.success.urlLabel} />
        </div>
        <Alert className="border-warning/40 bg-warning/10">
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            aria-hidden
            className="text-warning-strong"
          />
          <AlertTitle className="text-warning-strong">
            {t.success.warningTitle}
          </AlertTitle>
          <AlertDescription>
            {t.success.warning} {t.success.revealNote}
          </AlertDescription>
        </Alert>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="brand" size="lg" asChild>
            <Link href={`/mcp-servers/${id}`}>{t.success.goToDetail}</Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/mcp-servers">{t.success.backToList}</Link>
          </Button>
          {onCreateAnother && (
            <Button variant="ghost" size="lg" onClick={onCreateAnother}>
              {t.success.createAnother}
            </Button>
          )}
        </div>
      </GlassCard>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.connect.guideTitle}</CardTitle>
          <CardDescription>{t.connect.guideDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <ClientSetupGuide url={url} />
        </CardContent>
      </Card>
    </div>
  )
}
