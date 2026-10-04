import { describe, expect, it } from "vitest"
import { capJson } from "./cap-json"
import { isSecretKeyName, redact, redactString, redactUrl } from "./redact"

describe("redact", () => {
  it("redacts secret-named keys at any depth", () => {
    const out = redact({
      a: { access_token: "abc", apiKey: "k", nested: [{ client_secret: "s" }] },
      name: "ok",
    }) as any
    expect(out.a.access_token).toBe("[redacted]")
    expect(out.a.apiKey).toBe("[redacted]")
    expect(out.a.nested[0].client_secret).toBe("[redacted]")
    expect(out.name).toBe("ok")
  })
  it("redacts known token shapes inside strings", () => {
    const s = redactString(
      "token EAABwzLixnjYBO1234567890abcdefghij and sk-proj-abcdefghijklmnopqrstuvwxyz and https://x/mcp/amcp_" +
        "A".repeat(43) +
        " Bearer abcdefghijklmnopqrstuvwxyz ?access_token=zzz&x=1"
    )
    expect(s).not.toMatch(/EAABwz/)
    expect(s).not.toMatch(/sk-proj-abc/)
    expect(s).not.toMatch(/AAAAAAAAAAAAAAAAAAAA/)
    expect(s).not.toMatch(/Bearer abcdef/)
    expect(s).not.toMatch(/access_token=zzz/)
  })
  it("redacts GitHub tokens (fine-grained and classic)", () => {
    const s = redactString("request with github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed")
    expect(s).not.toMatch(/github_pat_11|ghp_abcdef/)
    expect(s).toContain("redacted")
  })
  it("matches secret key names in any casing / separator style", () => {
    const out = redact({
      developer_token: "d1",
      developerToken: "d2",
      "developer-token": "d3",
      auth_code: "c1",
      "access-token": "t1",
      secret_key: "s1",
      "X-Amz-Signature": "sig1",
      sig: "sig2",
      signature: "sig3",
      clientSecret: "cs",
      newPassword: "pw",
      refresh_token: "rt",
      idempotency_key: "keep-me",
      name: "keep",
      code: "keep-error-code",
      tokens: 12,
    }) as Record<string, unknown>
    for (const k of ["developer_token", "developerToken", "developer-token", "auth_code", "access-token", "secret_key", "X-Amz-Signature", "sig", "signature", "clientSecret", "newPassword", "refresh_token"]) {
      expect(out[k], k).toBe("[redacted]")
    }
    expect(out.idempotency_key).toBe("keep-me")
    expect(out.name).toBe("keep")
    expect(out.code).toBe("keep-error-code")
    expect(out.tokens).toBe(12)
    expect(isSecretKeyName("confirm_token")).toBe(true)
    expect(isSecretKeyName("budget")).toBe(false)
  })
  it("redacts Google client secrets and signed-URL query parameters", () => {
    const s = redactString(
      "GOCSPX-abcdefghijklmnop https://bucket.s3.amazonaws.com/a.png?X-Amz-Credential=AKIA&X-Amz-Signature=deadbeef&x=1 " +
        "https://cdn.example.com/v.mp4?token=abc123&sig=xyz&signature=qqq&refresh_token=rrr"
    )
    expect(s).not.toMatch(/GOCSPX-abc/)
    expect(s).not.toMatch(/deadbeef/)
    expect(s).not.toMatch(/AKIA/)
    expect(s).not.toMatch(/abc123/)
    expect(s).not.toMatch(/sig=xyz/)
    expect(s).not.toMatch(/qqq/)
    expect(s).not.toMatch(/rrr/)
    expect(s).toContain("x=1")
  })
  it("redactUrl keeps scheme/host/path and drops the query string", () => {
    expect(redactUrl("https://cdn.example.com/a/b.png?X-Amz-Signature=abc")).toBe("https://cdn.example.com/a/b.png?[redacted]")
    expect(redactUrl("https://cdn.example.com/a/b.png")).toBe("https://cdn.example.com/a/b.png")
  })
  it("redacts PEM private keys", () => {
    expect(
      redactString(
        "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"
      )
    ).toBe("[redacted-private-key]")
  })
})

describe("capJson", () => {
  it("keeps small values and truncates big ones", () => {
    expect(capJson({ a: 1 }, 100)).toEqual({
      json: { a: 1 },
      bytes: 7,
      truncated: false,
    })
    const big = capJson({ s: "x".repeat(500) }, 100)
    expect(big.truncated).toBe(true)
    expect((big.json as any)._truncated).toBe(true)
  })
})
