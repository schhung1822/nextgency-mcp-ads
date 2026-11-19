import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Notification03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { AppShell } from "@/components/app"
import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

import { DemoGallery } from "./demo-gallery"

export const metadata: Metadata = { title: "Thư viện giao diện" }

// Dev-only component gallery. Never available in production builds.
export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound()

  async function demoSignOut() {
    "use server"
    // no-op in the gallery - the auth feature wires the real sign-out action
  }

  return (
    <AppShell
      user={{ name: "Giáp Đức Thắng", email: "admin@nextgency.vn", role: "admin" }}
      signOutAction={demoSignOut}
      commandGroups={[
        {
          heading: "MCP",
          items: [
            {
              label: "Báo cáo hằng ngày",
              href: "/mcp-servers/demo-1",
              hint: "Meta, TikTok, Google Ads, OpenAI Ads",
            },
            {
              label: "Vận hành Meta",
              href: "/mcp-servers/demo-2",
              hint: "Meta",
            },
          ],
        },
      ]}
      topBarExtra={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={common.notifications.label}
          className="relative"
        >
          <HugeiconsIcon
            icon={Notification03Icon}
            strokeWidth={2}
            aria-hidden
          />
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand-primary ring-2 ring-background"
          />
        </Button>
      }
    >
      <DemoGallery />
    </AppShell>
  )
}
