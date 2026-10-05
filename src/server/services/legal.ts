// Public legal pages (/privacy, /terms, /data-deletion): operator info + log retention for the texts.
// PUBLIC on purpose (no session; Meta's crawler reads these pages) - returns only what the pages print: the
// operator name/contact set by an admin, the public domain/URL and the retention months. Never throws: the pages
// must render even when the database is unreachable (fallbacks: domain, "the system administrator", env default).
import "server-only"
import { resolveLegalInfo, type LegalInfo } from "@/lib/legal"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { env } from "@/server/env"
import { getAllSettings } from "@/server/services/settings"

function envUrls(): {
  appDomain: string | null
  appUrl: string | null
  defaultRetention: number
} {
  try {
    const e = env()
    return {
      appDomain: e.APP_DOMAIN,
      appUrl: e.BETTER_AUTH_URL,
      defaultRetention: e.LOG_RETENTION_MONTHS,
    }
  } catch {
    // invalid env (only possible outside production, which validates at startup): read the raw values
    return {
      appDomain: process.env.APP_DOMAIN ?? null,
      appUrl: process.env.BETTER_AUTH_URL ?? null,
      defaultRetention: Number(process.env.LOG_RETENTION_MONTHS ?? 3),
    }
  }
}

export async function getPublicLegalInfo(): Promise<LegalInfo> {
  const { appDomain, appUrl, defaultRetention } = envUrls()
  let settings: Awaited<ReturnType<typeof getAllSettings>> | null = null
  try {
    settings = await getAllSettings()
  } catch (e) {
    console.error("[legal] settings unavailable", safeErrorForLog(e))
  }
  return resolveLegalInfo({
    orgName: settings?.legal_org_name,
    contactEmail: settings?.legal_contact_email,
    appDomain,
    appUrl,
    retentionMcpMonths: settings?.log_retention_months_mcp,
    retentionStaffMonths: settings?.log_retention_months_staff,
    defaultRetentionMonths: defaultRetention,
  })
}
