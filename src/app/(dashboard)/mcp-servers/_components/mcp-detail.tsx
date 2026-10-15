"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowRight01Icon,
  FileSearchIcon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PageGuide, PageHeader, StatusBadge } from "@/components/app"
import { ClientSetupGuide } from "@/components/mcp/client-setup-guide"
import { UrlCopyBox } from "@/components/mcp/url-copy-box"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDateTime } from "@/lib/format"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import type { McpApifyPoolSummary } from "@/lib/schemas/apify"
import type { McpDriveSourceOption } from "@/lib/schemas/drive"
import type { McpChannelOption } from "@/lib/schemas/notifications"
import type {
  McpDetail,
  SelectableConnection,
} from "@/server/services/mcp-servers"

import { ConfigTab, type UpdateMcpActionFn } from "./config-tab"
import { DETAIL_TABS, parseDetailTab, type DetailTab } from "./detail-tabs"
import { OverviewTab } from "./overview-tab"
import { RevealDialog, type RevealActionFn } from "./reveal-dialog"
import { SecurityTab, type SecurityActions } from "./security-tab"
import type { GmvMaxFormContext } from "./tiktok-gmv-max-section"

export interface McpDetailActions extends SecurityActions {
  update: UpdateMcpActionFn
  reveal: RevealActionFn
}

function ConnectTab({
  mcp,
  revealedUrl,
  onReveal,
  onHide,
}: {
  mcp: McpDetail
  revealedUrl: string | null
  onReveal: () => void
  onHide: () => void
}) {
  const c = t.connect
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{c.urlTitle}</CardTitle>
          <CardDescription>{c.urlDescription}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {revealedUrl ? (
            <>
              <UrlCopyBox value={revealedUrl} label={c.revealedLabel} />
              <Button
                variant="outline"
                size="lg"
                className="w-full sm:w-fit"
                onClick={onHide}
              >
                <HugeiconsIcon icon={ViewOffIcon} strokeWidth={2} aria-hidden />
                {c.hide}
              </Button>
            </>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                readOnly
                value={mcp.maskedUrl}
                aria-label={c.maskedLabel}
                className="h-10 min-w-0 flex-1 font-mono text-[13px]"
              />
              <Button
                variant="outline"
                size="lg"
                className="w-full shrink-0 sm:w-auto"
                onClick={onReveal}
              >
                <HugeiconsIcon icon={ViewIcon} strokeWidth={2} aria-hidden />
                {c.reveal}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{c.guideTitle}</CardTitle>
          <CardDescription>
            {revealedUrl
              ? c.guideDescription
              : `${c.guideDescription} ${c.guideMaskedNote}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClientSetupGuide
            url={revealedUrl ?? mcp.maskedUrl}
            masked={!revealedUrl}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function LogsTab({ mcp }: { mcp: McpDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.logs.title}</CardTitle>
        <CardDescription>{t.logs.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <Button variant="outline" asChild>
          <Link href={`/logs?tab=mcp&mcp=${mcp.id}`}>
            <HugeiconsIcon icon={FileSearchIcon} strokeWidth={2} aria-hidden />
            {t.logs.open}
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              aria-hidden
            />
          </Link>
        </Button>
        <p className="text-[13px] text-muted-foreground">{t.logs.staffNote}</p>
      </CardContent>
    </Card>
  )
}

export function McpDetailView({
  mcp,
  connections,
  channels,
  driveSources,
  drivePublicAvailable,
  accountNames,
  twoFactorEnabled,
  initialTab,
  actions,
  gmvMax,
  apifyPool = null,
}: {
  mcp: McpDetail
  connections: SelectableConnection[]
  /** Telegram channels the MCP owner can pick (config tab) */
  channels?: McpChannelOption[]
  /** Google Drive sources the MCP owner can pick (config tab) */
  driveSources?: McpDriveSourceOption[]
  /** a Drive API key is saved: public Drive links can be read */
  drivePublicAvailable?: boolean
  /** names of picked ad accounts that are switched off now (ad account id → name), for the config warning */
  accountNames?: Record<string, string>
  twoFactorEnabled: boolean
  initialTab: DetailTab
  actions: McpDetailActions
  /** viewer role + TikTok accounts with GMV Max (config tab: admin-only switch) */
  gmvMax?: GmvMaxFormContext
  /** Apify token pool of the MCP OWNER (config tab: Apify card) */
  apifyPool?: McpApifyPoolSummary | null
}) {
  const [tab, setTab] = React.useState<DetailTab>(initialTab)
  const [revealOpen, setRevealOpen] = React.useState(false)
  const [revealedUrl, setRevealedUrl] = React.useState<string | null>(null)
  // the config tab shows its own contextual save bar (with the page’s only brand button) while dirty
  const [configDirty, setConfigDirty] = React.useState(false)
  // bumped by the "set caps" action of the overview banner: the config tab scrolls to the caps section
  const [capsFocus, setCapsFocus] = React.useState(0)

  const changeTab = (v: string, focus?: "caps") => {
    const next = parseDetailTab(v)
    setTab(next)
    const url = new URL(window.location.href)
    if (next === "overview") url.searchParams.delete("tab")
    else url.searchParams.set("tab", next)
    if (next === "config" && focus) url.searchParams.set("focus", focus)
    else url.searchParams.delete("focus")
    window.history.replaceState(window.history.state, "", url)
  }

  const subtitle = [
    mcp.description,
    !mcp.isMine ? `${t.detail.ownerLabel}: ${mcp.ownerEmail}` : null,
    t.detail.createdAt(formatDateTime(mcp.createdAt)),
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="w-full">
      <PageGuide guide={tg.mcpDetail[tab]} />
      <PageHeader
        title={mcp.name}
        titleMeta={<StatusBadge kind="mcp" status={mcp.status} />}
        description={subtitle}
        backHref="/mcp-servers"
        primaryAction={
          <Button
            variant={configDirty && tab === "config" ? "outline" : "brand"}
            onClick={() =>
              revealedUrl ? changeTab("connect") : setRevealOpen(true)
            }
          >
            <HugeiconsIcon icon={ViewIcon} strokeWidth={2} aria-hidden />
            {t.connect.reveal}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={changeTab} className="gap-5">
        <div className="-mx-1 [scrollbar-width:none] overflow-x-auto px-1 pb-1 [&::-webkit-scrollbar]:hidden">
          <TabsList
            aria-label={t.detail.tabsLabel}
            className="w-full min-w-max max-sm:h-11! sm:w-max"
          >
            {DETAIL_TABS.map((k) => (
              <TabsTrigger
                key={k}
                value={k}
                className="px-1.5 text-[13px] sm:px-3 sm:text-sm"
              >
                {t.detail.tabs[k]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab
            mcp={mcp}
            connections={connections}
            apifyPool={apifyPool}
            onOpenConfig={() => {
              changeTab("config", "caps")
              setCapsFocus((n) => n + 1)
            }}
          />
        </TabsContent>
        {/* kept mounted (just hidden) so unsaved edits survive a switch to another tab */}
        <TabsContent
          value="config"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <ConfigTab
            key={mcp.updatedAt}
            mcp={mcp}
            connections={connections}
            channels={channels}
            driveSources={driveSources}
            drivePublicAvailable={drivePublicAvailable}
            accountNames={accountNames}
            updateAction={actions.update}
            twoFactorEnabled={twoFactorEnabled}
            onDirtyChange={setConfigDirty}
            capsFocusSignal={capsFocus}
            gmvMax={gmvMax}
            apifyPool={apifyPool}
          />
        </TabsContent>
        <TabsContent value="connect">
          <ConnectTab
            mcp={mcp}
            revealedUrl={revealedUrl}
            onReveal={() => setRevealOpen(true)}
            onHide={() => setRevealedUrl(null)}
          />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab mcp={mcp} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab
            mcp={mcp}
            actions={actions}
            twoFactorEnabled={twoFactorEnabled}
            onKeyRotated={(url) => setRevealedUrl(url)}
          />
        </TabsContent>
      </Tabs>
      <RevealDialog
        open={revealOpen}
        onOpenChange={setRevealOpen}
        mcpId={mcp.id}
        twoFactorEnabled={twoFactorEnabled}
        revealAction={actions.reveal}
        onRevealed={(url) => {
          setRevealedUrl(url)
          changeTab("connect")
        }}
      />
    </div>
  )
}
