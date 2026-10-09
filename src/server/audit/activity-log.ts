// Staff activity log (activity_logs). Write it INSIDE the same transaction as the business change.
import "server-only"
import { headers } from "next/headers"
import { db, type Tx } from "@/server/db/client"
import { activityLogs } from "@/server/db/schema"
import { normalizeIp } from "@/server/net/ip"
import { capJson } from "./cap-json"

export type ActivityAction =
  | "setup.first_admin"
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.2fa.enable"
  | "auth.2fa.disable"
  | "auth.2fa.backup_codes.regenerate"
  | "auth.password.change"
  | "user.create"
  | "user.update"
  | "user.role.change"
  | "user.ban"
  | "user.unban"
  | "user.delete"
  | "user.password.reset"
  | "user.2fa.reset"
  | "user.sessions.revoke"
  | "connection.create"
  | "connection.update"
  | "connection.delete"
  | "connection.test"
  | "connection.accounts.toggle"
  | "connection.pages.toggle"
  | "notification_channel.create"
  | "notification_channel.update"
  | "notification_channel.delete"
  | "notification_channel.disable"
  | "notification_channel.enable"
  | "notification_channel.test"
  | "notification_channel.token.replace"
  | "drive_credential.create"
  | "drive_credential.update"
  | "drive_credential.test"
  | "drive_credential.delete"
  | "drive_source.create"
  | "drive_source.update"
  | "drive_source.delete"
  | "mcp.create"
  | "mcp.update"
  | "mcp.enable"
  | "mcp.disable"
  | "mcp.delete"
  | "mcp.key.rotate"
  | "mcp.key.reveal"
  | "settings.update"
  | "logs.export"
  | "system.update_check"
  | "system.update_requested"
  | "system.update_succeeded"
  | "system.update_failed"
  | "system.update_rolled_back"

export interface ActivityActor {
  id: string | null
  email: string | null
  role: string | null
}

export interface ActivityEntry {
  actor: ActivityActor
  action: ActivityAction
  target?: { type: string; id?: string | null; label?: string | null }
  status?: "success" | "failure"
  /** diff {before, after}, reason, counts… - redacted + capped automatically */
  metadata?: Record<string, unknown>
  /** override request meta (e.g. from Better Auth hook context) */
  ip?: string | null
  userAgent?: string | null
}

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/** Client IP (first X-Forwarded-For hop set by Caddy) + user agent of the current request. */
export async function getRequestMeta(): Promise<RequestMeta> {
  try {
    const h = await headers()
    return metaFromHeaders(h)
  } catch {
    return { ip: null, userAgent: null }
  }
}

/**
 * Only the first X-Forwarded-For hop is trusted (Caddy overwrites client-supplied values); X-Real-IP is
 * passed through untouched by Caddy, i.e. attacker-controlled, so it is ignored.
 */
export function metaFromHeaders(h: Headers): RequestMeta {
  // normalizeIp: valid IP only, IPv6 zone id ("fe80::1%eth0", accepted by node:net but REJECTED by Postgres inet -
  // it would abort the transaction that writes the log) and "::ffff:" prefix stripped
  return {
    ip: normalizeIp(h.get("x-forwarded-for")?.split(",")[0]),
    userAgent: h.get("user-agent")?.slice(0, 512) ?? null,
  }
}

export async function logActivity(
  entry: ActivityEntry,
  tx: Tx | typeof db = db
): Promise<void> {
  const meta =
    entry.ip === undefined && entry.userAgent === undefined
      ? await getRequestMeta()
      : null
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
    ip: entry.ip ?? meta?.ip ?? null,
    userAgent: entry.userAgent ?? meta?.userAgent ?? null,
    metadata: (capped.json ?? {}) as Record<string, unknown>,
  })
}

/** Convenience: actor from an AppSession user */
export function actorOf(user: {
  id: string
  email: string
  role: string
}): ActivityActor {
  return { id: user.id, email: user.email, role: user.role }
}
