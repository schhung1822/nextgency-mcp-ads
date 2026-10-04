"use client"

import * as React from "react"
import { toast } from "sonner"

import { common } from "@/lib/i18n/vi/common"

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Fallback for non-secure contexts (http on LAN).
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand("copy")
  document.body.removeChild(ta)
  if (!ok) throw new Error("copy failed")
}

/** Copies text, shows the "Đã sao chép" toast and exposes a short-lived `copied` flag. */
export function useCopy(options?: {
  toastMessage?: string | false
  resetMs?: number
}) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const toastMessage = options?.toastMessage ?? common.copied
  const resetMs = options?.resetMs ?? 1500

  React.useEffect(() => () => clearTimeout(timer.current), [])

  const copy = React.useCallback(
    async (text: string) => {
      try {
        await writeClipboard(text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), resetMs)
        if (toastMessage) toast.success(toastMessage)
        return true
      } catch {
        toast.error(common.copyFailed)
        return false
      }
    },
    [resetMs, toastMessage]
  )

  return { copied, copy }
}
