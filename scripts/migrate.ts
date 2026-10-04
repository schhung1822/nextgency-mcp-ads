// Run DB migrations at container start (bundled to dist/migrate.mjs) or in dev (`pnpm db:migrate`).
// Advisory lock prevents concurrent runs; afterwards make sure log partitions exist.
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

const LOCK_ID = 7272701

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL chưa được cấu hình")
  const pool = new Pool({ connectionString, max: 1, application_name: "ads-mcp-migrate" })
  const client = await pool.connect()
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID])
    console.log("[migrate] running migrations…")
    await migrate(drizzle({ client }), { migrationsFolder: process.env.MIGRATIONS_DIR ?? "./drizzle" })
    await client.query(
      "select app_ensure_monthly_partitions('mcp_call_logs', 3), app_ensure_monthly_partitions('activity_logs', 3)"
    )
    console.log("[migrate] done")
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {})
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error("[migrate] failed:", e instanceof Error ? e.message : e)
  process.exit(1)
})
