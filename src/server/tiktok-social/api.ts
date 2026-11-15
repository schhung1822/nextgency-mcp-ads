// TikTok Social MCP server - OAuth (Dynamic Client Registration + PKCE) and the JSON-RPC client
// (.claude/docs/17-tiktok-social.md §2-§3). No imports from "next/*" or "server-only" (the worker job uses it).
// Host is a constant (never taken from metadata / responses); redirects are refused; nothing here logs, and tokens /
// codes / verifiers never appear in an error.
import { createHash, randomBytes } from "node:crypto"

export const TIKTOK_SOCIAL_SERVER = "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-organic-social"
const OAUTH = `${TIKTOK_SOCIAL_SERVER}/oauth/tiktok`
/** client_name shown on TikTok's consent screen */
export const TIKTOK_SOCIAL_CLIENT_NAME = "Ads MCP Simple"
const TIMEOUT_MS = { oauth: 15_000, call: 25_000 }
const MAX_BODY_BYTES = 4 * 1024 * 1024

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
let fetchImpl: FetchLike = (i, init) => fetch(i, init)
/** tests only */
export function __setTiktokSocialFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((i, init) => fetch(i, init))
}

// ---- errors --------------------------------------------------------------------------------------------------

export type TiktokSocialErrorCode =
  /** token rejected / refresh refused → sign in again */
  | "auth"
  /** the sign-in did not grant the scope a tool needs */
  | "scope"
  | "rate_limited"
  /** TikTok refused the parameters (message kept, it explains what is wrong) */
  | "invalid_request"
  | "not_found"
  /** TikTok / network trouble - retry later */
  | "upstream"
  | "timeout"

export class TiktokSocialError extends Error {
  readonly code: TiktokSocialErrorCode
  /** TikTok API code (40002…) or HTTP status, when known */
  readonly upstreamCode: number | null
  /** TikTok's own message (English, cleaned, ≤ 300 chars) */
  readonly upstreamMessage: string | null
  readonly requestId: string | null
  readonly retryable: boolean
  constructor(a: {
    code: TiktokSocialErrorCode
    message: string
    upstreamCode?: number | null
    upstreamMessage?: string | null
    requestId?: string | null
    retryable?: boolean
  }) {
    super(a.message)
    this.name = "TiktokSocialError"
    this.code = a.code
    this.upstreamCode = a.upstreamCode ?? null
    this.upstreamMessage = a.upstreamMessage ?? null
    this.requestId = a.requestId ?? null
    this.retryable = a.retryable ?? (a.code === "upstream" || a.code === "timeout" || a.code === "rate_limited")
  }
}

export function isTiktokSocialError(e: unknown): e is TiktokSocialError {
  return e instanceof TiktokSocialError
}

/** printable, single line, ≤ max chars (upstream text is untrusted) */
export function cleanUpstream(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.slice(0, max) : null
}

// ---- HTTP ----------------------------------------------------------------------------------------------------

async function send(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string; contentType: string }> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.any(signals) })
  } catch (e) {
    const name = e instanceof Error ? e.name : ""
    if (name === "TimeoutError" || (name === "AbortError" && !signal?.aborted)) {
      throw new TiktokSocialError({ code: "timeout", message: "TikTok did not answer in time" })
    }
    if (signal?.aborted) throw e
    throw new TiktokSocialError({ code: "upstream", message: "TikTok could not be reached" })
  }
  const len = Number(res.headers.get("content-length") ?? "0")
  if (len > MAX_BODY_BYTES) throw new TiktokSocialError({ code: "upstream", message: "TikTok response too large", upstreamCode: res.status })
  const text = await res.text()
  if (text.length > MAX_BODY_BYTES) throw new TiktokSocialError({ code: "upstream", message: "TikTok response too large", upstreamCode: res.status })
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---- OAuth ---------------------------------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString("base64url")

/** PKCE pair (RFC 7636, S256) + an unguessable state */
export function newPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), state: b64url(randomBytes(24)) }
}

/** Dynamic Client Registration (public client). Called once per redirect URI and cached in tiktok_social_clients. */
export async function registerClient(redirectUri: string, signal?: AbortSignal): Promise<string> {
  const r = await send(
    `${OAUTH}/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: TIKTOK_SOCIAL_CLIENT_NAME,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    },
    TIMEOUT_MS.oauth,
    signal
  )
  const j = parseJson(r.text)
  const id = j?.client_id
  if (r.status >= 400 || typeof id !== "string" || !/^[\w.~-]{8,200}$/.test(id)) {
    throw new TiktokSocialError({
      code: r.status === 400 ? "invalid_request" : "upstream",
      message: "TikTok client registration failed",
      upstreamCode: r.status,
      upstreamMessage: cleanUpstream(j?.error_description ?? j?.error),
    })
  }
  return id
}

export function authorizeUrl(a: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const u = new URL(`${OAUTH}/authorize`)
  u.search = new URLSearchParams({
    response_type: "code",
    resource: TIKTOK_SOCIAL_SERVER,
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
    state: a.state,
  }).toString()
  return u.toString()
}

export interface TiktokSocialTokens {
  accessToken: string
  refreshToken: string
  accessExpiresAt: Date
  refreshExpiresAt: Date
  scopes: string[]
}

async function tokenRequest(body: Record<string, string>, now: Date, previousRefresh?: { token: string; expiresAt: Date }, signal?: AbortSignal): Promise<TiktokSocialTokens> {
  const r = await send(
    `${OAUTH}/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(body).toString() },
    TIMEOUT_MS.oauth,
    signal
  )
  const j = parseJson(r.text)
  const access = j?.access_token
  if (r.status >= 400 || typeof access !== "string" || !access) {
    const err = typeof j?.error === "string" ? j.error : ""
    // invalid_grant / invalid_client / unauthorized_client = the code / refresh token / client is not valid any more
    const auth = r.status === 400 || r.status === 401 || /invalid_grant|invalid_client|unauthorized/.test(err)
    throw new TiktokSocialError({
      code: r.status >= 500 ? "upstream" : auth ? "auth" : "upstream",
      message: "TikTok token request failed",
      upstreamCode: r.status,
      upstreamMessage: cleanUpstream(j?.error_description ?? j?.error),
    })
  }
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d)
  const refresh = typeof j?.refresh_token === "string" && j.refresh_token ? j.refresh_token : previousRefresh?.token
  if (!refresh) throw new TiktokSocialError({ code: "upstream", message: "TikTok returned no refresh token", upstreamCode: r.status })
  const refreshExpiresAt =
    typeof j?.refresh_token_expires_in === "number"
      ? new Date(now.getTime() + num(j.refresh_token_expires_in, 365 * 86_400) * 1000)
      : (previousRefresh?.expiresAt ?? new Date(now.getTime() + 365 * 86_400 * 1000))
  return {
    accessToken: access,
    refreshToken: refresh,
    accessExpiresAt: new Date(now.getTime() + num(j?.expires_in, 86_400) * 1000),
    refreshExpiresAt,
    scopes: typeof j?.scope === "string" ? j.scope.split(/[\s,]+/).filter(Boolean).sort() : [],
  }
}

export function exchangeCode(a: { clientId: string; redirectUri: string; code: string; verifier: string; now?: Date; signal?: AbortSignal }): Promise<TiktokSocialTokens> {
  return tokenRequest(
    { grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri, client_id: a.clientId },
    a.now ?? new Date(),
    undefined,
    a.signal
  )
}

/** Live probe 2026-11-15: the refresh token is NOT rotated and its 1-year window does not move. */
export function refreshTokens(a: { clientId: string; refreshToken: string; refreshExpiresAt: Date; now?: Date; signal?: AbortSignal }): Promise<TiktokSocialTokens> {
  return tokenRequest(
    { grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: a.clientId },
    a.now ?? new Date(),
    { token: a.refreshToken, expiresAt: a.refreshExpiresAt },
    a.signal
  )
}

/** Best effort (deleting a connection): errors are swallowed by the caller. */
export async function revokeToken(a: { clientId: string; token: string; signal?: AbortSignal }): Promise<void> {
  await send(
    `${OAUTH}/revoke`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: a.token, client_id: a.clientId }).toString() },
    TIMEOUT_MS.oauth,
    a.signal
  )
}

// ---- MCP tools/call ------------------------------------------------------------------------------------------

/**
 * Business API codes seen inside the tool text (live 2026-11-15: 40002 invalid params, 40130 scope not granted).
 * 40100 = too many requests, 40104 / 40105 / 40106 = token missing / invalid / expired [?] (TikTok API for Business
 * common codes).
 */
function classifyApiCode(code: number): TiktokSocialErrorCode {
  if (code === 40130) return "scope"
  if (code === 40100 || code === 40133 || code === 40016) return "rate_limited"
  if (code === 40104 || code === 40105 || code === 40106 || code === 40102) return "auth"
  if (code >= 50000) return "upstream"
  return "invalid_request"
}

let rpcSeq = 1

/**
 * tools/call on TikTok's Social MCP server (stateless: no initialize / session needed - live 2026-11-15). Returns the
 * `data` object of the wrapped TikTok API response; code != 0 → TiktokSocialError. Accepts JSON or SSE answers.
 */
export async function callTiktokSocialTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ data: Record<string, unknown>; requestId: string | null }> {
  const r = await send(
    TIKTOK_SOCIAL_SERVER,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method: "tools/call", params: { name, arguments: args } }),
    },
    TIMEOUT_MS.call,
    signal
  )
  if (r.status === 401 || r.status === 403) throw new TiktokSocialError({ code: "auth", message: "TikTok rejected the token", upstreamCode: r.status })
  if (r.status === 429) throw new TiktokSocialError({ code: "rate_limited", message: "TikTok rate limit", upstreamCode: 429 })
  if (r.status >= 400) throw new TiktokSocialError({ code: "upstream", message: "TikTok MCP error", upstreamCode: r.status })
  const body = r.contentType.includes("text/event-stream")
    ? (r.text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean)
        .pop() ?? "")
    : r.text
  const rpc = parseJson(body)
  if (!rpc) throw new TiktokSocialError({ code: "upstream", message: "Unreadable TikTok MCP answer", upstreamCode: r.status })
  const rpcErr = rpc.error as { code?: number; message?: unknown } | undefined
  if (rpcErr) {
    // -32602 invalid params / unknown tool
    throw new TiktokSocialError({
      code: rpcErr.code === -32602 || rpcErr.code === -32601 ? "invalid_request" : "upstream",
      message: "TikTok MCP error",
      upstreamCode: typeof rpcErr.code === "number" ? rpcErr.code : null,
      upstreamMessage: cleanUpstream(rpcErr.message),
    })
  }
  const result = rpc.result as { content?: { type?: string; text?: unknown }[]; isError?: boolean; structuredContent?: unknown } | undefined
  const text = result?.content?.find((c) => c?.type === "text" && typeof c.text === "string")?.text as string | undefined
  const api = (text ? parseJson(text) : null) ?? (result?.structuredContent && typeof result.structuredContent === "object" ? (result.structuredContent as Record<string, unknown>) : null)
  if (!api) {
    throw new TiktokSocialError({
      code: result?.isError ? "invalid_request" : "upstream",
      message: "Unreadable TikTok tool result",
      upstreamMessage: cleanUpstream(text),
    })
  }
  const code = typeof api.code === "number" ? api.code : Number(api.code ?? 0)
  const requestId = typeof api.request_id === "string" ? api.request_id.slice(0, 64) : null
  if (code !== 0 || result?.isError) {
    throw new TiktokSocialError({
      code: classifyApiCode(code),
      message: "TikTok API error",
      upstreamCode: Number.isFinite(code) ? code : null,
      upstreamMessage: cleanUpstream(api.message),
      requestId,
    })
  }
  const data = api.data && typeof api.data === "object" && !Array.isArray(api.data) ? (api.data as Record<string, unknown>) : {}
  return { data, requestId }
}
