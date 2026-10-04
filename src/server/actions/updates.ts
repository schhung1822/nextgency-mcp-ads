"use server"
// Admin-only server actions of the update system. Thin: requireUserForAction({ role: "admin" }) -> zod -> service
// (re-auth, target check, activity log in the same transaction). The container running this code has no Docker
// access: "Cập nhật" only enqueues a request for the separate `updater` service.
import { revalidatePath } from "next/cache"
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { updates as t } from "@/lib/i18n/vi/updates"
import { startUpdateSchema } from "@/lib/schemas/updates"
import type { UpdateStatus } from "@/lib/update-types"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { ReauthError, requestReauthVerifier } from "@/server/auth/reauth"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { checkForUpdatesNow, startUpdate, UpdateServiceError } from "@/server/services/updates"

function zodFail(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {}
  for (const i of error.issues) fieldErrors[i.path.join(".") || "_"] ??= i.message
  return fail(error.issues[0]?.message ?? t.errors.generic, fieldErrors)
}

function toFail(e: unknown, generic: string): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof ReauthError) return fail(e.message, e.fieldErrors)
  if (e instanceof UpdateServiceError) return fail(e.message)
  console.error("[actions/updates]", safeErrorForLog(e))
  return fail(generic)
}

/** "Kiểm tra ngay": ask GitHub for the newest release (admin). Returns the refreshed status + the check error, if any. */
export async function checkUpdatesAction(): Promise<ActionResult<{ status: UpdateStatus; error: string | null }>> {
  try {
    const session = await requireUserForAction({ role: "admin" })
    const r = await checkForUpdatesNow({ id: session.user.id, email: session.user.email, role: session.user.role })
    revalidatePath("/settings/updates")
    return ok(r)
  } catch (e) {
    return toFail(e, t.errors.checkGeneric)
  }
}

/** "Cập nhật lên vX": admin + password (+ TOTP) -> enqueue a pending request for the updater. */
export async function startUpdateAction(
  input: unknown
): Promise<ActionResult<{ id: string; fromVersion: string; targetVersion: string }>> {
  try {
    const session = await requireUserForAction({ role: "admin" })
    const parsed = startUpdateSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const { targetVersion, password, code } = parsed.data
    const verify = await requestReauthVerifier(session.user, { password, code })
    const r = await startUpdate(
      { id: session.user.id, email: session.user.email, role: session.user.role },
      { targetVersion },
      verify,
      { sessionId: session.sessionId }
    )
    revalidatePath("/settings/updates")
    revalidatePath("/logs")
    return ok(r, t.toast.started)
  } catch (e) {
    return toFail(e, t.errors.generic)
  }
}
