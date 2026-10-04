// Integration tests against the dev/test Postgres (DATABASE_URL). Rows use a unique prefix and are removed afterwards.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const hasDb = !!process.env.DATABASE_URL

describe.skipIf(!hasDb)("logs service (DB)", async () => {
  const { like } = await import("drizzle-orm")
  const { db, pool } = await import("@/server/db/client")
  const { activityLogs, mcpCallLogs } = await import("@/server/db/schema")
  const svc = await import("./logs")
  const { AuthorizationError } = await import("@/server/auth/session")

  const P = `tld${randomUUID().slice(0, 8)}`
  const admin = { id: `${P}_admin`, role: "admin" as const }
  const staffA = { id: `${P}_staffA`, role: "staff" as const }
  const staffB = { id: `${P}_staffB`, role: "staff" as const }
  const mcpA = randomUUID()
  const mcpB = randomUUID()
  const now = new Date()
  const tie = new Date(now.getTime() - 10 * 60_000) // 7 rows share this exact timestamp
  const range = { since: new Date(now.getTime() - 3_600_000), until: new Date(now.getTime() + 60_000) }
  let firstA: { id: string; createdAt: string } | null = null

  beforeAll(async () => {
    const rows: (typeof mcpCallLogs.$inferInsert)[] = []
    for (let i = 0; i < 7; i++) {
      rows.push({
        createdAt: tie,
        mcpId: mcpA,
        mcpName: `${P} MCP A`,
        ownerId: staffA.id,
        ownerEmail: `${staffA.id}@example.test`,
        method: "tools/call",
        toolName: i % 2 ? "meta_update_budget" : "ads_get_report",
        platform: "meta",
        adAccountId: "act_123",
        actionKind: i % 2 ? "write" : "read",
        status: i === 3 ? "error" : "success",
        errorMessage: i === 3 ? `${P} token hết hạn` : null,
        durationMs: 100 + i,
        request: { args: { secret: "[REDACTED]" } },
        response: { ok: true },
        changes: i % 2 ? [{ object_id: "c1", field: "daily_budget", before: 100, after: 120 }] : null,
      })
    }
    for (let i = 0; i < 3; i++) {
      rows.push({
        createdAt: new Date(now.getTime() - (20 + i) * 60_000),
        mcpId: mcpB,
        mcpName: `${P} MCP B`,
        ownerId: staffB.id,
        method: "tools/call",
        toolName: "openai_ads_list_campaigns",
        platform: "openai_ads",
        actionKind: "read",
        status: "success",
        durationMs: 50,
      })
    }
    await db.insert(mcpCallLogs).values(rows)
    await db.insert(activityLogs).values([
      { actorId: staffA.id, actorEmail: "a@example.test", actorRole: "staff", action: "auth.login.success", createdAt: new Date(now.getTime() - 5 * 60_000) },
      { actorId: staffA.id, actorEmail: "a@example.test", actorRole: "staff", action: "mcp.create", targetType: "mcp", targetId: mcpA, targetLabel: `${P} MCP A`, createdAt: new Date(now.getTime() - 4 * 60_000), metadata: { after: { name: "x" } } },
      { actorId: staffB.id, actorEmail: "b@example.test", actorRole: "staff", action: "connection.create", createdAt: new Date(now.getTime() - 3 * 60_000) },
    ])
  })

  afterAll(async () => {
    await db.delete(mcpCallLogs).where(like(mcpCallLogs.ownerId, `${P}%`))
    await db.delete(activityLogs).where(like(activityLogs.actorId, `${P}%`))
    await pool().end()
    ;(globalThis as Record<string, unknown>).__adsMcpPool = undefined
    ;(globalThis as Record<string, unknown>).__adsMcpDb = undefined
  })

  it("staff chỉ thấy nhật ký MCP của mình", async () => {
    const a = await svc.listMcpLogs(staffA, { ...range, mcpIds: [mcpA, mcpB] })
    expect(a.rows).toHaveLength(7)
    expect(a.rows.every((r) => r.ownerId === staffA.id)).toBe(true)
    // ownerIds from the client is ignored for staff
    const spoof = await svc.listMcpLogs(staffA, { ...range, mcpIds: [mcpB], ownerIds: [staffB.id] })
    expect(spoof.rows).toHaveLength(0)
    const b = await svc.listMcpLogs(staffB, { ...range, mcpIds: [mcpA, mcpB] })
    expect(b.rows).toHaveLength(3)
    const all = await svc.listMcpLogs(admin, { ...range, mcpIds: [mcpA, mcpB] })
    expect(all.rows).toHaveLength(10)
    firstA = a.rows[0]
  })

  it("danh sách không chứa request/response/changes", async () => {
    const a = await svc.listMcpLogs(staffA, { ...range, mcpIds: [mcpA] }, null, 1)
    expect(a.rows[0]).not.toHaveProperty("request")
    expect(a.rows[0]).not.toHaveProperty("response")
    expect(a.rows[0]).not.toHaveProperty("changes")
    expect(a.rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })

  it("staff không đọc được chi tiết nhật ký của người khác", async () => {
    expect(firstA).not.toBeNull()
    const own = await svc.getMcpLog(staffA, firstA!.id, firstA!.createdAt)
    expect(own?.request).toEqual({ args: { secret: "[REDACTED]" } })
    expect(await svc.getMcpLog(staffB, firstA!.id, firstA!.createdAt)).toBeNull()
    expect(await svc.getMcpLog(admin, firstA!.id, firstA!.createdAt)).not.toBeNull()
    expect(await svc.getMcpLog(admin, firstA!.id, "not-a-time")).toBeNull()
  })

  it("phân trang keyset ổn định khi nhiều dòng trùng thời điểm", async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof svc.listMcpLogs>> = await svc.listMcpLogs(
        admin,
        { ...range, mcpIds: [mcpA, mcpB] },
        cursor,
        3
      )
      seen.push(...page.rows.map((r) => `${r.createdAt}|${r.id}`))
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(4)
    expect(new Set(seen).size).toBe(10)
    const sorted = [...seen].sort().reverse()
    expect(seen).toEqual(sorted)
  })

  it("lọc theo trạng thái, thao tác ghi và nội dung lỗi", async () => {
    const writes = await svc.listMcpLogs(admin, { ...range, mcpIds: [mcpA], writesOnly: true })
    expect(writes.rows).toHaveLength(3)
    const errors = await svc.listMcpLogs(admin, { ...range, mcpIds: [mcpA], statuses: ["error"] })
    expect(errors.rows).toHaveLength(1)
    const q = await svc.listMcpLogs(admin, { ...range, q: `${P} token` })
    expect(q.rows).toHaveLength(1)
    const pct = await svc.listMcpLogs(admin, { ...range, mcpIds: [mcpA], q: "%" })
    expect(pct.rows).toHaveLength(0)
  })

  it("bắt buộc có khoảng thời gian hợp lệ", async () => {
    await expect(svc.listMcpLogs(admin, {} as never)).rejects.toThrow(RangeError)
    await expect(
      svc.listMcpLogs(admin, { since: new Date("2020-01-01"), until: new Date("2026-01-01") })
    ).rejects.toThrow(RangeError)
    await expect(svc.listMcpLogs(admin, { since: now, until: now })).rejects.toThrow(RangeError)
  })

  it("cursor giả mạo trả về trang rỗng", async () => {
    const r = await svc.listMcpLogs(admin, range, "bm90LWEtY3Vyc29y")
    expect(r).toEqual({ rows: [], nextCursor: null })
  })

  it("staff không xem được nhật ký nhân sự", async () => {
    await expect(svc.listActivityLogs(staffA, range)).rejects.toBeInstanceOf(AuthorizationError)
    const it = svc.iterateActivityLogsForExport(staffA, range)
    await expect(it.next()).rejects.toBeInstanceOf(AuthorizationError)
  })

  it("admin lọc nhật ký nhân sự theo người và nhóm hành động", async () => {
    const all = await svc.listActivityLogs(admin, { ...range, actorIds: [staffA.id, staffB.id] })
    expect(all.rows).toHaveLength(3)
    expect(all.rows[0]).not.toHaveProperty("metadata")
    const mcp = await svc.listActivityLogs(admin, { ...range, actorIds: [staffA.id], groups: ["mcp"] })
    expect(mcp.rows.map((r) => r.action)).toEqual(["mcp.create"])
    const detail = await svc.getActivityLog(admin, mcp.rows[0].id, mcp.rows[0].createdAt)
    expect(detail?.metadata).toEqual({ after: { name: "x" } })
    // staff can read their own activity row (account page) but not someone else's
    expect(await svc.getActivityLog(staffA, mcp.rows[0].id, mcp.rows[0].createdAt)).not.toBeNull()
    expect(await svc.getActivityLog(staffB, mcp.rows[0].id, mcp.rows[0].createdAt)).toBeNull()
  })

  it("listMyActivity chỉ trả hoạt động của chính người dùng", async () => {
    const mine = await svc.listMyActivity(staffA, { limit: 1 })
    expect(mine.rows).toHaveLength(1)
    expect(mine.rows[0].action).toBe("mcp.create")
    const next = await svc.listMyActivity(staffA, { limit: 1, cursor: mine.nextCursor })
    expect(next.rows.map((r) => r.action)).toEqual(["auth.login.success"])
    expect(next.nextCursor).toBeNull()
  })

  it("xuất CSV theo lô, có giới hạn số dòng", async () => {
    let total = 0
    let batches = 0
    for await (const b of svc.iterateMcpLogsForExport(admin, { ...range, mcpIds: [mcpA, mcpB] }, 5, 2)) {
      total += b.length
      batches++
    }
    expect(total).toBe(5)
    expect(batches).toBe(3)
  })

  it("thông tin dung lượng bảng log", async () => {
    const info = await svc.getLogStorageInfo()
    expect(info.tables.map((t) => t.table)).toEqual(["mcp_call_logs", "activity_logs"])
    expect(info.tables[0].partitions.some((p) => p.name === "mcp_call_logs_default")).toBe(true)
  })
})

describe("CSV helpers", async () => {
  const { csvEscape, csvLine, CSV_BOM, decodeLogCursor, encodeLogCursor, escapeLike } = await import("./logs")

  it("escape dấu phẩy, ngoặc kép, xuống dòng", () => {
    expect(csvEscape('a,"b"')).toBe('"a,""b"""')
    expect(csvEscape("dòng 1\ndòng 2")).toBe('"dòng 1\ndòng 2"')
    expect(csvEscape(null)).toBe("")
    expect(csvEscape(["x", "y"])).toBe("x y")
    expect(csvLine(["Thời gian", 12, null])).toBe("Thời gian,12,\r\n")
  })

  it("chặn công thức Excel (CSV injection)", () => {
    expect(csvEscape("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)")
    expect(csvEscape("+1")).toBe("'+1")
    expect(csvEscape("@cmd")).toBe("'@cmd")
  })

  it("có BOM UTF-8 cho Excel", () => {
    expect(CSV_BOM).toBe("﻿")
    expect(Buffer.from(CSV_BOM, "utf8")).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  it("cursor mã hoá/giải mã và từ chối dữ liệu lạ", () => {
    const id = randomUUID()
    const c = encodeLogCursor("2026-10-02T01:02:03.123456Z", id)
    expect(decodeLogCursor(c)).toEqual({ ts: "2026-10-02T01:02:03.123456Z", id })
    expect(decodeLogCursor(encodeLogCursor("'; drop table x;--", id))).toBeNull()
    expect(decodeLogCursor("%%%")).toBeNull()
    expect(escapeLike("50%_\\")).toBe("50\\%\\_\\\\")
  })
})
