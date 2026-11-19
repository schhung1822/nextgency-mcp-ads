import {
  ArrowUpRight01Icon,
  InformationCircleIcon,
  RepeatIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { CodeSnippet } from "@/components/mcp/client-setup-guide"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { automation as t } from "@/lib/i18n/vi/automation"

const p = t.platforms
type ClientKey = keyof typeof p.clients
const ORDER: ClientKey[] = ["claude", "chatgpt", "gemini", "geminiCli"]

interface CodeSample {
  label: string
  code: string
}

/** Per-app steps to schedule the task (Claude / ChatGPT / Gemini / Gemini CLI). Static content - tabs are the only interaction. */
export function PlatformTabs() {
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-pretty">
        {p.intervalNote}
      </p>
      <Tabs defaultValue="claude" className="gap-4">
        <div className="-mx-1 [scrollbar-width:none] overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] px-1 pb-1 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden">
          <TabsList
            aria-label={p.tabsLabel}
            className="w-max max-sm:h-11! max-sm:pr-6"
          >
            {ORDER.map((k) => (
              <TabsTrigger key={k} value={k}>
                {p.clients[k].tab}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {ORDER.map((k) => {
          const c = p.clients[k]
          const code: readonly CodeSample[] = c.code
          return (
            <TabsContent key={k} value={k} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <h3 className="text-base font-semibold">{c.title}</h3>
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                  <span className="sr-only">{p.frequencyLabel}: </span>
                  <Badge variant="secondary" className="gap-1">
                    <HugeiconsIcon
                      icon={RepeatIcon}
                      strokeWidth={2}
                      className="size-3.5"
                      aria-hidden
                    />
                    {c.frequency}
                  </Badge>
                  <span className="text-pretty">{c.plans}</span>
                </p>
              </div>
              <ol aria-label={p.stepsLabel} className="flex flex-col gap-2.5">
                {c.steps.map((s, i) => (
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
              {code.length > 0 && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-medium">{p.codeLabel}</p>
                  {code.map((sample) => (
                    <div key={sample.label} className="flex flex-col gap-1.5">
                      <p className="text-[13px] text-muted-foreground">
                        {sample.label}
                      </p>
                      <CodeSnippet code={sample.code} label={sample.label} />
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-xl border border-dashed p-3">
                <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    strokeWidth={2}
                    className="size-4"
                    aria-hidden
                  />
                  {p.notesLabel}
                </p>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted-foreground">
                  {c.notes.map((n, i) => (
                    <li key={i} className="text-pretty">
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
              {c.links.length > 0 && (
                <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  {c.links.map((l) => (
                    <li key={l.url}>
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-sm font-medium text-brand-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:min-h-10 pointer-coarse:min-h-10"
                      >
                        {l.label}
                        <HugeiconsIcon
                          icon={ArrowUpRight01Icon}
                          strokeWidth={2}
                          className="size-3.5"
                          aria-hidden
                        />
                        <span className="sr-only">{p.newTab}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          )
        })}
      </Tabs>
    </div>
  )
}
