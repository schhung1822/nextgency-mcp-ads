import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  LogBuffer,
  MAX_LOG_BYTES,
  backupFileName,
  checkTargetVersion,
  collectSecretValues,
  compareSemver,
  evaluateHealth,
  isValidImageName,
  makeRedactor,
  parseComposePs,
  parseSemver,
  readEnvVar,
  repoDigestsFor,
  setEnvVar,
  signatureMode,
  signerIdentity,
  writeFileAtomicKeepMode,
} from "./updater-core"

describe("semver", () => {
  it("parses only strict x.y.z", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3])
    for (const bad of ["1.2", "v1.2.3", "1.2.3-rc.1", "01.2.3", "1.2.3 ", "1.2.3; rm -rf /", "", "latest", "dev", "1.2.3\n", "1.2.99999999999999999999"]) {
      expect(parseSemver(bad), bad).toBeNull()
    }
    expect(parseSemver(123 as unknown)).toBeNull()
  })

  it("compares numerically, not lexically", () => {
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareSemver("2.0.0", "10.0.0")).toBeLessThan(0)
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0)
  })

  it("target must be strictly newer than every known semver version; non-semver current is ignored", () => {
    expect(checkTargetVersion("1.2.0", ["1.1.0", "1.1.5"])).toEqual({ ok: true })
    expect(checkTargetVersion("1.2.0", ["dev", null, "latest", ""])).toEqual({ ok: true })
    expect(checkTargetVersion("1.2.0", ["1.2.0"]).ok).toBe(false)
    expect(checkTargetVersion("1.2.0", ["1.3.0"]).ok).toBe(false)
    expect(checkTargetVersion("1.2.0", ["1.1.0", "v1.2.0"]).ok).toBe(false) // .env may carry a leading v
    expect(checkTargetVersion("1.2.0-rc.1", []).ok).toBe(false)
    expect(checkTargetVersion("1.2.0 && curl evil", []).ok).toBe(false)
    expect(checkTargetVersion(undefined, []).ok).toBe(false)
  })
})

describe("image signature helpers", () => {
  const D1 = `sha256:${"a".repeat(64)}`
  const D2 = `sha256:${"b".repeat(64)}`

  it("binds the signer identity to the exact release tag of the official repo", () => {
    expect(signerIdentity("1.2.3")).toBe("https://github.com/notivn/Ads-MCP-simple/.github/workflows/docker.yml@refs/tags/v1.2.3")
    for (const bad of ["v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3@refs/heads/x", ""]) expect(() => signerIdentity(bad), bad).toThrow()
  })

  it("extracts distinct registry digests of the given repository only", () => {
    const img = "ghcr.io/notivn/ads-mcp-simple"
    const json = JSON.stringify([`${img}@${D1}`, `${img}-updater@${D2}`, `${img}@${D1}`, `evil.io/x@${D2}`, `${img}@sha256:short`, `${img}@${D2.toUpperCase()}`, 42])
    expect(repoDigestsFor(json, img)).toEqual([D1])
    expect(repoDigestsFor(json, `${img}-updater`)).toEqual([D2])
    for (const bad of ["", "null", "[]", "{}", "not json", "<no value>"]) expect(repoDigestsFor(bad, img), bad).toEqual([])
  })

  it("verifies only the official image unless the .env switch is exactly 0", () => {
    const img = "ghcr.io/notivn/ads-mcp-simple"
    expect(signatureMode(img, "A=1\n")).toBe("verify")
    expect(signatureMode(img, "UPDATER_VERIFY_SIGNATURE=1\n")).toBe("verify")
    expect(signatureMode(img, "UPDATER_VERIFY_SIGNATURE=false\n")).toBe("verify")
    expect(signatureMode(img, "# UPDATER_VERIFY_SIGNATURE=0\n")).toBe("verify")
    expect(signatureMode(img, "UPDATER_VERIFY_SIGNATURE=0\n")).toBe("skip-env")
    expect(signatureMode("localhost:5000/ads-mcp", "")).toBe("skip-image")
  })
})

describe("image name", () => {
  it("accepts registry repositories, rejects tags, spaces and shell characters", () => {
    expect(isValidImageName("ghcr.io/notivn/ads-mcp-simple")).toBe(true)
    expect(isValidImageName("registry.local:5000/team/ads-mcp")).toBe(true)
    for (const bad of ["ads-mcp", "ghcr.io/notivn/ads-mcp:1.2.3", "ghcr.io/x/y z", "ghcr.io/x/y;id", "-v/x:/y", "GHCR.io/Foo/Bar", "ghcr.io//x", ""]) {
      expect(isValidImageName(bad), bad).toBe(false)
    }
  })
})

describe("setEnvVar / readEnvVar", () => {
  const BASE = ["# comment", "APP_DOMAIN=ads.example.com", "# APP_VERSION=0.0.1", "SETUP_TOKEN=abc", "APP_VERSION=1.0.0", "", "KEEP=  spaced value  ", ""].join("\n")

  it("changes exactly one line and keeps every other byte", () => {
    const out = setEnvVar(BASE, "APP_VERSION", "1.2.0")
    expect(out).toBe(BASE.replace("\nAPP_VERSION=1.0.0\n", "\nAPP_VERSION=1.2.0\n"))
    const diff = out.split("\n").filter((l, i) => l !== BASE.split("\n")[i])
    expect(diff).toEqual(["APP_VERSION=1.2.0"])
  })

  it("leaves commented lines alone and appends when the key is absent", () => {
    const src = "A=1\n# APP_VERSION=9.9.9\nB=2\n"
    const out = setEnvVar(src, "APP_VERSION", "1.2.0")
    expect(out).toBe("A=1\n# APP_VERSION=9.9.9\nB=2\nAPP_VERSION=1.2.0\n")
    expect(setEnvVar("A=1", "APP_VERSION", "1.2.0")).toBe("A=1\nAPP_VERSION=1.2.0\n")
    expect(setEnvVar("", "APP_VERSION", "1.2.0")).toBe("APP_VERSION=1.2.0\n")
  })

  it("keeps CRLF files CRLF and handles quoted old values", () => {
    const src = "A=1\r\nAPP_VERSION=\"1.0.0\"\r\nB=2\r\n"
    expect(setEnvVar(src, "APP_VERSION", "1.2.0")).toBe("A=1\r\nAPP_VERSION=1.2.0\r\nB=2\r\n")
    expect(setEnvVar("A=1\r\nB=2", "APP_VERSION", "1.2.0")).toBe("A=1\r\nB=2\r\nAPP_VERSION=1.2.0\r\n")
  })

  it("updates duplicates and can remove the key (rollback when it was not set before)", () => {
    expect(setEnvVar("APP_VERSION=1\nX=1\nAPP_VERSION=2\n", "APP_VERSION", "3.0.0")).toBe("APP_VERSION=3.0.0\nX=1\nAPP_VERSION=3.0.0\n")
    expect(setEnvVar("A=1\nAPP_VERSION=1.0.0\nB=2\n", "APP_VERSION", null)).toBe("A=1\nB=2\n")
    expect(setEnvVar("A=1\nB=2\n", "APP_VERSION", null)).toBe("A=1\nB=2\n")
  })

  it("rejects values that could inject lines or shell syntax, and bad keys", () => {
    for (const bad of ["1.2.0\nEVIL=1", "1.2.0 ", "$(id)", "a b", "", "x".repeat(65)]) {
      expect(() => setEnvVar("A=1\n", "APP_VERSION", bad), bad).toThrow()
    }
    expect(() => setEnvVar("A=1\n", "app_version", "1.0.0")).toThrow()
    expect(() => readEnvVar("A=1\n", "A=1|.*")).toThrow()
  })

  it("reads the active value", () => {
    expect(readEnvVar(BASE, "APP_VERSION")).toBe("1.0.0")
    expect(readEnvVar("APP_VERSION=\n", "APP_VERSION")).toBeNull()
    expect(readEnvVar("APP_VERSION='v1.1.0'\n", "APP_VERSION")).toBe("v1.1.0")
    expect(readEnvVar("# APP_VERSION=1\n", "APP_VERSION")).toBeNull()
  })
})

describe("writeFileAtomicKeepMode", () => {
  let dir = ""
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it("replaces the file atomically, keeps a .bak of the old content, leaves no temp file", () => {
    dir = mkdtempSync(join(tmpdir(), "updater-env-"))
    const p = join(dir, ".env")
    writeFileSync(p, "A=1\nAPP_VERSION=1.0.0\n", { mode: 0o600 })
    writeFileAtomicKeepMode(p, "A=1\nAPP_VERSION=1.2.0\n")
    expect(readFileSync(p, "utf8")).toBe("A=1\nAPP_VERSION=1.2.0\n")
    expect(readFileSync(p + ".bak", "utf8")).toBe("A=1\nAPP_VERSION=1.0.0\n")
    expect(readdirSync(dir).sort()).toEqual([".env", ".env.bak"])
    if (process.platform !== "win32") {
      expect(statSync(p).mode & 0o777).toBe(0o600)
      expect(statSync(p + ".bak").mode & 0o777).toBe(0o600)
    }
  })

  it("does not touch .bak when backups are off (rollback keeps the original)", () => {
    dir = mkdtempSync(join(tmpdir(), "updater-env-"))
    const p = join(dir, ".env")
    writeFileSync(p, "ORIGINAL\n")
    writeFileAtomicKeepMode(p, "NEW\n")
    writeFileAtomicKeepMode(p, "ROLLED\n", { backupSuffix: null })
    expect(readFileSync(p + ".bak", "utf8")).toBe("ORIGINAL\n")
    expect(readFileSync(p, "utf8")).toBe("ROLLED\n")
  })

  it("throws (and writes nothing) when the file is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "updater-env-"))
    expect(() => writeFileAtomicKeepMode(join(dir, ".env"), "X=1\n")).toThrow()
    expect(existsSync(join(dir, ".env"))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe("redaction", () => {
  const ENV = [
    "POSTGRES_PASSWORD=pgS3cretPassw0rd",
    "DATABASE_URL=postgres://adsmcp:pgS3cretPassw0rd@db:5432/adsmcp",
    "BETTER_AUTH_SECRET=ZmFrZS1hdXRoLXNlY3JldC1mb3ItdGVzdHM=",
    "ENCRYPTION_KEYS=1:YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=",
    "SETUP_TOKEN=setupTokenValue12345",
    "APP_DOMAIN=ads.example.com",
    "UPDATE_GITHUB_TOKEN=github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
  ].join("\n")
  const redact = makeRedactor(collectSecretValues(ENV))

  it("masks every secret value taken from .env, even inside other text", () => {
    const out = redact("connect failed for postgres://adsmcp:pgS3cretPassw0rd@db:5432/adsmcp; key=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU= token setupTokenValue12345")
    expect(out).not.toMatch(/pgS3cretPassw0rd|YWJjZGVm|setupTokenValue12345/)
  })

  it("masks KEY=value lines, URL passwords, bearer/GitHub tokens and auth headers by pattern", () => {
    const lines = [
      "MCP_KEY_PEPPER=somethingElseNotInEnvFile999",
      "using postgres://user:hunter2hunter2@host:5432/db",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "token=eyJhbGciOiJIUzI1NiJ9.payload.signature",
    ]
    const out = lines.map((l) => makeRedactor()(l)).join("\n")
    expect(out).not.toMatch(/somethingElse|hunter2|abcdefghijklmnop|eyJhbGci/)
    expect(out).toContain("[redacted]")
  })

  it("does not mangle ordinary log text", () => {
    const text = "Status: Downloaded newer image for ghcr.io/notivn/ads-mcp-simple:1.2.0"
    expect(redact(text)).toBe(text)
    expect(redact("APP_DOMAIN is ads.example.com")).toContain("ads.example.com")
  })

  it("ignores very short values (would blank unrelated text)", () => {
    expect(collectSecretValues("A_TOKEN=abc\nB_KEY=12345\n")).toEqual([])
  })
})

describe("LogBuffer", () => {
  it("redacts on add and keeps only the last 64 KB", () => {
    const buf = new LogBuffer(makeRedactor(["topsecretvalue"]))
    buf.add("hello topsecretvalue world")
    expect(buf.tail()).toBe("hello [redacted] world")
    for (let i = 0; i < 5000; i++) buf.add(`line ${i} ${"x".repeat(100)}`)
    const tail = buf.tail()
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX_LOG_BYTES)
    expect(tail).toContain("line 4999")
    expect(tail).not.toContain("hello")
  })

  it("keeps working with a single huge line and multibyte text", () => {
    const buf = new LogBuffer((s) => s, 1000)
    buf.add("đ".repeat(3000))
    expect(Buffer.byteLength(buf.tail())).toBeLessThanOrEqual(1000)
    buf.add("tiếng Việt có dấu")
    expect(buf.tail()).toContain("tiếng Việt có dấu")
  })
})

describe("compose ps + health decision", () => {
  const IMG = "ghcr.io/notivn/ads-mcp-simple"
  const web = (o: object = {}) => ({ Service: "web", State: "running", Health: "healthy", Image: `${IMG}:1.2.0`, ...o })
  const worker = (o: object = {}) => ({ Service: "worker", State: "running", Health: "", Image: `${IMG}:1.2.0`, ...o })

  it("parses both an array and NDJSON", () => {
    expect(parseComposePs(JSON.stringify([web(), worker()]))).toHaveLength(2)
    expect(parseComposePs(`${JSON.stringify(web())}\n${JSON.stringify(worker())}\n`)).toHaveLength(2)
    expect(parseComposePs("")).toEqual([])
    expect(parseComposePs("not json\n{broken")).toEqual([])
  })

  it("ready only when web is healthy, worker runs and both use the expected tag", () => {
    expect(evaluateHealth([web(), worker()], "1.2.0")).toEqual({ state: "ready" })
    expect(evaluateHealth([web(), worker()], null)).toEqual({ state: "ready" })
    expect(evaluateHealth([web({ Health: "starting" }), worker()], "1.2.0").state).toBe("pending")
    expect(evaluateHealth([web({ Image: `${IMG}:1.1.0` }), worker()], "1.2.0").state).toBe("pending")
    expect(evaluateHealth([web(), worker({ State: "restarting" })], "1.2.0")).toMatchObject({ state: "pending", restarting: true })
    expect(evaluateHealth([web()], "1.2.0").state).toBe("pending")
  })

  it("fails fast when a container stopped or web is unhealthy", () => {
    expect(evaluateHealth([web({ State: "exited", ExitCode: 1 }), worker()], "1.2.0").state).toBe("failed")
    expect(evaluateHealth([web({ Health: "unhealthy" }), worker()], "1.2.0").state).toBe("failed")
    expect(evaluateHealth([web(), worker({ State: "exited", ExitCode: 137 })], "1.2.0").state).toBe("failed")
  })
})

describe("backupFileName", () => {
  it("uses UTC and the pre-update- prefix", () => {
    expect(backupFileName(new Date("2026-10-03T10:15:09Z"))).toBe("pre-update-20261003-101509.dump")
  })
})
