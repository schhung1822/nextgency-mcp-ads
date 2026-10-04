// Map thrown errors to safe Vietnamese messages for server action results.
import { isAPIError } from "better-auth/api"
import { ZodError } from "zod"

import { auth as tAuth } from "@/lib/i18n/vi/auth"
import { authErrorMessage } from "@/lib/schemas/auth"
import { safeErrorForLog } from "@/server/audit/safe-error"

/** Error whose message is already a safe, user-facing Vietnamese sentence. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserFacingError"
  }
}

/** Better Auth APIError code (e.g. "INVALID_PASSWORD") or null. */
export function apiErrorCode(e: unknown): string | null {
  if (!isAPIError(e)) return null
  const code = (e as { body?: { code?: unknown } }).body?.code
  return typeof code === "string" ? code : null
}

export function toUserMessage(e: unknown, context = "action"): string {
  if (e instanceof UserFacingError) return e.message
  if (e instanceof Error && e.name === "AuthorizationError") return e.message
  if (e instanceof ZodError) return e.issues[0]?.message ?? tAuth.errors.GENERIC
  if (isAPIError(e)) {
    const status = (e as { statusCode?: number }).statusCode
    return authErrorMessage(apiErrorCode(e), status)
  }
  console.error(`[${context}] unexpected error:`, safeErrorForLog(e))
  return tAuth.errors.GENERIC
}
