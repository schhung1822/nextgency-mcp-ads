// Google Drive - DB helpers for credentials and sources (15-google-drive-media.md §4, §10). No imports from "next/*".
// Secrets are encrypted at rest (AES-256-GCM, AAD bound to the row id) and decrypted lazily, only when a Google
// call needs them. Nothing here logs; callers must never return decrypted values to a client or the AI.
import { and, eq, isNull } from "drizzle-orm"

import {
  aad,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
} from "@/server/crypto/secret-box"
import { db, type Tx } from "@/server/db/client"
import {
  driveCredentials,
  driveMediaUploads,
  driveRelayLinks,
  driveSources,
} from "@/server/db/schema"

import { DriveError } from "./errors"
import {
  DEFAULT_SHEET_COLUMNS,
  DRIVE_LIMITS,
  type DriveAuth,
  type FolderSourceConfig,
  type GoogleServiceAccount,
  type SheetColumnsConfig,
  type SheetSourceConfig,
} from "./types"

export type DriveCredentialRow = typeof driveCredentials.$inferSelect
export type NewDriveCredentialRow = typeof driveCredentials.$inferInsert
export type DriveSourceRow = typeof driveSources.$inferSelect
export type NewDriveSourceRow = typeof driveSources.$inferInsert
export type DriveMediaUploadRow = typeof driveMediaUploads.$inferSelect
export type DriveRelayLinkRow = typeof driveRelayLinks.$inferSelect

type DbLike = Tx | typeof db

/** Token cache key of a credential (getGoogleAccessToken / invalidateGoogleAccessTokens). */
export function driveCredentialCacheKey(credentialId: string): string {
  return `drive_credential:${credentialId}`
}

// ---- encryption (the only place that knows the stored formats) -------------------------------------------

/**
 * credentials_encrypted = JSON of the normalised GoogleServiceAccount (not the raw downloaded file):
 * { clientEmail, privateKey, privateKeyId, projectId }.
 */
export function encryptServiceAccount(
  credentialId: string,
  sa: GoogleServiceAccount
): string {
  const value: GoogleServiceAccount = {
    clientEmail: sa.clientEmail,
    privateKey: sa.privateKey,
    privateKeyId: sa.privateKeyId ?? null,
    projectId: sa.projectId ?? null,
  }
  return encryptJson(value, aad.driveCredential(credentialId))
}

/** Decrypt + shape-check; any failure (wrong key, damaged row, bad shape) → DriveError auth_failed. */
export function decryptServiceAccount(
  row: Pick<DriveCredentialRow, "id" | "credentialsEncrypted">
): GoogleServiceAccount {
  let v: Partial<GoogleServiceAccount> | null
  try {
    v = decryptJson<Partial<GoogleServiceAccount> | null>(
      row.credentialsEncrypted,
      aad.driveCredential(row.id)
    )
  } catch {
    // never chain the cause: it may describe the ciphertext
    throw new DriveError("auth_failed")
  }
  if (
    !v ||
    typeof v.clientEmail !== "string" ||
    !v.clientEmail ||
    typeof v.privateKey !== "string" ||
    !v.privateKey.includes("PRIVATE KEY")
  ) {
    throw new DriveError("auth_failed")
  }
  return {
    clientEmail: v.clientEmail,
    privateKey: v.privateKey,
    privateKeyId: typeof v.privateKeyId === "string" ? v.privateKeyId : null,
    projectId: typeof v.projectId === "string" ? v.projectId : null,
  }
}

export function encryptDriveApiKey(
  credentialId: string,
  apiKey: string
): string {
  return encryptSecret(apiKey, aad.driveCredentialApiKey(credentialId))
}

export function decryptDriveApiKey(
  row: Pick<DriveCredentialRow, "id" | "apiKeyEncrypted">
): string | null {
  if (!row.apiKeyEncrypted) return null
  try {
    return decryptSecret(row.apiKeyEncrypted, aad.driveCredentialApiKey(row.id))
  } catch {
    throw new DriveError("api_key_invalid")
  }
}

export function encryptSourceResourceKey(
  sourceId: string,
  resourceKey: string | null | undefined
): string | null {
  return resourceKey
    ? encryptSecret(resourceKey, aad.driveSourceResourceKey(sourceId))
    : null
}

export function decryptSourceResourceKey(
  row: Pick<DriveSourceRow, "id" | "resourceKeyEncrypted">
): string | null {
  if (!row.resourceKeyEncrypted) return null
  try {
    return decryptSecret(
      row.resourceKeyEncrypted,
      aad.driveSourceResourceKey(row.id)
    )
  } catch {
    // ENCRYPTION_KEYS problem (operator), not a Drive error; no cause (it may describe the ciphertext)
    throw new Error("drive_source resource key cannot be decrypted")
  }
}

// ---- auth --------------------------------------------------------------------------------------------------

/** Service-account auth of a credential row (status / deleted checks are the caller's business). */
export function driveAuthForCredential(
  row: Pick<DriveCredentialRow, "id" | "credentialsEncrypted">
): DriveAuth {
  return {
    type: "service_account",
    sa: decryptServiceAccount(row),
    cacheKey: driveCredentialCacheKey(row.id),
  }
}

/** true when a credential may be used for Google calls (not deleted, not disabled; "error" is retried). */
export function isDriveCredentialUsable(
  row: Pick<DriveCredentialRow, "deletedAt" | "status">
): boolean {
  return !row.deletedAt && row.status !== "disabled"
}

// ---- loaders -----------------------------------------------------------------------------------------------

/** The live (not deleted) system credential, whatever its status, or null. */
export async function loadSystemDriveCredential(
  tx: DbLike = db
): Promise<DriveCredentialRow | null> {
  const [row] = await tx
    .select()
    .from(driveCredentials)
    .where(
      and(
        eq(driveCredentials.kind, "system"),
        isNull(driveCredentials.deletedAt)
      )
    )
    .limit(1)
  return row ?? null
}

/** A live (not deleted) credential by id, whatever its status, or null. */
export async function loadDriveCredential(
  id: string,
  tx: DbLike = db
): Promise<DriveCredentialRow | null> {
  if (!isUuid(id)) return null
  const [row] = await tx
    .select()
    .from(driveCredentials)
    .where(and(eq(driveCredentials.id, id), isNull(driveCredentials.deletedAt)))
    .limit(1)
  return row ?? null
}

/**
 * Anonymous API-key auth for public "Anyone with the link" files: the usable system credential's API key, or null
 * when Drive is not configured, the credential is disabled or no API key was saved.
 */
export async function systemApiKeyAuth(
  tx: DbLike = db
): Promise<Extract<DriveAuth, { type: "api_key" }> | null> {
  const row = await loadSystemDriveCredential(tx)
  if (!row || !isDriveCredentialUsable(row) || !row.apiKeyEncrypted) return null
  const apiKey = decryptDriveApiKey(row)
  return apiKey ? { type: "api_key", apiKey } : null
}

/** A live (not deleted) source by id, whatever its status, or null. */
export async function loadDriveSource(
  id: string,
  tx: DbLike = db
): Promise<DriveSourceRow | null> {
  if (!isUuid(id)) return null
  const [row] = await tx
    .select()
    .from(driveSources)
    .where(and(eq(driveSources.id, id), isNull(driveSources.deletedAt)))
    .limit(1)
  return row ?? null
}

// ---- config (jsonb is untrusted shape-wise: normalise on read) ----------------------------------------------

export function normalizeFolderConfig(raw: unknown): FolderSourceConfig {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >
  const d = Number(v.recursiveDepth)
  return {
    recursiveDepth: Number.isInteger(d)
      ? Math.min(Math.max(d, 0), DRIVE_LIMITS.recursiveMaxDepth)
      : 0,
  }
}

export function normalizeSheetConfig(raw: unknown): SheetSourceConfig {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >
  const h = Number(v.headerRow)
  const c = (v.columns && typeof v.columns === "object" ? v.columns : {}) as
    Record<string, unknown> | undefined
  const columns: SheetColumnsConfig = {
    link:
      typeof c?.link === "string" && c.link.trim()
        ? c.link
        : DEFAULT_SHEET_COLUMNS.link,
  }
  for (const k of Object.keys(
    DEFAULT_SHEET_COLUMNS
  ) as (keyof SheetColumnsConfig)[]) {
    if (k === "link") continue
    const val = c?.[k]
    columns[k] = typeof val === "string" && val.trim() ? val : null
  }
  return {
    headerRow: Number.isInteger(h) && h >= 1 && h <= 100 ? h : 1,
    columns,
    writeback: v.writeback === true,
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ids come from the AI / URLs: a malformed uuid must read as "not found", not as a Postgres cast error. */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}
