// TikTok Social MCP client (17-tiktok-social.md §2-§3): DCR, PKCE, token exchange / refresh, tools/call parsing and
// error mapping. Response shapes from the live probe of 2026-11-15. No network: fetch is replaced.
import { createHash } from "node:crypto"

import { afterEach, describe, expect, it } from "vitest"

import {
  __setTiktokSocialFetch,
  authorizeUrl,
  callTiktokSocialTool,
  exchangeCode,
  newPkce,
  refreshTokens,
  registerClient,
  TIKTOK_SOCIAL_SERVER,
  TiktokSocialError,
} from "./api"

interface Seen {
  url: string
  init: RequestInit
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = []
  __setTiktokSocialFetch(async (url, init) => {
    seen.push({ url, init })
    return handler(url, init)
  })
  return seen
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } })

/** a tools/call answer wrapping a TikTok API response as text content (live shape) */
const toolResult = (api: unknown) => json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(api) }] } })

afterEach(() => __setTiktokSocialFetch(null))

describe("OAuth (DCR + PKCE)", () => {
  it("PKCE: S256 challenge of the verifier, random state", () => {
    const p = newPkce()
    expect(p.verifier.length).toBeGreaterThanOrEqual(43)
    expect(p.challenge).toBe(createHash("sha256").update(p.verifier).digest("base64url"))
    expect(newPkce().state).not.toBe(p.state)
  })

  it("registers a public client and returns client_id; refuses redirects", async () => {
    const seen = mockFetch(() => json({ client_id: "abcDEF123456789", client_name: "Ads MCP Simple" }))
    await expect(registerClient("https://ads.example.com/api/tiktok-social/callback")).resolves.toBe("abcDEF123456789")
    expect(seen[0]!.url).toBe(`${TIKTOK_SOCIAL_SERVER}/oauth/tiktok/register`)
    expect(seen[0]!.init.redirect).toBe("error")
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({
      redirect_uris: ["https://ads.example.com/api/tiktok-social/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    })
  })

  it("authorize URL carries resource, client, redirect, S256 challenge and state", () => {
    const u = new URL(authorizeUrl({ clientId: "cid", redirectUri: "https://x.test/cb", challenge: "chal", state: "st" }))
    expect(u.origin + u.pathname).toBe(`${TIKTOK_SOCIAL_SERVER}/oauth/tiktok/authorize`)
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      resource: TIKTOK_SOCIAL_SERVER,
      client_id: "cid",
      redirect_uri: "https://x.test/cb",
      code_challenge: "chal",
      code_challenge_method: "S256",
      state: "st",
    })
  })

  it("exchanges the code (form body with verifier): 1-day access, 1-year refresh, scopes", async () => {
    const now = new Date("2026-11-15T00:00:00Z")
    const seen = mockFetch(() =>
      json({ access_token: "AT1", refresh_token: "RT1", token_type: "Bearer", scope: "video.list user.info.basic", expires_in: 86400, refresh_token_expires_in: 31536000 })
    )
    const t = await exchangeCode({ clientId: "cid", redirectUri: "https://x.test/cb", code: "C", verifier: "V", now })
    expect(new URLSearchParams(String(seen[0]!.init.body)).get("code_verifier")).toBe("V")
    expect(t).toMatchObject({ accessToken: "AT1", refreshToken: "RT1", scopes: ["user.info.basic", "video.list"] })
    expect(t.accessExpiresAt.toISOString()).toBe("2026-11-16T00:00:00.000Z")
    expect(t.refreshExpiresAt.toISOString()).toBe("2027-11-15T00:00:00.000Z")
  })

  it("a refused code is an auth error without the code / token in the message", async () => {
    mockFetch(() => json({ error: "invalid_grant", error_description: "code expired" }, 400))
    const err = await exchangeCode({ clientId: "cid", redirectUri: "r", code: "SECRETCODE", verifier: "v" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TiktokSocialError)
    expect(err).toMatchObject({ code: "auth", upstreamMessage: "code expired" })
    expect(String((err as Error).message)).not.toContain("SECRETCODE")
  })

  it("refresh keeps the refresh token when TikTok does not rotate it (live 2026-11-15)", async () => {
    const refreshExpiresAt = new Date("2027-11-15T00:00:00Z")
    mockFetch(() => json({ access_token: "AT2", expires_in: 86400 }))
    const t = await refreshTokens({ clientId: "cid", refreshToken: "RT1", refreshExpiresAt })
    expect(t).toMatchObject({ accessToken: "AT2", refreshToken: "RT1" })
    expect(t.refreshExpiresAt).toEqual(refreshExpiresAt)
  })
})

describe("tools/call", () => {
  it("Bearer token, JSON-RPC tools/call; returns the data of the wrapped API answer", async () => {
    const seen = mockFetch(() => toolResult({ code: 0, message: "OK", request_id: "R1", data: { username: "shop" } }))
    const res = await callTiktokSocialTool("AT", "account_user_get", { fields: ["username"] })
    expect(res).toEqual({ data: { username: "shop" }, requestId: "R1" })
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer AT")
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ method: "tools/call", params: { name: "account_user_get", arguments: { fields: ["username"] } } })
  })

  it("reads an SSE answer (last data: line)", async () => {
    mockFetch(
      () =>
        new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"code":0,"data":{"a":1}}' }] } })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
    )
    await expect(callTiktokSocialTool("AT", "x", {})).resolves.toMatchObject({ data: { a: 1 } })
  })

  it.each([
    [40130, "scope"],
    [40002, "invalid_request"],
    [40100, "rate_limited"],
    [40105, "auth"],
    [50002, "upstream"],
  ])("TikTok code %s inside the text → %s", async (code, kind) => {
    mockFetch(() => toolResult({ code, message: "msg", request_id: "R" }))
    await expect(callTiktokSocialTool("AT", "x", {})).rejects.toMatchObject({ code: kind, upstreamCode: code, upstreamMessage: "msg" })
  })

  it("HTTP 401 → auth; 429 → rate_limited; JSON-RPC error → invalid_request", async () => {
    mockFetch(() => new Response("", { status: 401 }))
    await expect(callTiktokSocialTool("AT", "x", {})).rejects.toMatchObject({ code: "auth" })
    mockFetch(() => new Response("", { status: 429 }))
    await expect(callTiktokSocialTool("AT", "x", {})).rejects.toMatchObject({ code: "rate_limited" })
    mockFetch(() => json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool" } }))
    await expect(callTiktokSocialTool("AT", "x", {})).rejects.toMatchObject({ code: "invalid_request", upstreamMessage: "Unknown tool" })
  })

  it("network failure → upstream (no token in the error)", async () => {
    __setTiktokSocialFetch(async () => {
      throw new TypeError("fetch failed AT_SECRET")
    })
    const err = await callTiktokSocialTool("AT_SECRET", "x", {}).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: "upstream" })
    expect(String((err as Error).message)).not.toContain("AT_SECRET")
  })
})
