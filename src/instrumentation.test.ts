// Production startup checks in register(): an unusable ENCRYPTION_KEYS / MCP_KEY_PEPPER stops the server
// before the first request (instead of failing on the first decrypt / MCP call). Fresh modules per test so the
// cached env() / key ring of other tests never leaks in.
import { randomBytes } from "node:crypto"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./server/audit/mcp-log-writer", () => ({ registerMcpLogShutdownHooks: vi.fn() }))

const KEY = randomBytes(32).toString("base64")

async function register() {
  const mod = await import("./instrumentation")
  return mod.register()
}

// warm the transform cache once (cold dynamic imports can be slow on a busy machine)
beforeAll(async () => {
  await import("./instrumentation")
  await Promise.all([import("./server/env"), import("./server/crypto/secret-box"), import("./server/crypto/mcp-key")])
}, 120_000)

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("NEXT_RUNTIME", "nodejs")
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("BETTER_AUTH_URL", "https://ads.example.com")
  vi.stubEnv("DATABASE_URL", "postgres://adsmcp:pw@db:5432/adsmcp")
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40))
  vi.stubEnv("SETUP_TOKEN", "")
  vi.stubEnv("ENCRYPTION_KEYS", `1:${KEY}`)
  vi.stubEnv("MCP_KEY_PEPPER", randomBytes(32).toString("base64"))
})
afterEach(() => vi.unstubAllEnvs())

describe("instrumentation register() in production", () => {
  it("starts with a valid configuration", async () => {
    await expect(register()).resolves.toBeUndefined()
  })

  it("refuses a malformed ENCRYPTION_KEYS without echoing key material", async () => {
    vi.stubEnv("ENCRYPTION_KEYS", "1:c2hvcnQta2V5")
    const err = await register().then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(err?.message).toMatch(/ENCRYPTION_KEYS/)
    expect(err?.message).not.toContain("c2hvcnQta2V5")
  })

  it("refuses an MCP_KEY_PEPPER shorter than 32 bytes", async () => {
    // 32 base64 characters pass the length check of env() but decode to only 24 bytes
    vi.stubEnv("MCP_KEY_PEPPER", randomBytes(24).toString("base64"))
    await expect(register()).rejects.toThrow(/MCP_KEY_PEPPER/)
  })
})
