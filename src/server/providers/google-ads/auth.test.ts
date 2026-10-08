import { createVerify } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache, getAccessToken, signServiceAccountJwt } from "./auth"
import { mockFetch, oauthCredentials, saCredentials, testKeyPair } from "./__fixtures__/mock-fetch"
import { ProviderError } from "../errors"
import type { ServiceAccountCredentials } from "./credentials"

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
}

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => vi.unstubAllGlobals())

describe("service account JWT", () => {
  it("has iss/scope/aud/iat/exp≤1h and no sub claim", () => {
    const creds = saCredentials() as ServiceAccountCredentials
    const now = Date.UTC(2026, 9, 2, 0, 0, 0)
    const jwt = signServiceAccountJwt(creds, now)
    const [h, c] = jwt.split(".")
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid123" })
    const claims = decode(c!)
    expect(claims).toEqual({
      iss: "ads-bot@demo-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/adwords",
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    })
    expect(claims).not.toHaveProperty("sub")
  })

  it("signature verifies with the generated public key (RS256)", () => {
    const creds = saCredentials() as ServiceAccountCredentials
    const jwt = signServiceAccountJwt(creds)
    const [h, c, s] = jwt.split(".")
    const v = createVerify("RSA-SHA256")
    v.update(`${h}.${c}`)
    expect(v.verify(testKeyPair().publicKey, Buffer.from(s!, "base64url"))).toBe(true)
  })

  it("posts a jwt-bearer grant to the token endpoint", async () => {
    const m = mockFetch()
    await getAccessToken(saCredentials(), { connectionId: "c1" })
    const call = m.tokenCalls()[0]!
    expect(call.method).toBe("POST")
    expect((call.body as Record<string, string>).grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
    expect((call.body as Record<string, string>).assertion.split(".")).toHaveLength(3)
  })
})

describe("token cache", () => {
  it("reuses the access token until 5 minutes before expiry", async () => {
    const m = mockFetch({ expiresIn: 3600 })
    const creds = oauthCredentials()
    let now = 1_000_000
    const t1 = await getAccessToken(creds, { connectionId: "c1", now: () => now })
    now += 54 * 60_000
    const t2 = await getAccessToken(creds, { connectionId: "c1", now: () => now })
    expect(t2).toBe(t1)
    expect(m.tokenCalls()).toHaveLength(1)
    now += 2 * 60_000 // 56 min → inside the 5-minute early-refresh window
    const t3 = await getAccessToken(creds, { connectionId: "c1", now: () => now })
    expect(t3).not.toBe(t1)
    expect(m.tokenCalls()).toHaveLength(2)
  })

  it("is keyed by connection", async () => {
    const m = mockFetch()
    const creds = oauthCredentials()
    await getAccessToken(creds, { connectionId: "a" })
    await getAccessToken(creds, { connectionId: "b" })
    expect(m.tokenCalls()).toHaveLength(2)
  })

  it("deduplicates concurrent mints", async () => {
    const m = mockFetch()
    const creds = oauthCredentials()
    await Promise.all([getAccessToken(creds, { connectionId: "x" }), getAccessToken(creds, { connectionId: "x" })])
    expect(m.tokenCalls()).toHaveLength(1)
  })

  it("sends refresh_token grant fields for OAuth", async () => {
    const m = mockFetch()
    await getAccessToken(oauthCredentials(), { connectionId: "o" })
    expect(m.tokenCalls()[0]!.body).toMatchObject({
      grant_type: "refresh_token",
      client_id: "1234567890-abc.apps.googleusercontent.com",
      refresh_token: "1//0gREFRESHTOKENVALUE",
    })
  })
})

describe("token errors", () => {
  it("maps invalid_grant to auth_invalid with the 7-day Testing hint (OAuth)", async () => {
    const m = mockFetch()
    m.on((c) => c.url.startsWith("https://oauth2.googleapis.com/token"), { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } })
    const err = (await getAccessToken(oauthCredentials(), { connectionId: "e" }).catch((e) => e)) as ProviderError
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.code).toBe("auth_invalid")
    expect(err.hint).toContain("7 ngày")
    expect(err.hint).toContain("In production")
    expect(err.message).not.toContain("1//0gREFRESHTOKENVALUE")
  })

  it("maps invalid_grant for service accounts without the OAuth hint", async () => {
    const m = mockFetch()
    m.on((c) => c.url.startsWith("https://oauth2.googleapis.com/token"), { status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } })
    const err = (await getAccessToken(saCredentials(), { connectionId: "e2" }).catch((e) => e)) as ProviderError
    expect(err.code).toBe("auth_invalid")
    expect(err.userMessageVi).toContain("service account")
  })
})
