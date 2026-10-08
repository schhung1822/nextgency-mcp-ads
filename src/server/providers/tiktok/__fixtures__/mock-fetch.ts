// Test helper: route-based fetch mock for TikTok endpoints (vi.stubGlobal("fetch", …)).
import { vi } from "vitest"
import type { ProviderContext } from "../../types"
import type { TikTokCredentials } from "../credentials"

export interface RecordedCall {
  method: string
  url: string
  /** "/campaign/get/" (version stripped) */
  path: string
  /** query params, JSON-decoded when possible */
  query: Record<string, unknown>
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

export type Reply = { status?: number; headers?: Record<string, string>; body: unknown }
export type Handler = (call: RecordedCall, nth: number) => Reply | unknown

export function ok(data: unknown, extra: Record<string, unknown> = {}): Reply {
  return { body: { code: 0, message: "OK", request_id: "req-ok-1", data, ...extra } }
}

export function fail(code: number, message = "error", status = 200): Reply {
  return { status, body: { code, message, request_id: `req-err-${code}`, data: {} } }
}

function isReply(v: unknown): v is Reply {
  return typeof v === "object" && v !== null && "body" in v && Object.keys(v).every((k) => ["status", "headers", "body"].includes(k))
}

/** Install a fetch mock. Routes are keyed "METHOD /path/" (e.g. "GET /campaign/get/"). */
export function mockTikTok(routes: Record<string, Handler | Reply | unknown>) {
  const calls: RecordedCall[] = []
  const counts = new Map<string, number>()
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const u = new URL(url)
    const path = u.pathname.replace(/^\/open_api\/v[\d.]+/, "")
    const query: Record<string, unknown> = {}
    for (const [k, v] of u.searchParams) {
      // arrays/objects are JSON-encoded by the client; scalars stay strings (ids exceed 2^53)
      if (/^[[{]/.test(v)) {
        try {
          query[k] = JSON.parse(v)
          continue
        } catch {
          // fall through
        }
      }
      query[k] = v
    }
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v))
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null
    const method = (init?.method ?? "GET").toUpperCase()
    const call: RecordedCall = { method, url, path, query, headers, body }
    calls.push(call)
    const key = `${method} ${path}`
    const nth = counts.get(key) ?? 0
    counts.set(key, nth + 1)
    const route = routes[key]
    if (route === undefined) {
      return new Response(JSON.stringify({ code: 40008, message: `no mock for ${key}`, data: {} }), { status: 200 })
    }
    const out = typeof route === "function" ? (route as Handler)(call, nth) : route
    const reply: Reply = isReply(out) ? out : ok(out)
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    })
  })
  vi.stubGlobal("fetch", fetchMock)
  return {
    calls,
    fetchMock,
    posts: () => calls.filter((c) => c.method === "POST"),
    callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
  }
}

export const CREDS: TikTokCredentials = { accessToken: "tok_test_abcdef123456", appId: "7000000000000000001", secret: "s3cr3t" }

export function makeCtx(overrides: Partial<ProviderContext<TikTokCredentials>["account"]> = {}): ProviderContext<TikTokCredentials> {
  return {
    connectionId: "conn-1",
    credentials: { ...CREDS, appId: `${CREDS.appId.slice(0, -3)}${Math.floor(Math.random() * 900 + 100)}` },
    connectionMeta: {},
    account: {
      id: "acc-uuid-1",
      externalId: "7100000000000000001",
      name: "Shop ABC",
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
      ...overrides,
    },
  }
}
