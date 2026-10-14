// CLI commands against a private throw-away database: create-admin / reset-password / reset-2fa / unlock /
// reencrypt, argument handling, exit codes, password length 8, argv-secret warnings, hash compatibility with
// Better Auth sign-in, activity_logs rows (actor role "cli") and "no secrets in output/logs".
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("../src/server/__tests__/people/temp-db")
  const t = await createTempDb("cli")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())

import { and, eq, sql } from "drizzle-orm"

import { __setKeyRing, aad, decryptSecret, encryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { account, activityLogs, connections, session as sessionTable, twoFactor, user, verification } from "@/server/db/schema"
import { lockoutIpKey, lockoutKey, recordLoginFailure } from "@/server/auth/lockout"
import { createTestUser, enableTotp, PASSWORD, randomIp, signIn, uid } from "@/server/__tests__/people/harness"

import { main } from "./cli"

const hasDb = !!tmp
const P = `tcli_${uid()}`
const email = (n: string) => `${P}_${n}@example.test`

interface Run {
  code: number
  out: string
  err: string
}

/** Runs a CLI command in-process, capturing stdout/stderr; `main` ends the pool, so recreate it afterwards. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  const out: string[] = []
  const err: string[] = []
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true))
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true))
  try {
    const code = await main(args)
    return { code, out: out.join(""), err: err.join("") }
  } finally {
    so.mockRestore()
    se.mockRestore()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await resetPool()
  }
}

/** `main` ends the shared pool; also end whatever the test helpers created since, then start fresh. */
async function resetPool(): Promise<void> {
  const g = globalThis as { __adsMcpPool?: { ended?: boolean; end: () => Promise<void> }; __adsMcpDb?: unknown; __adsMcpAuth?: unknown }
  const p = g.__adsMcpPool
  g.__adsMcpPool = undefined
  g.__adsMcpDb = undefined
  g.__adsMcpAuth = undefined // the Better Auth instance holds a Drizzle handle bound to the old pool
  if (p && !p.ended) await p.end().catch(() => {})
}

const tempPasswordOf = (out: string) => /Mật khẩu tạm: (\S+)/.exec(out)?.[1]
const userByEmail = async (e: string) => (await db.select().from(user).where(eq(user.email, e)))[0]
const logsOf = async (action: string) => db.select().from(activityLogs).where(eq(activityLogs.action, action))

describe.skipIf(!hasDb)("CLI (DB)", () => {
  beforeAll(() => {
    __setKeyRing(undefined)
  })
  afterAll(async () => {
    await resetPool()
    await tmp?.drop()
  })
  beforeEach(async () => {
    await resetPool()
  })

  describe("create-admin", () => {
    it("tạo admin đầu tiên với mật khẩu tạm ngẫu nhiên (≥ 8 ký tự), buộc đổi mật khẩu, đăng nhập được, ghi nhật ký cli", async () => {
      const r = await cli(["create-admin", "--email", email("first").toUpperCase(), "--name", "Chủ hệ thống"])
      expect(r.code).toBe(0)
      expect(r.out).toContain("người dùng đầu tiên")
      const pw = tempPasswordOf(r.out)!
      expect(pw.length).toBeGreaterThanOrEqual(8)
      const u = (await userByEmail(email("first")))!
      expect(u).toMatchObject({ role: "admin", mustChangePassword: true, banned: false, name: "Chủ hệ thống" })
      expect(u.twoFactorEnabled).toBeFalsy() // optional by default
      // the hash is compatible with Better Auth's sign-in
      const s = await signIn({ id: u.id, email: u.email, password: pw, role: "admin", name: u.name })
      expect(s.sessionId).toBeTruthy()
      const logs = await db.select().from(activityLogs).where(and(eq(activityLogs.targetId, u.id), eq(activityLogs.action, "setup.first_admin")))
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({ actorRole: "cli", actorId: null, status: "success" })
      expect(JSON.stringify(logs[0]!.metadata)).not.toContain(pw)
    })

    it("mật khẩu từ biến môi trường ADMIN_PASSWORD: 7 ký tự bị từ chối (exit 1, không tạo), 8 ký tự được nhận", async () => {
      const short = await cli(["create-admin", "--email", email("short")], { ADMIN_PASSWORD: "Abcde12" })
      expect(short.code).toBe(1)
      expect(short.err).toContain("ít nhất 8 ký tự")
      expect(await userByEmail(email("short"))).toBeUndefined()
      const ok = await cli(["create-admin", "--email", email("eight")], { ADMIN_PASSWORD: "Abcdef78" })
      expect(ok.code).toBe(0)
      expect(ok.out).not.toContain("Abcdef78") // given secrets are never echoed
      expect(tempPasswordOf(ok.out)).toBeUndefined()
      const u = (await userByEmail(email("eight")))!
      await expect(signIn({ id: u.id, email: u.email, password: "Abcdef78", role: "admin", name: u.name })).resolves.toBeTruthy()
      const tooLong = await cli(["create-admin", "--email", email("long")], { ADMIN_PASSWORD: "a".repeat(129) })
      expect(tooLong.code).toBe(1)
    })

    it("--password trên dòng lệnh vẫn chạy nhưng cảnh báo lộ qua ps/lịch sử shell", async () => {
      const r = await cli(["create-admin", "--email", email("argv"), "--password", "Abcdef78"])
      expect(r.code).toBe(0)
      expect(r.err).toMatch(/--password.*ADMIN_PASSWORD/)
      expect(r.out).not.toContain("Abcdef78")
    })

    it("email trùng / không hợp lệ / thiếu / tham số lạ: exit 1 với thông báo tiếng Việt, không in stack", async () => {
      expect((await cli(["create-admin", "--email", email("first")])).err).toMatch(/đã có tài khoản/)
      const bad = await cli(["create-admin", "--email", "khong-phai-email"])
      expect(bad).toMatchObject({ code: 1 })
      expect(bad.err).toMatch(/Email không hợp lệ/)
      expect((await cli(["create-admin"])).code).toBe(1)
      const unknown = await cli(["create-admin", "--email", email("x"), "--role", "admin"])
      expect(unknown.code).toBe(1)
      expect(unknown.err).not.toMatch(/\n\s+at /)
      expect(await userByEmail(email("x"))).toBeUndefined()
    })

    it("lệnh lạ in trợ giúp và thoát 1; không có lệnh / help thoát 0", async () => {
      expect(await cli(["nonsense"])).toMatchObject({ code: 1 })
      expect((await cli(["nonsense"])).out).toContain("Cách dùng")
      expect((await cli([])).code).toBe(0)
      expect((await cli(["help"])).code).toBe(0)
      expect((await cli(["--help"])).out).toContain("create-admin")
    })

    it("lỗi cơ sở dữ liệu bất ngờ không in tham số truy vấn (hash mật khẩu, id, email) ra stderr", async () => {
      // Drizzle's "Failed query: … params: <values>" would carry the password hash — force such a failure:
      await db.execute(sql`alter table account add constraint pa_cli_boom check (false) not valid`)
      try {
        const r = await cli(["create-admin", "--email", email("dberr")], { ADMIN_PASSWORD: "Abcdef78" })
        expect(r.code).toBe(1)
        expect(r.err).toMatch(/^✖ /)
        expect(r.err).not.toMatch(/params:/i)
        expect(r.err).not.toMatch(/[0-9a-f]{32,}/i) // scrypt hash / ids
        expect(r.err).not.toContain("Abcdef78")
        expect(r.err).not.toContain(email("dberr"))
      } finally {
        await db.execute(sql`alter table account drop constraint pa_cli_boom`)
      }
      expect(await userByEmail(email("dberr"))).toBeUndefined() // the whole transaction rolled back
    })
  })

  describe("reset-password / reset-2fa / unlock", () => {
    it("reset-password: mật khẩu cũ chết, phiên bị xoá, buộc đổi mật khẩu, mật khẩu tạm đăng nhập được, nhật ký cli không chứa mật khẩu", async () => {
      const u = await createTestUser(P, "rp", { role: "staff" })
      await signIn(u)
      const trustId = `trust-device-${P}-rp`
      await db.insert(verification).values({ id: trustId, identifier: trustId, value: u.id, expiresAt: new Date(Date.now() + 86_400_000) })
      const r = await cli(["reset-password", u.email.toUpperCase()])
      expect(r.code).toBe(0)
      expect(await db.select().from(verification).where(eq(verification.id, trustId))).toHaveLength(0)
      const pw = tempPasswordOf(r.out)!
      expect(pw.length).toBeGreaterThanOrEqual(8)
      expect(await db.select().from(sessionTable).where(eq(sessionTable.userId, u.id))).toHaveLength(0)
      expect((await userByEmail(u.email))!.mustChangePassword).toBe(true)
      await expect(signIn(u)).rejects.toThrow()
      await expect(signIn({ ...u, password: pw })).resolves.toBeTruthy()
      const log = (await logsOf("user.password.reset")).find((l) => l.targetId === u.id)!
      expect(log).toMatchObject({ actorRole: "cli", status: "success" })
      expect(log.metadata).toMatchObject({ via: "cli", forcedChangeOnLogin: true })
      expect(JSON.stringify(log.metadata)).not.toContain(pw)
    })

    it("reset-password cho email không tồn tại / không hợp lệ: exit 1", async () => {
      expect((await cli(["reset-password", email("nobody")])).code).toBe(1)
      expect((await cli(["reset-password", "--email", email("nobody")])).code).toBe(1)
      expect((await cli(["reset-password"])).code).toBe(1)
      // alias
      expect((await cli(["user:reset-password", email("nobody")])).code).toBe(1)
    })

    it("reset-2fa: xoá bí mật + mã dự phòng + thiết bị tin cậy, đăng xuất mọi thiết bị, đăng nhập lại chỉ cần mật khẩu", async () => {
      const u = await createTestUser(P, "r2", { role: "admin" })
      await enableTotp(await signIn(u))
      expect((await userByEmail(u.email))!.twoFactorEnabled).toBe(true)
      const r = await cli(["reset-2fa", u.email])
      expect(r.code).toBe(0)
      expect((await userByEmail(u.email))!.twoFactorEnabled).toBe(false)
      expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, u.id))).toHaveLength(0)
      expect(await db.select().from(sessionTable).where(eq(sessionTable.userId, u.id))).toHaveLength(0)
      await expect(signIn(u)).resolves.toBeTruthy()
      const log = (await logsOf("user.2fa.reset")).find((l) => l.targetId === u.id)!
      expect(log).toMatchObject({ actorRole: "cli" })
      expect(log.metadata).toMatchObject({ via: "cli", before: { twoFactorEnabled: true }, after: { twoFactorEnabled: false } })
      expect((await cli(["reset-2fa", email("nobody")])).code).toBe(1)
    })

    it("unlock: xoá bộ đếm khoá đăng nhập (email + từng IP) và khoá 2FA; email lạ vẫn exit 0", async () => {
      const u = await createTestUser(P, "un", { role: "staff" })
      for (let i = 0; i < 3; i++) await recordLoginFailure(u.email, randomIp())
      expect((await db.select().from(verification).where(eq(verification.id, lockoutKey(u.email)))).length).toBe(1)
      const r = await cli(["unlock", u.email])
      expect(r.code).toBe(0)
      expect(r.out).toContain("Đã gỡ khoá")
      const left = (await db.select().from(verification)).filter((v) => v.id.startsWith(lockoutKey(u.email)))
      expect(left).toHaveLength(0)
      expect(lockoutIpKey(u.email, "1.2.3.4")).toContain(lockoutKey(u.email))
      expect((await cli(["unlock", email("ghost")])).code).toBe(0)
      expect((await logsOf("user.update")).some((l) => l.targetId === u.id && (l.metadata as { op?: string }).op === "unlock")).toBe(true)
    })

    it("unban: mở khoá tài khoản bị quản trị viên khoá, đăng nhập lại bằng mật khẩu hiện tại, nhật ký user.unban (cli)", async () => {
      const u = await createTestUser(P, "ban", { role: "staff", banned: true })
      await db.update(user).set({ banReason: "test", banExpires: new Date(Date.now() + 86_400_000) }).where(eq(user.id, u.id))
      await expect(signIn(u)).rejects.toThrow()
      const r = await cli(["unban", u.email.toUpperCase()])
      expect(r.code).toBe(0)
      expect(r.out).toContain("Đã mở khoá")
      expect(await userByEmail(u.email)).toMatchObject({ banned: false, banReason: null, banExpires: null })
      await expect(signIn(u)).resolves.toBeTruthy()
      const logs = (await logsOf("user.unban")).filter((l) => l.targetId === u.id)
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({ actorRole: "cli", actorId: null, status: "success" })
      expect(logs[0]!.metadata).toMatchObject({ via: "cli", before: { banned: true }, after: { banned: false } })

      // not banned → exit 0, nothing logged
      const again = await cli(["unban", u.email])
      expect(again.code).toBe(0)
      expect(again.out).toContain("không bị khoá")
      expect((await logsOf("user.unban")).filter((l) => l.targetId === u.id)).toHaveLength(1)

      // alias + unknown / invalid email
      await db.update(user).set({ banned: true }).where(eq(user.id, u.id))
      expect((await cli(["user:unban", u.email])).code).toBe(0)
      expect((await userByEmail(u.email))!.banned).toBe(false)
      expect((await cli(["unban", email("nobody")])).code).toBe(1)
      expect((await cli(["unban"])).code).toBe(1)
      expect((await cli(["--help"])).out).toContain("unban <email>")
    })
  })

  describe("reencrypt", () => {
    it("--dry-run chỉ đếm; chạy thật mã hoá lại bằng khoá đang hoạt động và vẫn giải mã được", async () => {
      const owner = await createTestUser(P, "enc", { role: "staff" })
      const k1 = Buffer.alloc(32, 1).toString("base64")
      const k2 = Buffer.alloc(32, 2).toString("base64")
      __setKeyRing(`1:${k1}`)
      const id = crypto.randomUUID()
      await db.insert(connections).values({
        id,
        ownerId: owner.id,
        platform: "meta",
        name: `${P} enc`,
        credentialsEncrypted: encryptSecret('{"accessToken":"x"}', aad.connectionCredentials(id)),
      })
      __setKeyRing(`2:${k2},1:${k1}`)
      const dry = await cli(["reencrypt", "--dry-run"])
      expect(dry.code).toBe(0)
      expect(dry.out).toMatch(/1 kết nối/)
      const [before] = await db.select().from(connections).where(eq(connections.id, id))
      expect(before!.credentialsEncrypted.startsWith("v1.")).toBe(true)
      const real = await cli(["reencrypt"])
      expect(real.code).toBe(0)
      const [after] = await db.select().from(connections).where(eq(connections.id, id))
      expect(after!.credentialsEncrypted.startsWith("v2.")).toBe(true)
      expect((await db.select().from(activityLogs).where(and(eq(activityLogs.action, "connection.update"), eq(activityLogs.actorRole, "cli")))).length).toBe(1)
      expect((await cli(["reencrypt", "--bogus"])).code).toBe(1)
      __setKeyRing(undefined)
    })

    it("bản ghi không giải mã được (khoá cũ đã bỏ) được báo theo id, bản ghi khác vẫn mã hoá lại; exit 1, không in bản mã", async () => {
      const owner = await createTestUser(P, "enc2", { role: "staff" })
      const k1 = Buffer.alloc(32, 1).toString("base64")
      const k2 = Buffer.alloc(32, 2).toString("base64")
      await db.delete(connections) // only this test's rows below
      __setKeyRing(`1:${k1}`)
      const good = crypto.randomUUID()
      const broken = crypto.randomUUID()
      const goodEnc = encryptSecret('{"accessToken":"good"}', aad.connectionCredentials(good))
      // encrypted under a key version that is not in the ring any more
      const brokenEnc = `v9.${goodEnc.split(".").slice(1).join(".")}`
      await db.insert(connections).values([
        { id: good, ownerId: owner.id, platform: "meta", name: `${P} good`, credentialsEncrypted: goodEnc },
        { id: broken, ownerId: owner.id, platform: "meta", name: `${P} broken`, credentialsEncrypted: brokenEnc },
      ])
      __setKeyRing(`2:${k2},1:${k1}`)
      try {
        const dry = await cli(["reencrypt", "--dry-run"])
        expect(dry.code).toBe(1)
        expect(dry.err).toContain(broken)

        const before = (await db.select().from(activityLogs).where(eq(activityLogs.action, "connection.update"))).length
        const r = await cli(["reencrypt"])
        expect(r.code).toBe(1)
        expect(r.err).toContain(broken)
        expect(r.err).not.toContain(brokenEnc.split(".")[3]!)
        expect(r.err).toMatch(/1 bản ghi không mã hoá lại được/)
        const rows = await db.select().from(connections)
        expect(rows.find((c) => c.id === good)!.credentialsEncrypted.startsWith("v2.")).toBe(true)
        expect(rows.find((c) => c.id === broken)!.credentialsEncrypted).toBe(brokenEnc)
        const logs = await db
          .select()
          .from(activityLogs)
          .where(and(eq(activityLogs.action, "connection.update"), eq(activityLogs.actorRole, "cli")))
        expect(logs.length).toBe(before + 1)
        expect(logs.some((l) => (l.metadata as { failed?: number; count?: number }).failed === 1 && (l.metadata as { count?: number }).count === 1)).toBe(true)
      } finally {
        __setKeyRing(undefined)
      }
    })
    it("mã hoá lại bí mật Google Drive (service account, API key, resource key nguồn + link tạm + lượt tải video) và ghi nhật ký", async () => {
      const schema = await import("@/server/db/schema")
      const { encryptServiceAccount } = await import("@/server/drive/store")
      const owner = await createTestUser(P, "drive", { role: "staff" })
      await db.delete(connections) // the previous test leaves an undecryptable row on purpose
      const k1 = Buffer.alloc(32, 1).toString("base64")
      const k2 = Buffer.alloc(32, 2).toString("base64")
      __setKeyRing(`1:${k1}`)
      try {
        const sa = {
          clientEmail: "sa@p.iam.gserviceaccount.com",
          privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
          privateKeyId: null,
          projectId: null,
        }
        const credId = crypto.randomUUID()
        await db.insert(schema.driveCredentials).values({
          id: credId,
          kind: "system",
          ownerId: null,
          credentialsEncrypted: encryptServiceAccount(credId, sa),
          apiKeyEncrypted: encryptSecret("AIza-test-key", aad.driveCredentialApiKey(credId)),
          clientEmail: sa.clientEmail,
        })
        const srcId = crypto.randomUUID()
        await db.insert(schema.driveSources).values({
          id: srcId,
          kind: "folder",
          scope: "company",
          ownerId: owner.id,
          credentialId: credId,
          googleId: `${P}-folder`,
          resourceKeyEncrypted: encryptSecret("0-src", aad.driveSourceResourceKey(srcId)),
          name: "f",
        })
        const mcpId = crypto.randomUUID()
        await db.insert(schema.mcpServers).values({ id: mcpId, ownerId: owner.id, name: `${P} mcp`, keyHash: `h-${mcpId}`, keyPrefix: "amcp_x", keyEncrypted: encryptSecret("amcp_k", aad.mcpKey(mcpId)) })
        const connId = crypto.randomUUID()
        await db.insert(connections).values({ id: connId, ownerId: owner.id, platform: "meta", name: `${P} drive conn`, credentialsEncrypted: encryptSecret("{}", aad.connectionCredentials(connId)) })
        const [acc] = await db
          .insert(schema.adAccounts)
          .values({ connectionId: connId, platform: "meta", externalId: `act_${P}`, name: "a", currency: "VND", timezone: "Asia/Ho_Chi_Minh" })
          .returning({ id: schema.adAccounts.id })
        const relayId = crypto.randomUUID()
        await db.insert(schema.driveRelayLinks).values({
          id: relayId,
          tokenHash: `${P}-hash`,
          mcpId,
          adAccountId: acc!.id,
          driveFileId: "f1",
          contentKey: "md5:a:1",
          access: "api_key",
          resourceKeyEncrypted: encryptSecret("0-relay", aad.driveRelayResourceKey(relayId)),
          fileName: "v.mp4",
          contentType: "video/mp4",
          sizeBytes: 1,
          maxFetches: 30,
          expiresAt: new Date(Date.now() + 3600_000),
        })
        const jobId = crypto.randomUUID()
        await db.insert(schema.mediaUploadJobs).values({
          id: jobId,
          mcpId,
          adAccountId: acc!.id,
          platform: "meta",
          driveFileId: "f2",
          contentKey: "md5:b:1",
          access: "api_key",
          resourceKeyEncrypted: encryptSecret("0-job", aad.mediaUploadJobResourceKey(jobId)),
          fileName: "big.mp4",
          contentType: "video/mp4",
          sizeBytes: 1,
        })
        __setKeyRing(`2:${k2},1:${k1}`)
        const dry = await cli(["reencrypt", "--dry-run"])
        expect(dry.code).toBe(0)
        expect(dry.out).toMatch(/5 bí mật Google Drive/)
        const real = await cli(["reencrypt"])
        expect(real.code).toBe(0)
        expect(real.out).not.toContain("AIza-test-key")
        const [cred] = await db.select().from(schema.driveCredentials).where(eq(schema.driveCredentials.id, credId))
        const [src] = await db.select().from(schema.driveSources).where(eq(schema.driveSources.id, srcId))
        const [relay] = await db.select().from(schema.driveRelayLinks).where(eq(schema.driveRelayLinks.id, relayId))
        expect(cred!.credentialsEncrypted.startsWith("v2.")).toBe(true)
        expect(cred!.apiKeyEncrypted!.startsWith("v2.")).toBe(true)
        expect(src!.resourceKeyEncrypted!.startsWith("v2.")).toBe(true)
        expect(relay!.resourceKeyEncrypted!.startsWith("v2.")).toBe(true)
        const [job] = await db.select().from(schema.mediaUploadJobs).where(eq(schema.mediaUploadJobs.id, jobId))
        expect(job!.resourceKeyEncrypted!.startsWith("v2.")).toBe(true)
        expect(decryptSecret(job!.resourceKeyEncrypted!, aad.mediaUploadJobResourceKey(jobId))).toBe("0-job")
        expect(decryptSecret(cred!.apiKeyEncrypted!, aad.driveCredentialApiKey(credId))).toBe("AIza-test-key")
        expect(decryptSecret(src!.resourceKeyEncrypted!, aad.driveSourceResourceKey(srcId))).toBe("0-src")
        expect(decryptSecret(relay!.resourceKeyEncrypted!, aad.driveRelayResourceKey(relayId))).toBe("0-relay")
        expect(JSON.parse(decryptSecret(cred!.credentialsEncrypted, aad.driveCredential(credId))).clientEmail).toBe(sa.clientEmail)
        for (const action of ["drive_credential.update", "drive_source.update"] as const) {
          const logs = await db
            .select()
            .from(activityLogs)
            .where(and(eq(activityLogs.action, action), eq(activityLogs.actorRole, "cli")))
          expect(logs.length, action).toBe(1)
        }
      } finally {
        __setKeyRing(undefined)
      }
    })
  })

  describe("reencrypt (Apify)", () => {
    it("mã hoá lại token Apify (cả dòng đã xoá mềm), vẫn giải mã được, ghi apify_token.update và không in token", async () => {
      const schema = await import("@/server/db/schema")
      const { encryptApifyToken } = await import("@/server/apify/store")
      const owner = await createTestUser(P, "apify", { role: "staff" })
      await db.delete(connections) // an earlier test leaves an undecryptable row on purpose
      const k1 = Buffer.alloc(32, 1).toString("base64")
      const k2 = Buffer.alloc(32, 2).toString("base64")
      __setKeyRing(`1:${k1}`)
      try {
        const secret = "apify_api_" + "Zx9".repeat(12)
        const live = crypto.randomUUID()
        const dead = crypto.randomUUID()
        await db.insert(schema.apifyTokens).values([
          { id: live, scope: "personal", ownerId: owner.id, name: `${P} apify`, credentialsEncrypted: encryptApifyToken(live, secret) },
          { id: dead, scope: "personal", ownerId: owner.id, name: `${P} apify dead`, credentialsEncrypted: encryptApifyToken(dead, ""), deletedAt: new Date() },
        ])
        __setKeyRing(`2:${k2},1:${k1}`)
        const dry = await cli(["reencrypt", "--dry-run"])
        expect(dry.code).toBe(0)
        expect(dry.out).toMatch(/2 token Apify/)
        const real = await cli(["reencrypt"])
        expect(real.code).toBe(0)
        expect(real.out + real.err).not.toContain(secret)
        const rows = await db.select().from(schema.apifyTokens)
        const l = rows.find((r) => r.id === live)!
        const d = rows.find((r) => r.id === dead)!
        expect(l.credentialsEncrypted.startsWith("v2.")).toBe(true)
        expect(d.credentialsEncrypted.startsWith("v2.")).toBe(true)
        expect(decryptSecret(l.credentialsEncrypted, aad.apifyTokenCredentials(live))).toBe(secret)
        const logs = await db
          .select()
          .from(activityLogs)
          .where(and(eq(activityLogs.action, "apify_token.update"), eq(activityLogs.actorRole, "cli")))
        expect(logs.length).toBe(1)
        expect(JSON.stringify(logs[0]!.metadata)).not.toContain(secret)
      } finally {
        __setKeyRing(undefined)
      }
    })
  })

  describe("google:refresh-token", () => {
    it("thiếu --client-id / client secret / cổng hoặc host không hợp lệ: exit 1 trước khi mở cổng nào", async () => {
      expect((await cli(["google:refresh-token"])).code).toBe(1)
      expect((await cli(["google:refresh-token", "--client-id", "abc"])).err).toMatch(/client secret/)
      const badPort = await cli(["google:refresh-token", "--client-id", "abc", "--port", "80"], { GOOGLE_ADS_CLIENT_SECRET: "s" })
      expect(badPort.code).toBe(1)
      expect(badPort.err).toMatch(/--port/)
      const badHost = await cli(["google:refresh-token", "--client-id", "abc", "--host", "example.com"], { GOOGLE_ADS_CLIENT_SECRET: "s" })
      expect(badHost.code).toBe(1)
      expect(badHost.err).toMatch(/--host/)
      expect((await cli(["--help"])).out).toContain("google:refresh-token --client-id")
    })
  })
})

void PASSWORD
void account
