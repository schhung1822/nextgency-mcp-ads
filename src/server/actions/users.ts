"use server"
// Admin-only user management actions. Thin: requireUserForAction({role:"admin"}) → zod → service.
import { revalidatePath } from "next/cache"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { users as tUsers } from "@/lib/i18n/vi/users"
import { zodFieldErrors } from "@/lib/schemas/auth"
import {
  banSchema,
  changeRoleSchema,
  createUserSchema,
  deleteUserSchema,
  resetPasswordSchema,
  resetTwoFactorSchema,
  revokeSessionsSchema,
  userTargetSchema,
} from "@/lib/schemas/users"
import { toUserMessage } from "@/server/auth/errors"
import { ReauthError, requestReauthVerifier, type ReauthVerifier } from "@/server/auth/reauth"
import { requireUserForAction, type AppSession } from "@/server/auth/session"
import * as usersService from "@/server/services/users"

const USERS_PATH = "/users"

/** Re-auth verifier for the acting admin, when the client sent {password, code}. */
async function verifierFor(
  s: AppSession,
  reauth: { password: string; code?: string } | undefined
): Promise<ReauthVerifier | undefined> {
  return reauth ? requestReauthVerifier(s.user, reauth) : undefined
}

function failFrom(e: unknown, context: string): ActionResult<never> {
  if (e instanceof ReauthError) return fail(e.message, e.fieldErrors)
  return fail(toUserMessage(e, context))
}

export async function createUserAction(input: unknown): Promise<ActionResult<{ userId: string }>> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = createUserSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    const { reauth, ...data } = parsed.data
    const res = await usersService.createUserByAdmin(s, data, await verifierFor(s, reauth))
    revalidatePath(USERS_PATH)
    return ok(res, tUsers.toast.created)
  } catch (e) {
    return failFrom(e, "users.create")
  }
}

export async function changeUserRoleAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = changeRoleSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    const { password, code, ...data } = parsed.data
    await usersService.changeUserRole(s, data, await requestReauthVerifier(s.user, { password, code }))
    revalidatePath(USERS_PATH)
    return ok(undefined, tUsers.toast.roleChanged)
  } catch (e) {
    return failFrom(e, "users.role")
  }
}

export async function resetUserPasswordAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = resetPasswordSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]!.message, zodFieldErrors(parsed.error))
    const { reauth, ...data } = parsed.data
    await usersService.resetUserPassword(s, data, await verifierFor(s, reauth))
    revalidatePath(USERS_PATH)
    return ok(undefined, tUsers.toast.passwordReset)
  } catch (e) {
    return failFrom(e, "users.resetPassword")
  }
}

export async function resetUserTwoFactorAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = resetTwoFactorSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? tUsers.errors.notFound, zodFieldErrors(parsed.error))
    const { reauth, ...data } = parsed.data
    await usersService.resetUserTwoFactor(s, data, await verifierFor(s, reauth))
    revalidatePath(USERS_PATH)
    return ok(undefined, tUsers.toast.twoFactorReset)
  } catch (e) {
    return failFrom(e, "users.reset2fa")
  }
}

export async function setUserBannedAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = banSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? tUsers.errors.notFound, zodFieldErrors(parsed.error))
    const { reauth, ...data } = parsed.data
    await usersService.setUserBanned(s, data, await verifierFor(s, reauth))
    revalidatePath(USERS_PATH)
    return ok(undefined, data.banned ? tUsers.toast.banned : tUsers.toast.unbanned)
  } catch (e) {
    return failFrom(e, "users.ban")
  }
}

export async function listUserSessionsAction(input: unknown): Promise<ActionResult<usersService.SessionItem[]>> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = userTargetSchema.safeParse(input)
    if (!parsed.success) return fail(tUsers.errors.notFound)
    return ok(await usersService.listSessionsOf(s, parsed.data.userId))
  } catch (e) {
    return fail(toUserMessage(e, "users.sessions"))
  }
}

export async function revokeUserSessionsAction(input: unknown): Promise<ActionResult<{ count: number }>> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = revokeSessionsSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? tUsers.errors.notFound, zodFieldErrors(parsed.error))
    const { reauth, ...data } = parsed.data
    const n = await usersService.revokeUserSessionsByAdmin(s, data, await verifierFor(s, reauth))
    revalidatePath(USERS_PATH)
    return ok({ count: n }, data.sessionId ? tUsers.toast.sessionRevoked : tUsers.toast.sessionsRevoked)
  } catch (e) {
    return failFrom(e, "users.revokeSessions")
  }
}

export async function deleteUserAction(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireUserForAction({ role: "admin" })
    const parsed = deleteUserSchema.safeParse(input)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? tUsers.errors.notFound, zodFieldErrors(parsed.error))
    const { reauth, ...data } = parsed.data
    await usersService.deleteUserByAdmin(s, data, await verifierFor(s, reauth))
    revalidatePath(USERS_PATH)
    return ok(undefined, tUsers.toast.deleted)
  } catch (e) {
    return failFrom(e, "users.delete")
  }
}
