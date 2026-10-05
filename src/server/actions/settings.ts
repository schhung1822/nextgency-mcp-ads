"use server"
// Admin settings: validate → write changed keys + one "settings.update" activity log in the same transaction.
// A change that RELAXES security (2FA requirement off, longer sessions, shorter log retention) also needs the
// admin's password (+ TOTP) through the shared re-auth gate - a hijacked admin session alone cannot weaken it.
import { revalidatePath } from "next/cache"
import { fail, ok, type ActionResult } from "@/lib/action-result"
import { settings as ts } from "@/lib/i18n/vi/settings"
import { REAUTH_REQUIRED_FIELD } from "@/lib/schemas/reauth"
import { isRelaxingSettingsChange, settingsUpdateSchema, type SettingsFormValues } from "@/lib/schemas/settings"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { REAUTH_MESSAGES, ReauthError, requestReauthVerifier, withReauth } from "@/server/auth/reauth"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { db, type Tx } from "@/server/db/client"
import { getAllSettings, setSetting, type SettingKey } from "@/server/services/settings"

const KEYS = [
  "log_retention_months_mcp",
  "log_retention_months_staff",
  "require_2fa_admin",
  "require_2fa_all",
  "session_max_hours",
  "legal_org_name",
  "legal_contact_email",
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
  const parsed = settingsUpdateSchema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? "")
      if (k && !fieldErrors[k]) fieldErrors[k] = issue.message
    }
    return fail(ts.saveFailed, fieldErrors)
  }
  const { reauth, ...next } = parsed.data
  try {
    const before = await getAllSettings()
    const changed = KEYS.filter((k) => before[k] !== next[k])
    if (changed.length === 0) return ok({ changed: [], values: next }, ts.noChanges)

    const write = async (tx: Tx) => {
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
    }
    if (isRelaxingSettingsChange(before, next)) {
      if (!reauth) return fail(REAUTH_MESSAGES.required, { [REAUTH_REQUIRED_FIELD]: "required" })
      const { user } = session
      const target = { type: "setting", id: changed.join(","), label: changed.join(", ") }
      await withReauth(
        { id: user.id, email: user.email, role: user.role },
        { action: "settings.update", target, metadata: { keys: changed } },
        await requestReauthVerifier(user, reauth),
        write,
        { sessionId: session.sessionId }
      )
    } else {
      await db.transaction(write)
    }
    revalidatePath("/settings")
    revalidatePath("/logs")
    if (changed.some((k) => k.startsWith("legal_"))) {
      revalidatePath("/privacy")
      revalidatePath("/terms")
      revalidatePath("/data-deletion")
    }
    return ok({ changed: [...changed], values: next }, ts.saved)
  } catch (e) {
    if (e instanceof ReauthError) return fail(e.message, e.fieldErrors)
    console.error("[settings action]", safeErrorForLog(e))
    return fail(ts.saveFailed)
  }
}
