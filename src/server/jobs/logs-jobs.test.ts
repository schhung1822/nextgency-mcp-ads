// Integration tests for the log maintenance jobs against the dev/test Postgres (DATABASE_URL).
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"

const hasDb = !!process.env.DATABASE_URL

describe.skipIf(!hasDb)("log jobs (DB)", async () => {
  const { eq, like, sql } = await import("drizzle-orm")
  const { db, pool } = await import("@/server/db/client")
  const { mcpCallLogs, mcpCallStatsHourly, mcpPendingActions, mcpServers, user } = await import("@/server/db/schema")
  const { runLogsMaintenance, logsMaintainJob } = await import("./logs-maintain")
  const { runLogsRollup, logsRollupJob } = await import("./logs-rollup")
  const { runPendingActionsCleanup, pendingActionsCleanupJob } = await import("./pending-cleanup")

  const P = `tlj${randomUUID().slice(0, 8)}`
  const FAKE = [
    ["mcp_call_logs", "mcp_call_logs_p202501", "2025-01-01", "2025-02-01"],
    ["mcp_call_logs", "mcp_call_logs_p202502", "2025-02-01", "2025-03-01"],
    ["activity_logs", "activity_logs_p202501", "2025-01-01", "2025-02-01"],
  ] as const

  async function partitionsOf(parent: string): Promise<string[]> {
    const r = await db.execute<{ name: string }>(sql`
      select c.relname as name from pg_inherits i
        join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
       where p.relname = ${parent} and c.relkind in ('r','p') order by 1`)
    return r.rows.map((x) => x.name)
  }

  afterAll(async () => {
    for (const [, name] of FAKE) await db.execute(sql.raw(`drop table if exists "${name}"`))
    await db.delete(mcpCallLogs).where(like(mcpCallLogs.ownerId, `${P}%`))
    await db.delete(mcpCallStatsHourly).where(like(mcpCallStatsHourly.ownerId, `${P}%`))
    await db.delete(mcpServers).where(like(mcpServers.name, `${P}%`))
    await db.delete(user).where(like(user.id, `${P}%`))
    await pool().end()
    ;(globalThis as Record<string, unknown>).__adsMcpPool = undefined
    ;(globalThis as Record<string, unknown>).__adsMcpDb = undefined
  })

  it("job objects có tên, cron, múi giờ và đã đăng ký trong JOBS", async () => {
    expect(logsMaintainJob).toMatchObject({ name: "logs.maintain", cron: "15 3 * * *" })
    expect(logsRollupJob).toMatchObject({ name: "logs.rollup", cron: "*/5 * * * *" })
    expect(pendingActionsCleanupJob).toMatchObject({ name: "pending_actions.cleanup", cron: "7 * * * *" })
    const { JOBS, jobTimezone } = await import("./index")
    for (const j of [logsMaintainJob, logsRollupJob, pendingActionsCleanupJob]) {
      expect(JOBS).toContain(j)
      expect(jobTimezone(j)).toBe(process.env.APP_TIMEZONE ?? "Asia/Ho_Chi_Minh")
      expect(typeof j.handler).toBe("function")
    }
  })

  it("logs.maintain xoá partition quá hạn và tạo partition tháng tới", async () => {
    for (const [parent, name, from, to] of FAKE) {
      await db.execute(
        sql.raw(
          `create table if not exists "${name}" partition of "${parent}" for values from ('${from} 00:00:00+00') to ('${to} 00:00:00+00')`
        )
      )
    }
    expect(await partitionsOf("mcp_call_logs")).toContain("mcp_call_logs_p202501")

    const res = await runLogsMaintenance({ retention: { mcp: 3, staff: 3 } })
    expect(res.errors).toEqual([])
    expect(res.retention).toEqual({ mcp: 3, staff: 3 })
    expect(res.dropped.mcp_call_logs).toBeGreaterThanOrEqual(2)
    expect(res.dropped.activity_logs).toBeGreaterThanOrEqual(1)

    const mcpParts = await partitionsOf("mcp_call_logs")
    const actParts = await partitionsOf("activity_logs")
    expect(mcpParts).not.toContain("mcp_call_logs_p202501")
    expect(mcpParts).not.toContain("mcp_call_logs_p202502")
    expect(actParts).not.toContain("activity_logs_p202501")
    // current month + 3 ahead always exist; default partition is kept
    const d = new Date()
    for (let i = 0; i <= 3; i++) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1))
      const suffix = `${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}`
      expect(mcpParts).toContain(`mcp_call_logs_p${suffix}`)
      expect(actParts).toContain(`activity_logs_p${suffix}`)
    }
    expect(mcpParts).toContain("mcp_call_logs_default")
  })

  it("logs.maintain giữ N tháng trọn + tháng hiện tại", async () => {
    // the partition exactly N months back must survive keep=N
    const d = new Date()
    const back = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1))
    const next = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 1))
    const suffix = `${back.getUTCFullYear()}${String(back.getUTCMonth() + 1).padStart(2, "0")}`
    const name = `activity_logs_p${suffix}`
    const existed = (await partitionsOf("activity_logs")).includes(name)
    if (!existed) {
      await db.execute(
        sql.raw(
          `create table "${name}" partition of activity_logs for values from ('${back.toISOString()}') to ('${next.toISOString()}')`
        )
      )
    }
    try {
      await runLogsMaintenance({ retention: { mcp: 3, staff: 3 } })
      expect(await partitionsOf("activity_logs")).toContain(name)
    } finally {
      if (!existed) await db.execute(sql.raw(`drop table if exists "${name}"`))
    }
  })

  it("logs.rollup gộp đúng theo giờ/MCP/nền tảng/tool và chạy lại không nhân đôi", async () => {
    const mcpId = randomUUID()
    const owner = `${P}_owner`
    const now = new Date()
    const hour = Math.floor(now.getTime() / 3_600_000) * 3_600_000
    const at = (h: number, s: number) => new Date(hour - h * 3_600_000 + s * 1000)
    const base = { mcpId, ownerId: owner, method: "tools/call" }
    await db.insert(mcpCallLogs).values([
      { ...base, createdAt: at(0, 1), platform: "meta", toolName: "meta_update_budget", actionKind: "write", status: "success", durationMs: 100 },
      { ...base, createdAt: at(0, 2), platform: "meta", toolName: "meta_update_budget", actionKind: "write", status: "error", durationMs: 50 },
      { ...base, createdAt: at(0, 3), platform: "meta", toolName: "meta_update_budget", actionKind: "write", status: "pending_confirmation", durationMs: 10 },
      { ...base, createdAt: at(1, 5), platform: "meta", toolName: "meta_update_budget", actionKind: "read", status: "denied", durationMs: 5 },
      { ...base, createdAt: at(1, 6), platform: "openai_ads", toolName: "openai_ads_list_campaigns", actionKind: "read", status: "success", durationMs: 7 },
      { ...base, createdAt: at(1, 7), method: "tools/list", actionKind: "protocol", status: "success", durationMs: 1 },
      // outside the 2h window → ignored
      { ...base, createdAt: at(5, 1), platform: "meta", toolName: "meta_update_budget", actionKind: "read", status: "success", durationMs: 1 },
    ])

    const read = async () =>
      (
        await db
          .select()
          .from(mcpCallStatsHourly)
          .where(eq(mcpCallStatsHourly.mcpId, mcpId))
      )
        .map((r) => ({
          h: (hour - r.bucket.getTime()) / 3_600_000,
          platform: r.platform,
          tool: r.toolName,
          calls: r.calls,
          errors: r.errors,
          writes: r.writes,
          ms: r.durationMsSum,
          owner: r.ownerId,
        }))
        .sort((a, b) => a.h - b.h || a.platform.localeCompare(b.platform) || a.tool.localeCompare(b.tool))

    await runLogsRollup({ now })
    const first = await read()
    expect(first).toEqual([
      { h: 0, platform: "meta", tool: "meta_update_budget", calls: 3, errors: 1, writes: 3, ms: 160, owner },
      { h: 1, platform: "", tool: "", calls: 1, errors: 0, writes: 0, ms: 1, owner },
      { h: 1, platform: "meta", tool: "meta_update_budget", calls: 1, errors: 1, writes: 0, ms: 5, owner },
      { h: 1, platform: "openai_ads", tool: "openai_ads_list_campaigns", calls: 1, errors: 0, writes: 0, ms: 7, owner },
    ])

    // idempotent: buckets are recomputed, not incremented
    await runLogsRollup({ now })
    expect(await read()).toEqual(first)

    // a late row in the window is picked up on the next run
    await db.insert(mcpCallLogs).values({ ...base, createdAt: at(0, 9), platform: "meta", toolName: "meta_update_budget", actionKind: "write", status: "success", durationMs: 40 })
    await runLogsRollup({ now })
    expect((await read())[0]).toMatchObject({ calls: 4, writes: 4, ms: 200 })
  })

  it("pending_actions.cleanup đánh dấu hết hạn và xoá bản cũ hơn 7 ngày", async () => {
    const uid = `${P}_u`
    await db.insert(user).values({ id: uid, name: "Test", email: `${uid}@example.test` })
    const [mcp] = await db
      .insert(mcpServers)
      .values({ ownerId: uid, name: `${P} mcp`, keyHash: `${P}-hash`, keyPrefix: "amcp_test", keyEncrypted: "x" })
      .returning({ id: mcpServers.id })
    const now = new Date()
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000)
    const row = (tag: string, status: string, expiresAt: Date, consumedAt: Date | null = null) => ({
      tokenHash: `${P}-${tag}`,
      mcpId: mcp.id,
      toolName: "meta_update_budget",
      argsHash: "h",
      args: {},
      preview: {},
      status,
      expiresAt,
      consumedAt,
    })
    await db.insert(mcpPendingActions).values([
      row("pending-expired", "pending", ago(1)),
      row("pending-live", "pending", new Date(now.getTime() + 600_000)),
      row("consumed-old", "consumed", ago(9 * 24), ago(8 * 24)),
      row("expired-old", "expired", ago(10 * 24)),
      row("consumed-recent", "consumed", ago(2 * 24), ago(2 * 24)),
    ])

    const res = await runPendingActionsCleanup(now)
    expect(res.expired).toBeGreaterThanOrEqual(1)
    expect(res.deleted).toBeGreaterThanOrEqual(2)

    const left = await db
      .select({ tag: mcpPendingActions.tokenHash, status: mcpPendingActions.status })
      .from(mcpPendingActions)
      .where(eq(mcpPendingActions.mcpId, mcp.id))
    const byTag = Object.fromEntries(left.map((r) => [r.tag.replace(`${P}-`, ""), r.status]))
    expect(byTag).toEqual({
      "pending-expired": "expired",
      "pending-live": "pending",
      "consumed-recent": "consumed",
    })
  })
})
