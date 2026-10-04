// Small display helpers shared by the log tables and detail sheets (client-safe, pure).
import { PLATFORM_LABELS, ROLE_LABELS } from "@/lib/constants"
import { DISPLAY_TZ } from "@/lib/format"
import { logs as tl } from "@/lib/i18n/vi/logs"
import type { Platform } from "@/components/app/types"

const TIME_FMT = new Intl.DateTimeFormat("vi-VN", {
  timeZone: DISPLAY_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/** "14:05:33 02/10/2026" style in Asia/Ho_Chi_Minh (seconds matter in logs). */
export function formatLogTime(iso: string): string {
  return TIME_FMT.format(new Date(iso))
}

/** Same instant split for stacked table cells: time on top ("14:05:33"), date below ("02/10/2026"). */
export function formatLogTimeParts(iso: string): { time: string; date: string } {
  const full = formatLogTime(iso)
  const i = full.indexOf(" ")
  return i < 0 ? { time: full, date: "" } : { time: full.slice(0, i), date: full.slice(i + 1) }
}

export function actionLabel(action: string): string {
  return tl.actions[action as keyof typeof tl.actions] ?? action
}

export function roleLabel(role: string | null): string {
  if (!role) return "-"
  return ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role
}

export function targetTypeLabel(type: string | null): string {
  if (!type) return ""
  return tl.targetTypes[type as keyof typeof tl.targetTypes] ?? type
}

export function isPlatform(p: string | null | undefined): p is Platform {
  return !!p && p in PLATFORM_LABELS
}

/** Renders a before/after value compactly (objects → JSON). */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "-"
  if (typeof v === "string") return v === "" ? "“”" : v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export interface ChangeRow {
  objectId: string | null
  field: string
  before: unknown
  after: unknown
}

/** mcp_call_logs.changes = [{object_id, object_name?, level?, field, before, after}] (src/server/mcp/logging.ts) (tolerant of camelCase / missing keys). */
export function normalizeChanges(changes: unknown): ChangeRow[] {
  if (!Array.isArray(changes)) return []
  const out: ChangeRow[] = []
  for (const c of changes) {
    if (!c || typeof c !== "object") continue
    const r = c as Record<string, unknown>
    const field = r.field ?? r.name
    if (typeof field !== "string") continue
    const obj = r.object_id ?? r.objectId
    const name = r.object_name ?? r.objectName
    const id = typeof obj === "string" || typeof obj === "number" ? String(obj) : null
    out.push({
      objectId: typeof name === "string" && name ? (id ? `${name} (${id})` : name) : id,
      field,
      before: r.before,
      after: r.after,
    })
  }
  return out
}

/** activity_logs.metadata {before:{…}, after:{…}} → rows (union of keys whose values differ). */
export function metadataDiff(metadata: unknown): ChangeRow[] {
  if (!metadata || typeof metadata !== "object") return []
  const m = metadata as Record<string, unknown>
  const before = m.before && typeof m.before === "object" ? (m.before as Record<string, unknown>) : null
  const after = m.after && typeof m.after === "object" ? (m.after as Record<string, unknown>) : null
  if (!before && !after) return []
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  return keys
    .filter((k) => displayValue(before?.[k]) !== displayValue(after?.[k]))
    .map((k) => ({ objectId: null, field: k, before: before?.[k], after: after?.[k] }))
}
