// Admin settings form (shared by the /settings client form and the server action).
// Bounds must match SETTING_SCHEMAS in src/server/services/settings.ts.
import { z } from "zod"

import { legalContactEmailSchema, legalOrgNameSchema } from "@/lib/legal"

import { reauthFieldsSchema } from "./reauth"

z.config(z.locales.vi())

const months = z.coerce
  .number({ error: "Nhập số tháng" })
  .int("Số tháng phải là số nguyên")
  .min(1, "Tối thiểu 1 tháng")
  .max(24, "Tối đa 24 tháng")

export const settingsFormSchema = z.object({
  log_retention_months_mcp: months,
  log_retention_months_staff: months,
  require_2fa_admin: z.boolean(),
  require_2fa_all: z.boolean(),
  session_max_hours: z.coerce
    .number({ error: "Nhập số giờ" })
    .int("Số giờ phải là số nguyên")
    .min(1, "Tối thiểu 1 giờ")
    .max(168, "Tối đa 168 giờ (7 ngày)"),
  // public legal pages - informational, never part of isRelaxingSettingsChange
  legal_org_name: legalOrgNameSchema,
  legal_contact_email: legalContactEmailSchema,
})

export type SettingsFormInput = z.input<typeof settingsFormSchema>
export type SettingsFormValues = z.output<typeof settingsFormSchema>

/** Server action input: the form + the acting admin's password (+ TOTP) when the change relaxes security. */
export const settingsUpdateSchema = settingsFormSchema.extend({ reauth: reauthFieldsSchema.optional() })

/**
 * True when `after` weakens security compared with `before`: turning a 2FA requirement off, allowing longer
 * sessions, or keeping logs for a shorter time (older logs are deleted for good). Such a change needs re-auth.
 * The legal-page fields (operator name, privacy contact) are informational and never count as relaxing.
 */
export function isRelaxingSettingsChange(before: SettingsFormValues, after: SettingsFormValues): boolean {
  return (
    (before.require_2fa_admin && !after.require_2fa_admin) ||
    (before.require_2fa_all && !after.require_2fa_all) ||
    after.session_max_hours > before.session_max_hours ||
    after.log_retention_months_mcp < before.log_retention_months_mcp ||
    after.log_retention_months_staff < before.log_retention_months_staff
  )
}
