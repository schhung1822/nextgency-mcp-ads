"use server"
// "Miễn trừ trách nhiệm" popup: record that the signed-in user read and accepted the current version of a text.
// Thin: requireUserForAction → zod → per-user throttle → service (activity_logs `legal.disclaimer_accept`).
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { acceptDisclaimerSchema } from "@/lib/disclaimers"
import { disclaimers as t } from "@/lib/i18n/vi/disclaimers"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import {
  acceptDisclaimer,
  DisclaimerError,
} from "@/server/services/disclaimers"

/** The popup shows once per user, kind and version; 30 confirmations / 10 min / user is far above honest use. */
const ACCEPT_QUOTA = {
  scope: "disclaimer-accept",
  max: 30,
  windowMs: 10 * 60_000,
}

function zodFail(error: z.ZodError): ActionResult<never> {
  return fail(error.issues[0] ? t.errors.invalid : t.errors.generic)
}

export async function acceptDisclaimerAction(
  input: unknown
): Promise<
  ActionResult<{ kind: string; version: string; acceptedAt: string }>
> {
  try {
    const session = await requireUserForAction()
    const parsed = acceptDisclaimerSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const q = await consumeQuota(
      ACCEPT_QUOTA.scope,
      session.user.id,
      ACCEPT_QUOTA.max,
      ACCEPT_QUOTA.windowMs
    )
    if (!q.allowed) return fail(t.errors.throttled)
    return ok(await acceptDisclaimer(session.user, parsed.data))
  } catch (e) {
    if (e instanceof AuthorizationError || e instanceof DisclaimerError)
      return fail(e.message)
    console.error("[actions/legal]", safeErrorForLog(e))
    return fail(t.errors.generic)
  }
}
