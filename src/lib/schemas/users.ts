// Zod schemas for user management (admin) + temp password generator. Safe for client and server.
import { z } from "zod"

import { users as tUsers } from "@/lib/i18n/vi/users"

import {
  currentPasswordSchema,
  emailSchema,
  nameSchema,
  newPasswordSchema,
} from "./auth"
import { reauthCodeSchema, reauthFieldsSchema } from "./reauth"

export const USER_ROLES = ["admin", "staff"] as const
export type UserRole = (typeof USER_ROLES)[number]

export const roleSchema = z.enum(USER_ROLES, { error: tUsers.validation.roleInvalid })

/** Better Auth ids are 32 alphanumeric chars; accept a slightly wider safe charset. */
export const userIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

export const createUserSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: roleSchema,
  password: newPasswordSchema,
  /** acting admin's password (+ TOTP) - required by the server when creating an ADMIN */
  reauth: reauthFieldsSchema.optional(),
})
export type CreateUserInput = z.input<typeof createUserSchema>

export const changeRoleSchema = z.object({
  userId: userIdSchema,
  role: roleSchema,
  /** acting admin's own password + TOTP (re-authentication) */
  password: currentPasswordSchema,
  code: reauthCodeSchema,
})
export type ChangeRoleInput = z.input<typeof changeRoleSchema>

export const resetPasswordSchema = z.object({
  userId: userIdSchema,
  password: newPasswordSchema,
  /** acting admin's password (+ TOTP) - required by the server when the target is an ADMIN */
  reauth: reauthFieldsSchema.optional(),
})
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>

export const userTargetSchema = z.object({ userId: userIdSchema })

/** Reset 2FA: `reauth` required by the server when the target is an ADMIN. */
export const resetTwoFactorSchema = userTargetSchema.extend({ reauth: reauthFieldsSchema.optional() })

export const banSchema = z.object({ userId: userIdSchema, banned: z.boolean() })

export const revokeSessionsSchema = z.object({
  userId: userIdSchema,
  /** omit = revoke every session of the user */
  sessionId: userIdSchema.optional(),
})

// Unambiguous alphabet (no 0/O, 1/l/I) so temp passwords can be read aloud / retyped.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"

/**
 * Random temporary password, grouped for readability: "Xk7q-9TmP-wZ3r-Hb8N" (16 chars of entropy ≈ 92 bits).
 * Uses Web Crypto (browser + Node ≥ 19). Rejection sampling avoids modulo bias.
 */
export function generateTempPassword(groups = 4, groupLen = 4): string {
  const out: string[] = []
  const max = 256 - (256 % ALPHABET.length)
  while (out.length < groups * groupLen) {
    const buf = new Uint8Array(32)
    globalThis.crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b < max && out.length < groups * groupLen) out.push(ALPHABET[b % ALPHABET.length]!)
    }
  }
  const parts: string[] = []
  for (let i = 0; i < groups; i++) parts.push(out.slice(i * groupLen, (i + 1) * groupLen).join(""))
  return parts.join("-")
}
