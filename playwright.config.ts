// Playwright E2E. Runs `next dev` on port 3101 against a DEDICATED database (<db>_e2e on the same
// Postgres as .env's DATABASE_URL), dropped + re-created + migrated before every run, so the first-run
// /setup flow starts from an empty user table and never touches dev data.
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { defineConfig, devices } from "@playwright/test"
import pg from "pg"

const root = import.meta.dirname
const require = createRequire(import.meta.url)
const PORT = Number(process.env.E2E_PORT ?? 3101)
const BASE_URL = `http://localhost:${PORT}`

if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"))

function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL
  const base = process.env.DATABASE_URL
  if (!base) throw new Error("DATABASE_URL chưa được cấu hình (.env) — cần để tạo database e2e")
  const u = new URL(base)
  u.pathname = `/${u.pathname.replace(/^\//, "") || "adsmcp"}_e2e`
  return u.toString()
}

const E2E_DATABASE_URL = e2eDatabaseUrl()
// Shared with the test workers through the environment (workers inherit the main process env).
process.env.E2E_DATABASE_URL = E2E_DATABASE_URL
process.env.E2E_SETUP_TOKEN ??= randomBytes(24).toString("base64url")

/** Main process only (the config is re-evaluated inside every worker). */
async function prepareDatabase() {
  const target = new URL(E2E_DATABASE_URL)
  const dbName = decodeURIComponent(target.pathname.slice(1))
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Tên database e2e không hợp lệ: ${dbName}`)
  const admin = new URL(E2E_DATABASE_URL)
  admin.pathname = "/postgres"
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await client.end()
  }
  execFileSync(process.execPath, [require.resolve("tsx/cli"), "scripts/migrate.ts"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  })
}

if (!process.env.TEST_WORKER_INDEX && !process.env.E2E_SKIP_DB_RESET) {
  await prepareDatabase()
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  // `next dev` compiles every route on its first request (webpack mode on nested worktrees: 10-30 s per page), so
  // the first navigation of a cold run needs more than the default 5 s to settle.
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Turbopack cannot resolve `next` when node_modules lives ABOVE the project root (nested git
    // worktrees share the main checkout's node_modules) → fall back to webpack there.
    command: `node "${require.resolve("next/dist/bin/next")}" dev${existsSync(path.join(root, "node_modules", "next")) ? "" : " --webpack"} --port ${PORT}`,
    cwd: root,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: E2E_DATABASE_URL,
      BETTER_AUTH_URL: BASE_URL,
      SETUP_TOKEN: process.env.E2E_SETUP_TOKEN!,
      NEXT_TELEMETRY_DISABLED: "1",
      // /settings/updates checks GitHub by itself on open: point it at a repo that does not exist so the check
      // fails harmlessly (the seeded update_latest row is kept) instead of reading the real releases
      UPDATE_REPO: "schhung1822/ads-mcp-e2e-no-such-repo",
      UPDATE_GITHUB_TOKEN: "",
    },
  },
})
