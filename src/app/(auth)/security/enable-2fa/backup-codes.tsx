"use client"

import { Copy01Icon, Download01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { useCopy } from "@/components/app"
import { Button } from "@/components/ui/button"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { formatDateTime } from "@/lib/format"

const t = tAuth.enable2fa

/** 10 one-time backup codes, shown once, with copy-all and .txt download (generated client-side). */
export function BackupCodes({ codes, email }: { codes: string[]; email: string }) {
  const { copy } = useCopy({ toastMessage: t.copied })

  function download() {
    const content = [
      t.fileHeader,
      t.fileAccount(email),
      t.fileCreated(formatDateTime(new Date())),
      "",
      ...codes,
      "",
      t.fileNote,
      "",
    ].join("\r\n")
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = "ads-mcp-ma-du-phong.txt"
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="flex flex-col gap-3">
      <ol
        aria-label={t.backupTitle}
        className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-2xl border bg-card p-3 font-mono text-sm tabular-nums sm:gap-x-6 sm:p-4 sm:text-[15px]"
        data-testid="backup-codes"
      >
        {codes.map((c) => (
          <li key={c} className="rounded-lg px-1 py-1.5 text-center tracking-wide select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-10" onClick={() => void copy(codes.join("\n"))}>
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
          {t.copyAll}
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={download}>
          <HugeiconsIcon icon={Download01Icon} strokeWidth={2} aria-hidden />
          {t.download}
        </Button>
      </div>
    </div>
  )
}
