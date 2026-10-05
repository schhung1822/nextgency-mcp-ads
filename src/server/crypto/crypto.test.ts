import { randomBytes } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertMcpKeyPepper,
  generateMcpKey,
  hashMcpKey,
  isWellFormedMcpKey,
  mcpKeyPrefix,
} from "./mcp-key"
import {
  __setKeyRing,
  aad,
  assertKeyRing,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  needsReencrypt,
} from "./secret-box"

const k1 = randomBytes(32).toString("base64")
const k2 = randomBytes(32).toString("base64")

afterEach(() => {
  __setKeyRing(undefined)
  vi.unstubAllEnvs()
})

describe("secret-box", () => {
  it("round-trips with AAD", () => {
    __setKeyRing(`1:${k1}`)
    const c = encryptSecret("EAAsecret-token", aad.connectionCredentials("abc"))
    expect(c.startsWith("v1.")).toBe(true)
    expect(decryptSecret(c, aad.connectionCredentials("abc"))).toBe(
      "EAAsecret-token"
    )
  })
  it("fails with a different AAD (no ciphertext swapping between rows)", () => {
    __setKeyRing(`1:${k1}`)
    const c = encryptSecret("x", aad.connectionCredentials("a"))
    expect(() => decryptSecret(c, aad.connectionCredentials("b"))).toThrow()
  })
  it("supports key rotation", () => {
    __setKeyRing(`1:${k1}`)
    const old = encryptJson({ apiKey: "k" }, "t")
    __setKeyRing(`2:${k2},1:${k1}`)
    expect(needsReencrypt(old)).toBe(true)
    expect(decryptJson<{ apiKey: string }>(old, "t").apiKey).toBe("k")
    expect(encryptSecret("y", "t").startsWith("v2.")).toBe(true)
  })
  it("rejects malformed key rings", () => {
    expect(() => __setKeyRing("1:short")).toThrow()
    expect(() => __setKeyRing("")).toThrow()
  })
  it("assertKeyRing validates ENCRYPTION_KEYS at startup without leaking key material", () => {
    vi.stubEnv("ENCRYPTION_KEYS", `1:${k1}`)
    expect(() => assertKeyRing()).not.toThrow()
    for (const bad of ["1:", "1:c2hvcnQ=", "", "x:" + k1, `1:${k1},1:${k2}`]) {
      __setKeyRing(undefined)
      vi.stubEnv("ENCRYPTION_KEYS", bad)
      let msg = ""
      try {
        assertKeyRing()
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg, bad).toMatch(/ENCRYPTION_KEYS/)
      expect(msg).not.toContain(k1)
      expect(msg).not.toContain("c2hvcnQ=")
    }
  })
  it("rejects truncated or oversized GCM tags (no short-tag forgery)", () => {
    __setKeyRing(`1:${k1}`)
    const c = encryptSecret("secret", "t")
    const [v, iv, tag, ct] = c.split(".") as [string, string, string, string]
    const full = Buffer.from(tag, "base64url")
    expect(full.length).toBe(16)
    for (const bad of [full.subarray(0, 4), full.subarray(0, 12), Buffer.concat([full, Buffer.from([0])])]) {
      expect(() => decryptSecret([v, iv, bad.toString("base64url"), ct].join("."), "t")).toThrow()
    }
    // a wrong IV length is refused too
    expect(() => decryptSecret([v, Buffer.alloc(8).toString("base64url"), tag, ct].join("."), "t")).toThrow()
    expect(decryptSecret(c, "t")).toBe("secret")
  })
  it("uses a fresh IV each time", () => {
    __setKeyRing(`1:${k1}`)
    expect(encryptSecret("same", "t")).not.toBe(encryptSecret("same", "t"))
  })
})

describe("mcp key", () => {
  it("generates well-formed keys and stable hashes", () => {
    const key = generateMcpKey()
    expect(isWellFormedMcpKey(key)).toBe(true)
    expect(mcpKeyPrefix(key)).toHaveLength(12)
    expect(hashMcpKey(key)).toBe(hashMcpKey(key))
    expect(hashMcpKey(key)).not.toBe(hashMcpKey(generateMcpKey()))
  })
  it("assertMcpKeyPepper requires a pepper of at least 32 bytes", () => {
    vi.stubEnv("MCP_KEY_PEPPER", randomBytes(32).toString("base64"))
    expect(() => assertMcpKeyPepper()).not.toThrow()
    vi.stubEnv("MCP_KEY_PEPPER", "")
    expect(() => assertMcpKeyPepper()).toThrow(/MCP_KEY_PEPPER/)
    const short = randomBytes(24).toString("base64")
    vi.stubEnv("MCP_KEY_PEPPER", short)
    expect(() => assertMcpKeyPepper()).toThrow(/MCP_KEY_PEPPER/)
  })
  it("rejects malformed keys", () => {
    expect(isWellFormedMcpKey("amcp_short")).toBe(false)
    expect(isWellFormedMcpKey("../../etc/passwd")).toBe(false)
  })
})
