// app_settings key/value store with typed defaults.
import "server-only"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { legalContactEmailSchema, legalOrgNameSchema } from "@/lib/legal"
import { db, type Tx } from "@/server/db/client"
import { appSettings } from "@/server/db/schema"

const retention = z.coerce.number().int().min(1).max(24)

export const SETTING_SCHEMAS = {
  log_retention_months_mcp: retention,
  log_retention_months_staff: retention,
  require_2fa_admin: z.boolean(),
  require_2fa_all: z.boolean(),
  session_max_hours: z.coerce.number().int().min(1).max(168),
  /** public legal pages (/privacy, /terms, /data-deletion): operator name + privacy contact; "" = not set */
  legal_org_name: legalOrgNameSchema,
  legal_contact_email: legalContactEmailSchema,
} as const

export type SettingKey = keyof typeof SETTING_SCHEMAS
export type SettingValue<K extends SettingKey> = z.infer<
  (typeof SETTING_SCHEMAS)[K]
>

function defaults(): { [K in SettingKey]: SettingValue<K> } {
  const months = Number(process.env.LOG_RETENTION_MONTHS ?? 3)
  const m = Number.isInteger(months) && months >= 1 && months <= 24 ? months : 3
  return {
    log_retention_months_mcp: m,
    log_retention_months_staff: m,
    require_2fa_admin: false,
    require_2fa_all: false,
    session_max_hours: 12,
    legal_org_name: "",
    legal_contact_email: "",
  }
}

export async function getSetting<K extends SettingKey>(
  key: K,
  tx: Tx | typeof db = db
): Promise<SettingValue<K>> {
  const rows = await tx
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1)
  const parsed = rows[0] ? SETTING_SCHEMAS[key].safeParse(rows[0].value) : null
  return (parsed?.success ? parsed.data : defaults()[key]) as SettingValue<K>
}

export async function getAllSettings(): Promise<{
  [K in SettingKey]: SettingValue<K>
}> {
  const rows = await db.select().from(appSettings)
  const out = { ...defaults() } as Record<string, unknown>
  for (const r of rows) {
    const schema = SETTING_SCHEMAS[r.key as SettingKey]
    const p = schema?.safeParse(r.value)
    if (p?.success) out[r.key] = p.data
  }
  return out as { [K in SettingKey]: SettingValue<K> }
}

/** Caller must authorize (admin) and write the activity log in the same transaction. */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  updatedBy: string,
  tx: Tx | typeof db = db
): Promise<void> {
  const v = SETTING_SCHEMAS[key].parse(value)
  await tx
    .insert(appSettings)
    .values({ key, value: v, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: v, updatedBy, updatedAt: new Date() },
    })
}
