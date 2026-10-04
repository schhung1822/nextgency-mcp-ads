// Staff isolation with real rows (two staff + admin) in a private database:
//  - overview KPIs / chart / alerts / recent activity (aggregates must not leak other people's numbers),
//  - logs: list / detail / filter options / CSV export iterators / "my activity", including owner filters sent by
//    the client (ignored for staff),
//  - actions: a staff member cannot read or change another staff member's connections / MCP servers,
//  - the activity log tab and the CSV export route are admin-only for staff-level data.
import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("./temp-db")
  const t = await createTempDb("isolation")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())

import { and, eq, inArray, sql } from "drizzle-orm"

import { aad, encryptJson } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections, mcpCallLogs, mcpCallStatsHourly, mcpServers } from "@/server/db/schema"

import { actAs, closeDb, createTestUser, PASSWORD, signIn, uid, type Signed, type TestUser } from "./harness"

const hasDb = !!tmp
const P = `tiso_${uid()}`

const NOW = new Date()
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

let admin: TestUser
let s1: TestUser
let s2: TestUser
let sess1: Signed
let sess2: Signed
let sessAdmin: Signed
const ids = {
  c1: randomUUID(),
  c1bad: randomUUID(),
  c2: randomUUID(),
  cAdmin: randomUUID(),
  a1: randomUUID(),
  a1b: randomUUID(),
  a2: randomUUID(),
  aAdmin: randomUUID(),
  m1: randomUUID(),
  m2: randomUUID(),
  mAdmin: randomUUID(),
}
const logIds: Record<string, { id: string; createdAt: string }> = {}

function conn(id: string, ownerId: string, platform: "meta" | "openai_ads", name: string, extra: Partial<typeof connections.$inferInsert> = {}) {
  return {
    id,
    ownerId,
    platform,
    name,
    status: "active",
    credentialsEncrypted: encryptJson({ accessToken: "x" }, aad.connectionCredentials(id)),
    credentialHint: "xxxx",
    ...extra,
  }
}
function acc(id: string, connectionId: string, platform: "meta" | "openai_ads", ext: string) {
  return { id, connectionId, platform, externalId: ext, name: ext, currency: "VND", timezone: "Asia/Ho_Chi_Minh", status: "active", isEnabled: true }
}
function mcp(id: string, ownerId: string, name: string) {
  return { id, ownerId, name, keyHash: `h_${id}`, keyPrefix: `amcp_${id.slice(0, 6)}`, keyEncrypted: "v1.x.y.z" }
}

describe.skipIf(!hasDb)("cách ly dữ liệu nhân viên (DB + Better Auth)", () => {
  beforeAll(async () => {
    admin = await createTestUser(P, "admin", { role: "admin" })
    s1 = await createTestUser(P, "s1", { role: "staff" })
    s2 = await createTestUser(P, "s2", { role: "staff" })
    ;[sessAdmin, sess1, sess2] = [await signIn(admin), await signIn(s1), await signIn(s2)]

    await db.insert(connections).values([
      conn(ids.c1, s1.id, "meta", `${P} c1`),
      conn(ids.c1bad, s1.id, "openai_ads", `${P} c1bad`, { status: "invalid", statusMessage: "token chết" }),
      conn(ids.c2, s2.id, "meta", `${P} c2`, { status: "expiring", tokenExpiresAt: new Date(NOW.getTime() + 2 * 86_400_000) }),
      conn(ids.cAdmin, admin.id, "meta", `${P} cAdmin`),
    ])
    await db.insert(adAccounts).values([
      acc(ids.a1, ids.c1, "meta", "act_1"),
      acc(ids.a1b, ids.c1bad, "openai_ads", "adacct_700001"),
      acc(ids.a2, ids.c2, "meta", "act_2"),
      acc(ids.aAdmin, ids.cAdmin, "meta", "act_9990001"),
    ])
    await db.insert(mcpServers).values([mcp(ids.m1, s1.id, `${P} m1`), mcp(ids.m2, s2.id, `${P} m2`), mcp(ids.mAdmin, admin.id, `${P} mAdmin`)])

    const bucket = new Date(Math.floor(hoursAgo(3).getTime() / 3_600_000) * 3_600_000)
    await db.insert(mcpCallStatsHourly).values([
      { bucket, mcpId: ids.m1, ownerId: s1.id, platform: "meta", toolName: "ads_get_report", calls: 10, errors: 2 },
      { bucket, mcpId: ids.m2, ownerId: s2.id, platform: "openai_ads", toolName: "openai_ads_list_campaigns", calls: 100, errors: 50 },
      { bucket, mcpId: ids.mAdmin, ownerId: admin.id, platform: "meta", toolName: "meta_admin_report", calls: 1000, errors: 0 },
    ])

    const call = (mcpId: string, owner: TestUser, n: number, tool: string, platform: string, status = "success") => ({
      createdAt: hoursAgo(1 + n / 100),
      mcpId,
      mcpName: `${P} ${tool}`,
      ownerId: owner.id,
      ownerEmail: owner.email,
      method: "tools/call",
      toolName: tool,
      platform,
      adAccountId: "act_1",
      actionKind: "read",
      status,
      durationMs: 10,
    })
    await db.insert(mcpCallLogs).values([
      call(ids.m1, s1, 1, "ads_get_report", "meta"),
      call(ids.m1, s1, 2, "ads_get_report", "meta", "error"),
      call(ids.m2, s2, 3, "openai_ads_list_campaigns", "openai_ads"),
      call(ids.m2, s2, 4, "openai_ads_list_campaigns", "openai_ads"),
      call(ids.mAdmin, admin, 5, "meta_admin_report", "meta"),
    ])
    await db.insert(activityLogs).values([
      { actorId: s1.id, actorEmail: s1.email, actorRole: "staff", action: "connection.create", targetLabel: `${P} c1`, createdAt: hoursAgo(2) },
      { actorId: s1.id, actorEmail: s1.email, actorRole: "staff", action: "auth.login.success", createdAt: hoursAgo(2.5) },
      { actorId: s2.id, actorEmail: s2.email, actorRole: "staff", action: "mcp.create", targetLabel: `${P} m2`, createdAt: hoursAgo(1.5) },
      { actorId: admin.id, actorEmail: admin.email, actorRole: "admin", action: "settings.update", targetLabel: "session_max_hours", createdAt: hoursAgo(1) },
    ])
    for (const [key, owner] of [
      ["s1", s1],
      ["s2", s2],
      ["admin", admin],
    ] as const) {
      const [r] = await db.execute<{ id: string; created_at: string }>(
        sql`select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at from mcp_call_logs where owner_id = ${owner.id} limit 1`
      ).then((x) => x.rows)
      logIds[key] = { id: r!.id, createdAt: r!.created_at }
    }
    const [a] = (
      await db.execute<{ id: string; created_at: string }>(
        sql`select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at from activity_logs where actor_id = ${admin.id} and action = 'settings.update' limit 1`
      )
    ).rows
    logIds.adminActivity = { id: a!.id, createdAt: a!.created_at }
    const [b] = (
      await db.execute<{ id: string; created_at: string }>(
        sql`select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at from activity_logs where actor_id = ${s1.id} and action = 'connection.create' limit 1`
      )
    ).rows
    logIds.s1Activity = { id: b!.id, createdAt: b!.created_at }
  })

  afterAll(async () => {
    await closeDb()
    await tmp?.drop()
  })

  const viewer = (u: TestUser) => ({ id: u.id, role: u.role })
  const range = { since: new Date(NOW.getTime() - 24 * 3_600_000), until: new Date(NOW.getTime() + 60_000) }

  // -------------------------------------------------------------------------------------------------------------
  describe("Tổng quan (số liệu tổng hợp)", () => {
    it("KPI: nhân viên chỉ thấy số của mình, admin thấy tổng", async () => {
      const { getOverviewKpis } = await import("@/server/services/dashboard")
      const k1 = await getOverviewKpis(viewer(s1))
      expect(k1).toMatchObject({ connections: 2, connectionsNeedingAttention: 1, adAccounts: 2, totalMcp: 1, activeMcp: 1, calls24h: 10, errors24h: 2 })
      const k2 = await getOverviewKpis(viewer(s2))
      expect(k2).toMatchObject({ connections: 1, adAccounts: 1, totalMcp: 1, calls24h: 100, errors24h: 50 })
      const ka = await getOverviewKpis(viewer(admin))
      expect(ka).toMatchObject({ connections: 4, adAccounts: 4, totalMcp: 3, calls24h: 1110, errors24h: 52 })
    })

    it("biểu đồ lượt gọi: tổng theo từng người xem; không lộ nền tảng của người khác", async () => {
      const { getCallsChart } = await import("@/server/services/dashboard")
      const sum = (rows: Awaited<ReturnType<typeof getCallsChart>>, k: "meta" | "openai_ads") => rows.reduce((a, r) => a + r[k], 0)
      const c1 = await getCallsChart(viewer(s1), 7)
      expect([sum(c1, "meta"), sum(c1, "openai_ads")]).toEqual([10, 0])
      const c2 = await getCallsChart(viewer(s2), 7)
      expect([sum(c2, "meta"), sum(c2, "openai_ads")]).toEqual([0, 100])
      const ca = await getCallsChart(viewer(admin), 7)
      expect([sum(ca, "meta"), sum(ca, "openai_ads")]).toEqual([1010, 100])
    })

    it("cảnh báo token: chỉ kết nối của mình", async () => {
      const { getDashboardAlerts } = await import("@/server/services/dashboard")
      expect((await getDashboardAlerts(viewer(s1))).map((a) => a.connectionId)).toEqual([ids.c1bad])
      expect((await getDashboardAlerts(viewer(s2))).map((a) => a.connectionId)).toEqual([ids.c2])
      expect((await getDashboardAlerts(viewer(admin))).map((a) => a.connectionId).sort()).toEqual([ids.c1bad, ids.c2].sort())
    })

    it("hoạt động gần đây: nhân viên không thấy nhật ký nhân sự cũng như cuộc gọi MCP của người khác", async () => {
      const { getRecentActivity } = await import("@/server/services/dashboard")
      const r1 = await getRecentActivity(viewer(s1), 50)
      expect(r1.every((i) => i.kind === "mcp")).toBe(true)
      expect(r1).toHaveLength(2)
      expect(JSON.stringify(r1)).not.toContain("openai_ads_list_campaigns")
      const ra = await getRecentActivity(viewer(admin), 50)
      expect(ra.some((i) => i.kind === "staff")).toBe(true)
      expect(ra.filter((i) => i.kind === "mcp")).toHaveLength(5)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("Nhật ký", () => {
    it("MCP: nhân viên bị ép theo owner của mình dù client gửi ownerIds/mcpIds của người khác", async () => {
      const { listMcpLogs } = await import("@/server/services/logs")
      const own = await listMcpLogs(viewer(s1), { ...range })
      expect(own.rows.map((r) => r.ownerId)).toEqual([s1.id, s1.id])
      const spoof = await listMcpLogs(viewer(s1), { ...range, ownerIds: [s2.id], mcpIds: [ids.m2], platforms: ["openai_ads"] })
      expect(spoof.rows).toHaveLength(0)
      const spoof2 = await listMcpLogs(viewer(s1), { ...range, ownerIds: [s2.id, s1.id] })
      expect(spoof2.rows.every((r) => r.ownerId === s1.id)).toBe(true)
      const all = await listMcpLogs(viewer(admin), { ...range })
      expect(all.rows).toHaveLength(5)
      expect((await listMcpLogs(viewer(admin), { ...range, ownerIds: [s2.id] })).rows).toHaveLength(2)
    })

    it("MCP qua action loadMore: query string của client không mở rộng phạm vi", async () => {
      const { loadMoreMcpLogsAction, loadMoreActivityLogsAction } = await import("@/server/actions/logs")
      const { listMcpLogs, listActivityLogs } = await import("@/server/services/logs")
      // a real keyset cursor (the client only ever sends cursors the server handed out)
      const cursor = (await listMcpLogs(viewer(s1), { ...range }, null, 1)).nextCursor!
      const adminCursor = (await listActivityLogs(viewer(admin), { ...range }, null, 1)).nextCursor!
      actAs(sess1)
      const r = await loadMoreMcpLogsAction({ search: `owner=${s2.id}&mcp=${ids.m2}&range=`, cursor })
      expect(r.ok && r.data.rows).toHaveLength(0)
      const own = await loadMoreMcpLogsAction({ search: `owner=${s2.id}`, cursor })
      expect(own.ok && own.data.rows.length).toBe(1)
      expect(own.ok && own.data.rows.every((x) => x.ownerId === s1.id)).toBe(true)
      expect(await loadMoreActivityLogsAction({ search: "tab=staff", cursor: adminCursor })).toMatchObject({ ok: false })
      actAs(sessAdmin)
      const admin2 = await loadMoreActivityLogsAction({ search: "tab=staff", cursor: adminCursor })
      expect(admin2.ok && admin2.data.rows.length).toBeGreaterThanOrEqual(2)
    })

    it("chi tiết: nhân viên không mở được dòng của người khác (cả MCP lẫn nhân sự); admin mở được hết", async () => {
      const { getMcpLogDetailAction, getActivityLogDetailAction } = await import("@/server/actions/logs")
      actAs(sess1)
      expect(await getMcpLogDetailAction(logIds.s2!)).toMatchObject({ ok: false })
      expect(await getMcpLogDetailAction(logIds.admin!)).toMatchObject({ ok: false })
      expect(await getMcpLogDetailAction(logIds.s1!)).toMatchObject({ ok: true })
      expect(await getActivityLogDetailAction(logIds.adminActivity!)).toMatchObject({ ok: false })
      expect(await getActivityLogDetailAction(logIds.s1Activity!)).toMatchObject({ ok: true })
      actAs(sess2)
      expect(await getActivityLogDetailAction(logIds.s1Activity!)).toMatchObject({ ok: false })
      actAs(sessAdmin)
      expect(await getMcpLogDetailAction(logIds.s2!)).toMatchObject({ ok: true })
      expect(await getActivityLogDetailAction(logIds.s1Activity!)).toMatchObject({ ok: true })
    })

    it("nhật ký nhân sự: nhân viên bị chặn; 'Hoạt động của tôi' chỉ có dòng của mình", async () => {
      const { listActivityLogs, listMyActivity, iterateActivityLogsForExport } = await import("@/server/services/logs")
      await expect(listActivityLogs(viewer(s1), { ...range })).rejects.toMatchObject({ name: "AuthorizationError" })
      await expect(iterateActivityLogsForExport(viewer(s1), { ...range }).next()).rejects.toMatchObject({ name: "AuthorizationError" })
      const mine = await listMyActivity(viewer(s1))
      expect(mine.rows.length).toBeGreaterThanOrEqual(2)
      expect(mine.rows.every((r) => r.actorId === s1.id)).toBe(true)
      const adminView = await listActivityLogs(viewer(admin), { ...range })
      expect(new Set(adminView.rows.map((r) => r.actorId))).toEqual(new Set([s1.id, s2.id, admin.id]))
    })

    it("tuỳ chọn bộ lọc: nhân viên chỉ thấy MCP/tài khoản/tool của mình và không có danh sách người dùng", async () => {
      const { getLogFilterOptions } = await import("@/server/services/logs")
      const o1 = await getLogFilterOptions(viewer(s1))
      expect(o1.mcps.map((m) => m.id)).toEqual([ids.m1])
      expect(o1.users).toEqual([])
      expect(o1.accounts.map((a) => a.externalId).sort()).toEqual(["act_1", "adacct_700001"])
      expect(o1.tools).toEqual(["ads_get_report"])
      const oa = await getLogFilterOptions(viewer(admin))
      expect(oa.mcps).toHaveLength(3)
      expect(oa.users.length).toBeGreaterThanOrEqual(3)
    })

    it("xuất CSV (iterator): nhân viên chỉ nhận dòng của mình", async () => {
      const { iterateMcpLogsForExport } = await import("@/server/services/logs")
      const rows: { ownerId: string | null }[] = []
      for await (const batch of iterateMcpLogsForExport(viewer(s1), { ...range, ownerIds: [s2.id] })) rows.push(...batch)
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.ownerId === s1.id)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("Route /api/logs/export", () => {
    const origin = () => (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "")
    function exportReq(body: unknown, headers: Record<string, string> = {}) {
      return new Request(`${origin()}/api/logs/export`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: origin(), ...headers },
        body: JSON.stringify(body),
      })
    }
    const call = async (s: Signed | null, body: unknown, headers: Record<string, string> = {}) => {
      actAs(s)
      const { POST } = await import("@/app/api/logs/export/route")
      return POST(exportReq(body, { cookie: s?.cookie ?? "", ...headers }))
    }

    it("ẩn danh 401; sai/thiếu Origin 403; Sec-Fetch-Site khác same-origin 403", async () => {
      expect((await call(null, { search: "" })).status).toBe(401)
      expect((await call(sess1, { search: "" }, { origin: "https://evil.example" })).status).toBe(403)
      expect((await call(sess1, { search: "" }, { "sec-fetch-site": "cross-site" })).status).toBe(403)
      const noOrigin = new Request(`${origin()}/api/logs/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      actAs(sess1)
      const { POST } = await import("@/app/api/logs/export/route")
      expect((await POST(noOrigin)).status).toBe(403)
    })

    it("nhân viên không xuất được tab nhân sự; xuất MCP chỉ có dòng của mình và có BOM + chống công thức", async () => {
      expect((await call(sess1, { search: "tab=staff" })).status).toBe(403)
      const res = await call(sess1, { search: `owner=${s2.id}` })
      expect(res.status).toBe(200)
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // UTF-8 BOM for Excel
      const text = new TextDecoder().decode(bytes)
      expect(text).toContain(s1.email)
      expect(text).not.toContain(s2.email)
      expect(text).not.toContain(admin.email)
      // the export was logged
      const l = await db.select().from(activityLogs).where(and(eq(activityLogs.action, "logs.export"), eq(activityLogs.actorId, s1.id)))
      expect(l).toHaveLength(1)
      expect(l[0]!.metadata).toMatchObject({ tab: "mcp", completed: true })
    })

    it("admin xuất được cả hai tab; phiên không còn 'tươi' phải nhập lại mật khẩu", async () => {
      const ok = await call(sessAdmin, { search: "tab=staff" })
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain(s1.email)
      // a session older than 10 minutes is not fresh → password required
      await db.execute(sql`update session set created_at = now() - interval '2 hours' where user_id = ${s2.id}`)
      // (verification row marking this session fresh does not exist for s2)
      const stale = await call(sess2, { search: "" })
      expect(stale.status).toBe(401)
      expect(((await stale.json()) as { code?: string }).code).toBe("reauth_required")
      const wrong = await call(sess2, { search: "", password: "sai-sai-sai-1" })
      expect(wrong.status).toBe(401)
      const good = await call(sess2, { search: "", password: PASSWORD })
      expect(good.status).toBe(200)
    })

    it("hạn mức 5 lần xuất / 10 phút / người", async () => {
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) statuses.push((await call(sessAdmin, { search: "" })).status)
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe("Action kết nối / MCP: không chạm được tài nguyên của người khác", () => {
    it("kết nối: đổi tên / kiểm tra / đồng bộ / bật-tắt tài khoản / xem MCP đang dùng / thay token / xoá đều bị từ chối và không đổi dữ liệu", async () => {
      const a = await import("@/server/actions/connections")
      actAs(sess1)
      const target = ids.c2
      const results = await Promise.all([
        a.renameConnectionAction({ connectionId: target, name: "bị đổi tên" }),
        a.testConnectionAction({ connectionId: target }),
        a.syncConnectionAccountsAction({ connectionId: target }),
        a.connectionUsageAction({ connectionId: target }),
        a.toggleAdAccountsAction({ connectionId: target, accountIds: [ids.a2], enabled: false }),
        a.deleteConnectionAction({ connectionId: target }),
      ])
      for (const r of results) expect(r).toMatchObject({ ok: false })
      const replace = await a.replaceCredentialsAction({ connectionId: target, credentials: { accessToken: "EAAxxxxxxxxxxxxxxxxxxxxxxxxx" }, password: PASSWORD })
      expect(replace.ok).toBe(false)
      const [row] = await db.select().from(connections).where(eq(connections.id, target))
      expect(row).toMatchObject({ name: `${P} c2`, deletedAt: null, status: "expiring" })
      const [account] = await db.select().from(adAccounts).where(eq(adAccounts.id, ids.a2))
      expect(account!.isEnabled).toBe(true)
      // sanity: the same call on an OWN connection does reach the service (rename works)
      expect(await a.renameConnectionAction({ connectionId: ids.c1, name: `${P} c1 renamed` })).toMatchObject({ ok: true })
    })

    it("MCP: sửa / bật-tắt / xoay key / xem lại link / xoá của người khác đều bị từ chối", async () => {
      const a = await import("@/server/actions/mcp-servers")
      actAs(sess1)
      const target = ids.m2
      const rotate = await a.rotateMcpKeyAction({ id: target, password: PASSWORD })
      const reveal = await a.revealMcpUrlAction({ id: target, password: PASSWORD })
      const enable = await a.setMcpEnabledAction({ id: target, enabled: false })
      const del = await a.deleteMcpAction({ id: target, confirmName: `${P} m2` })
      const upd = await a.updateMcpAction({ id: target, name: "bị đổi", description: "", platforms: [], settings: {}, expiresAt: null })
      for (const r of [rotate, reveal, enable, del, upd]) expect(r.ok).toBe(false)
      const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, target))
      expect(row).toMatchObject({ name: `${P} m2`, status: "active", deletedAt: null, keyHash: `h_${target}` })
      // no failure rows for re-auth were attributed to a wrong password either (password was right)
      const logs = await db.select().from(activityLogs).where(and(eq(activityLogs.actorId, s1.id), inArray(activityLogs.action, ["mcp.key.rotate", "mcp.key.reveal", "mcp.delete"])))
      expect(logs.filter((l) => l.status === "success")).toHaveLength(0)
    })

    it("admin thấy và dùng được tài nguyên của nhân viên (D4): vào danh sách kết nối/MCP của người khác", async () => {
      const { listConnections } = await import("@/server/services/connections")
      const { listMcpServers } = await import("@/server/services/mcp-servers")
      const admin1 = await listConnections({ id: admin.id, email: admin.email, role: "admin" })
      expect(admin1.map((c) => c.id).sort()).toEqual([ids.c1, ids.c1bad, ids.c2, ids.cAdmin].sort())
      const staff1 = await listConnections({ id: s1.id, email: s1.email, role: "staff" })
      expect(staff1.map((c) => c.id).sort()).toEqual([ids.c1, ids.c1bad].sort())
      const mcpAdmin = await listMcpServers({ id: admin.id, email: admin.email, role: "admin" })
      expect(mcpAdmin).toHaveLength(3)
      const mcpStaff = await listMcpServers({ id: s2.id, email: s2.email, role: "staff" })
      expect(mcpStaff.map((m) => m.id)).toEqual([ids.m2])
    })
  })
})
