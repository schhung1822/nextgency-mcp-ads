// Zod schemas shared by auth forms (client) and server actions. Safe to import anywhere.
import { z } from "zod"

import { auth as tAuth, type AuthErrorCode } from "@/lib/i18n/vi/auth"

const v = tAuth.validation

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

export const emailSchema = z
  .string({ error: v.emailRequired })
  .trim()
  .min(1, v.emailRequired)
  .max(254, v.emailInvalid)
  .pipe(z.email({ error: v.emailInvalid }))
  .transform((s) => s.toLowerCase())

/** New passwords (setup, change, admin-set temp passwords). */
export const newPasswordSchema = z
  .string({ error: v.passwordRequired })
  .min(PASSWORD_MIN, v.passwordMin)
  .max(PASSWORD_MAX, v.passwordMax)

/** Existing password being re-entered (no policy, only presence + max length). */
export const currentPasswordSchema = z
  .string({ error: v.passwordRequired })
  .min(1, v.passwordRequired)
  .max(PASSWORD_MAX, v.passwordMax)

export const nameSchema = z
  .string({ error: v.nameRequired })
  .trim()
  .min(1, v.nameRequired)
  .max(100, v.nameMax)

export const loginSchema = z.object({
  email: emailSchema,
  password: currentPasswordSchema,
})
export type LoginInput = z.input<typeof loginSchema>

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, v.codeInvalid)

export const backupCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, v.backupInvalid)
  .transform((s) => (s.includes("-") ? s : `${s.slice(0, 5)}-${s.slice(5)}`))

export const setupSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: newPasswordSchema,
    confirmPassword: z.string(),
    setupToken: z.string().trim().min(1, v.tokenRequired).max(512),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ["confirmPassword"],
    message: v.passwordMismatch,
  })
export type SetupInput = z.input<typeof setupSchema>

export const changePasswordSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    newPassword: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: v.passwordMismatch,
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    path: ["newPassword"],
    message: v.passwordSame,
  })
export type ChangePasswordInput = z.input<typeof changePasswordSchema>

export const passwordConfirmSchema = z.object({ password: currentPasswordSchema })
export type PasswordConfirmInput = z.input<typeof passwordConfirmSchema>

export const totpConfirmSchema = z.object({ code: totpCodeSchema })

export const profileSchema = z.object({ name: nameSchema })
export type ProfileInput = z.input<typeof profileSchema>

/**
 * Vietnamese message for a Better Auth / app error code (falls back to a generic message).
 * `status` 429 (rate limit) is mapped even when the code is missing.
 */
export function authErrorMessage(code?: string | null, status?: number): string {
  if (code && code in tAuth.errors) return tAuth.errors[code as AuthErrorCode]
  if (status === 429) return tAuth.errors.TOO_MANY_REQUESTS
  if (status === 401) return tAuth.errors.UNAUTHORIZED
  if (status === 403) return tAuth.errors.FORBIDDEN
  return tAuth.errors.GENERIC
}

/** Only allow same-origin relative paths for post-login redirects ("/x", not "//evil" or "/\\evil"). */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || typeof next !== "string") return null
  if (next.length > 512) return null
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null
  if (/[\u0000-\u001f]/.test(next)) return null
  if (next.startsWith("/login") || next.startsWith("/setup") || next.startsWith("/api/")) return null
  return next
}

/** First zod issue per field → `{ field: message }` for ActionResult.fieldErrors. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_"
    out[key] ??= issue.message
  }
  return out
}
