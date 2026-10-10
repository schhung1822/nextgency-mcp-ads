"use server"
// Server actions for "Kết nối quảng cáo". Thin: requireUserForAction → zod → service (owner checks,
// encryption, activity log in the same transaction) → revalidatePath. Never returns credentials.
import { revalidatePath } from "next/cache"
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { connections as m } from "@/lib/i18n/vi/connections"
import {
  connectionIdSchema,
  createConnectionSchema,
  previewConnectionSchema,
  renameConnectionSchema,
  replaceCredentialsSchema,
  tiktokAuthCodeCreateSchema,
  tiktokAuthCodeReplaceSchema,
  toggleAccountsSchema,
  togglePagesSchema,
  type AdAccountDto,
  type ConnectionCheckResult,
  type ConnectionPreview,
  type McpUsage,
  type MetaPageDto,
} from "@/lib/schemas/connections"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { ReauthError, requestReauthVerifier, requireReauth } from "@/server/auth/reauth"
import { AuthorizationError, requireUserForAction, type AppSession } from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import { setAdAccountsEnabled, setMetaPagesEnabled } from "@/server/services/ad-accounts"
import { checkDisclaimerAccepted } from "@/server/services/disclaimers"
import {
  ConnectionServiceError,
  createConnection,
  createTikTokConnectionFromAuthCode,
  deleteConnection,
  getConnectionUsage,
  previewConnection,
  renameConnection,
  replaceCredentials,
  replaceTikTokCredentialsFromAuthCode,
  syncConnectionAccounts,
  testConnection,
} from "@/server/services/connections"

const LIST = "/connections"

function zodFail(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {}
  for (const i of error.issues) {
    const k = i.path.join(".") || "_"
    fieldErrors[k] ??= i.message
  }
  return fail(error.issues[0]?.message ?? m.errors.invalidInput, fieldErrors)
}

function toFail(e: unknown): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof ConnectionServiceError || e instanceof ReauthError) return fail(e.message, e.fieldErrors)
  // unexpected: log a redacted one-liner, show a generic Vietnamese message
  console.error("[actions/connections]", safeErrorForLog(e))
  return fail(m.errors.generic)
}

/**
 * Replacing credentials is sensitive: re-authenticate (password + TOTP when 2FA is on) through the shared
 * gate - failures are counted (5 / 15 min / user, all sensitive actions) and logged as connection.update.
 */
async function reauthForConnection(
  session: AppSession,
  connectionId: string,
  fields: { password: string; code?: string }
): Promise<void> {
  await requireReauth(
    { id: session.user.id, email: session.user.email, role: session.user.role },
    { action: "connection.update", target: { type: "connection", id: connectionId }, metadata: { changed: ["credentials"] } },
    await requestReauthVerifier(session.user, fields),
    { sessionId: session.sessionId }
  )
}

/**
 * Calls that reach the ad platform with a credential (preview, create, test, sync, replace token) are throttled per
 * user: they cost the platform's rate limit and would otherwise let a script probe tokens at full speed.
 */
const PROVIDER_QUOTA_MAX = 10
const PROVIDER_QUOTA_WINDOW_MS = 60_000

async function throttleProvider(session: AppSession): Promise<ActionResult<never> | null> {
  const q = await consumeQuota("connection-verify", session.user.id, PROVIDER_QUOTA_MAX, PROVIDER_QUOTA_WINDOW_MS)
  return q.allowed ? null : fail(m.errors.tooManyChecks(q.retryAfterSec))
}

function revalidateConnection(id?: string) {
  revalidatePath(LIST)
  if (id) revalidatePath(`${LIST}/${id}`)
}

// ---------------------------------------------------------------------------

/** Wizard step 3: validate the pasted credentials and list ad accounts. Saves nothing. */
export async function previewConnectionAction(input: unknown): Promise<ActionResult<ConnectionPreview>> {
  try {
    const session = await requireUserForAction()
    const parsed = previewConnectionSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    return ok(await previewConnection(session.user, parsed.data))
  } catch (e) {
    return toFail(e)
  }
}

export async function createConnectionAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await requireUserForAction()
    const parsed = createConnectionSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    // "Miễn trừ trách nhiệm" accepted (current version, last 12 h) before anything reaches the platform
    const disclaimer = await checkDisclaimerAccepted(session.user.id, "connection")
    if (!disclaimer.ok) return fail(disclaimer.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    const res = await createConnection(session.user, parsed.data, { disclaimerVersion: disclaimer.version })
    revalidateConnection(res.id)
    return ok(res, m.new.saved)
  } catch (e) {
    return toFail(e)
  }
}

/** TikTok: exchange auth_code → token and create the connection server-side (the token is never sent back). */
export async function createTikTokFromAuthCodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await requireUserForAction()
    const parsed = tiktokAuthCodeCreateSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const disclaimer = await checkDisclaimerAccepted(session.user.id, "connection")
    if (!disclaimer.ok) return fail(disclaimer.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    const res = await createTikTokConnectionFromAuthCode(session.user, parsed.data, { disclaimerVersion: disclaimer.version })
    revalidateConnection(res.id)
    return ok({ id: res.id }, m.new.authCodeSuccess)
  } catch (e) {
    return toFail(e)
  }
}

export async function renameConnectionAction(input: unknown): Promise<ActionResult> {
  try {
    const session = await requireUserForAction()
    const parsed = renameConnectionSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await renameConnection(session.user, parsed.data)
    revalidateConnection(parsed.data.connectionId)
    return ok(undefined, m.rename.done)
  } catch (e) {
    return toFail(e)
  }
}

export async function replaceCredentialsAction(input: unknown): Promise<ActionResult<ConnectionCheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = replaceCredentialsSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    await reauthForConnection(session, parsed.data.connectionId, parsed.data)
    const res = await replaceCredentials(session.user, parsed.data)
    revalidateConnection(parsed.data.connectionId)
    return ok(res, m.replace.done)
  } catch (e) {
    return toFail(e)
  }
}

/** "Thay token" for TikTok by a new auth_code (re-auth first, exchange server-side). */
export async function replaceTikTokFromAuthCodeAction(input: unknown): Promise<ActionResult<ConnectionCheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = tiktokAuthCodeReplaceSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    await reauthForConnection(session, parsed.data.connectionId, parsed.data)
    const res = await replaceTikTokCredentialsFromAuthCode(session.user, parsed.data)
    revalidateConnection(parsed.data.connectionId)
    return ok(res, m.replace.done)
  } catch (e) {
    return toFail(e)
  }
}

export async function testConnectionAction(input: unknown): Promise<ActionResult<ConnectionCheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = connectionIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    const res = await testConnection(session.user, parsed.data.connectionId)
    revalidateConnection(parsed.data.connectionId)
    return ok(res, m.detail.rechecked)
  } catch (e) {
    return toFail(e)
  }
}

export async function syncConnectionAccountsAction(input: unknown): Promise<ActionResult<ConnectionCheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = connectionIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttleProvider(session)
    if (throttled) return throttled
    const res = await syncConnectionAccounts(session.user, parsed.data.connectionId)
    revalidateConnection(parsed.data.connectionId)
    return ok(res)
  } catch (e) {
    return toFail(e)
  }
}

export async function toggleAdAccountsAction(input: unknown): Promise<ActionResult<AdAccountDto[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = toggleAccountsSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const res = await setAdAccountsEnabled(session.user, parsed.data)
    revalidateConnection(parsed.data.connectionId)
    return ok(res)
  } catch (e) {
    return toFail(e)
  }
}

export async function toggleMetaPagesAction(input: unknown): Promise<ActionResult<MetaPageDto[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = togglePagesSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const res = await setMetaPagesEnabled(session.user, parsed.data)
    revalidateConnection(parsed.data.connectionId)
    return ok(res)
  } catch (e) {
    return toFail(e)
  }
}

/** MCPs that would lose access if the connection is deleted (shown in the delete dialog). */
export async function connectionUsageAction(input: unknown): Promise<ActionResult<McpUsage[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = connectionIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    return ok(await getConnectionUsage(session.user, parsed.data.connectionId))
  } catch (e) {
    return toFail(e)
  }
}

export async function deleteConnectionAction(
  input: unknown
): Promise<ActionResult<{ affectedMcpIds: string[]; affectedMcpCount: number }>> {
  try {
    const session = await requireUserForAction()
    const parsed = connectionIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const res = await deleteConnection(session.user, parsed.data.connectionId)
    revalidatePath(LIST)
    return ok(res, m.remove.done)
  } catch (e) {
    return toFail(e)
  }
}
