// "Kết nối → Apify" service (16-apify.md §4): API tokens of Apify, encrypted at rest (AAD apify_token:<id>:credentials,
// src/server/apify/store.ts) and NEVER returned. Rules:
// - company tokens: only admins create / rename / replace / recheck / enable / disable / delete them; staff see them
//   read-only (name, status, credit - no hint, no management);
// - personal tokens: the owner manages them; admins see and manage every token;
// - an MCP rotates through company tokens + its OWNER's personal tokens (loadGrantApifyTokens, store.ts).
// Apify calls (network) always run OUTSIDE DB transactions; every change writes activity_logs in the same transaction
// and is followed by invalidateGrantCache(). Automatic status changes (job / rotation) are not logged here.
import "server-only"
import { randomUUID } from "node:crypto"
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm"

import { apifyErrors } from "@/lib/i18n/vi/apify-errors"
import {
  isUsableApifyStatus,
  type ApifyAccountPreview,
  type ApifyTokenDetail,
  type ApifyTokenDto,
  type ApifyTokenScope,
  type ApifyTokenStatus,
  type McpApifyPoolSummary,
} from "@/lib/schemas/apify"
import { apifyErrorText } from "@/server/apify/errors"
import {
  checkApifySecret,
  checkApifyTokenRow,
  type ApifyCheckResult,
} from "@/server/apify/health"
import { APIFY_RESERVATION_STATUS } from "@/server/apify/pool"
import {
  accountColumns,
  encryptApifyToken,
  loadApifyTokenRow,
  loadGrantApifyTokens,
  type ApifyStatusPatch,
  type ApifyTokenRow,
} from "@/server/apify/store"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import type { AppUser } from "@/server/auth/session"
import { lastChars } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  apifyRuns,
  apifyTokens,
  mcpServers,
  user as userTable,
} from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"
import {
  disclaimerAuditMeta,
  type CreateAudit,
} from "@/server/services/disclaimers"

export { loadGrantApifyTokens }

const m = apifyErrors.service
const TARGET = "apify_token"
const RECENT_RUNS = 20

export type ApifyActor = Pick<AppUser, "id" | "email" | "role">

/** Expected, user-facing failure (Vietnamese message, safe to show), optionally per form field. */
export class ApifyServiceError extends Error {
  readonly fieldErrors?: Record<string, string>
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = "ApifyServiceError"
    this.fieldErrors = fieldErrors
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function scopeOf(v: string): ApifyTokenScope {
  return v === "company" ? "company" : "personal"
}

function statusOf(v: string): ApifyTokenStatus {
  return v === "exhausted" ||
    v === "invalid" ||
    v === "error" ||
    v === "disabled"
    ? v
    : "active"
}

/** admins: every token; staff: company tokens + their own */
function canView(
  actor: ApifyActor,
  row: Pick<ApifyTokenRow, "scope" | "ownerId">
): boolean {
  return (
    actor.role === "admin" ||
    row.scope === "company" ||
    row.ownerId === actor.id
  )
}

/** admins: every token; staff: their own personal tokens */
function canManage(
  actor: ApifyActor,
  row: Pick<ApifyTokenRow, "scope" | "ownerId">
): boolean {
  return (
    actor.role === "admin" ||
    (row.scope === "personal" && row.ownerId === actor.id)
  )
}

/** SQL filter of the tokens `actor` may see */
function visibleTo(actor: ApifyActor): SQL | undefined {
  return actor.role === "admin"
    ? undefined
    : or(eq(apifyTokens.scope, "company"), eq(apifyTokens.ownerId, actor.id))
}

/**
 * WHERE of a write based on `row` as it was read: still live, still holding the same token (not replaced meanwhile)
 * and - when the write may change the status - not disabled meanwhile.
 */
function unchangedSince(
  row: Pick<ApifyTokenRow, "id" | "credentialsEncrypted">,
  writesStatus: boolean
): SQL {
  return and(
    eq(apifyTokens.id, row.id),
    isNull(apifyTokens.deletedAt),
    eq(apifyTokens.credentialsEncrypted, row.credentialsEncrypted),
    writesStatus ? ne(apifyTokens.status, "disabled") : undefined
  )!
}

function toDto(
  actor: ApifyActor,
  row: ApifyTokenRow,
  ownerName: string | null
): ApifyTokenDto {
  const manage = canManage(actor, row)
  return {
    id: row.id,
    name: row.name,
    scope: scopeOf(row.scope),
    ownerId: row.ownerId,
    ownerName,
    // staff viewing a company token: no hint (not theirs to recognise / replace)
    credentialHint: manage ? row.credentialHint : "",
    apifyUsername: row.apifyUsername,
    planId: row.planId,
    planTier: row.planTier,
    usageUsd: row.usageUsd,
    limitUsd: row.limitUsd,
    cycleEndAt: iso(row.cycleEndAt),
    status: statusOf(row.status),
    statusMessage: row.statusMessage,
    exhaustedUntil: iso(row.exhaustedUntil),
    lastCheckedAt: iso(row.lastCheckedAt),
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: row.createdAt.toISOString(),
    canManage: manage,
  }
}

async function ownerNameOf(ownerId: string): Promise<string | null> {
  const [o] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, ownerId))
    .limit(1)
  return o?.name ?? null
}

/** A live token the actor may see; otherwise a generic "not found" (never reveals other people's tokens). */
async function getVisibleRow(
  actor: ApifyActor,
  id: string
): Promise<ApifyTokenRow> {
  const row = await loadApifyTokenRow(id)
  if (!row || !canView(actor, row)) throw new ApifyServiceError(m.notFound)
  return row
}

/** A live token the actor may manage (visible but read-only → "admins only"). */
async function getManagedRow(
  actor: ApifyActor,
  id: string
): Promise<ApifyTokenRow> {
  const row = await getVisibleRow(actor, id)
  if (!canManage(actor, row)) throw new ApifyServiceError(m.readOnly)
  return row
}

/** live MCPs with apify_enabled = true that rotate through `row` (company: every such MCP; personal: the owner's) */
function mcpsUsing(row: Pick<ApifyTokenRow, "scope" | "ownerId">): SQL {
  return and(
    isNull(mcpServers.deletedAt),
    sql`(${mcpServers.settings} -> 'apify_enabled') = 'true'::jsonb`,
    row.scope === "company" ? undefined : eq(mcpServers.ownerId, row.ownerId)
  )!
}

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

/** Admin: every live token. Staff: company tokens (read-only) + their own personal tokens. Never the secret. */
export async function listApifyTokens(
  actor: ApifyActor
): Promise<ApifyTokenDto[]> {
  const rows = await db
    .select({ token: apifyTokens, ownerName: userTable.name })
    .from(apifyTokens)
    .innerJoin(userTable, eq(userTable.id, apifyTokens.ownerId))
    .where(and(isNull(apifyTokens.deletedAt), visibleTo(actor)))
    .orderBy(desc(apifyTokens.createdAt), desc(apifyTokens.id))
  return rows.map((r) => toDto(actor, r.token, r.ownerName))
}

/** /connections/apify/[id]: DTO + MCPs using it (others' anonymised for staff) + recent runs (staff: own MCPs only). */
export async function getApifyTokenDetail(
  actor: ApifyActor,
  id: string
): Promise<ApifyTokenDetail> {
  const row = await getVisibleRow(actor, id)
  const [ownerName, mcps, runs] = await Promise.all([
    ownerNameOf(row.ownerId),
    db
      .select({
        id: mcpServers.id,
        name: mcpServers.name,
        ownerId: mcpServers.ownerId,
        ownerName: userTable.name,
      })
      .from(mcpServers)
      .innerJoin(userTable, eq(userTable.id, mcpServers.ownerId))
      .where(mcpsUsing(row))
      .orderBy(mcpServers.name),
    db
      .select({
        id: apifyRuns.id,
        mcpName: mcpServers.name,
        mcpOwnerId: mcpServers.ownerId,
        actorId: apifyRuns.actorId,
        taskKey: apifyRuns.taskKey,
        status: apifyRuns.status,
        usageUsd: apifyRuns.usageUsd,
        startedAt: apifyRuns.startedAt,
      })
      .from(apifyRuns)
      .innerJoin(mcpServers, eq(mcpServers.id, apifyRuns.mcpId))
      .where(
        and(
          eq(apifyRuns.tokenId, row.id),
          // an in-flight daily-cap reservation carries a placeholder token: not a run of this token
          ne(apifyRuns.status, APIFY_RESERVATION_STATUS),
          actor.role === "admin" ? undefined : eq(mcpServers.ownerId, actor.id)
        )
      )
      .orderBy(desc(apifyRuns.createdAt), desc(apifyRuns.id))
      .limit(RECENT_RUNS),
  ])
  return {
    ...toDto(actor, row, ownerName),
    mcpUsage: mcps.map((x) => {
      const visible = actor.role === "admin" || x.ownerId === actor.id
      return {
        mcpId: visible ? x.id : null,
        mcpName: visible ? x.name : m.otherMcp,
        ownerName: visible ? x.ownerName : null,
      }
    }),
    recentRuns: runs.map((r) => ({
      id: r.id,
      mcpName: r.mcpName,
      actorId: r.actorId,
      taskKey: r.taskKey,
      status: r.status,
      usageUsd: r.usageUsd,
      startedAt: r.startedAt.toISOString(),
    })),
  }
}

/**
 * Apify card of the MCP wizard for an MCP owned by `owner`: company tokens + the owner's personal tokens that are
 * not disabled / invalid (no secrets, no names of other people's tokens).
 */
export async function getMcpApifyPoolSummary(owner: {
  id: string
  role: "admin" | "staff"
}): Promise<McpApifyPoolSummary> {
  const rows = await db
    .select({
      id: apifyTokens.id,
      scope: apifyTokens.scope,
      apifyUserId: apifyTokens.apifyUserId,
      status: apifyTokens.status,
      exhaustedUntil: apifyTokens.exhaustedUntil,
    })
    .from(apifyTokens)
    .where(
      and(
        isNull(apifyTokens.deletedAt),
        // exactly the tokens the grant rotates through (loadGrantApifyTokens)
        inArray(apifyTokens.status, ["active", "exhausted"]),
        or(
          eq(apifyTokens.scope, "company"),
          and(
            eq(apifyTokens.scope, "personal"),
            eq(apifyTokens.ownerId, owner.id)
          )
        )
      )
    )
  const now = Date.now()
  const accounts = new Set(
    rows.map((r) => (r.apifyUserId ? `u:${r.apifyUserId}` : `t:${r.id}`))
  )
  return {
    tokens: rows.length,
    accounts: accounts.size,
    usableNow: rows.filter((r) =>
      isUsableApifyStatus(statusOf(r.status), iso(r.exhaustedUntil), now)
    ).length,
    company: rows.filter((r) => r.scope === "company").length,
    personal: rows.filter((r) => r.scope !== "company").length,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Check / create
// ---------------------------------------------------------------------------------------------------------------

/** Apify check of a pasted token → account info, or ApifyServiceError on the `token` field. */
async function checkOrThrow(
  token: string
): Promise<Extract<ApifyCheckResult, { kind: "ok" }>> {
  const r = await checkApifySecret(token)
  if (r.kind === "ok") return r
  if (r.kind === "transient") {
    if (r.error.code !== "aborted")
      console.error("[apify-tokens] check failed:", safeErrorForLog(r.error))
    throw new ApifyServiceError(m.unavailable)
  }
  // Apify refused the token (401, disabled account, scoped token without access to /users/me…): not saved.
  // An account merely out of credit answers normally (kind "ok", status exhausted) and IS accepted.
  const text = r.error ? apifyErrorText(r.error) : (r.patch.statusMessage ?? m.unavailable)
  throw new ApifyServiceError(text, { token: text })
}

/** live tokens of this Apify account the viewer may see (staff: company tokens + their own - never other people's) */
async function sameAccountCount(
  actor: ApifyActor,
  apifyUserId: string
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apifyTokens)
    .where(
      and(
        isNull(apifyTokens.deletedAt),
        eq(apifyTokens.apifyUserId, apifyUserId),
        visibleTo(actor)
      )
    )
  return Number(row?.n ?? 0)
}

/** "Kiểm tra": GET /users/me + /users/me/limits with the pasted token. Saves nothing. */
export async function previewApifyToken(
  actor: ApifyActor,
  token: string
): Promise<ApifyAccountPreview> {
  const { account } = await checkOrThrow(token)
  return {
    apifyUserId: account.apifyUserId,
    username: account.username,
    planId: account.planId,
    planTier: account.planTier,
    usageUsd: account.usageUsd,
    limitUsd: account.limitUsd,
    cycleEndAt: account.cycleEndAt,
    actorsEnabled: account.actorsEnabled,
    sameAccountTokens: await sameAccountCount(actor, account.apifyUserId),
  }
}

/** Status columns implied by a check (a disabled token stays disabled). */
function statusColumns(patch: ApifyStatusPatch) {
  return {
    status: patch.status,
    statusMessage: patch.statusMessage,
    exhaustedUntil:
      patch.status === "exhausted" ? (patch.exhaustedUntil ?? null) : null,
  }
}

/** "Lưu": checks the token with Apify (outside the transaction), then insert + activity log in one transaction. */
export async function createApifyToken(
  actor: ApifyActor,
  input: { name: string; token: string; scope: ApifyTokenScope },
  audit?: CreateAudit
): Promise<{ id: string }> {
  if (input.scope === "company" && actor.role !== "admin")
    throw new ApifyServiceError(m.scopeAdminOnly, { scope: m.scopeAdminOnly })
  const token = input.token.trim()
  const name = input.name.trim()
  const check = await checkOrThrow(token)
  const id = randomUUID()
  const hint = lastChars(token)
  await db.transaction(async (tx) => {
    await tx.insert(apifyTokens).values({
      id,
      scope: input.scope,
      ownerId: actor.id,
      name,
      credentialsEncrypted: encryptApifyToken(id, token),
      credentialHint: hint,
      ...accountColumns(check.account),
      ...statusColumns(check.patch),
      lastCheckedAt: new Date(),
    })
    await logActivity(
      {
        actor: actorOf(actor),
        action: "apify_token.create",
        target: { type: TARGET, id, label: name },
        metadata: {
          name,
          scope: input.scope,
          credentialHint: hint,
          apifyUsername: check.account.username,
          planId: check.account.planId,
          status: check.patch.status,
          ...disclaimerAuditMeta(audit),
        },
      },
      tx
    )
  })
  invalidateGrantCache()
  return { id }
}

// ---------------------------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------------------------

export async function renameApifyToken(
  actor: ApifyActor,
  input: { id: string; name: string }
): Promise<void> {
  const row = await getManagedRow(actor, input.id)
  const name = input.name.trim()
  if (name === row.name) return
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(apifyTokens)
      .set({ name })
      .where(and(eq(apifyTokens.id, row.id), isNull(apifyTokens.deletedAt)))
      .returning({ id: apifyTokens.id })
    if (updated.length === 0) throw new ApifyServiceError(m.notFound)
    await logActivity(
      {
        actor: actorOf(actor),
        action: "apify_token.update",
        target: { type: TARGET, id: row.id, label: name },
        metadata: { before: { name: row.name }, after: { name } },
      },
      tx
    )
  })
  invalidateGrantCache()
}

export async function setApifyTokenEnabled(
  actor: ApifyActor,
  input: { id: string; enabled: boolean }
): Promise<void> {
  const row = await getManagedRow(actor, input.id)
  const isDisabled = row.status === "disabled"
  if (input.enabled !== isDisabled) return
  const status: ApifyTokenStatus = input.enabled ? "active" : "disabled"
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(apifyTokens)
      .set({ status, statusMessage: null, exhaustedUntil: null })
      .where(and(eq(apifyTokens.id, row.id), isNull(apifyTokens.deletedAt)))
      .returning({ id: apifyTokens.id })
    if (updated.length === 0) throw new ApifyServiceError(m.notFound)
    await logActivity(
      {
        actor: actorOf(actor),
        action: input.enabled ? "apify_token.enable" : "apify_token.disable",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: { before: { status: row.status }, after: { status } },
      },
      tx
    )
  })
  invalidateGrantCache()
}

/** New secret (checked with Apify first). The caller (action) must have re-authenticated the user. */
export async function replaceApifyTokenSecret(
  actor: ApifyActor,
  input: { id: string; token: string }
): Promise<void> {
  const row = await getManagedRow(actor, input.id)
  const token = input.token.trim()
  const check = await checkOrThrow(token)
  // runs already started stay pinned to this row: a token of ANOTHER Apify account could not read them
  if (row.apifyUserId && check.account.apifyUserId !== row.apifyUserId)
    throw new ApifyServiceError(m.otherAccount, { token: m.otherAccount })
  const hint = lastChars(token)
  const keepDisabled = row.status === "disabled"
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(apifyTokens)
      .set({
        credentialsEncrypted: encryptApifyToken(row.id, token),
        credentialHint: hint,
        ...accountColumns(check.account),
        ...(keepDisabled ? {} : statusColumns(check.patch)),
        lastCheckedAt: new Date(),
      })
      .where(unchangedSince(row, !keepDisabled))
      .returning({ id: apifyTokens.id })
    // replaced / disabled / deleted by someone else while Apify was being asked: nothing written, nothing logged
    if (updated.length === 0) throw new ApifyServiceError(m.conflict)
    await logActivity(
      {
        actor: actorOf(actor),
        action: "apify_token.replace_token",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: {
          before: {
            credentialHint: row.credentialHint,
            apifyUsername: row.apifyUsername,
            status: row.status,
          },
          after: {
            credentialHint: hint,
            apifyUsername: check.account.username,
            status: keepDisabled ? "disabled" : check.patch.status,
          },
          sameAccount: row.apifyUserId === check.account.apifyUserId,
        },
      },
      tx
    )
  })
  invalidateGrantCache()
}

/**
 * "Kiểm tra lại": re-check the stored token. Pass → account info + active / exhausted; Apify refuses it → invalid /
 * error with the Vietnamese reason (returned in the DTO); Apify unreachable → status unchanged, activity logged as a
 * failure, ApifyServiceError thrown. A disabled token keeps its status (info is still refreshed).
 */
export async function recheckApifyToken(
  actor: ApifyActor,
  id: string
): Promise<ApifyTokenDto> {
  const row = await getManagedRow(actor, id)
  const r = await checkApifyTokenRow(row)
  const keep = row.status === "disabled"
  const after: ApifyTokenStatus =
    r.kind === "transient" || keep ? statusOf(row.status) : r.patch.status
  await db.transaction(async (tx) => {
    if (r.kind !== "transient") {
      const updated = await tx
        .update(apifyTokens)
        .set({
          ...(r.kind === "ok" ? accountColumns(r.account) : {}),
          ...(keep ? {} : statusColumns(r.patch)),
          lastCheckedAt: new Date(),
          // a check is not an edit
          updatedAt: sql`${apifyTokens.updatedAt}`,
        })
        .where(unchangedSince(row, !keep))
        .returning({ id: apifyTokens.id })
      // the token was replaced / disabled / deleted meanwhile: never write the old token's result over it
      if (updated.length === 0) throw new ApifyServiceError(m.conflict)
    }
    await logActivity(
      {
        actor: actorOf(actor),
        action: "apify_token.recheck",
        target: { type: TARGET, id: row.id, label: row.name },
        status: r.kind === "ok" ? "success" : "failure",
        metadata: {
          before: { status: row.status },
          after: { status: after },
          message:
            r.kind === "ok"
              ? null
              : r.kind === "transient"
                ? r.error.userMessageVi
                : r.patch.statusMessage,
        },
      },
      tx
    )
  })
  if (r.kind === "transient") {
    if (r.error.code !== "aborted")
      console.error("[apify-tokens] recheck failed:", safeErrorForLog(r.error))
    throw new ApifyServiceError(m.unavailable)
  }
  invalidateGrantCache()
  const fresh = (await loadApifyTokenRow(row.id)) ?? row
  return toDto(actor, fresh, await ownerNameOf(fresh.ownerId))
}

/**
 * Soft delete after the name was typed: wipes the secret (re-encrypted ""), logs how many MCPs rotated through it.
 * Run records keep pointing at the row (FK RESTRICT); their results cannot be read any more.
 */
export async function deleteApifyToken(
  actor: ApifyActor,
  input: { id: string; confirmName: string }
): Promise<void> {
  const row = await getManagedRow(actor, input.id)
  if (input.confirmName.trim() !== row.name.trim())
    throw new ApifyServiceError(m.confirmName, { confirmName: m.confirmName })
  const [affected] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mcpServers)
    .where(mcpsUsing(row))
  const affectedMcpCount = Number(affected?.n ?? 0)
  await db.transaction(async (tx) => {
    await tx
      .update(apifyTokens)
      .set({
        deletedAt: new Date(),
        credentialsEncrypted: encryptApifyToken(row.id, ""),
        statusMessage: null,
      })
      .where(and(eq(apifyTokens.id, row.id), isNull(apifyTokens.deletedAt)))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "apify_token.delete",
        target: { type: TARGET, id: row.id, label: row.name },
        metadata: {
          name: row.name,
          scope: row.scope,
          credentialHint: row.credentialHint,
          apifyUsername: row.apifyUsername,
          affectedMcpCount,
        },
      },
      tx
    )
  })
  invalidateGrantCache()
}
