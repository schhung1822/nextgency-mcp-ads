// Framework-free activity_logs writer for code that must not import `next/*` or "server-only":
// Better Auth hooks (also loaded by the Better Auth CLI via auth-cli.ts) and scripts/cli.ts.
// Next server code should keep using `logActivity` from "@/server/audit/activity-log".
import type { ActivityAction, ActivityActor } from "@/server/audit/activity-log"
import { capJson } from "@/server/audit/cap-json"
import { db, type Tx } from "@/server/db/client"
import { activityLogs } from "@/server/db/schema"
import { normalizeIp } from "@/server/net/ip"

export interface CoreActivityEntry {
  actor: ActivityActor
  action: ActivityAction
  target?: { type: string; id?: string | null; label?: string | null }
  status?: "success" | "failure"
  metadata?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Same extraction as audit/activity-log.ts `metaFromHeaders`: only the first X-Forwarded-For hop (set by
 * Caddy) is trusted; X-Real-IP is attacker-controlled and ignored.
 */
export function requestMetaFromHeaders(h: Headers | null | undefined): RequestMeta {
  if (!h) return { ip: null, userAgent: null }
  return {
    // see audit/activity-log.ts: zone ids would be rejected by the `inet` column and abort the insert
    ip: normalizeIp(h.get("x-forwarded-for")?.split(",")[0]),
    userAgent: h.get("user-agent")?.slice(0, 512) ?? null,
  }
}

/** Insert one activity_logs row (metadata is redacted + capped). Pass `tx` to share a transaction. */
export async function insertActivity(entry: CoreActivityEntry, tx: Tx | typeof db = db): Promise<void> {
  const capped = capJson(entry.metadata ?? {}, 16 * 1024)
  await tx.insert(activityLogs).values({
    actorId: entry.actor.id,
    actorEmail: entry.actor.email,
    actorRole: entry.actor.role,
    action: entry.action,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    targetLabel: entry.target?.label ?? null,
    status: entry.status ?? "success",
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    metadata: (capped.json ?? {}) as Record<string, unknown>,
  })
}

/** Actor used for CLI-originated changes (no signed-in user). */
export const CLI_ACTOR: ActivityActor = { id: null, email: null, role: "cli" }
