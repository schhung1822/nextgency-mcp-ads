"use client"

import * as React from "react"
import { toast } from "sonner"

import { PlatformIcon } from "@/components/app"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { tiktokSocialVi as t } from "@/lib/i18n/vi/tiktok-social"
import { startTiktokSocialConnectAction } from "@/server/actions/tiktok-social"

/** Explains the TikTok sign-in, then sends the browser to TikTok (the callback brings it back to the list). */
export function TiktokSocialConnectCard({ reconnectId, reconnectUsername }: { reconnectId?: string; reconnectUsername?: string }) {
  const [pending, setPending] = React.useState(false)
  const go = async () => {
    setPending(true)
    try {
      const res = await startTiktokSocialConnectAction(reconnectId ? { reconnectId } : {})
      if (!res.ok) {
        toast.error(res.error)
        setPending(false)
        return
      }
      window.location.assign(res.data.url)
    } catch {
      toast.error(t.errors.generic)
      setPending(false)
    }
  }
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlatformIcon platform="tiktok" />
          {reconnectUsername ? `${t.reconnect} @${reconnectUsername}` : t.connectButton}
        </CardTitle>
        <CardDescription>{t.pageDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          {t.howItWorks.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {reconnectUsername && <li>{`Hãy đăng nhập đúng tài khoản @${reconnectUsername} (đăng xuất TikTok trên trình duyệt nếu đang ở tài khoản khác).`}</li>}
        </ul>
      </CardContent>
      <CardFooter>
        <Button variant="brand" onClick={() => void go()} disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          {reconnectUsername ? t.reconnect : t.connectButton}
        </Button>
      </CardFooter>
    </Card>
  )
}
