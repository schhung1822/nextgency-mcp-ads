// gen-env.mjs: APP_VERSION is always written (docker-compose.yml has no `latest` fallback) and .env is 0600.
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const SCRIPT = resolve(import.meta.dirname, "gen-env.mjs")
const EXAMPLE = resolve(import.meta.dirname, "..", ".env.example")

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gen-env-"))
  dirs.push(dir)
  copyFileSync(EXAMPLE, join(dir, ".env.example"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version }, null, 2))
  return dir
}

function gen(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, HOST_PROJECT_DIR: "/opt/ads-mcp" },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const line = (env: string, key: string) => env.split("\n").find((l) => l.startsWith(`${key}=`))

describe("gen-env.mjs", () => {
  it("production: APP_VERSION from package.json, secrets and DATABASE_URL generated", () => {
    const r = gen(project("1.0.2"), "--print", "--domain", "mcp.congty.vn", "--email", "it@congty.vn")
    expect(r.code).toBe(0)
    expect(line(r.out, "APP_VERSION")).toBe("APP_VERSION=1.0.2")
    const pg = line(r.out, "POSTGRES_PASSWORD")!.slice("POSTGRES_PASSWORD=".length)
    expect(pg.length).toBeGreaterThanOrEqual(20)
    expect(line(r.out, "DATABASE_URL")).toBe(`DATABASE_URL=postgres://adsmcp:${pg}@db:5432/adsmcp`)
    expect(r.out).not.toContain("change-me")
  })

  it("--app-version overrides package.json (a leading v is accepted)", () => {
    const r = gen(project("1.0.2"), "--print", "--app-version", "v1.3.0")
    expect(r.code).toBe(0)
    expect(line(r.out, "APP_VERSION")).toBe("APP_VERSION=1.3.0")
  })

  it("--dev writes APP_VERSION=dev", () => {
    const r = gen(project("1.0.2"), "--print", "--dev")
    expect(r.code).toBe(0)
    expect(line(r.out, "APP_VERSION")).toBe("APP_VERSION=dev")
  })

  it("refuses to produce an empty APP_VERSION in production", () => {
    for (const [version, args] of [
      ["1.2.3-rc.1", []],
      ["1.0.2", ["--app-version", "latest"]],
      ["1.0.2", ["--app-version", "1.2"]],
    ] as const) {
      const r = gen(project(version), "--print", ...args)
      expect(r.code, `${version} ${args.join(" ")}`).toBe(1)
      expect(r.out).toBe("")
    }
  })

  it.skipIf(process.platform === "win32")("writes .env with mode 0600, also when --force overwrites a 0644 file", () => {
    const dir = project("1.0.2")
    writeFileSync(join(dir, ".env"), "OLD=1\n", { mode: 0o644 })
    expect(gen(dir, "--force").code).toBe(0)
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600)
    expect(line(readFileSync(join(dir, ".env"), "utf8"), "APP_VERSION")).toBe("APP_VERSION=1.0.2")
  })
})
