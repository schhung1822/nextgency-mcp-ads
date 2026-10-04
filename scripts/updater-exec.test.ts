// spawnExec against real child processes (node itself - works on Windows and Linux).
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { spawnExec } from "./updater-exec"

const NODE = process.execPath
const base = { env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" }, timeoutMs: 20_000 }
let dir = ""
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

describe("spawnExec", () => {
  it("passes args as an array (no shell interpretation) and reports the exit code", async () => {
    const lines: string[] = []
    const r = await spawnExec(NODE, ["-e", "console.log(process.argv[1]); process.exit(3)", "a b; echo pwned $(id) `x`"], { ...base, onLine: (l) => lines.push(l) })
    expect(r.code).toBe(3)
    expect(r.timedOut).toBe(false)
    expect(lines).toEqual(["a b; echo pwned $(id) `x`"])
  })

  it("splits stdout and stderr into lines, including a last line without newline", async () => {
    const got: Array<[string, string]> = []
    await spawnExec(NODE, ["-e", "process.stdout.write('one\\ntwo'); process.stderr.write('err\\n')"], { ...base, onLine: (l, s) => got.push([s, l]) })
    expect(got).toContainEqual(["stdout", "one"])
    expect(got).toContainEqual(["stdout", "two"])
    expect(got).toContainEqual(["stderr", "err"])
  })

  it("does not inherit process.env: the child only sees what the caller passes", async () => {
    process.env.UPDATER_TEST_SECRET = "should-not-leak"
    const r = await spawnExec(NODE, ["-e", "process.stdout.write(String(process.env.UPDATER_TEST_SECRET))"], { ...base, capture: true })
    delete process.env.UPDATER_TEST_SECRET
    expect(r.stdout).toBe("undefined")
  })

  it("captures stdout when asked", async () => {
    const r = await spawnExec(NODE, ["-e", "process.stdout.write('hello')"], { ...base, capture: true })
    expect(r.stdout).toBe("hello")
  })

  it("streams stdout into a file (mode 0600) and feeds a file to stdin", async () => {
    dir = mkdtempSync(join(tmpdir(), "updater-exec-"))
    const out = join(dir, "out.bin")
    const r = await spawnExec(NODE, ["-e", "process.stdout.write(Buffer.from([1,2,3,250,251]))"], { ...base, stdoutFile: out })
    expect(r.code).toBe(0)
    expect([...readFileSync(out)]).toEqual([1, 2, 3, 250, 251])
    if (process.platform !== "win32") expect(statSync(out).mode & 0o777).toBe(0o600)

    const inp = join(dir, "in.txt")
    writeFileSync(inp, "from-file")
    const r2 = await spawnExec(NODE, ["-e", "process.stdin.pipe(process.stdout)"], { ...base, stdinFile: inp, capture: true })
    expect(r2.stdout).toBe("from-file")
  })

  it("kills a command that exceeds its timeout", async () => {
    const t0 = Date.now()
    const r = await spawnExec(NODE, ["-e", "setInterval(()=>{},1000)"], { ...base, timeoutMs: 400 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(8000)
  })

  it("reports a missing binary instead of throwing", async () => {
    const r = await spawnExec("definitely-not-a-binary-xyz", [], base)
    expect(r.code).toBeNull()
    expect(r.error).toBe("ENOENT")
  })
})
