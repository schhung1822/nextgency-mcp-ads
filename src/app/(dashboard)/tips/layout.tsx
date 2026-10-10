import Link from "next/link"
import { Add01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PageHeader } from "@/components/app"
import { Button } from "@/components/ui/button"
import { tips as t } from "@/lib/i18n/vi/tips"
import { requireUser } from "@/server/auth/session"

import { TipsNav } from "./_components/tips-nav"

/**
 * "Mẹo sử dụng" (every role, static how-tos): shared title + sub-menu; each tip is a page under /tips/<slug> with its
 * own metadata title and guide. /tips and the old /automation-tips redirect to /tips/automation (next.config.ts).
 * The header + menu stay while loading.tsx streams the next tip.
 */
export default async function TipsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireUser()

  return (
    <div className="flex w-full flex-col">
      <PageHeader
        title={t.title}
        description={t.description}
        primaryAction={
          <Button variant="brand" asChild>
            <Link href="/mcp-servers/new">
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {t.createMcp}
            </Link>
          </Button>
        }
      />
      <TipsNav />
      {children}
    </div>
  )
}
