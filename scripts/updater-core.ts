// Updater (pure logic): semver, .env editing, redaction, log buffer, compose-ps parsing, health decision.
// No DB, no docker and no process.env here - everything is testable without I/O (see updater-core.test.ts).
// Design contract: .claude/docs/10-update-system.md. Runs inside the `updater` container only.
import { chmodSync, chownSync, copyFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"

import { redactString } from "@/server/audit/redact"

// ---------------------------------------------------------------------------------------------
// Types shared by the state machine, the pg store and the spawn wrapper
// ---------------------------------------------------------------------------------------------
export type UpdateStatus = "pending" | "running" | "succeeded" | "failed" | "rolled_back"
export type FinalStatus = "succeeded" | "failed" | "rolled_back"
export type UpdateStep = "backup" | "pull" | "migrate" | "restart" | "healthcheck" | "rollback"

export const ACTION_BY_STATUS: Record<FinalStatus, string> = {
  succeeded: "system.update_succeeded",
  failed: "system.update_failed",
  rolled_back: "system.update_rolled_back",
}

export const MAX_LOG_BYTES = 64 * 1024
export const STALE_RUNNING_MINUTES = 30
/** a pending request older than this is never started (an updater that comes back after days must not run an old click) */
export const STALE_PENDING_MINUTES = 10
export const DEFAULT_IMAGE = "ghcr.io/notivn/ads-mcp-simple"

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseSemver(v: unknown): [number, number, number] | null {
  if (typeof v !== "string" || v.length > 32) return null
  const m = SEMVER_RE.exec(v)
  if (!m) return null
  const n: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return n.every(Number.isSafeInteger) ? n : null
}

/** Negative when a < b. Both must be valid (throws otherwise). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) throw new Error("compareSemver: invalid version")
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  return 0
}

/** "v1.2.3" -> "1.2.3" (only strips one leading v). */
export function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v
}

export type TargetCheck = { ok: true } | { ok: false; reason: string }

/**
 * target must be x.y.z and strictly greater than every known current version.
 * `known` = versions that are semver (the running version recorded by the web app, the APP_VERSION in .env).
 * Non-semver values ("dev", "latest", "") are ignored: a source build can move to any release.
 */
export function checkTargetVersion(target: unknown, known: Array<string | null | undefined>): TargetCheck {
  if (typeof target !== "string" || !parseSemver(target)) {
    return { ok: false, reason: "Phiên bản đích không hợp lệ (cần dạng 1.2.3)." }
  }
  for (const k of known) {
    if (!k) continue
    const cur = stripV(k)
    if (!parseSemver(cur)) continue
    if (compareSemver(target, cur) <= 0) {
      return { ok: false, reason: `Phiên bản đích ${target} không mới hơn phiên bản hiện tại ${cur}.` }
    }
  }
  return { ok: true }
}

/** Container image repository, e.g. ghcr.io/notivn/ads-mcp-simple (no tag, no digest). */
export function isValidImageName(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length <= 200 &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(s)
  )
}

// ---------------------------------------------------------------------------------------------
// .env editing (content in, content out) + atomic file write
// ---------------------------------------------------------------------------------------------
const ENV_VALUE_RE = /^[A-Za-z0-9._-]{1,64}$/

function keyLineRe(key: string): RegExp {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid env key")
  return new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`)
}

/** Value of the first active `KEY=value` line (quotes stripped); null when absent or empty. */
export function readEnvVar(content: string, key: string): string | null {
  const re = keyLineRe(key)
  for (const line of content.split(/\r?\n/)) {
    if (!re.test(line)) continue
    let v = line.replace(re, "").trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    return v === "" ? null : v
  }
  return null
}

/**
 * Sets `KEY=value` (value restricted to [A-Za-z0-9._-]) touching ONLY the lines of that key; every other byte
 * (comments, order, line endings, trailing newline) is kept. value === null removes the key's lines.
 * Absent key + value -> appended at the end.
 */
export function setEnvVar(content: string, key: string, value: string | null): string {
  if (value !== null && !ENV_VALUE_RE.test(value)) throw new Error("invalid env value")
  const re = keyLineRe(key)
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const parts = content.split(/(\r?\n)/) // [line, eol, line, eol, ..., lastLine]
  let found = false
  const out: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!
    const sep = parts[i + 1] // undefined for the last element
    const m = re.exec(line)
    if (!m) {
      out.push(line)
      if (sep !== undefined) out.push(sep)
      continue
    }
    found = true
    if (value === null) continue // drop the line (and its eol)
    out.push(`${m[1]}${key}=${value}`)
    if (sep !== undefined) out.push(sep)
  }
  let result = out.join("")
  if (!found && value !== null) {
    if (result !== "" && !/\r?\n$/.test(result)) result += eol
    result += `${key}=${value}${eol}`
  }
  return result
}

/**
 * Writes `content` to `path` atomically (temp file in the same directory + rename), keeping mode and owner.
 * Before that, copies the current file to `<path>.bak` (same mode) so the last good .env is kept.
 * The caller must mount the DIRECTORY (rename on a single-file bind mount fails with EBUSY).
 */
export function writeFileAtomicKeepMode(path: string, content: string, opts: { backupSuffix?: string | null } = {}): void {
  const st = statSync(path)
  const mode = st.mode & 0o777
  const suffix = opts.backupSuffix === undefined ? ".bak" : opts.backupSuffix
  if (suffix) {
    const bak = path + suffix
    copyFileSync(path, bak)
    tryOwner(bak, st.uid, st.gid, mode)
  }
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, content, { mode })
    tryOwner(tmp, st.uid, st.gid, mode)
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* no temp file */
    }
    throw e
  }
}

function tryOwner(p: string, uid: number, gid: number, mode: number) {
  try {
    chmodSync(p, mode)
  } catch {
    /* e.g. Windows */
  }
  try {
    chownSync(p, uid, gid)
  } catch {
    /* not permitted (not root) - mode is still right */
  }
}

// ---------------------------------------------------------------------------------------------
// Redaction: nothing from .env or a token may ever reach the DB log
// ---------------------------------------------------------------------------------------------
const SECRET_ENV_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|KEY|KEYS|PEPPER|DATABASE_URL|CREDENTIAL)/i

/** Values worth masking verbatim: every secret-looking variable of .env (+ pieces of ENCRYPTION_KEYS). */
export function collectSecretValues(envContent: string): string[] {
  const out = new Set<string>()
  for (const raw of envContent.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw)
    if (!m || !SECRET_ENV_KEY.test(m[1]!)) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (v.length < 6) continue
    out.add(v)
    if (m[1] === "ENCRYPTION_KEYS" || m[1] === "DATABASE_URL") {
      for (const piece of v.split(/[,:@/]/)) if (piece.length >= 8) out.add(piece)
    }
  }
  // longest first so a long secret is masked before any of its own substrings
  return [...out].sort((a, b) => b.length - a.length)
}

const SECRET_ASSIGN = /(\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|KEYS?|PEPPER|DATABASE_URL|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+)/gi

export function makeRedactor(secretValues: string[] = []): (s: string) => string {
  const secrets = secretValues.filter((s) => s.length >= 6)
  return (input: string) => {
    let s = input
    for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join("[redacted]")
    s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@") // user:pass@host
    s = s.replace(SECRET_ASSIGN, "$1[redacted]")
    s = s.replace(/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, "gh…[redacted]")
    s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_…[redacted]")
    s = s.replace(/\b(Authorization:\s*)\S+(?:\s+\S+)?/gi, "$1[redacted]")
    return redactString(s)
  }
}

/** Rolling text buffer: keeps the last MAX_LOG_BYTES (UTF-8) of already-redacted lines. */
export class LogBuffer {
  private lines: string[] = []
  private bytes = 0
  constructor(
    private readonly redact: (s: string) => string,
    private readonly maxBytes = MAX_LOG_BYTES
  ) {}

  add(line: string): void {
    const clean = this.redact(line.replace(/\r$/, "")).slice(0, 4000)
    this.lines.push(clean)
    this.bytes += Buffer.byteLength(clean) + 1
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      this.bytes -= Buffer.byteLength(this.lines.shift()!) + 1
    }
  }

  /** `[HH:MM:SS] ` stamped, redacted note from the updater itself */
  note(text: string, at = new Date()): void {
    this.add(`[${at.toISOString().slice(11, 19)}] ${text}`)
  }

  tail(): string {
    let text = this.lines.join("\n")
    while (Buffer.byteLength(text) > this.maxBytes) text = text.slice(Math.max(1, text.length - this.maxBytes))
    return text
  }
}

// ---------------------------------------------------------------------------------------------
// docker compose ps -> health decision
// ---------------------------------------------------------------------------------------------
export interface PsEntry {
  Service?: string
  State?: string
  Health?: string
  ExitCode?: number
  Image?: string
}

/** `docker compose ps --format json` prints a JSON array (old) or one JSON object per line (compose >= 2.21). */
export function parseComposePs(stdout: string): PsEntry[] {
  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((x): x is PsEntry => !!x && typeof x === "object")
  } catch {
    const out: PsEntry[] = []
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith("{")) continue
      try {
        out.push(JSON.parse(t) as PsEntry)
      } catch {
        /* skip a broken line */
      }
    }
    return out
  }
}

export type HealthVerdict =
  | { state: "ready" }
  /** restarting=true: a container is in the restart loop (the caller gives up after a few observations, no need to wait the full timeout) */
  | { state: "pending"; detail: string; restarting?: boolean }
  | { state: "failed"; detail: string }

/**
 * web must be running + healthy and worker running; both on the expected image tag when one is given.
 * `failed` = no point waiting (container stopped / unhealthy); `pending` = keep polling until the deadline.
 */
export function evaluateHealth(entries: PsEntry[], expectedTag: string | null): HealthVerdict {
  for (const name of ["web", "worker"]) {
    const e = entries.find((x) => x.Service === name)
    if (!e) return { state: "pending", detail: `chưa thấy container ${name}` }
    const state = (e.State ?? "").toLowerCase()
    if (state === "exited" || state === "dead") {
      return { state: "failed", detail: `${name} đã dừng (exit code ${e.ExitCode ?? "?"})` }
    }
    if (state === "restarting") return { state: "pending", detail: `${name} đang khởi động lại liên tục`, restarting: true }
    if (state !== "running") return { state: "pending", detail: `${name} đang ở trạng thái ${state || "không rõ"}` }
    if (expectedTag && !(e.Image ?? "").endsWith(`:${expectedTag}`)) {
      return { state: "pending", detail: `${name} chưa chạy image ${expectedTag}` }
    }
    const health = (e.Health ?? "").toLowerCase()
    if (name === "web") {
      if (health === "unhealthy") return { state: "failed", detail: "web báo unhealthy" }
      if (health && health !== "healthy") return { state: "pending", detail: `web healthcheck: ${health}` }
    }
  }
  return { state: "ready" }
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------
/** pre-update-20261003-101500.dump (UTC) */
export function backupFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const ts = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  return `pre-update-${ts}.dump`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Short, single-line, redacted text for the `message` column. */
export function shortMessage(s: string, redact: (x: string) => string): string {
  return redact(s).replace(/\s+/g, " ").trim().slice(0, 500)
}

/**
 * Turn the last output lines of a failed `docker pull` / `docker compose` into ONE actionable Vietnamese sentence
 * for the admin (the raw lines stay in the log column). null = nothing recognisable: callers fall back to the raw
 * last line. `credDir` = HOST directory whose config.json the updater uses for `docker login` (null = unknown).
 */
export function explainDockerFailure(lines: string[], ctx: { credDir: string | null }): string | null {
  const text = lines.join("\n")
  const dir = ctx.credDir
    ? `thư mục ${ctx.credDir} trên máy chủ`
    : "thư mục credential của updater (mặc định /root/.docker, hoặc UPDATER_DOCKER_CONFIG trong .env)"
  if (/\b(denied|unauthorized|authentication required|no basic auth credentials|insufficient_scope)\b/i.test(text)) {
    return (
      `GHCR từ chối quyền tải image ("denied"). Updater dùng thông tin docker login trong ${dir}: ` +
      "đăng nhập lại GHCR bằng PAT classic có quyền read:packages cho đúng user sở hữu thư mục đó " +
      "(hoặc sửa UPDATER_DOCKER_CONFIG trong .env rồi chạy docker compose up -d updater), sau đó bấm Cập nhật lại"
    )
  }
  if (/manifest unknown|manifest for .* not found|not found: manifest/i.test(text)) {
    return "GHCR không có phiên bản này (manifest unknown): bản phát hành có thể chưa build xong - đợi vài phút rồi bấm Kiểm tra ngay"
  }
  if (/toomanyrequests|rate limit/i.test(text)) {
    return "GHCR đang giới hạn số lần tải (toomanyrequests): đợi vài phút rồi bấm Cập nhật lại"
  }
  if (/no space left on device/i.test(text)) {
    return "Máy chủ hết dung lượng ổ đĩa: dọn bớt (docker image prune, xoá bản sao lưu cũ trong backups/) rồi bấm Cập nhật lại"
  }
  if (/no such host|i\/o timeout|dial tcp|tls handshake|connection refused|network is unreachable|temporary failure in name resolution/i.test(text)) {
    return "Máy chủ không kết nối được tới ghcr.io (lỗi mạng/DNS): kiểm tra Internet, DNS và tường lửa của máy chủ rồi bấm Cập nhật lại"
  }
  return null
}

/** Last meaningful output line (redacted by the caller), capped for the `message` column. */
export function lastOutputLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim()
    if (l && !l.startsWith("$ ")) return l.length > 180 ? `${l.slice(0, 180)}…` : l
  }
  return null
}
