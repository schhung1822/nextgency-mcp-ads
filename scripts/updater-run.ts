// Updater (state machine): backup -> pull -> migrate -> write APP_VERSION -> up web/worker -> healthcheck,
// rollback to the previous APP_VERSION on failure after the swap. All effects go through injected deps
// (exec / store / files / sleep / now) so the whole flow is tested with fakes (updater-run.test.ts).
// Safety rules (10-update-system.md §1): the running web/worker are untouched until migrate succeeded;
// every external command is spawn(args[]) with values validated here, nothing from the DB is concatenated
// into a shell string; the log tail is redacted before it is stored.
import { posix as path } from "node:path"

import {
  LogBuffer,
  backupFileName,
  checkTargetVersion,
  collectSecretValues,
  evaluateHealth,
  explainDockerFailure,
  formatBytes,
  lastOutputLine,
  makeRedactor,
  parseComposePs,
  readEnvVar,
  setEnvVar,
  shortMessage,
  type FinalStatus,
  type UpdateStep,
} from "./updater-core"
import type { Exec, ExecResult } from "./updater-exec"
import type { Store, UpdateRequest } from "./updater-store"

export interface UpdaterConfig {
  /** Absolute project path ON THE HOST; the container mounts it at the SAME path (compose resolves bind mounts on the host). */
  projectDir: string
  /** image repository without tag, e.g. ghcr.io/notivn/ads-mcp-simple */
  image: string
  composeProject: string
  dbService: string
  pgUser: string
  pgDb: string
  /** Complete env for child processes (allow-list: PATH, HOME, DOCKER_CONFIG, PWD...). Never contains APP_VERSION or secrets. */
  baseEnv: Record<string, string>
  /** this updater's own build version */
  ownVersion: string
  /** HOST directory mounted as the updater's docker config (docker login), for error messages; null = unknown */
  dockerConfigHostDir?: string | null
  timeouts: {
    backupMs: number
    pullMs: number
    migrateMs: number
    restartMs: number
    healthMs: number
    stableMs: number
    pollMs: number
  }
}

export interface RunFiles {
  readEnv(): string
  /** atomic, keeps mode/owner; keepBackup=true copies the previous file to .env.bak first */
  writeEnv(content: string, keepBackup: boolean): void
  mkdirp(dir: string): void
  size(file: string): number
  remove(file: string): void
  rename(from: string, to: string): void
}

export interface RunDeps {
  cfg: UpdaterConfig
  exec: Exec
  store: Pick<Store, "progress" | "finish">
  files: RunFiles
  sleep(ms: number): Promise<void>
  now(): number
}

export const STEP_LABEL: Record<UpdateStep, string> = {
  backup: "sao lưu cơ sở dữ liệu",
  pull: "tải image",
  migrate: "chạy migration",
  restart: "khởi động bản mới",
  healthcheck: "kiểm tra sức khoẻ",
  rollback: "quay về bản cũ",
}

class StepError extends Error {
  constructor(
    readonly step: UpdateStep | null,
    readonly reason: string
  ) {
    super(reason)
  }
}

/** A command result plus its last output lines (already redacted) - the reason shown to the admin comes from them. */
type RunResult = ExecResult & { tail: string[] }

function describe(r: ExecResult & { tail?: string[] }): string {
  if (r.timedOut) return "quá thời gian chờ"
  if (r.error) return `không chạy được lệnh (${r.error})`
  const last = lastOutputLine(r.tail ?? [])
  return last ? `lệnh thoát với mã ${r.code}: ${last}` : `lệnh thoát với mã ${r.code}`
}

const ok = (r: ExecResult) => r.code === 0 && !r.timedOut && !r.error

export function composeArgs(cfg: UpdaterConfig, ...rest: string[]): string[] {
  return ["compose", "--project-directory", cfg.projectDir, "-f", path.join(cfg.projectDir, "docker-compose.yml"), ...rest]
}

/**
 * Runs one update request to its final state and records it (store.finish). Never throws for expected failures.
 */
export async function runUpdate(req: UpdateRequest, d: RunDeps): Promise<FinalStatus> {
  const { cfg } = d
  const t0 = d.now()
  let envContent = ""
  let envReadError = false
  try {
    envContent = d.files.readEnv()
  } catch {
    envReadError = true
  }
  const redact = makeRedactor(collectSecretValues(envContent))
  const log = new LogBuffer(redact)
  let lastFlush = 0
  const flush = (force = false) => {
    const n = d.now()
    if (!force && n - lastFlush < 2000) return
    lastFlush = n
    void d.store.progress(req.id, { log: log.tail() }).catch(() => {})
  }
  const note = (text: string) => log.note(text, new Date(d.now()))
  const setStep = async (step: UpdateStep, message: string) => {
    note(message)
    lastFlush = d.now()
    await d.store.progress(req.id, { step, message, log: log.tail() }).catch(() => {})
  }
  const run = async (label: string, args: string[], timeoutMs: number, extra: { env?: Record<string, string>; stdoutFile?: string; stdinFile?: string; capture?: boolean; quiet?: boolean } = {}): Promise<RunResult> => {
    note(`$ docker ${label}`)
    const tail: string[] = []
    const r = await d.exec("docker", args, {
      env: { ...cfg.baseEnv, ...extra.env },
      cwd: cfg.projectDir,
      timeoutMs,
      stdoutFile: extra.stdoutFile,
      stdinFile: extra.stdinFile,
      capture: extra.capture,
      onLine: (line, stream) => {
        if (extra.quiet && stream === "stdout") return
        log.add(line)
        tail.push(redact(line))
        if (tail.length > 8) tail.shift()
        flush()
      },
    })
    return { ...r, tail }
  }
  const imageRef = `${cfg.image}:${req.targetVersion}`
  const compose = (...rest: string[]) => composeArgs(cfg, ...rest)
  const meta: Record<string, unknown> = { from: req.fromVersion, to: req.targetVersion }
  let backupFile: string | null = null
  let failedStep: UpdateStep | null = null

  const finish = async (status: FinalStatus, step: UpdateStep | null, message: string, extra: Record<string, unknown> = {}) => {
    const durationMs = d.now() - t0
    note(`Kết thúc: ${status}`)
    const saved = await d.store.finish(req, {
      status,
      step,
      message: shortMessage(message, redact),
      log: log.tail(),
      metadata: { ...meta, durationMs, ...(failedStep ? { failedStep } : {}), ...(backupFile ? { backupFile } : {}), ...extra },
    })
    if (!saved) console.error("[updater] không ghi được trạng thái cuối: dòng yêu cầu không còn ở trạng thái running")
    return status
  }

  // ---- preflight ------------------------------------------------------------------------------
  let prevVersion: string | null = null
  try {
    if (envReadError) throw new StepError(null, "Không đọc được file .env trong thư mục dự án (kiểm tra HOST_PROJECT_DIR và quyền mount).")
    prevVersion = readEnvVar(envContent, "APP_VERSION")
    const check = checkTargetVersion(req.targetVersion, [req.fromVersion, prevVersion])
    if (!check.ok) throw new StepError(null, check.reason)
    note(`Cập nhật ${req.fromVersion} -> ${req.targetVersion} (image ${imageRef})`)

    await stepBackup()
    await stepPull()
    await stepMigrate()
  } catch (e) {
    const err = asStepError(e)
    failedStep = err.step
    note(`Lỗi${err.step ? ` ở bước ${STEP_LABEL[err.step]}` : ""}: ${err.reason}`)
    const where = err.step ? ` ở bước "${STEP_LABEL[err.step]}"` : ""
    return finish("failed", err.step, `Cập nhật chưa được áp dụng${where}: ${err.reason}. Phiên bản đang chạy không bị ảnh hưởng.`)
  }

  // ---- swap web/worker --------------------------------------------------------------------------
  let replaced = false
  try {
    await stepRestart()
    await stepHealth(req.targetVersion, "healthcheck")
    await d.store.progress(req.id, { step: "healthcheck", message: `Đã cập nhật lên v${req.targetVersion}`, log: log.tail() }).catch(() => {})
    return finish("succeeded", "healthcheck", `Đã cập nhật lên v${req.targetVersion} thành công.`)
  } catch (e) {
    const err = asStepError(e)
    failedStep = err.step
    note(`Lỗi${err.step ? ` ở bước ${STEP_LABEL[err.step]}` : ""}: ${err.reason}`)
    const where = err.step ? ` ở bước "${STEP_LABEL[err.step]}"` : ""
    if (!replaced) {
      return finish("failed", err.step, `Cập nhật chưa được áp dụng${where}: ${err.reason}. Phiên bản đang chạy không bị ảnh hưởng.`)
    }
    // the swap started: go back to the previous version
    try {
      await stepRollback()
      return finish("rolled_back", "rollback", `Bản mới v${req.targetVersion} lỗi${where}: ${err.reason}. Đã quay về phiên bản trước${prevVersion ? ` (v${prevVersion})` : ""}.`, { rollback: "ok" })
    } catch (re) {
      const rerr = asStepError(re)
      note(`Rollback lỗi: ${rerr.reason}`)
      return finish(
        "failed",
        "rollback",
        `Bản mới lỗi${where} và việc quay về bản cũ cũng thất bại (${rerr.reason}). Cần xử lý thủ công trên máy chủ${backupFile ? `; bản sao lưu: backups/${backupFile}` : ""}. Xem hướng dẫn khôi phục trong tài liệu.`,
        { rollback: "failed" }
      )
    }
  }

  // ---- steps --------------------------------------------------------------------------------------
  async function stepBackup() {
    await setStep("backup", "Đang sao lưu cơ sở dữ liệu trước khi cập nhật")
    const dir = path.join(cfg.projectDir, "backups")
    const name = backupFileName(new Date(d.now()))
    const partial = path.join(dir, `${name}.partial`)
    const final = path.join(dir, name)
    try {
      d.files.mkdirp(dir)
    } catch {
      throw new StepError("backup", "không tạo được thư mục backups")
    }
    const dump = await run(
      "compose exec -T db pg_dump -Fc",
      compose("exec", "-T", cfg.dbService, "pg_dump", "-U", cfg.pgUser, "-d", cfg.pgDb, "-Fc", "-Z", "zstd:6"),
      cfg.timeouts.backupMs,
      { stdoutFile: partial }
    )
    const discard = () => {
      try {
        d.files.remove(partial)
      } catch {
        /* nothing to remove */
      }
    }
    if (!ok(dump)) {
      discard()
      throw new StepError("backup", `pg_dump thất bại (${describe(dump)})`)
    }
    let size = 0
    try {
      size = d.files.size(partial)
    } catch {
      /* treated as empty */
    }
    if (size < 512) {
      discard()
      throw new StepError("backup", "file sao lưu rỗng hoặc quá nhỏ")
    }
    // the dump must be readable by pg_restore before we touch anything
    const list = await run("compose exec -T db pg_restore --list", compose("exec", "-T", cfg.dbService, "pg_restore", "--list"), 120_000, {
      stdinFile: partial,
      capture: true,
      quiet: true,
    })
    if (!ok(list) || !(list.stdout ?? "").includes(";")) {
      discard()
      throw new StepError("backup", "file sao lưu không đọc lại được bằng pg_restore")
    }
    try {
      d.files.rename(partial, final)
    } catch {
      discard()
      throw new StepError("backup", "không đổi tên được file sao lưu")
    }
    backupFile = name
    note(`Đã sao lưu: backups/${name} (${formatBytes(size)})`)
  }

  async function stepPull() {
    await setStep("pull", `Đang tải image v${req.targetVersion}`)
    const pull = await run(`pull ${imageRef}`, ["pull", imageRef], cfg.timeouts.pullMs)
    if (!ok(pull)) {
      const why = explainDockerFailure(pull.tail, { credDir: cfg.dockerConfigHostDir ?? null })
      throw new StepError(
        "pull",
        why
          ? `không tải được image ${imageRef} - ${why}`
          : `không tải được image ${imageRef} (${describe(pull)}). Nếu image ở chế độ riêng tư, chạy docker login ghcr.io trên máy chủ (đúng user của thư mục credential mà updater dùng)`
      )
    }
    // the tag must really contain this version (APP_BUILD_VERSION is baked in at build time)
    const insp = await run(`image inspect ${imageRef}`, ["image", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", imageRef], 60_000, {
      capture: true,
      quiet: true,
    })
    const baked = (insp.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("APP_BUILD_VERSION="))
    if (!ok(insp) || baked !== `APP_BUILD_VERSION=${req.targetVersion}`) {
      throw new StepError("pull", `image ${imageRef} không mang đúng phiên bản (${baked ?? "thiếu APP_BUILD_VERSION"})`)
    }
    note("Đã tải image và xác nhận đúng phiên bản")
  }

  async function stepMigrate() {
    await setStep("migrate", "Đang chạy migration cơ sở dữ liệu bằng bản mới (bản đang chạy chưa bị thay)")
    // APP_VERSION from the process env overrides .env for THIS command only: .env is not written yet.
    const mig = await run("compose run --rm -T migrate", compose("run", "--rm", "-T", "migrate"), cfg.timeouts.migrateMs, {
      env: { APP_VERSION: req.targetVersion },
    })
    if (!ok(mig)) throw new StepError("migrate", `migration thất bại (${describe(mig)})`)
    note("Migration xong")
  }

  async function stepRestart() {
    await setStep("restart", `Đang chuyển web và worker sang v${req.targetVersion}`)
    try {
      const current = d.files.readEnv()
      d.files.writeEnv(setEnvVar(current, "APP_VERSION", req.targetVersion), true)
    } catch {
      throw new StepError("restart", "không ghi được APP_VERSION vào .env")
    }
    replaced = true
    note(`Đã ghi APP_VERSION=${req.targetVersion} vào .env (bản gốc: .env.bak)`)
    const up = await run("compose up -d --no-deps web worker", compose("up", "-d", "--no-deps", "web", "worker"), cfg.timeouts.restartMs)
    if (!ok(up)) throw new StepError("restart", `docker compose up thất bại (${describe(up)})`)
  }

  async function stepHealth(expectedTag: string | null, step: UpdateStep) {
    await setStep(step, step === "rollback" ? "Đang kiểm tra bản cũ sau khi quay về" : "Đang kiểm tra web và worker sau khi cập nhật")
    const deadline = d.now() + cfg.timeouts.healthMs
    let readySince: number | null = null
    let last = "chưa có kết quả"
    let restartingSeen = 0
    for (;;) {
      const ps = await run("compose ps --all --format json web worker", compose("ps", "--all", "--format", "json", "web", "worker"), 60_000, {
        capture: true,
        quiet: true,
      })
      if (ok(ps)) {
        const verdict = evaluateHealth(parseComposePs(ps.stdout ?? ""), expectedTag)
        if (verdict.state === "failed") throw new StepError(step === "rollback" ? "rollback" : "healthcheck", verdict.detail)
        if (verdict.state === "ready") {
          readySince ??= d.now()
          if (d.now() - readySince >= cfg.timeouts.stableMs) {
            note("Web healthy, worker đang chạy ổn định")
            return
          }
        } else {
          readySince = null
          last = verdict.detail
          restartingSeen = verdict.restarting ? restartingSeen + 1 : 0
          if (restartingSeen >= 3) throw new StepError(step === "rollback" ? "rollback" : "healthcheck", verdict.detail)
        }
      } else {
        readySince = null
        last = `docker compose ps lỗi (${describe(ps)})`
      }
      if (d.now() >= deadline) throw new StepError(step === "rollback" ? "rollback" : "healthcheck", `quá thời gian chờ, ${last}`)
      await d.sleep(cfg.timeouts.pollMs)
    }
  }

  async function stepRollback() {
    await setStep("rollback", "Đang quay về phiên bản trước")
    try {
      const current = d.files.readEnv()
      d.files.writeEnv(setEnvVar(current, "APP_VERSION", prevVersion), false) // keep .env.bak = the original
    } catch {
      throw new StepError("rollback", "không khôi phục được APP_VERSION trong .env")
    }
    const up = await run("compose up -d --no-deps web worker", compose("up", "-d", "--no-deps", "web", "worker"), cfg.timeouts.restartMs)
    if (!ok(up)) throw new StepError("rollback", `docker compose up thất bại (${describe(up)})`)
    await stepHealth(prevVersion, "rollback")
  }
}

function asStepError(e: unknown): StepError {
  if (e instanceof StepError) return e
  return new StepError(null, "lỗi không mong đợi trong updater")
}

// ---------------------------------------------------------------------------------------------
// After a successful update: replace the updater itself with the new image (best effort)
// ---------------------------------------------------------------------------------------------
export const SELF_UPDATE_HELPER = "ads-mcp-updater-selfupdate"

/**
 * The running updater cannot `docker compose up --force-recreate updater` itself (the CLI is killed with the
 * container halfway). A throw-away helper container started from the NEW updater image does it instead.
 * Called only after the final status was written. Any failure leaves the old updater running.
 */
export async function recreateUpdater(
  deps: Pick<RunDeps, "cfg" | "exec">,
  targetVersion: string,
  say: (line: string) => void
): Promise<"skipped" | "started" | "failed"> {
  const { cfg, exec } = deps
  if (cfg.ownVersion === targetVersion) return "skipped"
  const env = cfg.baseEnv
  const base = { env, cwd: cfg.projectDir, timeoutMs: 15 * 60_000, onLine: (l: string) => say(l) }
  say(`Tự cập nhật updater lên v${targetVersion}`)
  const pull = await exec("docker", composeArgs(cfg, "pull", "updater"), base)
  if (!ok(pull)) {
    say(`Không tải được image updater mới (${describe(pull)}); giữ updater hiện tại`)
    return "failed"
  }
  await exec("docker", ["rm", "-f", SELF_UPDATE_HELPER], { ...base, timeoutMs: 60_000 })
  const dir = cfg.projectDir
  const run = await exec(
    "docker",
    [
      "run", "-d", "--rm", "--name", SELF_UPDATE_HELPER,
      "--entrypoint", "docker",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${dir}:${dir}`,
      "-w", dir,
      "-e", `HOST_PROJECT_DIR=${dir}`,
      "-e", `PWD=${dir}`,
      `${cfg.image}-updater:${targetVersion}`,
      "compose", "--project-directory", dir, "up", "-d", "--no-deps", "--force-recreate", "updater",
    ],
    { ...base, timeoutMs: 120_000 }
  )
  if (!ok(run)) {
    say(`Không khởi động được container tự cập nhật (${describe(run)}); giữ updater hiện tại`)
    return "failed"
  }
  say("Đã giao việc thay updater cho container tạm; updater này sẽ được thay trong ít giây")
  return "started"
}
