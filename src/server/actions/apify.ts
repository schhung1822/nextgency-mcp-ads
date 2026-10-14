"use server"
// Server actions for "Kết nối → Apify" (16-apify.md §4). Thin: requireUserForAction → zod → (create: disclaimer) →
// per-user quota for calls that reach Apify → service (owner / admin checks, encryption, activity log in the same
// transaction) → revalidatePath. Never returns the token. Success messages come from the UI (i18n apify.server).
import { revalidatePath } from "next/cache"
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { apifyErrors } from "@/lib/i18n/vi/apify-errors"
import {
  APIFY_SCHEMA_MESSAGES,
  apifyTokenIdSchema,
  createApifyTokenSchema,
  deleteApifyTokenSchema,
  previewApifyTokenSchema,
  renameApifyTokenSchema,
  replaceApifyTokenSchema,
  setApifyTokenEnabledSchema,
  type ApifyAccountPreview,
  type ApifyTokenDto,
} from "@/lib/schemas/apify"
import { safeErrorForLog } from "@/server/audit/safe-error"
import {
  ReauthError,
  requestReauthVerifier,
  requireReauth,
} from "@/server/auth/reauth"
import {
  AuthorizationError,
  requireUserForAction,
  type AppSession,
} from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import {
  ApifyServiceError,
  createApifyToken,
  deleteApifyToken,
  previewApifyToken,
  recheckApifyToken,
  renameApifyToken,
  replaceApifyTokenSecret,
  setApifyTokenEnabled,
} from "@/server/services/apify-tokens"
import { checkDisclaimerAccepted } from "@/server/services/disclaimers"

const LIST = "/connections"
const detailPath = (id: string) => `/connections/apify/${id}`

const m = apifyErrors.service

function zodFail(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {}
  for (const i of error.issues) {
    const k = i.path.join(".") || "_"
    fieldErrors[k] ??= i.message
  }
  return fail(error.issues[0]?.message ?? APIFY_SCHEMA_MESSAGES.id, fieldErrors)
}

function toFail(e: unknown): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof ApifyServiceError || e instanceof ReauthError)
    return fail(e.message, e.fieldErrors)
  // unexpected: log a redacted one-liner, show a generic Vietnamese message
  console.error("[actions/apify]", safeErrorForLog(e))
  return fail(m.generic)
}

/**
 * Calls that reach Apify with a token (check, create, replace, recheck) are throttled per user (10 / minute): a
 * script must not probe tokens at full speed through this server.
 */
const APIFY_QUOTA_MAX = 10
const APIFY_QUOTA_WINDOW_MS = 60_000

async function throttleApify(
  session: AppSession
): Promise<ActionResult<never> | null> {
  const q = await consumeQuota(
    "apify-verify",
    session.user.id,
    APIFY_QUOTA_MAX,
    APIFY_QUOTA_WINDOW_MS
  )
  return q.allowed ? null : fail(m.tooManyChecks(q.retryAfterSec))
}

function revalidateToken(id?: string) {
  revalidatePath(LIST)
  if (id) revalidatePath(detailPath(id))
}

// ---------------------------------------------------------------------------

/** "Kiểm tra": account, plan, credit of the pasted token. Saves nothing. */
export async function previewApifyTokenAction(
  input: unknown
): Promise<ActionResult<ApifyAccountPreview>> {
  try {
    const session = await requireUserForAction()
    const parsed = previewApifyTokenSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleApify(session)
    if (throttled) return throttled
    return ok(await previewApifyToken(session.user, parsed.data.token))
  } catch (e) {
    return toFail(e)
  }
}

/** "Lưu" (company scope: admins only - the service refuses it for staff). */
export async function createApifyTokenAction(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await requireUserForAction()
    const parsed = createApifyTokenSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    // "Miễn trừ trách nhiệm" (kết nối) accepted for the current version
    const disclaimer = await checkDisclaimerAccepted(
      session.user.id,
      "connection"
    )
    if (!disclaimer.ok) return fail(disclaimer.error)
    const throttled = await throttleApify(session)
    if (throttled) return throttled
    const res = await createApifyToken(session.user, parsed.data, {
      disclaimerVersion: disclaimer.version,
    })
    revalidateToken(res.id)
    return ok(res)
  } catch (e) {
    return toFail(e)
  }
}

export async function renameApifyTokenAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = renameApifyTokenSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await renameApifyToken(session.user, parsed.data)
    revalidateToken(parsed.data.id)
    return ok(undefined)
  } catch (e) {
    return toFail(e)
  }
}

export async function setApifyTokenEnabledAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = setApifyTokenEnabledSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await setApifyTokenEnabled(session.user, parsed.data)
    revalidateToken(parsed.data.id)
    return ok(undefined)
  } catch (e) {
    return toFail(e)
  }
}

/** "Kiểm tra lại": the refreshed DTO (status invalid / error + reason when Apify refuses the token). */
export async function recheckApifyTokenAction(
  input: unknown
): Promise<ActionResult<ApifyTokenDto>> {
  try {
    const session = await requireUserForAction()
    const parsed = apifyTokenIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleApify(session)
    if (throttled) return throttled
    const res = await recheckApifyToken(session.user, parsed.data.id)
    revalidateToken(parsed.data.id)
    return ok(res)
  } catch (e) {
    return toFail(e)
  }
}

/**
 * Replacing the token is sensitive (it spends money): re-authenticate (password + TOTP when 2FA is on) through the
 * shared gate - failures are counted (5 / 15 min / user, all sensitive actions) and logged as apify_token.replace_token.
 */
export async function replaceApifyTokenAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = replaceApifyTokenSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleApify(session)
    if (throttled) return throttled
    await requireReauth(
      {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      },
      {
        action: "apify_token.replace_token",
        target: { type: "apify_token", id: parsed.data.id },
      },
      await requestReauthVerifier(session.user, parsed.data),
      { sessionId: session.sessionId }
    )
    await replaceApifyTokenSecret(session.user, {
      id: parsed.data.id,
      token: parsed.data.token,
    })
    revalidateToken(parsed.data.id)
    return ok(undefined)
  } catch (e) {
    return toFail(e)
  }
}

/** Delete after typing the name (soft delete, secret wiped). */
export async function deleteApifyTokenAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = deleteApifyTokenSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await deleteApifyToken(session.user, parsed.data)
    revalidatePath(LIST)
    return ok(undefined)
  } catch (e) {
    return toFail(e)
  }
}
