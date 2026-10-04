"use client"

import * as React from "react"
import {
  ArrowRight01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

import { useCopy } from "./use-copy"

export interface JsonViewerProps {
  /** any JSON-serialisable value (already redacted server-side) */
  data: unknown
  /** caption shown in the toolbar, e.g. "Request" */
  label?: string
  /** levels expanded initially (default 1) */
  defaultExpandDepth?: number
  /** CSS max-height of the scroll area (default 24rem) */
  maxHeight?: string
  className?: string
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? String(data)
  } catch {
    return String(data)
  }
}

/** Collapsible JSON tree (text rendered by React → always escaped), with copy + expand/collapse all. */
export function JsonViewer({
  data,
  label,
  defaultExpandDepth = 1,
  maxHeight = "24rem",
  className,
}: JsonViewerProps) {
  const [depth, setDepth] = React.useState(defaultExpandDepth)
  const [generation, setGeneration] = React.useState(0)
  const { copied, copy } = useCopy()
  const setAll = (d: number) => {
    setDepth(d)
    setGeneration((g) => g + 1)
  }
  return (
    <div
      // shrink-0: inside a scrolling flex column (e.g. log detail sheet) an overflow-hidden child would
      // otherwise be squeezed to its border instead of making the column scroll
      className={cn(
        "shrink-0 overflow-hidden rounded-xl border bg-muted/40",
        className
      )}
    >
      {/* short label + actions share one row; a label too long for the row takes it and the actions wrap below */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-card/60 px-3 py-1.5">
        <span className="min-w-0 flex-auto text-xs font-medium break-words text-muted-foreground">
          {label}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="pointer-coarse:h-9"
            onClick={() => setAll(Number.POSITIVE_INFINITY)}
          >
            {common.json.expandAll}
          </Button>
          <Button variant="ghost" size="xs" className="pointer-coarse:h-9" onClick={() => setAll(0)}>
            {common.json.collapseAll}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pointer-coarse:size-9"
            aria-label={common.json.copy}
            title={common.json.copy}
            onClick={() => void copy(safeStringify(data))}
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              strokeWidth={2}
              aria-hidden
            />
          </Button>
        </div>
      </div>
      <div
        className="overflow-auto py-3 pr-3 pl-7 font-mono text-[13px] leading-5"
        style={{ maxHeight }}
      >
        <JsonNode
          key={generation}
          value={data as Json}
          depth={0}
          expandDepth={depth}
          isLast
        />
      </div>
    </div>
  )
}

function Primitive({ value }: { value: Json }) {
  if (value === null) return <span className="text-muted-foreground">null</span>
  switch (typeof value) {
    case "string":
      return (
        <span className="break-all whitespace-pre-wrap text-info-strong">
          &quot;{value}&quot;
        </span>
      )
    case "number":
      return (
        <span className="text-brand-ink tabular-nums">{String(value)}</span>
      )
    case "boolean":
      return <span className="text-warning-strong">{String(value)}</span>
    default:
      return <span className="text-muted-foreground">{String(value)}</span>
  }
}

function JsonNode({
  name,
  value,
  depth,
  expandDepth,
  isLast,
}: {
  name?: string
  value: Json
  depth: number
  expandDepth: number
  isLast: boolean
}) {
  const isArray = Array.isArray(value)
  const isObject = value !== null && typeof value === "object"
  const [open, setOpen] = React.useState(depth < expandDepth)
  const comma = isLast ? "" : ","
  const keyLabel =
    name !== undefined ? (
      <>
        <span className="text-foreground">&quot;{name}&quot;</span>
        <span className="text-muted-foreground">: </span>
      </>
    ) : null

  if (!isObject) {
    return (
      <div className="pl-4">
        {keyLabel}
        <Primitive value={value} />
        <span className="text-muted-foreground">{comma}</span>
      </div>
    )
  }

  const entries: [string, Json][] = isArray
    ? (value as Json[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>)
  const [openBr, closeBr] = isArray ? ["[", "]"] : ["{", "}"]
  if (entries.length === 0) {
    return (
      <div className="pl-4">
        {keyLabel}
        <span className="text-muted-foreground">
          {openBr}
          {closeBr}
          {comma}
        </span>
      </div>
    )
  }
  const summary = isArray
    ? common.json.items(entries.length)
    : common.json.keys(entries.length)
  return (
    <div className={cn(depth > 0 && "pl-4")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? common.json.collapse : common.json.expand}${name !== undefined ? ` ${name}` : ""}`}
        className="-ml-4 inline-flex items-start rounded-md text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span>
          {keyLabel}
          <span className="text-muted-foreground">{openBr}</span>
          {!open && (
            <span className="text-muted-foreground">
              {" "}
              … {closeBr}
              {comma}{" "}
              <span className="font-sans text-xs italic">{summary}</span>
            </span>
          )}
        </span>
      </button>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k}
              name={isArray ? undefined : k}
              value={v}
              depth={depth + 1}
              expandDepth={expandDepth}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="text-muted-foreground">
            {closeBr}
            {comma}
          </div>
        </>
      )}
    </div>
  )
}
