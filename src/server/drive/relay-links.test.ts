// Relay links (/dl/<token>/<name>) and Drive media reuse against the test Postgres (skipped without DATABASE_URL).
import { randomUUID } from "node:crypto"
import { eq, inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/server/db/client"
import {
  adAccounts,
  connections,
  driveCredentials,
  driveMediaUploads,
  driveRelayLinks,
  driveSources,
  mcpServers,
  user,
} from "@/server/db/schema"

import {
  findReusableMedia,
  listMediaUploadsForFiles,
  recordMediaUpload,
} from "./media-uploads"
import {
  consumeRelayToken,
  createRelayLink,
  decryptRelayResourceKey,
  deleteExpiredRelayLinks,
  hashRelayToken,
  isRelayTokenFormat,
  peekRelayToken,
  type CreateRelayLinkInput,
} from "./relay-links"
import { encryptServiceAccount } from "./store"
import { DRIVE_LIMITS } from "./types"

describe("relay token format", () => {
  it("accepts only adr_ + 43 base64url chars", () => {
    expect(isRelayTokenFormat("adr_" + "a".repeat(43))).toBe(true)
    expect(isRelayTokenFormat("adr_" + "a".repeat(42))).toBe(false)
    expect(isRelayTokenFormat("adr_" + "a".repeat(42) + "=")).toBe(false)
    expect(isRelayTokenFormat("amcp_" + "a".repeat(43))).toBe(false)
    expect(isRelayTokenFormat(undefined)).toBe(false)
    expect(hashRelayToken("adr_x")).toMatch(/^[0-9a-f]{64}$/)
  })
})

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-drive-relay-${randomUUID().slice(0, 8)}`
const owner = { id: `${PREFIX}-owner`, email: `${PREFIX}-o@test.local` }

describe.skipIf(!HAS_DB)("relay links + media uploads (DB)", () => {
  let mcpId = ""
  let adAccountId = ""
  let adAccount2 = ""
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
    })
    const [conn] = await db
      .insert(connections)
      .values({
        ownerId: owner.id,
        platform: "meta",
        name: `${PREFIX} conn`,
        credentialsEncrypted: "v1.x.y.z",
      })
      .returning({ id: connections.id })
    const accs = await db
      .insert(adAccounts)
      .values(
        ["1", "2"].map((n) => ({
          connectionId: conn!.id,
          platform: "meta" as const,
          externalId: `act_${PREFIX}_${n}`,
          name: `acc ${n}`,
          currency: "VND",
          timezone: "Asia/Ho_Chi_Minh",
        }))
      )
      .returning({ id: adAccounts.id })
    adAccountId = accs[0]!.id
    adAccount2 = accs[1]!.id
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

  function input(
    extra: Partial<CreateRelayLinkInput> = {}
  ): CreateRelayLinkInput {
    return {
      mcpId,
      adAccountId,
      driveFileId: `${PREFIX}-file`,
      contentKey: "md5:abc:1000",
      access: { type: "service_account", credentialId },
      resourceKey: null,
      fileName: "Video tuần 41.mp4",
      contentType: "video/mp4",
      sizeBytes: 1000,
      ...extra,
    }
  }

  it("create: random adr_ token, only its hash stored, URL with the encoded name, TTL from DRIVE_LIMITS", async () => {
    const before = Date.now()
    const link = await createRelayLink(input({ resourceKey: "0-RkEy" }))
    expect(isRelayTokenFormat(link.token)).toBe(true)
    expect(link.url).toMatch(
      new RegExp(`/dl/${link.token}/Video%20tu%E1%BA%A7n%2041\\.mp4$`)
    )
    const [row] = await db
      .select()
      .from(driveRelayLinks)
      .where(eq(driveRelayLinks.id, link.id))
    expect(row!.tokenHash).toBe(hashRelayToken(link.token))
    expect(JSON.stringify(row)).not.toContain(link.token)
    expect(row!.maxFetches).toBe(DRIVE_LIMITS.relayMaxFetches)
    expect(row!.fetchCount).toBe(0)
    expect(row!.resourceKeyEncrypted).not.toContain("0-RkEy")
    expect(decryptRelayResourceKey(row!)).toBe("0-RkEy")
    const ttl = link.expiresAt.getTime() - before
    expect(ttl).toBeGreaterThan(DRIVE_LIMITS.relayTtlMs - 60_000)
    expect(ttl).toBeLessThan(DRIVE_LIMITS.relayTtlMs + 60_000)
    const other = await createRelayLink(input())
    expect(other.token).not.toBe(link.token)
  })

  it("create validates the file name, access and size", async () => {
    for (const fileName of [
      "",
      "a/b.mp4",
      "a\\b.mp4",
      "..",
      "x\n.mp4",
      "a".repeat(201),
    ])
      await expect(createRelayLink(input({ fileName }))).rejects.toThrow()
    await expect(createRelayLink(input({ sizeBytes: -1 }))).rejects.toThrow()
    await expect(createRelayLink(input({ contentKey: "" }))).rejects.toThrow()
    // api_key access stores no credential; the DB refuses a service_account link without one
    const pub = await createRelayLink(input({ access: { type: "api_key" } }))
    const [row] = await db
      .select()
      .from(driveRelayLinks)
      .where(eq(driveRelayLinks.id, pub.id))
    expect(row!.access).toBe("api_key")
    expect(row!.credentialId).toBeNull()
    await expect(
      db.insert(driveRelayLinks).values({
        tokenHash: randomUUID(),
        mcpId,
        adAccountId,
        driveFileId: "f",
        contentKey: "k",
        access: "service_account",
        fileName: "a.mp4",
        contentType: "video/mp4",
        sizeBytes: 1,
        maxFetches: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow()
  })

  it("create stores the source the file was resolved through (re-checked by the route); deleting the source sets it null", async () => {
    const viaSource = await createRelayLink(input({ sourceId }))
    const pub = await createRelayLink(input({ access: { type: "api_key" } }))
    const rows = await db
      .select({ id: driveRelayLinks.id, sourceId: driveRelayLinks.sourceId })
      .from(driveRelayLinks)
      .where(inArray(driveRelayLinks.id, [viaSource.id, pub.id]))
    expect(new Map(rows.map((r) => [r.id, r.sourceId]))).toEqual(
      new Map([
        [viaSource.id, sourceId],
        [pub.id, null],
      ])
    )
    expect((await peekRelayToken(viaSource.token))?.sourceId).toBe(sourceId)
    // FK on delete set null (a hard-deleted source never leaves a dangling id)
    const [tmp] = await db
      .insert(driveSources)
      .values({
        ownerId: owner.id,
        credentialId,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-tmp-folder`,
        name: "tmp",
      })
      .returning({ id: driveSources.id })
    const l = await createRelayLink(input({ sourceId: tmp!.id }))
    await db.delete(driveSources).where(eq(driveSources.id, tmp!.id))
    const [after] = await db
      .select({ sourceId: driveRelayLinks.sourceId })
      .from(driveRelayLinks)
      .where(eq(driveRelayLinks.id, l.id))
    expect(after!.sourceId).toBeNull()
  })

  it("peek does not count, consume counts atomically up to max_fetches", async () => {
    const link = await createRelayLink(input(), { maxFetches: 3 })
    expect((await peekRelayToken(link.token))?.id).toBe(link.id)
    expect((await peekRelayToken(link.token))?.fetchCount).toBe(0)
    // 5 parallel GETs: exactly 3 succeed
    const results = await Promise.all(
      Array.from({ length: 5 }, () => consumeRelayToken(link.token))
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(
      results
        .filter(Boolean)
        .map((r) => r!.fetchCount)
        .sort()
    ).toEqual([1, 2, 3])
    expect(await peekRelayToken(link.token)).toBeNull()
    expect(await consumeRelayToken(link.token)).toBeNull()
  })

  it("unknown / malformed tokens → null", async () => {
    expect(await peekRelayToken("adr_" + "Z".repeat(43))).toBeNull()
    expect(await consumeRelayToken("adr_" + "Z".repeat(43))).toBeNull()
    expect(await peekRelayToken("nope")).toBeNull()
    expect(await consumeRelayToken("' or 1=1 --")).toBeNull()
  })

  it("expired links are dead and removed by deleteExpiredRelayLinks after the grace period", async () => {
    const link = await createRelayLink(input())
    await db
      .update(driveRelayLinks)
      .set({ expiresAt: sql`now() - interval '2 hours'` })
      .where(eq(driveRelayLinks.id, link.id))
    expect(await peekRelayToken(link.token)).toBeNull()
    expect(await consumeRelayToken(link.token)).toBeNull()
    expect(await deleteExpiredRelayLinks(24 * 3600_000)).toBe(0)
    await db
      .update(driveRelayLinks)
      .set({ expiresAt: sql`now() - interval '25 hours'` })
      .where(eq(driveRelayLinks.id, link.id))
    expect(await deleteExpiredRelayLinks(24 * 3600_000)).toBeGreaterThanOrEqual(
      1
    )
    expect(
      await db
        .select()
        .from(driveRelayLinks)
        .where(eq(driveRelayLinks.id, link.id))
    ).toEqual([])
  })

  it("MCP disabled / expired / deleted, or owner banned → 404 (null); usable again when restored", async () => {
    const link = await createRelayLink(input())
    const cases: [
      Partial<typeof mcpServers.$inferInsert>,
      Partial<typeof mcpServers.$inferInsert>,
    ][] = [
      [{ status: "disabled" }, { status: "active" }],
      [{ expiresAt: new Date(Date.now() - 1000) }, { expiresAt: null }],
      [{ deletedAt: new Date() }, { deletedAt: null }],
    ]
    for (const [bad, good] of cases) {
      await db.update(mcpServers).set(bad).where(eq(mcpServers.id, mcpId))
      expect(await peekRelayToken(link.token), JSON.stringify(bad)).toBeNull()
      expect(
        await consumeRelayToken(link.token),
        JSON.stringify(bad)
      ).toBeNull()
      await db.update(mcpServers).set(good).where(eq(mcpServers.id, mcpId))
    }
    await db
      .update(mcpServers)
      .set({ expiresAt: new Date(Date.now() + 3600_000) })
      .where(eq(mcpServers.id, mcpId))
    expect(await peekRelayToken(link.token)).not.toBeNull()
    await db
      .update(mcpServers)
      .set({ expiresAt: null })
      .where(eq(mcpServers.id, mcpId))

    await db
      .update(user)
      .set({ banned: true, banExpires: null })
      .where(eq(user.id, owner.id))
    expect(await peekRelayToken(link.token)).toBeNull()
    expect(await consumeRelayToken(link.token)).toBeNull()
    await db
      .update(user)
      .set({ banned: true, banExpires: new Date(Date.now() + 3600_000) })
      .where(eq(user.id, owner.id))
    expect(await peekRelayToken(link.token)).toBeNull()
    // ban already over
    await db
      .update(user)
      .set({ banned: true, banExpires: new Date(Date.now() - 3600_000) })
      .where(eq(user.id, owner.id))
    expect(await peekRelayToken(link.token)).not.toBeNull()
    await db
      .update(user)
      .set({ banned: false, banExpires: null })
      .where(eq(user.id, owner.id))
    const consumed = await consumeRelayToken(link.token)
    expect(consumed?.fetchCount).toBe(1)
    // failed attempts above never counted a fetch
  })

  it("deleting the MCP removes its links (cascade)", async () => {
    const tmpMcp = randomUUID()
    await db.insert(mcpServers).values({
      id: tmpMcp,
      ownerId: owner.id,
      name: `${PREFIX} tmp`,
      keyHash: `h-${tmpMcp}`,
      keyPrefix: "amcp_x",
      keyEncrypted: "v1.x.y.z",
    })
    const link = await createRelayLink(input({ mcpId: tmpMcp }))
    await db.delete(mcpServers).where(eq(mcpServers.id, tmpMcp))
    expect(await peekRelayToken(link.token)).toBeNull()
    expect(
      await db
        .select()
        .from(driveRelayLinks)
        .where(eq(driveRelayLinks.id, link.id))
    ).toEqual([])
  })

  // ---- media uploads ----------------------------------------------------------------------------------------

  it("media uploads: miss → record → reuse (bumps last_used_at); new content key = miss", async () => {
    const key = {
      adAccountId,
      driveFileId: `${PREFIX}-img`,
      contentKey: "md5:aa:10",
    }
    expect(await findReusableMedia(key)).toBeNull()
    await recordMediaUpload({
      ...key,
      mediaType: "image",
      mediaId: "hash-1",
      mediaUrl: "https://cdn.example/img.jpg",
      sizeBytes: 10,
      sourceId,
      mcpId,
    })
    const [first] = await db
      .select()
      .from(driveMediaUploads)
      .where(eq(driveMediaUploads.driveFileId, key.driveFileId))
    await db
      .update(driveMediaUploads)
      .set({ lastUsedAt: sql`now() - interval '1 day'` })
      .where(eq(driveMediaUploads.id, first!.id))
    expect(await findReusableMedia(key)).toEqual({
      mediaId: "hash-1",
      mediaType: "image",
      mediaUrl: "https://cdn.example/img.jpg",
    })
    const [bumped] = await db
      .select()
      .from(driveMediaUploads)
      .where(eq(driveMediaUploads.id, first!.id))
    expect(bumped!.lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(
      await findReusableMedia({ ...key, contentKey: "md5:bb:10" })
    ).toBeNull()
    expect(
      await findReusableMedia({ ...key, adAccountId: adAccount2 })
    ).toBeNull()
  })

  it("media uploads: upsert (force_reupload) replaces the media id, keeps first_mcp_id / source", async () => {
    const key = {
      adAccountId,
      driveFileId: `${PREFIX}-vid`,
      contentKey: "rev:r1:99",
    }
    await recordMediaUpload({
      ...key,
      mediaType: "video",
      mediaId: "v-1",
      sourceId,
      mcpId,
    })
    await recordMediaUpload({
      ...key,
      mediaType: "video",
      mediaId: "v-2",
      mcpId: null,
    })
    const rows = await db
      .select()
      .from(driveMediaUploads)
      .where(eq(driveMediaUploads.driveFileId, key.driveFileId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      mediaId: "v-2",
      mediaType: "video",
      firstMcpId: mcpId,
      sourceId,
    })
    await recordMediaUpload({
      ...key,
      adAccountId: adAccount2,
      mediaType: "video",
      mediaId: "v-3",
    })
    const uses = await listMediaUploadsForFiles(
      [key.driveFileId, "unknown"],
      [adAccountId, adAccount2]
    )
    expect(uses.map((u) => u.mediaId).sort()).toEqual(["v-2", "v-3"])
    // limited to the accounts the caller may see
    expect(
      (await listMediaUploadsForFiles([key.driveFileId], [adAccount2])).map(
        (u) => u.mediaId
      )
    ).toEqual(["v-3"])
    expect(await listMediaUploadsForFiles([], [adAccountId])).toEqual([])
    // bad media type refused by the DB
    await expect(
      recordMediaUpload({
        ...key,
        contentKey: "x",
        mediaType: "audio" as "video",
        mediaId: "a",
      })
    ).rejects.toThrow()
    // source deleted → source_id set null, row kept
    await db.delete(driveSources).where(eq(driveSources.id, sourceId))
    const [kept] = await db
      .select()
      .from(driveMediaUploads)
      .where(inArray(driveMediaUploads.mediaId, ["v-2"]))
    expect(kept!.sourceId).toBeNull()
  })
})
