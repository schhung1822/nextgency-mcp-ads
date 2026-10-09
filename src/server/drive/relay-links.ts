// Temporary public links for videos: /dl/<token>/<file name> (15-google-drive-media.md §8, GD5).
// The platform (Meta file_url / TikTok video_url) fetches the video from our domain; the route streams it from Drive.
// Token = "adr_" + 32 random bytes base64url; only its SHA-256 is stored (lookup by hash, no compare needed).
// The token / URL must never be logged or returned to the AI. No imports from "next/*".
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { and, eq, gt, lt, sql } from "drizzle-orm"

import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { driveRelayLinks, mcpServers, user } from "@/server/db/schema"
import { appBaseUrl } from "@/server/env"

import type { DriveRelayLinkRow } from "./store"
import { DRIVE_LIMITS } from "./types"

export const RELAY_TOKEN_PREFIX = "adr_"
/** adr_ + base64url(32 bytes) = 4 + 43 chars */
const RELAY_TOKEN_RE = /^adr_[A-Za-z0-9_-]{43}$/
const MAX_FILE_NAME = 200

export type RelayAccess =
  { type: "service_account"; credentialId: string } | { type: "api_key" }

export interface CreateRelayLinkInput {
  mcpId: string
  adAccountId: string
  driveFileId: string
  /** driveContentKey(file) at creation - the route re-checks it before streaming (file replaced → 404) */
  contentKey: string
  /** how the file was resolved: a granted folder's service account, or the system API key (public link) */
  access: RelayAccess
  /** drive_sources.id the file was resolved through (null / omitted = public link); the route re-checks it */
  sourceId?: string | null
  resourceKey: string | null
  /** already sanitised by the caller (no path separators / control chars); compared with the URL segment */
  fileName: string
  contentType: string
  sizeBytes: number
}

export interface CreatedRelayLink {
  id: string
  /** secret - pass only to the platform API, never log / return to the AI */
  token: string
  /** ${appBaseUrl()}/dl/<token>/<encoded file name> - secret like the token */
  url: string
  expiresAt: Date
}

export function isRelayTokenFormat(token: unknown): token is string {
  return typeof token === "string" && RELAY_TOKEN_RE.test(token)
}

export function hashRelayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

function assertFileName(name: string) {
  if (
    !name ||
    name.length > MAX_FILE_NAME ||
    name === "." ||
    name === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("relay link: invalid file name")
  }
}

export async function createRelayLink(
  input: CreateRelayLinkInput,
  opts: { ttlMs?: number; maxFetches?: number } = {}
): Promise<CreatedRelayLink> {
  assertFileName(input.fileName)
  if (!input.contentKey) throw new Error("relay link: content key required")
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw new Error("relay link: invalid size")
  const ttlMs = opts.ttlMs ?? DRIVE_LIMITS.relayTtlMs
  const maxFetches = opts.maxFetches ?? DRIVE_LIMITS.relayMaxFetches
  if (!(ttlMs > 0) || !Number.isInteger(maxFetches) || maxFetches < 1)
    throw new Error("relay link: invalid limits")

  const id = randomUUID()
  const token = RELAY_TOKEN_PREFIX + randomBytes(32).toString("base64url")
  const [row] = await db
    .insert(driveRelayLinks)
    .values({
      id,
      tokenHash: hashRelayToken(token),
      mcpId: input.mcpId,
      adAccountId: input.adAccountId,
      driveFileId: input.driveFileId,
      contentKey: input.contentKey,
      access: input.access.type,
      sourceId: input.sourceId ?? null,
      credentialId:
        input.access.type === "service_account"
          ? input.access.credentialId
          : null,
      resourceKeyEncrypted: input.resourceKey
        ? encryptSecret(input.resourceKey, aad.driveRelayResourceKey(id))
        : null,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      maxFetches,
      // database clock: the same clock peek / consume compare against
      expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000}::double precision)`,
    })
    .returning({ expiresAt: driveRelayLinks.expiresAt })
  return {
    id,
    token,
    url: `${appBaseUrl()}/dl/${token}/${encodeURIComponent(input.fileName)}`,
    expiresAt: row!.expiresAt,
  }
}

/** Resource key of the file (X-Goog-Drive-Resource-Keys), decrypted only when the route streams. */
export function decryptRelayResourceKey(
  row: Pick<DriveRelayLinkRow, "id" | "resourceKeyEncrypted">
): string | null {
  if (!row.resourceKeyEncrypted) return null
  return decryptSecret(
    row.resourceKeyEncrypted,
    aad.driveRelayResourceKey(row.id)
  )
}

/** Same rule as src/server/mcp/grant.ts (ownerBanned): banned without expiry, or until a future date. */
function ownerBanned(banned: boolean | null, banExpires: Date | null): boolean {
  return !!banned && (!banExpires || banExpires.getTime() > Date.now())
}

/** Link not expired, fetches left, and its MCP usable like grant.ts usableMcp(): active, not deleted, not expired. */
function liveLinkOfUsableMcp(tokenHash: string) {
  return and(
    eq(driveRelayLinks.tokenHash, tokenHash),
    gt(driveRelayLinks.expiresAt, sql`now()`),
    lt(driveRelayLinks.fetchCount, driveRelayLinks.maxFetches),
    sql`exists (select 1 from ${mcpServers} where ${mcpServers.id} = ${driveRelayLinks.mcpId} and ${mcpServers.status} = 'active' and ${mcpServers.deletedAt} is null and (${mcpServers.expiresAt} is null or ${mcpServers.expiresAt} > now()))`
  )
}

async function peekByHash(
  tokenHash: string
): Promise<DriveRelayLinkRow | null> {
  const [r] = await db
    .select({
      link: driveRelayLinks,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(driveRelayLinks)
    .innerJoin(mcpServers, eq(mcpServers.id, driveRelayLinks.mcpId))
    .innerJoin(user, eq(user.id, mcpServers.ownerId))
    .where(liveLinkOfUsableMcp(tokenHash))
    .limit(1)
  if (!r || ownerBanned(r.banned, r.banExpires)) return null
  return r.link
}

/** HEAD: the link if it is usable right now, without counting a fetch. Malformed / unknown / dead → null. */
export async function peekRelayToken(
  token: string
): Promise<DriveRelayLinkRow | null> {
  if (!isRelayTokenFormat(token)) return null
  return peekByHash(hashRelayToken(token))
}

/**
 * GET: count one fetch atomically (fetch_count < max_fetches re-checked in the UPDATE, so parallel requests can
 * never exceed the limit) and return the link, or null when unusable (expired, used up, MCP disabled / deleted /
 * expired, owner banned).
 */
export async function consumeRelayToken(
  token: string
): Promise<DriveRelayLinkRow | null> {
  if (!isRelayTokenFormat(token)) return null
  const tokenHash = hashRelayToken(token)
  // owner ban is decided in code (same as grant.ts); checked before counting
  if (!(await peekByHash(tokenHash))) return null
  const [row] = await db
    .update(driveRelayLinks)
    .set({ fetchCount: sql`${driveRelayLinks.fetchCount} + 1` })
    .where(liveLinkOfUsableMcp(tokenHash))
    .returning()
  return row ?? null
}

/** drive.cleanup job: delete links expired more than `olderThanMs` ago. Returns the number of rows removed. */
export async function deleteExpiredRelayLinks(
  olderThanMs: number
): Promise<number> {
  const secs = Math.max(0, olderThanMs) / 1000
  const r = await db
    .delete(driveRelayLinks)
    .where(
      lt(driveRelayLinks.expiresAt, sql`now() - make_interval(secs => ${secs}::double precision)`)
    )
  return r.rowCount ?? 0
}
