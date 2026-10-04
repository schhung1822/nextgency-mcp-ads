"use client"

import * as React from "react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { useCopy } from "@/components/app"
import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

/**
 * A long MCP URL, shown in full: a read-only, auto-growing textarea (so a real textbox that wraps the
 * monospace text - never clipped, never a horizontal scroll) and a copy button that is always visible:
 * beside the text on wide screens, full width under it on phones.
 */
export function UrlCopyBox({
  value,
  label,
  className,
}: {
  value: string
  /** accessible name of the URL textbox and the copy button */
  label: string
  className?: string
}) {
  const { copied, copy } = useCopy()
  const ref = React.useRef<HTMLTextAreaElement>(null)

  // grow the textarea to its content (re-measured when the width changes)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = "auto"
      el.style.height = `${el.scrollHeight}px`
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [value])

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-start",
        className
      )}
    >
      <textarea
        ref={ref}
        readOnly
        rows={1}
        value={value}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => e.currentTarget.select()}
        className="block w-full min-w-0 resize-none overflow-hidden rounded-md bg-transparent px-1 py-1 font-mono text-[13px] leading-5 break-all text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:flex-1"
      />
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full shrink-0 sm:w-auto"
        onClick={() => void copy(value)}
        aria-label={`${common.copy}: ${label}`}
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={2}
          className={cn(copied && "text-success")}
          aria-hidden
        />
        {copied ? common.copied : common.copy}
      </Button>
    </div>
  )
}
