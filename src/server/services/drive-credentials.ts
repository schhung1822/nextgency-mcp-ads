// Google Drive credentials service (15-google-drive-media.md §4, §5.3, §10):
// - system credential (admin only, ONE live row): service account JSON + optional API key (public links);
//   everybody may read { configured, clientEmail, hasApiKey } to share folders with the email;
// - personal credentials (advanced): a user's own service account, used only for that user's sources.
// Secrets are encrypted at rest (src/server/drive/store.ts, AAD bound to the row id) and NEVER returned: DTOs carry
// hints only (last 4 chars). Google calls run outside DB transactions; every change writes activity_logs in the same
// transaction. Re-authentication for the system credential is done by the action (src/server/actions/drive.ts).
import "server-only"
import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm"

import { driveUi } from "@/lib/i18n/vi/drive-ui"
import type {
  DriveCredentialTestResult,
  DriveStatusDto,
  DriveSystemInfo,
  PersonalDriveCredentialDto,
  SystemDriveCredentialDto,
} from "@/lib/schemas/drive"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { canAccessOwned, type AppUser } from "@/server/auth/session"
import { lastChars } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  driveCredentials,
  driveSources,
  user as userTable,
} from "@/server/db/schema"
import { toDriveError } from "@/server/drive/client"
import { isDriveError } from "@/server/drive/errors"
import { checkServiceAccountAccess } from "@/server/drive/files"
import {
  driveAuthForCredential,
  driveCredentialCacheKey,
  encryptDriveApiKey,
  encryptServiceAccount,
  isUuid,
  loadDriveCredential,
  loadSystemDriveCredential,
  type DriveCredentialRow,
} from "@/server/drive/store"
import type { DriveAuth, GoogleServiceAccount } from "@/server/drive/types"
import {
  invalidateGoogleAccessTokens,
  isGoogleAuthError,
  parseServiceAccountJson,
} from "@/server/google/service-account"
import { invalidateGrantCache } from "@/server/mcp/grant"

const m = driveUi.service
const TARGET = "drive_credential"

export type DriveActor = Pick<AppUser, "id" | "email" | "role">

/** Expected, user-facing failure (Vietnamese message, safe to show). */
export class DriveServiceError extends Error {
  readonly fieldErrors?: Record<string, string>
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = "DriveServiceError"
    this.fieldErrors = fieldErrors
  }
}

/** Vietnamese "message. hint" of a DriveError / GoogleAuthError, null for anything else. */
export function driveErrorMessage(e: unknown): string | null {
  if (!isDriveError(e) && !isGoogleAuthError(e)) return null
  const d = toDriveError(e)
  return d.hintVi ? `${d.userMessageVi} ${d.hintVi}` : d.userMessageVi
}

/**
 * Any failure of a Google call → DriveServiceError (DriveError: its Vietnamese message + hint, on `field` when
 * given). Unexpected errors are logged (redacted) and shown as "Google Drive unavailable".
 */
export function toDriveServiceError(
  e: unknown,
  field?: string,
  where = "drive"
): DriveServiceError {
  if (e instanceof DriveServiceError) return e
  const msg = driveErrorMessage(e)
  if (msg)
    return new DriveServiceError(msg, field ? { [field]: msg } : undefined)
  console.error(`[${where}] google call failed:`, safeErrorForLog(e))
  return new DriveServiceError(m.googleUnavailable)
}

/** DriveError codes that mean "the configuration is broken" (vs. Google being temporarily unavailable). */
export function isConfigProblem(e: unknown): boolean {
  if (isGoogleAuthError(e)) return !toDriveError(e).retryable
  return isDriveError(e) && !e.retryable
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function statusOf(v: string): DriveStatusDto {
  return v === "error" || v === "disabled" ? v : "active"
}

function requireAdmin(actor: DriveActor): void {
  if (actor.role !== "admin") throw new DriveServiceError(m.adminOnly)
}

/** Parse the pasted JSON key (Vietnamese errors on the serviceAccountJson field; the input is never echoed). */
function parseKeyOrThrow(raw: string): GoogleServiceAccount {
  try {
    return parseServiceAccountJson(raw)
  } catch (e) {
    const msg =
      (isGoogleAuthError(e) && e.userMessageVi) || m.invalidServiceAccount
    throw new DriveServiceError(msg, { serviceAccountJson: msg })
  }
}

/** Token + files.list with a not-yet-saved key (cache key unique to this check, dropped afterwards). */
async function checkKeyOrThrow(sa: GoogleServiceAccount): Promise<void> {
  const cacheKey = `drive_check:${randomUUID()}`
  try {
    await checkServiceAccountAccess({ type: "service_account", sa, cacheKey })
  } catch (e) {
    throw toDriveServiceError(e, "serviceAccountJson", "drive-credentials")
  } finally {
    invalidateGoogleAccessTokens(cacheKey)
  }
}

async function liveSourceCounts(
  credentialIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (credentialIds.length === 0) return out
  const rows = await db
    .select({
      credentialId: driveSources.credentialId,
      n: sql<number>`count(*)::int`,
    })
    .from(driveSources)
    .where(
      and(
        inArray(driveSources.credentialId, credentialIds),
        isNull(driveSources.deletedAt)
      )
    )
    .groupBy(driveSources.credentialId)
  for (const r of rows) out.set(r.credentialId, Number(r.n))
  return out
}

/** A live service account with the same client_email (system or personal, other than `exceptId`). */
async function emailTaken(
  clientEmail: string,
  exceptId?: string
): Promise<DriveCredentialRow | null> {
  const [row] = await db
    .select()
    .from(driveCredentials)
    .where(
      and(
        isNull(driveCredentials.deletedAt),
        sql`lower(${driveCredentials.clientEmail}) = lower(${clientEmail})`,
        exceptId ? ne(driveCredentials.id, exceptId) : undefined
      )
    )
    .limit(1)
  return row ?? null
}

// ---------------------------------------------------------------------------
// System credential
// ---------------------------------------------------------------------------

/** For every signed-in user: is Drive configured, which email to share folders with, are public links possible. */
export async function getDriveSystemInfo(): Promise<DriveSystemInfo> {
  const row = await loadSystemDriveCredential()
  if (!row)
    return {
      configured: false,
      clientEmail: null,
      hasApiKey: false,
      status: null,
    }
  return {
    configured: true,
    clientEmail: row.clientEmail,
    hasApiKey: !!row.apiKeyEncrypted,
    status: statusOf(row.status),
  }
}

function projectIdHint(row: DriveCredentialRow): string | null {
  // the project id is part of the client email (<name>@<project>.iam.gserviceaccount.com) - not a secret
  const m2 = /@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/i.exec(row.clientEmail)
  return m2?.[1] ?? null
}

function systemDto(
  row: DriveCredentialRow | null,
  sourceCount: number
): SystemDriveCredentialDto {
  if (!row)
    return {
      configured: false,
      clientEmail: null,
      hasApiKey: false,
      status: null,
      id: null,
      projectId: null,
      credentialHint: null,
      apiKeyHint: null,
      statusMessage: null,
      lastCheckedAt: null,
      createdAt: null,
      updatedAt: null,
      sourceCount: 0,
    }
  return {
    configured: true,
    clientEmail: row.clientEmail,
    hasApiKey: !!row.apiKeyEncrypted,
    status: statusOf(row.status),
    id: row.id,
    projectId: projectIdHint(row),
    credentialHint: row.credentialHint || null,
    apiKeyHint: row.apiKeyEncrypted ? row.apiKeyHint : null,
    statusMessage: row.statusMessage,
    lastCheckedAt: iso(row.lastCheckedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sourceCount,
  }
}

/** Settings → Google Drive card (admin only). */
export async function getSystemDriveCredential(
  actor: DriveActor
): Promise<SystemDriveCredentialDto> {
  requireAdmin(actor)
  const row = await loadSystemDriveCredential()
  const counts = row ? await liveSourceCounts([row.id]) : new Map()
  return systemDto(row, row ? (counts.get(row.id) ?? 0) : 0)
}

/**
 * Create or replace the system credential (admin; the action re-authenticates first).
 * serviceAccountJson: required when none exists, omitted = keep (else parsed + checked with Google);
 * apiKey: omitted = keep, clearApiKey removes it (format check only - a test call needs a public file, UNVERIFIED).
 */
export async function saveSystemDriveCredential(
  actor: DriveActor,
  input: { serviceAccountJson?: string; apiKey?: string; clearApiKey?: boolean }
): Promise<SystemDriveCredentialDto> {
  requireAdmin(actor)
  if (input.apiKey && input.clearApiKey)
    throw new DriveServiceError(m.apiKeyConflict, { apiKey: m.apiKeyConflict })
  const existing = await loadSystemDriveCredential()
  if (!existing && !input.serviceAccountJson)
    throw new DriveServiceError(m.serviceAccountRequired, {
      serviceAccountJson: m.serviceAccountRequired,
    })
  const sa = input.serviceAccountJson
    ? parseKeyOrThrow(input.serviceAccountJson)
    : null
  if (sa) {
    const taken = await emailTaken(sa.clientEmail, existing?.id)
    if (taken)
      throw new DriveServiceError(m.serviceAccountTaken, {
        serviceAccountJson: m.serviceAccountTaken,
      })
    await checkKeyOrThrow(sa)
  }
  const now = new Date()

  if (!existing) {
    const id = randomUUID()
    try {
      await db.transaction(async (tx) => {
        await tx.insert(driveCredentials).values({
          id,
          kind: "system",
          ownerId: null,
          name: "",
          credentialsEncrypted: encryptServiceAccount(id, sa!),
          apiKeyEncrypted: input.apiKey
            ? encryptDriveApiKey(id, input.apiKey)
            : null,
          apiKeyHint: input.apiKey ? lastChars(input.apiKey) : null,
          clientEmail: sa!.clientEmail,
          credentialHint: sa!.privateKeyId ? lastChars(sa!.privateKeyId) : "",
          status: "active",
          lastCheckedAt: now,
        })
        await logActivity(
          {
            actor: actorOf(actor),
            action: "drive_credential.create",
            target: { type: TARGET, id, label: sa!.clientEmail },
            metadata: {
              kind: "system",
              clientEmail: sa!.clientEmail,
              credentialHint: sa!.privateKeyId
                ? lastChars(sa!.privateKeyId)
                : null,
              hasApiKey: !!input.apiKey,
            },
          },
          tx
        )
      })
    } catch (e) {
      // two admins saving at once: the partial unique index keeps ONE system credential
      if ((e as { code?: unknown })?.code === "23505")
        throw new DriveServiceError(m.generic)
      throw e
    }
    invalidateGrantCache()
    return getSystemDriveCredential(actor)
  }

  const patch: Partial<typeof driveCredentials.$inferInsert> = {}
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  if (sa) {
    patch.credentialsEncrypted = encryptServiceAccount(existing.id, sa)
    patch.clientEmail = sa.clientEmail
    patch.credentialHint = sa.privateKeyId ? lastChars(sa.privateKeyId) : ""
    patch.status = existing.status === "disabled" ? "disabled" : "active"
    patch.statusMessage = null
    patch.lastCheckedAt = now
    before.serviceAccount = {
      clientEmail: existing.clientEmail,
      credentialHint: existing.credentialHint || null,
      status: existing.status,
    }
    after.serviceAccount = {
      clientEmail: sa.clientEmail,
      credentialHint: patch.credentialHint || null,
      status: patch.status,
    }
  }
  if (input.apiKey) {
    patch.apiKeyEncrypted = encryptDriveApiKey(existing.id, input.apiKey)
    patch.apiKeyHint = lastChars(input.apiKey)
    before.apiKeyHint = existing.apiKeyEncrypted ? existing.apiKeyHint : null
    after.apiKeyHint = patch.apiKeyHint
  } else if (input.clearApiKey && existing.apiKeyEncrypted) {
    patch.apiKeyEncrypted = null
    patch.apiKeyHint = null
    before.apiKeyHint = existing.apiKeyHint
    after.apiKeyHint = null
  }
  if (Object.keys(after).length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(driveCredentials)
        .set(patch)
        .where(
          and(
            eq(driveCredentials.id, existing.id),
            isNull(driveCredentials.deletedAt)
          )
        )
      await logActivity(
        {
          actor: actorOf(actor),
          action: "drive_credential.update",
          target: {
            type: TARGET,
            id: existing.id,
            label: patch.clientEmail ?? existing.clientEmail,
          },
          metadata: { kind: "system", before, after },
        },
        tx
      )
    })
    if (sa) invalidateGoogleAccessTokens(driveCredentialCacheKey(existing.id))
    invalidateGrantCache()
  }
  return getSystemDriveCredential(actor)
}

/** Refuse while live (not deleted) sources are read with this credential. */
async function assertUnused(credentialId: string): Promise<void> {
  const n = (await liveSourceCounts([credentialId])).get(credentialId) ?? 0
  if (n > 0) throw new DriveServiceError(m.credentialInUse)
}

async function softDelete(
  actor: DriveActor,
  row: DriveCredentialRow
): Promise<void> {
  await assertUnused(row.id)
  await db.transaction(async (tx) => {
    // re-check inside the transaction: a source created meanwhile keeps the credential alive
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(driveSources)
      .where(
        and(
          eq(driveSources.credentialId, row.id),
          isNull(driveSources.deletedAt)
        )
      )) as [{ n: number }]
    if (Number(n) > 0) throw new DriveServiceError(m.credentialInUse)
    await tx
      .update(driveCredentials)
      .set({
        deletedAt: new Date(),
        // wipe the secrets (the row stays for history / FKs)
        credentialsEncrypted: encryptServiceAccount(row.id, {
          clientEmail: row.clientEmail,
          privateKey: "",
          privateKeyId: null,
          projectId: null,
        }),
        apiKeyEncrypted: null,
        apiKeyHint: null,
        statusMessage: null,
      })
      .where(
        and(eq(driveCredentials.id, row.id), isNull(driveCredentials.deletedAt))
      )
    await logActivity(
      {
        actor: actorOf(actor),
        action: "drive_credential.delete",
        target: {
          type: TARGET,
          id: row.id,
          label: row.name || row.clientEmail,
        },
        metadata: {
          kind: row.kind,
          clientEmail: row.clientEmail,
          ...(row.ownerId && row.ownerId !== actor.id
            ? { ownerId: row.ownerId }
            : {}),
        },
      },
      tx
    )
  })
  invalidateGoogleAccessTokens(driveCredentialCacheKey(row.id))
  invalidateGrantCache()
}

/** Delete the system credential (admin; the action re-authenticates). Refused while sources use it. */
export async function deleteSystemDriveCredential(
  actor: DriveActor
): Promise<void> {
  requireAdmin(actor)
  const row = await loadSystemDriveCredential()
  if (!row) throw new DriveServiceError(m.credentialNotFound)
  await softDelete(actor, row)
}

/**
 * "Kiểm tra" of a stored credential: fresh token + files.list. Pass → active; a configuration problem → error with
 * the Vietnamese reason; Google unreachable → status unchanged. A disabled credential stays disabled.
 * Activity drive_credential.test (success / failure).
 */
async function testRow(
  actor: DriveActor,
  row: DriveCredentialRow
): Promise<DriveCredentialTestResult> {
  let ok = false
  let problem: string | null = null
  let broken = false
  try {
    const auth: DriveAuth = driveAuthForCredential(row)
    await checkServiceAccountAccess(auth)
    ok = true
  } catch (e) {
    problem = driveErrorMessage(e)
    broken = isConfigProblem(e)
    if (!problem) {
      console.error("[drive-credentials] test failed:", safeErrorForLog(e))
      problem = m.googleUnavailable
    }
  }
  const keep = row.status === "disabled"
  const status: DriveStatusDto = keep
    ? "disabled"
    : ok
      ? "active"
      : broken
        ? "error"
        : statusOf(row.status)
  const statusMessage = ok ? null : broken ? problem : row.statusMessage
  await db.transaction(async (tx) => {
    await tx
      .update(driveCredentials)
      .set({
        lastCheckedAt: new Date(),
        ...(keep ? {} : { status, statusMessage }),
      })
      .where(eq(driveCredentials.id, row.id))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "drive_credential.test",
        target: {
          type: TARGET,
          id: row.id,
          label: row.name || row.clientEmail,
        },
        status: ok ? "success" : "failure",
        metadata: {
          kind: row.kind,
          before: { status: row.status },
          after: { status },
          message: problem,
        },
      },
      tx
    )
  })
  if (status !== row.status) invalidateGrantCache()
  return {
    ok,
    status,
    statusMessage: keep ? row.statusMessage : statusMessage,
    clientEmail: row.clientEmail,
  }
}

export async function testSystemDriveCredential(
  actor: DriveActor
): Promise<DriveCredentialTestResult> {
  requireAdmin(actor)
  const row = await loadSystemDriveCredential()
  if (!row) throw new DriveServiceError(m.notConfigured)
  return testRow(actor, row)
}

// ---------------------------------------------------------------------------
// Personal credentials
// ---------------------------------------------------------------------------

/** A live personal credential the actor may access (owner or admin); otherwise "not found". */
async function getOwnedPersonal(
  actor: DriveActor,
  credentialId: string
): Promise<DriveCredentialRow> {
  const row = isUuid(credentialId)
    ? await loadDriveCredential(credentialId)
    : null
  if (
    !row ||
    row.kind !== "personal" ||
    !row.ownerId ||
    !canAccessOwned(actor, row.ownerId)
  )
    throw new DriveServiceError(m.credentialNotFound)
  return row
}

/** Staff: own personal credentials. Admin: everybody's (with owner). Never a secret. */
export async function listPersonalDriveCredentials(
  actor: DriveActor
): Promise<PersonalDriveCredentialDto[]> {
  const rows = await db
    .select({
      c: driveCredentials,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
    })
    .from(driveCredentials)
    .innerJoin(userTable, eq(userTable.id, driveCredentials.ownerId))
    .where(
      and(
        eq(driveCredentials.kind, "personal"),
        isNull(driveCredentials.deletedAt),
        actor.role === "admin"
          ? undefined
          : eq(driveCredentials.ownerId, actor.id)
      )
    )
    .orderBy(desc(driveCredentials.createdAt))
  const counts = await liveSourceCounts(rows.map((r) => r.c.id))
  return rows.map((r) => ({
    id: r.c.id,
    name: r.c.name,
    clientEmail: r.c.clientEmail,
    credentialHint: r.c.credentialHint,
    status: statusOf(r.c.status),
    statusMessage: r.c.statusMessage,
    lastCheckedAt: iso(r.c.lastCheckedAt),
    createdAt: r.c.createdAt.toISOString(),
    owner: { id: r.c.ownerId!, email: r.ownerEmail, name: r.ownerName },
    isMine: r.c.ownerId === actor.id,
    sourceCount: counts.get(r.c.id) ?? 0,
  }))
}

/** Add an own service account (checked with Google). The system service account cannot be added again. */
export async function createPersonalDriveCredential(
  actor: DriveActor,
  input: { name: string; serviceAccountJson: string }
): Promise<{ id: string; clientEmail: string }> {
  const sa = parseKeyOrThrow(input.serviceAccountJson)
  const taken = await emailTaken(sa.clientEmail)
  if (taken) {
    const msg =
      taken.kind === "system" ? m.serviceAccountIsSystem : m.serviceAccountTaken
    throw new DriveServiceError(msg, { serviceAccountJson: msg })
  }
  await checkKeyOrThrow(sa)
  const id = randomUUID()
  await db.transaction(async (tx) => {
    await tx.insert(driveCredentials).values({
      id,
      kind: "personal",
      ownerId: actor.id,
      name: input.name,
      credentialsEncrypted: encryptServiceAccount(id, sa),
      apiKeyEncrypted: null,
      apiKeyHint: null,
      clientEmail: sa.clientEmail,
      credentialHint: sa.privateKeyId ? lastChars(sa.privateKeyId) : "",
      status: "active",
      lastCheckedAt: new Date(),
    })
    await logActivity(
      {
        actor: actorOf(actor),
        action: "drive_credential.create",
        target: { type: TARGET, id, label: input.name },
        metadata: {
          kind: "personal",
          name: input.name,
          clientEmail: sa.clientEmail,
          credentialHint: sa.privateKeyId ? lastChars(sa.privateKeyId) : null,
        },
      },
      tx
    )
  })
  return { id, clientEmail: sa.clientEmail }
}

export async function testPersonalDriveCredential(
  actor: DriveActor,
  credentialId: string
): Promise<DriveCredentialTestResult> {
  return testRow(actor, await getOwnedPersonal(actor, credentialId))
}

/** Owner or admin; refused while live sources use it. */
export async function deletePersonalDriveCredential(
  actor: DriveActor,
  credentialId: string
): Promise<void> {
  await softDelete(actor, await getOwnedPersonal(actor, credentialId))
}
