// Integration tests for the Google Drive services (credentials, sources, MCP scope) against the test Postgres
// (skipped without DATABASE_URL). Google is a fake in-memory Drive (src/server/drive/{files,sheets} mocked) - no
// network. One file on purpose: the system credential is a singleton (one live row), so these tests run in order.
import { randomUUID } from "node:crypto"
import { and, eq, inArray, isNull } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { DriveFile } from "@/server/drive/types"

const g = vi.hoisted(() => ({
  failLog: false,
  files: new Map<string, unknown>(),
  children: new Map<string, unknown[]>(),
  /** checkServiceAccountAccess / getDriveFile failure to throw (one call) */
  checkFail: null as unknown,
  getFail: null as unknown,
  header: [] as string[],
  rows: [] as { rowNumber: number; cells: string[] }[],
  /** cacheKeys that may NOT see a file id (hidden from that credential) */
  hidden: new Map<string, Set<string>>(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...mod,
    logActivity: async (
      entry: Parameters<typeof mod.logActivity>[0],
      tx?: Parameters<typeof mod.logActivity>[1]
    ) => {
      if (g.failLog) throw new Error("simulated activity log failure")
      return mod.logActivity({ ...entry, ip: null, userAgent: null }, tx)
    },
  }
})

vi.mock("@/server/drive/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/drive/files")>()
  const { DriveError } = await import("@/server/drive/errors")
  type F = import("@/server/drive/types").DriveFile
  type A = import("@/server/drive/types").DriveAuth
  const get = (auth: A, id: string): F => {
    const f = g.files.get(id) as F | undefined
    const key = auth.type === "service_account" ? auth.cacheKey : "api_key"
    if (!f || g.hidden.get(key)?.has(id)) throw new DriveError("not_found")
    return f
  }
  const ancestors = (auth: A, file: F): string[] => {
    const out: string[] = []
    const seen = new Set([file.id])
    let level = [...file.parents]
    for (let d = 0; d < 10 && level.length; d++) {
      const next: string[] = []
      for (const p of level) {
        if (seen.has(p)) continue
        seen.add(p)
        out.push(p)
        try {
          next.push(...get(auth, p).parents)
        } catch {
          /* hidden parent ends the branch */
        }
      }
      level = next
    }
    return out
  }
  return {
    ...actual,
    getDriveFile: async (auth: A, id: string) => {
      if (g.getFail) {
        const e = g.getFail
        g.getFail = null
        throw e
      }
      return get(auth, id)
    },
    resolveShortcut: async (auth: A, f: F) =>
      f.shortcut ? get(auth, f.shortcut.targetId) : f,
    listAncestorIds: async (auth: A, f: F) => ancestors(auth, f),
    // documented semantics (files.ts): a branch reaching a `blocked` id before a candidate is pruned
    findAncestorIn: async (
      auth: A,
      f: F,
      set: ReadonlySet<string>,
      opts: { blocked?: ReadonlySet<string> } = {}
    ) => {
      if (f.mimeType === "application/vnd.google-apps.folder" && set.has(f.id))
        return f.id
      const seen = new Set([f.id])
      let level = [...f.parents]
      for (let d = 0; d < 10 && level.length; d++) {
        const next: string[] = []
        for (const p of level) {
          if (seen.has(p)) continue
          seen.add(p)
          if (set.has(p)) return p
          if (opts.blocked?.has(p)) continue
          try {
            next.push(...get(auth, p).parents)
          } catch {
            /* hidden parent ends the branch */
          }
        }
        level = next
      }
      return null
    },
    listDriveFolder: async (
      _auth: A,
      id: string,
      opts: { family?: string } = {}
    ) => ({
      files: ((g.children.get(id) ?? []) as F[]).filter(
        (c) =>
          !opts.family ||
          opts.family === "all" ||
          c.mimeType.startsWith(`${opts.family}/`) ||
          c.mimeType === "application/vnd.google-apps.folder"
      ),
      nextPageToken: null,
    }),
    checkServiceAccountAccess: async () => {
      if (g.checkFail) {
        const e = g.checkFail
        g.checkFail = null
        throw e
      }
    },
    fetchDriveThumbnail: async () => ({
      contentType: "image/png",
      bytes: Buffer.from("png"),
    }),
  }
})

vi.mock("@/server/drive/sheets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/drive/sheets")>()
  return {
    ...actual,
    getSheetMeta: async (_a: unknown, _id: string, gid: number) => ({
      spreadsheetTitle: "Creative",
      title: "Tuần 41",
      gid,
      rowCount: 100,
    }),
    readSheetRows: async (
      _a: unknown,
      _id: string,
      _t: string,
      o: { maxRows: number }
    ) => ({
      header: [...g.header],
      rows: g.rows.slice(0, o.maxRows),
      nextRow: null,
    }),
  }
})

import { driveJobs } from "@/lib/i18n/vi/drive-jobs"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { aad, decryptSecret, encryptJson } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  activityLogs,
  adAccounts,
  connections,
  driveCredentials,
  driveMediaUploads,
  driveSources,
  mcpDriveScopes,
  mcpServers,
  user,
} from "@/server/db/schema"
import {
  saJson,
  SA_EMAIL,
  TEST_API_KEY,
} from "@/server/drive/__fixtures__/google-fetch"
import { DriveError } from "@/server/drive/errors"
import { driveCredentialCacheKey } from "@/server/drive/store"
import { DRIVE_FOLDER_MIME } from "@/server/drive/types"
import {
  createMcpServer,
  getMcpServer,
  updateMcpServer,
} from "@/server/services/mcp-servers"

import {
  createPersonalDriveCredential,
  deletePersonalDriveCredential,
  deleteSystemDriveCredential,
  getDriveSystemInfo,
  getSystemDriveCredential,
  listPersonalDriveCredentials,
  saveSystemDriveCredential,
  testSystemDriveCredential,
  type DriveActor,
} from "./drive-credentials"
import {
  createDriveSource,
  deleteDriveSource,
  DRIVE_SPREADSHEET_MIME,
  DriveServiceError,
  getDriveSource,
  getDriveSourceThumbnail,
  listDriveSourceFiles,
  listDriveSources,
  listDriveSourceOptionsForMcp,
  listDriveSourcesForMcpScope,
  previewDriveSheetRows,
  previewDriveSource,
  recheckDriveSource,
  updateDriveSource,
} from "./drive-sources"

const HAS_DB = !!process.env.DATABASE_URL
const P = `tdrv_${randomUUID().slice(0, 8)}`
const admin: DriveActor = {
  id: `${P}_admin`,
  email: `${P}_admin@test.local`,
  role: "admin",
}
const staffA: DriveActor = {
  id: `${P}_a`,
  email: `${P}_a@test.local`,
  role: "staff",
}
const staffB: DriveActor = {
  id: `${P}_b`,
  email: `${P}_b@test.local`,
  role: "staff",
}
const actors = [admin, staffA, staffB]
const okVerify = async () => "ok" as const
/** the one message staff get for not found / wrong type / trashed / claimed / inside or containing (L6) */
const REFUSED = driveUi.service.registrationRefused

// fake Drive ids ([A-Za-z0-9_-]{10,})
const ID = {
  root: "ROOTmyDrive0001",
  company: "COMPANYfolder01",
  companySub: "COMPANYsub00001",
  aFolder: "STAFFAfolder001",
  aSub: "STAFFAsub000001",
  bFolder: "STAFFBfolder001",
  sheet: "SHEETspread0001",
  sheetRo: "SHEETreadonly01",
  img: "IMGfile00000001",
  vid: "VIDfile00000001",
  outsideImg: "IMGoutside00001",
  pdf: "PDFfile00000001",
}
const folderLink = (id: string) =>
  `https://drive.google.com/drive/folders/${id}`
const sheetLink = (id: string, gid: number | null = 0) =>
  `https://docs.google.com/spreadsheets/d/${id}/edit${gid === null ? "" : `#gid=${gid}`}`

function file(id: string, over: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name: id,
    mimeType: DRIVE_FOLDER_MIME,
    sizeBytes: null,
    md5: null,
    headRevisionId: null,
    version: "1",
    modifiedTime: "2026-10-08T03:00:00.000Z",
    parents: [ID.root],
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

function seedDrive() {
  g.files.clear()
  g.children.clear()
  g.hidden.clear()
  const add = (f: DriveFile) => g.files.set(f.id, f)
  add(file(ID.root, { parents: [] }))
  add(file(ID.company, { name: "Creative công ty" }))
  add(file(ID.companySub, { name: "Tuần 41", parents: [ID.company] }))
  add(file(ID.aFolder, { name: "Thư mục A" }))
  add(file(ID.aSub, { name: "A con", parents: [ID.aFolder] }))
  add(file(ID.bFolder, { name: "Thư mục B" }))
  add(
    file(ID.sheet, {
      name: "Sheet creative",
      mimeType: DRIVE_SPREADSHEET_MIME,
      canEdit: true,
    })
  )
  add(
    file(ID.sheetRo, {
      name: "Sheet chỉ xem",
      mimeType: DRIVE_SPREADSHEET_MIME,
    })
  )
  const img = file(ID.img, {
    name: "banner.jpg",
    mimeType: "image/jpeg",
    parents: [ID.companySub],
    sizeBytes: 2048,
    md5: "abc",
  })
  const vid = file(ID.vid, {
    name: "clip.mp4",
    mimeType: "video/mp4",
    parents: [ID.company],
    sizeBytes: 9000,
  })
  const pdf = file(ID.pdf, {
    name: "brief.pdf",
    mimeType: "application/pdf",
    parents: [ID.company],
  })
  add(img)
  add(vid)
  add(pdf)
  add(
    file(ID.outsideImg, {
      name: "other.png",
      mimeType: "image/png",
      parents: [ID.bFolder],
    })
  )
  g.children.set(ID.company, [g.files.get(ID.companySub), vid, pdf])
  g.children.set(ID.companySub, [img])
  g.header = [
    "Link Drive",
    "Tên creative",
    "Nền tảng",
    "Tài khoản QC",
    "Trạng thái",
    "Mã media",
    "Ghi chú hệ thống",
  ]
  g.rows = [
    {
      rowNumber: 2,
      cells: [
        "https://drive.google.com/file/d/IMGfile00000001/view",
        "Banner",
        "Facebook",
        "act_1",
        "Chờ lên",
      ],
    },
    {
      rowNumber: 3,
      cells: [
        "https://drive.google.com/file/d/VIDfile00000001/view",
        "Clip",
        "TikTok",
        "",
        "Đã lên",
      ],
    },
    {
      rowNumber: 5,
      cells: [
        "https://drive.google.com/file/d/IMGfile00000001/view",
        "Banner 2",
        "",
        "",
        "",
      ],
    },
  ]
}

async function expectServiceError(
  p: Promise<unknown>,
  match: RegExp | string,
  field?: string
) {
  const e = await p.then(
    () => null,
    (err: unknown) => err
  )
  expect(e, "expected a DriveServiceError").toBeInstanceOf(DriveServiceError)
  const err = e as DriveServiceError
  if (typeof match === "string") expect(err.message).toContain(match)
  else expect(err.message).toMatch(match)
  if (field) expect(err.fieldErrors?.[field]).toBeTruthy()
  return err
}

async function logs(action: string, targetId?: string) {
  return db
    .select()
    .from(activityLogs)
    .where(
      and(
        inArray(
          activityLogs.actorId,
          actors.map((a) => a.id)
        ),
        eq(activityLogs.action, action),
        targetId ? eq(activityLogs.targetId, targetId) : undefined
      )
    )
}

function noSecrets(v: unknown) {
  const json = JSON.stringify(v)
  expect(json).not.toContain("PRIVATE KEY")
  expect(json).not.toContain("AIza")
  expect(json).not.toMatch(/"v\d+\.[A-Za-z0-9_-]+\./) // ciphertext
}

describe.skipIf(!HAS_DB)("Google Drive services (DB)", () => {
  const ids = {
    connA: randomUUID(),
    connB: randomUUID(),
    accA: randomUUID(),
    accB: randomUUID(),
    companySource: "",
    aSource: "",
    bSource: "",
    sheetSource: "",
  }

  beforeAll(async () => {
    seedDrive()
    // the test db belongs to these tests: start without a live system credential
    const sys = await db
      .select({ id: driveCredentials.id })
      .from(driveCredentials)
      .where(
        and(
          eq(driveCredentials.kind, "system"),
          isNull(driveCredentials.deletedAt)
        )
      )
    if (sys.length) {
      await db
        .update(driveSources)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            driveSources.credentialId,
            sys.map((s) => s.id)
          )
        )
      await db
        .update(driveCredentials)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            driveCredentials.id,
            sys.map((s) => s.id)
          )
        )
    }
    await db.insert(user).values(
      actors.map((a) => ({
        id: a.id,
        name: a.id,
        email: a.email,
        emailVerified: true,
        role: a.role,
        twoFactorEnabled: a.role === "admin",
      }))
    )
    const conn = (id: string, ownerId: string) => ({
      id,
      ownerId,
      platform: "meta" as const,
      name: `${P} ${ownerId}`,
      status: "active",
      credentialsEncrypted: encryptJson(
        { accessToken: "x" },
        aad.connectionCredentials(id)
      ),
      credentialHint: "xxxx",
    })
    await db
      .insert(connections)
      .values([conn(ids.connA, staffA.id), conn(ids.connB, staffB.id)])
    const acc = (id: string, connectionId: string, ext: string) => ({
      id,
      connectionId,
      platform: "meta" as const,
      externalId: ext,
      name: ext,
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
      status: "active",
      isEnabled: true,
    })
    await db
      .insert(adAccounts)
      .values([
        acc(ids.accA, ids.connA, "act_a1"),
        acc(ids.accB, ids.connB, "act_b1"),
      ])
  })

  beforeEach(() => {
    g.failLog = false
    g.checkFail = null
    g.getFail = null
  })

  afterAll(async () => {
    if (!HAS_DB) return
    const owners = actors.map((a) => a.id)
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
    await db
      .delete(driveMediaUploads)
      .where(inArray(driveMediaUploads.adAccountId, [ids.accA, ids.accB]))
    await db.delete(driveSources).where(inArray(driveSources.ownerId, owners))
    const sys = await db
      .select({ id: driveCredentials.id })
      .from(driveCredentials)
      .where(eq(driveCredentials.clientEmail, SA_EMAIL))
    if (sys.length) {
      await db.delete(driveSources).where(
        inArray(
          driveSources.credentialId,
          sys.map((s) => s.id)
        )
      )
      await db.delete(driveCredentials).where(
        inArray(
          driveCredentials.id,
          sys.map((s) => s.id)
        )
      )
    }
    await db
      .delete(driveCredentials)
      .where(inArray(driveCredentials.ownerId, owners))
    await db.delete(connections).where(inArray(connections.ownerId, owners))
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
    await db.delete(user).where(inArray(user.id, owners))
  })

  // -------------------------------------------------------------------------
  // System credential
  // -------------------------------------------------------------------------

  it("system credential: admin only; nothing configured yet", async () => {
    await expectServiceError(getSystemDriveCredential(staffA), "quản trị viên")
    await expectServiceError(
      saveSystemDriveCredential(staffA, { serviceAccountJson: saJson() }),
      "quản trị viên"
    )
    expect(await getDriveSystemInfo()).toEqual({
      configured: false,
      clientEmail: null,
      hasApiKey: false,
      status: null,
    })
    await expectServiceError(
      saveSystemDriveCredential(admin, {}),
      "JSON",
      "serviceAccountJson"
    )
    await expectServiceError(
      saveSystemDriveCredential(admin, {
        serviceAccountJson: '{"type":"user"}',
      }),
      "service_account",
      "serviceAccountJson"
    )
    // Google refuses the key (API not enabled): Vietnamese reason, nothing stored
    g.checkFail = new DriveError("api_disabled")
    await expectServiceError(
      saveSystemDriveCredential(admin, { serviceAccountJson: saJson() }),
      "Google Drive API",
      "serviceAccountJson"
    )
    expect((await getSystemDriveCredential(admin)).configured).toBe(false)
  })

  it("system credential: saved encrypted, DTOs carry hints only, activity in the same transaction", async () => {
    // activity log failure → nothing saved
    g.failLog = true
    await expect(
      saveSystemDriveCredential(admin, {
        serviceAccountJson: saJson(),
        apiKey: TEST_API_KEY,
      })
    ).rejects.toThrow("simulated activity log failure")
    g.failLog = false
    expect((await getSystemDriveCredential(admin)).configured).toBe(false)

    const dto = await saveSystemDriveCredential(admin, {
      serviceAccountJson: saJson(),
      apiKey: TEST_API_KEY,
    })
    expect(dto).toMatchObject({
      configured: true,
      clientEmail: SA_EMAIL,
      hasApiKey: true,
      apiKeyHint: TEST_API_KEY.slice(-4),
      credentialHint: "ve-1",
      projectId: "demo-project",
      status: "active",
      sourceCount: 0,
    })
    noSecrets(dto)
    const [row] = await db
      .select()
      .from(driveCredentials)
      .where(eq(driveCredentials.id, dto.id!))
    expect(row!.credentialsEncrypted).not.toContain("PRIVATE KEY")
    expect(row!.apiKeyEncrypted).not.toContain(TEST_API_KEY)
    expect(
      decryptSecret(row!.apiKeyEncrypted!, aad.driveCredentialApiKey(row!.id))
    ).toBe(TEST_API_KEY)
    const created = await logs("drive_credential.create", dto.id!)
    expect(created).toHaveLength(1)
    noSecrets(created[0]!.metadata)
    // staff only learn what they need to share folders
    expect(await getDriveSystemInfo()).toEqual({
      configured: true,
      clientEmail: SA_EMAIL,
      hasApiKey: true,
      status: "active",
    })
  })

  it("system credential: API key cleared / replaced (keep the JSON), activity update", async () => {
    let dto = await saveSystemDriveCredential(admin, { clearApiKey: true })
    expect([dto.hasApiKey, dto.apiKeyHint]).toEqual([false, null])
    await expectServiceError(
      saveSystemDriveCredential(admin, {
        apiKey: TEST_API_KEY,
        clearApiKey: true,
      }),
      "API key",
      "apiKey"
    )
    dto = await saveSystemDriveCredential(admin, { apiKey: TEST_API_KEY })
    expect(dto.hasApiKey).toBe(true)
    const updates = await logs("drive_credential.update", dto.id!)
    expect(updates).toHaveLength(2)
    expect(updates.map((u) => u.metadata)).toContainEqual(
      expect.objectContaining({
        before: { apiKeyHint: TEST_API_KEY.slice(-4) },
        after: { apiKeyHint: null },
      })
    )
    noSecrets(updates.map((u) => u.metadata))
  })

  it("system credential test: pass → active; config problem → error; Google unreachable → unchanged", async () => {
    expect(await testSystemDriveCredential(admin)).toMatchObject({
      ok: true,
      status: "active",
      statusMessage: null,
    })
    g.checkFail = new DriveError("auth_failed")
    const bad = await testSystemDriveCredential(admin)
    expect(bad).toMatchObject({ ok: false, status: "error" })
    expect(bad.statusMessage).toContain("Service account")
    g.checkFail = new DriveError("timeout")
    expect(await testSystemDriveCredential(admin)).toMatchObject({
      ok: false,
      status: "error",
    })
    expect(await testSystemDriveCredential(admin)).toMatchObject({
      ok: true,
      status: "active",
    })
    const tests = await logs("drive_credential.test")
    expect(tests.map((t) => t.status).sort()).toEqual([
      "failure",
      "failure",
      "success",
      "success",
    ])
  })

  // -------------------------------------------------------------------------
  // Personal credentials
  // -------------------------------------------------------------------------

  it("personal credentials: the system service account is refused, own key accepted, owner-only access", async () => {
    await expectServiceError(
      createPersonalDriveCredential(staffA, {
        name: "A key",
        serviceAccountJson: saJson(),
      }),
      "service account hệ thống",
      "serviceAccountJson"
    )
    const res = await createPersonalDriveCredential(staffA, {
      name: "A key",
      serviceAccountJson: saJson({
        client_email: `a-own@${P.replace(/_/g, "-")}.iam.gserviceaccount.com`,
      }),
    })
    const listA = await listPersonalDriveCredentials(staffA)
    expect(listA.map((c) => c.id)).toEqual([res.id])
    noSecrets(listA)
    expect(await listPersonalDriveCredentials(staffB)).toEqual([])
    expect(
      (await listPersonalDriveCredentials(admin)).map((c) => c.id)
    ).toContain(res.id)
    await expectServiceError(
      deletePersonalDriveCredential(staffB, res.id),
      "Không tìm thấy"
    )
    // B cannot read folders with A's key
    await expectServiceError(
      previewDriveSource(staffB, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.bFolder),
        credentialId: res.id,
      }),
      "của chính mình",
      "credentialId"
    )
    // A can (sources of A's key are A's own)
    const p = await previewDriveSource(staffA, {
      kind: "folder",
      scope: "personal",
      link: folderLink(ID.bFolder),
      credentialId: res.id,
    })
    expect(p.credential).toMatchObject({
      id: res.id,
      kind: "personal",
      name: "A key",
    })
    await deletePersonalDriveCredential(staffA, res.id)
    expect(await listPersonalDriveCredentials(staffA)).toEqual([])
    expect(await logs("drive_credential.delete", res.id)).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  it("company sources: admin only; preview counts images / videos / folders", async () => {
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "folder",
        scope: "company",
        link: folderLink(ID.company),
      }),
      "quản trị viên"
    )
    const p = await previewDriveSource(admin, {
      kind: "folder",
      scope: "company",
      link: folderLink(ID.company),
    })
    expect(p).toMatchObject({
      kind: "folder",
      scope: "company",
      googleId: ID.company,
      googleName: "Creative công ty",
      folder: { images: 0, videos: 1, folders: 1, more: false },
      credential: { kind: "system", clientEmail: SA_EMAIL },
    })
    // activity failure → no source
    g.failLog = true
    await expect(
      createDriveSource(admin, {
        kind: "folder",
        scope: "company",
        link: folderLink(ID.company),
      })
    ).rejects.toThrow()
    g.failLog = false
    expect(
      await db
        .select()
        .from(driveSources)
        .where(eq(driveSources.googleId, ID.company))
    ).toHaveLength(0)

    const res = await createDriveSource(admin, {
      kind: "folder",
      scope: "company",
      link: folderLink(ID.company),
      recursiveDepth: 2,
    })
    ids.companySource = res.id
    expect(res.source).toMatchObject({
      name: "Creative công ty",
      folder: { recursiveDepth: 2 },
      canManage: true,
    })
    expect(await logs("drive_source.create", res.id)).toHaveLength(1)
  })

  it("link checks: kind mismatch, sheet without #gid, invalid link, trashed", async () => {
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "sheet",
        scope: "personal",
        link: folderLink(ID.aFolder),
      }),
      "Google Sheet",
      "link"
    )
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheet, null),
      }),
      "gid",
      "link"
    )
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "folder",
        scope: "personal",
        link: "https://example.com/x",
      }),
      "không hợp lệ",
      "link"
    )
    // a bare id of a spreadsheet given as a folder: admins get the reason, staff the generic refusal (L6)
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "personal",
        link: ID.sheet,
      }),
      "không phải thư mục",
      "link"
    )
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "folder",
        scope: "personal",
        link: ID.sheet,
      }),
      REFUSED,
      "link"
    )
    g.files.set(ID.bFolder, {
      ...(g.files.get(ID.bFolder) as DriveFile),
      trashed: true,
    })
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.bFolder),
      }),
      "thùng rác"
    )
    await expectServiceError(
      previewDriveSource(staffB, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.bFolder),
      }),
      REFUSED
    )
    g.files.set(ID.bFolder, {
      ...(g.files.get(ID.bFolder) as DriveFile),
      trashed: false,
    })
  })

  it("anti-claiming: first registration wins (staff never learn who), inside another's personal folder is refused", async () => {
    const a = await createDriveSource(staffA, {
      kind: "folder",
      scope: "personal",
      link: folderLink(ID.aFolder),
    })
    ids.aSource = a.id
    expect(a.source).toBeTruthy()
    // ancestors stored for the H1 "contains" check
    const [aRow] = await db
      .select({ ancestorIds: driveSources.ancestorIds })
      .from(driveSources)
      .where(eq(driveSources.id, a.id))
    expect(aRow!.ancestorIds).toEqual([ID.root])
    // staff: claimed / not found / inside another's folder all read the same (no oracle - L6)
    const bErr = await expectServiceError(
      createDriveSource(staffB, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.aFolder),
      }),
      REFUSED,
      "link"
    )
    expect(bErr.message).not.toContain(staffA.email)
    const notFound = await expectServiceError(
      previewDriveSource(staffB, {
        kind: "folder",
        scope: "personal",
        link: folderLink("NOPEnope0000001"),
      }),
      REFUSED,
      "link"
    )
    expect(notFound.message).toBe(bErr.message)
    // ... but their own registration is not a secret
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.aFolder),
      }),
      "Bạn đã khai báo",
      "link"
    )
    const adminErr = await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.aFolder),
      }),
      "đã được người khác khai báo"
    )
    expect(adminErr.message).toContain(staffA.email)
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "personal",
        link: folderLink("NOPEnope0000001"),
      }),
      "Không tìm thấy file"
    )
    const insideErr = await expectServiceError(
      createDriveSource(staffB, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.aSub),
      }),
      REFUSED,
      "link"
    )
    expect(insideErr.message).toBe(bErr.message)
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "company",
        link: folderLink(ID.aSub),
      }),
      "thư mục riêng của người khác",
      "link"
    )
    // the owner may register a sub-folder of their own folder; a sub-folder of a company folder is fine too
    expect(
      (
        await previewDriveSource(staffA, {
          kind: "folder",
          scope: "personal",
          link: folderLink(ID.aSub),
        })
      ).googleId
    ).toBe(ID.aSub)
    expect(
      (
        await previewDriveSource(staffB, {
          kind: "folder",
          scope: "personal",
          link: folderLink(ID.companySub),
        })
      ).googleId
    ).toBe(ID.companySub)
    const b = await createDriveSource(staffB, {
      kind: "folder",
      scope: "personal",
      link: folderLink(ID.bFolder),
      name: "Của B",
    })
    ids.bSource = b.id
    expect(b.source.name).toBe("Của B")
  })

  it("H1: a folder that CONTAINS another person's personal folder is refused (staff: generic; admin: how many)", async () => {
    // ROOT contains A's and B's personal folders
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.root),
      }),
      REFUSED,
      "link"
    )
    await expectServiceError(
      createDriveSource(staffB, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.root),
      }),
      REFUSED,
      "link"
    )
    const containsTwo = driveUi.service.containsOtherPersonal(2)
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "company",
        link: folderLink(ID.root),
      }),
      containsTwo,
      "link"
    )
    await expectServiceError(
      createDriveSource(admin, {
        kind: "folder",
        scope: "personal",
        link: folderLink(ID.root),
      }),
      containsTwo,
      "link"
    )
    expect(
      await db
        .select()
        .from(driveSources)
        .where(
          and(
            eq(driveSources.googleId, ID.root),
            isNull(driveSources.deletedAt)
          )
        )
    ).toHaveLength(0)

    // a source registered before migration 0008 has no ancestors yet: recheck (and drive.health) fills them in
    await db
      .update(driveSources)
      .set({ ancestorIds: [] })
      .where(eq(driveSources.id, ids.bSource))
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "company",
        link: folderLink(ID.root),
      }),
      driveUi.service.containsOtherPersonal(1)
    )
    expect((await recheckDriveSource(staffB, ids.bSource)).ok).toBe(true)
    const [bRow] = await db
      .select({ ancestorIds: driveSources.ancestorIds })
      .from(driveSources)
      .where(eq(driveSources.id, ids.bSource))
    expect(bRow!.ancestorIds).toEqual([ID.root])
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "folder",
        scope: "company",
        link: folderLink(ID.root),
      }),
      containsTwo
    )
    // the folder was moved: recheck stores the new path
    g.files.set(ID.bFolder, {
      ...(g.files.get(ID.bFolder) as DriveFile),
      parents: ["GONEparent0001"],
    })
    expect((await recheckDriveSource(staffB, ids.bSource)).ok).toBe(true)
    const [bRow2] = await db
      .select({ ancestorIds: driveSources.ancestorIds })
      .from(driveSources)
      .where(eq(driveSources.id, ids.bSource))
    expect(bRow2!.ancestorIds).toEqual(["GONEparent0001"])
    g.files.set(ID.bFolder, {
      ...(g.files.get(ID.bFolder) as DriveFile),
      parents: [ID.root],
    })
    await recheckDriveSource(staffB, ids.bSource)
  })

  it("visibility: staff see company + own; another staff member's source is 404; company writes are admin only", async () => {
    const listB = await listDriveSources(staffB)
    expect(listB.map((s) => s.id).sort()).toEqual(
      [ids.companySource, ids.bSource].sort()
    )
    expect(listB.find((s) => s.id === ids.companySource)).toMatchObject({
      canManage: false,
      isMine: false,
    })
    const listAdmin = await listDriveSources(admin)
    expect(listAdmin.map((s) => s.id)).toEqual(
      expect.arrayContaining([ids.companySource, ids.aSource, ids.bSource])
    )
    expect(listAdmin.find((s) => s.id === ids.aSource)).toMatchObject({
      canManage: true,
      owner: { email: staffA.email },
    })
    noSecrets(listAdmin)

    await expectServiceError(
      getDriveSource(staffB, ids.aSource),
      "Không tìm thấy"
    )
    await expectServiceError(
      updateDriveSource(staffB, { sourceId: ids.aSource, name: "x" }),
      "Không tìm thấy"
    )
    await expectServiceError(
      deleteDriveSource(staffB, ids.aSource),
      "Không tìm thấy"
    )
    await expectServiceError(
      listDriveSourceFiles(staffB, { sourceId: ids.aSource }),
      "Không tìm thấy"
    )
    await expectServiceError(
      updateDriveSource(staffB, { sourceId: ids.companySource, name: "x" }),
      "quản trị viên"
    )
    await expectServiceError(
      deleteDriveSource(staffA, ids.companySource),
      "quản trị viên"
    )
    await expectServiceError(
      recheckDriveSource(staffA, ids.companySource),
      "quản trị viên"
    )
    // admin manages a staff member's personal source (G4)
    const upd = await updateDriveSource(admin, {
      sourceId: ids.aSource,
      name: "A (admin sửa)",
      recursiveDepth: 1,
    })
    expect(upd).toMatchObject({
      name: "A (admin sửa)",
      folder: { recursiveDepth: 1 },
    })
    const [log] = await logs("drive_source.update", ids.aSource)
    expect(log!.metadata).toMatchObject({
      before: { name: expect.any(String), config: { recursiveDepth: 0 } },
      after: { name: "A (admin sửa)", config: { recursiveDepth: 1 } },
      ownerId: staffA.id,
    })
    expect((await getDriveSource(staffB, ids.companySource)).usedBy).toEqual([])
  })

  it("sheet sources: column mapping, write-back needs Editor + status column", async () => {
    const p = await previewDriveSource(staffA, {
      kind: "sheet",
      scope: "personal",
      link: sheetLink(ID.sheet, 0),
    })
    expect(p.sheet).toMatchObject({
      title: "Tuần 41",
      gid: 0,
      headerRow: 1,
      canEdit: true,
      suggestedColumns: {
        link: "Link Drive",
        name: "Tên creative",
        status: "Trạng thái",
        note: "Ghi chú hệ thống",
        adIds: null,
      },
    })
    await expectServiceError(
      createDriveSource(staffA, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheetRo, 0),
        writeback: true,
      }),
      "Người chỉnh sửa",
      "writeback"
    )
    await expectServiceError(
      createDriveSource(staffA, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheet, 0),
        columns: { link: "Link Drive", platform: "Kênh" },
      }),
      "tiêu đề",
      "columns.platform"
    )
    await expectServiceError(
      createDriveSource(staffA, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheet, 0),
        columns: { link: "Link Drive" },
        writeback: true,
      }),
      "trạng thái",
      "writeback"
    )
    const res = await createDriveSource(staffA, {
      kind: "sheet",
      scope: "personal",
      link: sheetLink(ID.sheet, 0),
      writeback: true,
    })
    ids.sheetSource = res.id
    expect(res.source).toMatchObject({
      kind: "sheet",
      sheetGid: 0,
      sheet: { writeback: true, columns: { status: "Trạng thái" } },
    })
    // M1: a spreadsheet is claimed as a whole - another tab only for the same owner + scope
    expect(
      (
        await previewDriveSource(staffA, {
          kind: "sheet",
          scope: "personal",
          link: sheetLink(ID.sheet, 7),
        })
      ).sheetGid
    ).toBe(7)
    await expectServiceError(
      previewDriveSource(staffA, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheet, 0),
      }),
      "Bạn đã khai báo",
      "link"
    )
    await expectServiceError(
      previewDriveSource(staffB, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheet, 7),
      }),
      REFUSED,
      "link"
    )
    const adminTab = await expectServiceError(
      previewDriveSource(admin, {
        kind: "sheet",
        scope: "company",
        link: sheetLink(ID.sheet, 9),
      }),
      "đã được người khác khai báo",
      "link"
    )
    expect(adminTab.message).toContain(staffA.email)
    // the same owner in another scope: all tabs of a spreadsheet share one scope
    const [sys] = await db
      .select({ id: driveCredentials.id })
      .from(driveCredentials)
      .where(
        and(
          eq(driveCredentials.kind, "system"),
          isNull(driveCredentials.deletedAt)
        )
      )
    const [tmp] = await db
      .insert(driveSources)
      .values({
        kind: "sheet",
        scope: "personal",
        ownerId: admin.id,
        credentialId: sys!.id,
        googleId: ID.sheetRo,
        sheetGid: 0,
        name: "tmp",
      })
      .returning({ id: driveSources.id })
    await expectServiceError(
      previewDriveSource(admin, {
        kind: "sheet",
        scope: "company",
        link: sheetLink(ID.sheetRo, 1),
      }),
      "phạm vi khác",
      "link"
    )
    expect(
      (
        await previewDriveSource(admin, {
          kind: "sheet",
          scope: "personal",
          link: sheetLink(ID.sheetRo, 1),
        })
      ).sheetGid
    ).toBe(1)
    await db.delete(driveSources).where(eq(driveSources.id, tmp!.id))
    // the claim also holds across credentials and inside the create transaction
    await expectServiceError(
      createDriveSource(staffB, {
        kind: "sheet",
        scope: "personal",
        link: sheetLink(ID.sheet, 3),
      }),
      REFUSED,
      "link"
    )

    const prev = await previewDriveSheetRows(staffA, res.id)
    expect(prev.statusCounts).toEqual({ "Chờ lên": 1, "Đã lên": 1, "": 1 })
    expect(prev.rows[0]).toEqual({
      rowNumber: 2,
      values: expect.objectContaining({
        link: expect.stringContaining(ID.img),
        platform: "Facebook",
        status: "Chờ lên",
      }),
    })
    expect(prev.missingColumns).toEqual([])
    await expectServiceError(
      previewDriveSheetRows(staffA, ids.aSource),
      "Google Sheet"
    )

    // disabling write-back needs no Google call; mapping an unknown column is refused
    expect(
      (await updateDriveSource(staffA, { sourceId: res.id, writeback: false }))
        .sheet?.writeback
    ).toBe(false)
    await expectServiceError(
      updateDriveSource(staffA, {
        sourceId: res.id,
        columns: { link: "Không có" },
      }),
      "tiêu đề",
      "columns.link"
    )
    await expectServiceError(
      updateDriveSource(staffA, { sourceId: res.id, recursiveDepth: 1 }),
      "không hợp lệ"
    )
  })

  it("folder grid: sub-folders must be descendants, usedIn limited to the viewer's ad accounts, thumbnails", async () => {
    await db.insert(driveMediaUploads).values([
      {
        adAccountId: ids.accA,
        driveFileId: ID.vid,
        contentKey: "ver:1",
        mediaType: "video",
        mediaId: "vidA",
      },
      {
        adAccountId: ids.accB,
        driveFileId: ID.vid,
        contentKey: "ver:1",
        mediaType: "video",
        mediaId: "vidB",
      },
    ])
    const root = await listDriveSourceFiles(staffA, {
      sourceId: ids.companySource,
    })
    expect(root.folder).toMatchObject({ id: ID.company, isRoot: true })
    expect(root.folders.map((f) => f.id)).toEqual([ID.companySub])
    expect(root.files.map((f) => f.id)).toEqual([ID.vid])
    expect(root.skipped).toBe(1)
    expect(root.files[0]!.usedIn.map((u) => u.mediaId)).toEqual(["vidA"])
    expect(
      (await listDriveSourceFiles(admin, { sourceId: ids.companySource }))
        .files[0]!.usedIn
    ).toHaveLength(2)

    const sub = await listDriveSourceFiles(staffA, {
      sourceId: ids.companySource,
      folderId: ID.companySub,
    })
    expect(sub.folder).toMatchObject({
      id: ID.companySub,
      name: "Tuần 41",
      isRoot: false,
    })
    expect(sub.files.map((f) => f.id)).toEqual([ID.img])
    await expectServiceError(
      listDriveSourceFiles(staffA, {
        sourceId: ids.companySource,
        folderId: ID.bFolder,
      }),
      "không nằm trong"
    )
    await expectServiceError(
      listDriveSourceFiles(staffA, { sourceId: ids.sheetSource }),
      "thư mục"
    )

    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, ID.img)
    ).toMatchObject({ contentType: "image/png" })
    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, ID.outsideImg)
    ).toBeNull()
    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, ID.pdf)
    ).toBeNull()
    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, "NOPEnope000001")
    ).toBeNull()
    await expectServiceError(
      getDriveSourceThumbnail(staffA, ids.bSource, ID.outsideImg),
      "Không tìm thấy"
    )
  })

  it("H1 defence in depth: another person's personal folder below a source is hidden from staff (not from its owner / admins)", async () => {
    // registered INSIDE the (older) company folder: allowed and still shared with everybody
    const inside = await createDriveSource(staffB, {
      kind: "folder",
      scope: "personal",
      link: folderLink(ID.companySub),
    })
    const subIds = async (actor: DriveActor) =>
      (
        await listDriveSourceFiles(actor, { sourceId: ids.companySource })
      ).folders.map((f) => f.id)
    expect(await subIds(staffA)).toEqual([ID.companySub])
    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, ID.img)
    ).not.toBeNull()

    // legacy: the company folder was registered ABOVE B's personal folder (before the H1 check) → blocked for others
    const [company] = await db
      .select({ createdAt: driveSources.createdAt })
      .from(driveSources)
      .where(eq(driveSources.id, ids.companySource))
    await db
      .update(driveSources)
      .set({ createdAt: new Date(company!.createdAt.getTime() - 86_400_000) })
      .where(eq(driveSources.id, inside.id))
    expect(await subIds(staffA)).toEqual([])
    await expectServiceError(
      listDriveSourceFiles(staffA, {
        sourceId: ids.companySource,
        folderId: ID.companySub,
      }),
      "không nằm trong"
    )
    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, ID.img)
    ).toBeNull()
    // files directly in the company folder are unaffected
    expect(
      await getDriveSourceThumbnail(staffA, ids.companySource, ID.vid)
    ).not.toBeNull()
    // the owner and admins still browse it
    expect(await subIds(staffB)).toEqual([ID.companySub])
    expect(await subIds(admin)).toEqual([ID.companySub])
    expect(
      (
        await listDriveSourceFiles(admin, {
          sourceId: ids.companySource,
          folderId: ID.companySub,
        })
      ).files.map((f) => f.id)
    ).toEqual([ID.img])
    expect(
      await getDriveSourceThumbnail(staffB, ids.companySource, ID.img)
    ).not.toBeNull()

    await deleteDriveSource(staffB, inside.id)
    expect(await subIds(staffA)).toEqual([ID.companySub])
  })

  it("recheck: active / error with the Vietnamese reason / unchanged when Google is unreachable", async () => {
    const isCheck = (l: { metadata: unknown }) =>
      (l.metadata as { kind?: string }).kind === "check"
    const before = (await logs("drive_source.update", ids.bSource)).filter(
      isCheck
    ).length
    expect(await recheckDriveSource(staffB, ids.bSource)).toEqual({
      ok: true,
      status: "active",
      statusMessage: null,
    })
    g.getFail = new DriveError("permission_denied")
    const bad = await recheckDriveSource(staffB, ids.bSource)
    expect(bad).toMatchObject({ ok: false, status: "error" })
    expect(bad.statusMessage).toContain("email hệ thống")
    g.getFail = new DriveError("rate_limited")
    expect(await recheckDriveSource(staffB, ids.bSource)).toMatchObject({
      ok: false,
      status: "error",
    })
    expect(await recheckDriveSource(staffB, ids.bSource)).toMatchObject({
      ok: true,
      status: "active",
    })
    const checks = (await logs("drive_source.update", ids.bSource)).filter(
      isCheck
    )
    expect(checks).toHaveLength(before + 4)
  })

  it("system credential cannot be deleted while sources use it", async () => {
    await expectServiceError(
      deleteSystemDriveCredential(admin),
      "đang được dùng"
    )
  })

  // -------------------------------------------------------------------------
  // MCP scope
  // -------------------------------------------------------------------------

  const settings = {
    twoStepConfirm: true,
    budgetChangeMaxPct: 50,
    maxDailyBudget: {},
    rateLimitPerMin: 60,
    allowedIps: [],
  }
  const platforms = (connectionId: string) => [
    {
      platform: "meta",
      connections: [{ connectionId, accountIds: null }],
      permissions: ["read"],
    },
  ]

  it("MCP scope: staff MCP = company + own personal sources; admin MCP may use any live source (G4)", async () => {
    // options
    const optsB = await listDriveSourcesForMcpScope(staffB, {
      id: staffB.id,
      role: "staff",
    })
    expect(optsB.map((o) => [o.id, o.group])).toEqual([
      [ids.companySource, "company"],
      [ids.bSource, "mine"],
    ])
    expect(
      await listDriveSourcesForMcpScope(staffB, {
        id: staffA.id,
        role: "staff",
      })
    ).toEqual([])
    const optsAdmin = await listDriveSourcesForMcpScope(admin, {
      id: admin.id,
      role: "admin",
    })
    expect(
      optsAdmin
        .filter((o) => o.group === "staff")
        .map((o) => o.id)
        .sort()
    ).toEqual([ids.aSource, ids.bSource, ids.sheetSource].sort())
    expect(optsAdmin.find((o) => o.id === ids.sheetSource)).toMatchObject({
      kind: "sheet",
      writeback: false,
    })

    // staff B cannot attach staff A's personal source
    const bad = createMcpServer(
      staffB,
      {
        name: `${P} B mcp`,
        platforms: platforms(ids.connB),
        settings,
        driveSourceIds: [ids.aSource],
      },
      okVerify
    )
    await expect(bad).rejects.toMatchObject({
      code: "invalid",
      fieldErrors: { driveSourceIds: expect.any(String) },
    })

    const mcpB = await createMcpServer(
      staffB,
      {
        name: `${P} B mcp`,
        platforms: platforms(ids.connB),
        settings: { ...settings, drivePublicLinks: false },
        driveSourceIds: [ids.companySource, ids.bSource, ids.bSource],
      },
      okVerify
    )
    const scopes = await db
      .select()
      .from(mcpDriveScopes)
      .where(eq(mcpDriveScopes.mcpId, mcpB.id))
    expect(scopes.map((s) => s.sourceId).sort()).toEqual(
      [ids.companySource, ids.bSource].sort()
    )
    const detail = (await getMcpServer({ ...staffB }, mcpB.id))!
    expect(detail.driveSources.map((s) => s.id).sort()).toEqual(
      [ids.companySource, ids.bSource].sort()
    )
    expect(detail.settings).toMatchObject({
      drivePublicLinks: false,
      driveSheetWriteback: true,
    })
    const [created] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.action, "mcp.create"),
          eq(activityLogs.targetId, mcpB.id)
        )
      )
    expect(
      (created!.metadata as { after: { driveSources: string[] } }).after
        .driveSources
    ).toHaveLength(2)

    // options for an existing MCP: its owner's view; another staff member cannot ask
    expect(
      (await listDriveSourceOptionsForMcp(admin, mcpB.id)).map((o) => o.group)
    ).not.toContain("staff")
    await expectServiceError(
      listDriveSourceOptionsForMcp(staffA, mcpB.id),
      "Không tìm thấy"
    )

    // update: omitted = keep; settings diff logged; [] = remove all; a new unusable id refused
    const base = {
      id: mcpB.id,
      name: `${P} B mcp`,
      platforms: platforms(ids.connB),
      settings,
    }
    expect(
      await updateMcpServer(staffB, {
        ...base,
        settings: { ...settings, drivePublicLinks: false },
      })
    ).toEqual({ changed: false })
    await updateMcpServer(staffB, base)
    const [upd] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.action, "mcp.update"),
          eq(activityLogs.targetId, mcpB.id)
        )
      )
    expect(upd!.metadata).toMatchObject({
      before: {
        settings: expect.objectContaining({ drivePublicLinks: false }),
      },
      after: { settings: expect.objectContaining({ drivePublicLinks: true }) },
    })
    expect(upd!.metadata).not.toHaveProperty("after.driveSources")
    await expect(
      updateMcpServer(staffB, { ...base, driveSourceIds: [ids.aSource] })
    ).rejects.toMatchObject({ code: "invalid" })
    await updateMcpServer(staffB, { ...base, driveSourceIds: [] })
    expect(
      await db
        .select()
        .from(mcpDriveScopes)
        .where(eq(mcpDriveScopes.mcpId, mcpB.id))
    ).toEqual([])

    // admin MCP: a staff member's personal source is allowed
    const mcpAdmin = await createMcpServer(
      admin,
      {
        name: `${P} admin mcp`,
        platforms: platforms(ids.connA),
        settings,
        driveSourceIds: [ids.aSource, ids.companySource],
      },
      okVerify
    )
    expect(
      (await getMcpServer(admin, mcpAdmin.id))!.driveSources
        .map((s) => s.id)
        .sort()
    ).toEqual([ids.aSource, ids.companySource].sort())
    expect((await getDriveSource(staffA, ids.aSource)).usedBy).toEqual([
      { id: null, name: null, ownedByViewer: false },
    ])

    // deleting a source removes it from every MCP scope (same transaction) + activity
    const del = await deleteDriveSource(staffA, ids.aSource)
    expect(del.affectedMcpCount).toBe(1)
    expect(del.affectedMcpIds).toEqual([]) // staff never learn ids of other people's MCPs
    expect(
      await db
        .select()
        .from(mcpDriveScopes)
        .where(eq(mcpDriveScopes.sourceId, ids.aSource))
    ).toEqual([])
    const [gone] = await db
      .select()
      .from(driveSources)
      .where(eq(driveSources.id, ids.aSource))
    expect(gone!.deletedAt).not.toBeNull()
    expect(gone!.resourceKeyEncrypted).toBeNull()
    expect(await logs("drive_source.delete", ids.aSource)).toHaveLength(1)
    expect(
      (await getMcpServer(admin, mcpAdmin.id))!.driveSources.map((s) => s.id)
    ).toEqual([ids.companySource])
    // the folder is free again (soft-deleted sources do not claim)
    expect(
      (
        await previewDriveSource(staffB, {
          kind: "folder",
          scope: "personal",
          link: folderLink(ID.aSub),
        })
      ).googleId
    ).toBe(ID.aSub)
  })

  it("T-2: ancestors are walked with the source's credential AND the system one; a source moved inside another person's personal folder is flagged and hidden from staff", async () => {
    const cred = await createPersonalDriveCredential(staffA, {
      name: "A key 2",
      serviceAccountJson: saJson({
        client_email: `a-two@${P.replace(/_/g, "-")}.iam.gserviceaccount.com`,
      }),
    })
    const hidden = new Set<string>([ID.bFolder, ID.root])
    g.hidden.set(driveCredentialCacheKey(cred.id), hidden)
    const inB = "NEWinsideB00001"
    const elsewhere = "NEWelsewhere001"
    g.files.set(inB, file(inB, { name: "Trong B", parents: [ID.bFolder] }))
    g.files.set(
      elsewhere,
      file(elsewhere, { name: "Ở ngoài", parents: [ID.root] })
    )
    let sourceId: string | null = null
    try {
      // A's own service account cannot see B's folder above it: only the system credential's walk reveals it
      await expectServiceError(
        previewDriveSource(staffA, {
          kind: "folder",
          scope: "personal",
          link: folderLink(inB),
          credentialId: cred.id,
        }),
        REFUSED,
        "link"
      )
      const res = await createDriveSource(staffA, {
        kind: "folder",
        scope: "personal",
        link: folderLink(elsewhere),
        credentialId: cred.id,
      })
      sourceId = res.id
      const stored = async () =>
        (
          await db
            .select({ ancestorIds: driveSources.ancestorIds })
            .from(driveSources)
            .where(eq(driveSources.id, res.id))
        )[0]!.ancestorIds
      // the root is hidden from A's key, seen by the system one
      expect(await stored()).toEqual([ID.root])
      expect(
        (await listDriveSourceFiles(staffA, { sourceId: res.id })).folder.id
      ).toBe(elsewhere)

      // moved inside B's personal folder: recheck flags it (error + Vietnamese reason), ancestors refreshed
      g.files.set(
        elsewhere,
        file(elsewhere, { name: "Ở ngoài", parents: [ID.bFolder] })
      )
      expect(await recheckDriveSource(staffA, res.id)).toEqual({
        ok: false,
        status: "error",
        statusMessage: driveJobs.sources.insideOtherPersonal,
      })
      expect(await stored()).toEqual([ID.bFolder, ID.root])
      // T-2 defence in depth: staff never browse it any more (B's folder is blocked for them); admins still do
      await expectServiceError(
        listDriveSourceFiles(staffA, { sourceId: res.id }),
        driveUi.service.notFound
      )
      expect(await getDriveSourceThumbnail(staffA, res.id, ID.img)).toBeNull()
      expect(
        (await listDriveSourceFiles(admin, { sourceId: res.id })).folder.id
      ).toBe(elsewhere)
    } finally {
      g.hidden.delete(driveCredentialCacheKey(cred.id))
      g.files.delete(inB)
      g.files.delete(elsewhere)
      if (sourceId) await deleteDriveSource(staffA, sourceId)
      await db
        .update(driveCredentials)
        .set({ deletedAt: new Date() })
        .where(eq(driveCredentials.id, cred.id))
    }
  })
})
