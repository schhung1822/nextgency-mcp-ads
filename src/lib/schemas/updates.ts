// Update request input (shared by the /settings/updates client dialog and the server action).
import { z } from "zod"

import { updates as t } from "@/lib/i18n/vi/updates"
import { parseSemver } from "@/lib/version"

import { reauthFieldsShape } from "./reauth"

z.config(z.locales.vi())

/** Strict MAJOR.MINOR.PATCH without "v" - the server still requires it to equal the stored latest release. */
export const targetVersionSchema = z
  .string({ error: t.errors.invalidTarget })
  .refine((v) => parseSemver(v) !== null, { message: t.errors.invalidTarget })

export const startUpdateSchema = z.object({
  targetVersion: targetVersionSchema,
  ...reauthFieldsShape,
})

export type StartUpdateInput = z.input<typeof startUpdateSchema>

/** "Kiểm tra ngay" (manual) or the check the update page runs by itself when opened (auto). */
export const checkUpdatesSchema = z.object({ auto: z.boolean().optional() }).strict().optional()
