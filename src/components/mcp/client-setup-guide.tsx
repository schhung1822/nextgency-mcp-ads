"use client"

import * as React from "react"
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  InformationCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { useCopy } from "@/components/app"
import { UrlCopyBox } from "@/components/mcp/url-copy-box"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { common } from "@/lib/i18n/vi/common"
import { mcp as t } from "@/lib/i18n/vi/mcp"

const g = t.guide

export type ClientKey =
  | "claude"
  | "chatgpt"
  | "geminiCli"
  | "geminiEnterprise"
  | "claudeCode"
  | "geminiApp"

const CLIENT_ORDER: ClientKey[] = [
  "claude",
  "chatgpt",
  "geminiCli",
  "geminiEnterprise",
  "claudeCode",
  "geminiApp",
]

export function claudeCodeCommand(url: string) {
  return `claude mcp add --transport http ${g.serverName} ${url} --scope user`
}

export function geminiCliSnippet(url: string) {
  return JSON.stringify(
    { mcpServers: { adsnextgency: { httpUrl: url, timeout: 120000 } } },
    null,
    2
  )
}

/** Preview height of a `collapsible` snippet (max-h-80): taller code gets an inner scroll + "Xem toàn bộ". */
const COLLAPSED_MAX_PX = 320

/** Multi-line code block with a copy button (commands / JSON). */
export function CodeSnippet({
  code,
  label,
  copyable = true,
  className,
  collapsible = false,
  copyLabel,
  disabledReason,
}: {
  code: string
  label: string
  /** false for masked URLs (nothing useful to copy) */
  copyable?: boolean
  className?: string
  /**
   * Long texts (prompts, SKILL.md): cap the preview at 20rem with its own scroll and a "Xem toàn bộ / Thu gọn"
   * toggle; on phones the copy button sits ABOVE the block, full width and 40px tall, so it is reachable without
   * scrolling past the text. Off by default (other callers keep the compact block).
   */
  collapsible?: boolean
  /** visible text of the copy button (default "Sao chép") */
  copyLabel?: string
  /** set while the text cannot be used yet (form errors): copy buttons disabled + this reason shown */
  disabledReason?: string | null
}) {
  const { copied, copy } = useCopy()
  const reasonId = React.useId()
  const preRef = React.useRef<HTMLPreElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [tall, setTall] = React.useState(false)
  const blocked = !!disabledReason
  const buttonText = copied ? common.copied : (copyLabel ?? g.copySnippet)

  React.useEffect(() => {
    const pre = preRef.current
    if (!collapsible || !pre) return
    const measure = () => setTall(pre.scrollHeight > COLLAPSED_MAX_PX + 2)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(pre)
    return () => ro.disconnect()
  }, [collapsible, code])

  const copyIcon = (
    <HugeiconsIcon
      icon={copied ? Tick02Icon : Copy01Icon}
      strokeWidth={2}
      className={cn("size-4", copied && "text-success")}
      aria-hidden
    />
  )

  if (!collapsible)
    return (
      <div
        className={cn(
          "relative rounded-xl border bg-muted/50 text-[13px] leading-5",
          className
        )}
      >
        <pre
          aria-label={label}
          className={cn(
            "overflow-x-auto p-3 font-mono break-all whitespace-pre-wrap",
            copyable && "sm:pr-28"
          )}
        >
          <code>{code}</code>
        </pre>
        {copyable && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mx-3 mb-3 w-[calc(100%-1.5rem)] sm:absolute sm:top-2 sm:right-2 sm:m-0 sm:w-auto"
            onClick={() => void copy(code)}
            aria-label={`${g.copySnippet}: ${label}`}
          >
            {copyIcon}
            <span>{copied ? common.copied : g.copySnippet}</span>
          </Button>
        )}
      </div>
    )

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {blocked && (
        <p
          id={reasonId}
          role="status"
          className="text-[13px] text-pretty text-destructive"
        >
          {disabledReason}
        </p>
      )}
      {copyable && (
        // phones: big copy button above the text (the text can be thousands of pixels tall)
        <Button
          type="button"
          variant="secondary"
          className="h-10 w-full sm:hidden"
          onClick={() => void copy(code)}
          disabled={blocked}
          aria-describedby={blocked ? reasonId : undefined}
          aria-label={`${copyLabel ?? g.copySnippet}: ${label}`}
        >
          {copyIcon}
          <span>{buttonText}</span>
        </Button>
      )}
      <div
        className={cn(
          "relative rounded-xl border bg-muted/50 text-[13px] leading-5",
          blocked && "opacity-60"
        )}
      >
        <pre
          ref={preRef}
          aria-label={label}
          tabIndex={tall && !expanded ? 0 : undefined}
          className={cn(
            "overflow-x-auto p-3 font-mono break-all whitespace-pre-wrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-xl",
            copyable && "sm:pr-44",
            !expanded && "max-h-80 overflow-y-auto overscroll-contain"
          )}
        >
          <code>{code}</code>
        </pre>
        {copyable && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute top-2 right-2 max-sm:hidden"
            onClick={() => void copy(code)}
            disabled={blocked}
            aria-describedby={blocked ? reasonId : undefined}
            aria-label={`${copyLabel ?? g.copySnippet}: ${label}`}
          >
            {copyIcon}
            <span>{buttonText}</span>
          </Button>
        )}
      </div>
      {tall && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start max-sm:h-10"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <HugeiconsIcon
            icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
            strokeWidth={2}
            data-icon="inline-start"
            aria-hidden
          />
          {expanded ? g.collapseSnippet : g.expandSnippet}
        </Button>
      )}
    </div>
  )
}

function Steps({ steps }: { steps: readonly string[] }) {
  return (
    <ol aria-label={g.stepsLabel} className="flex flex-col gap-2.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span
            aria-hidden
            className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-ink tabular-nums"
          >
            {i + 1}
          </span>
          <span className="pt-0.5 text-pretty">{s}</span>
        </li>
      ))}
    </ol>
  )
}

function Notes({ notes }: { notes: readonly string[] }) {
  return (
    <div className="rounded-xl border border-dashed p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <HugeiconsIcon
          icon={InformationCircleIcon}
          strokeWidth={2}
          className="size-4"
          aria-hidden
        />
        {g.notesLabel}
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted-foreground">
        {notes.map((n, i) => (
          <li key={i} className="text-pretty">
            {n}
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface ClientSetupGuideProps {
  /** full MCP URL, or a masked one (then `masked` = true: snippets are shown but not meant to be copied) */
  url: string
  masked?: boolean
  defaultClient?: ClientKey
  className?: string
}

/** Step-by-step setup for Claude / ChatGPT / Gemini CLI / Gemini Enterprise / Claude Code / Gemini app. */
export function ClientSetupGuide({
  url,
  masked,
  defaultClient = "claude",
  className,
}: ClientSetupGuideProps) {
  const c = g.clients
  const urlField = masked ? null : (
    <UrlCopyBox value={url} label={t.success.urlLabel} />
  )
  return (
    <Tabs defaultValue={defaultClient} className={cn("gap-4", className)}>
      <div className="-mx-1 [scrollbar-width:none] overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] px-1 pb-1 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden">
        <TabsList
          aria-label={g.tabsLabel}
          className="w-max max-sm:h-11! max-sm:pr-6"
        >
          {CLIENT_ORDER.map((k) => (
            <TabsTrigger key={k} value={k}>
              {c[k].tab}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="claude" className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{c.claude.title}</h3>
        <Steps steps={c.claude.steps} />
        {urlField}
        <Notes notes={c.claude.notes} />
      </TabsContent>

      <TabsContent value="chatgpt" className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{c.chatgpt.title}</h3>
        <Steps steps={c.chatgpt.steps} />
        {urlField}
        <Notes notes={c.chatgpt.notes} />
      </TabsContent>

      <TabsContent value="geminiCli" className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{c.geminiCli.title}</h3>
        <Steps steps={c.geminiCli.steps} />
        <CodeSnippet
          code={geminiCliSnippet(url)}
          label="~/.gemini/settings.json"
          copyable={!masked}
        />
        <Notes notes={c.geminiCli.notes} />
      </TabsContent>

      <TabsContent value="geminiEnterprise" className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{c.geminiEnterprise.title}</h3>
        <Steps steps={c.geminiEnterprise.steps} />
        {urlField}
        <Notes notes={c.geminiEnterprise.notes} />
      </TabsContent>

      <TabsContent value="claudeCode" className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{c.claudeCode.title}</h3>
        <Steps steps={c.claudeCode.steps} />
        <CodeSnippet
          code={claudeCodeCommand(url)}
          label={g.copyCommand}
          copyable={!masked}
        />
        <Notes notes={c.claudeCode.notes} />
      </TabsContent>

      <TabsContent value="geminiApp" className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{c.geminiApp.title}</h3>
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
          <AlertTitle>{c.geminiApp.unsupportedTitle}</AlertTitle>
          <AlertDescription>{c.geminiApp.unsupported}</AlertDescription>
        </Alert>
      </TabsContent>
    </Tabs>
  )
}
