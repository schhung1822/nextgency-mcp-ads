import type { Metadata } from "next"
import Link from "next/link"
import { Home01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { StatusScreen } from "@/components/app/status-screen"
import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

export const metadata: Metadata = { title: common.notFound.metaTitle }

/** Root 404 (unmatched URLs and notFound() outside the dashboard). Rendered inside the root layout. */
export default function NotFound() {
  const s = common.notFound
  return (
    <StatusScreen
      code={s.code}
      title={s.title}
      description={s.description}
      actions={
        <Button variant="brand" asChild>
          <Link href="/">
            <HugeiconsIcon
              icon={Home01Icon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
            {s.home}
          </Link>
        </Button>
      }
    />
  )
}
