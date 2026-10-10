"use client"

import { CodeSnippet } from "@/components/mcp/client-setup-guide"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { tips as t } from "@/lib/i18n/vi/tips"

const s = t.shared
/** long Vietnamese prompts: wrap between words, not in the middle of a word (CodeSnippet uses break-all) */
export const WRAP = "[&_pre]:break-normal [&_pre]:[overflow-wrap:anywhere]"

/**
 * Copy-paste outputs of a prompt builder: full prompt | SKILL.md + the short prompt that calls the skill.
 * Long texts are capped (own scroll + "Xem toàn bộ") with the copy button above them on phones; while the form has
 * errors every copy button is disabled with `blockedReason` (nothing built from a wrong value can be copied).
 */
export function PromptOutputs({
  prompt,
  promptHelp,
  promptLabel,
  skillName,
  skillMd,
  skillPrompt,
  extra,
  blockedReason,
  labels,
}: {
  prompt: string
  promptHelp: string
  promptLabel: string
  skillName: string
  skillMd: string
  skillPrompt: string
  /** rendered under the full prompt (e.g. the scheduling sentence) */
  extra?: React.ReactNode
  /** form errors: copy disabled with this reason */
  blockedReason?: string | null
  /** texts of the automation tip (its own tab names / help); default: the shared ones */
  labels?: {
    promptTab: string
    skillTab: string
    skillHelp: string
    skillLabel: string
    skillShortTitle: string
    skillShortLabel: string
    outputsLabel: string
  }
}) {
  const l = labels ?? {
    promptTab: s.promptTab,
    skillTab: s.skillTab,
    skillHelp: s.skillHelp(skillName),
    skillLabel: s.skillLabel,
    skillShortTitle: s.skillShortTitle,
    skillShortLabel: s.skillShortLabel,
    outputsLabel: s.outputsLabel,
  }
  return (
    <Tabs defaultValue="prompt" className="gap-4">
      <div className="-mx-1 [scrollbar-width:none] overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] px-1 pb-1 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden">
        <TabsList
          aria-label={l.outputsLabel}
          className="w-max max-sm:h-11! max-sm:pr-6"
        >
          <TabsTrigger value="prompt">{l.promptTab}</TabsTrigger>
          <TabsTrigger value="skill">{l.skillTab}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="prompt" className="flex flex-col gap-3">
        <p className="text-[13px] text-pretty text-muted-foreground">
          {promptHelp}
        </p>
        <CodeSnippet
          className={WRAP}
          code={prompt}
          label={promptLabel}
          collapsible
          copyLabel={s.copyPrompt}
          disabledReason={blockedReason}
        />
        {extra}
      </TabsContent>
      <TabsContent value="skill" className="flex flex-col gap-3">
        <p className="text-[13px] text-pretty text-muted-foreground">
          {l.skillHelp}
        </p>
        <CodeSnippet
          className={WRAP}
          code={skillMd}
          label={l.skillLabel}
          collapsible
          copyLabel={s.copySkill}
          disabledReason={blockedReason}
        />
        <p className="pt-1 text-sm font-medium">{l.skillShortTitle}</p>
        <CodeSnippet
          className={WRAP}
          code={skillPrompt}
          label={l.skillShortLabel}
          collapsible
          copyLabel={s.copyShort}
          disabledReason={blockedReason}
        />
      </TabsContent>
    </Tabs>
  )
}
