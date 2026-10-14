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
  it("redacts Meta app access tokens (<app_id>|<app_secret>)", () => {
    const s = redactString("debug_token?input_token=x with 1234567890123456|0123456789abcdef0123456789abcdef failed")
    expect(s).not.toMatch(/0123456789abcdef0123456789abcdef/)
    expect(s).toContain("1234567890123456|[redacted]")
  })
  it("redacts secrets in a bare form body but keeps other fields", () => {
    const s = redactString("client_secret=s3cr3tVal&grant_type=fb_exchange_token&fb_exchange_token=short1")
    expect(s).not.toMatch(/s3cr3tVal/)
    expect(s).not.toMatch(/short1/)
    expect(s).toContain("grant_type=fb_exchange_token")
  })
  it("redacts the password of URL userinfo", () => {
    const pg = redactString("connect failed: postgres://adsmcp:pgS3cret@db:5432/adsmcp")
    expect(pg).not.toMatch(/pgS3cret/)
    expect(pg).toContain("postgres://adsmcp:[redacted]@db:5432/adsmcp")
    expect(redactString("GET https://u:p4ss@x.example/a")).not.toMatch(/p4ss/)
    expect(redactString("https://example.com/a:b@c")).toBe("https://example.com/a:b@c")
  })
  it("keeps Meta image hashes (32-hex) readable", () => {
    expect(redactString("image_hash a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe("image_hash a1b2c3d4e5f60718293a4b5c6d7e8f90")
  })
  it("redacts secret values inside JSON text", () => {
    const s = redactString('body {"error":"x","client_secret":"cs-1","access_token" : "tok\\"en2","name":"keep"}')
    expect(s).not.toMatch(/cs-1/)
    expect(s).not.toMatch(/en2/)
    expect(s).toContain('"client_secret":"[redacted]"')
    expect(s).toContain('"name":"keep"')
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

describe("redact Telegram bot token", () => {
  const token = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
  it("redacts a bare token and a Bot API URL path", () => {
    const s = redactString(`token ${token} url https://api.telegram.org/bot${token}/sendMessage`)
    expect(s).not.toContain("AAEhBP0av28")
    expect(s).toContain("https://api.telegram.org/bot[redacted]/sendMessage")
    expect(redactString(`bot${token}`)).toBe("bot[redacted]")
    expect(redact({ botToken: token })).toEqual({ botToken: "[redacted]" })
  })
  it("does not touch times, ids, chat ids or short id:value pairs", () => {
    const keep = "Lúc 12:30, 2026-10-08T12:30:00Z, chat -1001234567890, act_123:456, robot12345:abc, 123456:short_value"
    expect(redactString(keep)).toBe(keep)
  })
})

describe("containsSecretValue", () => {
  it("nhận ra token / key / URL có mật khẩu nhưng không coi chữ thường hay mã hash 40-hex là bí mật", async () => {
    const { containsSecretValue } = await import("./redact")
    const secrets = [
      "apify_api_" + "Ab3x9QzK".repeat(4),
      "123456789:" + "A".repeat(35),
      "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K_L-M3n4O5p6Q",
      "1//" + "0g".repeat(15),
      "ya29." + "a0".repeat(15),
      "adr_" + "Ab3_-x".repeat(5),
      "Bearer abcdefghijklmnopqrstu",
      "http://user:pass@proxy.example:8000",
      "https://x.example/cb?access_token=abc",
      "EAAB" + "x".repeat(30),
    ]
    for (const s of secrets) expect(containsSecretValue(`note ${s}`), s).toBe(true)
    for (const s of ["son môi giá rẻ", "https://shopee.vn/search?keyword=son", "a".repeat(10) + "0123456789abcdef0123456789abcdef01234567"])
      expect(containsSecretValue(s), s).toBe(false)
  })
})

describe("redact Apify API tokens", () => {
  const token = "apify_api_" + "Ab3x9QzK".repeat(4) + "q1"
  it("che token Apify ở mọi vị trí (chuỗi, JSON, header, URL) nhưng giữ chữ thường", () => {
    const s = redactString(
      `start run failed with ${token}; {"note":"${token}"}; Authorization: Bearer ${token}; https://api.apify.com/v2/users/me?token=${token}`
    )
    expect(s).not.toContain(token.slice(10, 30))
    expect(s).toContain("apify_api_…[redacted]")
    expect(redact({ note: `token ${token}` })).toEqual({ note: "token apify_api_…[redacted]" })
    expect(redact({ apifyToken: token })).toEqual({ apifyToken: "[redacted]" })
    const keep = "Apify actor apify~website-content-crawler, apify_runs, apify_token.create, apify_api_"
    expect(redactString(keep)).toBe(keep)
  })
})

describe("redact Google Drive secrets", () => {
  const relayToken = "adr_" + "Ab3_-x".repeat(7) + "q"
  const apiKey = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K_L-M3n4O5p6Q"
  it("redacts relay tokens in a /dl/ URL and Google API keys anywhere", () => {
    expect(apiKey).toHaveLength(39)
    const s = redactString(
      `fetch https://ads.example.vn/dl/${relayToken}/video.mp4 failed; key ${apiKey}; url https://www.googleapis.com/drive/v3/files/1?key=${apiKey}&alt=media`
    )
    expect(s).not.toContain(relayToken.slice(4, 24))
    expect(s).toContain("/dl/adr_…[redacted]/video.mp4")
    expect(s).not.toContain(apiKey.slice(4, 20))
    expect(s).toContain("AIza…[redacted]")
    expect(redact({ note: `k=${apiKey}` })).toEqual({ note: "k=AIza…[redacted]" })
  })
  it("keeps ordinary text, Drive file ids and short look-alikes", () => {
    const keep = "file 1AbCdEfGhIjKlMnOpQrStUvWxYz012345 adr_short AIzaShort Drive folder adr"
    expect(redactString(keep)).toBe(keep)
  })
  it("redacts resource keys in Drive links (resourcekey= / resource_key= / resource-key=) but keeps the file id", () => {
    const rk = "0-AbCdEfGhIjKlMnOpQrStUv"
    for (const param of ["resourcekey", "resourceKey", "resource_key", "resource-key"]) {
      const s = redactString(`https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing&${param}=${rk}#x`)
      expect(s, param).not.toContain(rk)
      expect(s, param).toContain(`${param}=[redacted]#x`)
      expect(s, param).toContain("/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing&")
    }
    expect(redactString(`?resourcekey=${rk}`)).toBe("?resourcekey=[redacted]")
    expect(redact({ link: `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrSt?resourcekey=${rk}` })).toEqual({
      link: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrSt?resourcekey=[redacted]",
    })
    // object keys holding resource keys
    expect(redact({ resourceKey: rk, resourceKeys: rk, "X-Goog-Drive-Resource-Keys": `1AbCdEfGhIjKlMnOpQrSt/${rk}`, fileId: "1AbCdEfGhIjKlMnOpQrSt" })).toEqual({
      resourceKey: "[redacted]",
      resourceKeys: "[redacted]",
      "X-Goog-Drive-Resource-Keys": "[redacted]",
      fileId: "1AbCdEfGhIjKlMnOpQrSt",
    })
    // look-alike parameter names stay
    expect(redactString("?resourcekeyword=abc&noresourcekey=1")).toBe("?resourcekeyword=abc&noresourcekey=1")
  })
})
