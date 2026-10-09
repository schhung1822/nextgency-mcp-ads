// drive.health against the test Postgres (skipped without DATABASE_URL); Google calls mocked.
import { randomUUID } from "node:crypto"
import { eq, inArray, like, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { db } from "@/server/db/client"
import { driveCredentials, driveSources, user } from "@/server/db/schema"

import { DriveError } from "./errors"
import type { DriveAuth, DriveFile } from "./types"

vi.mock("./files", async (orig) => {
  const actual = await orig<typeof import("./files")>()
  return {
    ...actual,
    checkServiceAccountAccess: vi.fn(),
    getDriveFile: vi.fn(),
    listAncestorIds: vi.fn(async () => []),
  }
})
vi.mock("./sheets", async (orig) => {
  const actual = await orig<typeof import("./sheets")>()
  return { ...actual, getSheetMeta: vi.fn() }
})

const files = await import("./files")
const sheets = await import("./sheets")
const { encryptServiceAccount, encryptSourceResourceKey } =
  await import("./store")
const {
  runDriveHealth,
  checkDriveSourceHealth,
  insideOtherPersonalFolder,
  DRIVE_SPREADSHEET_MIME,
} = await import("./health")
const { driveJobs } = await import("@/lib/i18n/vi/drive-jobs")

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-drive-health-${randomUUID().slice(0, 8)}`
const owner = { id: `${PREFIX}-owner`, email: `${PREFIX}-o@test.local` }
const FOLDER_MIME = "application/vnd.google-apps.folder"

function file(id: string, over: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name: `name of ${id}`,
    mimeType: FOLDER_MIME,
    sizeBytes: null,
    md5: null,
    headRevisionId: null,
    version: "1",
    modifiedTime: null,
    parents: [],
    trashed: false,
    driveId: null,
    width: null,
    height: null,
    durationMs: null,
    canDownload: true,
    canEdit: false,
    resourceKey: null,
    shortcut: null,
    ...over,
  }
}

const sa = (email: string) => ({
  clientEmail: email,
  privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
  privateKeyId: null,
  projectId: null,
})

describe("checkDriveSourceHealth (no DB)", () => {
  const auth: DriveAuth = { type: "api_key", apiKey: "k" }
  const base = {
    id: randomUUID(),
    googleId: "G1234567890",
    resourceKeyEncrypted: null,
    config: { recursiveDepth: 0 },
  }

  it("transient Google errors leave the row alone (null)", async () => {
    vi.mocked(files.getDriveFile).mockRejectedValueOnce(
      new DriveError("rate_limited")
    )
    expect(
      await checkDriveSourceHealth(
        { ...base, kind: "folder", sheetGid: null },
        auth
      )
    ).toBeNull()
    vi.mocked(files.getDriveFile).mockRejectedValueOnce(
      new DriveError("timeout")
    )
    expect(
      await checkDriveSourceHealth(
        { ...base, kind: "folder", sheetGid: null },
        auth
      )
    ).toBeNull()
  })

  it("healthy sources refresh their ancestors (H1); a failed walk keeps the stored value (undefined)", async () => {
    vi.mocked(files.getDriveFile).mockResolvedValueOnce(file("G1234567890"))
    vi.mocked(files.listAncestorIds).mockResolvedValueOnce(["P1", "ROOT"])
    expect(
      await checkDriveSourceHealth(
        { ...base, kind: "folder", sheetGid: null },
        auth
      )
    ).toMatchObject({ status: "active", ancestorIds: ["P1", "ROOT"] })
    const logs: string[] = []
    vi.mocked(files.getDriveFile).mockResolvedValueOnce(
      file("G1234567890", { mimeType: DRIVE_SPREADSHEET_MIME })
    )
    vi.mocked(sheets.getSheetMeta).mockResolvedValueOnce({
      spreadsheetTitle: "S",
      title: "T",
      gid: 5,
      rowCount: 1,
    })
    vi.mocked(files.listAncestorIds).mockRejectedValueOnce(
      new DriveError("rate_limited")
    )
    const r = await checkDriveSourceHealth(
      { ...base, kind: "sheet", sheetGid: 5 },
      auth,
      { log: (m) => logs.push(m) }
    )
    expect(r).toMatchObject({ status: "active" })
    expect(r!.ancestorIds).toBeUndefined()
    expect(logs.join(" ")).toMatch(/ancestor refresh failed/)
    // broken sources do not walk
    vi.mocked(files.listAncestorIds).mockClear()
    vi.mocked(files.getDriveFile).mockResolvedValueOnce(
      file("G1234567890", { trashed: true })
    )
    expect(
      await checkDriveSourceHealth(
        { ...base, kind: "folder", sheetGid: null },
        auth
      )
    ).not.toHaveProperty("ancestorIds")
    expect(files.listAncestorIds).not.toHaveBeenCalled()
  })

  it("a folder that is no longer a folder / a sheet tab that was deleted → error", async () => {
    vi.mocked(files.getDriveFile).mockResolvedValueOnce(
      file("G1234567890", { mimeType: "image/png" })
    )
    expect(
      await checkDriveSourceHealth(
        { ...base, kind: "folder", sheetGid: null },
        auth
      )
    ).toMatchObject({
      status: "error",
    })
    vi.mocked(files.getDriveFile).mockResolvedValueOnce(
      file("G1234567890", { mimeType: DRIVE_SPREADSHEET_MIME })
    )
    vi.mocked(sheets.getSheetMeta).mockRejectedValueOnce(
      new DriveError("sheet_tab_not_found")
    )
    expect(
      await checkDriveSourceHealth(
        { ...base, kind: "sheet", sheetGid: 5 },
        auth
      )
    ).toMatchObject({
      status: "error",
      statusMessage: new DriveError("sheet_tab_not_found").userMessageVi,
    })
  })
})

describe.skipIf(!HAS_DB)("runDriveHealth (DB)", () => {
  const ids = {
    sysCred: randomUUID(),
    badCred: randomUUID(),
    offCred: randomUUID(),
  }
  const src: Record<string, string> = {}

  beforeAll(async () => {
    // dedicated test DB: retire any leftover live system credential (one live system row allowed)
    await db.execute(
      sql`update drive_credentials set deleted_at = now() where kind = 'system' and deleted_at is null`
    )
    await db.insert(user).values({
      id: owner.id,
      name: owner.id,
      email: owner.email,
      role: "staff",
      emailVerified: true,
    })
    await db.insert(driveCredentials).values([
      {
        id: ids.sysCred,
        kind: "system",
        credentialsEncrypted: encryptServiceAccount(
          ids.sysCred,
          sa("ok@p.iam.gserviceaccount.com")
        ),
        clientEmail: "ok@p.iam.gserviceaccount.com",
        status: "error",
        statusMessage: "old",
      },
      {
        id: ids.badCred,
        kind: "personal",
        ownerId: owner.id,
        credentialsEncrypted: encryptServiceAccount(
          ids.badCred,
          sa("bad@p.iam.gserviceaccount.com")
        ),
        clientEmail: "bad@p.iam.gserviceaccount.com",
      },
      {
        id: ids.offCred,
        kind: "personal",
        ownerId: owner.id,
        credentialsEncrypted: encryptServiceAccount(
          ids.offCred,
          sa("off@p.iam.gserviceaccount.com")
        ),
        clientEmail: "off@p.iam.gserviceaccount.com",
        status: "disabled",
      },
    ])
    const mk = async (
      key: string,
      v: {
        credentialId: string
        kind?: "folder" | "sheet"
        sheetGid?: number | null
        status?: string
        config?: object
        deleted?: boolean
      }
    ) => {
      const id = randomUUID()
      src[key] = id
      await db.insert(driveSources).values({
        id,
        ownerId: owner.id,
        credentialId: v.credentialId,
        kind: v.kind ?? "folder",
        scope: "personal",
        googleId: `${PREFIX}-${key}`,
        sheetGid: v.kind === "sheet" ? (v.sheetGid ?? 0) : null,
        resourceKeyEncrypted:
          key === "ok" ? encryptSourceResourceKey(id, "rk-ok") : null,
        name: key,
        config: (v.config ?? {}) as never,
        status: v.status ?? "active",
        deletedAt: v.deleted ? new Date() : null,
      })
    }
    await mk("ok", { credentialId: ids.sysCred, status: "error" })
    await mk("trashed", { credentialId: ids.sysCred })
    await mk("busy", { credentialId: ids.sysCred })
    await mk("sheetOk", {
      credentialId: ids.sysCred,
      kind: "sheet",
      config: { writeback: true },
    })
    await mk("sheetNoEdit", {
      credentialId: ids.sysCred,
      kind: "sheet",
      sheetGid: 7,
      config: { writeback: true },
    })
    await mk("disabled", { credentialId: ids.sysCred, status: "disabled" })
    await mk("deleted", { credentialId: ids.sysCred, deleted: true })
    await mk("ofBadCred", { credentialId: ids.badCred })
    await mk("ofOffCred", { credentialId: ids.offCred })

    vi.mocked(files.checkServiceAccountAccess).mockImplementation(
      async (auth) => {
        if (
          auth.type === "service_account" &&
          auth.sa.clientEmail.startsWith("bad")
        )
          throw new DriveError("auth_failed")
      }
    )
    vi.mocked(files.getDriveFile).mockImplementation(
      async (_auth, id, opts) => {
        const key = id.slice(PREFIX.length + 1)
        if (key === "ok") {
          expect(opts?.resourceKey).toBe("rk-ok")
          return file(id, {
            name: "Thư mục\u0007 creative",
            driveId: "SHARED1",
          })
        }
        if (key === "trashed") return file(id, { trashed: true })
        if (key === "busy") throw new DriveError("rate_limited")
        if (key === "sheetOk")
          return file(id, { mimeType: DRIVE_SPREADSHEET_MIME, canEdit: true })
        if (key === "sheetNoEdit")
          return file(id, { mimeType: DRIVE_SPREADSHEET_MIME, canEdit: false })
        throw new Error(`unexpected Google call for ${key}`)
      }
    )
    vi.mocked(files.listAncestorIds).mockImplementation(async (_auth, f) => {
      const key = f.id.slice(PREFIX.length + 1)
      if (key === "ok") return ["P1", "ROOT"]
      throw new DriveError("timeout")
    })
    vi.mocked(sheets.getSheetMeta).mockResolvedValue({
      spreadsheetTitle: "S",
      title: "T",
      gid: 0,
      rowCount: 10,
    })
  })

  afterAll(async () => {
    if (!HAS_DB) return
    await db
      .delete(driveSources)
      .where(like(driveSources.googleId, `${PREFIX}-%`))
    await db
      .delete(driveCredentials)
      .where(inArray(driveCredentials.id, Object.values(ids)))
    await db.delete(user).where(eq(user.id, owner.id))
  })

  it("updates statuses, keeps transient / disabled / deleted rows and never throws", async () => {
    const logs: string[] = []
    const summary = await runDriveHealth({ log: (m) => logs.push(m) })
    expect(summary.credentials.error).toBeGreaterThanOrEqual(1)

    const creds = await db
      .select()
      .from(driveCredentials)
      .where(inArray(driveCredentials.id, Object.values(ids)))
    const cred = (id: string) => creds.find((c) => c.id === id)!
    expect(cred(ids.sysCred)).toMatchObject({
      status: "active",
      statusMessage: null,
    })
    expect(cred(ids.sysCred).lastCheckedAt).toBeInstanceOf(Date)
    expect(cred(ids.badCred)).toMatchObject({
      status: "error",
      statusMessage: new DriveError("auth_failed").userMessageVi,
    })
    expect(cred(ids.offCred)).toMatchObject({
      status: "disabled",
      lastCheckedAt: null,
    })

    const rows = await db
      .select()
      .from(driveSources)
      .where(like(driveSources.googleId, `${PREFIX}-%`))
    const s = (k: string) => rows.find((r) => r.id === src[k])!
    expect(s("ok")).toMatchObject({
      status: "active",
      statusMessage: null,
      googleName: "Thư mục  creative",
      sharedDriveId: "SHARED1",
      ancestorIds: ["P1", "ROOT"],
    })
    // ancestor walk failed → stored value kept (still healthy)
    expect(s("sheetOk")).toMatchObject({ status: "active", ancestorIds: [] })
    expect(s("trashed")).toMatchObject({
      status: "error",
      statusMessage: new DriveError("not_found").userMessageVi,
    })
    expect(s("busy")).toMatchObject({ status: "active", lastCheckedAt: null })
    expect(s("sheetOk")).toMatchObject({ status: "active" })
    expect(s("sheetNoEdit")).toMatchObject({
      status: "error",
      statusMessage: new DriveError("permission_denied").userMessageVi,
    })
    expect(s("disabled")).toMatchObject({
      status: "disabled",
      lastCheckedAt: null,
    })
    expect(s("deleted").lastCheckedAt).toBeNull()
    expect(s("ofBadCred")).toMatchObject({
      status: "error",
      statusMessage: new DriveError("auth_failed").userMessageVi,
    })
    expect(s("ofOffCred").lastCheckedAt).toBeNull()
    // a health check is not an edit
    expect(s("ok").updatedAt.getTime()).toBe(s("ok").createdAt.getTime())
    expect(logs.join("\n")).toMatch(/drive\.health: credentials ok=/)
    expect(logs.join("\n")).not.toMatch(/PRIVATE KEY|rk-ok/)
  })

  it("T-2: ancestors = own credential ∪ system credential; a source now inside another user's personal folder is flagged", async () => {
    const other = { id: `${PREFIX}-other`, email: `${PREFIX}-x@test.local` }
    await db.insert(user).values({
      id: other.id,
      name: other.id,
      email: other.email,
      role: "staff",
      emailVerified: true,
    })
    const goodCred = randomUUID()
    await db.insert(driveCredentials).values({
      id: goodCred,
      kind: "personal",
      ownerId: owner.id,
      credentialsEncrypted: encryptServiceAccount(
        goodCred,
        sa("good@p.iam.gserviceaccount.com")
      ),
      clientEmail: "good@p.iam.gserviceaccount.com",
    })
    const ins = async (
      key: string,
      v: { ownerId: string; credentialId: string; scope?: string }
    ) => {
      const id = randomUUID()
      src[key] = id
      await db.insert(driveSources).values({
        id,
        ownerId: v.ownerId,
        credentialId: v.credentialId,
        kind: "folder",
        scope: v.scope ?? "personal",
        googleId: `${PREFIX}-${key}`,
        name: key,
      })
    }
    // a personal folder of ANOTHER user, the folders checked against it
    await ins("othersFolder", { ownerId: other.id, credentialId: ids.sysCred })
    await ins("union", { ownerId: owner.id, credentialId: goodCred })
    await ins("moved", { ownerId: owner.id, credentialId: ids.sysCred })
    await ins("movedCompany", {
      ownerId: owner.id,
      credentialId: ids.sysCred,
      scope: "company",
    })
    try {
      const base = vi.mocked(files.getDriveFile).getMockImplementation()!
      vi.mocked(files.getDriveFile).mockImplementation(async (auth, id, o) => {
        const key = id.slice(PREFIX.length + 1)
        if (["othersFolder", "union", "moved", "movedCompany"].includes(key))
          return file(id)
        return base(auth, id, o)
      })
      const baseAnc = vi.mocked(files.listAncestorIds).getMockImplementation()!
      vi.mocked(files.listAncestorIds).mockImplementation(
        async (auth, f, o) => {
          const key = f.id.slice(PREFIX.length + 1)
          const email =
            auth.type === "service_account" ? auth.sa.clientEmail : ""
          if (key === "union")
            // the personal service account sees one parent, the system one sees more
            return email.startsWith("good") ? ["P-OWN"] : ["P-SYS", "P-OWN"]
          if (key === "moved" || key === "movedCompany")
            return [`${PREFIX}-othersFolder`, "ROOT"]
          if (key === "othersFolder") return ["ROOT"]
          return baseAnc(auth, f, o)
        }
      )
      await runDriveHealth()
      const rows = await db
        .select()
        .from(driveSources)
        .where(like(driveSources.googleId, `${PREFIX}-%`))
      const s = (k: string) => rows.find((r) => r.id === src[k])!
      expect(s("union")).toMatchObject({
        status: "active",
        ancestorIds: ["P-OWN", "P-SYS"],
      })
      expect(s("othersFolder")).toMatchObject({ status: "active" })
      for (const k of ["moved", "movedCompany"]) {
        expect(s(k)).toMatchObject({
          status: "error",
          statusMessage: driveJobs.sources.insideOtherPersonal,
          ancestorIds: [`${PREFIX}-othersFolder`, "ROOT"],
        })
      }
      // the personal folder's own owner is not flagged for being inside it
      expect(
        await insideOtherPersonalFolder(other.id, `${PREFIX}-x`, [
          `${PREFIX}-othersFolder`,
        ])
      ).toBe(false)
      expect(
        await insideOtherPersonalFolder(owner.id, `${PREFIX}-x`, [
          `${PREFIX}-othersFolder`,
        ])
      ).toBe(true)
    } finally {
      await db
        .delete(driveSources)
        .where(
          inArray(driveSources.id, [
            src.othersFolder!,
            src.union!,
            src.moved!,
            src.movedCompany!,
          ])
        )
      await db.delete(driveCredentials).where(eq(driveCredentials.id, goodCred))
      await db.delete(user).where(eq(user.id, other.id))
    }
  })
})
