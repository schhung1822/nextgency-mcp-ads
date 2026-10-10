// "Miễn trừ trách nhiệm" (src/lib/disclaimers.ts): record a user's acceptance (activity_logs
// `legal.disclaimer_accept`, same request IP / user agent columns as every staff log) and check it before a create.
//
// Enforcement lives in the server ACTIONS that every UI path goes through (create connection - token or TikTok
// auth_code -, create Telegram channel, create Google Drive source → kind "connection"; create MCP → kind "mcp"):
// they refuse unless the SAME user accepted the CURRENT version of that text (at any time: the popup is shown once per
// user, kind and version - the pages use hasAcceptedDisclaimer to skip it). The CLI, seeds and tests that call the
// services directly are out of scope. activity_logs is append-only (DB trigger), so an acceptance can never be edited
// once written; it lives as long as the staff log retention keeps its monthly partition (then the user is asked again).
import "server-only"
import { createHash } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"

import {
  DISCLAIMER_VERSIONS,
  isCurrentDisclaimerVersion,
  type DisclaimerKind,
} from "@/lib/disclaimers"
import { disclaimers as t } from "@/lib/i18n/vi/disclaimers"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import type { AppUser } from "@/server/auth/session"
import { db } from "@/server/db/client"
import { activityLogs } from "@/server/db/schema"

export type DisclaimerActor = Pick<AppUser, "id" | "email" | "role">

export const DISCLAIMER_ACTION = "legal.disclaimer_accept" as const
const TARGET = "disclaimer"

export class DisclaimerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DisclaimerError"
  }
}

/** Short SHA-256 of the exact text shown for `kind` (logged with every acceptance: proves which words were agreed to). */
export function disclaimerContentHash(kind: DisclaimerKind): string {
  return createHash("sha256")
    .update(JSON.stringify(t.docs[kind]))
    .digest("hex")
    .slice(0, 16)
}

/**
 * The user confirmed the popup. Refuses a version that is not the current one (the text changed while the popup
 * was open). Writes the acceptance row in its own transaction.
 */
export async function acceptDisclaimer(
  actor: DisclaimerActor,
  input: { kind: DisclaimerKind; version: string }
): Promise<{ kind: DisclaimerKind; version: string; acceptedAt: string }> {
  if (!isCurrentDisclaimerVersion(input.kind, input.version))
    throw new DisclaimerError(t.errors.stale)
  const version = DISCLAIMER_VERSIONS[input.kind]
  const acceptedAt = new Date()
  await db.transaction(async (tx) => {
    await logActivity(
      {
        actor: actorOf(actor),
        action: DISCLAIMER_ACTION,
        target: { type: TARGET, id: input.kind, label: version },
        metadata: {
          kind: input.kind,
          version,
          contentHash: disclaimerContentHash(input.kind),
        },
      },
      tx
    )
  })
  return { kind: input.kind, version, acceptedAt: acceptedAt.toISOString() }
}

/** Latest acceptance of the CURRENT version of `kind` by this user (no time window), or null. */
export async function findDisclaimerAcceptance(
  actorId: string,
  kind: DisclaimerKind
): Promise<{ version: string; acceptedAt: Date } | null> {
  const version = DISCLAIMER_VERSIONS[kind]
  const al = activityLogs
  const [row] = await db
    .select({ createdAt: al.createdAt })
    .from(al)
    .where(
      and(
        eq(al.actorId, actorId),
        eq(al.action, DISCLAIMER_ACTION),
        eq(al.status, "success"),
        eq(al.targetType, TARGET),
        eq(al.targetId, kind),
        sql`${al.metadata}->>'version' = ${version}`
      )
    )
    .orderBy(desc(al.createdAt))
    .limit(1)
  return row ? { version, acceptedAt: row.createdAt } : null
}

/** The user already accepted the current version of `kind`: the page does not show the popup again. */
export async function hasAcceptedDisclaimer(
  actorId: string,
  kind: DisclaimerKind
): Promise<boolean> {
  return (await findDisclaimerAcceptance(actorId, kind)) !== null
}

/**
 * Gate for a create action: `{ ok: true, version }` (log it with the created object) or `{ ok: false, error }` with
 * the Vietnamese refusal to show.
 */
export async function checkDisclaimerAccepted(
  actorId: string,
  kind: DisclaimerKind
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const hit = await findDisclaimerAcceptance(actorId, kind)
  return hit
    ? { ok: true, version: hit.version }
    : { ok: false, error: t.errors.required[kind] }
}

/** Extra audit fields a create service adds to its activity log metadata. */
export interface CreateAudit {
  /** version of the disclaimer the creator accepted (checked by the action) */
  disclaimerVersion?: string
}

export function disclaimerAuditMeta(audit?: CreateAudit): {
  disclaimerVersion?: string
} {
  return audit?.disclaimerVersion
    ? { disclaimerVersion: audit.disclaimerVersion }
    : {}
}
