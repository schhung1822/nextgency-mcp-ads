"use client"

import * as React from "react"
import { ArrowDown01Icon, ArrowUp01Icon, ComputerIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { ConfirmDialog, RelativeTime } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { formatIp } from "@/lib/format-ip"
import { account as tAccount } from "@/lib/i18n/vi/account"

const t = tAccount.sessions

/** Sessions shown before "Hiện thêm" (the current device always comes first). */
const VISIBLE = 5

export interface AccountSession {
  id: string
  device: string
  ip: string | null
  createdAt: string
  lastActiveAt: string
  current: boolean
}

export function SessionsCard({
  sessions,
  revokeOne,
  revokeOthers,
}: {
  sessions: AccountSession[]
  revokeOne: (sessionId: unknown) => Promise<ActionResult>
  revokeOthers: () => Promise<ActionResult>
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const ordered = React.useMemo(
    () => [...sessions].sort((a, b) => Number(b.current) - Number(a.current)),
    [sessions]
  )
  const others = sessions.filter((s) => !s.current)
  const shown = expanded ? ordered : ordered.slice(0, VISIBLE)
  const hidden = ordered.length - shown.length

  async function run(id: string, fn: () => Promise<ActionResult>) {
    setBusy(id)
    try {
      const res = await fn()
      if (!res.ok) {
        toast.error(res.error)
        return false
      }
      toast.success(res.message)
      router.refresh()
      return true
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="divide-y">
          {shown.map((s) => {
            const mobile = /iOS|Android/.test(s.device)
            return (
              <li key={s.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <HugeiconsIcon icon={mobile ? SmartPhone01Icon : ComputerIcon} strokeWidth={1.75} className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm leading-5 font-medium">{s.device}</span>
                    {s.current && (
                      <Badge variant="secondary" className="rounded-full">
                        {t.current}
                      </Badge>
                    )}
                  </div>
                  <p className="text-[13px] leading-5 break-words text-muted-foreground">
                    <span className="font-mono">{formatIp(s.ip) ?? t.unknownIp}</span>
                    <span aria-hidden> · </span>
                    <RelativeTime value={s.lastActiveAt} />
                  </p>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    className="h-10 shrink-0 px-3"
                    disabled={busy !== null}
                    aria-label={t.revokeLabel(s.device)}
                    onClick={() => void run(s.id, () => revokeOne(s.id))}
                  >
                    {busy === s.id && <Spinner aria-hidden />}
                    {t.revoke}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>

        {ordered.length > VISIBLE && (
          <Button variant="ghost" className="h-10 self-center" onClick={() => setExpanded((v) => !v)}>
            <HugeiconsIcon icon={expanded ? ArrowUp01Icon : ArrowDown01Icon} strokeWidth={2} aria-hidden />
            {expanded ? t.showLess : t.showMore(hidden)}
          </Button>
        )}

        {others.length > 0 ? (
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-muted-foreground">{t.othersCount(others.length)}</p>
            <ConfirmDialog
              trigger={
                <Button variant="outline" className="h-10">
                  {t.revokeOthers}
                </Button>
              }
              title={t.revokeOthersTitle}
              description={t.revokeOthersDescription}
              confirmLabel={t.revokeOthers}
              onConfirm={() => run("others", revokeOthers)}
            />
          </div>
        ) : (
          <p className="border-t pt-4 text-[13px] text-muted-foreground">{t.empty}</p>
        )}
      </CardContent>
    </Card>
  )
}
