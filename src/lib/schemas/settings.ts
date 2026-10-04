// Admin settings form (shared by the /settings client form and the server action).
// Bounds must match SETTING_SCHEMAS in src/server/services/settings.ts.
import { z } from "zod"

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
})

export type SettingsFormInput = z.input<typeof settingsFormSchema>
export type SettingsFormValues = z.output<typeof settingsFormSchema>
