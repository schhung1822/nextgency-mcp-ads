// State machine tests with a fake docker / filesystem / store (no I/O).
import { describe, expect, it } from "vitest"

import { MAX_LOG_BYTES, readEnvVar } from "./updater-core"
import type { Exec, ExecOptions, ExecResult } from "./updater-exec"
import { SELF_UPDATE_HELPER, recreateUpdater, runUpdate, type RunDeps, type RunFiles, type UpdaterConfig } from "./updater-run"
import type { FinishInfo, UpdateRequest } from "./updater-store"

const IMAGE = "ghcr.io/schhung1822/nextgency-mcp-ads"
const SIGNER = "https://github.com/schhung1822/nextgency-mcp-ads/.github/workflows/docker.yml@refs/tags/"
const ISSUER = "https://token.actions.githubusercontent.com"
const DIR = "/opt/ads-mcp"
const ENV0 = [
  "APP_DOMAIN=ads.example.com",
  "POSTGRES_PASSWORD=pgS3cretPassw0rd",
  "ENCRYPTION_KEYS=1:YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=",
  "APP_VERSION=1.1.0",
  "",
].join("\n")

interface Call {
  cmd: string
  args: string[]
  opts: ExecOptions
  /** .env content at the time of the call */
  env: string
}

type Handler = (args: string[], opts: ExecOptions, ctx: Ctx, cmd: string) => Partial<ExecResult & { lines: string[] }> | undefined

interface Ctx {
  calls: Call[]
  env: string
  fs: Map<string, number>
  t: number
}

const ok = (extra: Partial<ExecResult> = {}): ExecResult => ({ code: 0, timedOut: false, ...extra })

function psJson(web: object, worker: object): string {
  return [web, worker].map((x) => JSON.stringify(x)).join("\n")
}
const svc = (service: string, tag: string, o: object = {}) => ({ Service: service, State: "running", Health: service === "web" ? "healthy" : "", Image: `${IMAGE}:${tag}`, ...o })
const DIGEST = `sha256:${"d".repeat(64)}`
const DIGEST2 = `sha256:${"e".repeat(64)}`
const isDigestInspect = (a: string[]) => a[0] === "image" && a.includes("{{json .RepoDigests}}")

function harness(opts: { env?: string; handler?: Handler; failEnvWrite?: boolean; image?: string } = {}) {
  const ctx: Ctx = { calls: [], env: opts.env ?? ENV0, fs: new Map(), t: 1_790_000_000_000 }
  const writes: Array<{ content: string; keepBackup: boolean }> = []
  const progress: Array<{ step?: string | null; message?: string; log?: string }> = []
  const finished: FinishInfo[] = []
  const removed: string[] = []

  /** default docker/cosign: everything succeeds (images signed), ps follows the tag found in .env */
  const exec: Exec = async (cmd, args, o) => {
    expect(["docker", "cosign"]).toContain(cmd)
    expect(Array.isArray(args) && args.every((a) => typeof a === "string")).toBe(true)
    ctx.calls.push({ cmd, args, opts: o, env: ctx.env })
    ctx.t += 500
    const custom = opts.handler?.(args, o, ctx, cmd)
    const res: Partial<ExecResult & { lines: string[] }> = custom ?? {}
    for (const l of res.lines ?? []) o.onLine?.(l, "stderr")
    if (custom && (custom.code !== undefined || custom.timedOut || custom.error)) return { ...ok(), ...custom }
    if (args.includes("pg_dump")) {
      if (o.stdoutFile) ctx.fs.set(o.stdoutFile, 4096)
      return ok()
    }
    if (args.includes("pg_restore")) return ok({ stdout: custom?.stdout ?? "; Archive created at 2026-10-03\n; TOC Entries: 12\n" })
    if (cmd === "cosign") return ok({ stdout: custom?.stdout ?? '[{"critical":{}}]\n' })
    if (args[0] === "pull") return ok()
    if (isDigestInspect(args)) {
      const repo = args[args.length - 1]!.replace(/:[^:/]+$/, "")
      return ok({ stdout: custom?.stdout ?? `${JSON.stringify([`${repo}@${DIGEST}`])}\n` })
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const tag = args[args.length - 1]!.split(":").pop()
      return ok({ stdout: custom?.stdout ?? `PATH=/usr/bin\nAPP_BUILD_VERSION=${tag}\nNODE_ENV=production\n` })
    }
    if (args.includes("ps")) {
      const tag = readEnvVar(ctx.env, "APP_VERSION") ?? "latest"
      return ok({ stdout: custom?.stdout ?? psJson(svc("web", tag), svc("worker", tag)) })
    }
    return ok(custom?.stdout !== undefined ? { stdout: custom.stdout } : {})
  }

  const files: RunFiles = {
    readEnv: () => ctx.env,
    writeEnv: (content, keepBackup) => {
      if (opts.failEnvWrite) throw new Error("EACCES")
      writes.push({ content, keepBackup })
      ctx.env = content
    },
    mkdirp: () => {},
    size: (f) => ctx.fs.get(f) ?? 0,
    remove: (f) => void (removed.push(f), ctx.fs.delete(f)),
    rename: (a, b) => {
      ctx.fs.set(b, ctx.fs.get(a) ?? 0)
      ctx.fs.delete(a)
    },
  }
  const cfg: UpdaterConfig = {
    projectDir: DIR,
    image: opts.image ?? IMAGE,
    composeProject: "ads-mcp",
    dbService: "db",
    pgUser: "adsmcp",
    pgDb: "adsmcp",
    baseEnv: { PATH: "/usr/bin", PWD: DIR },
    ownVersion: "1.1.0",
    timeouts: { backupMs: 1000, pullMs: 1000, migrateMs: 1000, restartMs: 1000, healthMs: 60_000, stableMs: 10_000, pollMs: 5_000 },
  }
  const deps: RunDeps = {
    cfg,
    exec,
    files,
    store: {
      progress: async (_id, p) => void progress.push(p),
      finish: async (_req, info) => (finished.push(info), true),
    },
    sleep: async (ms) => void (ctx.t += ms),
    now: () => ctx.t,
  }
  return { ctx, deps, writes, progress, finished, removed }
}

const REQ: UpdateRequest = { id: "11111111-1111-1111-1111-111111111111", fromVersion: "1.1.0", targetVersion: "1.2.0", requestedBy: "u1" }
const find = (calls: Call[], pred: (a: string[]) => boolean) => calls.filter((c) => pred(c.args))
const isUp = (a: string[]) => a.includes("up")
const isMigrate = (a: string[]) => a.includes("run") && a.includes("migrate")

describe("runUpdate: success path", () => {
  it("runs backup -> pull -> migrate -> env write -> up -> health, in that order, and records succeeded", async () => {
    const h = harness()
    const status = await runUpdate(REQ, h.deps)
    expect(status).toBe("succeeded")

    const order = h.ctx.calls.map((c) => {
      const a = c.args
      if (c.cmd === "cosign") return "cosign"
      return a.includes("pg_dump") ? "dump" : a.includes("pg_restore") ? "verify" : a[0] === "pull" ? "pull" : isDigestInspect(a) ? "digests" : a[0] === "image" ? "inspect" : isMigrate(a) ? "migrate" : isUp(a) ? "up" : a.includes("ps") ? "ps" : "?"
    })
    expect(order.slice(0, 8)).toEqual(["dump", "verify", "pull", "inspect", "digests", "cosign", "migrate", "up"])
    expect(new Set(order.slice(8))).toEqual(new Set(["ps"]))

    // migrate ran with the NEW tag via process env while .env still held the old version
    const mig = find(h.ctx.calls, isMigrate)[0]!
    expect(mig.opts.env.APP_VERSION).toBe("1.2.0")
    expect(readEnvVar(mig.env, "APP_VERSION")).toBe("1.1.0")
    // the swap: exactly one env write (keep .bak) before `up`, only APP_VERSION changed
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.keepBackup).toBe(true)
    expect(h.writes[0]!.content).toBe(ENV0.replace("APP_VERSION=1.1.0", "APP_VERSION=1.2.0"))
    const up = find(h.ctx.calls, isUp)[0]!
    expect(up.args.slice(-5)).toEqual(["up", "-d", "--no-deps", "web", "worker"])
    expect(readEnvVar(up.env, "APP_VERSION")).toBe("1.2.0")
    expect(up.opts.env.APP_VERSION).toBeUndefined()

    // only fixed image + validated version reach docker
    expect(find(h.ctx.calls, (a) => a[0] === "pull")[0]!.args).toEqual(["pull", `${IMAGE}:1.2.0`])
    const dump = find(h.ctx.calls, (a) => a.includes("pg_dump"))[0]!
    expect(dump.args).toEqual(["compose", "--project-directory", DIR, "-f", `${DIR}/docker-compose.yml`, "exec", "-T", "db", "pg_dump", "-U", "adsmcp", "-d", "adsmcp", "-Fc", "-Z", "zstd:6"])
    expect(dump.opts.stdoutFile).toMatch(/^\/opt\/ads-mcp\/backups\/pre-update-\d{8}-\d{6}\.dump\.partial$/)

    // final record
    expect(h.finished).toHaveLength(1)
    const fin = h.finished[0]!
    expect(fin.status).toBe("succeeded")
    expect(fin.message).toContain("1.2.0")
    expect(fin.metadata).toMatchObject({ from: "1.1.0", to: "1.2.0" })
    expect(fin.metadata.durationMs).toBeGreaterThan(0)
    expect(String(fin.metadata.backupFile)).toMatch(/^pre-update-\d{8}-\d{6}\.dump$/)
    // backup is kept: partial renamed to the final name
    expect([...h.ctx.fs.keys()]).toEqual([`${DIR}/backups/${fin.metadata.backupFile}`])
    // step progress was reported
    expect(h.progress.map((p) => p.step).filter(Boolean)).toEqual(["backup", "pull", "migrate", "restart", "healthcheck", "healthcheck"])
  })

  it("appends APP_VERSION when .env had none and still succeeds", async () => {
    const h = harness({ env: "A=1\n" })
    expect(await runUpdate(REQ, h.deps)).toBe("succeeded")
    expect(h.writes[0]!.content).toBe("A=1\nAPP_VERSION=1.2.0\n")
  })
})

describe("runUpdate: input validation", () => {
  it.each([
    ["not semver", "1.2"],
    ["shell injection", "1.2.0; rm -rf /"],
    ["flag injection", "--help"],
    ["leading v", "v1.2.0"],
    ["prerelease", "1.2.0-rc.1"],
    ["same version", "1.1.0"],
    ["older version", "1.0.9"],
  ])("rejects %s without running a single command", async (_name, target) => {
    const h = harness()
    const status = await runUpdate({ ...REQ, targetVersion: target }, h.deps)
    expect(status).toBe("failed")
    expect(h.ctx.calls).toHaveLength(0)
    expect(h.writes).toHaveLength(0)
    expect(h.finished[0]!.message).toMatch(/không bị ảnh hưởng/)
  })

  it("rejects a target not newer than the APP_VERSION in .env even when the request's from_version is stale", async () => {
    const h = harness({ env: ENV0.replace("1.1.0", "1.3.0") })
    expect(await runUpdate({ ...REQ, fromVersion: "1.0.0", targetVersion: "1.2.0" }, h.deps)).toBe("failed")
    expect(h.ctx.calls).toHaveLength(0)
  })

  it("allows a source build ('dev') to move to a release", async () => {
    const h = harness({ env: "A=1\n" })
    expect(await runUpdate({ ...REQ, fromVersion: "dev" }, h.deps)).toBe("succeeded")
  })

  it("fails cleanly when .env cannot be read", async () => {
    const h = harness()
    h.deps.files.readEnv = () => {
      throw new Error("ENOENT")
    }
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.ctx.calls).toHaveLength(0)
  })
})

describe("runUpdate: failures before the swap leave the running version alone", () => {
  it("backup failure: failed, partial file removed, nothing else runs", async () => {
    const h = harness({ handler: (a) => (a.includes("pg_dump") ? { code: 1, lines: ["pg_dump: error: connection failed"] } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.step).toBe("backup")
    expect(h.ctx.calls.some((c) => c.args[0] === "pull")).toBe(false)
    expect(h.writes).toHaveLength(0)
    expect(h.removed.some((f) => f.endsWith(".partial"))).toBe(true)
  })

  it("empty / unreadable dump counts as a failed backup", async () => {
    const h = harness({ handler: (a) => (a.includes("pg_restore") ? { code: 1 } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.step).toBe("backup")
    expect(h.ctx.calls.some((c) => c.args[0] === "pull")).toBe(false)
  })

  it("pull failure: failed at pull, mentions docker login, no migrate", async () => {
    const h = harness({ handler: (a) => (a[0] === "pull" ? { code: 1, lines: ["denied: requires authentication"] } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.step).toBe("pull")
    expect(h.finished[0]!.message).toContain("docker login")
    expect(h.ctx.calls.some((c) => isMigrate(c.args))).toBe(false)
  })

  it("an image whose baked-in version differs from the tag is refused", async () => {
    const h = harness({ handler: (a) => (a[0] === "image" ? { stdout: "APP_BUILD_VERSION=1.9.9\n" } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.step).toBe("pull")
    expect(h.ctx.calls.some((c) => isMigrate(c.args))).toBe(false)
  })

  it("MIGRATE FAILURE: failed, .env never written, web/worker never touched", async () => {
    const h = harness({ handler: (a) => (isMigrate(a) ? { code: 1, lines: ["[migrate] failed: syntax error"] } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.status).toBe("failed")
    expect(h.finished[0]!.step).toBe("migrate")
    expect(h.finished[0]!.message).toMatch(/không bị ảnh hưởng/)
    expect(h.writes).toHaveLength(0)
    expect(find(h.ctx.calls, isUp)).toHaveLength(0)
    expect(h.ctx.env).toBe(ENV0)
    expect(h.finished[0]!.log).toContain("syntax error")
  })

  it("migrate timeout is a failure too", async () => {
    const h = harness({ handler: (a) => (isMigrate(a) ? { code: null, timedOut: true } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.message).toContain("quá thời gian chờ")
    expect(find(h.ctx.calls, isUp)).toHaveLength(0)
  })

  it("cannot write .env: failed (not rolled back), no up", async () => {
    const h = harness({ failEnvWrite: true })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    expect(h.finished[0]!.step).toBe("restart")
    expect(find(h.ctx.calls, isUp)).toHaveLength(0)
  })
})

describe("runUpdate: failures after the swap roll back", () => {
  it("unhealthy new version: rolled_back, APP_VERSION restored, old tag brought back and verified", async () => {
    let swapped = false
    const h = harness({
      handler: (a, _o, ctx) => {
        if (isUp(a) && readEnvVar(ctx.env, "APP_VERSION") === "1.2.0") swapped = true
        if (a.includes("ps") && readEnvVar(ctx.env, "APP_VERSION") === "1.2.0") {
          return { stdout: psJson(svc("web", "1.2.0", { State: "exited", ExitCode: 1, Health: "" }), svc("worker", "1.2.0")) }
        }
        return undefined
      },
    })
    expect(await runUpdate(REQ, h.deps)).toBe("rolled_back")
    expect(swapped).toBe(true)
    expect(h.writes.map((w) => readEnvVar(w.content, "APP_VERSION"))).toEqual(["1.2.0", "1.1.0"])
    expect(h.writes[1]!.keepBackup).toBe(false) // .env.bak keeps the ORIGINAL
    expect(h.ctx.env).toBe(ENV0)
    expect(find(h.ctx.calls, isUp)).toHaveLength(2)
    const fin = h.finished[0]!
    expect(fin.status).toBe("rolled_back")
    expect(fin.step).toBe("rollback")
    expect(fin.message).toContain("1.1.0")
    expect(fin.metadata).toMatchObject({ failedStep: "healthcheck", rollback: "ok" })
  })

  it("health never converges (timeout): rolled back too", async () => {
    const h = harness({
      handler: (a, _o, ctx) =>
        a.includes("ps") && readEnvVar(ctx.env, "APP_VERSION") === "1.2.0" ? { stdout: psJson(svc("web", "1.2.0", { Health: "starting" }), svc("worker", "1.2.0")) } : undefined,
    })
    expect(await runUpdate(REQ, h.deps)).toBe("rolled_back")
    expect(h.finished[0]!.metadata.failedStep).toBe("healthcheck")
  })

  it("a crash-looping container is detected after a few polls instead of waiting for the full timeout", async () => {
    const h = harness({
      handler: (a, _o, ctx) =>
        a.includes("ps") && readEnvVar(ctx.env, "APP_VERSION") === "1.2.0" ? { stdout: psJson(svc("web", "1.2.0", { State: "restarting", Health: "" }), svc("worker", "1.2.0")) } : undefined,
    })
    const t0 = h.ctx.t
    expect(await runUpdate(REQ, h.deps)).toBe("rolled_back")
    expect(h.finished[0]!.metadata.failedStep).toBe("healthcheck")
    // 3 polls x 5 s, then rollback health (stable 10 s): well under the 60 s health budget of this fake config
    expect(h.ctx.t - t0).toBeLessThan(50_000)
  })

  it("compose up fails after the env swap: rolled back", async () => {
    let n = 0
    const h = harness({ handler: (a) => (isUp(a) && ++n === 1 ? { code: 1 } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("rolled_back")
    expect(h.finished[0]!.metadata.failedStep).toBe("restart")
    expect(h.ctx.env).toBe(ENV0)
  })

  it("when .env had no APP_VERSION, rollback removes the line again", async () => {
    const h = harness({
      env: "A=1\n",
      handler: (a, _o, ctx) => (a.includes("ps") && readEnvVar(ctx.env, "APP_VERSION") === "1.2.0" ? { stdout: psJson(svc("web", "1.2.0", { State: "exited" }), svc("worker", "1.2.0")) } : undefined),
    })
    expect(await runUpdate(REQ, h.deps)).toBe("rolled_back")
    expect(h.ctx.env).toBe("A=1\n")
  })

  it("ROLLBACK ALSO FAILS: status failed (not rolled_back) with a clear manual-recovery message and the backup name", async () => {
    let ups = 0
    const h = harness({
      handler: (a, _o, ctx) => {
        if (isUp(a) && ++ups === 2) return { code: 1 }
        if (a.includes("ps") && readEnvVar(ctx.env, "APP_VERSION") === "1.2.0") return { stdout: psJson(svc("web", "1.2.0", { State: "exited" }), svc("worker", "1.2.0")) }
        return undefined
      },
    })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    const fin = h.finished[0]!
    expect(fin.status).toBe("failed")
    expect(fin.step).toBe("rollback")
    expect(fin.message).toContain("thủ công")
    expect(fin.message).toContain("backups/pre-update-")
    expect(fin.metadata).toMatchObject({ rollback: "failed" })
  })
})

describe("runUpdate: log hygiene", () => {
  it("never stores .env secrets or tokens, even when docker prints them", async () => {
    const h = harness({
      handler: (a) =>
        isMigrate(a)
          ? {
              code: 1,
              lines: [
                "error: connect postgres://adsmcp:pgS3cretPassw0rd@db:5432/adsmcp refused",
                "ENCRYPTION_KEYS=1:YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=",
                "BETTER_AUTH_SECRET=notInTheEnvFileButStillSecret",
                "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
                "pulled with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
              ],
            }
          : undefined,
    })
    await runUpdate(REQ, h.deps)
    const stored = JSON.stringify([h.finished, h.progress])
    for (const secret of ["pgS3cretPassw0rd", "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU", "notInTheEnvFileButStillSecret", "abcdefghijklmnopqrstuvwxyz0123456789"]) {
      expect(stored, secret).not.toContain(secret)
    }
    expect(h.finished[0]!.log).toContain("[redacted]")
    // the plain .env text is never echoed
    expect(stored).not.toContain("APP_DOMAIN=ads.example.com")
  })

  it("keeps the stored log tail within 64 KB however chatty docker is", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `layer ${i} ${"a".repeat(80)}`)
    const h = harness({ handler: (a) => (a[0] === "pull" ? { lines } : undefined) })
    await runUpdate(REQ, h.deps)
    const fin = h.finished[0]!
    expect(Buffer.byteLength(fin.log)).toBeLessThanOrEqual(MAX_LOG_BYTES)
    expect(fin.log).toContain("Kết thúc: succeeded")
    for (const p of h.progress) if (p.log) expect(Buffer.byteLength(p.log)).toBeLessThanOrEqual(MAX_LOG_BYTES)
  })

  it("messages are short single lines", async () => {
    const h = harness({ handler: (a) => (isMigrate(a) ? { code: 1 } : undefined) })
    await runUpdate(REQ, h.deps)
    expect(h.finished[0]!.message.length).toBeLessThanOrEqual(500)
    expect(h.finished[0]!.message).not.toContain("\n")
  })
})

describe("runUpdate: image signature (cosign)", () => {
  const cosignCalls = (h: ReturnType<typeof harness>) => h.ctx.calls.filter((c) => c.cmd === "cosign")
  const failedBeforeSwap = (h: ReturnType<typeof harness>) => {
    expect(h.finished[0]!.status).toBe("failed")
    expect(h.finished[0]!.step).toBe("pull")
    expect(h.writes).toHaveLength(0)
    expect(h.ctx.env).toBe(ENV0)
    expect(h.ctx.calls.some((c) => isMigrate(c.args) || isUp(c.args))).toBe(false)
  }

  it("verifies the pulled digest against the exact tag identity, with a TUF cache in /tmp and no secrets", async () => {
    const h = harness()
    expect(await runUpdate(REQ, h.deps)).toBe("succeeded")
    const [c, ...more] = cosignCalls(h)
    expect(more).toHaveLength(0)
    expect(c!.args).toEqual(["verify", "--certificate-identity", `${SIGNER}v1.2.0`, "--certificate-oidc-issuer", ISSUER, `${IMAGE}@${DIGEST}`])
    expect(c!.opts.env).toEqual({ PATH: "/usr/bin", PWD: DIR, TUF_ROOT: "/tmp/sigstore-tuf" })
    expect(c!.opts.timeoutMs).toBeGreaterThanOrEqual(60_000)
    expect(h.finished[0]!.log).toContain("Đã xác minh chữ ký số")
  })

  it("an unsigned image (or one signed for another tag) is refused at the pull step; .env untouched, no migrate", async () => {
    const h = harness({ handler: (_a, _o, _c, cmd) => (cmd === "cosign" ? { code: 1, lines: ["Error: no matching signatures: none of the expected identities matched"] } : undefined) })
    expect(await runUpdate(REQ, h.deps)).toBe("failed")
    failedBeforeSwap(h)
    const msg = h.finished[0]!.message
    expect(msg).toContain("chữ ký số")
    expect(msg).toContain("v1.2.0")
    expect(msg).toContain("UPDATER_VERIFY_SIGNATURE=0")
    expect(msg).toMatch(/không bị ảnh hưởng/)
    expect(msg.length).toBeLessThanOrEqual(500)
    expect(h.finished[0]!.log).toContain("no matching signatures")
  })

  it("cosign missing / Sigstore unreachable fails closed", async () => {
    for (const res of [{ code: null, error: "spawn cosign ENOENT" }, { code: null, timedOut: true }]) {
      const h = harness({ handler: (_a, _o, _c, cmd) => (cmd === "cosign" ? res : undefined) })
      expect(await runUpdate(REQ, h.deps)).toBe("failed")
      failedBeforeSwap(h)
    }
  })

  it("an image without a registry digest of this repository is refused without calling cosign", async () => {
    for (const stdout of ["[]\n", `${JSON.stringify([`evil.example/ads@${DIGEST}`])}\n`]) {
      const h = harness({ handler: (a) => (isDigestInspect(a) ? { stdout } : undefined) })
      expect(await runUpdate(REQ, h.deps)).toBe("failed")
      failedBeforeSwap(h)
      expect(cosignCalls(h)).toHaveLength(0)
    }
  })

  it("passes when one of several recorded digests is signed", async () => {
    const h = harness({
      handler: (a, _o, _c, cmd) => {
        if (isDigestInspect(a)) return { stdout: JSON.stringify([`${IMAGE}@${DIGEST2}`, `${IMAGE}@${DIGEST}`]) }
        if (cmd === "cosign" && a[a.length - 1]!.endsWith(DIGEST2)) return { code: 1 }
        return undefined
      },
    })
    expect(await runUpdate(REQ, h.deps)).toBe("succeeded")
    expect(cosignCalls(h)).toHaveLength(2)
  })

  it("is skipped (with a log note) for a fork / local registry image", async () => {
    const img = "localhost:5000/ads-mcp"
    const h = harness({
      image: img,
      handler: (a, _o, ctx) => (a.includes("ps") ? { stdout: psJson({ ...svc("web", "x"), Image: `${img}:${readEnvVar(ctx.env, "APP_VERSION")}` }, { ...svc("worker", "x"), Image: `${img}:${readEnvVar(ctx.env, "APP_VERSION")}` }) } : undefined),
    })
    expect(await runUpdate(REQ, h.deps)).toBe("succeeded")
    expect(cosignCalls(h)).toHaveLength(0)
    expect(h.finished[0]!.log).toContain("Bỏ qua xác minh chữ ký số")
  })

  it("is skipped when the operator set UPDATER_VERIFY_SIGNATURE=0 in .env", async () => {
    const h = harness({ env: `${ENV0}UPDATER_VERIFY_SIGNATURE=0\n` })
    expect(await runUpdate(REQ, h.deps)).toBe("succeeded")
    expect(cosignCalls(h)).toHaveLength(0)
    expect(h.finished[0]!.log).toContain("UPDATER_VERIFY_SIGNATURE=0")
  })
})

describe("recreateUpdater (self update)", () => {
  it("skips when the running updater already has the target version", async () => {
    const h = harness()
    expect(await recreateUpdater(h.deps, "1.1.0", () => {})).toBe("skipped")
    expect(h.ctx.calls).toHaveLength(0)
  })

  it("pulls the new updater image, verifies its signature, then starts a helper container that recreates it (args array, no shell)", async () => {
    const h = harness()
    expect(await recreateUpdater(h.deps, "1.2.0", () => {})).toBe("started")
    const [pull, digests, cosign, rm, run] = h.ctx.calls.map((c) => c.args)
    expect(pull).toEqual(["compose", "--project-directory", DIR, "-f", `${DIR}/docker-compose.yml`, "pull", "updater"])
    expect(digests).toEqual(["image", "inspect", "--format", "{{json .RepoDigests}}", `${IMAGE}-updater:1.2.0`])
    expect(h.ctx.calls[2]!.cmd).toBe("cosign")
    expect(cosign).toEqual(["verify", "--certificate-identity", `${SIGNER}v1.2.0`, "--certificate-oidc-issuer", ISSUER, `${IMAGE}-updater@${DIGEST}`])
    expect(rm).toEqual(["rm", "-f", SELF_UPDATE_HELPER])
    expect(run!.slice(0, 5)).toEqual(["run", "-d", "--rm", "--name", SELF_UPDATE_HELPER])
    expect(run).toContain(`${IMAGE}-updater:1.2.0`)
    expect(run!.slice(-7)).toEqual(["--project-directory", DIR, "up", "-d", "--no-deps", "--force-recreate", "updater"])
    expect(run).toContain(`${DIR}:${DIR}`)
  })

  it("keeps the current updater when the new updater image is not signed for the tag (no helper container)", async () => {
    const h = harness({ handler: (_a, _o, _c, cmd) => (cmd === "cosign" ? { code: 1, lines: ["Error: no matching signatures"] } : undefined) })
    const said: string[] = []
    expect(await recreateUpdater(h.deps, "1.2.0", (l) => said.push(l))).toBe("failed")
    expect(h.ctx.calls.some((c) => c.args[0] === "run" || c.args[0] === "rm")).toBe(false)
    expect(said.join("\n")).toContain("giữ updater hiện tại")
  })

  it("self update skips the signature check for a fork image or UPDATER_VERIFY_SIGNATURE=0", async () => {
    for (const h of [harness({ image: "localhost:5000/ads-mcp" }), harness({ env: `${ENV0}UPDATER_VERIFY_SIGNATURE=0\n` })]) {
      expect(await recreateUpdater(h.deps, "1.2.0", () => {})).toBe("started")
      expect(h.ctx.calls.some((c) => c.cmd === "cosign")).toBe(false)
    }
  })

  it("self update verifies when .env cannot be read", async () => {
    const h = harness({ handler: (_a, _o, _c, cmd) => (cmd === "cosign" ? { code: 1 } : undefined) })
    h.deps.files.readEnv = () => {
      throw new Error("ENOENT")
    }
    expect(await recreateUpdater(h.deps, "1.2.0", () => {})).toBe("failed")
  })

  it("keeps the current updater when the new image cannot be pulled", async () => {
    const h = harness({ handler: (a) => (a.includes("pull") && a.includes("updater") ? { code: 1 } : undefined) })
    expect(await recreateUpdater(h.deps, "1.2.0", () => {})).toBe("failed")
    expect(h.ctx.calls.some((c) => c.args[0] === "run")).toBe(false)
  })
})
