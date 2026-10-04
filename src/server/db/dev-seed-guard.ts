// Guard for DEV-ONLY seed scripts (scripts/dev-seed-logs.ts, src/server/mcp/__dev__/seed.ts): they create
// users with known passwords, fake connections and MCP keys - never against a real database.
// Runs only when ALL hold: NODE_ENV ≠ production, ALLOW_DEV_SEED=1, DATABASE_URL host is loopback, and
// every existing user has an @example.test email. Framework-free.
import { sql } from "drizzle-orm"

import { db } from "./client"
import { user } from "./schema"

export const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
export const DEV_SEED_EMAIL_DOMAIN = "@example.test"

/** Why the seed must not run (Vietnamese, for the console), or null when the environment allows it. */
export function devSeedRefusal(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === "production") return "không chạy khi NODE_ENV=production."
  if (env.ALLOW_DEV_SEED !== "1") return "cần đặt ALLOW_DEV_SEED=1 để xác nhận đây là database dev."
  const raw = env.DATABASE_URL
  if (!raw) return "thiếu DATABASE_URL."
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return "DATABASE_URL không hợp lệ."
  }
  if (!LOCAL_DB_HOSTS.has(host)) return `DATABASE_URL trỏ tới "${host}" - chỉ chạy với localhost / 127.0.0.1 / ::1.`
  return null
}

/** Throws when the seed must not run (environment, or the DB holds non-test users). */
export async function assertDevSeedAllowed(env: Record<string, string | undefined> = process.env): Promise<void> {
  const why = devSeedRefusal(env)
  if (why) throw new Error(`Dev seed bị từ chối: ${why}`)
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(sql`lower(${user.email}) not like ${`%${DEV_SEED_EMAIL_DOMAIN}`}`)
  if (Number(row?.n ?? 0) > 0) {
    throw new Error(
      `Dev seed bị từ chối: database có người dùng ngoài ${DEV_SEED_EMAIL_DOMAIN} (có vẻ không phải database dev).`
    )
  }
}
