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
import { setAdAccountsEnabled, setMetaPagesEnabled } from "@/server/services/ad-accounts"
import {
  ConnectionServiceError,
  createConnection,
  deleteConnection,
  getConnectionUsage,
  previewConnection,
  renameConnection,
  replaceCredentials,
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
    const res = await createConnection(session.user, parsed.data)
    revalidateConnection(res.id)
    return ok(res, m.new.saved)
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
    await reauthForConnection(session, parsed.data.connectionId, parsed.data)
    const res = await replaceCredentials(session.user, parsed.data)
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

export async function deleteConnectionAction(input: unknown): Promise<ActionResult<{ affectedMcpIds: string[] }>> {
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
