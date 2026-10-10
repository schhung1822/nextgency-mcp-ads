// Google Drive data layer: AAD helpers, encrypted formats, config normalisation (unit) + migration 0007 constraints
// and loaders against the test Postgres (DB part skipped without DATABASE_URL).
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  driveCredentials,
  driveSources,
  mcpDriveScopes,
  mcpServers,
  user,
} from "@/server/db/schema"

import { isDriveError } from "./errors"
import {
  decryptDriveApiKey,
  decryptServiceAccount,
  decryptSourceResourceKey,
  driveAuthForCredential,
  encryptDriveApiKey,
  encryptServiceAccount,
  encryptSourceResourceKey,
  isUuid,
  loadDriveCredential,
  loadDriveSource,
  loadSystemDriveCredential,
  normalizeFolderConfig,
  normalizeSheetConfig,
  systemApiKeyAuth,
} from "./store"
import type { GoogleServiceAccount } from "./types"

const SA: GoogleServiceAccount = {
  clientEmail: "ads-mcp@demo-project.iam.gserviceaccount.com",
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n",
  privateKeyId: "0123456789abcdef0123456789abcdef01234567",
  projectId: "demo-project",
}
const API_KEY = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K_L-M3n4O5p6Q"

describe("AAD helpers (secret-box)", () => {
  it("bind each Drive secret to its row and field", () => {
    expect(aad.driveCredential("c1")).toBe("drive_credential:c1:credentials")
    expect(aad.driveCredentialApiKey("c1")).toBe("drive_credential:c1:api_key")
    expect(aad.driveSourceResourceKey("s1")).toBe(
      "drive_source:s1:resource_key"
    )
    expect(aad.driveRelayResourceKey("r1")).toBe(
      "drive_relay_link:r1:resource_key"
    )
    const enc = encryptSecret("secret", aad.driveCredentialApiKey("c1"))
    expect(decryptSecret(enc, aad.driveCredentialApiKey("c1"))).toBe("secret")
    // another row, or another field of the same row, cannot decrypt it
    expect(() => decryptSecret(enc, aad.driveCredentialApiKey("c2"))).toThrow()
    expect(() => decryptSecret(enc, aad.driveCredential("c1"))).toThrow()
  })
})

describe("encrypted formats", () => {
  it("service account round-trips (normalised) and never appears in clear text", () => {
    const enc = encryptServiceAccount("c1", SA)
    expect(enc).not.toContain("PRIVATE KEY")
    expect(enc).not.toContain(SA.clientEmail)
    const row = { id: "c1", credentialsEncrypted: enc }
    expect(decryptServiceAccount(row)).toEqual(SA)
    expect(driveAuthForCredential(row)).toEqual({
      type: "service_account",
      sa: SA,
      cacheKey: "drive_credential:c1",
    })
  })

  it("wrong row id / damaged payload / bad shape → DriveError auth_failed without detail", () => {
    const enc = encryptServiceAccount("c1", SA)
    for (const row of [
      { id: "c2", credentialsEncrypted: enc },
      { id: "c1", credentialsEncrypted: "v1.x.y.z" },
      {
        id: "c1",
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ clientEmail: "x@y" }),
          aad.driveCredential("c1")
        ),
      },
    ]) {
      let err: unknown
      try {
        decryptServiceAccount(row)
      } catch (e) {
        err = e
      }
      expect(isDriveError(err) && err.code).toBe("auth_failed")
      expect((err as Error).cause).toBeUndefined()
    }
  })

  it("API key and resource keys", () => {
    const k = encryptDriveApiKey("c1", API_KEY)
    expect(decryptDriveApiKey({ id: "c1", apiKeyEncrypted: k })).toBe(API_KEY)
    expect(decryptDriveApiKey({ id: "c1", apiKeyEncrypted: null })).toBeNull()
    let err: unknown
    try {
      decryptDriveApiKey({ id: "c9", apiKeyEncrypted: k })
    } catch (e) {
      err = e
    }
    expect(isDriveError(err) && err.code).toBe("api_key_invalid")

    expect(encryptSourceResourceKey("s1", null)).toBeNull()
    expect(encryptSourceResourceKey("s1", "")).toBeNull()
    const rk = encryptSourceResourceKey("s1", "0-AbCdEf")!
    expect(
      decryptSourceResourceKey({ id: "s1", resourceKeyEncrypted: rk })
    ).toBe("0-AbCdEf")
    expect(() =>
      decryptSourceResourceKey({ id: "s2", resourceKeyEncrypted: rk })
    ).toThrow()
  })
})

describe("config normalisation", () => {
  it("folder: recursiveDepth clamped to 0-3, garbage → 0", () => {
    expect(normalizeFolderConfig({ recursiveDepth: 2 })).toEqual({
      recursiveDepth: 2,
    })
    expect(normalizeFolderConfig({ recursiveDepth: 9 }).recursiveDepth).toBe(3)
    expect(normalizeFolderConfig({ recursiveDepth: -1 }).recursiveDepth).toBe(0)
    expect(normalizeFolderConfig(null).recursiveDepth).toBe(0)
    expect(normalizeFolderConfig({ recursiveDepth: "x" }).recursiveDepth).toBe(
      0
    )
  })

  it("sheet: header row, link column default, unknown columns null, writeback only when true", () => {
    expect(normalizeSheetConfig({})).toEqual({
      headerRow: 1,
      columns: {
        link: "Link Drive",
        name: null,
        platform: null,
        account: null,
        content: null,
        headline: null,
        destination: null,
        status: null,
        mediaId: null,
        adIds: null,
        postLink: null,
        campaignLink: null,
        note: null,
        updatedAt: null,
      },
      writeback: false,
    })
    // a config stored before the link columns existed (2026-10-10): they read as "not mapped"
    const old = normalizeSheetConfig({
      headerRow: 1,
      columns: { link: "Link Drive", status: "Trạng thái", note: "Ghi chú" },
      writeback: true,
    })
    expect(old.columns).toMatchObject({
      status: "Trạng thái",
      note: "Ghi chú",
      postLink: null,
      campaignLink: null,
    })
    expect(
      normalizeSheetConfig({
        columns: {
          link: "Link Drive",
          postLink: "Link bài viết",
          campaignLink: " ",
        },
      }).columns
    ).toMatchObject({ postLink: "Link bài viết", campaignLink: null })
    const c = normalizeSheetConfig({
      headerRow: 3,
      columns: { link: "Link", status: "Trạng thái", bogus: "x", note: 5 },
      writeback: "true",
    })
    expect(c.headerRow).toBe(3)
    expect(c.columns.link).toBe("Link")
    expect(c.columns.status).toBe("Trạng thái")
    expect(c.columns.note).toBeNull()
    expect("bogus" in c.columns).toBe(false)
    expect(c.writeback).toBe(false)
    expect(
      normalizeSheetConfig({ headerRow: 0, writeback: true })
    ).toMatchObject({ headerRow: 1, writeback: true })
  })

  it("isUuid", () => {
    expect(isUuid(randomUUID())).toBe(true)
    expect(isUuid("1AbCdEfGhIjK")).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DB: migration 0007 constraints + loaders
// ---------------------------------------------------------------------------

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-drive-store-${randomUUID().slice(0, 8)}`
const staff = { id: `${PREFIX}-staff`, email: `${PREFIX}-staff@test.local` }
const admin = { id: `${PREFIX}-admin`, email: `${PREFIX}-admin@test.local` }

/** Postgres error code of a failed query (drizzle wraps the pg error in `cause`). */
async function pgCode(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } }
    return err.cause?.code ?? err.code ?? "unknown"
  }
}

function credValues(
  kind: "system" | "personal",
  ownerId: string | null,
  extra: Partial<typeof driveCredentials.$inferInsert> = {}
): typeof driveCredentials.$inferInsert {
  const id = extra.id ?? randomUUID()
  return {
    id,
    kind,
    ownerId,
    name: `${PREFIX} ${kind}`,
    credentialsEncrypted: encryptServiceAccount(id, SA),
    clientEmail: SA.clientEmail,
    credentialHint: "4567",
    ...extra,
  }
}

describe.skipIf(!HAS_DB)("drive tables (DB, migration 0007)", () => {
  const createdCreds: string[] = []

  beforeAll(async () => {
    await db.insert(user).values(
      [staff, admin].map((a, i) => ({
        id: a.id,
        name: a.id,
        email: a.email,
        role: i === 0 ? "staff" : "admin",
        emailVerified: true,
      }))
    )
    // the test db is shared by the Drive data tests: start without a live system credential
    await db
      .update(driveCredentials)
      .set({ deletedAt: new Date() })
      .where(eq(driveCredentials.kind, "system"))
  })

  afterAll(async () => {
    const owners = [staff.id, admin.id]
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
    await db.delete(driveSources).where(inArray(driveSources.ownerId, owners))
    if (createdCreds.length)
      await db
        .delete(driveCredentials)
        .where(inArray(driveCredentials.id, createdCreds))
    await db.delete(user).where(inArray(user.id, owners))
  })

  async function insertCred(
    v: typeof driveCredentials.$inferInsert
  ): Promise<string> {
    await db.insert(driveCredentials).values(v)
    createdCreds.push(v.id!)
    return v.id!
  }

  it("drive_credentials CHECKs: kind, system ⇔ no owner, API key only on system, status", async () => {
    expect(
      await pgCode(
        db.insert(driveCredentials).values(credValues("system", staff.id))
      )
    ).toBe("23514")
    expect(
      await pgCode(
        db.insert(driveCredentials).values(credValues("personal", null))
      )
    ).toBe("23514")
    expect(
      await pgCode(
        db
          .insert(driveCredentials)
          .values(
            credValues("personal", staff.id, { apiKeyEncrypted: "v1.a.b.c" })
          )
      )
    ).toBe("23514")
    expect(
      await pgCode(
        db
          .insert(driveCredentials)
          .values({ ...credValues("personal", staff.id), kind: "other" })
      )
    ).toBe("23514")
    expect(
      await pgCode(
        db
          .insert(driveCredentials)
          .values(credValues("personal", staff.id, { status: "broken" }))
      )
    ).toBe("23514")
  })

  it("one live system credential; a soft-deleted one does not count", async () => {
    const first = await insertCred(credValues("system", null))
    expect(
      await pgCode(
        db.insert(driveCredentials).values(credValues("system", null))
      )
    ).toBe("23505")
    await db
      .update(driveCredentials)
      .set({ deletedAt: new Date() })
      .where(eq(driveCredentials.id, first))
    expect(await loadSystemDriveCredential()).toBeNull()
    const second = await insertCred(
      credValues("system", null, { apiKeyEncrypted: null })
    )
    expect((await loadSystemDriveCredential())?.id).toBe(second)
    expect(await loadDriveCredential(first)).toBeNull()
    expect((await loadDriveCredential(second))?.id).toBe(second)
    expect(await loadDriveCredential("not-a-uuid")).toBeNull()
  })

  it("systemApiKeyAuth: null without API key or when disabled, api_key auth otherwise", async () => {
    const sys = (await loadSystemDriveCredential())!
    expect(await systemApiKeyAuth()).toBeNull()
    await db
      .update(driveCredentials)
      .set({
        apiKeyEncrypted: encryptDriveApiKey(sys.id, API_KEY),
        apiKeyHint: "5p6Q",
      })
      .where(eq(driveCredentials.id, sys.id))
    expect(await systemApiKeyAuth()).toEqual({
      type: "api_key",
      apiKey: API_KEY,
    })
    await db
      .update(driveCredentials)
      .set({ status: "error" })
      .where(eq(driveCredentials.id, sys.id))
    expect((await systemApiKeyAuth())?.type).toBe("api_key")
    await db
      .update(driveCredentials)
      .set({ status: "disabled" })
      .where(eq(driveCredentials.id, sys.id))
    expect(await systemApiKeyAuth()).toBeNull()
    await db
      .update(driveCredentials)
      .set({ status: "active" })
      .where(eq(driveCredentials.id, sys.id))
  })

  it("drive_sources CHECKs + live unique (credential, google id, gid) + loader", async () => {
    const sys = (await loadSystemDriveCredential())!
    const base = {
      ownerId: admin.id,
      credentialId: sys.id,
      name: `${PREFIX} src`,
      config: { recursiveDepth: 0 },
    }
    const folderId = randomUUID()
    expect(
      await pgCode(
        db.insert(driveSources).values({
          ...base,
          id: folderId,
          kind: "folder",
          scope: "company",
          googleId: `${PREFIX}-folder`,
        })
      )
    ).toBeNull()
    // claimed: same folder for the same credential (even by somebody else)
    expect(
      await pgCode(
        db.insert(driveSources).values({
          ...base,
          ownerId: staff.id,
          kind: "folder",
          scope: "personal",
          googleId: `${PREFIX}-folder`,
        })
      )
    ).toBe("23505")
    // folder with a gid / sheet without a gid
    expect(
      await pgCode(
        db.insert(driveSources).values({
          ...base,
          kind: "folder",
          scope: "company",
          googleId: `${PREFIX}-f2`,
          sheetGid: 0,
        })
      )
    ).toBe("23514")
    expect(
      await pgCode(
        db.insert(driveSources).values({
          ...base,
          kind: "sheet",
          scope: "company",
          googleId: `${PREFIX}-s1`,
        })
      )
    ).toBe("23514")
    for (const bad of [
      { kind: "file", scope: "company" },
      { kind: "folder", scope: "team" },
      { kind: "folder", scope: "company", status: "gone" },
    ]) {
      expect(
        await pgCode(
          db
            .insert(driveSources)
            .values({ ...base, googleId: `${PREFIX}-${randomUUID()}`, ...bad })
        )
      ).toBe("23514")
    }
    // two tabs of one spreadsheet are two sources; the same tab twice is claimed
    const sheet = {
      ...base,
      kind: "sheet",
      scope: "company",
      googleId: `${PREFIX}-sheet`,
    }
    expect(
      await pgCode(db.insert(driveSources).values({ ...sheet, sheetGid: 0 }))
    ).toBeNull()
    expect(
      await pgCode(db.insert(driveSources).values({ ...sheet, sheetGid: 7 }))
    ).toBeNull()
    expect(
      await pgCode(db.insert(driveSources).values({ ...sheet, sheetGid: 7 }))
    ).toBe("23505")

    expect((await loadDriveSource(folderId))?.googleId).toBe(`${PREFIX}-folder`)
    // soft delete frees the slot
    await db
      .update(driveSources)
      .set({ deletedAt: new Date() })
      .where(eq(driveSources.id, folderId))
    expect(await loadDriveSource(folderId)).toBeNull()
    expect(
      await pgCode(
        db.insert(driveSources).values({
          ...base,
          ownerId: staff.id,
          kind: "folder",
          scope: "personal",
          googleId: `${PREFIX}-folder`,
        })
      )
    ).toBeNull()
    // credential in use cannot be hard-deleted (ON DELETE RESTRICT → 23001)
    expect(
      await pgCode(
        db.delete(driveCredentials).where(eq(driveCredentials.id, sys.id))
      )
    ).toBe("23001")
  })

  it("mcp_drive_scopes cascade with the MCP and the source", async () => {
    const sys = (await loadSystemDriveCredential())!
    const mcpId = randomUUID()
    await db.insert(mcpServers).values({
      id: mcpId,
      ownerId: staff.id,
      name: `${PREFIX} mcp`,
      keyHash: `h-${mcpId}`,
      keyPrefix: "amcp_x",
      keyEncrypted: "v1.x.y.z",
    })
    const [src] = await db
      .insert(driveSources)
      .values({
        ownerId: staff.id,
        credentialId: sys.id,
        kind: "folder",
        scope: "personal",
        googleId: `${PREFIX}-scoped`,
        name: "scoped",
      })
      .returning({ id: driveSources.id })
    await db.insert(mcpDriveScopes).values({ mcpId, sourceId: src!.id })
    expect(
      await pgCode(
        db.insert(mcpDriveScopes).values({ mcpId, sourceId: src!.id })
      )
    ).toBe("23505")
    await db.delete(driveSources).where(eq(driveSources.id, src!.id))
    expect(
      await db
        .select()
        .from(mcpDriveScopes)
        .where(eq(mcpDriveScopes.mcpId, mcpId))
    ).toEqual([])
  })
})
