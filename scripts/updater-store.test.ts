// SQL of the updater against a REAL Postgres (throw-away database next to DATABASE_URL, like cli.integration.test.ts).
// The temp database is migrated with the app migrations, so system_update_requests comes from drizzle/0002+.
// Skipped when DATABASE_URL is not set.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const tmp = await (async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  const { createTempDb } = await import("../src/server/__tests__/people/temp-db")
  return createTempDb("updater")
})()

import pg from "pg"

import { createPgStore, type Store } from "./updater-store"

const hasDb = !!tmp
const describeDb = hasDb ? describe : describe.skip

describeDb("updater store (real Postgres)", () => {
  let pool: pg.Pool
  let store: Store
  const USER_ID = "updater-test-user"

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: tmp!.url, max: 6 })
    await pool.query(`INSERT INTO "user" (id, name, email, role) VALUES ($1, 'Admin Test', 'admin-updater@example.test', 'admin')`, [USER_ID])
    store = createPgStore(pool)
  }, 60_000)
  afterAll(async () => {
    await pool?.end()
    await tmp?.drop()
  }, 60_000)
  beforeEach(async () => {
    await pool.query("DELETE FROM system_update_requests")
    await pool.query("DELETE FROM activity_logs")
  })

  const insertRequest = async (status = "pending", extra = "") => {
    const { rows } = await pool.query(
      `INSERT INTO system_update_requests (from_version, target_version, status, requested_by ${extra ? ", started_at" : ""})
       VALUES ('1.1.0', '1.2.0', $1, $2 ${extra ? `, ${extra}` : ""}) RETURNING id`,
      [status, USER_ID]
    )
    return rows[0].id as string
  }

  it("claimNext: returns null when empty, claims the pending row once, never twice", async () => {
    expect(await store.claimNext()).toBeNull()
    const id = await insertRequest()
    const req = await store.claimNext()
    expect(req).toEqual({ id, fromVersion: "1.1.0", targetVersion: "1.2.0", requestedBy: USER_ID })
    expect(await store.claimNext()).toBeNull()
    const { rows } = await pool.query("SELECT status, started_at, message FROM system_update_requests WHERE id = $1", [id])
    expect(rows[0].status).toBe("running")
    expect(rows[0].started_at).toBeInstanceOf(Date)
    expect(rows[0].message).toBeTruthy()
  })

  it("claimNext never starts a pending request older than 10 minutes; failStalePending fails it (with an activity row) and frees the slot", async () => {
    const { rows } = await pool.query(
      `INSERT INTO system_update_requests (from_version, target_version, requested_by, created_at)
       VALUES ('1.1.0', '1.2.0', $1, now() - interval '3 days') RETURNING id`,
      [USER_ID]
    )
    const oldId = rows[0].id as string
    expect(await store.claimNext()).toBeNull() // too old to start, even if nobody swept it yet
    expect((await pool.query("SELECT status FROM system_update_requests WHERE id = $1", [oldId])).rows[0].status).toBe("pending")

    expect(await store.failStalePending(10, "Yêu cầu quá cũ")).toBe(1)
    const r = (await pool.query("SELECT status, message, finished_at FROM system_update_requests WHERE id = $1", [oldId])).rows[0]
    expect(r).toMatchObject({ status: "failed", message: "Yêu cầu quá cũ" })
    expect(r.finished_at).toBeInstanceOf(Date)
    const logs = (await pool.query("SELECT action, status, metadata FROM activity_logs")).rows
    expect(logs).toEqual([{ action: "system.update_failed", status: "failure", metadata: { from: "1.1.0", to: "1.2.0", reason: "stale_pending" } }])

    // the slot is free again and a fresh request is claimed normally
    const fresh = await insertRequest()
    expect(await store.failStalePending(10, "x")).toBe(0)
    expect((await store.claimNext())?.id).toBe(fresh)
  })

  it("claimNext: concurrent claimers get the row exactly once (FOR UPDATE SKIP LOCKED)", async () => {
    await insertRequest()
    const results = await Promise.all(Array.from({ length: 6 }, () => createPgStore(pool).claimNext()))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("claimNext: a pending row locked by another transaction is skipped, not waited for", async () => {
    const id = await insertRequest()
    const holder = await pool.connect()
    try {
      await holder.query("BEGIN")
      await holder.query("SELECT id FROM system_update_requests WHERE id = $1 FOR UPDATE", [id])
      const t0 = Date.now()
      expect(await store.claimNext()).toBeNull()
      expect(Date.now() - t0).toBeLessThan(2000)
    } finally {
      await holder.query("ROLLBACK")
      holder.release()
    }
    expect(await store.claimNext()).not.toBeNull()
  })

  it("contract: at most one pending/running row at a time", async () => {
    await insertRequest()
    await expect(insertRequest()).rejects.toThrow(/system_update_requests_open_uq/)
  })

  it("progress updates step/message/log of the running row only", async () => {
    const id = await insertRequest()
    const req = (await store.claimNext())!
    await store.progress(req.id, { step: "backup", message: "Đang sao lưu", log: "line 1" })
    await store.progress(req.id, { log: "line 1\nline 2" }) // keeps step + message
    const { rows } = await pool.query("SELECT step, message, log FROM system_update_requests WHERE id = $1", [id])
    expect(rows[0]).toEqual({ step: "backup", message: "Đang sao lưu", log: "line 1\nline 2" })
    await store.finish(req, { status: "succeeded", step: "healthcheck", message: "ok", log: "end", metadata: {} })
    await store.progress(req.id, { message: "late write must be ignored" })
    const after = await pool.query("SELECT message FROM system_update_requests WHERE id = $1", [id])
    expect(after.rows[0].message).toBe("ok")
  })

  it("finish: status + finished_at + activity_logs row in one transaction (actor resolved from the user table)", async () => {
    await insertRequest()
    const req = (await store.claimNext())!
    const saved = await store.finish(req, {
      status: "succeeded",
      step: "healthcheck",
      message: "Đã cập nhật lên v1.2.0 thành công.",
      log: "done",
      metadata: { from: "1.1.0", to: "1.2.0", durationMs: 4321 },
    })
    expect(saved).toBe(true)
    const r = (await pool.query("SELECT status, step, finished_at, log FROM system_update_requests WHERE id = $1", [req.id])).rows[0]
    expect(r).toMatchObject({ status: "succeeded", step: "healthcheck", log: "done" })
    expect(r.finished_at).toBeInstanceOf(Date)
    const { rows } = await pool.query("SELECT * FROM activity_logs")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_id: USER_ID,
      actor_email: "admin-updater@example.test",
      actor_role: "admin",
      action: "system.update_succeeded",
      target_type: "system_update",
      target_id: req.id,
      status: "success",
    })
    expect(rows[0].metadata).toEqual({ from: "1.1.0", to: "1.2.0", durationMs: 4321 })
  })

  it("finish: failed / rolled_back map to their actions with status failure", async () => {
    for (const [status, action] of [["failed", "system.update_failed"], ["rolled_back", "system.update_rolled_back"]] as const) {
      await pool.query("DELETE FROM system_update_requests")
      await pool.query("DELETE FROM activity_logs")
      await insertRequest()
      const req = (await store.claimNext())!
      expect(await store.finish(req, { status, step: "migrate", message: "x", log: "y", metadata: { from: "1.1.0", to: "1.2.0" } })).toBe(true)
      const { rows } = await pool.query("SELECT action, status FROM activity_logs")
      expect(rows).toEqual([{ action, status: "failure" }])
    }
  })

  it("finish: writes nothing (no activity row) when the request is no longer running", async () => {
    await insertRequest()
    const req = (await store.claimNext())!
    await pool.query("UPDATE system_update_requests SET status = 'failed' WHERE id = $1", [req.id])
    expect(await store.finish(req, { status: "succeeded", step: null, message: "x", log: "", metadata: {} })).toBe(false)
    expect((await pool.query("SELECT 1 FROM activity_logs")).rowCount).toBe(0)
  })

  it("finish: an unknown requester (deleted user) still gets a log row with a system actor", async () => {
    await insertRequest()
    const req = (await store.claimNext())!
    await store.finish({ ...req, requestedBy: null }, { status: "failed", step: "pull", message: "x", log: "", metadata: {} })
    const { rows } = await pool.query("SELECT actor_id, actor_email, actor_role FROM activity_logs")
    expect(rows).toEqual([{ actor_id: null, actor_email: null, actor_role: "system" }])
  })

  it("failStaleRunning: only rows older than the limit (or all with 0) are failed, each with an activity row", async () => {
    const id = await insertRequest("running", "now() - interval '45 minutes'")
    expect(await store.failStaleRunning(30, "treo")).toBe(1)
    const { rows } = await pool.query("SELECT status, message, finished_at FROM system_update_requests WHERE id = $1", [id])
    expect(rows[0]).toMatchObject({ status: "failed", message: "treo" })
    expect(rows[0].finished_at).toBeInstanceOf(Date)
    expect((await pool.query("SELECT action FROM activity_logs")).rows).toEqual([{ action: "system.update_failed" }])

    const fresh = await insertRequest("running", "now() - interval '5 minutes'")
    expect(await store.failStaleRunning(30, "treo")).toBe(0)
    expect((await pool.query("SELECT status FROM system_update_requests WHERE id = $1", [fresh])).rows[0].status).toBe("running")
    expect(await store.failStaleRunning(0, "khởi động lại")).toBe(1)
  })

  it("heartbeat upserts app_settings.updater_heartbeat", async () => {
    await store.heartbeat({ at: new Date("2026-10-03T00:00:00Z"), version: "1.1.0", composeProject: "ads-mcp" })
    await store.heartbeat({ at: new Date("2026-10-03T00:00:30Z"), version: "1.1.0", composeProject: "ads-mcp" })
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'updater_heartbeat'")
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toEqual({ at: "2026-10-03T00:00:30.000Z", version: "1.1.0", composeProject: "ads-mcp" })
  })
})
