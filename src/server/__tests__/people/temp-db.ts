// Throw-away Postgres database per test file (people integration tests).
//
// Why: these tests change GLOBAL state (app_settings 2FA policy, user table emptiness for /setup, last-admin
// rules, sessions) and run in parallel with the rest of the suite - a private database per file makes them
// deterministic and leaves the dev data untouched. The database is created from DATABASE_URL (same server,
// `adsmcp_pa_<label>_<random>`), migrated with the project migrations, and dropped afterwards.
//
// No app imports here: it must be usable inside `vi.hoisted()` BEFORE any module reads DATABASE_URL.
import { randomBytes } from "node:crypto"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"

export interface TempDb {
  name: string
  url: string
  drop: () => Promise<void>
}

function withDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

/** Creates + migrates a fresh database next to DATABASE_URL's. Returns null when DATABASE_URL is not set. */
export async function createTempDb(label: string): Promise<TempDb | null> {
  const base = process.env.DATABASE_URL
  if (!base) return null
  const name = `adsmcp_pa_${label}_${randomBytes(4).toString("hex")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_")
  const admin = withDatabase(base, "postgres")
  const drop = async () => {
    const c = new pg.Client({ connectionString: admin })
    await c.connect()
    try {
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    } finally {
      await c.end()
    }
  }
  const c = new pg.Client({ connectionString: admin })
  await c.connect()
  try {
    await c.query(`CREATE DATABASE "${name}"`)
  } finally {
    await c.end()
  }
  const url = withDatabase(base, name)
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" })
    await pool.query(
      "select app_ensure_monthly_partitions('mcp_call_logs', 3), app_ensure_monthly_partitions('activity_logs', 3)"
    )
  } catch (e) {
    await pool.end().catch(() => {})
    await drop().catch(() => {})
    throw e
  }
  await pool.end()
  return { name, url, drop }
}
