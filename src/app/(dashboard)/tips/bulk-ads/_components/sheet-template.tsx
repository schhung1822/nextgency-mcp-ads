"use client"

import {
  Copy01Icon,
  Download01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"
import { toast } from "sonner"

import { useCopy } from "@/components/app/use-copy"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  BULK_SHEET_COLUMNS,
  BULK_SYSTEM_COLUMNS,
  BULK_TEMPLATE_FILE_NAME,
  buildSheetHeaderTsv,
  buildSheetTemplateCsv,
} from "@/lib/bulk-ads-prompt"
import { tips as t } from "@/lib/i18n/vi/tips"

const sh = t.bulk.sheet
const SYSTEM = new Set<string>(BULK_SYSTEM_COLUMNS)

function downloadTemplate() {
  const blob = new Blob([buildSheetTemplateCsv()], {
    type: "text/csv;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = BULK_TEMPLATE_FILE_NAME
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  toast.success(sh.downloaded)
}

/** header cell colours: columns you fill vs columns the system writes (legend uses the same classes) */
const YOU_CELL = "bg-brand-primary/8 ring-brand-primary/20"
const SYSTEM_CELL = "bg-card ring-foreground/10"

const WHO_LABEL = {
  you: sh.whoYou,
  system: sh.whoSystem,
  both: sh.whoBoth,
} as const

/** Recommended sheet: header row (copy as tab-separated cells), CSV template download, column + status meanings. */
export function SheetTemplate({ id }: { id?: string }) {
  const { copied, copy } = useCopy()

  return (
    <Card id={id} className={cn(id && "scroll-mt-24")}>
      <CardHeader>
        <CardTitle>{sh.title}</CardTitle>
        <CardDescription>{sh.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-3" aria-label={sh.headerLabel}>
          <p className="text-sm font-medium">{sh.headerLabel}</p>
          <ol className="flex flex-wrap gap-1.5 rounded-xl border bg-muted/50 p-3">
            {BULK_SHEET_COLUMNS.map((name, i) => (
              <li
                key={name}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-xs ring-1 ring-inset",
                  SYSTEM.has(name)
                    ? cn(SYSTEM_CELL, "text-muted-foreground")
                    : cn(YOU_CELL, "text-foreground")
                )}
              >
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {String.fromCharCode(65 + i)}
                </span>
                {name}
                <span className="sr-only">
                  {" "}
                  ({SYSTEM.has(name) ? sh.whoSystem : sh.whoYou})
                </span>
              </li>
            ))}
          </ol>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted-foreground">
            <span>{sh.legendLabel}</span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn("size-3.5 rounded ring-1 ring-inset", YOU_CELL)}
              />
              {sh.whoYou}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn("size-3.5 rounded ring-1 ring-inset", SYSTEM_CELL)}
              />
              {sh.whoSystem}
            </span>
          </p>
          <p className="text-[13px] text-pretty text-muted-foreground">
            {sh.headerHelp}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void copy(buildSheetHeaderTsv())}
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                className={cn(copied && "text-success")}
                aria-hidden
              />
              {sh.copyHeader}
            </Button>
            <Button type="button" variant="outline" onClick={downloadTemplate}>
              <HugeiconsIcon
                icon={Download01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {sh.download}
            </Button>
          </div>
          <p className="text-[13px] text-pretty text-muted-foreground">
            {sh.downloadHelp}
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{sh.columnsTitle}</h3>
          <ul
            aria-label={sh.columnsLabel}
            className="grid grid-cols-1 gap-2 xl:grid-cols-2"
          >
            {sh.columns.map((c) => {
              const who = c.who as keyof typeof WHO_LABEL
              return (
                <li
                  key={c.name}
                  className="flex flex-col gap-1.5 rounded-2xl border p-3"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">
                      {c.name}
                    </span>
                    <Badge
                      variant="outline"
                      // same tint as the header cells / legend above
                      className={cn(
                        "border-transparent text-foreground ring-1 ring-inset",
                        who === "system"
                          ? SYSTEM_CELL
                          : who === "you"
                            ? YOU_CELL
                            : "bg-muted ring-foreground/10"
                      )}
                    >
                      {WHO_LABEL[who]}
                    </Badge>
                    {"required" in c && c.required && (
                      <Badge
                        variant="secondary"
                        className="rounded-full bg-brand-primary/10 text-brand-ink"
                      >
                        {sh.required}
                      </Badge>
                    )}
                  </div>
                  <p className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                    {c.detail}
                  </p>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{sh.statusTitle}</h3>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sh.statuses.map((st) => (
              <li
                key={st.value}
                className="flex flex-col gap-1 rounded-2xl bg-muted/50 p-3"
              >
                <span className="text-sm font-medium">{st.value}</span>
                {st.aliases && (
                  <span className="text-[13px] text-pretty text-muted-foreground">
                    {sh.aliasesLabel} {st.aliases}
                  </span>
                )}
                <span className="text-[13px] leading-[18px] text-pretty">
                  {st.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </CardContent>
    </Card>
  )
}
