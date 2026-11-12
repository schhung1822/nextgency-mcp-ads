// Integration tests for the Apify tokens service against the test Postgres (skipped without DATABASE_URL).
// Apify is the in-memory fake (src/server/apify/__fixtures__/apify-fetch.ts) stubbed as the global fetch.
import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

const hooks = vi.hoisted(() => ({ failLog: false }))

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
      if (hooks.failLog) throw new Error("simulated activity log failure")
      return mod.logActivity({ ...entry, ip: null, userAgent: null }, tx)
    },
  }
})

import {
  createFakeApify,
  fakeToken,
  type FakeApify,
} from "@/server/apify/__fixtures__/apify-fetch"
import { decryptApifyToken } from "@/server/apify/store"
import { aad, decryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  activityLogs,
  apifyRuns,
  apifyTokens,
  mcpServers,
  user,
} from "@/server/db/schema"

import {
  ApifyServiceError,
  createApifyToken,
  deleteApifyToken,
  getApifyTokenDetail,
  getMcpApifyPoolSummary,
  listApifyTokens,
  loadGrantApifyTokens,
  previewApifyToken,
  recheckApifyToken,
  renameApifyToken,
  replaceApifyTokenSecret,
  setApifyTokenEnabled,
  type ApifyActor,
} from "./apify-tokens"

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-apify-svc-${randomUUID().slice(0, 8)}`
/** Apify account ids are alphanumeric */
const ACC = PREFIX.replace(/[^A-Za-z0-9]/g, "")
const staffA: ApifyActor = {
  id: `${PREFIX}-a`,
  email: `${PREFIX}-a@test.local`,
  role: "staff",
}
const staffB: ApifyActor = {
  id: `${PREFIX}-b`,
  email: `${PREFIX}-b@test.local`,
  role: "staff",
}
const admin: ApifyActor = {
  id: `${PREFIX}-admin`,
  email: `${PREFIX}-admin@test.local`,
  role: "admin",
}
const actors = [staffA, staffB, admin]

const T_A = fakeToken(`${PREFIX.slice(-8)}A`)
const T_A2 = fakeToken(`${PREFIX.slice(-8)}A2`)
const T_B = fakeToken(`${PREFIX.slice(-8)}B`)
const T_CO = fakeToken(`${PREFIX.slice(-8)}CO`)
const T_EX = fakeToken(`${PREFIX.slice(-8)}EX`)
const SECRETS = [T_A, T_A2, T_B, T_CO, T_EX]

let fake: FakeApify

function setupAccounts() {
  fake.accounts.set(T_A, {
    userId: `${ACC}accA`,
    username: "nhanvien-a",
    planId: "FREE",
    tier: "FREE",
    usageUsd: 1,
    limitUsd: 5,
    cycleEndAt: "2099-11-01T00:00:00.000Z",
  })
  // same Apify account as T_A (shares the credit)
  fake.accounts.set(T_A2, {
    userId: `${ACC}accA`,
    username: "nhanvien-a",
    planId: "FREE",
    tier: "FREE",
    usageUsd: 1,
    limitUsd: 5,
    cycleEndAt: "2099-11-01T00:00:00.000Z",
  })
  fake.accounts.set(T_B, {
    userId: `${ACC}accB`,
    username: "nhanvien-b",
    usageUsd: 0,
    limitUsd: 5,
    cycleEndAt: "2099-11-01T00:00:00.000Z",
  })
  fake.accounts.set(T_CO, {
    userId: `${ACC}accCo`,
    username: "congty",
    planId: "STARTER",
    tier: "BRONZE",
    usageUsd: 2,
    limitUsd: 19,
    cycleEndAt: "2099-11-01T00:00:00.000Z",
  })
  fake.accounts.set(T_EX, {
    userId: `${ACC}accEx`,
    username: "hetcredit",
    usageUsd: 5,
    limitUsd: 5,
    cycleEndAt: "2099-11-03T00:00:00.000Z",
  })
}

const logsOf = (id: string, action: string) =>
  db
    .select()
    .from(activityLogs)
    .where(and(eq(activityLogs.targetId, id), eq(activityLogs.action, action)))

async function newMcp(owner: ApifyActor, name: string, apifyEnabled: boolean) {
  const id = randomUUID()
  await db.insert(mcpServers).values({
    id,
    ownerId: owner.id,
    name: `${PREFIX} ${name}`,
    keyHash: `h-${id}`,
    keyPrefix: "amcp_x",
    keyEncrypted: "v1.x.y.z",
    settings: apifyEnabled ? { apify_enabled: true } : {},
  })
  return id
}

function expectNoSecrets(o: unknown) {
  const s = JSON.stringify(o)
  for (const t of SECRETS) expect(s).not.toContain(t)
  expect(s).not.toContain("credentialsEncrypted")
  expect(s).not.toContain("owner@private.example")
  expect(s).not.toContain("proxy-secret-pw")
}

describe.skipIf(!HAS_DB)("apify tokens service (DB)", () => {
  beforeAll(async () => {
    await db
      .insert(user)
      .values(
        actors.map((a) => ({
          id: a.id,
          name: `Tên ${a.id}`,
          email: a.email,
          role: a.role,
          emailVerified: true,
        }))
      )
  })

  afterAll(async () => {
    const ids = actors.map((a) => a.id)
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, ids))
    const mcps = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(inArray(mcpServers.ownerId, ids))
    if (mcps.length)
      await db.delete(apifyRuns).where(
        inArray(
          apifyRuns.mcpId,
          mcps.map((x) => x.id)
        )
      )
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, ids))
    await db.delete(apifyTokens).where(inArray(apifyTokens.ownerId, ids))
    await db.delete(user).where(inArray(user.id, ids))
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    hooks.failLog = false
    fake = createFakeApify()
    setupAccounts()
    vi.stubGlobal("fetch", vi.fn(fake.fetch))
  })

  it("tạo token cá nhân: mã hoá (AAD gắn id), lưu tài khoản / gói / credit, activity log có phiên bản miễn trừ; token không bao giờ có trong kết quả / log", async () => {
    const { id } = await createApifyToken(
      staffA,
      { name: `${PREFIX} cá nhân A`, token: T_A, scope: "personal" },
      { disclaimerVersion: "2026-10-14" }
    )
    const [row] = await db
      .select()
      .from(apifyTokens)
      .where(eq(apifyTokens.id, id))
    expect(row!.credentialsEncrypted).not.toContain(T_A)
    expect(
      decryptSecret(row!.credentialsEncrypted, aad.apifyTokenCredentials(id))
    ).toBe(T_A)
    expect(row).toMatchObject({
      scope: "personal",
      ownerId: staffA.id,
      credentialHint: T_A.slice(-4),
      apifyUserId: `${ACC}accA`,
      apifyUsername: "nhanvien-a",
      planId: "FREE",
      usageUsd: 1,
      limitUsd: 5,
      status: "active",
    })
    expect(row!.lastCheckedAt).not.toBeNull()
    // only header auth reached Apify
    for (const c of fake.calls) {
      expect(c.query.has("token")).toBe(false)
      expect(c.authorization).toBe(`Bearer ${T_A}`)
    }
    const logs = await logsOf(id, "apify_token.create")
    expect(logs).toHaveLength(1)
    expect(logs[0]!.metadata).toMatchObject({
      scope: "personal",
      disclaimerVersion: "2026-10-14",
      apifyUsername: "nhanvien-a",
    })
    expectNoSecrets(logs[0]!.metadata)
    expectNoSecrets(await listApifyTokens(staffA))
    expectNoSecrets(await getApifyTokenDetail(staffA, id))
    expectNoSecrets(await previewApifyToken(staffA, T_A))
    expectNoSecrets(await loadGrantApifyTokens(staffA.id))
  })

  it("activity log lỗi → không lưu token (cùng transaction); token sai → lỗi ở trường token, không lưu", async () => {
    hooks.failLog = true
    await expect(
      createApifyToken(staffA, {
        name: `${PREFIX} tx-fail`,
        token: T_A,
        scope: "personal",
      })
    ).rejects.toThrow()
    hooks.failLog = false
    expect(
      await db
        .select()
        .from(apifyTokens)
        .where(eq(apifyTokens.name, `${PREFIX} tx-fail`))
    ).toHaveLength(0)
    const err = await createApifyToken(staffA, {
      name: `${PREFIX} sai`,
      token: fakeToken("khongton tai"),
      scope: "personal",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApifyServiceError)
    expect((err as ApifyServiceError).fieldErrors?.token).toMatch(
      /Apify từ chối token/
    )
    expect(
      await db
        .select()
        .from(apifyTokens)
        .where(eq(apifyTokens.name, `${PREFIX} sai`))
    ).toHaveLength(0)
  })

  it("nhân viên không được thêm token công ty; admin được; Apify không phản hồi → lỗi chung, không lưu", async () => {
    const err = await createApifyToken(staffA, {
      name: `${PREFIX} co`,
      token: T_CO,
      scope: "company",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApifyServiceError)
    expect((err as ApifyServiceError).fieldErrors).toHaveProperty("scope")
    expect(fake.calls).toHaveLength(0)
    const { id } = await createApifyToken(admin, {
      name: `${PREFIX} công ty`,
      token: T_CO,
      scope: "company",
    })
    expect(
      (await db.select().from(apifyTokens).where(eq(apifyTokens.id, id)))[0]!
        .scope
    ).toBe("company")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    )
    await expect(
      createApifyToken(admin, {
        name: `${PREFIX} down`,
        token: T_CO,
        scope: "company",
      })
    ).rejects.toThrow(/Không kết nối được tới Apify/)
  })

  it("tài khoản đã hết credit vẫn lưu được nhưng ở trạng thái exhausted tới cuối chu kỳ; preview đếm token cùng tài khoản", async () => {
    const { id } = await createApifyToken(staffB, {
      name: `${PREFIX} hết credit`,
      token: T_EX,
      scope: "personal",
    })
    const [row] = await db
      .select()
      .from(apifyTokens)
      .where(eq(apifyTokens.id, id))
    expect(row!.status).toBe("exhausted")
    expect(row!.exhaustedUntil?.toISOString()).toBe("2099-11-03T00:00:00.000Z")
    const p = await previewApifyToken(staffA, T_A2)
    expect(p).toMatchObject({
      apifyUserId: `${ACC}accA`,
      username: "nhanvien-a",
      usageUsd: 1,
      limitUsd: 5,
      actorsEnabled: true,
    })
    expect(p.sameAccountTokens).toBeGreaterThanOrEqual(1)
  })

  it("phân quyền: nhân viên thấy token công ty (chỉ xem, không hint) + token của mình, không thấy token cá nhân người khác; admin thấy và quản lý tất cả", async () => {
    const co = await createApifyToken(admin, {
      name: `${PREFIX} co-vis`,
      token: T_CO,
      scope: "company",
    })
    const a = await createApifyToken(staffA, {
      name: `${PREFIX} a-vis`,
      token: T_A,
      scope: "personal",
    })
    const b = await createApifyToken(staffB, {
      name: `${PREFIX} b-vis`,
      token: T_B,
      scope: "personal",
    })
    const listA = await listApifyTokens(staffA)
    const coA = listA.find((t) => t.id === co.id)!
    expect(coA).toMatchObject({
      scope: "company",
      canManage: false,
      credentialHint: "",
      ownerName: `Tên ${admin.id}`,
    })
    expect(listA.find((t) => t.id === a.id)).toMatchObject({
      canManage: true,
      credentialHint: T_A.slice(-4),
    })
    expect(listA.find((t) => t.id === b.id)).toBeUndefined()
    const listAdmin = await listApifyTokens(admin)
    for (const id of [co.id, a.id, b.id])
      expect(listAdmin.find((t) => t.id === id)?.canManage).toBe(true)

    // not visible → generic not found; visible company token → read-only for staff
    await expect(getApifyTokenDetail(staffA, b.id)).rejects.toThrow(
      "Không tìm thấy token Apify."
    )
    await expect(
      renameApifyToken(staffA, { id: b.id, name: "x" })
    ).rejects.toThrow("Không tìm thấy token Apify.")
    await expect(
      deleteApifyToken(staffA, { id: b.id, confirmName: `${PREFIX} b-vis` })
    ).rejects.toThrow("Không tìm thấy token Apify.")
    for (const op of [
      () => renameApifyToken(staffA, { id: co.id, name: "x" }),
      () => setApifyTokenEnabled(staffA, { id: co.id, enabled: false }),
      () => replaceApifyTokenSecret(staffA, { id: co.id, token: T_A }),
      () => recheckApifyToken(staffA, co.id),
      () =>
        deleteApifyToken(staffA, {
          id: co.id,
          confirmName: `${PREFIX} co-vis`,
        }),
    ])
      await expect(op()).rejects.toThrow(/Chỉ quản trị viên/)
    expect((await getApifyTokenDetail(staffA, co.id)).canManage).toBe(false)
    // admin manages a staff member's personal token
    await renameApifyToken(admin, { id: b.id, name: `${PREFIX} b-vis-2` })
    expect(
      (await listApifyTokens(staffB)).find((t) => t.id === b.id)!.name
    ).toBe(`${PREFIX} b-vis-2`)
    // grant of an MCP owned by A: company + A's personal only
    const grant = (await loadGrantApifyTokens(staffA.id)).map((t) => t.id)
    expect(grant).toEqual(expect.arrayContaining([co.id, a.id]))
    expect(grant).not.toContain(b.id)
  })

  it("đổi tên / tắt / bật / thay token (đọc lại tài khoản) / kiểm tra lại / xoá - mỗi bước có activity log, không lộ token", async () => {
    const { id } = await createApifyToken(staffA, {
      name: `${PREFIX} vòng đời`,
      token: T_A,
      scope: "personal",
    })
    await renameApifyToken(staffA, { id, name: `${PREFIX} vòng đời 2` })
    await renameApifyToken(staffA, { id, name: `${PREFIX} vòng đời 2` }) // no-op, no second log
    expect(await logsOf(id, "apify_token.update")).toHaveLength(1)

    await setApifyTokenEnabled(staffA, { id, enabled: false })
    await setApifyTokenEnabled(staffA, { id, enabled: false }) // no-op
    expect(
      (await db.select().from(apifyTokens).where(eq(apifyTokens.id, id)))[0]!
        .status
    ).toBe("disabled")
    expect(
      await loadGrantApifyTokens(staffA.id).then((g) => g.map((t) => t.id))
    ).not.toContain(id)
    await setApifyTokenEnabled(staffA, { id, enabled: true })
    expect(await logsOf(id, "apify_token.disable")).toHaveLength(1)
    expect(await logsOf(id, "apify_token.enable")).toHaveLength(1)

    // another Apify account is refused (runs stay pinned to this row): field error, nothing written
    const other = await replaceApifyTokenSecret(staffA, { id, token: T_B }).catch((e: unknown) => e)
    expect(other).toBeInstanceOf(ApifyServiceError)
    expect((other as ApifyServiceError).fieldErrors?.token).toMatch(/Token mới thuộc tài khoản Apify khác/)
    expect(await logsOf(id, "apify_token.replace_token")).toHaveLength(0)
    // replace with another token of the SAME account
    await replaceApifyTokenSecret(staffA, { id, token: T_A2 })
    const [row] = await db
      .select()
      .from(apifyTokens)
      .where(eq(apifyTokens.id, id))
    expect(decryptApifyToken(row!)).toBe(T_A2)
    expect(row).toMatchObject({
      credentialHint: T_A2.slice(-4),
      apifyUserId: `${ACC}accA`,
      apifyUsername: "nhanvien-a",
      status: "active",
    })
    const rep = await logsOf(id, "apify_token.replace_token")
    expect(rep[0]!.metadata).toMatchObject({
      before: { credentialHint: T_A.slice(-4) },
      after: { credentialHint: T_A2.slice(-4) },
      sameAccount: true,
    })
    expectNoSecrets(rep[0]!.metadata)

    // recheck: account now out of credit → exhausted (no updated_at bump)
    fake.accounts.get(T_A2)!.usageUsd = 5
    const before = row!.updatedAt
    const dto = await recheckApifyToken(staffA, id)
    expect(dto).toMatchObject({ status: "exhausted", usageUsd: 5 })
    expect(
      (
        await db.select().from(apifyTokens).where(eq(apifyTokens.id, id))
      )[0]!.updatedAt.getTime()
    ).toBe(before.getTime())
    // recheck: token revoked at Apify → invalid + reason in the DTO, activity status failure
    fake.accounts.delete(T_A2)
    const dto2 = await recheckApifyToken(staffA, id)
    expect(dto2.status).toBe("invalid")
    expect(dto2.statusMessage).toMatch(/Thay token/)
    // recheck: Apify down → status unchanged, failure logged, error thrown
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 502 }))
    )
    await expect(recheckApifyToken(staffA, id)).rejects.toThrow(
      /Không kết nối được tới Apify/
    )
    const rechecks = await logsOf(id, "apify_token.recheck")
    expect(rechecks.map((l) => l.status).sort()).toEqual([
      "failure",
      "failure",
      "success",
    ])
    expect(
      (await db.select().from(apifyTokens).where(eq(apifyTokens.id, id)))[0]!
        .status
    ).toBe("invalid")

    // delete: the typed name must match; secret wiped; MCPs using it counted
    await newMcp(staffA, "dùng apify", true)
    await newMcp(staffA, "không dùng", false)
    await expect(
      deleteApifyToken(staffA, { id, confirmName: "sai" })
    ).rejects.toMatchObject({
      fieldErrors: { confirmName: expect.any(String) },
    })
    await deleteApifyToken(staffA, { id, confirmName: `${PREFIX} vòng đời 2` })
    const [gone] = await db
      .select()
      .from(apifyTokens)
      .where(eq(apifyTokens.id, id))
    expect(gone!.deletedAt).not.toBeNull()
    expect(
      decryptSecret(gone!.credentialsEncrypted, aad.apifyTokenCredentials(id))
    ).toBe("")
    expect((await logsOf(id, "apify_token.delete"))[0]!.metadata).toMatchObject(
      { affectedMcpCount: 1 }
    )
    expect(
      (await listApifyTokens(staffA)).find((t) => t.id === id)
    ).toBeUndefined()
    await expect(getApifyTokenDetail(admin, id)).rejects.toThrow(
      "Không tìm thấy token Apify."
    )
  })

  it("chi tiết: MCP của người khác ẩn danh với nhân viên; lịch sử chạy chỉ gồm MCP của chính nhân viên; tóm tắt kho cho wizard", async () => {
    const co = await createApifyToken(admin, {
      name: `${PREFIX} co-detail`,
      token: T_CO,
      scope: "company",
    })
    const mine = await newMcp(staffA, "mcp A", true)
    const theirs = await newMcp(staffB, "mcp B", true)
    await db.insert(apifyRuns).values([
      {
        mcpId: mine,
        tokenId: co.id,
        actorId: "apify~a",
        runId: `${co.id.slice(0, 8)}r1`.replace(/-/g, ""),
        status: "SUCCEEDED",
        maxChargeUsd: 1,
        usageUsd: 0.1,
      },
      {
        mcpId: theirs,
        tokenId: co.id,
        actorId: "apify~b",
        runId: `${co.id.slice(0, 8)}r2`.replace(/-/g, ""),
        status: "RUNNING",
        maxChargeUsd: 1,
      },
    ])
    const dA = await getApifyTokenDetail(staffA, co.id)
    expect(dA.mcpUsage.find((u) => u.mcpId === mine)).toMatchObject({
      mcpName: `${PREFIX} mcp A`,
    })
    expect(
      dA.mcpUsage.find((u) => u.mcpName === `${PREFIX} mcp B`)
    ).toBeUndefined()
    expect(
      dA.mcpUsage.some((u) => u.mcpId === null && u.ownerName === null)
    ).toBe(true)
    expect(dA.recentRuns.map((r) => r.actorId)).toEqual(["apify~a"])
    const dAdmin = await getApifyTokenDetail(admin, co.id)
    expect(dAdmin.recentRuns.map((r) => r.actorId).sort()).toEqual([
      "apify~a",
      "apify~b",
    ])
    expect(dAdmin.mcpUsage.find((u) => u.mcpId === theirs)?.ownerName).toBe(
      `Tên ${staffB.id}`
    )

    const s = await getMcpApifyPoolSummary({ id: staffA.id, role: "staff" })
    expect(s.company).toBeGreaterThanOrEqual(1)
    expect(s.tokens).toBe(s.company + s.personal)
    expect(s.usableNow).toBeLessThanOrEqual(s.tokens)
    expect(s.accounts).toBeLessThanOrEqual(s.tokens)
  })

  it("preview: nhân viên chỉ đếm token cùng tài khoản là token công ty + của mình (không lộ token cá nhân người khác)", async () => {
    // B (staff) saves a personal token of the account accA; A previews another token of accA
    await createApifyToken(staffB, { name: `${PREFIX} b-same`, token: T_A2, scope: "personal" })
    const forA = await previewApifyToken(staffA, T_A)
    const forAdmin = await previewApifyToken(admin, T_A)
    expect(forAdmin.sameAccountTokens).toBeGreaterThan(forA.sameAccountTokens)
    const mineOrCompany = (await listApifyTokens(staffA)).filter((t) => t.apifyUsername === "nhanvien-a").length
    expect(forA.sameAccountTokens).toBe(mineOrCompany)
  })

  it("thay token / kiểm tra lại không ghi đè khi token bị tắt hoặc bị thay trong lúc gọi Apify → lỗi xung đột, không log", async () => {
    const { id } = await createApifyToken(staffA, { name: `${PREFIX} race`, token: T_A, scope: "personal" })
    // disabled by someone else while Apify checks the new token → no re-activation, nothing written
    let once = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (once && url.endsWith("/users/me")) {
          once = false
          await db.update(apifyTokens).set({ status: "disabled" }).where(eq(apifyTokens.id, id))
        }
        return fake.fetch(url, init)
      })
    )
    await expect(replaceApifyTokenSecret(staffA, { id, token: T_A2 })).rejects.toThrow(/vừa được thay đổi/)
    const [r1] = await db.select().from(apifyTokens).where(eq(apifyTokens.id, id))
    expect(r1!.status).toBe("disabled")
    expect(decryptApifyToken(r1!)).toBe(T_A)
    expect(await logsOf(id, "apify_token.replace_token")).toHaveLength(0)

    // re-enabled, then replaced by someone else during a recheck → the old token's result is not written
    await setApifyTokenEnabled(staffA, { id, enabled: true })
    fake.accounts.delete(T_A) // the old token would now be "invalid"
    once = true
    const { encryptApifyToken } = await import("@/server/apify/store")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (once && url.endsWith("/users/me")) {
          once = false
          await db.update(apifyTokens).set({ credentialsEncrypted: encryptApifyToken(id, T_B) }).where(eq(apifyTokens.id, id))
        }
        return fake.fetch(url, init)
      })
    )
    await expect(recheckApifyToken(staffA, id)).rejects.toThrow(/vừa được thay đổi/)
    const [r2] = await db.select().from(apifyTokens).where(eq(apifyTokens.id, id))
    expect(r2!.status).toBe("active")
    expect(await logsOf(id, "apify_token.recheck")).toHaveLength(0)
  })

  it("chi tiết: giữ chỗ đang khởi chạy (STARTING, token tạm) không hiện; UNKNOWN hiện ở token đã thử; tóm tắt kho chỉ đếm token grant dùng", async () => {
    const co = await createApifyToken(admin, { name: `${PREFIX} co-res`, token: T_CO, scope: "company" })
    const mine = await newMcp(admin, "mcp res", true)
    await db.insert(apifyRuns).values([
      { mcpId: mine, tokenId: co.id, actorId: "apify~a", runId: `pending:${randomUUID()}`, status: "STARTING", maxChargeUsd: 1 },
      { mcpId: mine, tokenId: co.id, actorId: "apify~b", runId: `pending:${randomUUID()}`, status: "UNKNOWN", maxChargeUsd: 1 },
    ])
    const d = await getApifyTokenDetail(admin, co.id)
    expect(d.recentRuns.map((r) => r.status)).toEqual(["UNKNOWN"])

    const before = await getMcpApifyPoolSummary({ id: staffA.id, role: "staff" })
    const { id: errId } = await createApifyToken(staffA, { name: `${PREFIX} err`, token: T_A, scope: "personal" })
    const mid = await getMcpApifyPoolSummary({ id: staffA.id, role: "staff" })
    expect(mid.tokens).toBe(before.tokens + 1)
    await db.update(apifyTokens).set({ status: "error" }).where(eq(apifyTokens.id, errId))
    const after = await getMcpApifyPoolSummary({ id: staffA.id, role: "staff" })
    expect(after.tokens).toBe(before.tokens)
  })
})
