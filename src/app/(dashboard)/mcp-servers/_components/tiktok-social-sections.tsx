"use client"

// TikTok Social block of the MCP form (17-tiktok-social.md §7, TSD3: a platform like Apify), shared by the create wizard
// and the config editor: platform card of step "Nền tảng & tài khoản" (pick the TikTok accounts the MCP may read) and
// the overview rows. Options come from the server for the MCP OWNER (staff: own accounts; admin: all) - never a token.
// The server re-checks every id on save.
import Link from "next/link"
import { Add01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { PlatformIcon } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { tiktokSocialVi as t } from "@/lib/i18n/vi/tiktok-social"
import type { McpFormValues, StepErrors } from "@/lib/schemas/mcp-servers"

import type { FormUpdater } from "./mcp-form-sections"

export const TIKTOK_SOCIAL_CARD_ID = "mcp-tiktok-social"

export interface TiktokSocialOption {
  id: string
  name: string
  username: string
  status: "active" | "expiring" | "invalid" | "disabled"
  isBusinessAccount: boolean | null
}

export function TiktokSocialPlatformCard({
  values,
  update,
  errors,
  options,
}: {
  values: McpFormValues
  update: FormUpdater
  errors: StepErrors
  /** accounts the MCP OWNER may pick */
  options: readonly TiktokSocialOption[]
}) {
  const selected = new Set(values.tiktokSocialAccountIds ?? [])
  const on = selected.size > 0
  const toggle = (id: string, checked: boolean) =>
    update((v) => {
      const cur = v.tiktokSocialAccountIds ?? []
      return {
        ...v,
        tiktokSocialAccountIds: checked ? [...new Set([...cur, id])] : cur.filter((x) => x !== id),
      }
    })
  return (
    <Card id={TIKTOK_SOCIAL_CARD_ID} className={cn("gap-0 py-0 transition-shadow", on && "ring-1 ring-brand-red/30")}>
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3 [.border-b]:pb-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <PlatformIcon platform="tiktok" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold">{t.mcp.cardTitle}</p>
          <p className="text-[13px] text-muted-foreground">{t.mcp.cardDescription}</p>
        </div>
        {on && <Badge variant="secondary">{t.mcp.summary(selected.size)}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 py-4">
        {options.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
            <p className="text-[13px] text-muted-foreground">{t.mcp.none}</p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/connections/tiktok-social/new">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                {t.connectButton}
              </Link>
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium">{t.mcp.pick}</p>
            <ul className="flex flex-col gap-2">
              {options.map((o) => {
                const id = `${TIKTOK_SOCIAL_CARD_ID}-${o.id}`
                const unusable = o.status === "disabled" || o.status === "invalid"
                return (
                  <li key={o.id} className="flex items-start gap-2.5">
                    <Checkbox
                      id={id}
                      checked={selected.has(o.id)}
                      // a disabled / invalid account cannot be newly picked (an already picked one can be removed)
                      disabled={unusable && !selected.has(o.id)}
                      onCheckedChange={(c) => toggle(o.id, c === true)}
                      className="mt-0.5"
                    />
                    <Label htmlFor={id} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
                      <span className="truncate font-medium">{o.name}</span>
                      <span className="text-xs text-muted-foreground">
                        @{o.username}
                        {o.isBusinessAccount === true ? ` · ${t.type.business}` : ""}
                        {unusable || o.status === "expiring" ? ` · ${t.status[o.status]}` : ""}
                      </span>
                    </Label>
                  </li>
                )
              })}
            </ul>
            {on && (
              <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
                <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t.mcp.permissionNote}
              </p>
            )}
          </>
        )}
        {errors.tiktokSocialAccountIds && <p className="text-[13px] text-destructive">{errors.tiktokSocialAccountIds}</p>}
      </CardContent>
    </Card>
  )
}

/** Overview rows: the TikTok accounts the MCP reads (from the MCP detail) */
export function TiktokSocialOverviewRow({ accounts }: { accounts: readonly { id: string; name: string; username: string; status: string }[] }) {
  if (!accounts.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-sm font-medium">
        <PlatformIcon platform="tiktok" />
        {t.mcp.cardTitle} · {t.mcp.summary(accounts.length)}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {accounts.map((a) => (
          <li key={a.id}>
            <Badge variant={a.status === "invalid" ? "destructive" : "outline"}>@{a.username}</Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}
