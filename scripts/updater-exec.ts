// Updater (I/O): run an external program with spawn(args[]) - never a shell, never a string built from DB data.
// Timeout: SIGTERM first (docker CLI stops the one-off container on SIGTERM), SIGKILL after KILL_GRACE_MS.
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { closeSync, openSync } from "node:fs"

export interface ExecOptions {
  /** COMPLETE environment of the child (the caller passes an allow-list, never process.env). */
  env: Record<string, string>
  cwd?: string
  timeoutMs: number
  /** stdout goes straight into this file (mode 0600), e.g. pg_dump output. Lines are not captured then. */
  stdoutFile?: string
  /** file piped into stdin, e.g. pg_restore --list */
  stdinFile?: string
  /** collect stdout into ExecResult.stdout (max CAPTURE_LIMIT) */
  capture?: boolean
  /** every stdout/stderr line (not called for stdout when stdoutFile is set) */
  onLine?: (line: string, stream: "stdout" | "stderr") => void
}

export interface ExecResult {
  code: number | null
  timedOut: boolean
  /** spawn failure (binary missing...) - message only */
  error?: string
  stdout?: string
}

export type Exec = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>

const KILL_GRACE_MS = 10_000
const CAPTURE_LIMIT = 1024 * 1024

class LineSplitter {
  private buf = ""
  constructor(private readonly emit: (line: string) => void) {}
  push(chunk: string) {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf("\n")) >= 0) {
      this.emit(this.buf.slice(0, i))
      this.buf = this.buf.slice(i + 1)
    }
    if (this.buf.length > 8000) {
      this.emit(this.buf)
      this.buf = ""
    }
  }
  end() {
    if (this.buf) this.emit(this.buf)
    this.buf = ""
  }
}

export const spawnExec: Exec = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    let outFd: number | undefined
    let inFd: number | undefined
    const closeFds = () => {
      for (const fd of [outFd, inFd]) if (fd !== undefined) closeSync(fd)
      outFd = inFd = undefined
    }
    try {
      if (opts.stdoutFile) outFd = openSync(opts.stdoutFile, "w", 0o600)
      if (opts.stdinFile) inFd = openSync(opts.stdinFile, "r")
    } catch (e) {
      closeFds()
      resolve({ code: null, timedOut: false, error: `không mở được file: ${(e as NodeJS.ErrnoException).code ?? "lỗi"}` })
      return
    }

    let captured = ""
    let timedOut = false
    let settled = false
    const stdoutSplit = new LineSplitter((l) => opts.onLine?.(l, "stdout"))
    const stderrSplit = new LineSplitter((l) => opts.onLine?.(l, "stderr"))

    const stdio: StdioOptions = [inFd ?? "ignore", outFd ?? "pipe", "pipe"]
    const child: ChildProcess = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio,
    })

    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
    }, opts.timeoutMs)

    const finish = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      stdoutSplit.end()
      stderrSplit.end()
      closeFds()
      resolve(opts.capture ? { ...r, stdout: captured } : r)
    }

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (c: string) => {
      if (opts.capture && captured.length < CAPTURE_LIMIT) captured += c
      stdoutSplit.push(c)
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (c: string) => stderrSplit.push(c))
    child.on("error", (e) => finish({ code: null, timedOut, error: (e as NodeJS.ErrnoException).code ?? "spawn_error" }))
    child.on("close", (code) => finish({ code, timedOut }))
  })
