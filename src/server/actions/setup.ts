"use server"
import { readTwoFactorPolicy, twoFactorRequiredFor } from "@/server/auth/two-factor-policy"
// First-run /setup: create the first admin (SETUP_TOKEN + empty DB), sign in, then the client navigates
// to the forced 2FA enrollment (`data.next`).
// L6: attempts that reach the SETUP_TOKEN check are throttled per client IP (10 / 15 min, stored in DB).
import { headers } from "next/headers"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { setupSchema, zodFieldErrors } from "@/lib/schemas/auth"
import { metaFromHeaders } from "@/server/audit/activity-log"
import { getAuth } from "@/server/auth/auth"
import { toUserMessage } from "@/server/auth/errors"
import { ROUTES } from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import { countUsers, createFirstAdmin } from "@/server/services/users"

const SETUP_ATTEMPTS_MAX = 10
const SETUP_ATTEMPTS_WINDOW_MS = 15 * 60_000

export async function setupFirstAdminAction(input: unknown): Promise<ActionResult<{ next: string }>> {
  const parsed = setupSchema.safeParse(input)
  if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
  const { name, email, password, setupToken } = parsed.data
  try {
    const h = await headers()
    // once a user exists /setup is closed anyway: no need to count (and no DB writes for scanners)
    if ((await countUsers()) > 0) return fail(tAuth.errors.SETUP_ALREADY_DONE)
    const ip = metaFromHeaders(h).ip ?? "unknown"
    const quota = await consumeQuota("setup-token", ip, SETUP_ATTEMPTS_MAX, SETUP_ATTEMPTS_WINDOW_MS)
    if (!quota.allowed) return fail(tAuth.errors.SETUP_TOO_MANY)
    await createFirstAdmin({ name, email, password, setupToken })
    await getAuth().api.signInEmail({ body: { email, password }, headers: h })
    const policy = await readTwoFactorPolicy()
    return ok({ next: twoFactorRequiredFor("admin", policy) ? ROUTES.enable2fa : "/" })
  } catch (e) {
    return fail(toUserMessage(e, "setup"))
  }
}
