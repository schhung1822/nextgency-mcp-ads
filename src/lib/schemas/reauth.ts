// Re-authentication fields {password, code?} for sensitive actions. Safe for client and server.
import { z } from "zod"

import { reauth as t } from "@/lib/i18n/vi/reauth"

/** 6-digit TOTP code; required by the server when the user has 2FA enabled. "" → undefined. */
export const reauthCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, t.codeInvalid)
  .optional()
  .or(z.literal("").transform(() => undefined))

export const reauthFieldsShape = {
  password: z.string({ error: t.passwordRequired }).min(1, t.passwordRequired).max(256),
  code: reauthCodeSchema,
}

export const reauthFieldsSchema = z.object(reauthFieldsShape)
export type ReauthFields = z.output<typeof reauthFieldsSchema>
export type ReauthFieldsInput = z.input<typeof reauthFieldsSchema>
