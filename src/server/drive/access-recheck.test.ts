// Use-time re-checks of the relay / background upload against the test Postgres (skipped without DATABASE_URL):
// loadGrantForMcpId + driveUseStillGranted (security review L4) and the live relay token set (relay-guard.ts, L3).
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { db } from "@/server/db/client"
import {
  adAccounts,
  connections,
  driveCredentials,
  driveRelayLinks,
  driveSources,
  mcpAccountScopes,
  mcpDriveScopes,
  mcpPlatformPermissions,
  mcpServers,
  user,
} from "@/server/db/schema"

import {
  __resetAccessRecheckCache,
  driveUseStillGranted,
  loadGrantForMcpId,
} from "./access-recheck"
import { __resetRelayGuard, isLiveRelayTokenHash } from "./relay-guard"
import { hashRelayToken } from "./relay-links"
import { encryptServiceAccount } from "./store"

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-drive-recheck-${randomUUID().slice(0, 8)}`
const owner = { id: `${PREFIX}-owner`, email: `${PREFIX}-o@test.local` }

describe.skipIf(!HAS_DB)("use-time re-checks (DB)", () => {
  let mcpId = ""
  let adAccountId = ""
  let credentialId = ""
  let sourceId = ""

  beforeAll(async () => {
    await db.insert(user).values({
      id: owner.id,
      name: owner.id,
      email: owner.email,
      role: "staff",
      emailVerified: true,
    })
    mcpId = randomUUID()
    await db.insert(mcpServers).values({
      id: mcpId,
      ownerId: owner.id,
      name: `${PREFIX} mcp`,
      keyHash: `h-${mcpId}`,
      keyPrefix: "amcp_x",
      keyEncrypted: "v1.x.y.z",
      settings: { drive_public_links: true },
    })
    await db
      .insert(mcpPlatformPermissions)
      .values({ mcpId, platform: "meta", permissions: ["read", "create"] })
    const [conn] = await db
      .insert(connections)
      .values({
        ownerId: owner.id,
        platform: "meta",
        name: `${PREFIX} conn`,
        credentialsEncrypted: "v1.x.y.z",
      })
      .returning({ id: connections.id })
    const [acc] = await db
      .insert(adAccounts)
      .values({
        connectionId: conn!.id,
        platform: "meta",
        externalId: `act_${PREFIX}`,
        name: "acc",
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
      })
      .returning({ id: adAccounts.id })
    adAccountId = acc!.id
    await db
      .insert(mcpAccountScopes)
      .values({ mcpId, connectionId: conn!.id, adAccountId })
    credentialId = randomUUID()
    await db.insert(driveCredentials).values({
      id: credentialId,
      kind: "personal",
      ownerId: owner.id,
      credentialsEncrypted: encryptServiceAccount(credentialId, {
        clientEmail: "x@p.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        privateKeyId: null,
        projectId: null,
      }),
      clientEmail: "x@p.iam.gserviceaccount.com",
    })
    const [src] = await db
      .insert(driveSources)
      .values({
        ownerId: owner.id,
        credentialId,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-folder`,
        name: "folder",
      })
      .returning({ id: driveSources.id })
    sourceId = src!.id
    await db.insert(mcpDriveScopes).values({ mcpId, sourceId })
  })

  afterAll(async () => {
    await db.delete(mcpServers).where(eq(mcpServers.ownerId, owner.id))
    await db.delete(connections).where(eq(connections.ownerId, owner.id))
    await db.delete(driveSources).where(eq(driveSources.ownerId, owner.id))
    await db
      .delete(driveCredentials)
      .where(eq(driveCredentials.ownerId, owner.id))
    await db.delete(user).where(eq(user.id, owner.id))
  })

  beforeEach(() => {
    __resetAccessRecheckCache()
    __resetRelayGuard()
  })

  const ref = () => ({
    adAccountId,
    access: "service_account",
    credentialId,
    sourceId,
  })

  it("the current grant allows the account + folder source; revoking the scope / disabling the MCP denies", async () => {
    const grant = await loadGrantForMcpId(mcpId)
    expect(grant?.mcpId).toBe(mcpId)
    expect(driveUseStillGranted(grant!, ref())).toBe(true)
    // public links: switch on, but no system API key in this database
    expect(
      driveUseStillGranted(grant!, {
        ...ref(),
        access: "api_key",
        credentialId: null,
        sourceId: null,
      })
    ).toBe(grant!.drivePublicAvailable)

    await db
      .delete(mcpDriveScopes)
      .where(
        and(
          eq(mcpDriveScopes.mcpId, mcpId),
          eq(mcpDriveScopes.sourceId, sourceId)
        )
      )
    // cached for a few seconds, fresh on demand
    expect(driveUseStillGranted((await loadGrantForMcpId(mcpId))!, ref())).toBe(
      true
    )
    const fresh = await loadGrantForMcpId(mcpId, { fresh: true })
    expect(driveUseStillGranted(fresh!, ref())).toBe(false)
    await db.insert(mcpDriveScopes).values({ mcpId, sourceId })

    await db
      .update(mcpPlatformPermissions)
      .set({ permissions: ["read"] })
      .where(eq(mcpPlatformPermissions.mcpId, mcpId))
    expect(
      driveUseStillGranted(
        (await loadGrantForMcpId(mcpId, { fresh: true }))!,
        ref()
      )
    ).toBe(false)
    await db
      .update(mcpPlatformPermissions)
      .set({ permissions: ["read", "create"] })
      .where(eq(mcpPlatformPermissions.mcpId, mcpId))

    await db
      .update(mcpServers)
      .set({ settings: { drive_public_links: false } })
      .where(eq(mcpServers.id, mcpId))
    const noPublic = await loadGrantForMcpId(mcpId, { fresh: true })
    expect(
      driveUseStillGranted(noPublic!, {
        ...ref(),
        access: "api_key",
        credentialId: null,
        sourceId: null,
      })
    ).toBe(false)
    expect(driveUseStillGranted(noPublic!, ref())).toBe(true)

    await db
      .update(mcpServers)
      .set({ status: "disabled" })
      .where(eq(mcpServers.id, mcpId))
    expect(await loadGrantForMcpId(mcpId, { fresh: true })).toBeNull()
    expect(await loadGrantForMcpId(randomUUID(), { fresh: true })).toBeNull()
    await db
      .update(mcpServers)
      .set({ status: "active" })
      .where(eq(mcpServers.id, mcpId))
  })

  it("live relay token set: live links only, reloaded on a miss", async () => {
    const insertLink = async (
      token: string,
      over: Partial<typeof driveRelayLinks.$inferInsert> = {}
    ) =>
      db.insert(driveRelayLinks).values({
        tokenHash: hashRelayToken(token),
        mcpId,
        adAccountId,
        driveFileId: `${PREFIX}-file`,
        contentKey: "md5:abc:1000",
        access: "service_account",
        credentialId,
        sourceId,
        fileName: "v.mp4",
        contentType: "video/mp4",
        sizeBytes: 1000,
        maxFetches: 30,
        expiresAt: new Date(Date.now() + 3600_000),
        ...over,
      })
    const live = `adr_${randomUUID()}`
    const expired = `adr_${randomUUID()}`
    const usedUp = `adr_${randomUUID()}`
    await insertLink(live)
    await insertLink(expired, { expiresAt: new Date(Date.now() - 1000) })
    await insertLink(usedUp, { fetchCount: 30 })
    expect(await isLiveRelayTokenHash(hashRelayToken(live))).toBe(true)
    expect(await isLiveRelayTokenHash(hashRelayToken(expired))).toBe(false)
    expect(await isLiveRelayTokenHash(hashRelayToken(usedUp))).toBe(false)
    // a link created after the last load is found once the reload window passed
    const later = `adr_${randomUUID()}`
    await insertLink(later)
    expect(await isLiveRelayTokenHash(hashRelayToken(later))).toBe(false)
    expect(
      await isLiveRelayTokenHash(hashRelayToken(later), Date.now() + 5_000)
    ).toBe(true)
  })
})
