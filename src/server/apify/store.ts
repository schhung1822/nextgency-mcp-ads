// Apify tokens - DB helpers (16-apify.md §3-§5). No imports from "next/*" or "server-only" (used by the worker job
// apify.health and by src/server/mcp/grant.ts). This is the ONLY module that encrypts / decrypts Apify tokens
// (AES-256-GCM, AAD apify_token:<id>:credentials). Nothing here logs; decrypted tokens never leave the server.
// Automatic status changes (health check, rotation) never bump updated_at (they are not edits).
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm"

import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db, type Tx } from "@/server/db/client"
import { apifyTokens } from "@/server/db/schema"

import type { ApifyAccountInfo, GrantApifyToken } from "./types"

export type ApifyTokenRow = typeof apifyTokens.$inferSelect
type DbLike = Tx | typeof db

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ids come from URLs / the AI: a malformed uuid reads as "not found", not as a Postgres cast error */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

// ---- encryption ----------------------------------------------------------------------------------------------

export function encryptApifyToken(tokenId: string, token: string): string {
  return encryptSecret(token, aad.apifyTokenCredentials(tokenId))
}

/** Thrown when the stored ciphertext cannot be read (ENCRYPTION_KEYS changed / damaged row). No cause attached. */
export class ApifyTokenUnreadableError extends Error {
  constructor() {
    super("apify token cannot be decrypted")
    this.name = "ApifyTokenUnreadableError"
  }
}

/** Plaintext token of a row; "" (deleted row) or a decryption failure → ApifyTokenUnreadableError. */
export function decryptApifyToken(
  row: Pick<ApifyTokenRow, "id" | "credentialsEncrypted">
): string {
  let v: string
  try {
    v = decryptSecret(
      row.credentialsEncrypted,
      aad.apifyTokenCredentials(row.id)
    )
  } catch {
    // never chain the cause: it may describe the ciphertext
    throw new ApifyTokenUnreadableError()
  }
  if (!v) throw new ApifyTokenUnreadableError()
  return v
}

// ---- loaders -------------------------------------------------------------------------------------------------

/** A live (not deleted) token row by id, whatever its status, or null. */
export async function loadApifyTokenRow(
  id: string,
  tx: DbLike = db
): Promise<ApifyTokenRow | null> {
  if (!isUuid(id)) return null
  const [row] = await tx
    .select()
    .from(apifyTokens)
    .where(and(eq(apifyTokens.id, id), isNull(apifyTokens.deletedAt)))
    .limit(1)
  return row ?? null
}

/**
 * Row + plaintext secret of a live token (any status but deleted: a run keeps using its pinned token even when the
 * token was disabled / exhausted meanwhile - reading results and aborting must keep working). null when deleted.
 * Throws ApifyTokenUnreadableError when the ciphertext cannot be read.
 */
export async function loadApifyToken(
  id: string,
  tx: DbLike = db
): Promise<{ row: ApifyTokenRow; secret: string } | null> {
  const row = await loadApifyTokenRow(id, tx)
  if (!row) return null
  return { row, secret: decryptApifyToken(row) }
}

/** non-secret pool view of a row */
export function toGrantApifyToken(
  row: Pick<
    ApifyTokenRow,
    | "id"
    | "name"
    | "scope"
    | "apifyUserId"
    | "status"
    | "exhaustedUntil"
    | "usageUsd"
    | "limitUsd"
    | "cycleEndAt"
    | "lastCheckedAt"
  >
): GrantApifyToken {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope === "company" ? "company" : "personal",
    apifyUserId: row.apifyUserId,
    status: row.status === "exhausted" ? "exhausted" : "active",
    exhaustedUntil: row.exhaustedUntil?.toISOString() ?? null,
    usageUsd: row.usageUsd,
    limitUsd: row.limitUsd,
    cycleEndAt: row.cycleEndAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
  }
}

/**
 * Tokens an MCP owned by `mcpOwnerId` may rotate through (16-apify.md §5): company tokens + the owner's personal
 * tokens, live, status active / exhausted (the pool decides whether an exhausted one is usable again). No secrets.
 * Oldest first (stable order; the pool picks at random anyway).
 */
export async function loadGrantApifyTokens(
  mcpOwnerId: string,
  tx: DbLike = db
): Promise<GrantApifyToken[]> {
  const rows = await tx
    .select({
      id: apifyTokens.id,
      name: apifyTokens.name,
      scope: apifyTokens.scope,
      apifyUserId: apifyTokens.apifyUserId,
      status: apifyTokens.status,
      exhaustedUntil: apifyTokens.exhaustedUntil,
      usageUsd: apifyTokens.usageUsd,
      limitUsd: apifyTokens.limitUsd,
      cycleEndAt: apifyTokens.cycleEndAt,
      lastCheckedAt: apifyTokens.lastCheckedAt,
    })
    .from(apifyTokens)
    .where(
      and(
        isNull(apifyTokens.deletedAt),
        inArray(apifyTokens.status, ["active", "exhausted"]),
        or(
          eq(apifyTokens.scope, "company"),
          and(
            eq(apifyTokens.scope, "personal"),
            eq(apifyTokens.ownerId, mcpOwnerId)
          )
        )
      )
    )
    .orderBy(apifyTokens.createdAt, apifyTokens.id)
  return rows.map(toGrantApifyToken)
}

// ---- state writes (no updated_at bump, never touch deleted / disabled rows) ---------------------------------

/**
 * Rows a status / info write may touch: live, not disabled by a person (a check never re-enables a token) and - when
 * `ciphertext` is given - still holding the token that was checked (a token replaced meanwhile never receives the
 * old token's account / status).
 */
function writable(id: string, ciphertext?: string) {
  return and(
    eq(apifyTokens.id, id),
    isNull(apifyTokens.deletedAt),
    ne(apifyTokens.status, "disabled"),
    ciphertext === undefined
      ? undefined
      : eq(apifyTokens.credentialsEncrypted, ciphertext)
  )
}

/** account columns from a fresh /users/me + /users/me/limits read */
export function accountColumns(info: ApifyAccountInfo) {
  return {
    apifyUserId: info.apifyUserId,
    apifyUsername: info.username,
    planId: info.planId,
    planTier: info.planTier,
    usageUsd: info.usageUsd,
    limitUsd: info.limitUsd,
    cycleEndAt: info.cycleEndAt ? new Date(info.cycleEndAt) : null,
  }
}

export type ApifyStatusPatch = {
  status: "active" | "exhausted" | "invalid" | "error"
  statusMessage: string | null
  exhaustedUntil?: Date | null
}

/**
 * Store the result of a check: fresh account info (optional) + status. Returns false when the row is deleted /
 * disabled meanwhile, or - with `ciphertext` (the credentials_encrypted that was decrypted for the check) - when the
 * token was replaced meanwhile (nothing written).
 */
export async function saveApifyTokenCheck(
  id: string,
  patch: ApifyStatusPatch & {
    account?: ApifyAccountInfo | null
    checked?: boolean
    ciphertext?: string
  },
  tx: DbLike = db
): Promise<boolean> {
  const rows = await tx
    .update(apifyTokens)
    .set({
      ...(patch.account ? accountColumns(patch.account) : {}),
      status: patch.status,
      statusMessage: patch.statusMessage,
      exhaustedUntil:
        patch.status === "exhausted" ? (patch.exhaustedUntil ?? null) : null,
      ...(patch.checked === false ? {} : { lastCheckedAt: sql`now()` }),
      // an automatic check is not an edit
      updatedAt: sql`${apifyTokens.updatedAt}`,
    })
    .where(writable(id, patch.ciphertext))
    .returning({ id: apifyTokens.id })
  return rows.length > 0
}

/** Fresh usage / limit / cycle of a token (credit refresh before a run), status untouched. */
export async function saveApifyTokenLimits(
  id: string,
  limits: {
    usageUsd: number | null
    limitUsd: number | null
    cycleEndAt: string | null
    /** credentials_encrypted of the token the limits were read with (skip a token replaced meanwhile) */
    ciphertext?: string
  },
  tx: DbLike = db
): Promise<void> {
  await tx
    .update(apifyTokens)
    .set({
      usageUsd: limits.usageUsd,
      limitUsd: limits.limitUsd,
      cycleEndAt: limits.cycleEndAt ? new Date(limits.cycleEndAt) : null,
      lastCheckedAt: sql`now()`,
      updatedAt: sql`${apifyTokens.updatedAt}`,
    })
    .where(writable(id, limits.ciphertext))
}

/**
 * Out of credit: mark EVERY live, not disabled token of the same Apify account (they share the credit) - or only
 * this token when its account id is unknown - exhausted until `until`. Returns the ids changed.
 */
export async function markApifyAccountExhausted(
  /** `ciphertext`: the triggering token is marked only if it still holds the token that failed */
  token: { id: string; apifyUserId: string | null; ciphertext?: string },
  until: Date,
  statusMessage: string,
  tx: DbLike = db
): Promise<string[]> {
  const self = and(
    eq(apifyTokens.id, token.id),
    token.ciphertext === undefined
      ? undefined
      : eq(apifyTokens.credentialsEncrypted, token.ciphertext)
  )
  const rows = await tx
    .update(apifyTokens)
    .set({
      status: "exhausted",
      statusMessage,
      exhaustedUntil: until,
      updatedAt: sql`${apifyTokens.updatedAt}`,
    })
    .where(
      and(
        isNull(apifyTokens.deletedAt),
        // never overwrite invalid / error / disabled: only usable tokens become "out of credit"
        inArray(apifyTokens.status, ["active", "exhausted"]),
        token.apifyUserId
          ? or(
              self,
              and(
                isNotNull(apifyTokens.apifyUserId),
                eq(apifyTokens.apifyUserId, token.apifyUserId)
              )
            )
          : self
      )
    )
    .returning({ id: apifyTokens.id })
  return rows.map((r) => r.id)
}

/** Apify rejected the token (401 / disabled account). `ciphertext`: only if the row still holds that token. */
export async function markApifyTokenInvalid(
  id: string,
  statusMessage: string,
  opts: { ciphertext?: string } = {},
  tx: DbLike = db
): Promise<boolean> {
  return saveApifyTokenCheck(
    id,
    { status: "invalid", statusMessage, checked: false, ciphertext: opts.ciphertext },
    tx
  )
}

/** A run started with this token. */
export async function touchApifyTokenUsed(
  id: string,
  tx: DbLike = db
): Promise<void> {
  await tx
    .update(apifyTokens)
    .set({ lastUsedAt: sql`now()`, updatedAt: sql`${apifyTokens.updatedAt}` })
    .where(eq(apifyTokens.id, id))
}
