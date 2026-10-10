"use client"

import * as React from "react"
import { cn } from "cn"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { tips as t } from "@/lib/i18n/vi/tips"

/** localStorage key prefix of the ticks (per tip, per browser - a convenience only, nothing is sent anywhere) */
const STORAGE_PREFIX = "ads-mcp:tips-prepare:"

/** same-tab change notification (the "storage" event only fires in OTHER tabs) */
const CHANGE_EVENT = "ads-mcp:tips-prepare"

/** storage blocked (private mode, site data off): ticks still work for this page view */
const memory = new Map<string, string | null>()

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key)
  } catch {
    return memory.get(key) ?? null
  }
}

function parseTicks(raw: string | null, count: number): ReadonlySet<number> {
  if (!raw) return new Set()
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(
      arr.filter(
        (n): n is number => Number.isInteger(n) && n >= 0 && n < count
      )
    )
  } catch {
    return new Set()
  }
}

function writeTicks(key: string, ticks: ReadonlySet<number>) {
  const value =
    ticks.size === 0 ? null : JSON.stringify([...ticks].sort((x, y) => x - y))
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_PREFIX + key)
    else window.localStorage.setItem(STORAGE_PREFIX + key, value)
  } catch {
    // private mode / storage blocked: kept in memory only (lost on reload)
    memory.set(key, value)
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

/**
 * "Cần chuẩn bị": tickable checklist. Ticks are remembered per tip in this browser (localStorage through
 * useSyncExternalStore: the server render has no ticks, the client picks them up after hydration).
 */
export function PrepareChecklist({
  id: anchorId,
  storageKey,
  items,
}: {
  /** anchor of the "Trên trang này" strip */
  id?: string
  /** one key per tip, e.g. "bulk-ads" */
  storageKey: string
  items: readonly { title: string; detail: string }[]
}) {
  const id = React.useId()
  const raw = React.useSyncExternalStore(
    subscribe,
    () => readRaw(storageKey),
    () => null
  )
  const done = React.useMemo(
    () => parseTicks(raw, items.length),
    [raw, items.length]
  )

  const toggle = (i: number, on: boolean) => {
    const next = new Set(done)
    if (on) next.add(i)
    else next.delete(i)
    writeTicks(storageKey, next)
  }

  return (
    <Card id={anchorId} className={cn(anchorId && "scroll-mt-24")}>
      <CardHeader>
        <CardTitle>{t.shared.prepareTitle}</CardTitle>
        <CardDescription>{t.shared.prepareDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {items.map((item, i) => {
            const checked = done.has(i)
            return (
              <li key={item.title}>
                <label
                  htmlFor={`${id}-${i}`}
                  className={cn(
                    "flex h-full cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-colors",
                    "hover:bg-muted/60 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                    checked && "border-success/40 bg-success/5"
                  )}
                >
                  <Checkbox
                    id={`${id}-${i}`}
                    checked={checked}
                    onCheckedChange={(v) => toggle(i, v === true)}
                    className="mt-0.5"
                  />
                  <span className="grid content-start gap-0.5">
                    <span
                      className={cn(
                        "text-sm leading-5 font-medium",
                        checked && "text-muted-foreground line-through"
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
