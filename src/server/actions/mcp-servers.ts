"use server"
// Thin server actions for /mcp-servers. Every action: session guard → zod → service (owner checks +
// activity log in the same transaction) → revalidatePath. Errors are mapped to Vietnamese ActionResult.
import { revalidatePath } from "next/cache"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { mcp as t } from "@/lib/i18n/vi/mcp"
import {
  deleteMcpSchema,
  reauthMcpSchema,
  setMcpEnabledSchema,
} from "@/lib/schemas/mcp-servers"
import { reauthFieldsSchema } from "@/lib/schemas/reauth"
import { ReauthError, requestReauthVerifier, type ReauthVerifier } from "@/server/auth/reauth"
import {
  AuthorizationError,
  requireUserForAction,
  type AppSession,
} from "@/server/auth/session"
import {
  createMcpServer,
  deleteMcpServer,
  McpServiceError,
  revealMcpUrl,
  rotateMcpKey,
  setMcpEnabled,
  updateMcpServer,
  type McpActor,
} from "@/server/services/mcp-servers"
import { getSetting } from "@/server/services/settings"
import { safeErrorForLog } from "@/server/audit/safe-error"

/**
 * requireUserForAction() + the `require_2fa_all` policy for staff (pages enforce it through
 * requireUser(); actions are reachable by direct POST, so check it here too).
 */
async function requireMcpSession(): Promise<AppSession> {
  const s = await requireUserForAction()
  if (
    s.user.role !== "admin" &&
    !s.user.twoFactorEnabled &&
    (await getSetting("require_2fa_all"))
  ) {
    throw new AuthorizationError(t.errors.twoFactorRequired)
  }
  return s
}

function actorFrom(s: AppSession): McpActor {
  return { id: s.user.id, email: s.user.email, role: s.user.role }
}

function toFailure(e: unknown): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof McpServiceError || e instanceof ReauthError) return fail(e.message, e.fieldErrors)
  console.error("[mcp-servers action]", safeErrorForLog(e))
  return fail(t.errors.generic)
}

function revalidate(id?: string) {
  revalidatePath("/mcp-servers")
  if (id) revalidatePath(`/mcp-servers/${id}`)
}

/** Parse {id, password, code?} and build a Better Auth re-auth verifier bound to this request. */
async function parseReauth(
  s: AppSession,
  input: unknown
): Promise<
  | { ok: true; id: string; verify: ReauthVerifier }
  | { ok: false; result: ActionResult<never> }
> {
  const parsed = reauthMcpSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      result: fail(
        issue?.message ?? t.errors.generic,
        issue ? { [issue.path.join(".")]: issue.message } : undefined
      ),
    }
  }
  const { id, password, code } = parsed.data
  return { ok: true, id, verify: await requestReauthVerifier(s.user, { password, code }) }
}

/**
 * Wizard submit: {...mcp fields, password, code?}. Returns the full MCP URL - shown once on the success
 * screen - so it requires re-authentication like "Xem lại link".
 */
export async function createMcpAction(
  input: unknown
): Promise<ActionResult<{ id: string; name: string; url: string }>> {
  try {
    const s = await requireMcpSession()
    const { password, code, ...mcpInput } = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    const fields = reauthFieldsSchema.safeParse({ password, code })
    if (!fields.success) {
      const issue = fields.error.issues[0]
      return fail(issue?.message ?? t.errors.generic, issue ? { [issue.path.join(".")]: issue.message } : undefined)
    }
    const verify = await requestReauthVerifier(s.user, fields.data)
    const r = await createMcpServer(actorFrom(s), mcpInput, verify)
    revalidate()
    return ok(r, t.toast.created)
  } catch (e) {
    return toFailure(e)
  }
}

export async function updateMcpAction(
  input: unknown
): Promise<ActionResult<{ changed: boolean }>> {
  try {
    const s = await requireMcpSession()
    const r = await updateMcpServer(actorFrom(s), input)
    const id = (input as { id?: unknown } | null)?.id
    revalidate(typeof id === "string" ? id : undefined)
    return ok(r, r.changed ? t.toast.updated : t.toast.noChanges)
  } catch (e) {
    return toFailure(e)
  }
}

export async function setMcpEnabledAction(
  input: unknown
): Promise<ActionResult<{ changed: boolean }>> {
  try {
    const s = await requireMcpSession()
    const { id, enabled } = setMcpEnabledSchema.parse(input)
    const r = await setMcpEnabled(actorFrom(s), id, enabled)
    revalidate(id)
    return ok(r, enabled ? t.toast.enabled : t.toast.disabled)
  } catch (e) {
    return toFailure(e)
  }
}

/** Rotate key: hands out a usable link → same re-authentication as "Xem lại link". */
export async function rotateMcpKeyAction(
  input: unknown
): Promise<ActionResult<{ url: string }>> {
  try {
    const s = await requireMcpSession()
    const p = await parseReauth(s, input)
    if (!p.ok) return p.result
    const r = await rotateMcpKey(actorFrom(s), p.id, p.verify)
    revalidate(p.id)
    return ok(r, t.toast.rotated)
  } catch (e) {
    return toFailure(e)
  }
}

/** "Xem lại link": re-authenticates with password (+ TOTP when 2FA is on) on every call. */
export async function revealMcpUrlAction(
  input: unknown
): Promise<ActionResult<{ url: string }>> {
  try {
    const s = await requireMcpSession()
    const p = await parseReauth(s, input)
    if (!p.ok) return p.result
    const r = await revealMcpUrl(actorFrom(s), p.id, p.verify)
    return ok(r)
  } catch (e) {
    return toFailure(e)
  }
}

export async function deleteMcpAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const s = await requireMcpSession()
    const { id, confirmName } = deleteMcpSchema.parse(input)
    await deleteMcpServer(actorFrom(s), id, confirmName)
    revalidate(id)
    return ok(undefined, t.toast.deleted)
  } catch (e) {
    return toFailure(e)
  }
}
