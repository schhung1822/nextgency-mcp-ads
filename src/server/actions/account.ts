"use server"
// Self-service account actions (/account, forced /security/* steps).
// Better Auth endpoints are called server-side with the request headers; activity_logs for 2FA and
// password events are written by the Better Auth hooks (src/server/auth/hooks.ts), not here.
// Server-side auth.api calls skip Better Auth's HTTP rate limit → every password (+TOTP) check goes through
// the shared re-auth gate first (src/server/auth/reauth.ts: per-user failure budget, failures logged).
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { account as tAccount } from "@/lib/i18n/vi/account"
import { auth as tAuth } from "@/lib/i18n/vi/auth"
import {
  changePasswordSchema,
  passwordConfirmSchema,
  profileSchema,
  zodFieldErrors,
} from "@/lib/schemas/auth"
import { reauthFieldsSchema } from "@/lib/schemas/reauth"
import { userIdSchema } from "@/lib/schemas/users"
import type { ActivityAction } from "@/server/audit/activity-log"
import { requestReauthVerifier, requireReauth } from "@/server/auth/reauth"
import { getAuth } from "@/server/auth/auth"
import { toUserMessage } from "@/server/auth/errors"
import { requireUserForAction, type AppSession } from "@/server/auth/session"
import { readTwoFactorPolicy, twoFactorRequiredFor } from "@/server/auth/two-factor-policy"
import * as usersService from "@/server/services/users"

const ACCOUNT_PATH = "/account"

/** Shared re-auth gate for the signed-in user's own password (+ TOTP unless `passwordOnly`). */
async function reauthSelf(
  s: AppSession,
  action: ActivityAction,
  fields: { password: string; code?: string },
  opts: { passwordOnly?: boolean } = {}
): Promise<void> {
  await requireReauth(
    { id: s.user.id, email: s.user.email, role: s.user.role },
    { action, target: { type: "user", id: s.user.id, label: s.user.email } },
    await requestReauthVerifier(s.user, fields, opts),
    { sessionId: s.sessionId }
  )
}

export async function updateProfileAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction()
    const parsed = profileSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    await usersService.updateOwnProfile(s, parsed.data)
    revalidatePath("/", "layout")
    return ok(undefined, tAccount.profile.savedToast)
  } catch (e) {
    return fail(toUserMessage(e, "account.profile"))
  }
}

/** Change own password (also the forced first-login step). Revokes other sessions; clears mustChangePassword. */
export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction({ allowPendingSetup: true })
    const parsed = changePasswordSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    await reauthSelf(s, "auth.password.change", { password: parsed.data.currentPassword }, { passwordOnly: true })
    await getAuth().api.changePassword({
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
    })
    // a stolen "trust this device" cookie must not keep skipping 2FA after the password changed (L2)
    await usersService.forgetTrustedDevices(s.user.id)
    if (s.user.mustChangePassword) await usersService.clearMustChangePassword(s.user.id)
    // No revalidatePath: the forced page would redirect mid-flight; clients navigate/refresh themselves.
    return ok(undefined, tAuth.changePassword.changedToast)
  } catch (e) {
    return fail(toUserMessage(e, "account.password"))
  }
}

export interface TwoFactorSetupData {
  totpURI: string
  /** base32 secret parsed from the URI, for manual entry */
  secret: string
  backupCodes: string[]
}

/** Step 1 of enrollment: verify password, create (unverified) TOTP secret + backup codes. */
export async function beginTwoFactorSetupAction(input: unknown): Promise<ActionResult<TwoFactorSetupData>> {
  try {
    const s = await requireUserForAction({ allowPendingSetup: true })
    if (s.user.mustChangePassword) return fail(tAuth.errors.FORBIDDEN)
    if (s.user.twoFactorEnabled) return fail(tAuth.errors.TOTP_ALREADY_ENABLED)
    const parsed = passwordConfirmSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    await reauthSelf(s, "auth.2fa.enable", parsed.data, { passwordOnly: true })
    const res = await getAuth().api.enableTwoFactor({
      body: { password: parsed.data.password },
      headers: await headers(),
    })
    if (!("totpURI" in res) || !res.totpURI || !res.backupCodes) return fail(tAuth.errors.GENERIC)
    const secret = new URL(res.totpURI).searchParams.get("secret") ?? ""
    return ok({ totpURI: res.totpURI, secret, backupCodes: res.backupCodes })
  } catch (e) {
    return fail(toUserMessage(e, "account.2fa.begin"))
  }
}

// Step 2 (first TOTP code) is verified by the client over HTTP: /api/auth/two-factor/verify-totp.
// A server action would set the rotated session cookie, which makes Next refresh the enrollment page and
// redirect away before the one-time backup codes are shown. The auth hooks log `auth.2fa.enable`.

export async function regenerateBackupCodesAction(input: unknown): Promise<ActionResult<{ backupCodes: string[] }>> {
  try {
    const s = await requireUserForAction()
    const parsed = reauthFieldsSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    // password + TOTP: new backup codes are a second factor on their own
    await reauthSelf(s, "auth.2fa.backup_codes.regenerate", parsed.data)
    const res = await getAuth().api.generateBackupCodes({
      body: { password: parsed.data.password },
      headers: await headers(),
    })
    return ok({ backupCodes: res.backupCodes }, tAccount.twoFactor.regenerateDone)
  } catch (e) {
    return fail(toUserMessage(e, "account.2fa.backup"))
  }
}

/**
 * 2FA is optional unless the policy (Cài đặt: require_2fa_admin / require_2fa_all) makes it mandatory for
 * the caller's role - admins included (owner decision 2026-10-02). The Better Auth before-hook enforces the
 * same rule.
 */
export async function disableTwoFactorAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction()
    if (twoFactorRequiredFor(s.user.role, await readTwoFactorPolicy())) {
      return fail(s.user.role === "admin" ? tAuth.errors.ADMIN_2FA_REQUIRED : tAuth.errors.TWO_FACTOR_REQUIRED)
    }
    const parsed = reauthFieldsSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    await reauthSelf(s, "auth.2fa.disable", parsed.data)
    await getAuth().api.disableTwoFactor({ body: { password: parsed.data.password }, headers: await headers() })
    revalidatePath(ACCOUNT_PATH)
    return ok(undefined, tAccount.twoFactor.disabledToast)
  } catch (e) {
    return fail(toUserMessage(e, "account.2fa.disable"))
  }
}

export async function revokeMySessionAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction()
    const parsed = userIdSchema.safeParse(input)
    if (!parsed.success) return fail(tAuth.errors.GENERIC)
    await usersService.revokeOwnSessions(s, { sessionId: parsed.data })
    revalidatePath(ACCOUNT_PATH)
    return ok(undefined, tAccount.sessions.revokedToast)
  } catch (e) {
    return fail(toUserMessage(e, "account.sessions"))
  }
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  try {
    const s = await requireUserForAction()
    await usersService.revokeOwnSessions(s, {})
    revalidatePath(ACCOUNT_PATH)
    return ok(undefined, tAccount.sessions.revokedOthersToast)
  } catch (e) {
    return fail(toUserMessage(e, "account.sessions"))
  }
}
