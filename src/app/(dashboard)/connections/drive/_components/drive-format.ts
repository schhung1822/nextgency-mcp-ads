// Small client-safe formatters for the Google Drive screens.
import { formatNumber } from "@/lib/format"
import { drive } from "@/lib/i18n/vi/drive"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import type { DriveSourceDto } from "@/lib/schemas/drive"

/** 1536 → "1,5 KB" (vi-VN decimals). */
export function formatBytes(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${formatNumber(v, 1)} ${units[i]}`
}

/** 75_000 → "1:15", 3_725_000 → "1:02:05". */
export function formatClock(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return null
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (x: number) => String(x).padStart(2, "0")
  return h > 0 ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

/**
 * Link that opens the source on Google (ids are not secrets). Resource keys are never sent to the client, so a folder
 * shared with an old-style resource key may ask the viewer to request access - that is fine for an "open" link.
 */
export function googleOpenUrl(
  s: Pick<DriveSourceDto, "kind" | "googleId" | "sheetGid">
): string {
  const id = encodeURIComponent(s.googleId)
  return s.kind === "sheet"
    ? `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${s.sheetGid ?? 0}`
    : `https://drive.google.com/drive/folders/${id}`
}

/** DriveError hints that only an administrator can act on (they fix the SYSTEM service account / API key). */
const ADMIN_ONLY_HINTS: readonly string[] = [
  drive.errors.auth_failed.hint,
  drive.errors.api_disabled.hint,
  drive.errors.api_key_invalid.hint,
  drive.errors.not_configured.hint,
  drive.serviceAccount.badKey,
]

/**
 * A staff member looking at a source read with the SYSTEM credential cannot "create a new JSON key" or "enable the
 * API": swap such admin-only fix hints for "ask the administrator to check Settings → Google Drive" (UI layer only;
 * the stored message stays the same for admins and for personal service accounts, which the owner fixes).
 */
export function driveStatusText(
  message: string | null | undefined,
  viewer: { isAdmin: boolean; credentialKind: "system" | "personal" | null }
): string | null {
  if (!message) return null
  if (viewer.isAdmin || viewer.credentialKind !== "system") return message
  let out = message
  for (const hint of ADMIN_ONLY_HINTS)
    if (out.includes(hint)) out = out.replace(hint, driveUi.list.systemErrorStaff)
  return out
}
