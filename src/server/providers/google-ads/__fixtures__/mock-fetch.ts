// Test-only fetch mock for the Google Ads adapter (no real network calls in automated tests).
import { generateKeyPairSync } from "node:crypto"
import { vi } from "vitest"
import type { ProviderContext } from "../../types"
import { parseCredentials, type GoogleAdsCredentials } from "../credentials"

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  rawBody: string | null
}

export interface MockResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

type Handler = (call: RecordedCall) => MockResponse | undefined

export interface FetchMock {
  calls: RecordedCall[]
  /** calls to googleads.googleapis.com only */
  api: () => RecordedCall[]
  tokenCalls: () => RecordedCall[]
  on: (match: (c: RecordedCall) => boolean, respond: MockResponse | ((c: RecordedCall) => MockResponse)) => void
  /** respond once (queued, first-in-first-out) */
  once: (match: (c: RecordedCall) => boolean, respond: MockResponse | ((c: RecordedCall) => MockResponse)) => void
}

export function mockFetch(opts: { token?: string; expiresIn?: number } = {}): FetchMock {
  const calls: RecordedCall[] = []
  const persistent: Handler[] = []
  const queued: { match: (c: RecordedCall) => boolean; respond: MockResponse | ((c: RecordedCall) => MockResponse) }[] = []
  let tokenN = 0
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
    const rawBody = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : null
    let body: unknown = rawBody
    if (rawBody && headers["content-type"]?.includes("json")) body = JSON.parse(rawBody)
    if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body.entries())
    const call: RecordedCall = { url, method: init?.method ?? "GET", headers, body, rawBody }
    calls.push(call)
    let res: MockResponse | undefined
    const qi = queued.findIndex((q) => q.match(call))
    if (qi >= 0) {
      const q = queued.splice(qi, 1)[0]!
      res = typeof q.respond === "function" ? q.respond(call) : q.respond
    }
    if (!res) for (const h of persistent) if ((res = h(call))) break
    if (!res && url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenN++
      res = { body: { access_token: `${opts.token ?? "ya29.test"}-${tokenN}`, expires_in: opts.expiresIn ?? 3599, token_type: "Bearer" } }
    }
    if (!res) res = { status: 599, body: { error: { message: `unmocked ${url}` } } }
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...(res.headers ?? {}) },
    })
  })
  vi.stubGlobal("fetch", fn)
  return {
    calls,
    api: () => calls.filter((c) => c.url.startsWith("https://googleads.googleapis.com/")),
    tokenCalls: () => calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token")),
    on: (match, respond) => persistent.push((c) => (match(c) ? (typeof respond === "function" ? respond(c) : respond) : undefined)),
    once: (match, respond) => queued.push({ match, respond }),
  }
}

let keyPair: { privateKey: string; publicKey: string } | null = null
export function testKeyPair() {
  keyPair ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  return keyPair
}

export function saCredentials(extra: Record<string, unknown> = {}): GoogleAdsCredentials {
  const { privateKey } = testKeyPair()
  return parseCredentials({
    auth_type: "service_account",
    service_account_json: JSON.stringify({
      type: "service_account",
      project_id: "demo-project",
      private_key_id: "kid123",
      private_key: privateKey,
      client_email: "ads-bot@demo-project.iam.gserviceaccount.com",
    }),
    ...extra,
  })
}

export function oauthCredentials(extra: Record<string, unknown> = {}): GoogleAdsCredentials {
  return parseCredentials({
    auth_type: "oauth_refresh_token",
    client_id: "1234567890-abc.apps.googleusercontent.com",
    client_secret: "GOCSPX-secret",
    refresh_token: "1//0gREFRESHTOKENVALUE",
    ...extra,
  })
}

export function providerCtx(creds: GoogleAdsCredentials, over: Partial<ProviderContext<GoogleAdsCredentials>> = {}): ProviderContext<GoogleAdsCredentials> {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    credentials: creds,
    connectionMeta: {},
    account: { id: "acc-1", externalId: "1234567890", name: "Demo", currency: "VND", timezone: "Asia/Ho_Chi_Minh" },
    ...over,
  }
}

export const isSearch = (c: RecordedCall) => c.url.endsWith("/googleAds:search")
export const queryOf = (c: RecordedCall) => String((c.body as { query?: string })?.query ?? "")
export const searchMatching = (re: RegExp) => (c: RecordedCall) => isSearch(c) && re.test(queryOf(c))

/** userMessageVi of the ProviderError thrown by fn */
export function viMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as { userMessageVi?: string }).userMessageVi ?? String(e)
  }
  return "<no error>"
}
