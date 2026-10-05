// Append-only guard of the log tables (migration 0005_logs_append_only): UPDATE / DELETE / TRUNCATE are refused
// by a trigger (SQLSTATE 42501) unless the session opts in with ads_mcp.log_mutation = 'allow'.
// Uses its own pg.Client with the GUC explicitly set to "deny" (the test process allows it through PGOPTIONS).
// Every refused statement runs inside a transaction that is rolled back, so a missing trigger can never wipe
// rows of other tests sharing the database.
import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const hasDb = !!process.env.DATABASE_URL

const TABLES = {
  activity_logs: {
    insert: `insert into activity_logs (id, action, actor_email, status) values ($1, 'test.append_only', 'append-only@example.test', 'success')`,
  },
  mcp_call_logs: {
    insert: `insert into mcp_call_logs (id, method, status, mcp_name) values ($1, 'tools/call', 'success', 'append-only-test')`,
  },
} as const
type Table = keyof typeof TABLES

function currentPartition(table: Table): string {
  const now = new Date()
  return `${table}_p${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

describe.skipIf(!hasDb)("log tables are append-only (DB trigger)", () => {
  let c: pg.Client
  const ids: Record<Table, string> = { activity_logs: randomUUID(), mcp_call_logs: randomUUID() }

  /** run `text` in a transaction that is always rolled back; resolves with the SQLSTATE (or null on success) */
  async function errorCodeOf(text: string, params: unknown[] = []): Promise<string | null> {
    await c.query("begin")
    try {
      await c.query("set local lock_timeout = '15s'")
      await c.query(text, params)
      return null
    } catch (e) {
      return (e as { code?: string }).code ?? "unknown"
    } finally {
      await c.query("rollback")
    }
  }

  beforeAll(async () => {
    c = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      options: "-c ads_mcp.log_mutation=deny",
      application_name: "ads-mcp-test-append-only",
    })
    await c.connect()
    await c.query(
      "select app_ensure_monthly_partitions('mcp_call_logs', 1), app_ensure_monthly_partitions('activity_logs', 1)"
    )
  })

  afterAll(async () => {
    if (!c) return
    // the documented opt-in, scoped to one transaction
    await c.query("begin")
    await c.query("set local ads_mcp.log_mutation = 'allow'")
    for (const t of Object.keys(TABLES) as Table[]) await c.query(`delete from ${t} where id = $1`, [ids[t]])
    await c.query("commit")
    await c.end()
  })

  it("the session under test really has the guard on", async () => {
    const r = await c.query<{ v: string | null }>("select current_setting('ads_mcp.log_mutation', true) as v")
    expect(r.rows[0]?.v).toBe("deny")
  })

  it.each(Object.keys(TABLES) as Table[])("%s: INSERT works, UPDATE / DELETE / TRUNCATE are refused (42501)", async (t) => {
    const id = ids[t]
    await c.query(TABLES[t].insert, [id])
    const where = "where id = $1"
    const count = await c.query(`select count(*)::int as n from ${t} ${where}`, [id])
    expect(count.rows[0].n).toBe(1)

    const col = t === "activity_logs" ? "action" : "method"
    expect(await errorCodeOf(`update ${t} set ${col} = 'tampered' ${where}`, [id])).toBe("42501")
    expect(await errorCodeOf(`delete from ${t} ${where}`, [id])).toBe("42501")
    // directly on the monthly partition the row lives in (row trigger cloned to partitions)
    expect(await errorCodeOf(`delete from ${currentPartition(t)} ${where}`, [id])).toBe("42501")
    expect(await errorCodeOf(`truncate ${t}`)).toBe("42501")

    // untouched
    const after = await c.query(`select ${col} as v from ${t} ${where}`, [id])
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0].v).not.toBe("tampered")
  })

  it("the opt-in GUC (transaction-local) allows the cleanup", async () => {
    const id = randomUUID()
    await c.query(TABLES.activity_logs.insert, [id])
    await c.query("begin")
    await c.query("select set_config('ads_mcp.log_mutation', 'allow', true)")
    const del = await c.query("delete from activity_logs where id = $1", [id])
    await c.query("commit")
    expect(del.rowCount).toBe(1)
    // back to "deny" after the transaction
    const r = await c.query<{ v: string | null }>("select current_setting('ads_mcp.log_mutation', true) as v")
    expect(r.rows[0]?.v).toBe("deny")
  })

  it("partitions created later inherit the row trigger", async () => {
    const r = await c.query<{ n: number }>(
      `select count(*)::int as n
         from pg_inherits i
         join pg_class p on p.oid = i.inhparent
        where p.relname in ('activity_logs', 'mcp_call_logs')
          and not exists (
            select 1 from pg_trigger tg
             where tg.tgrelid = i.inhrelid and tg.tgname in ('activity_logs_append_only', 'mcp_call_logs_append_only'))`
    )
    expect(r.rows[0]?.n).toBe(0)
  })
})
