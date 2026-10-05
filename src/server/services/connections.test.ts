// Integration tests for the connections / ad-accounts services against the dev/test Postgres
// (skipped when DATABASE_URL is not set). A fake "meta" provider is registered so no API is called.
import { randomUUID } from "node:crypto"
import { and, eq, inArray, like } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ failLog: false }))

vi.mock("server-only", () => ({}))
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...mod,
    logActivity: async (entry: Parameters<typeof mod.logActivity>[0], tx?: Parameters<typeof mod.logActivity>[1]) => {
      if (hooks.failLog) throw new Error("simulated activity log failure")
      return mod.logActivity({ ...entry, ip: null, userAgent: null }, tx)
    },
  }
})

import { decryptJson, aad } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections, mcpAccountScopes, mcpServers, user } from "@/server/db/schema"
import { deriveHealth, refreshConnection } from "@/server/jobs/lib/connection-ops"
import { ProviderError } from "@/server/providers/errors"
import { registerProvider } from "@/server/providers/registry"
import type { AdAccountInfo, AdsProvider, CredentialCheck } from "@/server/providers/types"

import { assertScopesUsableForMcp, listUsableConnectionsForMcp, setAdAccountsEnabled } from "./ad-accounts"
import {
  ConnectionServiceError,
  createConnection,
  deleteConnection,
  getConnection,
  getConnectionUsage,
  listConnections,
  previewConnection,
  renameConnection,
  replaceCredentials,
  syncConnectionAccounts,
  testConnection,
  type Actor,
} from "./connections"

// ---------------------------------------------------------------------------
// Fake provider
// ---------------------------------------------------------------------------

const TOKEN = "FAKE-SECRET-TOKEN-0123456789-abcd"
const fake = {
  valid: true,
  tokenExpiresAt: null as Date | null,
  throwOnValidate: null as ProviderError | null,
  accounts: [] as AdAccountInfo[],
}

function acc(id: string, name = `Account ${id}`): AdAccountInfo {
  return { externalId: id, name, currency: "VND", timezone: "Asia/Ho_Chi_Minh", status: "active", statusRaw: "1" }
}

const notUsed = () => {
  throw new Error("not used in tests")
}

const fakeProvider = {
  platform: "meta",
  capabilities: {},
  credentialFields: [{ key: "access_token", label: "Access token", type: "secret", required: true }],
  guide: { summary: "fake", steps: [] },
  extensions: [],
  parseCredentials(raw: unknown) {
    const t = (raw as Record<string, unknown>)?.access_token
    if (typeof t !== "string" || t.length < 10) {
      throw new ProviderError({
        platform: "meta",
        code: "invalid_credentials_input",
        message: "bad",
        userMessageVi: "Access token quá ngắn.",
      })
    }
    return { accessToken: t }
  },
  credentialHint: (c: { accessToken: string }) => `…${c.accessToken.slice(-4)}`,
  async validateCredentials(): Promise<CredentialCheck> {
    if (fake.throwOnValidate) throw fake.throwOnValidate
    return {
      valid: fake.valid,
      tokenExpiresAt: fake.tokenExpiresAt,
      scopes: fake.valid ? ["ads_management", "ads_read"] : null,
      warnings: fake.valid ? ["Cảnh báo thử nghiệm"] : ["Token Meta đã hết hạn."],
      meta: { appId: "123456" },
    }
  },
  async listAccounts() {
    return fake.accounts
  },
  getReport: notUsed,
  listObjects: notUsed,
  getObject: notUsed,
  setStatus: notUsed,
  updateBudget: notUsed,
  updateObject: notUsed,
  copyObject: notUsed,
  deleteObject: notUsed,
  uploadMedia: notUsed,
  lookup: notUsed,
} as unknown as AdsProvider<unknown>

// ---------------------------------------------------------------------------

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-conn-${randomUUID().slice(0, 8)}`

const staffA: Actor = { id: `${PREFIX}-a`, email: `${PREFIX}-a@test.local`, role: "staff" }
const staffB: Actor = { id: `${PREFIX}-b`, email: `${PREFIX}-b@test.local`, role: "staff" }
const admin: Actor = { id: `${PREFIX}-admin`, email: `${PREFIX}-admin@test.local`, role: "admin" }
const actors = [staffA, staffB, admin]

function resetFake() {
  fake.valid = true
  fake.tokenExpiresAt = null
  fake.throwOnValidate = null
  fake.accounts = [acc("act_1"), acc("act_2"), acc("act_3")]
  hooks.failLog = false
}

async function newConnection(owner: Actor, name: string, disabled: string[] = []) {
  return createConnection(owner, {
    platform: "meta",
    name: `${PREFIX} ${name}`,
    credentials: { access_token: TOKEN },
    disabledExternalIds: disabled,
  })
}

describe.skipIf(!HAS_DB)("connections service (DB)", () => {
  beforeAll(async () => {
    registerProvider(fakeProvider)
    await db.insert(user).values(
      actors.map((a) => ({ id: a.id, name: a.id, email: a.email, role: a.role, emailVerified: true }))
    )
  })

  afterAll(async () => {
    const ids = actors.map((a) => a.id)
    // test-only cleanup of our own rows (append-only rule applies to app code)
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, ids))
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, ids))
    await db.delete(connections).where(inArray(connections.ownerId, ids))
    await db.delete(user).where(inArray(user.id, ids))
  })

  beforeEach(resetFake)

  it("mã hoá credential khi lưu (AAD gắn với id) và lưu hint, TKQC, activity log", async () => {
    const { id } = await newConnection(staffA, "encrypt", ["act_2"])
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    expect(row).toBeDefined()
    expect(row!.credentialsEncrypted).not.toContain(TOKEN)
    expect(row!.credentialsEncrypted).toMatch(/^v\d+\./)
    expect(decryptJson(row!.credentialsEncrypted, aad.connectionCredentials(id))).toEqual({ accessToken: TOKEN })
    expect(() => decryptJson(row!.credentialsEncrypted, aad.connectionCredentials(randomUUID()))).toThrow()
    expect(row!.credentialHint).toBe("…abcd")
    expect(row!.status).toBe("active")
    expect(row!.scopes).toEqual(["ads_management", "ads_read"])
    expect(row!.meta).toMatchObject({ appId: "123456", checkWarnings: ["Cảnh báo thử nghiệm"] })

    const accounts = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id))
    expect(accounts.map((a) => [a.externalId, a.isEnabled]).sort()).toEqual([
      ["act_1", true],
      ["act_2", false],
      ["act_3", true],
    ])

    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.targetId, id), eq(activityLogs.action, "connection.create")))
    expect(logs).toHaveLength(1)
    expect(logs[0]!.actorId).toBe(staffA.id)
    expect(JSON.stringify(logs[0]!.metadata)).not.toContain(TOKEN)
  })

  it("không bao giờ trả credential/ciphertext qua list, get, preview", async () => {
    const { id } = await newConnection(staffA, "no-leak")
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    const outputs = [
      await listConnections(staffA),
      await getConnection(staffA, id),
      await previewConnection(staffA, { platform: "meta", credentials: { access_token: TOKEN } }),
    ]
    for (const o of outputs) {
      const s = JSON.stringify(o)
      expect(s).not.toContain(TOKEN)
      expect(s).not.toContain(row!.credentialsEncrypted)
      expect(s).not.toContain("credentialsEncrypted")
    }
  })

  it("staff không thấy / không sửa được kết nối của người khác; admin thấy tất cả", async () => {
    const { id } = await newConnection(staffA, "owner-check")
    const listB = await listConnections(staffB)
    expect(listB.find((c) => c.id === id)).toBeUndefined()
    const listAdmin = await listConnections(admin)
    const seen = listAdmin.find((c) => c.id === id)
    expect(seen?.owner.email).toBe(staffA.email)
    expect(seen?.accountCount).toBe(3)

    await expect(getConnection(staffB, id)).rejects.toBeInstanceOf(ConnectionServiceError)
    await expect(renameConnection(staffB, { connectionId: id, name: "hack" })).rejects.toBeInstanceOf(
      ConnectionServiceError
    )
    await expect(
      replaceCredentials(staffB, { connectionId: id, credentials: { access_token: "OTHER-TOKEN-123456" } })
    ).rejects.toBeInstanceOf(ConnectionServiceError)
    await expect(testConnection(staffB, id)).rejects.toBeInstanceOf(ConnectionServiceError)
    await expect(deleteConnection(staffB, id)).rejects.toBeInstanceOf(ConnectionServiceError)
    const [acct] = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id)).limit(1)
    await expect(
      setAdAccountsEnabled(staffB, { connectionId: id, changes: [{ adAccountId: acct!.id, enabled: false }] })
    ).rejects.toBeInstanceOf(ConnectionServiceError)

    // admin may act on staff connections
    await renameConnection(admin, { connectionId: id, name: `${PREFIX} renamed-by-admin` })
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    expect(row!.name).toBe(`${PREFIX} renamed-by-admin`)
    expect(row!.ownerId).toBe(staffA.id)
  })

  it("rollback toàn bộ khi ghi activity log lỗi (cùng transaction)", async () => {
    hooks.failLog = true
    await expect(newConnection(staffA, "rollback")).rejects.toThrow("simulated activity log failure")
    hooks.failLog = false
    const rows = await db.select().from(connections).where(like(connections.name, `${PREFIX} rollback%`))
    expect(rows).toHaveLength(0)

    const { id } = await newConnection(staffA, "rollback-rename")
    hooks.failLog = true
    await expect(renameConnection(staffA, { connectionId: id, name: `${PREFIX} new-name` })).rejects.toThrow()
    hooks.failLog = false
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    expect(row!.name).toBe(`${PREFIX} rollback-rename`)
  })

  it("từ chối token không hợp lệ và input sai bằng thông báo tiếng Việt", async () => {
    await expect(
      createConnection(staffA, { platform: "meta", name: `${PREFIX} short`, credentials: { access_token: "x" } })
    ).rejects.toThrow("Access token quá ngắn.")
    fake.valid = false
    await expect(newConnection(staffA, "invalid")).rejects.toThrow("Token Meta đã hết hạn.")
    fake.valid = true
    fake.tokenExpiresAt = new Date(Date.now() - 1000)
    await expect(newConnection(staffA, "expired")).rejects.toThrow(/đã hết hạn/)
  })

  it("đồng bộ: thêm TKQC mới, đánh dấu TKQC biến mất là closed, không xoá dòng", async () => {
    const { id } = await newConnection(staffA, "sync", ["act_3"])
    fake.accounts = [acc("act_1", "Renamed 1"), acc("act_3"), acc("act_4")]
    const res = await syncConnectionAccounts(staffA, id)
    expect(res.status).toBe("active")
    expect(res.accountCount).toBe(3)
    const rows = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id))
    const by = new Map(rows.map((r) => [r.externalId, r]))
    expect(rows).toHaveLength(4)
    expect(by.get("act_1")!.name).toBe("Renamed 1")
    expect(by.get("act_2")!.status).toBe("closed")
    expect(by.get("act_2")!.statusRaw).toBe("not_returned")
    expect(by.get("act_3")!.isEnabled).toBe(false) // user choice kept
    expect(by.get("act_1")!.isEnabled).toBe(true) // existing row keeps its state
    // discovered AFTER creation → disabled until the user enables it (MCP "all accounts" must not expand)
    expect(by.get("act_4")!.isEnabled).toBe(false)
  })

  it("kiểm tra sức khoẻ: active / expiring (<7 ngày) / invalid / lỗi tạm thời giữ trạng thái", async () => {
    const { id } = await newConnection(staffA, "health")

    fake.tokenExpiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000)
    let r = await testConnection(staffA, id)
    expect(r.status).toBe("expiring")
    expect(r.statusMessage).toMatch(/hết hạn sau 3 ngày/)
    // message = what happened; hint = the next step (separate fields, no instruction inside the message)
    expect(r.statusMessage).not.toMatch(/Thay token/)
    expect(r.statusHint).toMatch(/Thay token/)
    expect(r.statusHint).toMatch(/Graph API Explorer/) // platform specific (meta)

    fake.throwOnValidate = new ProviderError({
      platform: "meta",
      code: "rate_limited",
      message: "429",
      userMessageVi: "Meta đang giới hạn số lệnh.",
      retryable: true,
    })
    r = await testConnection(staffA, id)
    expect(r.status).toBe("expiring") // unchanged
    expect(r.statusMessage).toBe("Không kiểm tra được: Meta đang giới hạn số lệnh.")
    expect(r.statusHint).toMatch(/Thay token/) // still expiring → replace the token

    fake.throwOnValidate = new ProviderError({
      platform: "meta",
      code: "auth_invalid",
      message: "190",
      userMessageVi: "Token Meta đã bị thu hồi.",
      hint: "Tạo token mới.",
    })
    r = await testConnection(staffA, id)
    expect(r.status).toBe("invalid")
    // the adapter message is stored alone; its hint is NOT glued on, the service returns a concrete next step instead
    expect(r.statusMessage).toBe("Token Meta đã bị thu hồi.")
    expect(r.statusHint).toBe('Tạo token mới trong Graph API Explorer (cùng app), rồi bấm "Thay token" ở trang kết nối.')
    expect((await getConnection(staffA, id)).statusHint).toBe(r.statusHint)
    expect((await listConnections(staffA)).find((c) => c.id === id)!.statusHint).toBe(r.statusHint)

    fake.throwOnValidate = null
    fake.tokenExpiresAt = null
    r = await testConnection(staffA, id)
    expect(r.status).toBe("active")
    expect(r.statusMessage).toBeNull()
    expect(r.statusHint).toBeNull()

    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.targetId, id), eq(activityLogs.action, "connection.test")))
    expect(logs.length).toBe(4)
  })

  it("lỗi tạm thời trên kết nối đang active: giữ trạng thái, gợi ý thử lại (không bảo thay token)", async () => {
    const { id } = await newConnection(staffA, "transient")
    fake.throwOnValidate = new ProviderError({ platform: "meta", code: "upstream_error", message: "503", userMessageVi: "Nền tảng đang bận.", retryable: true })
    const r = await testConnection(staffA, id)
    expect(r.status).toBe("active")
    expect(r.statusMessage).toBe("Không kiểm tra được: Nền tảng đang bận.")
    expect(r.statusHint).toMatch(/Kiểm tra lại/)
    expect(r.statusHint).not.toMatch(/Thay token/)
    fake.throwOnValidate = null
  })

  it("preview: tài khoản đã đóng / bị tắt / chờ duyệt / MCC mặc định TẮT, tài khoản active và unknown mặc định BẬT", async () => {
    fake.accounts = [
      acc("act_ok"),
      { ...acc("act_closed"), status: "closed", statusRaw: "101" },
      { ...acc("act_disabled"), status: "disabled", statusRaw: "2" },
      { ...acc("act_pending"), status: "pending", statusRaw: "7" },
      { ...acc("act_unknown"), status: "unknown", statusRaw: "?" },
      { ...acc("act_mcc"), isManager: true },
    ]
    const pv = await previewConnection(staffA, { platform: "meta", credentials: { access_token: TOKEN } })
    const def = Object.fromEntries(pv.accounts.map((a) => [a.externalId, a.defaultEnabled]))
    expect(def).toEqual({ act_ok: true, act_closed: false, act_disabled: false, act_pending: false, act_unknown: true, act_mcc: false })
    expect(pv.statusHint).toBeNull() // healthy token
  })

  it("tạo kết nối: mặc định theo defaultEnabled; disabledExternalIds tắt thêm; enabledExternalIds bật tài khoản mặc định-tắt", async () => {
    fake.accounts = [
      acc("act_ok"),
      acc("act_ok_off"),
      { ...acc("act_closed"), status: "closed", statusRaw: "101" },
      { ...acc("act_closed_on"), status: "closed", statusRaw: "101" },
      { ...acc("act_pending"), status: "pending", statusRaw: "7" },
      { ...acc("act_mcc"), isManager: true },
    ]
    const { id } = await createConnection(staffA, {
      platform: "meta",
      name: `${PREFIX} defaults`,
      credentials: { access_token: TOKEN },
      disabledExternalIds: ["act_ok_off"],
      enabledExternalIds: ["act_closed_on", "act_ok_off"], // act_ok_off is in both lists: the OFF list wins
    })
    const rows = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id))
    const on = Object.fromEntries(rows.map((r) => [r.externalId, r.isEnabled]))
    expect(on).toEqual({ act_ok: true, act_ok_off: false, act_closed: false, act_closed_on: true, act_pending: false, act_mcc: false })
    // an old client that sends only the OFF list never silently enables closed accounts
    const again = await createConnection(staffA, { platform: "meta", name: `${PREFIX} defaults 2`, credentials: { access_token: TOKEN }, disabledExternalIds: [] })
    const rows2 = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, again.id))
    expect(rows2.filter((r) => r.isEnabled).map((r) => r.externalId).sort()).toEqual(["act_ok", "act_ok_off"])
  })

  it("worker refreshConnection cập nhật trạng thái mà không ghi activity log", async () => {
    const { id } = await newConnection(staffA, "worker")
    fake.valid = false
    const res = await refreshConnection(id, { syncAccounts: true })
    expect(res?.status).toBe("invalid")
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    expect(row!.status).toBe("invalid")
    expect(row!.lastCheckedAt).not.toBeNull()
    const logs = await db.select().from(activityLogs).where(eq(activityLogs.targetId, id))
    expect(logs.map((l) => l.action)).toEqual(["connection.create"])
  })

  it("thay token: mã hoá lại, đổi hint, ghi connection.update", async () => {
    const { id } = await newConnection(staffA, "replace")
    const NEW = "NEW-SECRET-TOKEN-zzzz-9876543210-wxyz"
    fake.accounts = [acc("act_1"), acc("act_2"), acc("act_3"), acc("act_new")]
    await replaceCredentials(staffA, { connectionId: id, credentials: { access_token: NEW } })
    const accts = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id))
    // an account the new token can see that was not there at creation starts DISABLED
    expect(accts.find((a) => a.externalId === "act_new")!.isEnabled).toBe(false)
    expect(accts.find((a) => a.externalId === "act_1")!.isEnabled).toBe(true)
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    expect(decryptJson(row!.credentialsEncrypted, aad.connectionCredentials(id))).toEqual({ accessToken: NEW })
    expect(row!.credentialHint).toBe("…wxyz")
    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.targetId, id), eq(activityLogs.action, "connection.update")))
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs[0]!.metadata)).not.toContain(NEW)
  })

  it("bật/tắt TKQC ghi connection.accounts.toggle; MCP wizard chỉ thấy TKQC đang bật của mình", async () => {
    const { id } = await newConnection(staffA, "toggle")
    const accts = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id))
    const a1 = accts.find((a) => a.externalId === "act_1")!
    const res = await setAdAccountsEnabled(staffA, {
      connectionId: id,
      changes: [{ adAccountId: a1.id, enabled: false }],
    })
    expect(res.find((a) => a.id === a1.id)?.isEnabled).toBe(false)
    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.targetId, id), eq(activityLogs.action, "connection.accounts.toggle")))
    expect(logs).toHaveLength(1)

    const usableA = await listUsableConnectionsForMcp(staffA)
    const c = usableA.find((u) => u.id === id)!
    expect(c.accounts.map((a) => a.externalId).sort()).toEqual(["act_2", "act_3"])
    const usableB = await listUsableConnectionsForMcp(staffB)
    expect(usableB.find((u) => u.id === id)).toBeUndefined()
    expect((await listUsableConnectionsForMcp(admin)).find((u) => u.id === id)).toBeDefined()

    await expect(assertScopesUsableForMcp(staffA, [{ connectionId: id, adAccountId: null }])).resolves.toBeUndefined()
    await expect(assertScopesUsableForMcp(staffA, [{ connectionId: id, adAccountId: a1.id }])).rejects.toBeInstanceOf(
      ConnectionServiceError
    )
    await expect(assertScopesUsableForMcp(staffB, [{ connectionId: id, adAccountId: null }])).rejects.toBeInstanceOf(
      ConnectionServiceError
    )
  })

  it("xoá mềm: xoá credential, ẩn khỏi danh sách, báo MCP bị ảnh hưởng", async () => {
    const { id } = await newConnection(staffA, "delete")
    const [mcp] = await db
      .insert(mcpServers)
      .values({
        ownerId: admin.id,
        name: `${PREFIX} admin mcp`,
        keyHash: `${PREFIX}-hash-${randomUUID()}`,
        keyPrefix: "amcp_test",
        keyEncrypted: "v1.x.y.z",
      })
      .returning()
    await db.insert(mcpAccountScopes).values({ mcpId: mcp!.id, connectionId: id, adAccountId: null })

    const usageStaff = await getConnectionUsage(staffA, id)
    expect(usageStaff).toEqual([{ id: null, name: null, ownedByViewer: false }]) // admin's MCP id + name hidden
    const usageAdmin = await getConnectionUsage(admin, id)
    expect(usageAdmin[0]!.name).toBe(`${PREFIX} admin mcp`)
    expect(usageAdmin[0]!.id).toBe(mcp!.id)

    const res = await deleteConnection(staffA, id)
    // staff never receive the id of another user's MCP - only the count
    expect(res).toEqual({ affectedMcpIds: [], affectedMcpCount: 1 })
    const [delLog] = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.targetId, id), eq(activityLogs.action, "connection.delete")))
    expect(delLog!.metadata).toMatchObject({ affectedMcpIds: [], affectedMcpCount: 1 })
    expect(JSON.stringify(delLog!.metadata)).not.toContain(mcp!.id)
    const [row] = await db.select().from(connections).where(eq(connections.id, id))
    expect(row!.deletedAt).not.toBeNull()
    expect(decryptJson(row!.credentialsEncrypted, aad.connectionCredentials(id))).toEqual({})
    expect((await listConnections(staffA)).find((c) => c.id === id)).toBeUndefined()
    await expect(getConnection(staffA, id)).rejects.toBeInstanceOf(ConnectionServiceError)
    // scope rows are kept (grant loader filters deleted connections)
    const scopes = await db.select().from(mcpAccountScopes).where(eq(mcpAccountScopes.connectionId, id))
    expect(scopes).toHaveLength(1)
  })
})

describe("deriveHealth", () => {
  const now = new Date("2026-10-02T00:00:00Z")
  const base: CredentialCheck = { valid: true, tokenExpiresAt: null, scopes: null, warnings: [], meta: {} }
  it("token không hạn → active", () => {
    expect(deriveHealth(base, now)).toEqual({ status: "active", statusMessage: null })
  })
  it("còn < 7 ngày → expiring", () => {
    const h = deriveHealth({ ...base, tokenExpiresAt: new Date("2026-10-05T00:00:00Z") }, now)
    expect(h.status).toBe("expiring")
    expect(h.statusMessage).toContain("3 ngày")
  })
  it("còn ≥ 7 ngày → active", () => {
    expect(deriveHealth({ ...base, tokenExpiresAt: new Date("2026-10-20T00:00:00Z") }, now).status).toBe("active")
  })
  it("đã quá hạn hoặc valid=false → invalid", () => {
    expect(deriveHealth({ ...base, tokenExpiresAt: new Date("2026-10-01T00:00:00Z") }, now).status).toBe("invalid")
    expect(deriveHealth({ ...base, valid: false, warnings: ["Lỗi X"] }, now)).toEqual({
      status: "invalid",
      statusMessage: "Lỗi X",
    })
  })
})
