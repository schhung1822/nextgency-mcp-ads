"use client"

// "Xuất CSV": POST /api/logs/export (same-origin, fresh session or re-auth, per-user quota), then save the
// streamed CSV as a file. When the session is not fresh the server answers `reauth_required` → ask for the
// password (+ TOTP) and retry; a successful re-auth keeps the session fresh for 10 minutes.
import * as React from "react"
import { Download01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import { ReauthDialog } from "@/components/app"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { fail, ok, type ActionResult } from "@/lib/action-result"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { logs as tl } from "@/lib/i18n/vi/logs"

const REAUTH_REQUIRED = "reauth_required"

function fileNameFrom(disposition: string | null): string {
  const star = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (star) {
    try {
      return decodeURIComponent(star)
    } catch {
      /* fall through */
    }
  }
  return disposition?.match(/filename="([^"]+)"/i)?.[1] ?? "nhat-ky.csv"
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function requestExport(search: string, fields?: { password: string; code?: string }): Promise<ActionResult> {
  let res: Response
  try {
    res = await fetch("/api/logs/export", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search, ...(fields ?? {}) }),
    })
  } catch {
    return fail(tAuth.errors.NETWORK)
  }
  if (res.ok) {
    saveBlob(await res.blob(), fileNameFrom(res.headers.get("content-disposition")))
    return ok(undefined, tl.exportDone)
  }
  const data = (await res.json().catch(() => null)) as { error?: string; code?: string; fieldErrors?: Record<string, string> } | null
  if (data?.code === REAUTH_REQUIRED) return fail(data.error ?? tl.errors.exportFailed, { [REAUTH_REQUIRED]: "1" })
  return fail(data?.error ?? tl.errors.exportFailed, data?.fieldErrors)
}

export function ExportCsvButton({ search, twoFactorEnabled }: { search: string; twoFactorEnabled: boolean }) {
  const [busy, setBusy] = React.useState(false)
  const [reauthOpen, setReauthOpen] = React.useState(false)

  async function onClick() {
    setBusy(true)
    try {
      const r = await requestExport(search)
      if (r.ok) toast.success(r.message ?? tl.exportDone)
      else if (r.fieldErrors?.[REAUTH_REQUIRED]) setReauthOpen(true)
      else toast.error(r.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="brand" onClick={() => void onClick()} disabled={busy} title={tl.exportHint}>
        {busy ? (
          <Spinner aria-hidden data-icon="inline-start" />
        ) : (
          <HugeiconsIcon icon={Download01Icon} strokeWidth={2} data-icon="inline-start" aria-hidden />
        )}
        {busy ? tl.exporting : tl.exportCsv}
      </Button>
      <ReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        twoFactorEnabled={twoFactorEnabled}
        idPrefix="export"
        hint={null}
        texts={{ title: tl.exportReauthTitle, description: tl.exportReauthDescription, submit: tl.exportReauthSubmit }}
        onSubmit={(fields) => requestExport(search, fields)}
        onSuccess={(_, message) => toast.success(message ?? tl.exportDone)}
      />
    </>
  )
}
