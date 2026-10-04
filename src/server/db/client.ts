// Single pg Pool + Drizzle instance (cached on globalThis for Next dev HMR).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema"

type Db = NodePgDatabase<typeof schema>

const g = globalThis as unknown as { __adsMcpPool?: Pool; __adsMcpDb?: Db }

export function pool(): Pool {
  if (!g.__adsMcpPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error("DATABASE_URL chưa được cấu hình")
    g.__adsMcpPool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      application_name: process.env.APP_PROCESS_NAME ?? "ads-mcp",
    })
  }
  return g.__adsMcpPool
}

export function getDb(): Db {
  g.__adsMcpDb ??= drizzle({ client: pool(), schema, casing: "snake_case" })
  return g.__adsMcpDb
}

/** Lazy proxy so modules can `import { db }` without connecting at import time (next build). */
export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>
    const v = real[prop]
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v
  },
})

export type Database = Db
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export { schema }
