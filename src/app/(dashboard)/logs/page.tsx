import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { logs as tl } from "@/lib/i18n/vi/logs"
import { logQueryToSearchParams, parseLogQuery } from "@/lib/schemas/logs"
import { requireUser } from "@/server/auth/session"
import {
  activityFiltersFromQuery,
  getLogFilterOptions,
  listActivityLogs,
  listMcpLogs,
  mcpFiltersFromQuery,
} from "@/server/services/logs"
import { getAllSettings } from "@/server/services/settings"

import { ExportCsvButton } from "./_components/export-button"
import { LogsView } from "./_components/logs-view"

export const metadata: Metadata = { title: tl.title }

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user } = await requireUser()
  const isAdmin = user.role === "admin"
  let query = parseLogQuery(await searchParams)
  // staff never see the staff tab (server-side, not just hidden)
  if (query.tab === "staff" && !isAdmin) query = { ...query, tab: "mcp" }

  const [settings, options, mcpPage, staffPage] = await Promise.all([
    getAllSettings(),
    getLogFilterOptions(user),
    query.tab === "mcp" ? listMcpLogs(user, mcpFiltersFromQuery(query)) : Promise.resolve(null),
    query.tab === "staff" ? listActivityLogs(user, activityFiltersFromQuery(query)) : Promise.resolve(null),
  ])

  const search = logQueryToSearchParams(query).toString()
  const mcpMonths = settings.log_retention_months_mcp
  const staffMonths = settings.log_retention_months_staff
  const description =
    !isAdmin || mcpMonths === staffMonths ? tl.description(mcpMonths) : tl.descriptionSplit(mcpMonths, staffMonths)

  return (
    <div className="flex w-full flex-col">
      <PageHeader
        title={tl.title}
        description={description}
        primaryAction={<ExportCsvButton search={search} twoFactorEnabled={user.twoFactorEnabled} />}
      />
      <LogsView isAdmin={isAdmin} query={query} mcpPage={mcpPage} staffPage={staffPage} options={options} />
    </div>
  )
}
