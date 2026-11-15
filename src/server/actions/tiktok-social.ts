"use server"
// Server actions for "Kết nối → TikTok Social" (17-tiktok-social.md §3, §7). Thin: requireUserForAction → zod →
// (connect: disclaimer + quota) → service → revalidatePath. "Kết nối" returns the TikTok authorize URL and stores the
// encrypted OAuth state (state + PKCE verifier + user) in an httpOnly cookie read by /api/tiktok-social/callback.
import { revalidatePath } from "next/cache"
import { cookies } from "next/headers"
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { tiktokSocialVi } from "@/lib/i18n/vi/tiktok-social"
import {
  deleteTiktokSocialSchema,
  renameTiktokSocialSchema,
  setTiktokSocialEnabledSchema,
  startTiktokSocialConnectSchema,
} from "@/lib/schemas/tiktok-social"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import { appBaseUrl } from "@/server/env"
import { checkDisclaimerAccepted } from "@/server/services/disclaimers"
import {
  beginTiktokSocialConnect,
  deleteTiktokSocialAccount,
  renameTiktokSocialAccount,
  setTiktokSocialAccountEnabled,
  TiktokSocialServiceError,
  tiktokSocialStateCookieName,
  TTS_STATE_TTL_MS,
} from "@/server/services/tiktok-social-accounts"

const e = tiktokSocialVi.errors
const LIST = "/connections/tiktok-social"

function zodFail(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {}
  for (const i of error.issues) fieldErrors[i.path.join(".") || "_"] ??= i.message
  return fail(error.issues[0]?.message ?? e.generic, fieldErrors)
}

function toFail(err: unknown): ActionResult<never> {
  if (err instanceof AuthorizationError) return fail(err.message)
  if (err instanceof TiktokSocialServiceError) return fail(err.message, err.fieldErrors)
  console.error("[actions/tiktok-social]", safeErrorForLog(err))
  return fail(e.generic)
}

/** "Kết nối tài khoản TikTok" / "Kết nối lại": returns the TikTok sign-in URL (the browser navigates to it). */
export async function startTiktokSocialConnectAction(input: unknown): Promise<ActionResult<{ url: string }>> {
  try {
    const session = await requireUserForAction()
    const parsed = startTiktokSocialConnectSchema.safeParse(input ?? {})
    if (!parsed.success) return zodFail(parsed.error)
    const disclaimer = await checkDisclaimerAccepted(session.user.id, "connection")
    if (!disclaimer.ok) return fail(disclaimer.error)
    const q = await consumeQuota("tiktok-social-connect", session.user.id, 10, 60_000)
    if (!q.allowed) return fail(e.tooMany(q.retryAfterSec))
    const res = await beginTiktokSocialConnect(session.user, parsed.data, { disclaimerVersion: disclaimer.version })
    const secure = appBaseUrl().startsWith("https://")
    ;(await cookies()).set(tiktokSocialStateCookieName(), res.stateBlob, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(TTS_STATE_TTL_MS / 1000),
    })
    return ok({ url: res.url })
  } catch (err) {
    return toFail(err)
  }
}

export async function renameTiktokSocialAction(input: unknown): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = renameTiktokSocialSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await renameTiktokSocialAccount(session.user, parsed.data)
    revalidatePath(LIST)
    return ok(undefined, tiktokSocialVi.server.renamed)
  } catch (err) {
    return toFail(err)
  }
}

export async function setTiktokSocialEnabledAction(input: unknown): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = setTiktokSocialEnabledSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await setTiktokSocialAccountEnabled(session.user, parsed.data)
    revalidatePath(LIST)
    return ok(undefined, parsed.data.enabled ? tiktokSocialVi.server.enabled : tiktokSocialVi.server.disabled)
  } catch (err) {
    return toFail(err)
  }
}

export async function deleteTiktokSocialAction(input: unknown): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = deleteTiktokSocialSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await deleteTiktokSocialAccount(session.user, parsed.data)
    revalidatePath(LIST)
    return ok(undefined, tiktokSocialVi.server.deleted)
  } catch (err) {
    return toFail(err)
  }
}
