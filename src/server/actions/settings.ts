"use server"
// Admin settings: validate → write changed keys + one "settings.update" activity log in the same transaction.
import { revalidatePath } from "next/cache"
import { fail, ok, type ActionResult } from "@/lib/action-result"
import { settings as ts } from "@/lib/i18n/vi/settings"
import { settingsFormSchema, type SettingsFormValues } from "@/lib/schemas/settings"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { db } from "@/server/db/client"
import { getAllSettings, setSetting, type SettingKey } from "@/server/services/settings"

const KEYS = [
  "log_retention_months_mcp",
  "log_retention_months_staff",
  "require_2fa_admin",
  "require_2fa_all",
  "session_max_hours",
] as const satisfies readonly (keyof SettingsFormValues & SettingKey)[]

export async function updateSettingsAction(
  input: unknown
): Promise<ActionResult<{ changed: string[]; values: SettingsFormValues }>> {
  let session
  try {
    session = await requireUserForAction({ role: "admin" })
  } catch (e) {
    return fail(e instanceof AuthorizationError ? e.message : ts.saveFailed)
  }
  const parsed = settingsFormSchema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? "")
      if (k && !fieldErrors[k]) fieldErrors[k] = issue.message
    }
    return fail(ts.saveFailed, fieldErrors)
  }
  const next = parsed.data
  try {
    const before = await getAllSettings()
    const changed = KEYS.filter((k) => before[k] !== next[k])
    if (changed.length === 0) return ok({ changed: [], values: next }, ts.noChanges)

    await db.transaction(async (tx) => {
      for (const k of changed) {
        // per-key typed write (the union of SettingValue<K> is narrowed by the key)
        await setSetting(k, next[k] as never, session.user.id, tx)
      }
      await logActivity(
        {
          actor: actorOf(session.user),
          action: "settings.update",
          target: { type: "setting", id: changed.join(","), label: changed.join(", ") },
          metadata: {
            before: Object.fromEntries(changed.map((k) => [k, before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, next[k]])),
          },
        },
        tx
      )
    })
    revalidatePath("/settings")
    revalidatePath("/logs")
    return ok({ changed: [...changed], values: next }, ts.saved)
  } catch (e) {
    console.error("[settings action]", safeErrorForLog(e))
    return fail(ts.saveFailed)
  }
}
