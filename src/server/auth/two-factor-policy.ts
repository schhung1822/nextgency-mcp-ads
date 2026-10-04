// 2FA enforcement policy from app_settings (framework-free: used by pages, actions, Better Auth hooks, CLI).
// Owner decision (2026-10-02): 2FA is OPTIONAL by default for everyone, admins included; users can turn
// it on/off in /account. Admins can make it mandatory in Cài đặt:
//   require_2fa_admin - admins must enroll 2FA before using the app (default OFF)
//   require_2fa_all   - every user must enroll 2FA (default OFF; implies require_2fa_admin)
// Reading the settings fails CLOSED (required) so a DB hiccup never silently relaxes an enabled policy.
import { inArray } from "drizzle-orm"
import { db, type Tx } from "@/server/db/client"
import { appSettings } from "@/server/db/schema"

export interface TwoFactorPolicy {
  /** admins must have 2FA */
  admin: boolean
  /** everyone must have 2FA (implies admin) */
  all: boolean
}

export async function readTwoFactorPolicy(
  tx: Tx | typeof db = db
): Promise<TwoFactorPolicy> {
  try {
    const rows = await tx
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, ["require_2fa_admin", "require_2fa_all"]))
    const get = (k: string) => rows.find((r) => r.key === k)?.value
    const all = get("require_2fa_all") === true
    return { admin: all || get("require_2fa_admin") === true, all }
  } catch {
    return { admin: true, all: true }
  }
}

/** Does the policy require a user with this role to have 2FA? */
export function twoFactorRequiredFor(
  role: string | null | undefined,
  p: TwoFactorPolicy
): boolean {
  return role === "admin" ? p.admin || p.all : p.all
}
