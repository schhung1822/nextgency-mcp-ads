import Link from "next/link"
import { Home01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { StatusScreen } from "@/components/app/status-screen"
import { Button } from "@/components/ui/button"
import { common } from "@/lib/i18n/vi/common"

/** notFound() inside the dashboard (e.g. an MCP/connection id that does not exist or is not yours). */
export default function DashboardNotFound() {
  const s = common.notFound
  return (
    <StatusScreen
      inline
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
