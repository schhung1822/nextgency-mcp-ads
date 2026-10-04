// Updater daemon (bundled to dist/updater.mjs, runs in the `updater` compose service).
// No inbound connections: polls system_update_requests every 5 s, writes a heartbeat to app_settings every 30 s,
// and executes ONE request at a time with `docker compose` against the host Docker daemon (docker.sock).
// The web container never gets docker.sock - this process is the only docker-capable component.
// Design: .claude/docs/10-update-system.md · Ops: .claude/docs/07-deployment.md §6
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { posix as path } from "node:path"

import { Pool } from "pg"

import { DEFAULT_IMAGE, STALE_PENDING_MINUTES, STALE_RUNNING_MINUTES, collectSecretValues, isValidImageName, makeRedactor, writeFileAtomicKeepMode } from "./updater-core"
import { spawnExec } from "./updater-exec"
import { recreateUpdater, runUpdate, type RunDeps, type RunFiles, type UpdaterConfig } from "./updater-run"
import { createPgStore, type Store } from "./updater-store"

const POLL_MS = 5_000
const HEARTBEAT_MS = 30_000
const DOCKER_SOCK = "/var/run/docker.sock"

let redact = makeRedactor()

function log(msg: string) {
  console.log(`[updater] ${redact(msg)}`)
}

function loadConfig(): { cfg: UpdaterConfig; connectionString: string } {
  const e = process.env
  const dir = (e.HOST_PROJECT_DIR ?? "").replace(/\/+$/, "")
  if (!/^\/[A-Za-z0-9._/-]+$/.test(dir) || dir.split("/").includes("..")) {
    throw new Error("HOST_PROJECT_DIR phải là đường dẫn tuyệt đối của thư mục dự án trên máy chủ (vd /opt/ads-mcp), không chứa khoảng trắng")
  }
  const image = (e.APP_IMAGE ?? DEFAULT_IMAGE).trim()
  if (!isValidImageName(image)) throw new Error("APP_IMAGE không hợp lệ (cần dạng ghcr.io/org/ten-image, không kèm tag)")
  const ident = /^[a-z_][a-z0-9_]{0,62}$/
  const dbService = e.UPDATER_DB_SERVICE ?? "db"
  const pgUser = e.UPDATER_PG_USER ?? "adsmcp"
  const pgDb = e.UPDATER_PG_DB ?? "adsmcp"
  for (const v of [dbService, pgUser, pgDb]) if (!ident.test(v)) throw new Error("UPDATER_DB_SERVICE / UPDATER_PG_USER / UPDATER_PG_DB không hợp lệ")
  const composeProject = e.COMPOSE_PROJECT_NAME && /^[a-z0-9][a-z0-9_-]*$/.test(e.COMPOSE_PROJECT_NAME) ? e.COMPOSE_PROJECT_NAME : "ads-mcp"

  let connectionString = e.DATABASE_URL
  if (!connectionString) {
    if (!e.POSTGRES_PASSWORD) throw new Error("Thiếu DATABASE_URL (hoặc POSTGRES_PASSWORD)")
    connectionString = `postgres://${pgUser}:${encodeURIComponent(e.POSTGRES_PASSWORD)}@${dbService}:5432/${pgDb}`
  }

  // allow-list for child processes: no app secrets, no APP_VERSION (set explicitly where needed)
  const baseEnv: Record<string, string> = {
    PATH: e.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: e.HOME ?? "/root",
    DOCKER_CONFIG: e.DOCKER_CONFIG ?? "/root/.docker",
    PWD: dir,
    COMPOSE_PROJECT_NAME: composeProject,
    ...(e.DOCKER_HOST ? { DOCKER_HOST: e.DOCKER_HOST } : {}),
  }
  const min = (n: number) => n * 60_000
  return {
    connectionString,
    cfg: {
      projectDir: dir,
      image,
      composeProject,
      dbService,
      pgUser,
      pgDb,
      baseEnv,
      ownVersion: e.APP_BUILD_VERSION ?? "dev",
      // shown in error messages only ("đăng nhập lại cho đúng thư mục này"); absolute path, no spaces
      dockerConfigHostDir: /^\/[A-Za-z0-9._/-]*$/.test(e.UPDATER_DOCKER_CONFIG_HOST ?? "") ? e.UPDATER_DOCKER_CONFIG_HOST! : null,
      timeouts: { backupMs: min(20), pullMs: min(20), migrateMs: min(10), restartMs: min(5), healthMs: min(5), stableMs: 10_000, pollMs: 5_000 },
    },
  }
}

function makeFiles(projectDir: string): RunFiles {
  const envPath = path.join(projectDir, ".env")
  return {
    readEnv: () => readFileSync(envPath, "utf8"),
    writeEnv: (content, keepBackup) => writeFileAtomicKeepMode(envPath, content, { backupSuffix: keepBackup ? ".bak" : null }),
    mkdirp: (dir) => void mkdirSync(dir, { recursive: true, mode: 0o755 }),
    size: (f) => statSync(f).size,
    remove: (f) => rmSync(f, { force: true }),
    rename: (a, b) => renameSync(a, b),
  }
}

/** null = ready to work; otherwise why this updater cannot work (then no heartbeat is sent, the UI shows "not enabled"). */
function selfCheck(cfg: UpdaterConfig): string | null {
  if (!existsSync(DOCKER_SOCK)) return `không thấy ${DOCKER_SOCK} (chưa mount docker.sock)`
  if (!existsSync(path.join(cfg.projectDir, "docker-compose.yml"))) return `không thấy ${cfg.projectDir}/docker-compose.yml (HOST_PROJECT_DIR sai hoặc chưa mount)`
  if (!existsSync(path.join(cfg.projectDir, ".env"))) return `không thấy ${cfg.projectDir}/.env`
  return null
}

/** finish() is the one write we must not lose when Postgres restarts for a moment: retry it. */
function withRetry(store: Store, sleep: (ms: number) => Promise<void>): Store {
  return {
    ...store,
    async finish(req, info) {
      let lastErr: unknown
      for (let i = 0; i < 12; i++) {
        try {
          return await store.finish(req, info)
        } catch (e) {
          lastErr = e
          await sleep(5_000)
        }
      }
      throw lastErr
    },
  }
}

async function main() {
  const { cfg, connectionString } = loadConfig()
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const pool = new Pool({ connectionString, max: 3, application_name: "ads-mcp-updater" })
  pool.on("error", (e) => log(`pg pool error: ${e.message}`))
  const store = withRetry(createPgStore(pool), sleep)
  const files = makeFiles(cfg.projectDir)
  const deps: RunDeps = { cfg, exec: spawnExec, store, files, sleep, now: () => Date.now() }

  let stopping = false
  let wake: () => void = () => {}
  /** like sleep, but returns at once when SIGTERM arrives (the idle poll and the post-self-update wait must not delay docker stop) */
  const idle = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms)
      wake = () => {
        clearTimeout(t)
        r()
      }
    })
  let busy = false
  let lastProblem: string | null | undefined
  const beat = async () => {
    const problem = selfCheck(cfg)
    if (problem !== lastProblem) {
      lastProblem = problem
      log(problem ? `chưa sẵn sàng: ${problem}` : "sẵn sàng nhận yêu cầu cập nhật")
    }
    if (problem) return
    await store.heartbeat({ at: new Date(), version: cfg.ownVersion, composeProject: cfg.composeProject }).catch((e) => log(`heartbeat lỗi: ${(e as Error).message}`))
  }
  const onStop = (sig: string) => {
    if (stopping) return
    stopping = true
    wake()
    log(`${sig} nhận được, dừng sau khi xong việc đang chạy (nếu có)`)
  }
  process.on("SIGTERM", () => onStop("SIGTERM"))
  process.on("SIGINT", () => onStop("SIGINT"))

  log(`khởi động v${cfg.ownVersion}, project ${cfg.projectDir}, image ${cfg.image}`)
  // a `running` row while we start can only be an orphan of a previous updater process
  await store
    .failStaleRunning(0, "Tiến trình cập nhật bị gián đoạn vì updater khởi động lại. Kiểm tra bằng docker compose ps; có thể thử cập nhật lại.")
    .catch((e) => log(`dọn yêu cầu treo lỗi: ${(e as Error).message}`))
  await beat()
  const hb = setInterval(() => void beat(), HEARTBEAT_MS)

  let lastLoopError = ""
  while (!stopping) {
    try {
      await store.failStalePending(
        STALE_PENDING_MINUTES,
        `Yêu cầu cập nhật không được xử lý trong ${STALE_PENDING_MINUTES} phút (updater không chạy hoặc đang bận) nên đã bị huỷ. Hãy bấm Cập nhật lại.`
      )
      await store.failStaleRunning(STALE_RUNNING_MINUTES, `Yêu cầu cập nhật chạy quá ${STALE_RUNNING_MINUTES} phút nên bị huỷ. Kiểm tra bằng docker compose ps.`)
      const problem = selfCheck(cfg)
      const req = problem ? null : await store.claimNext()
      lastLoopError = ""
      if (!req) {
        await idle(POLL_MS)
        continue
      }
      busy = true
      // secrets of .env are masked in every line we print as well
      try {
        redact = makeRedactor(collectSecretValues(files.readEnv()))
      } catch {
        /* keep the default redactor */
      }
      log(`nhận yêu cầu ${req.id}: ${req.fromVersion} -> ${req.targetVersion}`)
      const status = await runUpdate(req, deps)
      log(`yêu cầu ${req.id} kết thúc: ${status}`)
      busy = false
      if (status === "succeeded") {
        const r = await recreateUpdater(deps, req.targetVersion, log).catch((e) => {
          log(`tự cập nhật lỗi: ${(e as Error).message}`)
          return "failed" as const
        })
        // the helper container is about to stop this process: do not claim new work meanwhile
        if (r === "started") await idle(90_000)
      }
    } catch (e) {
      busy = false
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== lastLoopError) log(`vòng lặp lỗi: ${msg}`) // same error every 5 s (e.g. table not migrated yet): print once
      lastLoopError = msg
      await idle(POLL_MS)
    }
  }
  clearInterval(hb)
  if (!busy) await pool.end().catch(() => {})
  log("đã dừng")
}

main().catch((e) => {
  console.error(`[updater] failed to start: ${redact(e instanceof Error ? e.message : String(e))}`)
  process.exit(1)
})
